import { bindings, defineConfig, exports, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "outbox-suburi",
		compatibilityDate: "2026-08-01",
		entrypoint: "src/index.js",

		// wrangler の migrations（new_sqlite_classes）の代わりに、exports で DO クラスを宣言する
		exports: {
			OrdersDB: exports.durableObject({ storage: "sqlite" }),
			MailSender: exports.durableObject({ storage: "sqlite" }),
		},

		// Queue のコンシューマ（このワーカーの queue() ハンドラで受け取る）
		triggers: [
			triggers.queue({
				name: "order-events",
				maxBatchSize: 10,
				maxBatchTimeout: 1,
			}),
		],

		env: {
			// Queue のプロデューサ（中継役が sendBatch する先）
			EVENTS: bindings.queue({ name: "order-events" }),
			// 障害フラグの置き場（src/flags.js）。本番なら id にネームスペースの ID を入れる
			FLAGS: bindings.kv(),
			// 同じワーカー内の DO クラスへのバインディング
			ORDERS: bindings.durableObject({ worker: "outbox-suburi", exportName: "OrdersDB" }),
			MAIL: bindings.durableObject({ worker: "outbox-suburi", exportName: "MailSender" }),
		},
	},
});
