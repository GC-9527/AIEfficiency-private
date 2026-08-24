/**
 * WS 本机信任判定。
 *
 * 背景：网关的 HTTP 业务路由（/api/devbench 等）对本机/可信来源请求免认证，
 * 而 WS 通道（/ws，承载 chat_stream / chat_stream_end / log 等实时事件）此前
 * 在生产模式（NODE_ENV 非 test/development）强制要求有效 admin token。
 * 这导致本机浏览器能通过 HTTP 发消息、查历史，却收不到实时流——
 * 表现为"故事点聊天窗口不显示实时信息"（所有模型均受影响，与引擎无关）。
 *
 * 本模块把"本机回环 + 受信 Origin"的判定独立出来，与 HTTP 侧的本机信任口径对齐：
 *   - 回环来源（127.0.0.1 / ::1）+ 本机 Origin（localhost/127.0.0.1/::1）→ 允许免认证；
 *   - 回环来源 + 无 Origin（桌面版 file:// 页面、本机 Node 工具）→ 允许免认证；
 *   - 回环来源 + 其它 Origin（恶意网页）→ 拒绝；
 *   - 非回环来源（LAN/远程）→ 一律要求认证（保持既有安全边界）。
 */
export function isLocalTrustedWsRequest(req = {}) {
  const remote = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "").toLowerCase();
  const loopback = remote === "127.0.0.1" || remote === "::1";
  if (!loopback) return false;

  const origin = String(req?.headers?.origin || "").trim();
  // 桌面版 file:// 内嵌面板的浏览器 Origin 是 "null"（规范），本机 Node 工具则完全
  // 不带 Origin；两者都视为本机可信。
  if (!origin || origin === "null") return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "::1"
      || host === "[::1]";
  } catch {
    return false;
  }
}
