import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 首页默认进工程开发，不加载 chat。
// 实施：main.jsx 的 index 路由 Navigate 的 to 必须指向 /devbench。

test("main.jsx 的 index 路由默认跳转目标必须是 /devbench", () => {
  const src = fs.readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  // 必须有 index 路由，且 Navigate to 必须是 /devbench
  assert.match(src, /<Route\s+index\s+element=\{<Navigate\s+to=["']\/devbench["']\s+replace\s*\/>/,
    "默认路由必须 Navigate 到 /devbench，避免首屏先显示 chat");
});

test("chat 路由仍保持 element=null 的 keep-alive 模式", () => {
  const src = fs.readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  // chat 路由必须保留 element=null 形式（不在 Outlet 实例化）
  assert.match(src, /<Route\s+path="chat"\s+element=\{null\}\s*\/>/,
    "/chat 路由必须保留 element=null 模式，由 App.jsx 走 keep-alive 挂载（不卸载 React state）");
});

test("chat 不再是默认跳转目标", () => {
  const src = fs.readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  // 不允许出现 Navigate to="/chat"（之前的形式）
  assert.doesNotMatch(src, /Navigate\s+to=["']\/chat["']/,
    "index 路由不得跳到 /chat（否则会绕过 devbench 默认行为）");
});

test("App.jsx 必须保持 isDevbenchPage 严格匹配 /devbench（确保 Navigate 后激活）", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.match(src, /const\s+isDevbenchPage\s*=\s*location\.pathname\s*===\s*["']\/devbench["']/,
    "App.jsx 必须有 isDevbenchPage 派生值，让 <Navigate to=/devbench> 后触发 devbenchVisited=true");
});