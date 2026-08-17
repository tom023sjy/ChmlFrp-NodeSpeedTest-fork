import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 显式绑定 IPv4：避免 Node 将 localhost 解析为 IPv6(::1) 导致 WebView2 走 IPv4 连接被拒（白屏/透明窗口）
  // strictPort：端口被占用时直接报错退出，防止 Vite 自动换端口造成 tauri devUrl 失配
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    cssMinify: "esbuild",
    minify: "esbuild",
  },
});
