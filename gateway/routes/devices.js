/**
 * 设备发现路由
 * GET  /api/devices/discover     — 自动发现车机（ping存活 + ADB探测 + automotive指纹）
 * GET  /api/devices/scan         — 完整扫描（ADB + mDNS + ARP OUI + 验证）
 * GET  /api/devices/quick        — 快速扫描（仅 ADB 已连接 + mDNS）
 * GET  /api/devices/arp          — 查看 ARP 缓存分析
 * GET  /api/devices/subnets      — 查看自动检测到的子网列表
 * DELETE /api/devices/subnets/:subnet — 删除子网
 * POST /api/devices/connect      — 手动连接指定 IP
 * POST /api/devices/disconnect   — 断开连接
 * GET  /api/devices/:serial/info — 获取设备详情
 */

import { Router } from "express";
import {
  discoverDevices,
  discoverAutomotive,
  getCachedDevices,
  quickScan,
  analyzeArpCache,
  verifyAdbConnection,
  getDeviceDetails,
  listSubnetCandidates,
} from "../services/device-discovery.js";
import { listSubnets as dbListSubnets, deleteSubnet as dbDeleteSubnet, upsertSubnet as dbUpsertSubnet, deleteDiscoveredDevice as dbDeleteDevice } from "../db/sqlite.js";
import { runDiagnose } from "../services/network-diagnose.js";
import { exec } from "child_process";
import { promisify } from "util";
import { requireAdmin } from "../services/admin-auth.js";

const execAsync = promisify(exec);
const router = Router();

// 保留发现/缓存查询的既有读取语义；修改网段、缓存或 ADB 连接状态时
// 必须通过统一管理员会话鉴权。
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  return requireAdmin(req, res, next);
});

function isValidCidr(value) {
  const m = String(value || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  return octets.every(n => n >= 0 && n <= 255) && prefix >= 1 && prefix <= 32;
}

// 获取缓存的设备列表（不触发扫描，页面加载用）
router.get("/cached", async (req, res) => {
  try {
    const devices = await getCachedDevices();
    res.json({ ok: true, data: devices });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 自动发现车机（手动触发）
router.get("/discover", async (req, res) => {
  try {
    const options = {};
    // 支持自定义网段: ?subnets=172.16.128.0/24,172.16.130.0/24
    if (req.query.subnets) {
      const customSubnets = req.query.subnets.split(",").map(s => s.trim()).filter(Boolean);
      const invalid = customSubnets.filter(s => !isValidCidr(s));
      if (invalid.length > 0) {
        return res.status(400).json({ ok: false, error: `无效的子网格式: ${invalid.join(", ")}` });
      }
      options.customSubnets = customSubnets;
    }
    // 支持自定义端口: ?port=5555
    if (req.query.port) {
      options.customPort = parseInt(req.query.port) || 5555;
    }
    const result = await discoverAutomotive(null, options);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 查看子网列表
router.get("/subnets", (req, res) => {
  res.json({ ok: true, data: dbListSubnets() });
});

// 查看可选择添加的候选网段（本机网卡 / ADB / 路由表 / 历史记录）
router.get("/subnet-candidates", async (req, res) => {
  try {
    const requestedMode = String(req.query.mode || "direct");
    const mode = ["advanced", "smart", "android", "exhaustive"].includes(requestedMode) ? requestedMode : "direct";
    const radius = Math.max(1, Math.min(parseInt(req.query.radius) || 8, 32));
    const maxCandidates = mode === "exhaustive" ? 70000 : ["smart", "android"].includes(mode) ? 10000 : 600;
    const androidPort = Math.max(1, Math.min(parseInt(req.query.port) || 5555, 65535));
    const subnets = await listSubnetCandidates({ mode, radius, maxCandidates, query: req.query.q || "", androidPort });
    res.json({ ok: true, data: { subnets } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 添加子网
router.post("/subnets", (req, res) => {
  const { subnet } = req.body;
  if (!subnet || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet)) {
    return res.status(400).json({ ok: false, error: "无效的子网格式，示例: 172.16.128.0/24" });
  }
  dbUpsertSubnet(subnet, "manual");
  res.json({ ok: true });
});

// 删除子网
router.delete("/subnets/:subnet", (req, res) => {
  const subnet = decodeURIComponent(req.params.subnet);
  dbDeleteSubnet(subnet);
  res.json({ ok: true });
});

// 删除缓存的设备
router.delete("/cached/:ip", (req, res) => {
  dbDeleteDevice(req.params.ip);
  res.json({ ok: true });
});

// 完整扫描（旧接口保留）
router.get("/scan", async (req, res) => {
  try {
    const options = {
      verifyConnections: req.query.verify !== "false",
      refreshArp: req.query.refreshArp !== "false",
      includeAllArp: req.query.allArp === "true",
    };
    const result = await discoverDevices(options);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 快速扫描
router.get("/quick", async (req, res) => {
  try {
    const result = await quickScan();
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ARP 缓存分析
router.get("/arp", async (req, res) => {
  try {
    const entries = await analyzeArpCache();
    res.json({
      ok: true,
      data: {
        total: entries.length,
        candidates: entries.filter(e => e.isCandidate),
        all: entries,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 手动连接
router.post("/connect", async (req, res) => {
  const { ip, port = 5555 } = req.body;
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return res.status(400).json({ ok: false, error: "无效的 IP 地址" });
  }
  try {
    const result = await verifyAdbConnection(ip, port, 5000);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 断开连接
router.post("/disconnect", async (req, res) => {
  const { serial } = req.body;
  if (!serial) {
    return res.status(400).json({ ok: false, error: "缺少 serial 参数" });
  }
  try {
    const { stdout } = await execAsync(`adb disconnect ${serial}`, { timeout: 5000 });
    res.json({ ok: true, message: stdout.trim() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 环境诊断 — 检查为什么扫描不到设备
// POST /api/devices/diagnose  body: { subnets: ["172.16.130.0/24"], port: 5555 }
router.post("/diagnose", async (req, res) => {
  try {
    const { subnets = [], port = 5555 } = req.body || {};
    const result = await runDiagnose(subnets, parseInt(port) || 5555);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 设备详情
router.get("/:serial/info", async (req, res) => {
  try {
    const details = await getDeviceDetails(req.params.serial);
    res.json({ ok: true, data: details });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
