import React, { Suspense, lazy, useState, useEffect } from "react";
import { Outlet, NavLink, useLocation, useNavigate } from "react-router-dom";
import FeedbackButton from "./components/FeedbackButton.jsx";
import DevMode from "./components/DevMode.jsx";
import DevRecordingOverlay, { DevRecordingButton } from "./components/DevRecordingOverlay.jsx";
import FloatingDock from "./components/FloatingDock.jsx";
import {
  getApiUrl,
  getGatewayUrl,
  setGatewayUrl,
} from "./services/gateway.js";
import { authenticatedFetch } from "./services/adminAuth.js";
import { copyToClipboard } from "./utils/clipboard.js";

const Chat = lazy(() => import("./pages/Chat.jsx"));
const DevBench = lazy(() => import("./pages/devbench/index.jsx"));

// 语义化版本比较：remote 是否「严格新于」local。云端落后(更旧)时不提示更新，避免误报/降级。
function isNewerVersion(remote, local) {
  if (!remote || !local) return false;
  if (remote === local) return false;
  const pa = String(remote).split(".").map((n) => parseInt(n, 10));
  const pb = String(local).split(".").map((n) => parseInt(n, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return remote !== local;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const a = pa[i] || 0, b = pb[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

const nav = [
  { path: "/chat", label: "聊天", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
  )},
  { path: "/skills", label: "Skills", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
  )},
  { path: "/agents", label: "Agents", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
  )},
  { path: "/tokens", label: "用量", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>
  )},
  { path: "/logs", label: "日志", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" /></svg>
  )},
  { path: "/devices", label: "设备", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" /></svg>
  )},
  { path: "/aiautowork", label: "AI工作台", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
  )},
  { path: "/devbench", label: "工程开发", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
  )},
  { path: "/tb-tasks", label: "TB任务", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
  )},
  { path: "/feishu-project-sync", label: "飞书同步", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7.5 8.25h9m-9 3.5h9m-9 3.5h5.25M5.25 4.5h13.5A2.25 2.25 0 0121 6.75v10.5a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 17.25V6.75A2.25 2.25 0 015.25 4.5z" /></svg>
  )},
  { path: "/bug-agent", label: "Bug分析", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z M8 10l-1-2M16 10l1-2M8 16l-2 1M16 16l2 1" /></svg>
  )},
  { path: "/schedule", label: "定时", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
  )},
  { path: "/cardev", label: "车机调试", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 17h14M5 17a2 2 0 01-2-2v-3a2 2 0 012-2h14a2 2 0 012 2v3a2 2 0 01-2 2M5 17v2a1 1 0 001 1h2a1 1 0 001-1v-2m6 0v2a1 1 0 001 1h2a1 1 0 001-1v-2M7 10V7a4 4 0 014-4h2a4 4 0 014 4v3M7 13h.01M17 13h.01" /></svg>
  )},
  { path: "/web-nav-dev", label: "网址导航", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.5 6.75h15M4.5 12h15M4.5 17.25h15M8.25 4.5v15M15.75 4.5v15" /></svg>
  )},
  { path: "/project-dev", label: "项目开发", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 3v11.25A2.25 2.25 0 006 16.5h12M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605" /></svg>
  )},
  { path: "/help", label: "帮助中心", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
  )},
  { path: "/performance", label: "性能", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
  )},
  { path: "/admin", label: "管理后台", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" /></svg>
  )},
  { path: "/settings", label: "设置", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93s.844.083 1.16-.178l.668-.567a1.125 1.125 0 011.606.106l.773.774c.458.459.516 1.17.106 1.606l-.567.668c-.261.316-.295.764-.178 1.16s.506.71.93.78l.894.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.93.78s-.083.844.178 1.16l.567.668c.41.436.352 1.147-.106 1.606l-.774.773a1.125 1.125 0 01-1.606.106l-.668-.567c-.316-.261-.764-.295-1.16-.178s-.71.506-.78.93l-.15.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93s-.844-.083-1.16.178l-.668.567a1.125 1.125 0 01-1.606-.106l-.773-.774a1.125 1.125 0 01-.106-1.606l.567-.668c.261-.316.295-.764.178-1.16s-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.764-.383.93-.78s.083-.844-.178-1.16l-.567-.668a1.125 1.125 0 01.106-1.606l.774-.773a1.125 1.125 0 011.606-.106l.668.567c.316.261.764.295 1.16.178s.71-.506.78-.93l.15-.894z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
  )},
];

// 本机开发类页面，仅在 isNode(node/standalone) 角色挂载对应 API；纯服务端角色隐藏，避免点进去 404
const NODE_ONLY_PATHS = new Set(["/chat", "/skills", "/agents", "/logs", "/devices", "/tb-tasks", "/feishu-project-sync", "/bug-agent", "/schedule", "/cardev", "/devbench", "/web-nav-dev", "/project-dev", "/performance", "/aiautowork"]);

// 侧栏可见入口白名单（包含管理后台入口）。路由不被裁剪——手动输入 URL 仍可访问完整功能。
const SIDEBAR_VISIBLE_PATHS = new Set([
  "/devbench",   // 工程开发
  "/cardev",     // 车机调试
  "/devices",    // 设备
  "/admin",      // 管理后台（仅服务端/单机角色显示）
  "/settings",   // 设置
]);

const SIDEBAR_KEY = "sidebar_expanded";
const UPDATE_DISMISS_KEY = "update_dismiss_ver";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [isServerGw, setIsServerGw] = useState(true); // 所连网关是否服务端(server/standalone)；node 客户端隐藏「管理后台」入口
  const [isNodeGw, setIsNodeGw] = useState(true); // 所连网关是否含本机节点(node/standalone)；纯服务端隐藏本机开发类页面
  const [selfInfo, setSelfInfo] = useState(null); // 本机节点信息(role/host/isServer/claudeEnabled)，用于角色标记 + 局域网访问地址
  const [ipList, setIpList] = useState({ ips: [], advertiseIp: "" }); // 本机所有 IPv4 + 选定对外地址（多网卡）
  const [showSetup, setShowSetup] = useState(false);
  const [setupUrl, setSetupUrl] = useState("");
  const [setupStatus, setSetupStatus] = useState(null);
  const [sidebarExpanded, setSidebarExpanded] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== "false");
  const [cmdCopied, setCmdCopied] = useState(false);
  // 版本更新状态
  const [updateInfo, setUpdateInfo] = useState(null); // { local, remote }
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState("");
  // 网关断连状态
  const [gatewayDown, setGatewayDown] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [localVersion, setLocalVersion] = useState("");
  const [versionChecking, setVersionChecking] = useState(false);
  const [updateCheckMsg, setUpdateCheckMsg] = useState("");
  const [desktopUpdateInfo, setDesktopUpdateInfo] = useState(null); // { local, remote }
  const [desktopUpdating, setDesktopUpdating] = useState(false);
  const [desktopVersion, setDesktopVersion] = useState(""); // 桌面版自身版本(app.getVersion)，仅 desktop 模式
  const location = useLocation();
  const navigate = useNavigate();
  const isChatPage = location.pathname === "/chat";
  const [chatVisited, setChatVisited] = useState(isChatPage);
  const isDevbenchPage = location.pathname === "/devbench";
  const [devbenchVisited, setDevbenchVisited] = useState(isDevbenchPage);

  useEffect(() => {
    if (isChatPage) setChatVisited(true);
  }, [isChatPage]);
  useEffect(() => {
    // 进入 devbench 后才挂载 chunk，避免首屏打开 /chat / settings 时被 1.15MB chunk 拖累；
    // 切到别的 tab 不卸载——保留 tabs/liveMap/会话/工程选择等状态。
    if (isDevbenchPage) setDevbenchVisited(true);
  }, [isDevbenchPage]);
  useEffect(() => {
    // DevBench dialogs use React portals under document.body. Keep their theme
    // scope in sync with the active route without moving or remounting them.
    document.body.classList.toggle("devbench-portal-theme", isDevbenchPage);
    return () => document.body.classList.remove("devbench-portal-theme");
  }, [isDevbenchPage]);
  const toggleSidebar = () => {
    const next = !sidebarExpanded;
    setSidebarExpanded(next);
    localStorage.setItem(SIDEBAR_KEY, String(next));
  };

  // 纯服务端角色：本机开发类页面未挂载，若停留其上则重定向到「帮助中心」避免 404
  useEffect(() => {
    if (!isNodeGw && NODE_ONLY_PATHS.has(location.pathname)) navigate("/help", { replace: true });
  }, [isNodeGw, location.pathname, navigate]);

  // desktop 模式：拉取桌面版自身版本号(app.getVersion)，在侧栏底部显示"桌面 vX.Y.Z"
  useEffect(() => {
    if (window.electronAPI?.isElectron && window.electronAPI.getDesktopVersion) {
      window.electronAPI.getDesktopVersion()
        .then((v) => { if (v) setDesktopVersion(String(v)); })
        .catch(() => {});
    }
  }, []);

  // 健康检查 + 网关状态
  useEffect(() => {
    const check = () => {
      const gwUrl = getGatewayUrl();
      if (!gwUrl) {
        // 无网关配置 — 检测当前 origin 是否可用（Electron 本地模式 / 云端模式 / 本机网关直接托管 UI）
        fetch(`${window.location.origin}/api/health`)
          .then((r) => r.json())
          .then((d) => {
            if (d.mode === "cloud") { setShowSetup(true); setConnected(false); setGatewayDown(false); }
            else if (d.status === "ok") {
              // 当前页面就是【本机网关】在同源托管 UI+API（非云端面板）→ 自动采用该 origin 作为网关，
              // 否则 getGatewayUrl()="" 会让设备页误报"未配置本地网关"并挡住设备扫描。
              try { if (!getGatewayUrl()) setGatewayUrl(window.location.origin); } catch {}
              setConnected(true); setGatewayDown(false);
            }
          })
          .catch(() => { setConnected(false); setGatewayDown(true); });
        return;
      }
      fetch(getApiUrl("/api/health"))
        .then((r) => r.json())
        .then((d) => {
          if (d.mode === "cloud" && !gwUrl) {
            setShowSetup(true);
            setConnected(false);
          } else {
            setConnected(true);
            setGatewayDown(false);
          }
        })
        .catch(() => {
          setConnected(false);
          setGatewayDown(true);
        });
    };
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, []);

  // 探测所连网关角色：node 客户端隐藏「管理后台」入口；设置页仍可用 /api/admin/auth 登录解锁本机角色设置。
  // 同时取本机角色 + 局域网地址，用于侧栏角色标记与"其他机器访问地址"展示
  useEffect(() => {
    fetch(getApiUrl("/api/discovery/info"))
      .then((r) => r.json())
      .then((d) => { if (d?.data) { setIsServerGw(!!d.data.isServer); setIsNodeGw((d.data.role || "standalone") !== "server"); setSelfInfo(d.data); } })
      .catch(() => {});
    fetch(getApiUrl("/api/discovery/ips")).then((r) => r.json())
      .then((d) => { if (d?.data) setIpList(d.data); }).catch(() => {});
  }, [connected]);

  // 多网卡时切换对外 IP（空=自动）；更新后刷新本机地址
  const changeAdvertiseIp = (ip) => {
    authenticatedFetch(getApiUrl("/api/discovery/advertise-ip"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip }) })
      .then((r) => r.json()).then((d) => {
        if (!d.ok) return;
        setIpList((p) => ({ ...p, advertiseIp: ip }));
        fetch(getApiUrl("/api/discovery/info")).then((r) => r.json()).then((x) => { if (x?.data) setSelfInfo(x.data); }).catch(() => {});
      }).catch(() => {});
  };

  // 版本更新检查（页面加载 + 切换页面时）
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        // Electron 桌面端：用 IPC 检查
        if (window.electronAPI?.checkUpdate) {
          const result = await window.electronAPI.checkUpdate();
          if (result.error) return;
          setLocalVersion(result.localVersion || "");
          if (result.hasUpdate) {
            const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY);
            if (dismissed !== result.remoteVersion) {
              setUpdateInfo({ local: result.localVersion, remote: result.remoteVersion });
              setUpdateDismissed(false);
            }
          } else {
            setUpdateInfo(null);
          }
          return;
        }

        // Web 模式：原有逻辑
        const gwUrl = getGatewayUrl();
        if (!gwUrl) return;
        const [cloudRes, localRes] = await Promise.all([
          fetch(`${window.location.origin}/api/gateway-version`).then(r => r.json()).catch(() => null),
          fetch(`${gwUrl}/api/health`).then(r => r.json()).catch(() => null),
        ]);
        const remoteVer = cloudRes?.version;
        const localVer = localRes?.version || null;
        if (localVer) setLocalVersion(localVer);
        if (isNewerVersion(remoteVer, localVer)) {
          const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY);
          if (dismissed !== remoteVer) {
            setUpdateInfo({ local: localVer, remote: remoteVer });
            setUpdateDismissed(false);
          }
        } else {
          setUpdateInfo(null);
        }
      } catch {}
    };
    checkUpdate();
  }, [location.pathname]);

  // 监听菜单"应用 → 检查更新"触发
  useEffect(() => {
    if (window.electronAPI?.onTriggerUpdateCheck) {
      return window.electronAPI.onTriggerUpdateCheck(() => handleCheckUpdate());
    }
  }, []);

  async function handleCheckUpdate() {
    setVersionChecking(true);
    let gwHasNew = false;
    let deskHasNew = false;
    try {
      if (window.electronAPI?.checkUpdate) {
        // 同时检查网关和桌面版
        const [gwResult, deskResult] = await Promise.all([
          window.electronAPI.checkUpdate(),
          window.electronAPI.checkDesktopUpdate?.() || Promise.resolve(null),
        ]);
        if (gwResult && !gwResult.error) {
          setLocalVersion(gwResult.localVersion || "");
          if (gwResult.hasUpdate) {
            setUpdateInfo({ local: gwResult.localVersion, remote: gwResult.remoteVersion, type: "gateway" });
            setUpdateDismissed(false);
            gwHasNew = true;
          }
        }
        if (deskResult && !deskResult.error && deskResult.hasUpdate) {
          setDesktopUpdateInfo({ local: deskResult.localVersion, remote: deskResult.remoteVersion });
          deskHasNew = true;
        } else {
          setDesktopUpdateInfo(null);
        }
        if (!gwHasNew && !deskHasNew) setUpdateInfo(null);
      } else {
        const gwUrl = getGatewayUrl();
        if (!gwUrl) return;
        const [cloudRes, localRes] = await Promise.all([
          fetch(`${window.location.origin}/api/gateway-version`).then(r => r.json()).catch(() => null),
          fetch(`${gwUrl}/api/health`).then(r => r.json()).catch(() => null),
        ]);
        const remoteVer = cloudRes?.version || "";
        const localVer = localRes?.version || null;
        if (localVer) setLocalVersion(localVer);
        if (isNewerVersion(remoteVer, localVer)) {
          setUpdateInfo({ local: localVer, remote: remoteVer, type: "gateway" });
          setUpdateDismissed(false);
          gwHasNew = true;
        } else {
          setUpdateInfo(null);
        }
      }
    } catch {}
    finally {
      setVersionChecking(false);
      if (!gwHasNew && !deskHasNew) {
        setUpdateCheckMsg("已是最新版本");
        setTimeout(() => setUpdateCheckMsg(""), 3000);
      }
    }
  }

  function testAndSave() {
    const url = setupUrl.replace(/\/+$/, "");
    setSetupStatus("testing");
    fetch(`${url}/api/health`)
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "ok") {
          setSetupStatus("ok");
          setGatewayUrl(url);
          setTimeout(() => {
            setShowSetup(false);
            setConnected(true);
            window.location.reload();
          }, 800);
        } else {
          setSetupStatus("fail");
        }
      })
      .catch(() => setSetupStatus("fail"));
  }

  // 给 ADB Extension Status 悬浮窗注入收起/展开按钮（该元素由外部注入）
  useEffect(() => {
    function patchAdbPanel() {
      const panel = document.getElementById("adb-extension-status");
      if (!panel || panel.dataset.patched) return;
      panel.dataset.patched = "1";

      const header = panel.querySelector("div");
      if (!header) return;

      // 将标题之后的内容包裹到一个容器中
      const content = document.createElement("div");
      content.id = "adb-content";
      while (panel.children.length > 1) {
        content.appendChild(panel.children[1]);
      }
      panel.appendChild(content);

      // 标题栏布局
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "center";
      header.style.cursor = "pointer";
      header.style.userSelect = "none";

      // 收起按钮
      const btn = document.createElement("span");
      btn.textContent = "\u2212"; // −
      Object.assign(btn.style, {
        marginLeft: "8px", width: "18px", height: "18px",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "rgba(255,255,255,0.2)", borderRadius: "3px",
        cursor: "pointer", fontSize: "14px",
      });
      header.appendChild(btn);

      let collapsed = false;
      header.addEventListener("click", () => {
        collapsed = !collapsed;
        content.style.display = collapsed ? "none" : "block";
        btn.textContent = collapsed ? "+" : "\u2212";
        panel.style.minWidth = collapsed ? "auto" : "200px";
      });
    }

    // 外部注入时机不确定，用 MutationObserver 监听
    patchAdbPanel();
    const observer = new MutationObserver(() => patchAdbPanel());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="app-shell flex h-screen" data-ui-region="app-shell">
      {/* 网关配置引导弹窗 */}
      {showSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[480px] shadow-2xl">
            <div className="px-6 py-5 border-b border-zinc-800">
              <h2 className="text-base font-semibold text-zinc-100">一行命令启动网关</h2>
              <p className="text-xs text-zinc-500 mt-1">
                当前为云端模式，需要在你的电脑上启动网关才能使用聊天、任务等功能
              </p>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* 上半部分：安装命令 */}
              <div>
                <p className="text-xs text-zinc-400 mb-2">打开 PowerShell，粘贴以下命令回车：</p>
                <div className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 flex items-center gap-2">
                  <code className="text-xs text-green-400 font-mono flex-1 break-all select-all">
                    {`irm ${window.location.origin}/setup.ps1 | iex`}
                  </code>
                  <button
                    onClick={() => {
                      copyToClipboard(`irm ${window.location.origin}/setup.ps1 | iex`).then(() => {
                        setCmdCopied(true);
                        setTimeout(() => setCmdCopied(false), 2000);
                      });
                    }}
                    className="shrink-0 px-2 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition"
                  >
                    {cmdCopied ? "已复制" : "复制"}
                  </button>
                </div>
                <p className="text-xs text-zinc-600 mt-1.5">首次安装约 2-3 分钟，再次运行会跳过已安装的步骤直接启动</p>
              </div>

              <div className="border-t border-zinc-800" />

              {/* 下半部分：连接网关 */}
              <div>
                <p className="text-xs text-zinc-400 mb-2">网关启动后会显示你的 IP 地址，填入下方连接：</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={setupUrl}
                    onChange={(e) => { setSetupUrl(e.target.value); setSetupStatus(null); }}
                    placeholder="http://192.168.x.x:3001"
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
                    onKeyDown={(e) => e.key === "Enter" && testAndSave()}
                  />
                  <button
                    onClick={testAndSave}
                    disabled={!setupUrl.trim() || setupStatus === "testing"}
                    className="shrink-0 px-4 py-2.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
                  >
                    {setupStatus === "testing" ? "连接中..." : "测试并保存"}
                  </button>
                </div>

                {setupStatus === "fail" && (
                  <p className="text-xs text-red-400 mt-2">连接失败，请检查地址是否正确、网关是否已启动</p>
                )}
                {setupStatus === "ok" && (
                  <p className="text-xs text-green-400 mt-2">连接成功，正在跳转...</p>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-zinc-800 flex justify-end">
              <button
                onClick={() => setShowSetup(false)}
                className="px-4 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition"
              >
                稍后配置
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 侧栏 */}
      <nav
        className="app-sidebar border-r flex flex-col py-3 shrink-0 overflow-hidden"
        data-ui-region="sidebar"
        data-expanded={sidebarExpanded}
      >
        {/* Logo + 侧栏展开/收起 */}
        <div className={`px-2 mb-4 h-9 flex items-center ${sidebarExpanded ? "justify-between" : "justify-center"}`}>
          {sidebarExpanded && (
            <div className="app-brand-mark">
              AE
            </div>
          )}
          <button
            type="button"
            onClick={toggleSidebar}
            className={`app-sidebar__toggle ${sidebarExpanded ? "w-8" : "w-9"} h-9 rounded-lg flex items-center justify-center`}
            title={sidebarExpanded ? "向左收起侧栏" : "向右展开侧栏"}
            aria-label={sidebarExpanded ? "向左收起侧栏" : "向右展开侧栏"}
          >
            <svg className="w-4 h-4" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={sidebarExpanded ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"}
              />
            </svg>
          </button>
        </div>

        {/* 导航项 */}
        <div className="flex-1 flex flex-col px-2 space-y-1 overflow-y-auto">
          {nav.filter((item) => SIDEBAR_VISIBLE_PATHS.has(item.path) && (item.path !== "/admin" || isServerGw) && (!NODE_ONLY_PATHS.has(item.path) || isNodeGw)).map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              title={sidebarExpanded ? undefined : item.label}
              onMouseEnter={item.path === "/admin" ? () => { void import("./pages/AdminPlatform.jsx"); } : undefined}
              onFocus={item.path === "/admin" ? () => { void import("./pages/AdminPlatform.jsx"); } : undefined}
              className={({ isActive }) =>
                `app-sidebar__item flex items-center gap-3 h-10 px-2.5 whitespace-nowrap ${
                  isActive
                    ? "is-active"
                    : ""
                }`
              }
            >
              <span className="shrink-0 w-5 h-5 flex items-center justify-center">{item.icon}</span>
              <span
                className="app-sidebar__label text-sm overflow-hidden"
              >
                {item.label}
              </span>
            </NavLink>
          ))}
        </div>

        {/* 本机角色标记 + 其他局域网机器访问本机的地址 */}
        {selfInfo && (() => {
          const role = selfInfo.role;
          const dual = role === "standalone";
          const label = dual ? "服务端 + 客户端" : role === "server" ? "服务端" : "客户端";
          const cls = dual ? "bg-indigo-500/15 text-indigo-300 border-indigo-500/30"
            : role === "server" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
            : "bg-zinc-700/40 text-zinc-400 border-zinc-600/40";
          return (
            <div className="app-sidebar__machine px-2 pb-1.5">
              {sidebarExpanded ? (
                <div className="space-y-1.5">
                  <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] ${cls}`}>
                    {dual ? "🖥️＋💻 " : role === "server" ? "🖥️ " : "💻 "}{label}
                  </div>
                  {selfInfo.isServer && selfInfo.host && (
                    <div className="text-[10px] leading-relaxed">
                      <div className="text-zinc-600">其他机器访问本机：</div>
                      {ipList.ips.length > 1 ? (
                        // 多网卡：下拉让用户选对外 IP（含"自动")
                        <select value={ipList.advertiseIp} onChange={(e) => changeAdvertiseIp(e.target.value)}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-200 font-mono outline-none">
                          <option value="">自动（{(ipList.ips[0] || {}).address}）</option>
                          {ipList.ips.map((x) => <option key={x.address} value={x.address}>{x.address} · {x.iface}</option>)}
                        </select>
                      ) : (
                        <div className="flex items-center gap-1">
                          <code className="font-mono text-zinc-300 truncate">{selfInfo.host}</code>
                          <button onClick={() => copyToClipboard(selfInfo.host)} title="复制地址" className="text-zinc-600 hover:text-zinc-300 shrink-0">⧉</button>
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <a href={`${selfInfo.host}/install`} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">→ 安装页 /install</a>
                        <button onClick={() => copyToClipboard(selfInfo.host)} title="复制地址" className="text-zinc-600 hover:text-zinc-300">复制 {selfInfo.host.replace(/^https?:\/\//, "")}</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex justify-center" title={`本机：${label}${selfInfo.isServer && selfInfo.host ? "（其他机器访问 " + selfInfo.host + "）" : ""}`}>
                  <span className={`w-2 h-2 rounded-full ${dual ? "bg-indigo-400" : role === "server" ? "bg-emerald-400" : "bg-zinc-500"}`} />
                </div>
              )}
            </div>
          );
        })()}

        {/* 底部状态 + 版本号 */}
        <div className="px-2 pb-2">
          <div className="flex items-center gap-2" title={connected ? "网关已连接" : "网关未连接"}>
            <span className="w-5 flex justify-center shrink-0">
              <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
            </span>
            <span
              className="text-xs text-zinc-600 overflow-hidden whitespace-nowrap flex items-center gap-1.5"
              style={{
                width: sidebarExpanded ? (desktopVersion ? 200 : 120) : 0,
                opacity: sidebarExpanded ? 1 : 0,
                transition: "opacity 200ms",
              }}
            >
              {connected ? "已连接" : "未连接"}
              {localVersion && (
                <span
                  onClick={handleCheckUpdate}
                  className={`font-mono cursor-pointer transition relative ${
                    updateInfo && !updateDismissed
                      ? "text-blue-400 hover:text-blue-300"
                      : "text-zinc-700 hover:text-zinc-400"
                  }`}
                  title={`网关 v${localVersion}${desktopVersion ? ` · 桌面 v${desktopVersion}` : ""}　点击检查更新`}
                >
                  {versionChecking ? "..." : `v${localVersion}`}
                  {updateInfo && !updateDismissed && (
                    <span className="absolute -top-1 -right-2 w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                  )}
                </span>
              )}
              {desktopVersion && (
                <span className="font-mono text-zinc-700 shrink-0" title={`桌面版 v${desktopVersion}（app.getVersion）`}>
                  · 桌面 v{desktopVersion}
                </span>
              )}
            </span>
          </div>
        </div>
      </nav>

      {/* 内容 */}
      <main className="app-main min-w-0 flex-1 overflow-hidden flex flex-col relative" data-ui-region="main-content">
        {/* 已是最新版本提示 */}
        {updateCheckMsg && (
          <div className="shrink-0 bg-green-600/10 border-b border-green-500/20 px-4 py-2 flex items-center gap-2">
            <span className="text-xs text-green-400">&#x2705; {updateCheckMsg}</span>
          </div>
        )}

        {/* 桌面版更新横幅 */}
        {desktopUpdateInfo && (
          <div className="absolute top-0 left-0 right-0 z-[60] bg-purple-600/15 border-b border-purple-500/30 px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">&#x1F5A5;</span>
              <span className="text-xs text-purple-300">
                桌面版新版本可用 <span className="font-mono font-medium text-purple-200">v{desktopUpdateInfo.remote}</span>
                <span className="text-purple-400 ml-1">（当前 v{desktopUpdateInfo.local}）</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setDesktopUpdating(true);
                  try {
                    const r = await window.electronAPI.doDesktopUpdate();
                    if (!r.success) {
                      setDesktopUpdating(false);
                      alert(`更新失败: ${r.error}`);
                    }
                    // 成功时应用会自动退出，安装器接管
                  } catch (e) {
                    setDesktopUpdating(false);
                    alert(`失败: ${e.message}`);
                  }
                }}
                disabled={desktopUpdating}
                className="px-3 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 text-white transition"
              >
                {desktopUpdating ? "下载中，即将重启..." : "下载并安装"}
              </button>
              <button
                onClick={() => setDesktopUpdateInfo(null)}
                className="px-2 py-1 text-xs text-purple-400 hover:text-purple-200 transition"
                disabled={desktopUpdating}
              >
                稍后
              </button>
            </div>
          </div>
        )}

        {/* 版本更新横幅 */}
        {updateInfo && !updateDismissed && (
          <div className="absolute top-0 left-0 right-0 z-[60] bg-blue-600/15 border-b border-blue-500/30 px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">&#x1F4E6;</span>
              <span className="text-xs text-blue-300">
                发现新版本 <span className="font-mono font-medium text-blue-200">v{updateInfo.remote}</span>
                <span className="text-blue-400 ml-1">（当前 v{updateInfo.local}）</span>
                {updateMsg && <span className="text-blue-400 ml-2">{updateMsg}</span>}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setUpdating(true);
                  setUpdateMsg("下载更新中...");
                  try {
                    if (window.electronAPI?.doUpdate) {
                      // Electron 桌面端：IPC 更新
                      const result = await window.electronAPI.doUpdate();
                      if (result.success) {
                        setUpdateMsg("更新完成，正在重启...");
                        setTimeout(() => window.electronAPI.restartApp(), 1500);
                      } else {
                        setUpdateMsg(`失败: ${result.error}`);
                        setUpdating(false);
                      }
                    } else {
                      // Web 模式：网关 self-update
                      const gwUrl = getGatewayUrl();
                      const resp = await fetch(`${gwUrl}/api/config/self-update`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ cloudUrl: window.location.origin }),
                      });
                      const d = await resp.json();
                      if (d.success) {
                        setUpdateMsg("更新完成，网关重启中...");
                        setTimeout(() => {
                          const checkRestart = setInterval(() => {
                            fetch(`${gwUrl}/api/health`).then(r => r.json()).then(h => {
                              if (h.status === "ok") {
                                clearInterval(checkRestart);
                                setUpdateInfo(null);
                                window.location.reload();
                              }
                            }).catch(() => {});
                          }, 2000);
                          setTimeout(() => clearInterval(checkRestart), 30000);
                        }, 2000);
                      } else {
                        setUpdateMsg(`失败: ${d.error}`);
                        setUpdating(false);
                      }
                    }
                  } catch (e) {
                    setUpdateMsg(`失败: ${e.message}`);
                    setUpdating(false);
                  }
                }}
                disabled={updating}
                className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-blue-400 text-white transition"
              >
                {updating ? "更新中..." : "一键更新"}
              </button>
              <button
                onClick={() => { setUpdateDismissed(true); localStorage.setItem(UPDATE_DISMISS_KEY, updateInfo.remote); }}
                className="px-2 py-1 text-xs text-blue-400 hover:text-blue-200 transition"
                disabled={updating}
              >
                忽略
              </button>
            </div>
          </div>
        )}

        {/* 网关断连横幅 */}
        {gatewayDown && getGatewayUrl() && (
          <div className="absolute top-0 left-0 right-0 z-[60] bg-red-600/15 border-b border-red-500/30 px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">&#x26A0;&#xFE0F;</span>
              <span className="text-xs text-red-300">
                网关未响应 <span className="text-red-400 font-mono">({getGatewayUrl()})</span>
                <span className="text-red-400 ml-1">— 请确认本机网关已启动</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  copyToClipboard(`irm ${window.location.origin}/setup.ps1 | iex`);
                  setCmdCopied(true);
                  setTimeout(() => setCmdCopied(false), 2000);
                }}
                className="px-3 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition"
                title="复制启动命令，在 PowerShell 中执行即可启动网关"
              >
                {cmdCopied ? "已复制" : "复制启动命令"}
              </button>
              <button
                onClick={() => {
                  setReconnecting(true);
                  fetch(getApiUrl("/api/health"))
                    .then(r => r.json())
                    .then(d => {
                      if (d.status === "ok") { setConnected(true); setGatewayDown(false); }
                      setReconnecting(false);
                    })
                    .catch(() => setReconnecting(false));
                }}
                disabled={reconnecting}
                className="px-3 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition disabled:opacity-50"
              >
                {reconnecting ? "连接中..." : "重试连接"}
              </button>
              <button
                onClick={() => { setShowSetup(true); }}
                className="px-2 py-1 text-xs text-red-400 hover:text-red-200 transition"
              >
                重新配置
              </button>
            </div>
          </div>
        )}
        {/* 首次进入聊天后再常驻；直接打开业务页时不加载聊天资源和后台请求。 */}
        {chatVisited && (
          <div className="app-route-surface flex-1 overflow-hidden" style={{ display: isChatPage ? "contents" : "none" }}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">正在加载聊天...</div>}>
              <Chat />
            </Suspense>
          </div>
        )}
        {/* 其他页面走正常路由 */}
        {!isChatPage && (
          <div className="app-route-surface flex-1 overflow-hidden">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">正在加载页面...</div>}>
              <Outlet />
            </Suspense>
          </div>
        )}
        {/* devbench 走 keep-alive：首次访问前不挂载 chunk；访问后保持 React state（含 tabs / liveMap / 滚动位置 / 工程选择等），
            切走仅 display:none，再回来秒级显示，无需重新拉 tabs/projects/会话。 */}
        {devbenchVisited && (
          // 注意：这里 inline style 用 `display: block`（不要用 `flex`，默认 row 主轴会让 DevBench 顶层宽度按内容收缩，第一帧占不满右侧全屏）。
          // 容器已经是 `absolute inset-0`，靠定位撑满四边；子项 `block` 默认 width:100% 父，DevBench 顶层无须 `w-full` 兜底。
          <div className="app-route-surface devbench-route-surface flex-1 overflow-hidden absolute inset-0 z-0" style={{ display: isDevbenchPage ? "block" : "none" }}>
            <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">正在加载工程开发...</div>}>
              <DevBench />
            </Suspense>
          </div>
        )}
      </main>
      {/* 常驻悬浮坞：收纳「反馈BUG」+ 管理员「在此开发」，可收起到右侧栏，避免压住页面按钮 */}
      <FloatingDock>
        <FeedbackButton />
        <DevMode />
        <DevRecordingButton />
      </FloatingDock>
      <DevRecordingOverlay />
    </div>
  );
}
