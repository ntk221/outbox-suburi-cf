import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// cloudflare() が cloudflare.config.ts を読んで、Worker を workerd で動かす
export default defineConfig({
	plugins: [cloudflare()],
});
