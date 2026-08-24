/**
 * 服务发现路由 /api/discovery/*：本机信息(含算力)、服务端列表、手动 peer 管理、客户端选服务端。
 */
import { Router } from "express";
import {
  announceDiscoveryNow,
  getServers,
  listLocalIps,
  probeManualPeer,
  selfInfo,
} from "../services/discovery.js";
import { getSharedVersion, getSharedBundle } from "../services/devbench/store.js";
import { getConfig, updateConfig } from "../services/config.js";
import {
  requireAuth,
  requirePeerReplicationAuth,
  isAdminPrincipal,
  requestPrincipal,
} from "../services/admin-auth.js";
import {
  configuredOutboundM2MToken,
  isTrustedPeerOrigin,
  normalizeHttpOrigin,
} from "../services/m2m-auth.js";

const router = Router();
let sharedBundleResponseCache = { version: 0, body: "" };

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || "").toLowerCase();
  return address === "::1" || address === "127.0.0.1" || address.endsWith(":127.0.0.1");
}

function isAdminRequest(req) {
  return isAdminPrincipal(requestPrincipal(req));
}

function requireLocalOrAdmin(req, res, next) {
  if (isLoopbackRequest(req) || isAdminRequest(req)) return next();
  return res.status(403).json({ ok: false, error: "该服务发现管理接口仅允许本机或管理员访问" });
}

// 本机节点信息 + 算力（供其它端/客户端轮询）
router.get("/info", (req, res) => {
  res.json({ ok: true, data: selfInfo() });
});

// 本机所有非内网 IPv4 + 当前选定的对外地址（多网卡时让用户选"其他机器访问本机"的地址）
router.get("/ips", requireLocalOrAdmin, (req, res) => {
  res.json({ ok: true, data: { ips: listLocalIps(), advertiseIp: String(getConfig().servers?.advertiseIp || "").trim() } });
});

// 设定对外 IP（空=自动取第一个）。影响 selfInfo.host 与 UDP 广播地址。
router.post("/advertise-ip", requireAuth(["super", "admin"]), (req, res) => {
  const ip = String(req.body?.ip || "").trim();
  if (ip && !listLocalIps().some((x) => x.address === ip)) return res.status(400).json({ ok: false, error: "该 IP 不在本机网卡列表中" });
  const cfg = getConfig();
  updateConfig({ servers: { ...(cfg.servers || {}), advertiseIp: ip } });
  announceDiscoveryNow();
  res.json({ ok: true, data: { advertiseIp: ip, host: selfInfo().host } });
});

// 共享配置 bundle（服务端间复制：版本更新方提供给落后方拉取）
router.get("/shared-bundle", requirePeerReplicationAuth, (req, res) => {
  const currentVersion = Number(getSharedVersion()) || 0;
  if (!sharedBundleResponseCache.body || sharedBundleResponseCache.version !== currentVersion) {
    const bundle = getSharedBundle();
    sharedBundleResponseCache = {
      version: Number(bundle.version) || currentVersion,
      body: JSON.stringify({ ok: true, data: bundle }),
    };
  }
  // 同一版本的大型共享 JSON 直接复用序列化结果；显式 ETag 避免 Express
  // 对多 MB 响应重复计算哈希。版本变化时缓存自然失效。
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("ETag", `"shared-${sharedBundleResponseCache.version}"`);
  res.send(sharedBundleResponseCache.body);
});

// 可选的服务端列表（广播 + 手动 + 本机），带实时算力。客户端下拉用。
router.get("/servers", (req, res) => {
  res.json({ ok: true, data: getServers() });
});

// 手动 peer（跨子网服务端地址）管理
router.get("/peers", requireAuth(["super", "admin"]), (req, res) => {
  res.json({ ok: true, data: getConfig().servers?.peers || [] });
});
router.post("/peers", requireAuth(["super", "admin"]), async (req, res) => {
  const host = normalizeHttpOrigin(req.body?.host);
  if (!host) {
    return res.status(400).json({
      ok: false,
      code: "DISCOVERY_PEER_ORIGIN_INVALID",
      error: "peer 必须是无用户名、路径、查询或片段的完整 http(s) origin",
    });
  }
  const cfg = getConfig();
  const peers = [...new Set([
    ...(cfg.servers?.peers || []).map(normalizeHttpOrigin).filter(Boolean),
    host,
  ])];
  updateConfig({ servers: { ...(cfg.servers || {}), peers } });
  const probe = await probeManualPeer(host);
  announceDiscoveryNow();
  res.json({ ok: true, data: peers, meta: { probe } });
});
router.delete("/peers", requireAuth(["super", "admin"]), (req, res) => {
  const host = normalizeHttpOrigin(req.query.host);
  if (!host) {
    return res.status(400).json({
      ok: false,
      code: "DISCOVERY_PEER_ORIGIN_INVALID",
      error: "peer 必须是完整 http(s) origin",
    });
  }
  const cfg = getConfig();
  const peers = (cfg.servers?.peers || [])
    .map(normalizeHttpOrigin)
    .filter((candidate) => candidate && candidate !== host);
  const clearSelection = normalizeHttpOrigin(cfg.servers?.selectedHost) === host;
  updateConfig({
    servers: {
      ...(cfg.servers || {}),
      peers,
      ...(clearSelection ? { selectedHost: "" } : {}),
    },
    ...(clearSelection ? {
      claudeProxyClient: {
        ...(cfg.claudeProxyClient || {}),
        enabled: false,
        host: "",
      },
    } : {}),
  });
  res.json({ ok: true, data: peers });
});

// 客户端选定服务端：写入 claudeProxyClient.host + servers.selectedHost；满了拒绝
router.post("/select", requireAuth(["super", "admin"]), (req, res) => {
  const rawHost = String(req.body?.host || "").trim();
  if (!rawHost) {
    // 取消选择
    const cfg = getConfig();
    updateConfig({ servers: { ...(cfg.servers || {}), selectedHost: "" }, claudeProxyClient: { ...(cfg.claudeProxyClient || {}), host: "", enabled: false } });
    return res.json({ ok: true, data: { selectedHost: "" } });
  }
  const host = normalizeHttpOrigin(rawHost);
  if (!host) {
    return res.status(400).json({
      ok: false,
      code: "DISCOVERY_CENTER_ORIGIN_INVALID",
      error: "中心地址必须是无用户名、路径、查询或片段的完整 http(s) origin",
    });
  }
  const cfg = getConfig();
  const selfOrigin = normalizeHttpOrigin(selfInfo().host);
  if (!isTrustedPeerOrigin(host, cfg, { selfOrigins: [selfOrigin] })) {
    return res.status(403).json({
      ok: false,
      code: "DISCOVERY_CENTER_NOT_TRUSTED",
      error: "自动发现节点不可直接选中；请管理员先将该 origin 明确加入 trusted peers",
    });
  }
  // 校验该服务端是否还有算力
  const target = getServers().find((s) => normalizeHttpOrigin(s.host) === host);
  if (target && target.full) return res.status(409).json({ ok: false, error: "该服务端算力已满（无空闲槽），请选其它服务端" });
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "token")) {
    return res.status(400).json({
      ok: false,
      code: "CENTER_TOKEN_NOT_ACCEPTED",
      error: "中心 M2M 口令必须通过受保护配置单独设置，不能随选择请求提交",
    });
  }
  const token = configuredOutboundM2MToken(cfg);
  if (!token) {
    return res.status(400).json({
      ok: false,
      code: "CENTER_M2M_TOKEN_REQUIRED",
      error: "选择中心前必须配置独立的 M2M 出站口令",
    });
  }
  updateConfig({
    servers: { ...(cfg.servers || {}), selectedHost: host },
    claudeProxyClient: { ...(cfg.claudeProxyClient || {}), enabled: true, host, token },
  });
  res.json({ ok: true, data: { selectedHost: host } });
});

export default router;
