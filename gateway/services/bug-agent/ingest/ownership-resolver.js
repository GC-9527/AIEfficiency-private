/**
 * 证据归属解析器（方案 §5.5，v3.3 核心修复）
 *
 * 职责：判定 evidence 片段"属于哪个 package"，用于：
 *   - §3.4 决策表三门控的 Gate 3 (package_owned)
 *   - §5 STEP 6b 重排公式 f4 归属纯度
 *
 * 输入是**整份**原始素材（logcat/anr/dumpsys/systrace/screenshot），输出是
 * 一个或多个带 owner_package + ownership_confidence 的 evidence span 列表。
 */

const TAG_LINE = /^(?:\d{2}-\d{2}\s+)?(?:\d{2}:\d{2}:\d{2}\.\d{3}\s+)?(\d+)\s+(\d+)\s+([EWVID])\s+([A-Za-z_][\w.-]*)\s*:/;
const START_PROC = /Start proc\s+(\d+):([a-zA-Z_][\w.]*)(?:\/[\w.]+)?\s/;
const FATAL_PROC = /FATAL EXCEPTION[\s\S]{0,200}?Process:\s*([a-zA-Z_][\w.]*)/;
const ANR_IN = /\bANR\s+in\s+([a-zA-Z_][\w.]*)/;
const ANR_HEADER_PID = /----- pid\s+(\d+) at /;
const ANR_CMDLINE = /Cmd\s*line:\s*([a-zA-Z_][\w.]*)/;
const DUMPSYS_SECTION = /^DUMP OF SERVICE\s+([A-Za-z_][\w.-]*)(?:\s+\[([^\]]+)\])?/m;
const SYSTRACE_TGID = /^#\s*tgid\s*=\s*(\d+)\s*(?:comm\s*=\s*([a-zA-Z_][\w.]*))?/m;

/**
 * 归属解析入口，按 source_type 分派。
 *
 * @param {Object} input
 * @param {string} input.source_type - logcat / anr_trace / dumpsys / systrace / screenshot / tb_content
 * @param {string} input.content - 整份原始文本（screenshot 除外）
 * @param {string} input.case_package - 当前 case 的 package_name（用于 tb_content / screenshot 归属默认值）
 * @returns {Array<{owner_package: string, ownership_confidence: number, text_snapshot: string, line_start?: number, line_end?: number, tag?: string}>}
 */
export function resolveOwnership({ source_type, content, case_package }) {
  if (source_type === "tb_content") {
    return [{
      owner_package: case_package,
      ownership_confidence: 1.0,
      text_snapshot: content,
      tag: "tb_body",
    }];
  }
  if (source_type === "screenshot") {
    return [{
      owner_package: case_package,
      ownership_confidence: 0.8,
      text_snapshot: "", // 截图不入 FTS
      tag: "screenshot",
    }];
  }
  if (source_type === "logcat") return resolveLogcat(content);
  if (source_type === "anr_trace") return resolveAnrTrace(content);
  if (source_type === "dumpsys") return resolveDumpsys(content);
  if (source_type === "systrace") return resolveSystrace(content);

  // 未知类型 → 整份归 unknown
  return [{
    owner_package: "unknown",
    ownership_confidence: 0.3,
    text_snapshot: content,
    tag: source_type,
  }];
}

// ---------- logcat ----------

/**
 * logcat 解析：
 *   1. 预扫 `Start proc <pid>:<pkg>/...` 建立 pid→pkg 映射
 *   2. 按行扫描，根据 pid 或 Process 字段归属
 *   3. 按 owner_package 变化切分为多条 span（同一 owner 的相邻行合并）
 */
export function resolveLogcat(content) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const pidToPkg = new Map();

  // 预扫
  for (const line of lines) {
    const m = line.match(START_PROC);
    if (m) pidToPkg.set(m[1], m[2]);
  }

  // 预扫 FATAL EXCEPTION 块中的 Process 字段（可能早于 Start proc 出现）
  const fatalBlockPkg = (() => {
    const m = content.match(FATAL_PROC);
    return m ? m[1] : null;
  })();

  const spans = [];
  let cur = null;
  let curStart = 0;

  function flush(endIdx) {
    if (cur) {
      cur.line_end = endIdx;
      cur.text_snapshot = lines.slice(cur.line_start - 1, endIdx).join("\n");
      spans.push(cur);
    }
    cur = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let owner = null;
    let conf = 0.3;

    // 优先级 1：ANR in <pkg>
    const anrM = line.match(ANR_IN);
    if (anrM) { owner = anrM[1]; conf = 1.0; }

    // 优先级 2：tag line 中 pid 归属
    if (!owner) {
      const tm = line.match(TAG_LINE);
      if (tm) {
        const pid = tm[1];
        if (pidToPkg.has(pid)) { owner = pidToPkg.get(pid); conf = 1.0; }
      }
    }

    // 优先级 3：FATAL 块
    if (!owner && fatalBlockPkg && /FATAL EXCEPTION|Process:|at\s+/.test(line)) {
      owner = fatalBlockPkg; conf = 0.9;
    }

    // 优先级 4：tag 前缀猜测（弱）
    if (!owner) {
      const tm = line.match(TAG_LINE);
      if (tm && /^[a-zA-Z_][\w.-]*$/.test(tm[4])) {
        const tag = tm[4];
        // 仅当 tag 看起来像一个 pkg 的子串（启发式，低置信度）
        for (const pkg of pidToPkg.values()) {
          if (pkg.toLowerCase().includes(tag.toLowerCase()) || tag.toLowerCase().includes(pkg.split(".").pop().toLowerCase())) {
            owner = pkg; conf = 0.7; break;
          }
        }
      }
    }

    if (!owner) { owner = "unknown"; conf = 0.3; }

    if (!cur) {
      cur = { owner_package: owner, ownership_confidence: conf, line_start: i + 1, tag: "logcat" };
      curStart = i + 1;
    } else if (cur.owner_package !== owner) {
      flush(i);
      cur = { owner_package: owner, ownership_confidence: conf, line_start: i + 1, tag: "logcat" };
      curStart = i + 1;
    } else {
      // 合并：保留更高的置信度
      if (conf > cur.ownership_confidence) cur.ownership_confidence = conf;
    }
  }
  flush(lines.length);
  return spans;
}

// ---------- anr trace ----------

export function resolveAnrTrace(content) {
  if (!content) return [];
  const cmdlineMatch = content.match(ANR_CMDLINE);
  const anrInMatch = content.match(ANR_IN);

  let owner = "unknown";
  let conf = 0.3;
  if (cmdlineMatch) { owner = cmdlineMatch[1]; conf = 1.0; }
  else if (anrInMatch) { owner = anrInMatch[1]; conf = 0.9; }

  return [{
    owner_package: owner,
    ownership_confidence: conf,
    text_snapshot: content,
    tag: "anr_trace",
  }];
}

// ---------- dumpsys ----------

/**
 * dumpsys 按 "DUMP OF SERVICE <name>" 切分。
 * - 带包参数（如 `meminfo com.xxx.foo`）→ 归对应包
 * - 系统服务（alarm/audio/...）→ 归 'framework'（0.8）
 * - 未识别 → 'unknown' (0.3)
 */
export function resolveDumpsys(content) {
  if (!content) return [];
  const parts = content.split(/(?=DUMP OF SERVICE\s)/);
  const spans = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const m = part.match(DUMPSYS_SECTION);
    if (!m) {
      spans.push({ owner_package: "unknown", ownership_confidence: 0.3, text_snapshot: part.slice(0, 16000), tag: "dumpsys" });
      continue;
    }
    const service = m[1];
    const argsInBracket = m[2] || "";
    // 检查 args 中是否有 package 名
    const pkgMatch = argsInBracket.match(/([a-zA-Z_][\w]+(?:\.[\w]+)+)/);
    if (pkgMatch) {
      spans.push({
        owner_package: pkgMatch[1],
        ownership_confidence: 1.0,
        text_snapshot: part.slice(0, 16000),
        tag: `dumpsys:${service}`,
      });
    } else {
      // 在 section body 里再扫一次 package
      const bodyPkg = part.match(/packageName=([a-zA-Z_][\w]+(?:\.[\w]+)+)/) ||
                      part.match(/(?:Process|proc):\s*([a-zA-Z_][\w]+(?:\.[\w]+)+)/);
      if (bodyPkg) {
        spans.push({
          owner_package: bodyPkg[1],
          ownership_confidence: 0.9,
          text_snapshot: part.slice(0, 16000),
          tag: `dumpsys:${service}`,
        });
      } else {
        // 系统服务归 framework
        spans.push({
          owner_package: "framework",
          ownership_confidence: 0.8,
          text_snapshot: part.slice(0, 16000),
          tag: `dumpsys:${service}`,
        });
      }
    }
  }
  return spans;
}

// ---------- systrace ----------

export function resolveSystrace(content) {
  if (!content) return [];
  const m = content.match(SYSTRACE_TGID);
  if (m && m[2]) {
    return [{ owner_package: m[2], ownership_confidence: 1.0, text_snapshot: content.slice(0, 16000), tag: "systrace" }];
  }
  if (m) {
    return [{ owner_package: "unknown", ownership_confidence: 0.5, text_snapshot: content.slice(0, 16000), tag: `systrace:tgid=${m[1]}` }];
  }
  return [{ owner_package: "unknown", ownership_confidence: 0.3, text_snapshot: content.slice(0, 16000), tag: "systrace" }];
}
