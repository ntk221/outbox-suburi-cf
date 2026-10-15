# Outbox パターンの素振り（Durable Objects + Queues）

Durable Object の SQLite で、注文の更新と「外に出すイベント（outbox）」を同じトランザクションで書き、alarm で outbox を読んで Queue に流し、お客さんにメールを送る（ログに出すだけ）最小構成です。

```
PUT /orders/:id ─→ OrdersDB（Durable Object）
                     ┌ transactionSync() ───────────┐
                     │ orders … 業務テーブル         │
                     │ outbox … 外に出すイベント     │ ← 両方を同じトランザクションで書く
                     └──────────────────────────────┘
                     alarm() … outbox を読んで Queue に送る（中継役）
                                    ↓
                                Queues（order-events）
                                    ↓
                     queue() ─→ MailSender（Durable Object）
                                ・送った seq を覚えて、2回目は送らない
                                ・注文ごとに、1つ前のメールを送るまで次は保留
```

イベントには `prev_seq`（同じ注文の1つ前のイベントの seq）を入れています。MailSender は、注文ごとに最後に送った seq と `prev_seq` が一致したときだけ送り、一致しなければ保留します。

## 動かし方（ローカルだけで動きます。Cloudflare のアカウントは不要）

新しい Cloudflare CLI の `cf`（open beta）と、`cf dev` が使う Vite で動かします。Node.js 22.18 以上が必要です。

```sh
npm install
npm run dev               # ターミナル1（cf dev → Vite。http://localhost:5173）
sh demo.sh                # ターミナル2
```

もう一度最初からやり直すときは、`npm run dev` を止めて `rm -rf .cloudflare/state` してから起動し直します（DO の中身はそこに保存されています）。

`demo.sh` は次の5つを順に試します。ログ（`[relay]` / `[mail]`）はターミナル1に出ます。

1. 普通に書く → 受付・発送のメールが順に送られる
2. 送信後・位置の保存前に落とす → 同じイベントが2回届き、2回目は送らない
3. Queue の中で順番が入れ替わる（逆順で届けるモード）→ 前のメールを待ってから送る
4. Queue に送れない状態にする → outbox に未送信のイベントが溜まる
5. 復旧する → 溜まっていた分がまとめて流れる

手元（cf dev）で実行したときのログ:

```
[relay] send seq=1..2
[mail] send seq=1 注文42「ご注文を受け付けました」
[mail] send seq=2 注文42「発送しました」
[relay] send seq=3..3
[relay] 送信後・位置の保存前に落ちた！
[mail] send seq=3 注文43「ご注文を受け付けました」
[relay] send seq=3..3
[mail] skip seq=3 注文43（送信済み）
[relay] send seq=4..5（逆順で届けるモード）
[mail] hold seq=5 注文44（seq=4 待ち）
[mail] send seq=4 注文44「ご注文を受け付けました」
[mail] send seq=5 注文44「お支払いを確認しました」
[relay] Queue に送れない（未送信 3 件）retry=0
[relay] Queue に送れない（未送信 3 件）retry=1
[relay] send seq=6..8
[mail] send seq=6 注文45「ご注文を受け付けました」
[mail] send seq=7 注文45「お支払いを確認しました」
[mail] send seq=8 注文42「ご注文をキャンセルしました」
```

途中で赤い `ERROR`（`crash after send` / `queue down`）が出ますが、わざと落としているものです。alarm は例外を投げると自動で再試行されます。

## 個別に叩く

```sh
curl -X PUT    localhost:5173/orders/1 -d '{"status":"pending"}'   # pending / paid / shipped
curl -X DELETE localhost:5173/orders/1
curl localhost:5173/debug                            # 注文・outbox・送信済み位置・フラグ
curl localhost:5173/mails                            # 送ったメールと保留中のイベント
curl localhost:5173/flags                            # 障害フラグの一覧
curl -X PUT localhost:5173/flags/relay.crash-after-send          # 次の送信後に落ちる（1回落ちたら自動で OFF）
curl -X PUT "localhost:5173/flags/relay.reorder?on=1"            # on=0 で戻す
curl -X PUT "localhost:5173/flags/relay.queue-down?on=1"         # on=0 で戻す
```

## 障害の起こし方（feature flag）

わざと落とす・遅らせる類のスイッチは、feature flag と同じ形で持っています。

- 定義は `src/flags.js`（名前と説明）。値は KV（`FLAGS` バインディング）に `"1"` があれば ON。
- 障害を起こしたい場所では `await flags.isOn(env, "relay.queue-down")` と聞くだけで、`OrdersDB` は「どのスイッチがあるか」を知りません。
- 切り替えは `PUT /flags/:name?on=1|0`。`relay.crash-after-send` は1回落ちたら中継役が自分で OFF にします。
- `relay.queue-down` を OFF にすると、次の alarm 再試行を待たずに溜まった分を流します（`OrdersDB.wake()`）。
- KV に置いているので DO が再起動しても値は残ります。本番の KV は書き込みが各拠点に届くまで最大 60 秒ほどかかるので、切り替えてすぐ効かないことがあります（ローカルの `cf dev` では即時）。

## メモ

- `transactionSync()` の中で orders と outbox の両方を書くので、「注文は更新されたのにイベントが無い」は起きません。
- 中継役は「送る → 送った位置を保存」の順なので、間で落ちると同じイベントがもう一度届きます（at-least-once）。
- Queues は順序を保証しないので、「逆順で届けるモード」で入れ替わりを再現しています。
- 実際のメール送信はしていません。本物にするなら `MailSender.send()` でメール送信 API を呼びます。その場合、API 呼び出しと「送った」の記録の間で落ちると、やはり2通送られうるので、送信 API 側の冪等キー（idempotency key）に seq を渡すのが安全です。

## cf CLI まわり

- 設定は `wrangler.jsonc` ではなく `cloudflare.config.ts` です（`cf migrate` で変換し、TODO を手で直したもの）。
  - DO の `migrations`（`new_sqlite_classes`）は変換されないので、`exports: { OrdersDB: exports.durableObject({ storage: "sqlite" }) }` に置き換えています。
  - Queue のプロデューサは `env` の `bindings.queue()`、コンシューマは `triggers` の `triggers.queue()` です。
- `vite.config.ts` に `@cloudflare/vite-plugin` を入れておかないと、`cf dev` がただの Vite として起動して 404 になります。
- `npx cf deploy --dry-run` で、ログインせずにビルドとバインディングの確認ができます。
- 本番に deploy する場合（未確認）:
  ```sh
  npx cf auth login
  npx cf queues create --queue-name order-events
  npx cf deploy
  ```
- `cf` はまだ本番のログを tail できないので、見るときは `npx wrangler tail outbox-suburi` を使います。
