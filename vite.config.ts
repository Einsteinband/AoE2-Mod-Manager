import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Tauri 期望固定端口，失败即报错，避免端口漂移导致 webview 白屏
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    sourcemap: false,
  },
});
