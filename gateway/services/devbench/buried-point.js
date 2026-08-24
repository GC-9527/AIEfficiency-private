/**
 * devbench 第三步·自我验收 —— 埋点数据库查询（可配置、可插拔）
 *
 * 「测埋点需到对应环境的数据库查到才算通过」。由于各团队埋点库类型/接入各异，这里只做**框架**：
 * 连接信息按环境配在 gateway 本地文件 `gateway/buried-point-db.json`（不进 git，含凭据），
 * 支持三种 mode：
 *   - sqlite : 用 better-sqlite3 直接查本地/网络 sqlite 文件
 *   - shell  : 跑团队自带 DB CLI（mysql/psql/clickhouse-client/mongosh…），命令模板里 {{QUERY}} 占位
 *   - http   : POST/GET 到团队的查询 HTTP 接口（{{QUERY}} 可插到 url/headers/body）
 * 查到行数 > 0（http 可按 rowsPath 取数组）即视为「埋点已落库」。无配置时优雅降级（listEnvs 返回 []）。
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

const CONFIG_PATH = fileURLToPath(new URL("../../buried-point-db.json", import.meta.url));

export function loadBpConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return { environments: {} };
    const j = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return j && typeof j === "object" && j.environments ? j : { environments: j || {} };
  } catch {
    return { environments: {} };
  }
}

// 已配置的环境名（仅名字，不含凭据；供 prompt 注入）
export function listEnvs() {
  return Object.keys(loadBpConfig().environments || {});
}

// 环境描述（不含凭据：name/mode/table/note），供验收规则注入，帮 Agent 写对 SQL
export function describeEnvs() {
  const envs = loadBpConfig().environments || {};
  return Object.entries(envs).map(([name, e]) => ({ name, mode: e?.mode || "", table: e?.table || "", note: e?.note || "" }));
}

// 按 a.b.c 路径取值
function pick(obj, dotPath) {
  if (!dotPath) return obj;
  return String(dotPath).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

// 在某环境执行查询，返回 { ok, count, rows, raw, error }
export async function queryEnv(envName, query) {
  const cfg = loadBpConfig();
  const env = cfg.environments?.[envName];
  if (!env) return { ok: false, error: `未配置埋点环境「${envName}」（请在 gateway/buried-point-db.json 配置）` };
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "查询为空" };
  try {
    if (env.mode === "sqlite") {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(env.file, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(q).all();
        return { ok: true, count: rows.length, rows, raw: JSON.stringify(rows).slice(0, 4000) };
      } finally { db.close(); }
    }
    if (env.mode === "mysql") {
      // 用本机 Python+pymysql 跑只读查询（免 node 驱动）。SQL 经 stdin 传，避免引号转义。
      const helper = fileURLToPath(new URL("./bp-mysql.py", import.meta.url));
      const conn = { host: env.host, port: env.port || 3306, user: env.user, password: env.password, database: env.database, charset: env.charset || "utf8mb4", connectTimeout: env.connectTimeout || 8 };
      const r = spawnSync(env.python || "python", [helper], { input: JSON.stringify(conn) + "\n" + q, encoding: "utf8", timeout: env.timeoutMs || 30000, maxBuffer: 32 * 1024 * 1024 });
      if (r.error) return { ok: false, error: String(r.error.message || r.error) };
      const out = (r.stdout || "").trim();
      let parsed = null; try { parsed = JSON.parse(out.split(/\r?\n/).pop() || "{}"); } catch {}
      if (parsed?.error) return { ok: false, error: parsed.error, raw: (r.stderr || out).slice(0, 4000) };
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      return { ok: r.status === 0, count: parsed?.count ?? rows.length, rows, raw: out.slice(0, 4000), exitCode: r.status };
    }
    if (env.mode === "shell") {
      const cmd = String(env.command || "").replace(/\{\{QUERY\}\}/g, q);
      if (!cmd) return { ok: false, error: "shell 环境缺少 command 模板" };
      const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: env.timeoutMs || 30000, maxBuffer: 16 * 1024 * 1024 });
      if (r.error) return { ok: false, error: String(r.error.message || r.error) };
      const out = (r.stdout || "").trim();
      const lines = out ? out.split(/\r?\n/).filter((l) => l.trim()) : [];
      return { ok: r.status === 0, count: lines.length, rows: lines, raw: (out + (r.stderr ? "\n[stderr] " + r.stderr : "")).slice(0, 4000), exitCode: r.status };
    }
    if (env.mode === "http") {
      const url = String(env.url || "").replace(/\{\{QUERY\}\}/g, encodeURIComponent(q));
      const method = (env.method || "POST").toUpperCase();
      const headers = JSON.parse(JSON.stringify(env.headers || {}));
      for (const k of Object.keys(headers)) headers[k] = String(headers[k]).replace(/\{\{QUERY\}\}/g, q);
      const init = { method, headers };
      if (method !== "GET" && env.bodyTemplate != null) {
        init.body = typeof env.bodyTemplate === "string"
          ? env.bodyTemplate.replace(/\{\{QUERY\}\}/g, q.replace(/"/g, '\\"'))
          : JSON.stringify(env.bodyTemplate).replace(/\{\{QUERY\}\}/g, q.replace(/"/g, '\\"'));
        if (!headers["Content-Type"] && !headers["content-type"]) init.headers["Content-Type"] = "application/json";
      }
      const resp = await fetch(url, init);
      const text = await resp.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      let rows = json != null ? pick(json, env.rowsPath) : null;
      if (!Array.isArray(rows)) rows = rows != null ? [rows] : (text ? [text] : []);
      const count = Array.isArray(rows) ? rows.filter((x) => x != null && x !== "").length : 0;
      return { ok: resp.ok, count, rows, raw: text.slice(0, 4000), status: resp.status };
    }
    return { ok: false, error: `不支持的 mode「${env.mode}」（应为 sqlite/shell/http）` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
