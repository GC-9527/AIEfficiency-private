import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gatewayTarget = process.env.VITE_GATEWAY_URL || "http://localhost:3001";
const gatewayWsTarget = gatewayTarget.replace(/^http/, "ws");

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      "/api": {
        target: gatewayTarget,
        changeOrigin: true,
        // Preserve the browser peer so local-only device control and raw
        // artifact routes can distinguish localhost from LAN callers.
        xfwd: true,
      },
      "/ws": {
        target: gatewayWsTarget,
        ws: true,
        // 网关的视频通道据此还原连接 Vite 的原始 peer，避免 LAN 客户端经代理伪装成本机。
        xfwd: true,
        // 抑制连接重置错误（网关重启/网络波动时的正常现象）
        configure: (proxy) => {
          proxy.on("error", () => {});
          proxy.on("proxyReqWs", (proxyReq, req, socket) => {
            socket.on("error", () => {});
          });
        },
      },
    },
  },
});
