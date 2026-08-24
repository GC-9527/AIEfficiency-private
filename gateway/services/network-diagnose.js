/**
 * 车机扫描环境诊断
 *
 * 当用户配置了某个子网（如 172.16.130.0/24）但扫不到设备时，
 * 这个模块帮助判断到底是 PC 配置问题、网络问题还是设备问题。
 *
 * 检查项：
 *   1. ADB 是否可用 / ADB server 状态
 *   2. 本机网卡 IPv4 接口列表
 *   3. 目标子网是否被任意本机接口覆盖（**关键：判定 PC 配置是否能到达**）
 *   4. 网关 / 子网内常见 IP 的 ICMP 可达性
 *   5. 子网内若干 IP 的 TCP 5555 探测样本
 *   6. mDNS 工具链是否可用
 *   7. ARP 缓存中目标子网的条目数
 *
 * 输出统一为 { ok|fail|warn, detail, hint } 结构，
 * 让前端可以渲染为带建议的清单。
 */
import { exec, execFile } from "child_process";
import net from "net";
import os from "os";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================================
// 工具：CIDR / 子网计算
// ============================================================

function ipToInt(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIp(n) {
  return [n >>> 24 & 0xff, n >>> 16 & 0xff, n >>> 8 & 0xff, n & 0xff].join(".");
}

function maskToInt(mask) {
  // mask 字符串如 "255.255.255.0"
  return ipToInt(mask);
}

function prefixToMaskInt(prefix) {
  if (prefix === 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

/** 返回 { network, prefix, broadcast } */
function parseCidr(cidr) {
  const [ipStr, prefStr] = cidr.split("/");
  const prefix = parseInt(prefStr, 10);
  const ipInt = ipToInt(ipStr);
  const maskInt = prefixToMaskInt(prefix);
  const network = (ipInt & maskInt) >>> 0;
  const broadcast = (network | (~maskInt >>> 0)) >>> 0;
  return { network, prefix, mask: maskInt, broadcast, networkIp: intToIp(network) };
}

function isIpInCidr(ip, cidr) {
  try {
    const { network, mask } = parseCidr(cidr);
    return (ipToInt(ip) & mask) >>> 0 === network;
  } catch { return false; }
}

// ============================================================
// 单项检查
// ============================================================

/** 1. ADB 可用 + 版本 + server 运行 */
async function checkAdb() {
  try {
    const { stdout } = await execAsync("adb version", { timeout: 5000 });
    const m = stdout.match(/Android Debug Bridge version\s+(\S+)/i);
    const version = m ? m[1] : stdout.trim().split("\n")[0];

    let serverOk = false;
    let connected = [];
    try {
      const r = await execAsync("adb devices", { timeout: 5000 });
      serverOk = true;
      const lines = r.stdout.split("\n").slice(1);
      for (const line of lines) {
        const m2 = line.trim().match(/^(\S+)\s+(device|offline|unauthorized)\b/);
        if (m2) connected.push({ serial: m2[1], state: m2[2] });
      }
    } catch {}

    return {
      id: "adb",
      title: "ADB 工具链",
      status: "ok",
      detail: `version: ${version} | server: ${serverOk ? "running" : "down"} | 已连接: ${connected.length}`,
      hint: connected.length === 0
        ? "当前没有任何 ADB 设备。USB 设备需先用线连一次 + 执行 `adb tcpip 5555` 才能被无线扫描发现。"
        : null,
      data: { version, connected },
    };
  } catch (err) {
    return {
      id: "adb",
      title: "ADB 工具链",
      status: "fail",
      detail: `adb 不可用: ${err.message}`,
      hint: "请安装 Android Platform-Tools 并把 adb 加入 PATH。",
    };
  }
}

/** 2. 本机网卡 IPv4 接口 */
function listLocalInterfaces() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of (addrs || [])) {
      if (addr.family === "IPv4" && !addr.internal) {
        const maskInt = maskToInt(addr.netmask);
        // 把 mask 转 prefix
        let prefix = 0;
        let m = maskInt;
        while (m & 0x80000000) { prefix++; m = (m << 1) >>> 0; }
        const networkInt = (ipToInt(addr.address) & maskInt) >>> 0;
        result.push({
          adapter: name,
          ip: addr.address,
          mask: addr.netmask,
          prefix,
          cidr: `${intToIp(networkInt)}/${prefix}`,
        });
      }
    }
  }
  return result;
}

function maskBitsFromStr(maskStr) {
  let n = ipToInt(maskStr);
  let bits = 0;
  while (n & 0x80000000) { bits++; n = (n << 1) >>> 0; }
  return bits;
}

/** Windows 路由表 — 走 PowerShell Get-NetRoute（UTF-8、结构化，不受 GBK 编码影响） */
async function getWindowsRoutingTable() {
  if (process.platform !== "win32") return [];
  try {
    // 单行 PowerShell；通过 execFile 传给 powershell.exe 避免 cmd 二次转义
    // [Console]::OutputEncoding 强制 UTF-8，避免 PowerShell 把 GBK 字节写到 stdout
    const psCmd = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.DestinationPrefix -ne $null } | ForEach-Object { $alias = $null; try { $alias = (Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).InterfaceAlias } catch {}; [PSCustomObject]@{ DestinationPrefix = $_.DestinationPrefix; NextHop = $_.NextHop; InterfaceAlias = $alias; InterfaceIndex = $_.InterfaceIndex; RouteMetric = $_.RouteMetric; InterfaceMetric = $_.InterfaceMetric } } | ConvertTo-Json -Compress -Depth 3`;
    const { stdout } = await execFileAsync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const text = stdout.trim();
    if (!text) return [];
    let parsed;
    try { parsed = JSON.parse(text); } catch { return []; }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const routes = [];
    for (const r of arr) {
      const dp = String(r.DestinationPrefix || "");
      const m = dp.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
      if (!m) continue;
      const network = m[1];
      const prefix = parseInt(m[2]);
      const netmaskInt = prefixToMaskInt(prefix);
      const netmask = intToIp(netmaskInt);
      const nextHop = String(r.NextHop || "0.0.0.0");
      const isOnLink = nextHop === "0.0.0.0";
      routes.push({
        network,
        netmask,
        gateway: isOnLink ? "On-link" : nextHop,
        iface: r.InterfaceAlias || `if#${r.InterfaceIndex}`,
        metric: (r.RouteMetric || 0) + (r.InterfaceMetric || 0),
        prefix,
      });
    }
    return routes;
  } catch (err) {
    return [];
  }
}

/** 给定目标子网，在路由表中找所有匹配的路由（按 mask 长度降序：最具体的在前） */
function findRoutesForSubnet(routes, cidr) {
  const { network: targetNet } = parseCidr(cidr);
  const matches = [];
  for (const r of routes) {
    const rNetInt = ipToInt(r.network);
    const rMaskInt = ipToInt(r.netmask);
    if (((targetNet & rMaskInt) >>> 0) === rNetInt) matches.push(r);
  }
  matches.sort((a, b) => b.prefix - a.prefix || a.metric - b.metric);
  return matches;
}

/**
 * 3. 目标子网可达性 — 综合判定（直连接口 / 显式路由 / 默认网关 / 不可达）
 *    替代旧的"必须同子网"判定，覆盖企业网常见的三层路由情形。
 */
function checkSubnetReachability(targetSubnets, interfaces, routes) {
  const items = targetSubnets.map((subnet) => {
    const directIfaces = interfaces.filter((ifc) => isIpInCidr(ifc.ip, subnet));
    const matchedRoutes = findRoutesForSubnet(routes, subnet);
    const specific = matchedRoutes.find((r) => r.prefix > 0); // 非默认路由
    const dflt = matchedRoutes.find((r) => r.prefix === 0);   // 0.0.0.0/0
    let reach;
    if (directIfaces.length > 0) reach = "direct";
    else if (specific) reach = "routed";
    else if (dflt) reach = "default_gateway";
    else reach = "unreachable";
    return {
      subnet,
      reach,
      directIfaces: directIfaces.map((i) => ({ adapter: i.adapter, ip: i.ip, cidr: i.cidr })),
      specificRoute: specific
        ? { network: specific.network, netmask: specific.netmask, gateway: specific.gateway, iface: specific.iface, metric: specific.metric, prefix: specific.prefix }
        : null,
      defaultRoute: dflt
        ? { gateway: dflt.gateway, iface: dflt.iface, metric: dflt.metric }
        : null,
    };
  });

  const unreachable = items.filter((i) => i.reach === "unreachable");
  const onlyDefault = items.filter((i) => i.reach === "default_gateway");
  const direct = items.filter((i) => i.reach === "direct");
  const routed = items.filter((i) => i.reach === "routed");

  let status, hint;
  if (unreachable.length > 0) {
    status = "fail";
    hint = "目标子网在路由表中找不到任何条目（连默认网关都没有），本机网络栈完全不通，先检查网卡是否启用、是否拿到 IP。";
  } else if (direct.length === items.length) {
    status = "ok";
    hint = null;
  } else if (routed.length > 0 || direct.length > 0) {
    status = "ok";
    hint = `存在显式路由：流量将通过 ${(routed[0]?.specificRoute?.gateway) || (direct[0] && "直连接口")} 转发到目标子网。`;
  } else {
    // 全部走默认网关 — 可能可达也可能不可达，要看默认网关是否真的转发到目标网
    status = "warn";
    hint = `没有显式到 ${onlyDefault.map((i) => i.subnet).join(", ")} 的路由，会走默认网关 (${onlyDefault[0]?.defaultRoute?.gateway})。如果同事 PC 能扫到，多半是他/她本机的路由表里多了一条静态路由（DHCP 121 / 手动 route add / VPN 推路由）。请用 PowerShell 执行 \`route print -4 | findstr 172.16.130\` 与同事对比。`;
  }

  return {
    id: "subnet_reachability",
    title: "目标子网路由可达性",
    status,
    detail: items.map((i) => `${i.subnet}: ${
      i.reach === "direct" ? `直连(${i.directIfaces[0]?.adapter}=${i.directIfaces[0]?.ip})`
      : i.reach === "routed" ? `显式路由 → ${i.specificRoute.gateway} (${i.specificRoute.network}/${i.specificRoute.prefix}, metric=${i.specificRoute.metric})`
      : i.reach === "default_gateway" ? `仅走默认网关 ${i.defaultRoute.gateway} (metric=${i.defaultRoute.metric})`
      : "无任何路由"
    }`).join(" | "),
    hint,
    data: { items },
  };
}

/** 4. 子网内常见网关 / 主机 ICMP 可达性（仅在被覆盖的子网上做） */
async function pingSubnet(subnet) {
  const isWin = process.platform === "win32";
  const flag = isWin ? "-n 1 -w 800" : "-c 1 -W 1";
  const { network, broadcast } = parseCidr(subnet);
  // 选取候选目标：网关 .1 和 .254
  const targets = [];
  if (broadcast - network > 2) {
    targets.push(intToIp(network + 1));   // .1
    targets.push(intToIp(broadcast - 1)); // .254
  }
  const results = [];
  for (const t of targets) {
    try {
      const { stdout } = await execAsync(`ping ${flag} ${t}`, { timeout: 3000 });
      const replied = isWin
        ? /TTL=|来自/i.test(stdout)
        : /1 received|bytes from/i.test(stdout);
      results.push({ ip: t, replied });
    } catch {
      results.push({ ip: t, replied: false });
    }
  }
  return results;
}

async function checkPingTargets(reach) {
  const reachable = (reach.data?.items || []).filter((i) => i.reach !== "unreachable");
  if (reachable.length === 0) {
    return {
      id: "ping",
      title: "目标子网网关 ICMP 可达性",
      status: "warn",
      detail: "未执行 — 没有任何子网在路由表中可达",
    };
  }
  const out = [];
  let anyOk = false;
  for (const item of reachable) {
    const pings = await pingSubnet(item.subnet);
    const okCount = pings.filter((p) => p.replied).length;
    if (okCount > 0) anyOk = true;
    out.push({ subnet: item.subnet, reach: item.reach, pings });
  }
  return {
    id: "ping",
    title: "目标子网 .1/.254 ICMP 可达性",
    status: anyOk ? "ok" : "warn",
    detail: anyOk
      ? `子网内至少有一台主机响应 ping`
      : "网关 / .254 都不响应（部分企业网关禁 ICMP，未必代表网络不通）",
    hint: anyOk ? null : "ICMP 不通不代表 TCP 也不通；继续看 TCP 抽样和 tracert 项。",
    data: { items: out },
  };
}

/** Windows tracert：到目标子网首跳是否真的转发出去 */
async function checkTracert(targetSubnets, reach) {
  if (process.platform !== "win32") {
    return { id: "tracert", title: "首跳路由跟踪", status: "warn", detail: "非 Windows 系统未执行" };
  }
  const items = [];
  let anyHopOk = false;
  for (const sub of targetSubnets) {
    const item = (reach.data?.items || []).find((i) => i.subnet === sub);
    if (!item || item.reach === "unreachable") {
      items.push({ subnet: sub, hops: [], note: "无路由，跳过" });
      continue;
    }
    const { network, broadcast } = parseCidr(sub);
    const target = intToIp(network + 1); // 子网的 .1
    if (broadcast - network <= 2) continue;
    try {
      const { stdout } = await execAsync(`tracert -d -h 4 -w 1000 ${target}`, { timeout: 12000 });
      const hops = [];
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+.*?(\d+\.\d+\.\d+\.\d+|\*)\s*$/);
        if (m) {
          hops.push({ idx: parseInt(m[1]), ip: m[2] });
          if (m[2] !== "*") anyHopOk = true;
        }
      }
      items.push({ subnet: sub, target, hops });
    } catch (err) {
      items.push({ subnet: sub, target, hops: [], error: err.message });
    }
  }
  return {
    id: "tracert",
    title: "首跳路由跟踪 (tracert -h 4)",
    status: anyHopOk ? "ok" : "warn",
    detail: anyHopOk ? "至少有一跳路由器响应" : "前 4 跳全部 *（可能首跳禁 ICMP，或路由黑洞）",
    hint: anyHopOk
      ? null
      : "可以同步问同事在他们机器跑 `tracert -d 172.16.130.1`，对比首跳网关 IP；如果两台机器走的是不同的首跳，就是路由配置差异。",
    data: { items },
  };
}

/** Windows Defender Firewall 当前配置文件 */
async function checkWindowsFirewall() {
  if (process.platform !== "win32") {
    return null;
  }
  try {
    const psCmd = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-NetFirewallProfile | Select-Object -Property Name,Enabled,DefaultOutboundAction | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { timeout: 8000, windowsHide: true });
    const data = JSON.parse(stdout || "[]");
    const profiles = Array.isArray(data) ? data : [data];
    const enabled = profiles.filter((p) => p.Enabled === 1 || p.Enabled === true);
    const blockedOut = profiles.filter((p) => String(p.DefaultOutboundAction).toLowerCase().includes("block"));
    let status = "ok";
    let hint = null;
    if (blockedOut.length > 0) {
      status = "fail";
      hint = `防火墙 ${blockedOut.map((p) => p.Name).join(",")} 默认出站策略为 Block，会拦截所有未明示放行的出站连接 — 这是当前最值得怀疑的差异点。可临时执行 \`Set-NetFirewallProfile -Profile ${blockedOut[0].Name} -DefaultOutboundAction Allow\`（管理员）测试是否恢复。`;
    } else if (enabled.length === 0) {
      status = "ok";
      hint = "所有配置文件已禁用，防火墙不会影响扫描。";
    }
    return {
      id: "firewall",
      title: "Windows Defender 防火墙",
      status,
      detail: profiles.map((p) => `${p.Name}: enabled=${!!p.Enabled} outbound=${p.DefaultOutboundAction}`).join(" | "),
      hint,
      data: { profiles },
    };
  } catch (err) {
    return {
      id: "firewall",
      title: "Windows Defender 防火墙",
      status: "warn",
      detail: `无法读取防火墙状态: ${(err.message || "").slice(0, 100)}`,
    };
  }
}

/** 路由表概要：默认网关 + 所有非默认显式路由（用于 UI 展示+对比同事 PC） */
function summarizeRoutes(routes) {
  const dflt = routes.filter((r) => r.prefix === 0);
  const specific = routes.filter((r) => r.prefix > 0 && r.prefix < 32 && !r.network.startsWith("224.") && !r.network.startsWith("239.") && !r.network.startsWith("255."));
  return {
    id: "routes",
    title: "路由表概要",
    status: dflt.length > 0 ? "ok" : "warn",
    detail: `默认路由 ${dflt.length} 条 | 显式路由 ${specific.length} 条`,
    hint: dflt.length === 0 ? "没有默认路由，无法访问任何外网。" : null,
    data: {
      defaultRoutes: dflt.slice(0, 5),
      specificRoutes: specific.slice(0, 30),
    },
  };
}

/** 5. 防火墙快速测试 — 本地 TCP 连接验证 socket 没被本地防火墙拦 */
async function checkLocalFirewall() {
  // 用监听一个临时端口然后自连方式，不依赖外部端口
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const client = new net.Socket();
      let done = false;
      const finish = (status, detail, hint) => {
        if (done) return;
        done = true;
        try { client.destroy(); } catch {}
        try { server.close(); } catch {}
        resolve({ id: "local_socket", title: "本机 TCP socket 出站", status, detail, hint });
      };
      client.setTimeout(2000);
      client.once("connect", () => finish("ok", `127.0.0.1:${port} 自连通过`));
      client.once("timeout", () => finish("fail", "本机 socket 自连超时", "本机防火墙可能拦截了出站 TCP；检查 Windows Defender 防火墙 / 安全软件。"));
      client.once("error", (err) => finish("fail", `socket 错误: ${err.message}`, "本机网络栈异常，重启电脑或检查网卡驱动。"));
      client.connect(port, "127.0.0.1");
    });
    server.once("error", (err) => resolve({
      id: "local_socket", title: "本机 TCP socket 出站", status: "fail",
      detail: `临时监听失败: ${err.message}`, hint: null,
    }));
  });
}

/** 6. TCP 端口探测 — /24 等小网段完整扫描，大网段抽样 */
function tcpProbe(ip, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(state);
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => finish("open"));
    sock.once("timeout", () => finish("timeout"));
    sock.once("error", (err) => {
      const msg = String(err.message || err.code || "");
      if (/ECONNREFUSED|RST|reset/i.test(msg)) finish("refused");
      else if (/EHOSTUNREACH|EADDRNOTAVAIL|ENETUNREACH/.test(msg)) finish("unreachable");
      else finish("error");
    });
    sock.connect(port, ip);
  });
}

function buildProbeTargets(subnet, maxHosts = 254) {
  const { network, broadcast } = parseCidr(subnet);
  const hostCount = Math.max(0, broadcast - network - 1);
  if (hostCount <= 0) return { targets: [], mode: "empty", totalHosts: hostCount };

  if (hostCount <= maxHosts) {
    const targets = [];
    for (let n = network + 1; n < broadcast; n++) targets.push(intToIp(n));
    return { targets, mode: "full", totalHosts: hostCount };
  }

  const picked = new Set();
  const offsets = [1, 2, 10, 20, 50, 100, 200, 254].filter((n) => n < hostCount);
  for (const offset of offsets) picked.add(intToIp(network + offset));
  while (picked.size < Math.min(32, hostCount)) {
    const offset = 1 + Math.floor(Math.random() * hostCount);
    picked.add(intToIp(network + offset));
  }
  return { targets: [...picked], mode: "sample", totalHosts: hostCount };
}

async function probeMany(ips, port, timeout = 1000, concurrency = 80) {
  const results = [];
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const states = await Promise.all(
      batch.map(async (ip) => ({ ip, state: await tcpProbe(ip, port, timeout) }))
    );
    results.push(...states);
  }
  return results;
}

async function checkTcpSample(reach, port = 5555) {
  // 只要不是 unreachable 都做探测（含 default_gateway / routed / direct）
  const reachable = (reach.data?.items || []).filter((i) => i.reach !== "unreachable");
  if (reachable.length === 0) {
    return {
      id: "tcp_sample",
      title: `目标子网 TCP ${port} 探测`,
      status: "warn",
      detail: "未执行 — 没有任何子网在路由表中可达",
    };
  }
  const items = [];
  let totalOpen = 0, totalUnreachable = 0, totalRefused = 0, totalTimeout = 0, totalScanned = 0;
  for (const item of reachable) {
    const { targets, mode, totalHosts } = buildProbeTargets(item.subnet);
    if (targets.length === 0) continue;
    const probes = await probeMany(targets, port, 1000);
    totalScanned += probes.length;
    for (const p of probes) {
      if (p.state === "open") totalOpen++;
      else if (p.state === "unreachable") totalUnreachable++;
      else if (p.state === "refused") totalRefused++;
      else if (p.state === "timeout") totalTimeout++;
    }

    const important = probes.filter((p) => p.state !== "timeout");
    const visibleTimeouts = probes.filter((p) => p.state === "timeout").slice(0, 8);
    items.push({
      subnet: item.subnet,
      reach: item.reach,
      mode,
      totalHosts,
      scanned: probes.length,
      probes: [...important, ...visibleTimeouts].slice(0, 40),
      stats: {
        open: probes.filter((p) => p.state === "open").length,
        refused: probes.filter((p) => p.state === "refused").length,
        unreachable: probes.filter((p) => p.state === "unreachable").length,
        timeout: probes.filter((p) => p.state === "timeout").length,
      },
    });
  }

  let status = "ok";
  let hint = null;
  if (totalOpen > 0) {
    status = "ok";
    hint = `发现 ${totalOpen} 个开放端口，扫描器应能扫到这些设备。如仍扫不到，重试一次或检查 scan 端口设置。`;
  } else if (totalUnreachable > 0 && totalRefused === 0 && totalTimeout === 0) {
    status = "fail";
    hint = "全部返回 host/network unreachable — 路由器告诉本机这个目标无路由可达。同事 PC 那边的路由表里有，你这没有。请用 PowerShell 跑 `route print -4` 与同事对比，或问网络管理员是否要为你机器加静态路由 / 加白名单。";
  } else if (totalRefused > 0 && totalOpen === 0) {
    status = "warn";
    hint = "网络可达但 TCP 端口被 RST — 设备 5555 端口未开，或路径上有防火墙正向干扰（极少见）。检查端口号是否对，或在车机上确认是否处于 `adb tcpip 5555` 模式。";
  } else if (totalTimeout > 0 && totalOpen === 0 && totalUnreachable === 0) {
    status = "warn";
    hint = "未发现任何开放的 ADB TCP 端口。若路由和防火墙项正常，通常是设备没有开启无线 ADB、端口不是当前配置，或设备不在线；可对已知设备 IP 单独执行 `Test-NetConnection -ComputerName 172.16.130.X -Port 5555` 验证。";
  } else {
    status = "warn";
    hint = "TCP 抽样未明确命中 — 换一个明确知道在线的 IP 用 `Test-NetConnection -ComputerName 172.16.130.X -Port 5555` 单独验证。";
  }

  return {
    id: "tcp_sample",
    title: `目标子网 TCP ${port} 探测`,
    status,
    detail: `扫描: ${totalScanned} | 开放: ${totalOpen} | 拒绝: ${totalRefused} | 不可达: ${totalUnreachable} | 超时: ${totalTimeout}`,
    hint,
    data: { items, port },
  };
}

/** 7. mDNS 工具可用性 */
async function checkMdns() {
  try {
    await execAsync("adb mdns check", { timeout: 5000 });
    return { id: "mdns", title: "ADB mDNS 服务", status: "ok", detail: "adb mdns 可用" };
  } catch (err) {
    return {
      id: "mdns",
      title: "ADB mDNS 服务",
      status: "warn",
      detail: `adb mdns 异常或不支持: ${(err.message || "").slice(0, 80)}`,
      hint: "Android 11+ 设备可走 mDNS 发现，老 adb 不支持。这是非致命项。",
    };
  }
}

/** 8. ARP 表中目标子网的条目 */
async function checkArpEntries(targetSubnets) {
  try {
    const { stdout } = await execAsync("arp -a", { timeout: 5000 });
    const ips = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) ips.push(m[1]);
    }
    const counts = targetSubnets.map((subnet) => ({
      subnet,
      count: ips.filter((ip) => isIpInCidr(ip, subnet)).length,
    }));
    const total = counts.reduce((a, c) => a + c.count, 0);
    return {
      id: "arp",
      title: "ARP 缓存中目标子网条目",
      status: total > 0 ? "ok" : "warn",
      detail: counts.map((c) => `${c.subnet}: ${c.count} 条`).join(" | "),
      hint: total === 0
        ? "ARP 缓存里没有目标子网的任何条目，再次确认本机在不在这个网段；或先在终端 ping 一下网关让 ARP 学到设备。"
        : null,
      data: { counts },
    };
  } catch (err) {
    return { id: "arp", title: "ARP 缓存", status: "warn", detail: `arp -a 失败: ${err.message}` };
  }
}

// ============================================================
// 入口
// ============================================================

/**
 * @param {string[]} subnets - 待诊断的目标子网（CIDR），如 ["172.16.130.0/24"]
 * @param {number} port - 期望的 ADB 端口，默认 5555
 */
export async function runDiagnose(subnets = [], port = 5555) {
  const targetSubnets = (subnets || [])
    .map((s) => String(s).trim())
    .filter((s) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));

  const interfaces = listLocalInterfaces();
  const ifaceCheck = {
    id: "interfaces",
    title: "本机网卡 IPv4 接口",
    status: interfaces.length > 0 ? "ok" : "fail",
    detail: interfaces.length > 0
      ? `${interfaces.length} 个接口：${interfaces.map((i) => `${i.adapter}=${i.ip}/${i.prefix}`).join("; ")}`
      : "未检测到任何 IPv4 接口",
    hint: interfaces.length === 0 ? "本机没有可用的 IPv4 网络，检查网卡是否禁用或网线/WiFi。" : null,
    data: { interfaces },
  };

  // 路由表：决定后续 ping/tcp 怎么走
  const routes = await getWindowsRoutingTable();
  const routesSummary = summarizeRoutes(routes);

  // 串行执行（互相有依赖：可达性结果决定要不要做 ping/tcp）
  const adb = await checkAdb();
  const localSocket = await checkLocalFirewall();
  let reach;
  if (targetSubnets.length === 0) {
    reach = {
      id: "subnet_reachability",
      title: "目标子网路由可达性",
      status: "warn",
      detail: "未提供任何待检查子网（请在「扫描配置」里添加，再点「环境检测」）",
      data: { items: [] },
    };
  } else {
    reach = checkSubnetReachability(targetSubnets, interfaces, routes);
  }

  const ping = targetSubnets.length ? await checkPingTargets(reach) : null;
  const tracert = targetSubnets.length ? await checkTracert(targetSubnets, reach) : null;
  const tcp = targetSubnets.length ? await checkTcpSample(reach, port) : null;
  const arp = targetSubnets.length ? await checkArpEntries(targetSubnets) : null;
  const mdns = await checkMdns();
  const firewall = await checkWindowsFirewall();

  const checks = [adb, ifaceCheck, routesSummary, reach, ping, tracert, tcp, localSocket, firewall, arp, mdns].filter(Boolean);

  // 主诊断结论：第一条 fail/warn 给出 hint
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  let primaryHint;
  if (failed.length > 0) {
    primaryHint = failed[0].hint || `${failed[0].title} 失败：${failed[0].detail}`;
  } else if (warned.length > 0) {
    primaryHint = warned[0].hint || `${warned[0].title} 异常：${warned[0].detail}`;
  } else {
    primaryHint = "环境检查全部通过，扫描应可正常工作。";
  }

  // 是 PC 配置问题、网络/设备问题还是 OK？
  // 优先级：adb / 防火墙 default-block / 路由不存在 / 缺少显式路由 / TCP 不可达 / 设备端端口未开
  let category = "ok";
  const tcpCheck = checks.find((c) => c.id === "tcp_sample");
  const tcpHasOpen = /开放:\s*[1-9]\d*/.test(tcpCheck?.detail || "");
  if (failed.length === 0 && warned.length === 0) category = "ok";
  else if (failed.find((c) => c.id === "adb")) category = "pc_config";
  else if (failed.find((c) => c.id === "firewall")) category = "pc_config";
  else if (failed.find((c) => c.id === "local_socket")) category = "pc_config";
  else if (failed.find((c) => c.id === "subnet_reachability")) category = "pc_config";
  else if (failed.find((c) => c.id === "tcp_sample")) {
    const tcpItem = failed.find((c) => c.id === "tcp_sample");
    const d = tcpItem.detail || "";
    // 全 unreachable → 路由 / NAC（PC 端配置/网络管理员）
    // 全 timeout → 出站防火墙 / NAC ACL（PC 端最常见的差异）
    // 全 refused → 设备端 5555 没开
    if (/不可达:\s*[^0]/.test(d) || /超时:\s*[^0]/.test(d)) category = "pc_config";
    else category = "device";
  }
  else if (warned.find((c) => c.id === "subnet_reachability") && !tcpHasOpen) {
    category = "pc_config";
  }
  else if (warned.find((c) => c.id === "tcp_sample")) {
    category = "device";
  }
  else category = "ok";

  return {
    timestamp: new Date().toISOString(),
    targetSubnets,
    port,
    summary: {
      passed: checks.filter((c) => c.status === "ok").length,
      warned: warned.length,
      failed: failed.length,
      primaryHint,
      category, // ok | pc_config | device
    },
    checks,
  };
}
