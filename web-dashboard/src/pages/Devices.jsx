import React, { useState, useEffect } from "react";
import { getApiUrl, getGatewayUrl, setGatewayUrl } from "../services/gateway.js";
import { authenticatedFetch } from "../services/adminAuth.js";

const STORAGE_DEVICES = "devices_cache";
const STORAGE_SUBNETS = "devices_subnets";
const STORAGE_SCAN_INFO = "devices_scan_info";

function subnetValue(item) {
  return String(item?.subnet || item || "").trim();
}

function isValidCidr(value) {
  const m = String(value).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  return octets.every(n => n >= 0 && n <= 255) && prefix >= 1 && prefix <= 32;
}

function subnetSourceLabel(sources = []) {
  const labels = {
    local_interface: "本机网卡",
    adb_connected: "ADB 设备",
    route: "路由表",
    manual: "手动添加",
    discovered_device: "历史设备",
    history: "历史记录",
    inferred_neighbor: "邻近推理",
    inferred_private: "常见网段",
    search_exact: "搜索输入",
    android_probe: "安卓探测",
    balanced_private: "智能遍历",
    exhaustive_private: "全量遍历",
  };
  return sources.map(s => labels[s] || s).join(" / ") || "候选";
}

function subnetCandidateDetail(item) {
  const parts = [];
  if (item.ip) parts.push(item.adapter ? `${item.adapter} ${item.ip}` : item.ip);
  else if (item.adapter) parts.push(item.adapter);
  if (item.route && item.route !== item.subnet) parts.push(`路由 ${item.route}`);
  if (item.gateway && item.gateway !== "0.0.0.0") parts.push(`via ${item.gateway}`);
  return parts.join(" | ");
}

function confidenceMeta(value = 0) {
  if (value >= 85) return { label: "高", className: "text-green-400 bg-green-500/10 border-green-500/20" };
  if (value >= 55) return { label: "中", className: "text-amber-400 bg-amber-500/10 border-amber-500/20" };
  return { label: "低", className: "text-zinc-400 bg-zinc-800 border-zinc-700" };
}

function candidateSearchText(item) {
  return [
    item.subnet,
    subnetSourceLabel(item.sources),
    subnetCandidateDetail(item),
    item.tier,
    item.adapter,
    item.ip,
    item.route,
    item.gateway,
    item.inferredFrom,
    item.confidence,
    item.probe?.status,
    item.androidProbe?.status,
    ...(item.androidProbe?.openHosts || []),
    ...(item.probe?.targets || []).map(t => `${t.ip} ${t.alive ? "reachable" : "no_reply"}`),
    ...(item.reasons || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function isIpLikeSearch(value) {
  const s = value.trim();
  return /\d/.test(s) && /^[\d./\s]+$/.test(s);
}

function candidateMatchesSearch(item, search) {
  if (!search) return true;
  if (isIpLikeSearch(search)) {
    return [
      item.subnet,
      item.ip,
      item.route,
      item.gateway,
    ].filter(Boolean).join(" ").toLowerCase().includes(search);
  }
  return candidateSearchText(item).includes(search);
}

function isPrivateIpv4(a, b) {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function subnetFromSearch(value) {
  const s = value.trim();
  const full = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?(?:\/(\d{1,2}))?$/);
  if (!full) return null;
  const a = Number(full[1]);
  const b = Number(full[2]);
  const c = Number(full[3]);
  const d = full[4] === undefined ? 0 : Number(full[4]);
  const prefix = full[5] === undefined ? 24 : Number(full[5]);
  if ([a, b, c, d].some(n => n < 0 || n > 255)) return null;
  if (prefix !== 24) return null;
  if (!isPrivateIpv4(a, b)) return null;
  return `${a}.${b}.${c}.0/24`;
}

function searchSubnetCandidate(search, candidates) {
  const subnet = subnetFromSearch(search);
  if (!subnet || candidates.some(item => item.subnet === subnet)) return null;
  return {
    subnet,
    sources: ["search_exact"],
    reasons: [`由搜索输入 ${search} 生成的 /24 私有网段候选`],
    confidence: 62,
    tier: "inferred",
  };
}

export default function Devices() {
  // 从 localStorage 恢复缓存（切换 tab 不丢失）
  const [devices, setDevices] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_DEVICES)) || []; } catch { return []; }
  });
  const [subnets, setSubnets] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_SUBNETS)) || []; } catch { return []; }
  });
  const [scanInfo, setScanInfo] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_SCAN_INFO)); } catch { return null; }
  });
  const [scanning, setScanning] = useState(false);
  const [actionLoading, setActionLoading] = useState({});
  const [manualIp, setManualIp] = useState("");
  const [newSubnet, setNewSubnet] = useState("");
  const [scanPort, setScanPort] = useState("5555");
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [subnetPickerOpen, setSubnetPickerOpen] = useState(false);
  const [subnetCandidates, setSubnetCandidates] = useState([]);
  const [subnetCandidatesLoading, setSubnetCandidatesLoading] = useState(false);
  const [subnetCandidatesError, setSubnetCandidatesError] = useState("");
  const [selectedCandidateSubnets, setSelectedCandidateSubnets] = useState([]);
  const [subnetCandidateMode, setSubnetCandidateMode] = useState("direct");
  const [subnetCandidateSearch, setSubnetCandidateSearch] = useState("");
  const [subnetCandidateFilter, setSubnetCandidateFilter] = useState("all");
  const [subnetCandidateVisibleLimit, setSubnetCandidateVisibleLimit] = useState(200);

  const [gwTick, setGwTick] = useState(0); // 采用同源网关后强制重算 gatewayConfigured
  const gatewayUrl = getGatewayUrl();
  const gatewayConfigured = !!gatewayUrl;

  // 未配置网关，但当前页面其实由【本机网关】同源托管（非云端）→ 自动采用该 origin，消除误报、放开设备扫描。
  useEffect(() => {
    if (gatewayConfigured) return;
    let alive = true;
    fetch(`${window.location.origin}/api/health`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.mode !== "cloud" && d?.status === "ok") {
          if (!getGatewayUrl()) setGatewayUrl(window.location.origin);
          setGwTick((t) => t + 1);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [gatewayConfigured, gwTick]);

  function getConfiguredSubnets() {
    return subnets.map(subnetValue).filter(isValidCidr);
  }

  // 持久化到 localStorage
  useEffect(() => { localStorage.setItem(STORAGE_DEVICES, JSON.stringify(devices)); }, [devices]);
  useEffect(() => { localStorage.setItem(STORAGE_SUBNETS, JSON.stringify(subnets)); }, [subnets]);
  useEffect(() => { if (scanInfo) localStorage.setItem(STORAGE_SCAN_INFO, JSON.stringify(scanInfo)); }, [scanInfo]);

  // 页面加载：仅刷新已连接设备的实时状态（不触发扫描）
  useEffect(() => {
    if (!gatewayConfigured) return;
    safeFetch(getApiUrl("/api/devices/quick"))
      .then((d) => {
        if (!d?.ok) return;
        const connectedIPs = new Set(
          (d.data.connectedDevices || []).filter(dev => dev.ip && dev.state === "device").map(dev => dev.ip)
        );
        // 更新缓存中设备的连接状态
        setDevices(prev => prev.map(dev => ({
          ...dev,
          status: connectedIPs.has(dev.ip) ? "connected" : "discovered",
        })));
      })
      .catch(() => {});
  }, []);

  async function safeFetch(url, options) {
    if (!gatewayConfigured && !url.startsWith("http")) {
      throw new Error("请先在设置页面配置本地网关地址");
    }
    let resp;
    try {
      const method = String(options?.method || "GET").toUpperCase();
      const transport = method === "GET" || method === "HEAD"
        ? fetch
        : authenticatedFetch;
      resp = await transport(url, options);
    } catch (e) {
      if (e.name === "AbortError") throw new Error("请求超时（60秒）");
      throw new Error(`无法连接网关 (${gatewayUrl})：${e.message}`);
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      // 读取实际返回内容帮助诊断
      const text = await resp.text().catch(() => "");
      const preview = text.slice(0, 100);
      // Express 默认 404 = HTML，正文包含 "Cannot POST /xxx"，多半是网关代码过旧没有该路由
      if (resp.status === 404) {
        const m = text.match(/Cannot\s+(GET|POST|PUT|DELETE|PATCH)\s+(\S+)/);
        if (m) {
          throw new Error(`网关 404：${m[1]} ${m[2]} 路由不存在。多半是网关版本过旧未包含此接口，重启网关（cd gateway && npm start）后重试。`);
        }
      }
      if (text.includes("<!DOCTYPE") || text.includes("<html")) {
        throw new Error(`网关地址 (${gatewayUrl}) 返回了 HTML 页面而非 API 响应。请确认地址指向本机网关（端口 3001），而非 Web 面板（端口 8080 或 3000）。`);
      }
      throw new Error(`网关返回非 JSON (HTTP ${resp.status}): ${preview || "(空)"}`);
    }
    return resp.json();
  }

  async function handleDiscover() {
    setScanning(true);
    setScanInfo(null);
    try {
      const params = new URLSearchParams();
      const subnetList = getConfiguredSubnets();
      if (subnetList.length > 0) params.set("subnets", subnetList.join(","));
      if (scanPort && scanPort !== "5555") params.set("port", scanPort);
      const requestUrl = getApiUrl(`/api/devices/discover${params.toString() ? "?" + params : ""}`);
      console.log("[Devices] scan url:", requestUrl, "| gateway:", gatewayUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      let d;
      try {
        d = await safeFetch(requestUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (d.ok) {
        const currentPort = parseInt(scanPort) || 5555;
        const newDevices = d.data.devices || [];
        // 合并策略：移除相同端口的旧结果，保留不同端口的设备
        setDevices(prev => {
          const kept = prev.filter(dev => (dev.port || 5555) !== currentPort);
          // 用 IP+Port 去重，新结果覆盖旧结果
          const merged = [...kept];
          for (const nd of newDevices) {
            const idx = merged.findIndex(d => d.ip === nd.ip && (d.port || 5555) === (nd.port || 5555));
            if (idx >= 0) merged[idx] = nd;
            else merged.push(nd);
          }
          return merged;
        });
        setSubnets(prev => {
          const newSubnets = (d.data.subnets || []).map(s => typeof s === "string" ? { subnet: s } : s);
          const existing = new Set(prev.map(s => s.subnet || s));
          const toAdd = newSubnets.filter(s => !existing.has(s.subnet || s));
          return [...prev, ...toAdd];
        });
        setScanInfo({ aliveCount: d.data.aliveCount, scanDuration: d.data.scanDuration, port: currentPort });
      } else {
        setScanInfo({ error: d.error });
      }
    } catch (e) {
      setScanInfo({ error: e.message });
    }
    setScanning(false);
  }

  async function handleConnect(ip, port = 5555) {
    setActionLoading(p => ({ ...p, [ip]: true }));
    try {
      const d = await safeFetch(getApiUrl("/api/devices/connect"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, port }),
      });
      if (d.ok && d.data.connected) {
        setDevices(prev => {
          const exists = prev.some(dev => dev.ip === ip);
          if (exists) return prev.map(dev => dev.ip === ip ? { ...dev, status: "connected", model: d.data.model || dev.model } : dev);
          return [...prev, { ip, port, status: "connected", model: d.data.model, product: d.data.product, androidVersion: d.data.androidVersion, source: "manual" }];
        });
      }
    } catch {}
    setActionLoading(p => ({ ...p, [ip]: false }));
  }

  async function handleDisconnect(serial) {
    const ip = serial.split(":")[0];
    setActionLoading(p => ({ ...p, [ip]: true }));
    try {
      await safeFetch(getApiUrl("/api/devices/disconnect"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial }),
      });
      setDevices(prev => prev.map(dev => dev.ip === ip ? { ...dev, status: "discovered" } : dev));
    } catch {}
    setActionLoading(p => ({ ...p, [ip]: false }));
  }

  function handleAddSubnet() {
    const s = newSubnet.trim();
    if (!s || !isValidCidr(s)) return;
    setSubnets(prev => [...prev.filter(x => (x.subnet || x) !== s), { subnet: s, source: "manual" }]);
    setNewSubnet("");
  }

  async function loadSubnetCandidates(mode = subnetCandidateMode) {
    setSubnetCandidatesLoading(true);
    setSubnetCandidatesError("");
    setSubnetCandidateMode(mode);
    setSubnetCandidateVisibleLimit(200);
    try {
      const params = new URLSearchParams();
      if (mode === "advanced") {
        params.set("mode", "advanced");
        params.set("radius", "12");
      } else if (mode === "exhaustive") {
        params.set("mode", "exhaustive");
      } else if (mode === "smart") {
        params.set("mode", "smart");
        params.set("radius", "16");
      } else if (mode === "android") {
        params.set("mode", "android");
        params.set("radius", "16");
        params.set("port", scanPort || "5555");
      }
      const d = await safeFetch(getApiUrl(`/api/devices/subnet-candidates${params.toString() ? "?" + params : ""}`));
      if (d.ok) {
        setSubnetCandidates(d.data?.subnets || []);
        setSelectedCandidateSubnets(prev => prev.filter(s => (d.data?.subnets || []).some(item => item.subnet === s)));
      } else {
        setSubnetCandidatesError(d.error || "获取候选网段失败");
      }
    } catch (e) {
      setSubnetCandidatesError(e.message);
    }
    setSubnetCandidatesLoading(false);
  }

  async function handleToggleSubnetPicker() {
    const nextOpen = !subnetPickerOpen;
    setSubnetPickerOpen(nextOpen);
    if (nextOpen && subnetCandidates.length === 0 && !subnetCandidatesLoading) {
      await loadSubnetCandidates();
    }
  }

  function handleToggleCandidateSubnet(subnet) {
    setSelectedCandidateSubnets(prev =>
      prev.includes(subnet) ? prev.filter(s => s !== subnet) : [...prev, subnet]
    );
  }

  function handleSelectAllCandidateSubnets() {
    setSelectedCandidateSubnets(filteredSubnetCandidates
      .map(item => item.subnet)
      .filter(subnet => isValidCidr(subnet) && !configuredSubnetSet.has(subnet)));
  }

  function handleSelectHighConfidenceCandidateSubnets() {
    setSelectedCandidateSubnets(filteredSubnetCandidates
      .filter(item => (item.confidence || 0) >= 70)
      .map(item => item.subnet)
      .filter(subnet => isValidCidr(subnet) && !configuredSubnetSet.has(subnet)));
  }

  function handleAddSelectedCandidateSubnets() {
    const selectedSubnets = selectedCandidateSubnets.filter(isValidCidr);
    if (selectedSubnets.length === 0) return;
    setSubnets(prev => {
      const existing = new Set(prev.map(subnetValue));
      const next = [...prev];
      for (const subnet of selectedSubnets) {
        if (!existing.has(subnet)) {
          next.push({ subnet, source: "manual" });
          existing.add(subnet);
        }
      }
      return next;
    });
    setSelectedCandidateSubnets([]);
  }

  function handleDeleteSubnet(subnet) {
    setSubnets(prev => prev.filter(s => (s.subnet || s) !== subnet));
  }

  function handleRemoveDevice(ip) {
    setDevices(prev => prev.filter(d => d.ip !== ip));
  }

  function handleClearAll() {
    setDevices([]);
    setSubnets([]);
    setScanInfo(null);
    localStorage.removeItem(STORAGE_DEVICES);
    localStorage.removeItem(STORAGE_SUBNETS);
    localStorage.removeItem(STORAGE_SCAN_INFO);
  }

  function handleManualConnect() {
    const ip = manualIp.trim();
    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return;
    handleConnect(ip, parseInt(scanPort) || 5555);
    setManualIp("");
  }

  async function handleDiagnose() {
    setDiagnosing(true);
    setDiagOpen(true);
    setDiagResult(null);
    try {
      const subnetList = getConfiguredSubnets();
      const d = await safeFetch(getApiUrl("/api/devices/diagnose"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subnets: subnetList, port: parseInt(scanPort) || 5555 }),
      });
      if (d.ok) setDiagResult(d.data);
      else setDiagResult({ error: d.error || "诊断失败" });
    } catch (e) {
      setDiagResult({ error: e.message });
    }
    setDiagnosing(false);
  }

  const automotiveDevices = devices.filter(d => d.isAutomotive);
  const otherDevices = devices.filter(d => !d.isAutomotive);
  const configuredSubnetSet = new Set(getConfiguredSubnets());
  const normalizedCandidateSearch = subnetCandidateSearch.trim().toLowerCase();
  const generatedSearchCandidate = searchSubnetCandidate(normalizedCandidateSearch, subnetCandidates);
  const subnetCandidatePool = generatedSearchCandidate ? [generatedSearchCandidate, ...subnetCandidates] : subnetCandidates;
  const filteredSubnetCandidates = subnetCandidatePool.filter(item => {
    const added = configuredSubnetSet.has(item.subnet);
    const matchesSearch = candidateMatchesSearch(item, normalizedCandidateSearch);
    if (!matchesSearch) return false;
    if (subnetCandidateFilter === "direct") return item.tier !== "inferred";
    if (subnetCandidateFilter === "inferred") return item.tier === "inferred";
    if (subnetCandidateFilter === "high") return (item.confidence || 0) >= 70;
    if (subnetCandidateFilter === "reachable") return item.probe?.status === "reachable";
    if (subnetCandidateFilter === "android") return ["adb_connected", "adb_port_open"].includes(item.androidProbe?.status);
    if (subnetCandidateFilter === "unadded") return !added;
    if (subnetCandidateFilter === "added") return added;
    return true;
  });
  const visibleSubnetCandidates = filteredSubnetCandidates.slice(0, subnetCandidateVisibleLimit);
  const pendingSelectedCandidateSubnets = selectedCandidateSubnets.filter(subnet => !configuredSubnetSet.has(subnet));
  const candidateFilterOptions = [
    { id: "all", label: "全部" },
    { id: "direct", label: "确定" },
    { id: "inferred", label: "推理" },
    { id: "high", label: "高可信" },
    { id: "reachable", label: "可达" },
    { id: "android", label: "安卓" },
    { id: "unadded", label: "未添加" },
    { id: "added", label: "已添加" },
  ];

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      {/* 网关提示 */}
      {!gatewayConfigured && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-start gap-3">
          <span className="text-amber-400 text-lg shrink-0">!</span>
          <div>
            <p className="text-xs text-amber-400 font-medium">未配置本地网关</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              设备扫描在你的本机执行。请先在本机启动网关（<code className="text-zinc-400">bash start.sh</code>），然后在 <a href="/settings" className="text-blue-400 underline">设置</a> 中配置 <code className="text-zinc-400">http://localhost:3001</code>。
            </p>
          </div>
        </div>
      )}

      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-300">车机设备</h2>
          <p className="text-xs text-zinc-600 mt-0.5">扫描在本机网关执行，结果保存在本地浏览器</p>
        </div>
        <div className="flex items-center gap-2">
          {devices.length > 0 && (
            <button onClick={handleClearAll} className="px-3 py-2 text-xs rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition">
              清空
            </button>
          )}
          <button
            onClick={handleDiagnose}
            disabled={diagnosing || !gatewayConfigured}
            className="px-3 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 transition shrink-0"
            title="检查为什么扫描不到设备：分析本机网卡、子网覆盖、TCP 可达性等"
          >
            {diagnosing ? "检测中..." : "环境检测"}
          </button>
          <button
            onClick={handleDiscover}
            disabled={scanning || !gatewayConfigured}
            className="px-4 py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition shrink-0"
          >
            {scanning ? (
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                扫描中...
              </span>
            ) : "扫描发现"}
          </button>
        </div>
      </div>

      {/* 环境检测结果弹窗 */}
      {diagOpen && (
        <DiagnoseModal
          loading={diagnosing}
          result={diagResult}
          onClose={() => setDiagOpen(false)}
          onRerun={handleDiagnose}
        />
      )}

      {/* 扫描配置 */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-500 font-medium">扫描配置</p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleSubnetPicker}
              disabled={!gatewayConfigured}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 transition"
            >
              {subnetPickerOpen ? "收起候选网段" : "选择网段"}
            </button>
            <span className="text-xs text-zinc-600">端口:</span>
            <input type="number" value={scanPort} onChange={e => setScanPort(e.target.value)}
              className="w-20 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none focus:border-zinc-500 text-center" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {subnets.map(s => {
            const subnet = s.subnet || s;
            return (
              <span key={subnet} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400">
                <span className={`w-1.5 h-1.5 rounded-full ${s.source === "manual" ? "bg-blue-500" : "bg-zinc-600"}`} />
                {subnet}
                <button onClick={() => handleDeleteSubnet(subnet)} className="text-zinc-600 hover:text-red-400 ml-0.5">&times;</button>
              </span>
            );
          })}
        </div>
        {subnetPickerOpen && (
          <div className="border border-zinc-800 bg-zinc-950/40 rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-zinc-400">候选网段</p>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  {subnetCandidateMode === "advanced"
                    ? "高级推理：确定来源 + 邻近 /24 循环枚举 + 常见私有网段"
                    : subnetCandidateMode === "smart"
                      ? "智能探测：综合路由/历史/常见车机网段，并对高优先候选做 ping 抽样"
                    : subnetCandidateMode === "android"
                      ? "安卓探测：只保留已有 ADB 连接或发现 ADB 端口开放的网段"
                    : subnetCandidateMode === "exhaustive"
                      ? "全量遍历：枚举 10/8、172.16/12、192.168/16 的全部 /24 私有网段"
                    : "确定来源：本机网卡、已连接 ADB、路由表和历史记录"}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => loadSubnetCandidates("direct")}
                  disabled={subnetCandidatesLoading}
                  className="px-2.5 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 transition"
                >
                  {subnetCandidatesLoading && subnetCandidateMode === "direct" ? "刷新中..." : "直接刷新"}
                </button>
                <button
                  onClick={() => loadSubnetCandidates("smart")}
                  disabled={subnetCandidatesLoading}
                  className="px-2.5 py-1.5 text-xs rounded bg-emerald-600/15 hover:bg-emerald-600/25 disabled:opacity-50 text-emerald-300 border border-emerald-500/20 transition"
                >
                  {subnetCandidatesLoading && subnetCandidateMode === "smart" ? "探测中..." : "智能探测"}
                </button>
                <button
                  onClick={() => loadSubnetCandidates("android")}
                  disabled={subnetCandidatesLoading}
                  className="px-2.5 py-1.5 text-xs rounded bg-green-600/15 hover:bg-green-600/25 disabled:opacity-50 text-green-300 border border-green-500/20 transition"
                >
                  {subnetCandidatesLoading && subnetCandidateMode === "android" ? "识别中..." : "安卓探测"}
                </button>
                <button
                  onClick={() => loadSubnetCandidates("advanced")}
                  disabled={subnetCandidatesLoading}
                  className="px-2.5 py-1.5 text-xs rounded bg-blue-600/20 hover:bg-blue-600/30 disabled:opacity-50 text-blue-300 border border-blue-500/20 transition"
                >
                  {subnetCandidatesLoading && subnetCandidateMode === "advanced" ? "推理中..." : "推理枚举"}
                </button>
                <button
                  onClick={() => loadSubnetCandidates("exhaustive")}
                  disabled={subnetCandidatesLoading}
                  className="px-2.5 py-1.5 text-xs rounded bg-amber-600/15 hover:bg-amber-600/25 disabled:opacity-50 text-amber-300 border border-amber-500/20 transition"
                >
                  {subnetCandidatesLoading && subnetCandidateMode === "exhaustive" ? "遍历中..." : "全量遍历"}
                </button>
                <button
                  onClick={handleSelectHighConfidenceCandidateSubnets}
                  disabled={subnetCandidatesLoading || subnetCandidatePool.length === 0}
                  className="px-2.5 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 transition"
                >
                  全选高可信
                </button>
                <button
                  onClick={handleSelectAllCandidateSubnets}
                  disabled={subnetCandidatesLoading || subnetCandidatePool.length === 0}
                  className="px-2.5 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 transition"
                >
                  全选未添加
                </button>
              </div>
            </div>

            {subnetCandidatesLoading ? (
              <div className="py-6 text-center text-xs text-zinc-500">
                <span className="inline-block w-1.5 h-1.5 bg-zinc-400 rounded-full animate-pulse mr-2" />
                {subnetCandidateMode === "exhaustive"
                  ? "正在遍历全部私有 /24 网段..."
                  : subnetCandidateMode === "android"
                    ? "正在 ping 抽样并识别 ADB 端口..."
                  : subnetCandidateMode === "smart"
                    ? "正在生成候选并 ping 抽样探测..."
                  : subnetCandidateMode === "advanced"
                    ? "正在推理枚举候选网段..."
                    : "正在读取候选网段..."}
              </div>
            ) : subnetCandidatesError ? (
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
                {subnetCandidatesError}
              </div>
            ) : subnetCandidatePool.length === 0 ? (
              <div className="text-xs text-zinc-500 bg-zinc-900/60 border border-zinc-800 rounded p-3">
                暂无候选网段，可以先手动输入。
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <input
                    type="text"
                    value={subnetCandidateSearch}
                    onChange={e => setSubnetCandidateSearch(e.target.value)}
                    placeholder="搜索网段、来源、接口、路由或推理原因"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-600"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      {candidateFilterOptions.map(option => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setSubnetCandidateFilter(option.id)}
                          className={`px-2.5 py-1 text-xs rounded border transition ${
                            subnetCandidateFilter === option.id
                              ? "border-blue-500/40 bg-blue-600/20 text-blue-300"
                              : "border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-600">显示 {filteredSubnetCandidates.length} / {subnetCandidatePool.length}</span>
                      {(subnetCandidateSearch || subnetCandidateFilter !== "all") && (
                        <button
                          type="button"
                          onClick={() => { setSubnetCandidateSearch(""); setSubnetCandidateFilter("all"); }}
                          className="text-xs text-zinc-500 hover:text-zinc-300"
                        >
                          清空过滤
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {filteredSubnetCandidates.length === 0 ? (
                  <div className="text-xs text-zinc-500 bg-zinc-900/60 border border-zinc-800 rounded p-3">
                    没有匹配的候选网段。
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                    {visibleSubnetCandidates.map(item => {
                  const added = configuredSubnetSet.has(item.subnet);
                  const checked = selectedCandidateSubnets.includes(item.subnet);
                  const detail = subnetCandidateDetail(item);
                  return (
                    <label
                      key={item.subnet}
                      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs transition ${
                        added
                          ? "border-zinc-800 bg-zinc-900/50 opacity-60"
                          : "border-zinc-800 bg-zinc-900 hover:border-zinc-600 cursor-pointer"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-blue-500"
                        checked={checked}
                        disabled={added}
                        onChange={() => handleToggleCandidateSubnet(item.subnet)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-zinc-200">{item.subnet}</span>
                          {(() => {
                            const meta = confidenceMeta(item.confidence);
                            return (
                              <span className={`text-[10px] rounded border px-1.5 py-0.5 ${meta.className}`}>
                                {meta.label} {item.confidence || 0}
                              </span>
                            );
                          })()}
                          {item.tier === "inferred" && (
                            <span className="text-[10px] text-blue-300 bg-blue-500/10 rounded px-1.5 py-0.5">推理</span>
                          )}
                          {item.probe?.status === "reachable" && (
                            <span className="text-[10px] text-emerald-300 bg-emerald-500/10 rounded px-1.5 py-0.5">ping 可达</span>
                          )}
                          {item.probe?.status === "no_reply" && (
                            <span className="text-[10px] text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5">ping 未响应</span>
                          )}
                          {item.androidProbe?.status === "adb_port_open" && (
                            <span className="text-[10px] text-green-300 bg-green-500/10 rounded px-1.5 py-0.5">ADB 端口</span>
                          )}
                          {item.androidProbe?.status === "adb_connected" && (
                            <span className="text-[10px] text-green-300 bg-green-500/10 rounded px-1.5 py-0.5">ADB 已连</span>
                          )}
                          {added && <span className="text-[10px] text-green-400 bg-green-500/10 rounded px-1.5 py-0.5">已添加</span>}
                        </span>
                        <span className="block text-[11px] text-zinc-500 mt-0.5">{subnetSourceLabel(item.sources)}</span>
                        {detail && <span className="block text-[11px] text-zinc-600 mt-0.5 truncate">{detail}</span>}
                        {item.reasons?.length > 0 && (
                          <span className="block text-[11px] text-zinc-500 mt-0.5 line-clamp-2">{item.reasons[0]}</span>
                        )}
                      </span>
                    </label>
                  );
                    })}
                  </div>
                )}
                {filteredSubnetCandidates.length > visibleSubnetCandidates.length && (
                  <div className="flex items-center justify-center pt-1">
                    <button
                      type="button"
                      onClick={() => setSubnetCandidateVisibleLimit(v => v + 200)}
                      className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
                    >
                      再显示 200 个（已显示 {visibleSubnetCandidates.length} / {filteredSubnetCandidates.length}）
                    </button>
                  </div>
                )}
              </>
            )}

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-zinc-600">已选择 {pendingSelectedCandidateSubnets.length} 个未添加网段</span>
              <button
                onClick={handleAddSelectedCandidateSubnets}
                disabled={pendingSelectedCandidateSubnets.length === 0}
                className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
              >
                添加选中
              </button>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <input type="text" value={newSubnet} onChange={e => setNewSubnet(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAddSubnet()}
            placeholder="添加网段，如 10.0.1.0/24"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500" />
          <button onClick={handleAddSubnet} disabled={!newSubnet.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-300 transition">
            添加
          </button>
        </div>
        {scanInfo && (
          <p className="text-xs text-zinc-600">
            {scanInfo.error
              ? `扫描失败: ${scanInfo.error}`
              : `扫描用时: ${(scanInfo.scanDuration / 1000).toFixed(1)}s | 端口开放: ${scanInfo.aliveCount} | 设备: ${devices.length}`}
          </p>
        )}
      </div>

      {/* 手动连接 */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <p className="text-xs text-zinc-500 mb-2">手动连接</p>
        <div className="flex gap-2">
          <input type="text" value={manualIp} onChange={e => setManualIp(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleManualConnect()}
            placeholder="输入 IP 地址"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500" />
          <button onClick={handleManualConnect} disabled={!manualIp.trim()}
            className="px-4 py-2 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-300 transition">
            连接
          </button>
        </div>
      </div>

      {/* 车机设备 */}
      {automotiveDevices.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">车机设备 ({automotiveDevices.length})</h3>
          <div className="space-y-2">
            {automotiveDevices.map(dev => (
              <DeviceCard key={dev.ip} dev={dev} loading={actionLoading[dev.ip]} onConnect={handleConnect} onDisconnect={handleDisconnect} onRemove={handleRemoveDevice} />
            ))}
          </div>
        </div>
      )}

      {/* 其他设备 */}
      {otherDevices.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">其他 ADB 设备 ({otherDevices.length})</h3>
          <div className="space-y-2">
            {otherDevices.map(dev => (
              <DeviceCard key={dev.ip} dev={dev} loading={actionLoading[dev.ip]} onConnect={handleConnect} onDisconnect={handleDisconnect} onRemove={handleRemoveDevice} />
            ))}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {devices.length === 0 && !scanning && (
        <div className="text-center py-16">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-violet-500/20 to-blue-600/20 flex items-center justify-center">
            <svg className="w-7 h-7 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
            </svg>
          </div>
          <p className="text-sm text-zinc-400">暂无设备</p>
          <p className="text-xs text-zinc-600 mt-1">点击"扫描发现"搜索本机网络中的车机</p>
        </div>
      )}
    </div>
  );
}

function DiagnoseModal({ loading, result, onClose, onRerun }) {
  const cat = result?.summary?.category;
  const catLabel = cat === "pc_config" ? "PC 端配置问题"
    : cat === "device" ? "设备端问题"
    : cat === "ok" ? "环境正常"
    : null;
  const catColor = cat === "pc_config" ? "text-amber-400 bg-amber-500/15 border-amber-500/30"
    : cat === "device" ? "text-blue-400 bg-blue-500/15 border-blue-500/30"
    : cat === "ok" ? "text-green-400 bg-green-500/15 border-green-500/30"
    : "text-zinc-400 bg-zinc-800 border-zinc-700";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">扫描环境检测</h2>
            {catLabel && (
              <span className={`text-xs px-2 py-0.5 rounded border ${catColor}`}>{catLabel}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onRerun} disabled={loading}
              className="px-3 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 transition">
              {loading ? "检测中..." : "重新检测"}
            </button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 px-2 py-1 text-sm">×</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading && !result && (
            <div className="text-center py-12 text-xs text-zinc-500">
              <span className="inline-block w-2 h-2 bg-zinc-400 rounded-full animate-pulse mr-2" />
              正在检测网络环境（最长约 30 秒）...
            </div>
          )}

          {result?.error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-xs text-red-300">
              诊断失败：{result.error}
            </div>
          )}

          {result?.summary?.primaryHint && (
            <div className="bg-zinc-950/50 border border-zinc-800 rounded p-3">
              <p className="text-[11px] text-zinc-500 mb-1">主要结论</p>
              <p className="text-sm text-zinc-200">{result.summary.primaryHint}</p>
              <p className="text-[11px] text-zinc-600 mt-2">
                通过 {result.summary.passed} | 警告 {result.summary.warned} | 失败 {result.summary.failed}
                {result.targetSubnets?.length ? ` | 目标子网: ${result.targetSubnets.join(", ")}` : ""}
                {result.port ? ` | 端口: ${result.port}` : ""}
              </p>
            </div>
          )}

          {result?.checks?.map((c) => <CheckItem key={c.id} item={c} />)}
        </div>
      </div>
    </div>
  );
}

function CheckItem({ item }) {
  const palette = item.status === "ok" ? "border-green-700/40 bg-green-600/5"
    : item.status === "warn" ? "border-amber-700/40 bg-amber-600/5"
    : "border-red-700/40 bg-red-600/5";
  const dot = item.status === "ok" ? "bg-green-500"
    : item.status === "warn" ? "bg-amber-500"
    : "bg-red-500";

  return (
    <div className={`border rounded p-3 ${palette}`}>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-sm text-zinc-200 font-medium">{item.title}</span>
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">{item.status}</span>
      </div>
      {item.detail && <p className="text-xs text-zinc-400 mt-1.5 break-all">{item.detail}</p>}
      {item.hint && (
        <p className="text-xs text-zinc-300 mt-1.5 bg-zinc-900/50 border border-zinc-800 rounded px-2 py-1.5">
          建议：{item.hint}
        </p>
      )}
      {item.data?.interfaces?.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {item.data.interfaces.map((i, idx) => (
            <div key={idx} className="text-[11px] font-mono text-zinc-500">
              {i.adapter}: {i.ip}/{i.prefix} ({i.cidr})
            </div>
          ))}
        </div>
      )}
      {item.data?.items && item.id === "subnet_reachability" && (
        <div className="mt-2 space-y-0.5">
          {item.data.items.map((it, idx) => (
            <div key={idx} className="text-[11px] font-mono">
              <span className={
                it.reach === "unreachable" ? "text-red-400"
                  : it.reach === "default_gateway" ? "text-amber-400"
                  : "text-green-400"
              }>
                {it.reach === "unreachable" ? "✗" : it.reach === "default_gateway" ? "!" : "✓"} {it.subnet}
              </span>
              <span className="text-zinc-500 ml-2">
                {it.reach === "direct"
                  ? `直连 ${it.directIfaces.map(i => `${i.adapter}=${i.ip}`).join(", ")}`
                  : it.reach === "routed"
                    ? `路由 ${it.specificRoute.network}/${it.specificRoute.prefix} via ${it.specificRoute.gateway}`
                    : it.reach === "default_gateway"
                      ? `默认网关 ${it.defaultRoute.gateway}`
                      : "无路由"}
              </span>
            </div>
          ))}
        </div>
      )}
      {item.data?.items && item.id === "tcp_sample" && (
        <div className="mt-2 space-y-1">
          {item.data.items.map((it, idx) => (
            <div key={idx}>
              <div className="text-[11px] text-zinc-500">
                {it.subnet}
                {it.scanned ? ` | ${it.mode === "full" ? "完整扫描" : "抽样"} ${it.scanned}/${it.totalHosts}` : ""}
                {it.stats ? ` | open ${it.stats.open}, refused ${it.stats.refused}, unreachable ${it.stats.unreachable}, timeout ${it.stats.timeout}` : ""}
              </div>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {it.probes.map((p, i) => {
                  const c = p.state === "open" ? "text-green-400 bg-green-500/10"
                    : p.state === "refused" ? "text-blue-400 bg-blue-500/10"
                    : p.state === "unreachable" ? "text-red-400 bg-red-500/10"
                    : "text-zinc-500 bg-zinc-800";
                  return (
                    <span key={i} className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${c}`}>
                      {p.ip}:{p.state}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceCard({ dev, loading, onConnect, onDisconnect, onRemove }) {
  const isConnected = dev.status === "connected";
  return (
    <div className="flex items-center justify-between p-3.5 bg-zinc-900 border border-zinc-800 rounded-xl hover:border-zinc-700 transition group">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${isConnected ? "bg-green-500" : "bg-blue-400"}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-200 font-mono">{dev.ip}</span>
            {dev.isAutomotive && (
              <span className="text-[10px] px-1.5 py-0 rounded bg-violet-500/15 text-violet-400">车机</span>
            )}
            <span className={`text-[10px] px-1.5 py-0 rounded ${isConnected ? "bg-green-500/15 text-green-400" : "bg-zinc-700 text-zinc-500"}`}>
              {isConnected ? "已连接" : "已发现"}
            </span>
          </div>
          <p className="text-xs text-zinc-500 truncate mt-0.5">
            {[dev.model, dev.androidVersion && `Android ${dev.androidVersion}`, dev.screenResolution, dev.dpi && `${dev.dpi}dpi`].filter(Boolean).join(" | ") || "未知设备"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => isConnected ? onDisconnect(`${dev.ip}:${dev.port || 5555}`) : onConnect(dev.ip, dev.port || 5555)}
          disabled={loading}
          className={`px-3 py-1.5 text-xs rounded-lg transition shrink-0 ${
            isConnected ? "bg-red-600/15 text-red-400 hover:bg-red-600/25" : "bg-blue-600/15 text-blue-400 hover:bg-blue-600/25"
          } disabled:opacity-50`}
        >
          {loading ? "..." : isConnected ? "断开" : "连接"}
        </button>
        <button
          onClick={() => onRemove(dev.ip)}
          className="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-600 hover:text-red-400 transition"
          title="移除"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>
  );
}
