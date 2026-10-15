#!/bin/sh
# npm run dev（cf dev）を起動した状態で、別のターミナルから実行する
# ログ（[relay] / [mail]）は cf dev 側のターミナルに出る
B=${BASE_URL:-http://localhost:5173}
step() { printf '\n===== %s\n' "$1"; }

step "1. 普通に: 注文42 を受付 → 発送"
curl -s -X PUT "$B/orders/42" -d '{"status":"pending"}' >/dev/null
curl -s -X PUT "$B/orders/42" -d '{"status":"shipped"}' >/dev/null
sleep 3

step "2. 送信後・位置の保存前に落とす → 同じイベントが2回届く（2回目は送らない）"
curl -s -X PUT "$B/flags/relay.crash-after-send" >/dev/null
curl -s -X PUT "$B/orders/43" -d '{"status":"pending"}' >/dev/null
sleep 6

step "3. Queue の中で順番が入れ替わる → 前のメールを待ってから送る"
curl -s -X PUT "$B/flags/relay.reorder?on=1" >/dev/null
curl -s -X PUT "$B/orders/44" -d '{"status":"pending"}' >/dev/null
curl -s -X PUT "$B/orders/44" -d '{"status":"paid"}' >/dev/null
sleep 3
curl -s -X PUT "$B/flags/relay.reorder?on=0" >/dev/null

step "4. Queue に送れない → outbox が溜まる"
curl -s -X PUT "$B/flags/relay.queue-down?on=1" >/dev/null
curl -s -X PUT "$B/orders/45" -d '{"status":"pending"}' >/dev/null
curl -s -X PUT "$B/orders/45" -d '{"status":"paid"}' >/dev/null
curl -s -X DELETE "$B/orders/42" >/dev/null
sleep 3
echo "debug: $(curl -s "$B/debug")"

step "5. 復旧 → 溜まっていた分がまとめて流れる"
curl -s -X PUT "$B/flags/relay.queue-down?on=0" >/dev/null
sleep 8

step "送ったメール"
curl -s "$B/mails"
echo
