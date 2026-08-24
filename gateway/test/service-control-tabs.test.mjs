import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const renderer = fs.readFileSync(path.join(repoRoot, "service-control-electron", "renderer", "renderer.js"), "utf8");
const styles = fs.readFileSync(path.join(repoRoot, "service-control-electron", "renderer", "styles.css"), "utf8");
const main = fs.readFileSync(path.join(repoRoot, "service-control-electron", "main.js"), "utf8");

test("每个 Development Tab 都带有独立删除按钮", () => {
  assert.match(renderer, /if \(isDevelopmentProfileId\(id\)\)/);
  assert.match(renderer, /removeButton\.className = "envTabRemove"/);
  assert.match(renderer, /removeButton\.dataset\.removeProfile = id/);
  assert.match(renderer, /removeDevelopmentTab\(id\)/);
  assert.match(styles, /\.envSwitch \.envTabRemove\s*\{/);
});

test("Tab 删除入口复用确认流程且删除当前 Tab 后切换到默认环境", () => {
  assert.match(renderer, /confirm\(`Remove \$\{label\} from Service Control\?`\)/);
  assert.match(renderer, /window\.serviceControl\.removeDevelopment\(id\)/);
  assert.match(renderer, /previousActiveProfileId === id[\s\S]*normalizeProfileId\(result\?\.defaultProfile\)/);
  assert.match(renderer, /event\.stopPropagation\(\)/);
});

test("主 Development 可删除，但运行中的开发环境仍由前后端共同禁止删除", () => {
  assert.doesNotMatch(renderer, /!isDevelopmentProfileId\(id\) \|\| id === "development"/);
  assert.match(renderer, /status !== "running"/);
  assert.match(main, /label: "Remove Development Environment",\s*enabled: !busy && !running/);
  assert.doesNotMatch(main, /enabled: id !== PRIMARY_DEVELOPMENT_PROFILE_ID && !busy && !running/);
  assert.match(main, /if \(!isDevelopmentProfileId\(id\)\) throw new Error\("Only development environments can be removed\."\)/);
  assert.match(main, /current\.status === "running"[\s\S]*Stop this development environment before removing it/);
});

test("Production 不显示删除入口但仍可通过 Choose 重新选择目录", () => {
  assert.match(renderer, /if \(isDevelopmentProfileId\(id\)\) \{/);
  assert.match(renderer, /window\.serviceControl\.chooseRepo\(activeProfileId\)/);
  assert.match(main, /if \(!isDevelopmentProfileId\(id\)\) throw new Error\("Only development environments can be removed\."\)/);
  assert.match(main, /if \(id === "production" && patch\.repoRoot\) next\.repoRoot = patch\.repoRoot/);
});
