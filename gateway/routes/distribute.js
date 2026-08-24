/**
 * LAN 自分发路由（仅服务端角色挂载）：让局域网客户端无需中心 Docker 即可一键安装。
 *   GET /install                     傻瓜安装落地页（桌面EXE / 网页版 / PowerShell 三选一）
 *   GET /setup.ps1                   客户端一键安装脚本（自动配成客户端并连本服务端）
 *   GET /download/gateway-bundle.zip 按需打包的网关代码包
 *   GET /download/desktop-setup.exe  桌面安装包（若服务端本地有）
 *   GET /api/gateway-version         网关版本（供脚本更新检测）
 */
import { Router } from "express";
import path from "path";
import QRCode from "qrcode";
import { getConfig } from "../services/config.js";
import { configuredNodeDisplayName } from "../services/node-name.js";
import { generateSetupScript } from "../services/setup-script.js";
import { generateSetupScriptSh } from "../services/setup-script-sh.js";
import { ensureBundle, gatewayVersion, findDesktopExe, findDesktopDmg } from "../services/bundle.js";

const router = Router();
const origin = (req) => `${req.protocol}://${req.headers.host}`;
const serverName = () => configuredNodeDisplayName(getConfig(), "本服务端");

router.get("/api/gateway-version", (req, res) => res.json({ version: gatewayVersion() }));

router.get("/setup.ps1", (req, res) => {
  const script = generateSetupScript({
    serverUrl: origin(req),
    asClient: req.query.client !== "0",
    token: req.query.token ? String(req.query.token) : "",
    serverName: serverName(),
  });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(script);
});

// macOS / Linux 一键安装（bash）
router.get("/setup.sh", (req, res) => {
  const script = generateSetupScriptSh({
    serverUrl: origin(req),
    asClient: req.query.client !== "0",
    token: req.query.token ? String(req.query.token) : "",
    serverName: serverName(),
  });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(script);
});

router.get("/download/gateway-bundle.zip", async (req, res) => {
  try {
    const zip = await ensureBundle();
    res.download(zip, "gateway-bundle.zip");
  } catch (e) { res.status(500).json({ error: "打包失败：" + e.message }); }
});

router.get("/download/desktop-setup.exe", (req, res) => {
  const exe = findDesktopExe();
  if (!exe) return res.status(404).json({ error: "本服务端未放置 Windows 桌面安装包（管理员可将 EXE 放到 gateway/desktop-setup.exe 或 desktop/dist/）" });
  res.download(exe, "AI提效工具-Setup.exe");
});

router.get("/download/desktop-setup.dmg", (req, res) => {
  const dmg = findDesktopDmg();
  if (!dmg) return res.status(404).json({ error: "本服务端未放置 macOS 桌面安装包（管理员可将 DMG 放到 gateway/desktop-setup.dmg 或 desktop/dist/）" });
  res.download(dmg, "AI提效工具.dmg");
});

router.get("/install", async (req, res) => {
  const url = origin(req);
  const hasExe = !!findDesktopExe();
  const hasDmg = !!findDesktopDmg();
  const name = serverName();
  let qrSvg = "";
  try { qrSvg = await QRCode.toString(`${url}/install`, { type: "svg", margin: 1, width: 150, color: { dark: "#e4e4e7", light: "#0000" } }); } catch {}
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(installPage({ url, hasExe, hasDmg, name, version: gatewayVersion(), qrSvg }));
});

function installPage({ url, hasExe, hasDmg, name, version, qrSvg }) {
  const psCmd = `irm ${url}/setup.ps1 | iex`;
  const shCmd = `curl -fsSL ${url}/setup.sh | bash`;
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安装 AI 提效客户端 · ${name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f10;color:#e4e4e7;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;min-height:100vh;padding:40px 20px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:22px;font-weight:600;margin-bottom:6px}
  .sub{color:#71717a;font-size:13px;margin-bottom:28px}
  .card{background:#18181b;border:1px solid #27272a;border-radius:14px;padding:20px;margin-bottom:16px}
  .card h2{font-size:15px;margin-bottom:4px;display:flex;align-items:center;gap:8px}
  .card p{color:#a1a1aa;font-size:12px;line-height:1.6;margin-bottom:12px}
  .tag{font-size:10px;padding:2px 7px;border-radius:6px;background:#27272a;color:#a1a1aa}
  .rec{background:rgba(16,185,129,.15);color:#34d399}
  .btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-size:13px;padding:9px 18px;border-radius:9px;border:none;cursor:pointer}
  .btn:hover{background:#1d4ed8}
  .btn.gray{background:#27272a;color:#e4e4e7}.btn.gray:hover{background:#3f3f46}
  .btn.disabled{background:#27272a;color:#6b7280;pointer-events:none}
  code{display:block;background:#0a0a0b;border:1px solid #27272a;border-radius:9px;padding:11px 13px;font-family:Consolas,monospace;font-size:12.5px;color:#34d399;word-break:break-all;margin-bottom:10px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .steps{color:#a1a1aa;font-size:12px;line-height:1.8;margin-top:8px;padding-left:18px}
  .foot{color:#52525b;font-size:11px;margin-top:24px;line-height:1.7}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .qr{flex-shrink:0;text-align:center;background:#18181b;border:1px solid #27272a;border-radius:12px;padding:10px}
  .qr svg{width:130px;height:130px;display:block}
  .qr .cap{font-size:10px;color:#71717a;margin-top:6px;max-width:130px}
</style></head>
<body><div class="wrap">
  <div class="head">
    <div>
      <h1>🤖 安装 AI 提效 客户端</h1>
      <div class="sub">服务端：<b style="color:#a1a1aa">${name}</b> · ${url} · 网关 v${version}</div>
    </div>
    ${qrSvg ? `<div class="qr">${qrSvg}<div class="cap">扫码在其它设备打开本安装页</div></div>` : ""}
  </div>

  <div class="card">
    <h2>① 桌面版 <span class="tag rec">最傻瓜 · 推荐</span></h2>
    <p>双击安装，内置网关 + 面板，免命令。首次启动选「💻 客户端」即自动配好；在「选择服务端」里本机会自动发现本服务端。</p>
    <div class="row">
      ${hasExe ? `<a class="btn" href="${url}/download/desktop-setup.exe">⬇ Windows (.exe)</a>` : `<span class="btn disabled">Windows 版未就绪</span>`}
      ${hasDmg ? `<a class="btn" href="${url}/download/desktop-setup.dmg">⬇ macOS (.dmg)</a>` : `<span class="btn disabled">macOS 版未就绪</span>`}
    </div>
    ${(!hasExe || !hasDmg) ? `<div style="color:#71717a;font-size:11px;margin-top:8px">未就绪的平台：管理员把安装包放到服务端 gateway/desktop-setup.exe / desktop-setup.dmg 或 desktop/dist/。macOS 首次打开若被 Gatekeeper 拦，右键「打开」或 <code style="display:inline;padding:1px 5px">xattr -dr com.apple.quarantine /Applications/AI提效工具.app</code></div>` : ""}
  </div>

  <div class="card">
    <h2>② 直接用网页版 <span class="tag">无需安装</span></h2>
    <p>本机若已装过网关，直接打开本服务端面板使用；面板里把网关地址填本机 <code style="display:inline;padding:1px 5px">http://localhost:3001</code> 即可。</p>
    <a class="btn gray" href="${url}/">打开网页面板</a>
  </div>

  <div class="card">
    <h2>③ 命令行一键安装 <span class="tag">无桌面版时用</span></h2>
    <p>在客户端终端粘贴执行。自动装 Node、装网关、开机自启，并<b>自动配成客户端 + 已连本服务端</b>。</p>
    <div style="font-size:11px;color:#a1a1aa;margin:2px 0 4px">🪟 Windows（PowerShell）</div>
    <code id="ps">${psCmd}</code>
    <button class="btn gray" onclick="navigator.clipboard.writeText(document.getElementById('ps').innerText);this.innerText='已复制 ✓'">复制 Windows 命令</button>
    <div style="font-size:11px;color:#a1a1aa;margin:12px 0 4px"> macOS / Linux（终端）</div>
    <code id="sh">${shCmd}</code>
    <button class="btn gray" onclick="navigator.clipboard.writeText(document.getElementById('sh').innerText);this.innerText='已复制 ✓'">复制 macOS/Linux 命令</button>
    <div class="steps">Windows 若提示执行策略：先 <code style="display:inline;padding:1px 5px">Set-ExecutionPolicy -Scope Process Bypass -Force</code>。macOS 缺 Node 会提示 <code style="display:inline;padding:1px 5px">brew install node</code>。</div>
  </div>

  <div class="foot">
    三种方式装好的都是<b>本机网关</b>(localhost:3001)，重活在本机跑、借本服务端的 Claude。<br>
    跨子网无法自动发现时，可在客户端「设置 → 选择服务端」手填本服务端 IP。
  </div>
</div></body></html>`;
}

export default router;
