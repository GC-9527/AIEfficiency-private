/**
 * 车机设备智能发现服务
 *
 * 发现策略（不暴力扫描 5555 端口）：
 * 1. ADB 已连接设备列表（adb devices）
 * 2. mDNS 服务发现（adb mdns services / dns-sd）
 * 3. ARP 缓存 + MAC OUI 指纹识别（识别 Android/车机芯片厂商）
 * 4. 子网广播 ping 刷新 ARP 缓存（被动探测，非端口扫描）
 * 5. 对 OUI 匹配的候选设备尝试 ADB 连接验证
 */

import { execFile, exec } from "child_process";
import net from "net";
import os from "os";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// 已知 Android / 车机相关芯片/设备厂商的 MAC OUI 前缀
// 格式: "XX:XX:XX" (大写)
const ANDROID_OUI_PREFIXES = new Map([
  // 高通 (Qualcomm) - 车机最常用芯片
  ["00:03:7F", "Atheros (Qualcomm)"],
  ["00:0E:8E", "Qualcomm"],
  ["9C:D2:1E", "Qualcomm"],
  ["58:CB:52", "Qualcomm"],

  // 联发科 (MediaTek) - 车机常用
  ["00:0C:E7", "MediaTek"],
  ["00:08:22", "MediaTek"],

  // 瑞芯微 (Rockchip) - 车机常用
  ["2C:4D:79", "Rockchip"],
  ["EA:27:AB", "Rockchip"],

  // 全志 (Allwinner)
  ["10:27:F5", "Allwinner"],

  // 三星 (Samsung) - Exynos 车机芯片
  ["00:07:AB", "Samsung"],
  ["00:12:47", "Samsung"],
  ["00:16:32", "Samsung"],
  ["00:17:D5", "Samsung"],
  ["00:1B:98", "Samsung"],
  ["00:1C:43", "Samsung"],
  ["00:1D:25", "Samsung"],
  ["00:1E:E2", "Samsung"],
  ["00:21:19", "Samsung"],
  ["00:23:39", "Samsung"],
  ["00:24:54", "Samsung"],
  ["00:26:37", "Samsung"],
  ["08:D4:2B", "Samsung"],
  ["10:D5:42", "Samsung"],
  ["14:49:E0", "Samsung"],
  ["18:67:B0", "Samsung"],
  ["1C:62:B8", "Samsung"],
  ["20:D3:90", "Samsung"],
  ["24:4B:03", "Samsung"],
  ["28:98:7B", "Samsung"],
  ["2C:AE:2B", "Samsung"],
  ["30:CD:A7", "Samsung"],
  ["34:23:BA", "Samsung"],
  ["38:01:46", "Samsung"],
  ["3C:5A:37", "Samsung"],
  ["40:4E:36", "Samsung"],
  ["44:6D:6C", "Samsung"],
  ["4C:3C:16", "Samsung"],
  ["50:01:BB", "Samsung"],
  ["50:B7:C3", "Samsung"],
  ["54:92:BE", "Samsung"],
  ["5C:0A:5B", "Samsung"],
  ["5C:3C:27", "Samsung"],
  ["60:AF:6D", "Samsung"],
  ["64:B5:C6", "Samsung"],
  ["6C:F3:73", "Samsung"],
  ["78:BD:BC", "Samsung"],
  ["78:D6:F0", "Samsung"],
  ["7C:0B:C6", "Samsung"],
  ["84:25:19", "Samsung"],
  ["84:38:35", "Samsung"],
  ["88:32:9B", "Samsung"],
  ["8C:77:12", "Samsung"],
  ["90:18:7C", "Samsung"],
  ["94:01:C2", "Samsung"],
  ["94:35:0A", "Samsung"],
  ["98:06:3C", "Samsung"],
  ["A0:07:98", "Samsung"],
  ["A4:08:EA", "Samsung"],
  ["A8:06:00", "Samsung"],
  ["AC:5F:3E", "Samsung"],
  ["B0:47:BF", "Samsung"],
  ["B4:79:A7", "Samsung"],
  ["BC:14:EF", "Samsung"],
  ["BC:44:86", "Samsung"],
  ["BC:72:B1", "Samsung"],
  ["C0:BD:D1", "Samsung"],
  ["C4:73:1E", "Samsung"],
  ["C8:BA:94", "Samsung"],
  ["CC:07:AB", "Samsung"],
  ["D0:22:BE", "Samsung"],
  ["D0:87:E2", "Samsung"],
  ["D8:90:E8", "Samsung"],
  ["E4:7C:F9", "Samsung"],
  ["E8:3A:12", "Samsung"],
  ["EC:1F:72", "Samsung"],
  ["F0:25:B7", "Samsung"],
  ["F4:09:D8", "Samsung"],
  ["F8:04:2E", "Samsung"],

  // 谷歌 (Google)
  ["54:60:09", "Google"],
  ["F4:F5:D8", "Google"],
  ["A4:77:33", "Google"],

  // 华为 / 海思 (HiSilicon) - 部分车机方案
  ["00:E0:FC", "Huawei"],
  ["00:18:82", "Huawei"],
  ["00:1E:10", "Huawei"],
  ["00:25:9E", "Huawei"],
  ["00:46:4B", "Huawei"],
  ["04:F9:38", "Huawei"],
  ["08:19:A6", "Huawei"],
  ["0C:37:DC", "Huawei"],
  ["10:47:80", "Huawei"],
  ["14:B9:68", "Huawei"],
  ["20:F1:7C", "Huawei"],
  ["24:09:95", "Huawei"],
  ["28:6E:D4", "Huawei"],
  ["30:D1:7E", "Huawei"],
  ["34:1E:6B", "Huawei"],
  ["40:4D:8E", "Huawei"],
  ["48:46:FB", "Huawei"],
  ["4C:1F:CC", "Huawei"],
  ["50:A7:2B", "Huawei"],
  ["54:A5:1B", "Huawei"],
  ["58:60:5F", "Huawei"],
  ["5C:09:79", "Huawei"],
  ["60:DE:44", "Huawei"],
  ["64:A2:F9", "Huawei"],
  ["70:72:3C", "Huawei"],
  ["74:88:2A", "Huawei"],
  ["78:F5:57", "Huawei"],
  ["80:71:7A", "Huawei"],
  ["80:B6:86", "Huawei"],
  ["84:A8:E4", "Huawei"],
  ["88:28:B3", "Huawei"],
  ["8C:34:FD", "Huawei"],
  ["90:17:AC", "Huawei"],
  ["94:04:9C", "Huawei"],
  ["B4:15:13", "Huawei"],
  ["C8:D1:5E", "Huawei"],
  ["CC:A2:23", "Huawei"],
  ["D4:6A:A8", "Huawei"],
  ["D8:49:0B", "Huawei"],
  ["E0:24:7F", "Huawei"],
  ["E4:68:A3", "Huawei"],
  ["E8:CD:2D", "Huawei"],
  ["F4:C7:14", "Huawei"],
  ["F8:01:13", "Huawei"],

  // NXP (车机 i.MX 系列)
  ["00:04:9F", "NXP"],
  ["00:1F:7B", "NXP"],
  ["00:60:37", "NXP"],

  // 德州仪器 (TI) - 部分车机方案
  ["00:17:83", "Texas Instruments"],
  ["00:17:E3", "Texas Instruments"],
  ["00:17:E6", "Texas Instruments"],
  ["00:17:E9", "Texas Instruments"],
  ["00:17:EC", "Texas Instruments"],
  ["00:18:2F", "Texas Instruments"],
  ["00:18:30", "Texas Instruments"],
  ["00:18:31", "Texas Instruments"],

  // Espressif (ESP32，部分车机辅助模块)
  ["24:0A:C4", "Espressif"],
  ["24:6F:28", "Espressif"],
  ["30:AE:A4", "Espressif"],
  ["A4:CF:12", "Espressif"],
  ["AC:67:B2", "Espressif"],
  ["BC:DD:C2", "Espressif"],
  ["CC:50:E3", "Espressif"],
]);

/**
 * 获取本机网络信息（跨平台：使用 Node.js os.networkInterfaces）
 */
async function getLocalNetworkInfo() {
  try {
    const nets = os.networkInterfaces();
    const interfaces = [];
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          interfaces.push({
            adapter: name,
            ip: addr.address,
            mask: addr.netmask || "255.255.255.0",
            gateway: null,
          });
        }
      }
    }
    return interfaces.filter(i =>
      !i.ip.startsWith("127.") &&
      !i.ip.startsWith("169.254.")
    );
  } catch {
    return [];
  }
}

/**
 * 计算子网广播地址
 */
function getBroadcastAddress(ip, mask) {
  const ipParts = ip.split(".").map(Number);
  const maskParts = mask.split(".").map(Number);
  return ipParts.map((p, i) => p | (~maskParts[i] & 0xFF)).join(".");
}

/**
 * 计算子网内所有 IP（仅限 /24 及更小子网，避免生成过多地址）
 */
function getSubnetIPs(ip, mask) {
  const ipParts = ip.split(".").map(Number);
  const maskParts = mask.split(".").map(Number);
  const networkParts = ipParts.map((p, i) => p & maskParts[i]);
  const hostBits = maskParts.reduce((acc, m) => {
    let bits = (~m & 0xFF).toString(2).split("1").length - 1;
    return acc + (8 - m.toString(2).split("1").length + 1);
  }, 0);

  // 仅处理 /24 或更小的子网
  const hostCount = Math.pow(2, 32 - maskParts.reduce((acc, m) => {
    let count = 0;
    let val = m;
    while (val) { count += val & 1; val >>= 1; }
    return acc + count;
  }, 0));

  if (hostCount > 254) {
    // 大子网只返回同网段 /24
    const base = networkParts.slice(0, 3);
    const ips = [];
    for (let i = 1; i < 255; i++) {
      const candidate = `${base[0]}.${base[1]}.${base[2]}.${i}`;
      if (candidate !== ip) ips.push(candidate);
    }
    return ips;
  }

  return [];
}

/**
 * 策略1: 获取 ADB 已连接设备
 */
async function getAdbDevices() {
  try {
    const { stdout } = await execAsync("adb devices -l", { timeout: 10000 });
    const devices = [];
    const lines = stdout.split("\n").slice(1); // 跳过 header

    for (const line of lines) {
      const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized)\s*(.*)/);
      if (!match) continue;

      const [, serial, state, props] = match;
      const device = {
        serial,
        state,
        source: "adb_connected",
        ip: null,
        port: null,
        model: null,
        product: null,
      };

      // 解析 IP:PORT 格式
      const ipMatch = serial.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
      if (ipMatch) {
        device.ip = ipMatch[1];
        device.port = parseInt(ipMatch[2]);
      }

      // 解析属性
      const modelMatch = props.match(/model:(\S+)/);
      const productMatch = props.match(/product:(\S+)/);
      if (modelMatch) device.model = modelMatch[1];
      if (productMatch) device.product = productMatch[1];

      devices.push(device);
    }

    return devices;
  } catch (e) {
    return [];
  }
}

/**
 * 策略2: mDNS 服务发现
 * Android 11+ 支持 adb mdns, 设备会广播 _adb-tls-connect._tcp
 */
async function discoverMdns() {
  const devices = [];

  // 方式A: adb mdns services
  try {
    const { stdout } = await execAsync("adb mdns services", { timeout: 8000 });
    const lines = stdout.split("\n");
    for (const line of lines) {
      // 格式: <instance_name>	_adb-tls-connect._tcp.	<ip>:<port>
      const match = line.match(/(\S+)\s+_adb.*?\._(tcp|udp)\.\s+(\d+\.\d+\.\d+\.\d+):(\d+)/);
      if (match) {
        devices.push({
          name: match[1],
          ip: match[3],
          port: parseInt(match[4]),
          source: "mdns_adb",
          protocol: match[2],
        });
      }
    }
  } catch (e) {
    // adb mdns 可能不可用
  }

  // 方式B: Windows DNS-SD (如果可用)
  try {
    const { stdout } = await execAsync(
      'powershell -Command "Resolve-DnsName -Name _adb._tcp.local -Type PTR -ErrorAction SilentlyContinue 2>$null"',
      { timeout: 8000 }
    );
    if (stdout.trim()) {
      // 解析 DNS-SD 结果
      const lines = stdout.split("\n");
      for (const line of lines) {
        const nameMatch = line.match(/NameHost\s*:\s*(\S+)/);
        if (nameMatch) {
          devices.push({
            name: nameMatch[1],
            source: "dns_sd",
            ip: null, // 需要进一步解析
          });
        }
      }
    }
  } catch (e) {
    // DNS-SD 不可用
  }

  return devices;
}

/**
 * 策略3: ARP 缓存分析 + MAC OUI 指纹
 */
async function analyzeArpCache() {
  const candidates = [];

  try {
    const { stdout } = await execAsync("arp -a", { timeout: 5000 });
    const lines = stdout.split("\n");

    for (const line of lines) {
      // Windows ARP 格式: "  192.168.1.100    00-aa-bb-cc-dd-ee     动态/dynamic"
      const match = line.trim().match(
        /(\d+\.\d+\.\d+\.\d+)\s+([\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2})\s+(\S+)/
      );
      if (!match) continue;

      const [, ip, rawMac, type] = match;

      // 跳过广播和多播地址
      if (ip.endsWith(".255") || rawMac.toLowerCase().startsWith("ff-ff-ff")) continue;

      // 统一 MAC 格式为 XX:XX:XX:XX:XX:XX
      const mac = rawMac.replace(/-/g, ":").toUpperCase();
      const oui = mac.substring(0, 8);

      const vendor = ANDROID_OUI_PREFIXES.get(oui);

      candidates.push({
        ip,
        mac,
        oui,
        vendor: vendor || null,
        isCandidate: !!vendor,
        type: type.toLowerCase().includes("动态") || type.toLowerCase().includes("dynamic") ? "dynamic" : "static",
        source: "arp_cache",
      });
    }
  } catch (e) {
    // ARP 不可用
  }

  return candidates;
}

/**
 * 策略4: 广播 ping 刷新 ARP 缓存
 * 发送广播 ping 使网络中的设备回应，填充 ARP 表
 */
async function refreshArpWithBroadcastPing(networkInterfaces) {
  const promises = [];

  for (const iface of networkInterfaces) {
    const broadcast = getBroadcastAddress(iface.ip, iface.mask);

    // Windows ping 广播
    promises.push(
      execAsync(`ping -n 1 -w 1000 ${broadcast}`, { timeout: 3000 }).catch(() => {})
    );

    // 同时 ping 网关（确保基础连通）
    if (iface.gateway) {
      promises.push(
        execAsync(`ping -n 1 -w 500 ${iface.gateway}`, { timeout: 2000 }).catch(() => {})
      );
    }
  }

  // 对同子网的常见 IP 段做轻量 ping（填充 ARP，不是端口扫描）
  for (const iface of networkInterfaces) {
    const base = iface.ip.split(".").slice(0, 3).join(".");
    // 分批 ping，每批 50 个，并发执行
    for (let batch = 0; batch < 5; batch++) {
      const start = batch * 50 + 1;
      const end = Math.min(start + 50, 255);
      // 使用 PowerShell 并发 ping
      const script = `
        ${Array.from({ length: end - start }, (_, i) => start + i)
          .map(i => `ping -n 1 -w 200 ${base}.${i}`)
          .join(" & ")}
      `;
      promises.push(
        execAsync(script, { timeout: 15000, windowsHide: true }).catch(() => {})
      );
    }
  }

  await Promise.allSettled(promises);
}

/**
 * 策略5: 对候选设备尝试 ADB 连接验证
 * 仅对 OUI 匹配的候选 IP 尝试连接，不暴力扫描
 */
async function verifyAdbConnection(ip, port = 5555, timeout = 3000) {
  try {
    const { stdout, stderr } = await execAsync(
      `adb connect ${ip}:${port}`,
      { timeout }
    );
    const output = (stdout + stderr).toLowerCase();

    if (output.includes("connected to") || output.includes("already connected")) {
      // 获取设备详情
      let model = null, product = null, androidVersion = null;
      try {
        const results = await Promise.allSettled([
          execAsync(`adb -s ${ip}:${port} shell getprop ro.product.model`, { timeout: 3000 }),
          execAsync(`adb -s ${ip}:${port} shell getprop ro.product.name`, { timeout: 3000 }),
          execAsync(`adb -s ${ip}:${port} shell getprop ro.build.version.release`, { timeout: 3000 }),
        ]);
        if (results[0].status === "fulfilled") model = results[0].value.stdout.trim();
        if (results[1].status === "fulfilled") product = results[1].value.stdout.trim();
        if (results[2].status === "fulfilled") androidVersion = results[2].value.stdout.trim();
      } catch (e) {}

      return {
        connected: true,
        ip,
        port,
        model,
        product,
        androidVersion,
      };
    }

    return { connected: false, ip, port, reason: output.trim() };
  } catch (e) {
    return { connected: false, ip, port, reason: e.message };
  }
}

/**
 * 获取已连接 ADB 设备的详细信息
 */
async function getDeviceDetails(serial) {
  const props = {};
  const propsToGet = [
    ["ro.product.model", "model"],
    ["ro.product.name", "product"],
    ["ro.product.brand", "brand"],
    ["ro.product.manufacturer", "manufacturer"],
    ["ro.build.version.release", "androidVersion"],
    ["ro.build.version.sdk", "sdkVersion"],
    ["ro.build.display.id", "buildId"],
    ["ro.hardware", "hardware"],
    ["persist.sys.timezone", "timezone"],
    ["ro.build.characteristics", "characteristics"],  // automotive 标识
    ["ro.product.first_api_level", "firstApiLevel"],
    ["net.wifi.interface", "wifiInterface"],
  ];

  try {
    const results = await Promise.allSettled(
      propsToGet.map(([prop]) =>
        execAsync(`adb -s ${serial} shell getprop ${prop}`, { timeout: 3000 })
      )
    );

    results.forEach((result, i) => {
      if (result.status === "fulfilled" && result.value.stdout.trim()) {
        props[propsToGet[i][1]] = result.value.stdout.trim();
      }
    });

    // 判断是否为车机
    props.isAutomotive = (props.characteristics || "").includes("automotive");

    // 获取屏幕信息
    try {
      const { stdout } = await execAsync(
        `adb -s ${serial} shell wm size`,
        { timeout: 3000 }
      );
      const sizeMatch = stdout.match(/(\d+)x(\d+)/);
      if (sizeMatch) {
        props.screenResolution = `${sizeMatch[1]}x${sizeMatch[2]}`;
      }
    } catch (e) {}

    try {
      const { stdout } = await execAsync(
        `adb -s ${serial} shell wm density`,
        { timeout: 3000 }
      );
      const dpiMatch = stdout.match(/(\d+)/);
      if (dpiMatch) {
        props.dpi = parseInt(dpiMatch[1]);
      }
    } catch (e) {}

    // 获取 IP 地址（如果是 USB 连接）
    if (!serial.includes(":")) {
      try {
        const { stdout } = await execAsync(
          `adb -s ${serial} shell ip route show table 0 | grep -oP "src \\K[\\d.]+"`,
          { timeout: 3000 }
        );
        // Windows 下 grep 可能不可用，用替代方式
        const { stdout: stdout2 } = await execAsync(
          `adb -s ${serial} shell "ip addr show wlan0 2>/dev/null || ip addr show eth0 2>/dev/null"`,
          { timeout: 3000 }
        );
        const ipMatch = stdout2.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
        if (ipMatch) {
          props.deviceIp = ipMatch[1];
        }
      } catch (e) {}
    }

  } catch (e) {}

  return props;
}

/**
 * 完整的设备发现流程
 */
export async function discoverDevices(options = {}) {
  const {
    verifyConnections = true,  // 是否对候选 IP 尝试 ADB 连接
    refreshArp = true,         // 是否先刷新 ARP 缓存
    includeAllArp = false,     // 是否返回所有 ARP 条目（非候选也包含）
    customOuis = [],           // 额外的 OUI 前缀 ["XX:XX:XX"]
  } = options;

  const startTime = Date.now();
  const result = {
    timestamp: new Date().toISOString(),
    connectedDevices: [],     // 已连接的 ADB 设备
    mdnsDevices: [],          // mDNS 发现的设备
    arpCandidates: [],        // ARP + OUI 匹配的候选
    verifiedDevices: [],      // ADB 连接验证成功的设备
    networkInfo: [],           // 网络接口信息
    scanDuration: 0,
    methods: [],
  };

  // 注册自定义 OUI
  for (const oui of customOuis) {
    ANDROID_OUI_PREFIXES.set(oui.toUpperCase(), "Custom");
  }

  // 并行执行各发现策略
  const [adbDevices, mdnsDevices, networkInfo] = await Promise.all([
    getAdbDevices(),
    discoverMdns(),
    getLocalNetworkInfo(),
  ]);

  result.connectedDevices = adbDevices;
  result.mdnsDevices = mdnsDevices;
  result.networkInfo = networkInfo;
  result.methods.push("adb_devices", "mdns");

  // 获取已连接设备详情
  for (const device of result.connectedDevices) {
    if (device.state === "device") {
      device.details = await getDeviceDetails(device.serial);
    }
  }

  // 刷新 ARP 缓存
  if (refreshArp && networkInfo.length > 0) {
    result.methods.push("arp_broadcast_ping");
    await refreshArpWithBroadcastPing(networkInfo);
    // 等待 ARP 缓存更新
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 分析 ARP 缓存
  const arpEntries = await analyzeArpCache();
  result.methods.push("arp_oui_fingerprint");

  // 提取已知设备的 IP（避免重复验证）
  const knownIPs = new Set([
    ...adbDevices.filter(d => d.ip).map(d => d.ip),
    ...mdnsDevices.filter(d => d.ip).map(d => d.ip),
  ]);

  // 筛选候选设备：排除已连接、组播/广播地址、本机 IP
  const localIPs = new Set(networkInfo.map(i => i.ip));
  const candidates = arpEntries.filter(entry => {
    if (knownIPs.has(entry.ip)) return false;
    if (localIPs.has(entry.ip)) return false;
    // 排除组播（224.x+）和广播（x.x.x.255）
    const firstOctet = parseInt(entry.ip.split(".")[0]);
    if (firstOctet >= 224) return false;
    if (entry.ip.endsWith(".255")) return false;
    return true;
  });

  result.arpCandidates = includeAllArp ? arpEntries : candidates;

  // 对所有单播候选尝试 ADB 连接（OUI 匹配的优先标记，但不限制验证范围）
  if (verifyConnections && candidates.length > 0) {
    result.methods.push("adb_connect_verify");
    const verifyResults = await Promise.allSettled(
      candidates.map(c => verifyAdbConnection(c.ip))
    );

    result.verifiedDevices = verifyResults
      .filter(r => r.status === "fulfilled" && r.value.connected)
      .map(r => {
        const arpEntry = arpEntries.find(e => e.ip === r.value.ip);
        return { ...r.value, mac: arpEntry?.mac || null, vendor: arpEntry?.vendor || null };
      });
  }

  result.scanDuration = Date.now() - startTime;

  return result;
}

/**
 * 快速检查：仅获取已连接设备和 mDNS
 */
export async function quickScan() {
  const [adbDevices, mdnsDevices] = await Promise.all([
    getAdbDevices(),
    discoverMdns(),
  ]);

  // 获取已连接设备详情
  for (const device of adbDevices) {
    if (device.state === "device") {
      device.details = await getDeviceDetails(device.serial);
    }
  }

  return { connectedDevices: adbDevices, mdnsDevices };
}

// ========== 新策略：自动网段发现 + ping 存活 + ADB 探测 ==========

import { upsertSubnet, listSubnets, upsertDiscoveredDevice, listDiscoveredDevices } from "../db/sqlite.js";

// 虚拟网卡 IP 前缀黑名单（WSL、Docker、Hyper-V 等）
const VIRTUAL_PREFIXES = ["127.", "169.254.", "172.25.", "172.30.", "172.17.", "172.18.", "10.255."];

/**
 * 将 IP 转为 /24 子网
 */
function ipToSubnet24(ip) {
  const parts = ip.split(".");
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function ipToInt(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIp(n) {
  return [n >>> 24 & 0xff, n >>> 16 & 0xff, n >>> 8 & 0xff, n & 0xff].join(".");
}

function prefixToMaskInt(prefix) {
  if (prefix === 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function maskToPrefix(mask) {
  let n = ipToInt(mask);
  let bits = 0;
  while (n & 0x80000000) {
    bits++;
    n = (n << 1) >>> 0;
  }
  return bits;
}

function parseCidr(subnet) {
  const m = String(subnet || "").trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const octets = m[1].split(".").map(Number);
  const prefix = Number(m[2]);
  if (!octets.every(n => n >= 0 && n <= 255) || prefix < 1 || prefix > 32) return null;
  const mask = prefixToMaskInt(prefix);
  const network = (ipToInt(m[1]) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { ip: m[1], prefix, network, broadcast, cidr: `${intToIp(network)}/${prefix}` };
}

function isRouteSubnetCandidate(cidr) {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const first = parsed.network >>> 24;
  const second = (parsed.network >>> 16) & 0xff;
  if (first === 0 || first === 127 || first >= 224) return false;
  if (first === 169 && second === 254) return false;
  if (parsed.prefix === 32) return false;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function splitIntoScanSubnets(cidr, maxSubnets = 512) {
  const parsed = parseCidr(cidr);
  if (!parsed) return [];
  if (parsed.prefix >= 24) return [parsed.cidr];
  const count = 2 ** (24 - parsed.prefix);
  if (count > maxSubnets) return [];
  const subnets = [];
  for (let i = 0; i < count; i++) {
    subnets.push(`${intToIp(parsed.network + i * 256)}/24`);
  }
  return subnets;
}

const SUBNET_SOURCE_META = {
  local_interface: { score: 96, label: "本机网卡", tier: "direct" },
  adb_connected: { score: 94, label: "ADB 设备", tier: "direct" },
  route: { score: 88, label: "路由表", tier: "direct" },
  manual: { score: 82, label: "手动添加", tier: "direct" },
  discovered_device: { score: 78, label: "历史设备", tier: "direct" },
  history: { score: 70, label: "历史记录", tier: "direct" },
  inferred_neighbor: { score: 48, label: "邻近推理", tier: "inferred" },
  inferred_private: { score: 36, label: "常见网段", tier: "inferred" },
  search_exact: { score: 62, label: "搜索输入", tier: "inferred" },
  android_probe: { score: 92, label: "安卓探测", tier: "direct" },
  balanced_private: { score: 24, label: "智能遍历", tier: "inferred" },
  exhaustive_private: { score: 18, label: "全量遍历", tier: "inferred" },
};

function addSubnetCandidate(map, subnet, source, meta = {}) {
  const parsed = parseCidr(subnet);
  if (!parsed) return;
  const value = parsed.cidr;
  const sourceMeta = SUBNET_SOURCE_META[source] || {};
  const confidence = meta.confidence ?? sourceMeta.score ?? 30;
  if (!map.has(value)) {
    const { confidence: _confidence, reason, reasons, ...restMeta } = meta;
    map.set(value, {
      subnet: value,
      sources: [],
      reasons: [],
      confidence,
      tier: sourceMeta.tier || "direct",
      ...restMeta,
    });
  }
  const item = map.get(value);
  if (!item.sources.includes(source)) item.sources.push(source);
  item.confidence = Math.max(item.confidence || 0, confidence);
  if ((sourceMeta.tier || "direct") === "direct") item.tier = "direct";
  else if (!item.tier) item.tier = "inferred";
  const reasonList = [
    ...[].concat(meta.reasons || []),
    ...(meta.reason ? [meta.reason] : []),
  ].filter(Boolean);
  for (const reason of reasonList) {
    if (!item.reasons.includes(reason)) item.reasons.push(reason);
  }
  for (const [key, val] of Object.entries(meta)) {
    if (key === "confidence" || key === "reason" || key === "reasons") continue;
    if (val !== undefined && val !== null && item[key] === undefined) item[key] = val;
  }
}

function addNeighborSubnetCandidates(candidates, seedSubnet, sourceLabel, radius = 8) {
  const parsed = parseCidr(seedSubnet);
  if (!parsed || parsed.prefix > 24) return;
  const parts = intToIp(parsed.network).split(".").map(Number);
  const baseA = parts[0];
  const baseB = parts[1];
  const baseC = parts[2];
  const start = Math.max(0, baseC - radius);
  const end = Math.min(255, baseC + radius);
  for (let c = start; c <= end; c++) {
    if (c === baseC) continue;
    const distance = Math.abs(c - baseC);
    const confidence = Math.max(28, 56 - distance * 2);
    addSubnetCandidate(candidates, `${baseA}.${baseB}.${c}.0/24`, "inferred_neighbor", {
      confidence,
      inferredFrom: seedSubnet,
      reason: `由 ${sourceLabel} ${seedSubnet} 向前后循环枚举 ±${radius} 个 /24，距离 ${distance}`,
    });
  }
}

function addCommonPrivateSubnetCandidates(candidates) {
  const commonSubnets = [
    "192.168.0.0/24", "192.168.1.0/24", "192.168.10.0/24", "192.168.31.0/24",
    "192.168.43.0/24", "192.168.50.0/24", "192.168.100.0/24",
    "172.16.0.0/24", "172.16.1.0/24", "172.16.10.0/24", "172.16.128.0/24",
    "172.16.129.0/24", "172.16.130.0/24", "172.16.131.0/24", "172.16.132.0/24",
    "10.0.0.0/24", "10.0.1.0/24", "10.10.0.0/24", "10.20.0.0/24",
  ];
  for (const subnet of commonSubnets) {
    addSubnetCandidate(candidates, subnet, "inferred_private", {
      confidence: 34,
      reason: "常见车机、热点、实验室或企业内网网段",
    });
  }
}

function addBalancedPrivateSubnetCandidates(candidates) {
  for (let b = 16; b <= 31; b++) {
    for (let c = 0; c <= 255; c++) {
      addSubnetCandidate(candidates, `172.${b}.${c}.0/24`, "balanced_private", {
        confidence: 24,
        reason: "智能规则：完整覆盖常见企业/车机网段 172.16.0.0/12",
      });
    }
  }
  for (let c = 0; c <= 255; c++) {
    addSubnetCandidate(candidates, `192.168.${c}.0/24`, "balanced_private", {
      confidence: 24,
      reason: "智能规则：完整覆盖常见局域网 192.168.0.0/16",
    });
  }
  const common10SecondOctets = [0, 1, 2, 10, 16, 20, 28, 50, 60, 88, 100, 128, 168, 200];
  for (const b of common10SecondOctets) {
    for (let c = 0; c <= 255; c++) {
      addSubnetCandidate(candidates, `10.${b}.${c}.0/24`, "balanced_private", {
        confidence: 22,
        reason: `智能规则：抽样覆盖常见 10.${b}.0.0/16 私有网段`,
      });
    }
  }
}

function addExhaustivePrivateSubnetCandidates(candidates) {
  for (let b = 0; b <= 255; b++) {
    for (let c = 0; c <= 255; c++) {
      addSubnetCandidate(candidates, `10.${b}.${c}.0/24`, "exhaustive_private", {
        confidence: 18,
      });
    }
  }
  for (let b = 16; b <= 31; b++) {
    for (let c = 0; c <= 255; c++) {
      addSubnetCandidate(candidates, `172.${b}.${c}.0/24`, "exhaustive_private", {
        confidence: 18,
      });
    }
  }
  for (let c = 0; c <= 255; c++) {
    addSubnetCandidate(candidates, `192.168.${c}.0/24`, "exhaustive_private", {
      confidence: 18,
    });
  }
}

function subnetFromSearchQuery(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = m[4] === undefined ? 0 : Number(m[4]);
  const prefix = m[5] === undefined ? 24 : Number(m[5]);
  if ([a, b, c, d].some(n => n < 0 || n > 255)) return null;
  if (prefix !== 24) return null;
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return null;
  return `${a}.${b}.${c}.0/24`;
}

function probeTargetsForSubnet(subnet) {
  const parsed = parseCidr(subnet);
  if (!parsed || parsed.broadcast - parsed.network < 2) return [];
  return [...new Set([intToIp(parsed.network + 1), intToIp(parsed.broadcast - 1)])];
}

function pingOutputLooksAlive(stdout = "") {
  return /TTL=|bytes from|来自/i.test(stdout);
}

async function pingHost(ip, timeoutMs = 650) {
  const isWin = process.platform === "win32";
  const args = isWin ? ["-n", "1", "-w", String(timeoutMs), ip] : ["-c", "1", "-W", "1", ip];
  try {
    const { stdout } = await execFileAsync("ping", args, {
      timeout: timeoutMs + 1200,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return pingOutputLooksAlive(stdout);
  } catch (err) {
    return pingOutputLooksAlive(err.stdout || "");
  }
}

async function probeSubnetByPing(item) {
  const targets = probeTargetsForSubnet(item.subnet);
  if (targets.length === 0) return { status: "untested", targets: [] };
  const results = await Promise.all(targets.map(async ip => ({ ip, alive: await pingHost(ip) })));
  const alive = results.filter(r => r.alive).map(r => r.ip);
  return { status: alive.length > 0 ? "reachable" : "no_reply", targets: results };
}

async function annotatePingProbes(items, { probeLimit = 300, concurrency = 48 } = {}) {
  const probeItems = items
    .filter(item =>
      item.tier === "direct" ||
      item.sources.includes("route") ||
      item.sources.includes("inferred_neighbor") ||
      item.sources.includes("inferred_private")
    )
    .slice(0, probeLimit);
  let index = 0;
  async function worker() {
    while (index < probeItems.length) {
      const item = probeItems[index++];
      item.probe = await probeSubnetByPing(item);
      if (item.probe.status === "reachable") {
        item.confidence = Math.max(item.confidence || 0, 72);
        item.tier = "direct";
        const alive = item.probe.targets.filter(t => t.alive).map(t => t.ip).join(", ");
        const reason = `ping 抽样可达：${alive}`;
        if (!item.reasons.includes(reason)) item.reasons.push(reason);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, probeItems.length) }, () => worker()));
}

async function probeSubnetAndroidAdb(item, port = 5555) {
  const openHosts = await tcpSweep5555(item.subnet, port, 650);
  return {
    status: openHosts.length > 0 ? "adb_port_open" : "none",
    port,
    openHosts,
  };
}

async function annotateAndroidProbes(items, { probeLimit = 120, concurrency = 4, port = 5555 } = {}) {
  for (const item of items) {
    if (item.sources.includes("adb_connected")) {
      item.androidProbe = {
        status: "adb_connected",
        port,
        openHosts: item.ip ? [item.ip] : [],
      };
      item.confidence = Math.max(item.confidence || 0, 96);
      item.tier = "direct";
      const reason = "已有 ADB 连接记录，判定为安卓设备网段";
      if (!item.reasons.includes(reason)) item.reasons.push(reason);
    }
  }

  const probeItems = items
    .filter(item =>
      !item.androidProbe &&
      (
        item.probe?.status === "reachable" ||
        item.sources.includes("route") ||
        item.sources.includes("manual") ||
        item.sources.includes("history") ||
        item.sources.includes("local_interface") ||
        item.sources.includes("search_exact")
      )
    )
    .slice(0, probeLimit);

  let index = 0;
  async function worker() {
    while (index < probeItems.length) {
      const item = probeItems[index++];
      item.androidProbe = await probeSubnetAndroidAdb(item, port);
      if (item.androidProbe.status === "adb_port_open") {
        if (!item.sources.includes("android_probe")) item.sources.push("android_probe");
        item.confidence = Math.max(item.confidence || 0, 92);
        item.tier = "direct";
        const reason = `发现 ADB 端口 ${port} 开放主机：${item.androidProbe.openHosts.join(", ")}`;
        if (!item.reasons.includes(reason)) item.reasons.push(reason);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, probeItems.length) }, () => worker()));
}

async function getRouteSubnetCandidates() {
  if (process.platform !== "win32") return [];
  try {
    const psCmd = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.DestinationPrefix -ne $null -and $_.DestinationPrefix -ne "0.0.0.0/0" } | ForEach-Object { $alias = $null; try { $alias = (Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).InterfaceAlias } catch {}; [PSCustomObject]@{ DestinationPrefix = $_.DestinationPrefix; NextHop = $_.NextHop; InterfaceAlias = $alias; InterfaceIndex = $_.InterfaceIndex; RouteMetric = $_.RouteMetric; InterfaceMetric = $_.InterfaceMetric } } | ConvertTo-Json -Compress -Depth 3`;
    const { stdout } = await execFileAsync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const text = stdout.trim();
    if (!text) return [];
    let parsed;
    try { parsed = JSON.parse(text); } catch { return []; }
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(route => ({
        subnet: String(route.DestinationPrefix || ""),
        gateway: String(route.NextHop || ""),
        adapter: route.InterfaceAlias || `if#${route.InterfaceIndex}`,
        metric: (route.RouteMetric || 0) + (route.InterfaceMetric || 0),
      }))
      .filter(route => isRouteSubnetCandidate(route.subnet));
  } catch {
    return [];
  }
}

/**
 * 展开 CIDR 为 IP 列表。小网段完整展开；过大网段限制为输入 IP 所在 /24，防止误填 /16 拖垮扫描。
 */
function expandSubnetTargets(subnet, maxHosts = 254) {
  const m = String(subnet).trim().match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!m) return [];

  const inputIp = m[1];
  const prefix = parseInt(m[2], 10);
  if (prefix < 1 || prefix > 32) return [];

  if (prefix === 32) return [inputIp];
  if (prefix === 31) {
    const base = ipToInt(inputIp) & prefixToMaskInt(prefix);
    return [intToIp(base), intToIp(base + 1)];
  }

  const mask = prefixToMaskInt(prefix);
  const network = (ipToInt(inputIp) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hostCount = broadcast - network - 1;

  if (hostCount > maxHosts) {
    const parts = inputIp.split(".");
    const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
    const ips = [];
    for (let i = 1; i < 255; i++) ips.push(`${base}.${i}`);
    return ips;
  }

  const ips = [];
  for (let n = network + 1; n < broadcast; n++) ips.push(intToIp(n));
  return ips;
}

/**
 * 自动检测要扫描的子网
 * 来源：本机网卡 + 已连接 ADB 设备 + 历史记录
 */
export async function autoDetectSubnets() {
  const subnets = new Set();

  // 1. 本机网卡（过滤虚拟网卡）
  const interfaces = await getLocalNetworkInfo();
  for (const iface of interfaces) {
    const isVirtual = VIRTUAL_PREFIXES.some(p => iface.ip.startsWith(p));
    if (!isVirtual) {
      const subnet = ipToSubnet24(iface.ip);
      subnets.add(subnet);
      upsertSubnet(subnet, "local_interface");
    }
  }

  // 2. 已连接 ADB 设备的网段
  const adbDevices = await getAdbDevices();
  for (const device of adbDevices) {
    if (device.ip) {
      const subnet = ipToSubnet24(device.ip);
      subnets.add(subnet);
      upsertSubnet(subnet, "adb_connected");
    }
  }

  // 3. 历史记录
  const saved = listSubnets();
  for (const row of saved) {
    subnets.add(row.subnet);
  }

  return { subnets: [...subnets], adbDevices };
}

export async function listSubnetCandidates({ mode = "direct", radius = 8, maxCandidates = 600, query = "", androidPort = 5555 } = {}) {
  const candidates = new Map();
  const inferenceSeeds = [];

  const interfaces = await getLocalNetworkInfo();
  for (const iface of interfaces) {
    const isVirtual = VIRTUAL_PREFIXES.some(p => iface.ip.startsWith(p));
    if (isVirtual) continue;

    const prefix = iface.mask ? maskToPrefix(iface.mask) : 24;
    const ifaceSubnets = splitIntoScanSubnets(`${iface.ip}/${prefix}`);
    for (const subnet of ifaceSubnets.length > 0 ? ifaceSubnets : [ipToSubnet24(iface.ip)]) {
      inferenceSeeds.push({ subnet, label: "本机网卡" });
      addSubnetCandidate(candidates, subnet, "local_interface", {
        adapter: iface.adapter,
        ip: iface.ip,
        reason: `本机网卡 ${iface.adapter} 当前 IPv4 为 ${iface.ip}`,
      });
    }
  }

  const adbDevices = await getAdbDevices();
  for (const device of adbDevices) {
    if (device.ip) {
      const subnet = ipToSubnet24(device.ip);
      inferenceSeeds.push({ subnet, label: "ADB 设备" });
      addSubnetCandidate(candidates, subnet, "adb_connected", {
        device: device.serial,
        reason: `已连接 ADB 设备 ${device.serial} 位于 ${device.ip}`,
      });
    }
  }

  const routes = await getRouteSubnetCandidates();
  for (const route of routes) {
    const routeSplitLimit = mode === "smart" || mode === "android" ? 4096 : 512;
    for (const subnet of splitIntoScanSubnets(route.subnet, routeSplitLimit)) {
      inferenceSeeds.push({ subnet, label: "路由表" });
      addSubnetCandidate(candidates, subnet, "route", {
        route: route.subnet,
        gateway: route.gateway,
        adapter: route.adapter,
        metric: route.metric,
        reason: `Windows 路由表存在 ${route.subnet}，接口 ${route.adapter}`,
      });
    }
  }

  const saved = listSubnets();
  for (const row of saved) {
    inferenceSeeds.push({ subnet: row.subnet, label: "历史网段" });
    addSubnetCandidate(candidates, row.subnet, row.source || "history", {
      lastFoundAt: row.last_found_at,
      reason: `历史扫描配置记录，最近发现时间 ${row.last_found_at || "未知"}`,
    });
  }

  if (mode === "advanced") {
    const seenSeeds = new Set();
    for (const seed of inferenceSeeds) {
      if (seenSeeds.has(seed.subnet)) continue;
      seenSeeds.add(seed.subnet);
      addNeighborSubnetCandidates(candidates, seed.subnet, seed.label, radius);
    }
    addCommonPrivateSubnetCandidates(candidates);
  }

  if (mode === "smart" || mode === "android") {
    const seenSeeds = new Set();
    for (const seed of inferenceSeeds) {
      if (seenSeeds.has(seed.subnet)) continue;
      seenSeeds.add(seed.subnet);
      addNeighborSubnetCandidates(candidates, seed.subnet, seed.label, Math.max(radius, 16));
    }
    addCommonPrivateSubnetCandidates(candidates);
    addBalancedPrivateSubnetCandidates(candidates);
  }

  if (mode === "exhaustive") {
    addExhaustivePrivateSubnetCandidates(candidates);
  }

  const querySubnet = subnetFromSearchQuery(query);
  if (querySubnet) {
    addSubnetCandidate(candidates, querySubnet, "search_exact", {
      confidence: 62,
      reason: `由搜索输入 ${query} 生成的 /24 私有网段候选`,
    });
  }

  const sourceRank = {
    local_interface: 0,
    adb_connected: 1,
    android_probe: 2,
    route: 3,
    manual: 4,
    discovered_device: 5,
    history: 6,
    inferred_neighbor: 7,
    inferred_private: 8,
    search_exact: 9,
    balanced_private: 10,
    exhaustive_private: 11,
  };

  const effectiveMax = mode === "exhaustive" ? Math.max(maxCandidates || 0, 70000) : maxCandidates;
  const sortCandidates = (items) => items.sort((a, b) => {
    const ar = Math.min(...a.sources.map(s => sourceRank[s] ?? 9));
    const br = Math.min(...b.sources.map(s => sourceRank[s] ?? 9));
    if (ar !== br) return ar - br;
    if ((b.confidence || 0) !== (a.confidence || 0)) return (b.confidence || 0) - (a.confidence || 0);
    return ipToInt(a.subnet.split("/")[0]) - ipToInt(b.subnet.split("/")[0]);
  });

  let sorted = sortCandidates([...candidates.values()]);
  if (mode === "smart" || mode === "android") {
    await annotatePingProbes(sorted, { probeLimit: 300, concurrency: 48 });
    sorted = sortCandidates(sorted);
  }
  if (mode === "android") {
    await annotateAndroidProbes(sorted, { probeLimit: 120, concurrency: 4, port: androidPort });
    sorted = sortCandidates(sorted).filter(item =>
      item.sources.includes("adb_connected") ||
      item.androidProbe?.status === "adb_connected" ||
      item.androidProbe?.status === "adb_port_open"
    );
  }
  return sorted.slice(0, effectiveMax);
}

/**
 * TCP 端口探测（纯 JS，高并发）
 * 检测 IP:port 是否可连接，超时快速失败
 */
function tcpProbe(ip, port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (open) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
    socket.connect(port, ip);
  });
}

/**
 * 批量 TCP 端口扫描（CIDR 子网）
 * 纯 JS 并发，254 个 IP 同时探测，约 1~2 秒完成
 */
async function tcpSweep5555(subnet, port = 5555, timeout = 1500) {
  const ips = expandSubnetTargets(subnet);
  const results = await Promise.allSettled(
    ips.map(async (ip) => {
      const open = await tcpProbe(ip, port, timeout);
      return open ? ip : null;
    })
  );
  return results
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);
}

/**
 * 对 5555 端口开放的主机执行 ADB connect + 获取设备信息
 */
async function probeAdbOnOpenHosts(openIPs, connectedIPs, port = 5555, concurrency = 30, timeout = 3000) {
  const toProbe = openIPs.filter(ip => !connectedIPs.has(ip));
  const results = [];

  for (let i = 0; i < toProbe.length; i += concurrency) {
    const batch = toProbe.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(ip => verifyAdbConnection(ip, port, timeout))
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value.connected) {
        results.push(r.value);
      }
    }
  }

  return results;
}

/**
 * 完整的自动车机发现（手动触发）
 * 结果持久化到 DB，切换页面不丢失
 * @param {object} options - { customSubnets?: string[], customPort?: number }
 */
export async function discoverAutomotive(progressCallback, options = {}) {
  const startTime = Date.now();
  const scanPort = options.customPort || 5555;

  // 1. 记录扫描前已连接的设备（扫描后只断开新连接的）
  const preConnectedAdb = await getAdbDevices();
  const preConnectedIPs = new Set(preConnectedAdb.filter(d => d.ip).map(d => d.ip));

  // 2. 收集要扫描的子网
  let subnets;
  if (options.customSubnets && options.customSubnets.length > 0) {
    // 用户指定的网段
    subnets = options.customSubnets;
    for (const s of subnets) upsertSubnet(s, "manual");
  } else {
    const detected = await autoDetectSubnets();
    subnets = detected.subnets;
  }

  // 收集已连接设备信息
  const connectedDevices = [];
  for (const device of preConnectedAdb) {
    if (device.state === "device") {
      device.details = await getDeviceDetails(device.serial);
      const dev = {
        ip: device.ip,
        port: device.port || 5555,
        serial: device.serial,
        status: "connected",
        model: device.details?.model || device.model,
        product: device.details?.product || device.product,
        androidVersion: device.details?.androidVersion,
        isAutomotive: device.details?.isAutomotive || false,
        screenResolution: device.details?.screenResolution,
        dpi: device.details?.dpi,
        source: "adb_connected",
      };
      connectedDevices.push(dev);
      upsertDiscoveredDevice(dev);
    }
  }

  progressCallback?.({ phase: "tcp_scan", subnets, message: `正在扫描 ${subnets.length} 个子网的 ${scanPort} 端口...` });

  // 3. 并发 TCP 端口扫描
  const allOpen = [];
  const scanResults = await Promise.allSettled(
    subnets.map(subnet => tcpSweep5555(subnet, scanPort))
  );
  for (const r of scanResults) {
    if (r.status === "fulfilled") allOpen.push(...r.value);
  }

  // 去除本机 IP
  const localIPs = new Set((await getLocalNetworkInfo()).map(i => i.ip));
  const openFiltered = allOpen.filter(ip => !localIPs.has(ip));

  progressCallback?.({
    phase: "adb_probe",
    aliveCount: openFiltered.length,
    message: `发现 ${openFiltered.length} 台 ${scanPort} 端口开放主机，正在获取设备信息...`,
  });

  // 4. 对端口开放的主机执行 ADB connect（包括已连接的，以获取最新状态）
  const toProbe = openFiltered.filter(ip => !preConnectedIPs.has(ip));
  const probed = await probeAdbOnOpenHosts(toProbe, new Set(), scanPort);

  // 5. 并发获取发现设备的 automotive 特征
  const detailResults = await Promise.allSettled(
    probed.map(async (device) => {
      const serial = `${device.ip}:${device.port || scanPort}`;
      const props = {};
      try {
        const results = await Promise.allSettled([
          execAsync(`adb -s ${serial} shell getprop ro.build.characteristics`, { timeout: 2000 }),
          execAsync(`adb -s ${serial} shell getprop ro.product.model`, { timeout: 2000 }),
          execAsync(`adb -s ${serial} shell getprop ro.build.version.release`, { timeout: 2000 }),
        ]);
        if (results[0].status === "fulfilled") props.characteristics = results[0].value.stdout.trim();
        if (results[1].status === "fulfilled") props.model = results[1].value.stdout.trim();
        if (results[2].status === "fulfilled") props.androidVersion = results[2].value.stdout.trim();
      } catch {}
      return { device, props };
    })
  );

  const discoveredDevices = [];
  for (const r of detailResults) {
    if (r.status !== "fulfilled") continue;
    const { device, props } = r.value;

    upsertSubnet(ipToSubnet24(device.ip), "discovered_device");

    const dev = {
      ip: device.ip,
      port: device.port || scanPort,
      status: "discovered",
      model: props.model || device.model,
      product: device.product,
      androidVersion: props.androidVersion || device.androidVersion,
      isAutomotive: (props.characteristics || "").includes("automotive"),
      source: "auto_subnet_scan",
    };
    discoveredDevices.push(dev);
    upsertDiscoveredDevice(dev);
  }

  // 6. 断开扫描过程中所有新增的 ADB 连接（包括 unauthorized/offline 的）
  //    对比扫描前后的 adb devices 列表，断开所有新增的
  const postAdb = await getAdbDevices();
  const preSerials = new Set(preConnectedAdb.map(d => d.serial));
  const newSerials = postAdb.filter(d => !preSerials.has(d.serial)).map(d => d.serial);
  if (newSerials.length > 0) {
    await Promise.allSettled(
      newSerials.map(serial => execAsync(`adb disconnect ${serial}`, { timeout: 2000 }).catch(() => {}))
    );
  }

  const allDevices = [...connectedDevices, ...discoveredDevices];

  return {
    subnets,
    aliveCount: openFiltered.length,
    devices: allDevices,
    scanDuration: Date.now() - startTime,
  };
}

/**
 * 获取缓存的设备列表（从 DB 读取，不触发扫描）
 * 同时合并当前 adb devices 的实时连接状态
 */
export async function getCachedDevices() {
  const cached = listDiscoveredDevices();
  const adbDevices = await getAdbDevices();
  const connectedIPs = new Set(adbDevices.filter(d => d.ip && d.state === "device").map(d => d.ip));

  return cached.map(d => ({
    ip: d.ip,
    port: d.port,
    model: d.model,
    product: d.product,
    androidVersion: d.android_version,
    isAutomotive: d.is_automotive === 1,
    screenResolution: d.screen_resolution,
    dpi: d.dpi,
    status: connectedIPs.has(d.ip) ? "connected" : "discovered",
    source: d.source,
    discoveredAt: d.discovered_at,
  }));
}

export { getAdbDevices, discoverMdns, analyzeArpCache, getLocalNetworkInfo, verifyAdbConnection, getDeviceDetails };
