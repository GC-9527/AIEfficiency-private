import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsSource = fs.readFileSync(path.join(pagesDir, "Settings.jsx"), "utf8");
const mainSource = fs.readFileSync(path.resolve(pagesDir, "..", "main.jsx"), "utf8");
const appSource = fs.readFileSync(path.resolve(pagesDir, "..", "App.jsx"), "utf8");

test("打开设置页不会自动启动 CLI 引擎检测", () => {
  assert.doesNotMatch(settingsSource, /\/api\/config\/engine-status/,
    "引擎状态检测可能启动多个 CLI 甚至模型调用，只能由点击检测触发");
  assert.match(settingsSource, /onClick=\{\(\) => checkEngine\(eng\)\}/,
    "必须保留用户主动检测单个引擎的入口");
});

test("设置页昂贵的备份环境探测只在面板接近可视区后挂载", () => {
  assert.match(settingsSource,
    /<DeferredSettingsPanel[\s\S]*?<BackupMigratePanel\s*\/>[\s\S]*?<\/DeferredSettingsPanel>/,
    "备份面板不得在设置页首屏挂载时立即运行环境进程探测");
  assert.match(settingsSource, /function DeferredSettingsPanel\(/);
  assert.match(settingsSource, /<Section title="AI 模式配置（局域网共享）" defer/);
  assert.match(settingsSource, /<Section title="AI 模型（OpenAI 兼容）" defer/);
  assert.match(settingsSource, /<Section title="工作报告" defer/);
  assert.match(settingsSource, /<DeferredSettingsPanel>[\s\S]*?<CodeupSettingsPanel/);
});

test("开发态 StrictMode 不重复启动 Settings 首次只读加载", () => {
  assert.match(settingsSource, /const initialLoadStartedRef = useRef\(false\)/);
  assert.match(settingsSource, /if \(initialLoadStartedRef\.current\) return/);
  assert.match(settingsSource, /initialLoadStartedRef\.current = true/);
});

test("网关地址输入状态隔离在首屏小组件中", () => {
  assert.match(settingsSource, /function GatewayConnectionSection\(/);
  assert.match(settingsSource, /<GatewayConnectionSection onSaved=/);
  const settingsBody = settingsSource.slice(
    settingsSource.indexOf("export default function Settings()"),
    settingsSource.indexOf("function GatewayConnectionSection("),
  );
  assert.doesNotMatch(settingsBody, /const \[gatewayUrl, setGatewayUrlState\]/,
    "输入网关地址不应让整个超大 Settings 组件逐键重渲染");
});

test("管理后台仅在侧栏表达访问意图时预取", () => {
  assert.doesNotMatch(mainSource, /requestIdleCallback[\s\S]{0,240}preloadAdminPlatform/,
    "任意路由空闲时预取管理后台会与当前页面争抢解析和主线程时间");
  assert.doesNotMatch(mainSource, /setTimeout[\s\S]{0,180}preloadAdminPlatform/);
  assert.match(appSource, /onMouseEnter=\{item\.path === "\/admin"[\s\S]*?import\("\.\/pages\/AdminPlatform\.jsx"\)/);
  assert.match(appSource, /onFocus=\{item\.path === "\/admin"[\s\S]*?import\("\.\/pages\/AdminPlatform\.jsx"\)/);
});
