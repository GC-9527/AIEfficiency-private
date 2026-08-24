// Hermes chat -q 流式输出解析器。
//
// hermes chat -q（不带 --quiet）在非 TTY 管道下把工具进度和正文逐句写到 stdout，
// 但混有装饰：Query 回显、ANSI 颜色码、"Initializing agent..."、分隔线、
// "╭─ Hermes ─╮" 回答框边框、结尾的 Resume/Session/Duration 摘要。
// 本解析器按行剥离装饰，产出 { type, text, final } 事件流：
//   - type "text" + final=true  ：回答框（╭─...╰─）内的正文 —— 最终报告内容
//   - type "thinking" + final=false：框外过程文本（提示词回显、工具间叙述）—— 仅流式展示
//   - type "tool_use"/"tool_output"：工具进度行 —— 仅流式展示
//   - type "meta"：session_id —— 供 --resume 续接
// 同时捕获 session_id。
//
// 实测输出形态（2026-08-05）：
//   Query: <prompt>
//   \x1b[2;3mInitializing agent...\x1b[0m
//   \x1b[38;2;255;191;0m──────...\x1b[0m
//     ┊ 📖 preparing read_file…
//     | 📖 read      sample.txt  4.4s
//   \x1b[1;38;2;255;215;0m╭─ Hermes ─...╮\x1b[0m
//       <正文行>
//   \x1b[1;38;2;255;215;0m╰────...╯\x1b[0m
//   Resume this session with:
//     hermes --resume <session_id>
//   Session:        <session_id>
//   Duration:       10s
//   Messages:       4 (1 user, 2 tool calls)

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** 剥离 ANSI 转义序列，返回纯文本。 */
export function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "");
}

const TOOL_PREPARING_RE = /^\s*┊\s+(.+)$/;                 // "  ┊ 📖 preparing read_file…"
const TOOL_RESULT_RE = /^\s*[│|]\s+(.+)$/;                 // "  | 📖 read      sample.txt  4.4s"
const RESUME_RE = /--resume\s+(\S+)/;
const META_SUMMARY_RE = /^(?:Session:|Duration:|Messages:|Resume this session with:|hermes --resume)/;
const BOX_OPEN_RE = /^╭─/;                                  // 回答框顶
const BOX_CLOSE_RE = /^╰─/;                                 // 回答框底
const ITERATION_BUDGET_RE = /Iteration budget reached/i;    // 预算耗尽警告（不进入最终报告）

/**
 * 逐行解析 hermes chat -q 的 stdout。
 * @param {string} chunk  本次到达的 stdout 文本（可能跨行/半行）
 * @param {object} state  跨 chunk 状态：{ lineBuffer, sessionId, inBox }
 * @returns {Array<{type:string, text:string, final?:boolean}>} 事件列表
 */
export function parseHermesChatStream(chunk, state = {}) {
  const lineBuffer = state.lineBuffer || "";
  const events = [];
  const all = lineBuffer + String(chunk || "");
  const lines = all.split(/\r?\n/);
  state.lineBuffer = lines.pop(); // 最后一段可能是半行，留给下次

  for (const raw of lines) {
    const line = stripAnsi(raw).replace(/\r$/, "");
    if (!line.trim()) continue;

    // 会话续接 ID：Resume 提示行
    const resume = line.match(RESUME_RE);
    if (resume) {
      state.sessionId = resume[1];
      events.push({ type: "meta", text: `session_id: ${resume[1]}` });
      continue;
    }

    // 回答框边界：切换 inBox 状态，边框行本身不产出事件，但通知外部"新框开始/结束"
    if (BOX_OPEN_RE.test(line.trim())) {
      state.inBox = true;
      events.push({ type: "box_open" });
      continue;
    }
    if (BOX_CLOSE_RE.test(line.trim())) {
      state.inBox = false;
      events.push({ type: "box_close" });
      continue;
    }

    // 结尾摘要 / Query 回显 / 初始化横幅 / 分隔线：不展示
    if (
      META_SUMMARY_RE.test(line.trim())
      || /^Query:/.test(line)
      || /Initializing agent/.test(line)
      || /^─+$/.test(line.trim())
      || /^[─╭╰]+$/.test(line.trim())
    ) {
      continue;
    }

    // 工具进度行（框内不可能是工具行）
    const preparing = line.match(TOOL_PREPARING_RE);
    if (preparing && !state.inBox) {
      events.push({ type: "tool_use", text: preparing[1].trim() });
      continue;
    }
    const toolResult = line.match(TOOL_RESULT_RE);
    if (toolResult && !state.inBox) {
      events.push({ type: "tool_output", text: toolResult[1].trim() });
      continue;
    }

    // 预算耗尽警告：不进入最终报告（框内正文的尾部噪音）
    if (ITERATION_BUDGET_RE.test(line)) {
      events.push({ type: "thinking", text: line.trim(), final: false });
      continue;
    }

    // 回答框内 → 最终报告正文；框外 → 过程叙述（仅流式展示）
    if (state.inBox) {
      // hermes 回答框排版：正文每行统一缩进 4 空格（对齐框线）。去掉统一缩进，
      // 否则 markdown 会把整段当缩进代码块渲染（字一样大、标题不放大）。
      // 只去掉恰好 4 空格的前缀，保留行内相对缩进（列表/嵌套仍有效）。
      const body = line.replace(/^ {4}/, "");
      events.push({ type: "text", text: body, final: true });
    } else {
      events.push({ type: "thinking", text: line, final: false });
    }
  }
  return events;
}

/**
 * 收尾：把 lineBuffer 中残留的半行作为事件输出（进程已结束）。
 */
export function flushHermesChatStream(state = {}) {
  const rest = String(state.lineBuffer || "").trim();
  state.lineBuffer = "";
  if (!rest) return [];
  const line = stripAnsi(rest).replace(/\r$/, "");
  if (!line) return [];
  if (
    META_SUMMARY_RE.test(line)
    || /^Query:/.test(line)
    || /Initializing agent/.test(line)
    || /^[─╭╰]+$/.test(line.trim())
    || ITERATION_BUDGET_RE.test(line)
  ) {
    return [];
  }
  const preparing = line.match(TOOL_PREPARING_RE);
  if (preparing && !state.inBox) return [{ type: "tool_use", text: preparing[1].trim() }];
  const toolResult = line.match(TOOL_RESULT_RE);
  if (toolResult && !state.inBox) return [{ type: "tool_output", text: toolResult[1].trim() }];
  if (state.inBox) return [{ type: "text", text: line.replace(/^ {4}/, ""), final: true }];
  return [{ type: "thinking", text: line, final: false }];
}

