import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(dir = sourceRoot) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(path));
    else if ([".js", ".jsx", ".mjs"].includes(extname(entry.name)) && !entry.name.includes(".test.")) result.push(path);
  }
  return result;
}

function relativeName(path) {
  return relative(sourceRoot, path).replaceAll("\\", "/");
}

test("站内 /admin 导航禁止原生 anchor，避免整页刷新", () => {
  const offenders = sourceFiles().filter((path) =>
    /<a\b[^>]*\bhref\s*=\s*["']\/admin["']/i.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(offenders.map(relativeName), []);
});

test("管理员身份接口只能由唯一 session store 消费", () => {
  const endpoint = ["/api/admin/auth", "me"].join("/");
  const consumers = sourceFiles().filter((path) => readFileSync(path, "utf8").includes(endpoint));
  assert.deepEqual(consumers.map(relativeName), ["services/adminAuth.js"]);
});

test("Teambition 普通管理员入口只能消费当前扫码的一次性 challenge", () => {
  const endpoint = ["/api/admin/auth", "tb-login"].join("/");
  const consumers = sourceFiles().filter((path) => readFileSync(path, "utf8").includes(endpoint));
  assert.deepEqual(consumers.map(relativeName), ["pages/AdminPlatform.jsx"]);
  const source = readFileSync(consumers[0], "utf8");
  assert.match(source, /loginAdmin\(\s*\{ loginChallenge: challenge \}/);
  assert.doesNotMatch(source, /getTbMe|userCookie/);
});

test("管理控制台不再用固定轮询刷新管理员列表", () => {
  const source = readFileSync(new URL("../pages/AdminPlatform.jsx", import.meta.url), "utf8");
  const consoleSource = source.slice(source.indexOf("function AdminConsole"), source.indexOf("function safeName"));
  assert.equal(consoleSource.includes("setInterval("), false);
});

test("验证器入口不把查看现有密钥误说成首次使用或重新绑定", () => {
  const source = readFileSync(new URL("../pages/AdminPlatform.jsx", import.meta.url), "utf8");
  assert.match(source, /查看验证器绑定信息/);
  assert.doesNotMatch(source, /首次使用 \/ 重新绑定验证器/);
  assert.match(source, /继续绑定使用现有密钥/);
});
