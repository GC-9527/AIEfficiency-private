import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("chat, ordinary Outlet pages, and DevBench share the light route surface", () => {
  const app = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");

  assert.match(app, /className="app-route-surface flex-1 overflow-hidden" style=\{\{ display: isChatPage/);
  assert.match(app, /!isChatPage[\s\S]*?className="app-route-surface flex-1 overflow-hidden"[\s\S]*?<Outlet \/>/);
  assert.match(app, /devbenchVisited[\s\S]*?className="app-route-surface devbench-route-surface flex-1 overflow-hidden absolute inset-0 z-0"/);
});

test("ordinary routes translate legacy dark surface, text, and border tokens to the shared light theme", () => {
  const css = fs.readFileSync(new URL("./index.css", import.meta.url), "utf8");

  assert.match(css, /\.app-route-surface\s*\{[\s\S]*?background:\s*var\(--color-paper\)/);
  assert.match(css, /:is\(\.app-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class~="bg-zinc-900"\][\s\S]*?background-color:\s*var\(--color-canvas\)/);
  assert.match(css, /:is\(\.app-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class~="bg-zinc-800"\][\s\S]*?background-color:\s*var\(--color-paper-2\)/);
  assert.match(css, /:is\(\.app-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class~="text-zinc-300"\][\s\S]*?color:\s*var\(--color-ink-2\)/);
  assert.match(css, /:is\(\.app-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class~="border-zinc-800"\][\s\S]*?border-color:\s*var\(--color-rule\)/);
  assert.match(css, /\[class~="bg-\[\#0f0f10\]"\]/);
});

test("DevBench receives light structural and semantic status mappings", () => {
  const css = fs.readFileSync(new URL("./index.css", import.meta.url), "utf8");

  assert.match(css, /\.devbench-route-surface\s*\{[\s\S]*?background:\s*var\(--color-paper\)/);
  assert.match(css, /:is\(\.devbench-route-surface, \.devbench-portal-theme\) \[class~="bg-\[\#101112\]"\][\s\S]*?background-color:\s*var\(--color-canvas\)/);
  assert.match(css, /:is\(\.devbench-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class\^="bg-red-9"\][\s\S]*?background-color:\s*var\(--status-danger-soft\)/);
  assert.match(css, /:is\(\.devbench-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class\^="text-amber-1"\][\s\S]*?color:\s*var\(--status-warning\)/);
  assert.match(css, /:is\(\.devbench-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class\^="text-cyan-1"\][\s\S]*?color:\s*var\(--color-accent\)/);
});

test("DevBench portals inherit the active light theme without recoloring their backdrop", () => {
  const app = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("./pages/devbench/NewStoryPanel.jsx", import.meta.url), "utf8");

  assert.match(app, /document\.body\.classList\.toggle\("devbench-portal-theme", isDevbenchPage\)/);
  assert.match(app, /document\.body\.classList\.remove\("devbench-portal-theme"\)/);
  assert.match(css, /:is\(\.app-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class~="bg-zinc-950"\][\s\S]*?background-color:\s*var\(--color-canvas\)/);
  assert.match(css, /:is\(\.devbench-route-surface, \.devbench-portal-theme\) :is\([\s\S]*?\[class\^="bg-cyan-9"\][\s\S]*?background-color:\s*var\(--color-accent-soft\)/);
  assert.match(panel, /bg-black\/75/, "the modal backdrop must remain explicitly dimmed");
  assert.doesNotMatch(css, /devbench-portal-theme[^\n{]*\[class[^\n{]*bg-black/,
    "the portal compatibility scope must not turn modal backdrops white");
  assert.match(css, /:is\(\.devbench-route-surface, \.devbench-portal-theme\)[\s\S]*?button:disabled\[class\*="disabled:from-zinc-"\][\s\S]*?background-image:\s*none/,
    "disabled gradient actions must use a light neutral surface instead of a dark zinc gradient");
});

test("shared scrollbars stay thin and use theme tokens on light route surfaces", () => {
  const css = fs.readFileSync(new URL("./index.css", import.meta.url), "utf8");

  assert.match(css, /\*\s*\{[\s\S]*?scrollbar-width:\s*thin;[\s\S]*?scrollbar-color:\s*var\(--color-rule-2\) transparent;/);
  assert.match(css, /::\-webkit-scrollbar\s*\{[\s\S]*?width:\s*6px;[\s\S]*?height:\s*6px;/);
  assert.match(css, /::\-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*var\(--color-rule-2\);[\s\S]*?border-radius:\s*var\(--radius-pill\)/);
  assert.doesNotMatch(css, /::\-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#333/);
});

test("global keyboard focus is a low-specificity fallback for custom rounded controls", () => {
  const css = fs.readFileSync(new URL("./index.css", import.meta.url), "utf8");

  assert.match(css, /:where\(:focus-visible\)\s*\{[\s\S]*?outline:\s*2px solid var\(--color-focus\)/,
    "the global focus ring must remain available for controls without a component focus style");
  assert.doesNotMatch(css, /(?:^|\n):focus-visible\s*\{/,
    "a bare :focus-visible rule overrides outline-none and creates a second rectangular focus box");
});

test("the light compatibility layer uses exact zinc tokens so disabled styles cannot override primary buttons", () => {
  const css = fs.readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const devices = fs.readFileSync(new URL("./pages/Devices.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(css, /\.app-route-surface[^{]*\[class\*="bg-zinc-"\]/);
  assert.match(devices, /bg-blue-600[^"`]*disabled:bg-zinc-700/);
});

test("shared shell consumes the product design tokens and exposes stable UI regions", () => {
  const app = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const dock = fs.readFileSync(new URL("./components/FloatingDock.jsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const tokens = fs.readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

  assert.match(tokens, /^\/\* Hallmark · genre: modern-minimal · macrostructure: Workbench/m);
  for (const token of [
    "--color-paper", "--color-canvas", "--color-ink", "--color-accent",
    "--color-accent-ink", "--color-focus", "--font-body", "--font-outlier",
    "--z-dock", "--status-success", "--status-danger",
  ]) {
    assert.ok(tokens.includes(token), `tokens.css must define ${token}`);
  }
  assert.match(tokens, /\[data-theme="dark"\]/, "the design system must provide a reusable dark token set");
  assert.match(css, /^@import "\.\.\/tokens\.css";/);
  assert.match(css, /html,\s*body\s*\{[\s\S]*?overflow-x:\s*clip/);
  assert.match(css, /@media\s*\(min-width:\s*40rem\)/, "responsive rules must be mobile-first");
  assert.match(app, /data-ui-region="app-shell"/);
  assert.match(app, /data-ui-region="sidebar"/);
  assert.match(app, /data-ui-region="main-content"/);
  assert.match(dock, /data-ui-layer="dock"/);
});

// 侧栏入口白名单：用户明确指定只暴露 工程开发 / 车机调试 / 设备 / 设置。
// 改 App.jsx 的 nav 白名单时要同步这里；后续增删入口需双向校验。

test("AI 提效工作台侧栏入口白名单符合 ask_7 要求", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.match(src, /const SIDEBAR_VISIBLE_PATHS = new Set\([\s\S]*?\);/,
    "App.jsx 必须声明 SIDEBAR_VISIBLE_PATHS 白名单");

  // 直接 grep 所有 path: "/xxx" 字面量，再校验白名单
  const paths = Array.from(src.matchAll(/["'`](\/[a-z][a-z0-9-]*)["'`]/g)).map((m) => m[1]);
  // 解析 Set 数组里的所有字符串字面量
  const setBlockMatch = src.match(/const SIDEBAR_VISIBLE_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(setBlockMatch, "白名单必须以 Set([...]) 形式声明");
  const items = Array.from(setBlockMatch[1].matchAll(/["'`](\/[a-z][a-z0-9-]*)["'`]/g)).map((m) => m[1]);

  assert.deepEqual(items, [
    "/devbench",   // 工程开发
    "/cardev",     // 车机调试
    "/devices",    // 设备
    "/admin",      // 管理后台
    "/settings",   // 设置
  ], "白名单必须恰好包含日常入口与管理后台路径，多一个或少一个都算回归");

  // 5 个路径都必须能映射到 nav 数组里的某个 path
  for (const p of items) {
    assert.ok(paths.includes(p), `白名单路径 ${p} 必须在 nav 或 NODE_ONLY_PATHS 等被引用`);
  }
});

test("侧栏 nav.filter 必须先过 SIDEBAR_VISIBLE_PATHS 白名单", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // 强制要求 filter 表达式里出现 SIDEBAR_VISIBLE_PATHS.has
  assert.match(src,
    /nav\.filter\(\(item\) => SIDEBAR_VISIBLE_PATHS\.has\(item\.path\)[\s\S]*?\)\.map/,
    "nav.filter 必须以 SIDEBAR_VISIBLE_PATHS.has 作为第一道闸门");
});

test("白名单里的 5 个路径都存在于 nav 数组中（防白名单打错路径）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // 解析 nav 数组的边界：从 const nav = [ 开始到 const NODE_ONLY_PATHS 之前
  const navStart = src.indexOf("const nav = [");
  const navEnd = src.indexOf("const NODE_ONLY_PATHS", navStart);
  assert.ok(navStart >= 0 && navEnd > navStart, "App.jsx 必须声明 nav 数组");
  const navPaths = Array.from(src.slice(navStart, navEnd).matchAll(/path:\s*["'`](\/[a-z][a-z0-9-]*)["'`]/g)).map((m) => m[1]);
  for (const p of ["/devbench", "/cardev", "/devices", "/admin", "/settings"]) {
    assert.ok(navPaths.includes(p), `nav 必须包含 ${p}`);
  }
});

test("登录入口显示为管理后台，且仍保留服务端角色门禁", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.match(src, /path:\s*["'`]\/admin["'`],\s*label:\s*["'`]管理后台["'`]/,
    "左侧 /admin 入口必须显示为管理后台");
  assert.match(src, /item\.path\s*!==\s*["'`]\/admin["'`]\s*\|\|\s*isServerGw/,
    "登录入口必须保留服务端/单机角色门禁");
});

test("未保留路径 /chat /skills 等不能出现在白名单中（防入口膨胀）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const setBlockMatch = src.match(/const SIDEBAR_VISIBLE_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  const items = Array.from(setBlockMatch[1].matchAll(/["'`](\/[a-z][a-z0-9-]*)["'`]/g)).map((m) => m[1]);
  const forbidden = ["/chat", "/skills", "/agents", "/tokens", "/logs", "/aiautowork",
    "/tb-tasks", "/feishu-project-sync", "/bug-agent", "/schedule", "/web-nav-dev",
    "/project-dev", "/help", "/performance"];
  for (const p of forbidden) {
    assert.ok(!items.includes(p), `白名单不得包含 ${p}`);
  }
});
