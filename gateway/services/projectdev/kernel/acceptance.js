/**
 * 外部验收检查器 —— 不信 AI 自报，跑真实检查判定里程碑是否达成。
 *
 * 无业务依赖：检查项由 spec 提供。支持四类（对照 autorunv2 的 acceptance）：
 *   - file_exists : { type, path }                      文件/目录存在
 *   - cmd         : { type, cmd, timeoutSec?, expectRc? } 跑命令，退出码==expectRc(默认0) 即过
 *   - grep_count  : { type, pattern, path, min?, max? }  正则在文件/目录中命中次数落在 [min,max]
 *   - json_schema : { type, path, schema }               目标 JSON 满足 schema（极简校验：required/type）
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const HEAD_TAIL = 1500; // 失败输出只留头尾，避免塞爆上下文

function clip(s) {
  s = String(s || "");
  if (s.length <= HEAD_TAIL * 2) return s;
  return s.slice(0, HEAD_TAIL) + "\n…(略)…\n" + s.slice(-HEAD_TAIL);
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      let names = []; try { names = readdirSync(p); } catch { continue; }
      for (const n of names) {
        if (n === "node_modules" || n === ".git" || n === "build" || n === "dist") continue;
        stack.push(path.join(p, n));
      }
    } else if (st.isFile()) out.push(p);
  }
  return out;
}

/** 单条检查 → { ok, output }。 */
export function checkOne(check, projectDir) {
  const type = check.type;
  try {
    if (type === "file_exists") {
      const abs = path.resolve(projectDir, check.path);
      return { ok: existsSync(abs), output: existsSync(abs) ? `存在: ${check.path}` : `缺失: ${check.path}` };
    }

    if (type === "cmd") {
      const r = spawnSync(check.cmd, {
        cwd: projectDir, shell: true, encoding: "utf8",
        timeout: (check.timeoutSec || 600) * 1000, maxBuffer: 32 * 1024 * 1024,
      });
      const expect = check.expectRc ?? 0;
      const rc = r.status == null ? -1 : r.status;
      const ok = rc === expect && !r.error;
      const out = `$ ${check.cmd}\n[rc=${rc}${r.error ? " err=" + r.error.message : ""}]\n${clip((r.stdout || "") + (r.stderr || ""))}`;
      return { ok, output: out };
    }

    if (type === "grep_count") {
      const abs = path.resolve(projectDir, check.path);
      if (!existsSync(abs)) return { ok: false, output: `路径不存在: ${check.path}` };
      const files = statSync(abs).isDirectory() ? walkFiles(abs) : [abs];
      const re = new RegExp(check.pattern, "gm");
      let count = 0;
      for (const f of files) {
        let txt = ""; try { txt = readFileSync(f, "utf8"); } catch { continue; }
        const m = txt.match(re);
        if (m) count += m.length;
      }
      const min = check.min ?? 1, max = check.max ?? Infinity;
      const ok = count >= min && count <= max;
      return { ok, output: `命中 ${count} 次（要求 ${min}~${max === Infinity ? "∞" : max}）/${check.pattern}/` };
    }

    if (type === "json_schema") {
      const abs = path.resolve(projectDir, check.path);
      if (!existsSync(abs)) return { ok: false, output: `JSON 不存在: ${check.path}` };
      let data; try { data = JSON.parse(readFileSync(abs, "utf8")); } catch (e) { return { ok: false, output: `JSON 解析失败: ${e.message}` }; }
      let schema = check.schema;
      if (typeof schema === "string") {
        const sAbs = path.resolve(projectDir, schema);
        if (!existsSync(sAbs)) return { ok: false, output: `schema 不存在: ${schema}` };
        try { schema = JSON.parse(readFileSync(sAbs, "utf8")); } catch (e) { return { ok: false, output: `schema 解析失败: ${e.message}` }; }
      }
      const errs = validateSchema(data, schema, "$");
      return { ok: errs.length === 0, output: errs.length ? "schema 不符:\n" + errs.join("\n") : "schema 通过" };
    }

    return { ok: false, output: `未知验收类型: ${type}` };
  } catch (e) {
    return { ok: false, output: `验收执行异常: ${e.message}` };
  }
}

/** 全部检查 → { pass, results:[{check,ok,output}], failures:[...] }。 */
export function checkAll(checks, projectDir) {
  const results = (checks || []).map((c) => ({ check: c, ...checkOne(c, projectDir) }));
  const failures = results.filter((r) => !r.ok);
  return { pass: failures.length === 0, results, failures };
}

/** 极简 JSON Schema 校验：覆盖 type / required / properties / items（够验收用，不引第三方）。 */
function validateSchema(data, schema, p) {
  const errs = [];
  if (!schema || typeof schema !== "object") return errs;
  const t = schema.type;
  const typeOf = (v) => Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    const actual = typeOf(data);
    const norm = actual === "number" && types.includes("integer") && Number.isInteger(data) ? "integer" : actual;
    if (!types.includes(norm)) { errs.push(`${p}: 期望 ${types.join("|")}，实际 ${actual}`); return errs; }
  }
  if (Array.isArray(schema.required) && typeOf(data) === "object") {
    for (const k of schema.required) if (!(k in data)) errs.push(`${p}.${k}: 缺失必填`);
  }
  if (schema.properties && typeOf(data) === "object") {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in data) errs.push(...validateSchema(data[k], sub, `${p}.${k}`));
    }
  }
  if (schema.items && Array.isArray(data)) {
    data.forEach((it, i) => errs.push(...validateSchema(it, schema.items, `${p}[${i}]`)));
  }
  return errs;
}
