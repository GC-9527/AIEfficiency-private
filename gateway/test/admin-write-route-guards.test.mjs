import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = join(here, "..", "routes");
const guardedRoutes = [
  "aiautowork.js",
  "backup.js",
  "cardev.js",
  "devices.js",
  "skills.js",
];

test("敏感写路由默认复用 admin-auth，且只读 HTTP 方法保持原语义", () => {
  for (const file of guardedRoutes) {
    const source = readFileSync(join(routesDir, file), "utf8");
    assert.match(
      source,
      /import\s*\{\s*requireAdmin\s*\}\s*from\s*["']\.\.\/services\/admin-auth\.js["']\s*;/,
      `${file} 必须复用统一管理员认证服务`,
    );
    assert.match(
      source,
      /\["GET",\s*"HEAD",\s*"OPTIONS"\]\.includes\(req\.method\)/,
      `${file} 必须明确保留只读及预检方法`,
    );
    assert.match(
      source,
      /return\s+requireAdmin\(req,\s*res,\s*next\)/,
      `${file} 的写请求必须进入统一管理员认证`,
    );
  }
});

test("CarDev 仅允许本机可信页面免登录进入工程模式", () => {
  const source = readFileSync(join(routesDir, "cardev.js"), "utf8");
  const trustedPluginGuard = "^\\/devices\\/engineering-mode\\/[a-z0-9-]+$";
  assert.ok(source.includes(trustedPluginGuard));
  assert.match(source, /isTrustedPerformanceResourceRequest\(req\)/);
  assert.match(source, /code: "CARDEV_ENGINEERING_MODE_LOCAL_ONLY"/);
  assert.equal(
    source.split(trustedPluginGuard).length - 1,
    1,
    "免管理员路径必须只有厂商工程模式插件入口一个",
  );
});

test("TB 普通用户扫码是公开能力，手工 Cookie 与其它写操作仍走管理员门禁", () => {
  const source = readFileSync(join(routesDir, "tb-tasks.js"), "utf8");
  assert.match(source, /import \{ tbTasksWriteRequiresAdmin \} from "\.\.\/services\/tb-user-access-policy\.js"/);
  assert.match(source, /tbTasksWriteRequiresAdmin\(req\.method,\s*req\.path\)/);
  assert.match(source, /return\s+requireAdmin\(req,\s*res,\s*next\)/);
  assert.match(source, /router\.post\("\/cookie-verify-save"/);
  assert.match(source, /cancelTbLoginChallenge\(req\.body\?\.loginChallenge\)/);
});
