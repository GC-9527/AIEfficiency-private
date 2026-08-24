import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runtimeSync from "../../service-control-electron/api-engine-sync-runtime.cjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "service-control-electron", "scripts", "sync-api-engines.cjs");
const TMP_ROOT = path.join(REPO_ROOT, "gateway", ".tmp");
const { syncApiEnginesToGateway } = runtimeSync;

function prepareConfig(root, config) {
  const gatewayDir = path.join(root, "gateway");
  fs.mkdirSync(gatewayDir, { recursive: true });
  fs.writeFileSync(path.join(gatewayDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
}

function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "gateway", "config.json"), "utf8"));
}

function runSync(sourceRoot, targetRoot) {
  const stdout = execFileSync(process.execPath, [SCRIPT, sourceRoot, targetRoot], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout.trim());
}

test("API 引擎增量合并：source 覆盖同名引擎字段（含 apiKey），target 独有引擎保留，自定义引擎新增，defaultEngine 与其他字段不动", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(TMP_ROOT, "api-engines-merge-"));
  const sourceRoot = path.join(work, "source");
  const targetRoot = path.join(work, "target");
  try {
    prepareConfig(sourceRoot, {
      apiEngines: {
        qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "source-qwen-key", model: "qwen-max" },
        myeng: { baseUrl: "https://my.example.com/v1", apiKey: "my-key", model: "my-model" },
      },
      defaultEngine: "qwen",
    });
    prepareConfig(targetRoot, {
      apiEngines: {
        qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "old-qwen-key", model: "qwen-old" },
        kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "kimi-key", model: "moonshot-v1" },
      },
      defaultEngine: "kimi",
      persona: "keep-me",
      teambition: { userCookie: "cookie-val" },
    });

    const result = runSync(sourceRoot, targetRoot);
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);   // myeng 新增
    assert.equal(result.updated, 1); // qwen 字段被覆盖
    assert.equal(result.removed, 0);

    const target = readConfig(targetRoot);
    // qwen 被 source 覆盖（含 apiKey）
    assert.equal(target.apiEngines.qwen.apiKey, "source-qwen-key");
    assert.equal(target.apiEngines.qwen.model, "qwen-max");
    assert.equal(target.apiEngines.qwen.builtin, true);
    // kimi 保留，apiKey 不变
    assert.equal(target.apiEngines.kimi.apiKey, "kimi-key");
    // myeng 新增并标记为自定义
    assert.equal(target.apiEngines.myeng.apiKey, "my-key");
    assert.equal(target.apiEngines.myeng.custom, true);
    // defaultEngine 不同步（保持 target 原值）
    assert.equal(target.defaultEngine, "kimi");
    // 其他字段保留
    assert.equal(target.persona, "keep-me");
    assert.equal(target.teambition.userCookie, "cookie-val");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("API 引擎 _delete：source 标记删除的自定义引擎在 target 被删，内置引擎标记删除无效且不覆盖", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(TMP_ROOT, "api-engines-delete-"));
  const sourceRoot = path.join(work, "source");
  const targetRoot = path.join(work, "target");
  try {
    prepareConfig(sourceRoot, {
      apiEngines: {
        myeng: { _delete: true },
        qwen: { _delete: true, apiKey: "should-not-apply" }, // 内置引擎 _delete 无效
      },
    });
    prepareConfig(targetRoot, {
      apiEngines: {
        myeng: { baseUrl: "https://my.example.com/v1", apiKey: "my-key", model: "my-model" },
        qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "qwen-key", model: "qwen" },
        kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "kimi-key", model: "moonshot-v1" },
      },
    });

    const result = runSync(sourceRoot, targetRoot);
    assert.equal(result.ok, true);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.removed, 1); // myeng 被删

    const target = readConfig(targetRoot);
    assert.equal(target.apiEngines.myeng, undefined); // 自定义引擎被删
    assert.notEqual(target.apiEngines.qwen, undefined); // 内置引擎保留
    assert.equal(target.apiEngines.qwen.apiKey, "qwen-key"); // 未被 source 的 _delete 版本覆盖
    assert.equal(target.apiEngines.kimi.apiKey, "kimi-key"); // 保留
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("API 引擎同步幂等：第二次执行无变化且不改变目标文件内容", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(TMP_ROOT, "api-engines-idempotent-"));
  const sourceRoot = path.join(work, "source");
  const targetRoot = path.join(work, "target");
  try {
    prepareConfig(sourceRoot, {
      apiEngines: {
        qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "qwen-key", model: "qwen-max" },
      },
    });
    prepareConfig(targetRoot, {
      apiEngines: {
        kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "kimi-key", model: "moonshot-v1" },
      },
    });

    const first = runSync(sourceRoot, targetRoot);
    assert.equal(first.ok, true);
    assert.equal(first.added, 1);
    const afterFirst = readConfig(targetRoot);

    const second = runSync(sourceRoot, targetRoot);
    assert.equal(second.ok, true);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.removed, 0);

    const afterSecond = readConfig(targetRoot);
    assert.deepEqual(afterSecond, afterFirst);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("API 引擎同步：source 无 apiEngines 时跳过且不写目标文件", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(TMP_ROOT, "api-engines-skip-"));
  const sourceRoot = path.join(work, "source");
  const targetRoot = path.join(work, "target");
  try {
    prepareConfig(sourceRoot, { defaultEngine: "qwen" }); // 无 apiEngines
    prepareConfig(targetRoot, {
      apiEngines: { kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "kimi-key", model: "moonshot-v1" } },
    });
    const before = readConfig(targetRoot);

    const result = runSync(sourceRoot, targetRoot);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.deepEqual(readConfig(targetRoot), before);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("运行中的目标 Gateway 接收 API engines 后必须通过 /api/config 读回验证", async (t) => {
  let targetEngines = {
    volcengine: {
      enabled: false,
      name: "火山方舟",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      apiKey: "",
      model: "ark-code-latest",
    },
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PUT" && req.url === "/api/config") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const incoming = JSON.parse(body).apiEngines || {};
        targetEngines = { ...targetEngines, ...incoming };
        res.end(JSON.stringify({ success: true, data: { apiEngines: targetEngines } }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/config") {
      const masked = Object.fromEntries(Object.entries(targetEngines).map(([id, engine]) => [
        id,
        { ...engine, apiKey: engine.apiKey ? "********" : "" },
      ]));
      res.end(JSON.stringify({ success: true, data: { apiEngines: masked } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const source = {
    volcengine: {
      enabled: true,
      name: "火山方舟",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      apiKey: "source-secret",
      model: "ark-code-latest",
    },
  };
  const address = server.address();
  const result = await syncApiEnginesToGateway(`http://127.0.0.1:${address.port}`, source);

  assert.deepEqual(result, { ok: true, pushed: true, verified: true });
  assert.equal(targetEngines.volcengine.enabled, true);
  assert.equal(targetEngines.volcengine.apiKey, "source-secret");
});
