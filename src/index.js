// Outbox パターンの素振り: Durable Object (SQLite) → alarm → Queues → メール送信
//
//   OrdersDB   … 注文DB。注文の更新と outbox への1行追加を「同じトランザクション」で書き、
//                alarm で outbox を読んで Queue に送る（中継役）
//   queue()    … Queue の consumer。MailSender に渡す
//   MailSender … お客さんにメールを送る役（送信はログに出すだけ）
//                ・送った seq を覚えておき、2回目は送らない（重複対策）
//                ・注文ごとに、1つ前のメールを送るまで次は保留する（順番対策）
import { DurableObject } from "cloudflare:workers";
import * as flags from "./flags.js";

const BATCH = 100;

export class OrdersDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id     INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );

      -- 外に出すイベント。seq が通し番号、prev_seq は「この注文の1つ前のイベント」
      CREATE TABLE IF NOT EXISTS outbox (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        type         TEXT NOT NULL,
        aggregate_id INTEGER NOT NULL,
        prev_seq     INTEGER NOT NULL,
        payload      TEXT NOT NULL,
        ts_ms        INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      );

      -- 注文ごとの最後のイベント（outbox は送ったら消すので別に持つ）
      CREATE TABLE IF NOT EXISTS last_event (
        aggregate_id INTEGER PRIMARY KEY,
        seq          INTEGER NOT NULL
      );

      -- どこまで送ったか
      CREATE TABLE IF NOT EXISTS offsets (
        name TEXT PRIMARY KEY,
        seq  INTEGER NOT NULL
      );
    `);
  }

  // ---- 業務の書き込みと、イベントの書き込みを同じトランザクションで ----
  async upsert(id, status) {
    this.ctx.storage.transactionSync(() => {
      const prev = this.findOrder(id);
      this.saveOrder(id, status);                  // 業務の書き込み
      this.addEvent(                               // イベントも書く
        prev ? "OrderStatusChanged" : "OrderCreated",
        id, { id, status });
    });
    await this.scheduleRelay();                    // alarm をセット
  }

  async remove(id) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM orders WHERE id = ?`, id);
      this.addEvent("OrderDeleted", id, { id });
    });
    await this.scheduleRelay();
  }

  findOrder(id) {
    return this.sql.exec(`SELECT * FROM orders WHERE id = ?`, id).toArray()[0];
  }

  saveOrder(id, status) {
    this.sql.exec(
      `INSERT INTO orders (id, status) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
      id, status
    );
  }

  // outbox に1行足す。この注文の1つ前の seq（prev_seq）も一緒に書く
  addEvent(type, aggregateId, payload) {
    const prevSeq =
      this.sql.exec(`SELECT seq FROM last_event WHERE aggregate_id = ?`, aggregateId).toArray()[0]?.seq ?? 0;
    const { seq } = this.sql
      .exec(
        `INSERT INTO outbox (type, aggregate_id, prev_seq, payload)
         VALUES (?, ?, ?, ?) RETURNING seq`,
        type, aggregateId, prevSeq, JSON.stringify(payload)
      )
      .one();
    this.sql.exec(
      `INSERT INTO last_event (aggregate_id, seq) VALUES (?, ?)
       ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq`,
      aggregateId, seq
    );
  }

  async scheduleRelay() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 200);
    }
  }

  loadOffset() {
    return this.sql.exec(`SELECT seq FROM offsets WHERE name = 'queue'`).toArray()[0]?.seq ?? 0;
  }

  saveOffset(seq) {
    this.sql.exec(
      `INSERT INTO offsets (name, seq) VALUES ('queue', ?)
       ON CONFLICT(name) DO UPDATE SET seq = excluded.seq`,
      seq
    );
  }

  // ---- 中継役: outbox を読んで Queue に送る ----
  async alarm(info) {
    const sent = this.loadOffset();              // どこまで送ったか
    const rows = this.sql
      .exec(`SELECT * FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?`, sent, BATCH)
      .toArray();
    if (rows.length === 0) return;

    // 障害: Queue に送れない
    if (await flags.isOn(this.env, "relay.queue-down")) {
      console.log(`[relay] Queue に送れない（未送信 ${this.backlog()} 件）retry=${info?.retryCount ?? 0}`);
      throw new Error("queue down");
    }

    // 障害: Queue の中で順番が入れ替わったことにする
    const reorder = await flags.isOn(this.env, "relay.reorder");
    const messages = rows.map((r) => ({ body: toEvent(r) }));
    if (reorder) messages.reverse();

    await this.env.EVENTS.sendBatch(messages);
    console.log(
      `[relay] send seq=${rows[0].seq}..${rows.at(-1).seq}${reorder ? "（逆順で届けるモード）" : ""}`
    );

    // 障害: 送ったあと・位置を保存する前に落ちる → 次の alarm で同じ seq をもう一度送る
    if (await flags.isOn(this.env, "relay.crash-after-send")) {
      await flags.set(this.env, "relay.crash-after-send", false); // 1回だけ
      console.log(`[relay] 送信後・位置の保存前に落ちた！`);
      throw new Error("crash after send");
    }

    const last = rows.at(-1).seq;
    this.saveOffset(last);                       // 送った位置を保存
    this.sql.exec(`DELETE FROM outbox WHERE seq <= ?`, last); // 送り終えた分は消す
    if (rows.length === BATCH) await this.ctx.storage.setAlarm(Date.now());
  }

  // ---- 観察用 ----
  backlog() {
    return this.sql.exec(`SELECT count(*) AS n FROM outbox`).one().n;
  }

  // 未送信があれば今すぐ alarm を動かす（障害から復旧したとき、次の再試行を待たずに流す）
  async wake() {
    if (this.backlog() > 0) await this.ctx.storage.setAlarm(Date.now());
  }

  debug() {
    return {
      orders: this.sql.exec(`SELECT * FROM orders ORDER BY id`).toArray(),
      outbox: this.sql.exec(`SELECT * FROM outbox ORDER BY seq`).toArray(),
      offset: this.loadOffset(),
    };
  }
}

function toEvent(r) {
  return {
    seq: r.seq,
    type: r.type,
    aggregate_id: r.aggregate_id,
    prev_seq: r.prev_seq,
    payload: JSON.parse(r.payload),
    ts_ms: r.ts_ms,
  };
}

const SUBJECTS = { pending: "ご注文を受け付けました", paid: "お支払いを確認しました", shipped: "発送しました" };

function subjectOf(ev) {
  if (ev.type === "OrderDeleted") return "ご注文をキャンセルしました";
  return SUBJECTS[ev.payload.status] ?? `ステータスが ${ev.payload.status} になりました`;
}

export class MailSender extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      -- 注文ごとに、最後に送ったメールの seq
      CREATE TABLE IF NOT EXISTS last_sent (
        order_id INTEGER PRIMARY KEY,
        seq      INTEGER NOT NULL
      );
      -- 前のメールを待っているイベント
      CREATE TABLE IF NOT EXISTS pending (
        seq      INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL,
        prev_seq INTEGER NOT NULL,
        body     TEXT NOT NULL
      );
      -- 送ったメール（受信箱の代わり）
      CREATE TABLE IF NOT EXISTS mails (
        seq      INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL,
        subject  TEXT NOT NULL
      );
    `);
  }

  lastSent(orderId) {
    return this.sql.exec(`SELECT seq FROM last_sent WHERE order_id = ?`, orderId).toArray()[0]?.seq ?? 0;
  }

  receive(events) {
    for (const ev of events) {
      const id = ev.aggregate_id;
      const last = this.lastSent(id);
      if (ev.seq <= last) {
        // もう送った seq → 2回目は送らない
        console.log(`[mail] skip seq=${ev.seq} 注文${id}（送信済み）`);
        continue;
      }
      if (ev.prev_seq !== last) {
        // 1つ前のメールがまだ → 保留して待つ
        this.sql.exec(
          `INSERT OR IGNORE INTO pending (seq, order_id, prev_seq, body) VALUES (?, ?, ?, ?)`,
          ev.seq, id, ev.prev_seq, JSON.stringify(ev)
        );
        console.log(`[mail] hold seq=${ev.seq} 注文${id}（seq=${ev.prev_seq} 待ち）`);
        continue;
      }
      this.send(ev);
      // 保留していた「次」があれば、続けて送る
      let next;
      while ((next = this.sql.exec(`SELECT * FROM pending WHERE order_id = ? AND prev_seq = ?`, id, this.lastSent(id)).toArray()[0])) {
        this.sql.exec(`DELETE FROM pending WHERE seq = ?`, next.seq);
        this.send(JSON.parse(next.body));
      }
    }
  }

  send(ev) {
    const subject = subjectOf(ev);
    // 本物ならここでメール送信 API を呼ぶ。素振りではログに出すだけ
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO mails (seq, order_id, subject) VALUES (?, ?, ?)`, ev.seq, ev.aggregate_id, subject);
      this.sql.exec(
        `INSERT INTO last_sent (order_id, seq) VALUES (?, ?)
         ON CONFLICT(order_id) DO UPDATE SET seq = excluded.seq`,
        ev.aggregate_id, ev.seq
      );
    });
    console.log(`[mail] send seq=${ev.seq} 注文${ev.aggregate_id}「${subject}」`);
  }

  inbox() {
    return {
      mails: this.sql.exec(`SELECT * FROM mails ORDER BY rowid`).toArray(),
      pending: this.sql.exec(`SELECT seq, order_id, prev_seq FROM pending ORDER BY seq`).toArray(),
    };
  }
}

const orders = (env) => env.ORDERS.get(env.ORDERS.idFromName("main"));
const mail = (env) => env.MAIL.get(env.MAIL.idFromName("main"));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const [, a, b] = url.pathname.split("/");

    if (a === "orders" && b && req.method === "PUT") {
      const { status } = await req.json();
      await orders(env).upsert(Number(b), status);
      return Response.json({ ok: true });
    }
    if (a === "orders" && b && req.method === "DELETE") {
      await orders(env).remove(Number(b));
      return Response.json({ ok: true });
    }
    if (a === "flags" && !b) return Response.json(await flags.all(env));
    if (a === "flags" && b && req.method === "PUT") {
      if (!(b in flags.FLAGS)) return new Response(`unknown flag: ${b}\n`, { status: 400 });
      const on = url.searchParams.get("on") !== "0";
      await flags.set(env, b, on);
      if (!on) await orders(env).wake();           // 復旧したら溜まった分を流す
      return Response.json(await flags.all(env));
    }
    if (a === "debug") {
      return Response.json({ ...(await orders(env).debug()), flags: await flags.all(env) });
    }
    if (a === "mails") return Response.json(await mail(env).inbox());

    return new Response(
      [
        "PUT    /orders/:id  {\"status\":\"pending\"}  注文を作成・更新（pending / paid / shipped）",
        "DELETE /orders/:id                         注文を削除",
        "GET    /debug                              注文・outbox・送信済み位置・フラグ",
        "GET    /mails                              送ったメール（受信箱の代わり）と保留中のイベント",
        "GET    /flags                              障害フラグの一覧",
        "PUT    /flags/:name?on=1|0                 障害フラグを ON / OFF",
        ...Object.entries(flags.FLAGS).map(([name, desc]) => `         ${name.padEnd(26)} ${desc}`),
      ].join("\n") + "\n"
    );
  },

  // Queue の consumer
  async queue(batch, env) {
    await mail(env).receive(batch.messages.map((m) => m.body));
    batch.ackAll();
  },
};
