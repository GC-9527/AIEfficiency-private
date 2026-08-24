import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("DevBench keep-alive container participates in the shared light route theme", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.match(src,
    /className="app-route-surface devbench-route-surface flex-1 overflow-hidden absolute inset-0 z-0"/,
    "DevBench must retain its keep-alive geometry while joining the light route theme");
});

// devbench keep-alive：第一次访问 devbench 后常驻 React state，切到其他 tab 再回来秒级显示。
// 实施要点（与 /chat 同源模式）：
//   1. main.jsx 里 /devbench 路由 element={null}（让 React Router 不实例化 Outlet 元素）
//   2. App.jsx 用 devbenchVisited 状态控制 chunk 首次挂载
//   3. App.jsx 在 <Outlet /> 之外单独渲染 DevBench，通过 display 切换可见性

test("main.jsx 中 /devbench 路由 element 必须为 null（不实例化 Outlet 元素）", () => {
  const src = fs.readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  assert.match(src, /<Route\s+path="devbench"\s+element=\{null\}\s*\/>/,
    "main.jsx 必须把 /devbench 路由的 element 设为 null，让 keep-alive 由 App.jsx 控制");
});

test("main.jsx 不再 import DevBench（避免死代码警告）", () => {
  const src = fs.readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^const\s+DevBench\s*=\s*lazy/m,
    "main.jsx 必须删除 const DevBench = lazy(...)（否则 vite/dead code 警告）");
});

test("App.jsx 必须 lazy import DevBench", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.match(src, /const\s+DevBench\s*=\s*lazy\(\(\)\s*=>\s*import\(["']\.\/pages\/devbench\/index\.jsx["']\)\)/,
    "App.jsx 必须自己 lazy import  DevBench 以承担挂载职责");
});

test("App.jsx 必须有 devbenchVisited 状态与 isDevbenchPage 判定", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.match(src, /const\s+\[devbenchVisited,\s*setDevbenchVisited\]\s*=\s*useState/,
    "App.jsx 必须声明 devbenchVisited 状态");
  assert.match(src, /const\s+isDevbenchPage\s*=\s*location\.pathname\s*===\s*["']\/devbench["']/,
    "App.jsx 必须有 isDevbenchPage 派生值");
  assert.match(src, /useEffect\(\(\)\s*=>\s*\{[^}]*if\s*\(\s*isDevbenchPage\s*\)\s*setDevbenchVisited\(true\)/,
    "App.jsx 必须在路径进入 /devbench 时设置 devbenchVisited=true");
});

test("App.jsx 必须用 display 切换控制 devbench 容器可见性（不卸载）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // 必须有 devbenchVisited && <div style={{ display: isDevbenchPage ? "<某非 none>" : "none" }}>
  // 注意：display 字段可以是 "block"（推荐：absolute inset-0 + block 子项默认 width:100% 父）、
  // "flex" 配 flex-direction: column，或历史用过的 "flex"（默认 row，已被禁止，见下一条测试）。
  // 不能用 ^<div[^>]*> 因为 fallback 里嵌套 <div> 的 `>` 会让 [^>]* 提前截断；
  // 改成直接锁定 `display: isDevbenchPage ? "<word>" : "none"` 模式。
  assert.match(src,
    /display:\s*isDevbenchPage\s*\?\s*["'](?:block|flex|grid|inline)["']\s*:\s*["']none["']/,
    "devbench 容器必须用 display: <某非 none> : \"none\" 切换可见性（如 \"block\" 或 \"flex\"），保留挂载");
  assert.match(src, /<Suspense[^>]*fallback=/,
    "DevBench 必须包在 Suspense 内（lazy chunk 需要）");
});

test("devbench 首次加载 Suspense fallback 必须占满并居中（h-full w-full flex items-center justify-center）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // fallback div 的 className 必须同时含 h-full + w-full + flex + items-center + justify-center，
  // 否则在 absolute inset-0 + display:flex 的容器内 fallback 会按内容收缩、贴在左上角而非居中。
  // 锚点：用「正在加载工程开发」唯一定位 devbench 专属 fallback（区别于 chat 的 fallback）。
  const m = src.match(/fallback=\{<div\s+className="([^"]+)">[\s\S]{0,40}?正在加载工程开发/);
  assert.ok(m, "必须能匹配到 devbench 首次加载 Suspense fallback");
  const cls = m[1];
  for (const c of ["h-full", "w-full", "flex", "items-center", "justify-center"]) {
    assert.match(cls, new RegExp(`\\b${c}\\b`),
      `devbench 首次加载 Suspense fallback 必须显式含 ${c}，保证「正在加载工程开发」提示在 main 内水平+垂直居中。当前 className: "${cls}"`);
  }
});

test("devbench 容器与 <Outlet /> 必须互斥（不重叠渲染）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // devbench 路由在 main.jsx 里 element={null}，所以 <Outlet /> 切到 /devbench 时实际不渲染内容；
  // App.jsx 必须仍然渲染 <Outlet />（承载其他 tab），devbench 容器用 absolute inset-0 覆盖。
  assert.match(src, /!isChatPage\s*&&\s*\(/,
    "<Outlet /> 仍要走非 chat 分支渲染");
  assert.match(src, /<Outlet\s*\/>/,
    "<Outlet /> 必须保留");
  // devbench 容器用 absolute inset-0，避免与 Outlet 容器 flex-1 冲突
  assert.match(src, /absolute\s+inset-0/,
    "devbench 容器必须用 absolute inset-0 与 Outlet 互斥");
});

test("<main> 必须包含 relative（让 devbench 容器 absolute inset-0 限定在 main 内，不覆盖侧栏）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // 侧栏是 <main> 的兄弟节点，devbench 容器 absolute inset-0 必须以 <main> 为 containing block，
  // 否则会相对视口定位，连带把侧栏一起覆盖。
  assert.match(src,
    /<main[^>]*\brelative\b/,
    "<main> 必须设 position: relative（Tailwind class 'relative'），否则 devbench 容器会盖住侧栏");
});

test("devbench 容器必须显式 z-0（让 main 内的更新/断连横幅不被压在 devbench 标题栏后）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // devbench 容器 absolute inset-0 默认 z-auto，与 main flex 子项同层级，
  // 后渲染者胜 → devbench 容器盖住更新/断连横幅，让「重试连接/重新配置/一键更新」等按钮看不见。
  // 显式 z-0 配合横幅的 z-[60]，明确分层。
  assert.match(src,
    /absolute\s+inset-0\s+z-0/,
    "devbench 容器必须同时含 absolute inset-0 与 z-0（明确把自身压在 main flex 流子项之下）");
});

test("devbench keep-alive 容器 inline style display 不能是纯 flex（默认 row 主轴会让 DevBench 顶层宽度按内容收缩、主区视觉跳变）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // 锁定 keep-alive 容器（absolute inset-0 的 div）
  const m = src.match(/<div\s+className="[^"]*\babsolute\s+inset-0\b[^"]*"\s+style=\{\{([^}]+)\}\}/);
  assert.ok(m, "必须能找到 devbench keep-alive 容器 (absolute inset-0 + style)");
  const style = m[1];
  // 两种合规状态：(a) display: "block"（推荐，absolute inset-0 + block 子项默认 width:100% 父），
  //               (b) display: "flex" 配 flexDirection: column（cross axis stretch 撑满横向）。
  // 禁止纯 "flex"（默认 row 主轴 → DevBench 顶层 width:auto 按内容收缩）。
  const isBlock = /display:\s*isDevbenchPage\s*\?\s*["']block["']/.test(style);
  const isFlexCol = /display:\s*isDevbenchPage\s*\?\s*["']flex["']/.test(style)
    && /flexDirection:\s*["']column["']/.test(style);
  assert.ok(isBlock || isFlexCol,
    "devbench keep-alive 容器 inline style display 必须为 'block'，或 'flex' 配 flexDirection: column；不能用纯 'flex'（默认 row 主轴让 DevBench 顶层宽度按内容收缩，主区 '先没占满、后占满' 视觉跳变）。当前 style: " + style.trim());
});

test("三个 main 横幅（桌面更新 / 版本更新 / 网关断连）必须 absolute top-0 + z-[60]（不遮挡下方视图且不被 devbench 容器盖住）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // 三个横幅 className 字符串本体相同，但背景色不同，可作为唯一锚点。
  // 要求：div className 内同时含 absolute + top-0 + left-0 + right-0 + z-[60] + 对应背景色。
  //   - absolute top-0 left-0 right-0：脱离文档流浮在 main 顶部（main 有 relative），不挤压下方 devbench/chat/页面视图
  //   - z-[60]：高于 devbench keep-alive 容器（z-0），不被压住
  const bannerColors = [
    { color: "bg-purple-600/15", label: "桌面版更新横幅" },
    { color: "bg-blue-600/15", label: "版本更新横幅" },
    { color: "bg-red-600/15", label: "网关断连横幅" },
  ];
  for (const { color, label } of bannerColors) {
    // 必须整个 className 在同一个 div 内。
    // 锁定 className 内容，避免 <div[^>]* 贪婪回溯陷阱。
    // 注意：z-[60] 后是空格，] 和空格都是 non-word，\b 无法匹配——所以 z-[60] 不能用 \b 边界。
    let re;
    if (color === "bg-purple-600/15") {
      re = /className="[^"]*absolute[^"]*top-0[^"]*left-0[^"]*right-0[^"]*z-\[60\][^"]*bg-purple-600\/15[^"]*"/;
    } else if (color === "bg-blue-600/15") {
      re = /className="[^"]*absolute[^"]*top-0[^"]*left-0[^"]*right-0[^"]*z-\[60\][^"]*bg-blue-600\/15[^"]*"/;
    } else if (color === "bg-red-600/15") {
      re = /className="[^"]*absolute[^"]*top-0[^"]*left-0[^"]*right-0[^"]*z-\[60\][^"]*bg-red-600\/15[^"]*"/;
    } else {
      throw new Error(`unexpected color: ${color}`);
    }
    assert.match(src, re,
      `${label}（${color}）必须在同一 div 内同时含 absolute top-0 left-0 right-0 z-[60] 对应背景色（脱离文档流不挤压视图、且不被 devbench 容器 z-0 盖住）`);
  }
});
