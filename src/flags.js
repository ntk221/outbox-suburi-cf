// 障害をわざと起こすスイッチを feature flag として持つ
//
//   定義 … このファイル（名前と説明）
//   値   … KV（env.FLAGS）。"1" なら ON、無ければ OFF
//   判定 … 障害を起こしたい場所で isOn() を聞くだけ。切り替えは PUT /flags/:name
//
// 本物の feature flag と同じで、オブジェクトを再起動しても値は残る

export const FLAGS = {
  "relay.crash-after-send": "Queue に送ったあと・位置を保存する前に落ちる（1回落ちたら自動で OFF）",
  "relay.reorder":          "Queue に逆順で届ける（順番の入れ替わりを再現）",
  "relay.queue-down":       "Queue に送れない状態にする",
};

function assertFlag(name) {
  if (!(name in FLAGS)) throw new Error(`unknown flag: ${name}`);
}

export async function isOn(env, name) {
  assertFlag(name);
  return (await env.FLAGS.get(name)) === "1";
}

export async function set(env, name, on) {
  assertFlag(name);
  if (on) await env.FLAGS.put(name, "1");
  else await env.FLAGS.delete(name);
}

// 全フラグの現在値 { name: boolean }
export async function all(env) {
  const entries = await Promise.all(
    Object.keys(FLAGS).map(async (name) => [name, await isOn(env, name)])
  );
  return Object.fromEntries(entries);
}
