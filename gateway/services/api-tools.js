/**
 * OpenAI-compatible API Agent tools.
 *
 * File tools are constrained to the story-point workspace roots. Shell commands
 * use a configurable authorization policy; "workspace" blocks known destructive
 * system/Git operations while still allowing normal build and test commands.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "path";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { getConfig } from "./config.js";
import { ensurePlainExternalChildDirectory } from "./external-temp.js";
import {
  removeTaskRuntimeLease,
  upsertTaskRuntimeLease,
} from "../db/sqlite.js";
import { captureProcessIdentity, captureProcessIdentityAsync } from "./process-identity.js";
import { startProcessTreeWatchdog } from "./process-watchdog.js";
import JSZip from "jszip";
import {
  callAppMarketMcpTool,
  isAppMarketMcpTool,
} from "./appmarket-admin-mcp.js";

const execFileAsync = promisify(execFile);
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_METADATA_BYTES = 50 * 1024 * 1024;
const MAX_MIME_SNIFF_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_PDF_RENDER_PAGES = 10;
const MAX_TOOL_OUTPUT = 200_000;
const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024;
const SHELL_TERMINATION_GRACE_MS = 5_000;
const PROCESS_RETENTION_MS = 30 * 60 * 1000;
const processes = new Map();
const processRuntimeOwner = `api-tool-process-${process.pid}-${randomUUID()}`;
const PROCESS_RUNTIME_LEASE_TTL_MS = 15_000;
const PROCESS_RUNTIME_RESERVATION_TTL_MS = 60_000;
const PROCESS_RUNTIME_LEASE_HEARTBEAT_MS = 4_000;
const API_PROCESS_SUPERVISOR = fileURLToPath(new URL("./cli-supervisor.js", import.meta.url));
const WINDOWS_CMD_FALLBACK_TOOLS = new Set(["ffmpeg", "ffprobe", "pdftoppm"]);

const DANGEROUS_COMMANDS = [
  /\b(?:shutdown|reboot|halt|poweroff|diskpart|mkfs|fdisk)\b/i,
  /\bformat(?:\.com)?\s+[a-z]:/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\s]*f/i,
  /\bgit\s+push\b[^\r\n]*(?:--force|-f\b)/i,
  /\b(?:rm|rmdir)\b[^\r\n]*(?:-rf|-fr|--recursive)/i,
  /\bdel\b[^\r\n]*\/(?:s|q)/i,
  /\bRemove-Item\b[^\r\n]*-(?:Recurse|Force)/i,
  /\b(?:reg\s+delete|bcdedit|cipher\s+\/w)\b/i,
];

const ALL_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_files",
      description: "使用 ripgrep 在工作区搜索文本或正则，返回文件、行号和匹配内容。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "搜索文本或正则表达式" },
          path: { type: "string", description: "搜索目录，默认当前工作区" },
          glob: { type: "string", description: "可选 glob，例如 **/*.js" },
          case_sensitive: { type: "boolean", description: "是否区分大小写，默认 false" },
          max_results: { type: "integer", description: "最大结果数，默认 200，最大 1000" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "按行分段读取文本文件，返回带行号内容及文件总行数。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内文件路径" },
          start_line: { type: "integer", description: "起始行（从 1 开始），默认 1" },
          line_count: { type: "integer", description: "读取行数，默认 400，最大 2000" },
          start_byte: { type: "integer", description: "可选的 0 基字节偏移；传入后使用字节分页模式而非行模式" },
          max_bytes: { type: "integer", description: "字节分页模式最多读取的字节数，默认 65536，最大 200000" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出工作区内目录的直接子项。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "目录路径，默认 ." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "查看工作区 Git 分支和文件状态。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "仓库目录，默认当前工作区" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "查看 Git diff，可选择暂存区、统计或单个文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "仓库目录，默认当前工作区" },
          file: { type: "string", description: "可选的工作区内文件路径" },
          staged: { type: "boolean", description: "是否查看暂存区" },
          stat: { type: "boolean", description: "是否仅查看统计" },
          max_chars: { type: "integer", description: "最大返回字符数，默认 20000，最大 100000" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_inspect",
      description: "参数化执行 Git 只读检查；不经过 Shell，不接受任意 Git 参数。",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["show", "diff", "log", "rev_parse", "file_at_revision", "ls_files", "grep", "merge_base", "branch_list"],
            description: "只读检查类型",
          },
          path: { type: "string", description: "仓库目录，默认当前工作区" },
          revision: { type: "string", description: "提交、标签或分支名；默认 HEAD" },
          base: { type: "string", description: "diff/merge_base 的基准 revision" },
          target: { type: "string", description: "diff/merge_base 的目标 revision" },
          file: { type: "string", description: "可选的仓库内文件路径" },
          pattern: { type: "string", description: "grep 的搜索文本" },
          stat: { type: "boolean", description: "diff 是否仅返回统计" },
          max_count: { type: "integer", description: "log 最大提交数，默认 20，最大 100" },
          max_chars: { type: "integer", description: "最大返回字符数，默认 30000，最大 100000" },
        },
        required: ["operation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "在工作区内新建或完整覆盖文件。仅在确实需要完整重写时使用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内文件路径" },
          content: { type: "string", description: "完整文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "精确替换文件中的唯一文本片段。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内文件路径" },
          old_string: { type: "string", description: "必须唯一匹配的原始文本" },
          new_string: { type: "string", description: "替换后的文本" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "在工作区应用 unified diff。必须包含 diff --git/---/+++ 和 @@ 行，不接受说明文字。",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "完整 unified diff" },
          path: { type: "string", description: "应用补丁的仓库/目录，默认当前工作区" },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作区执行短命令并等待结果。长任务请使用 start_process。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell 命令" },
          purpose: { type: "string", description: "执行目的，便于审计" },
          path: { type: "string", description: "工作目录，默认当前工作区" },
          timeout_seconds: { type: "integer", description: "超时秒数，默认 120，最大 600" },
        },
        required: ["command", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_process",
      description: "启动长时间命令并立即返回 process_id，随后用 poll_process 续接输出。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell 命令" },
          purpose: { type: "string", description: "执行目的，便于审计" },
          path: { type: "string", description: "工作目录，默认当前工作区" },
          kind: { type: "string", enum: ["command", "test"], description: "test 会在结束时解析测试结果" },
          max_minutes: { type: "integer", description: "最长运行分钟数，默认 120，最大 720" },
        },
        required: ["command", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "poll_process",
      description: "获取长时间命令从上次轮询后的新增输出和当前状态。",
      parameters: {
        type: "object",
        properties: {
          process_id: { type: "string", description: "start_process process id" },
          cursor: { type: "integer", description: "Optional absolute output cursor. Omit to continue from the previous poll." },
          max_chars: { type: "integer", description: "Maximum output characters to return, default 200000" },
        },
        required: ["process_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_process",
      description: "停止由 start_process 启动的命令。",
      parameters: {
        type: "object",
        properties: { process_id: { type: "string", description: "要停止的进程 ID" } },
        required: ["process_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "运行测试命令并解析通过、失败、跳过数量及构建状态。超过 10 分钟的测试请用 start_process(kind=test)。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "测试命令" },
          purpose: { type: "string", description: "测试目标，便于审计" },
          path: { type: "string", description: "工作目录，默认当前工作区" },
          timeout_seconds: { type: "integer", description: "超时秒数，默认 600，最大 1800" },
        },
        required: ["command", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_local_check",
      description: "Run one Gateway-controlled local build or test check from the frozen Workflow v2 execution profile. Commands and arguments cannot be supplied by the model.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          rootId: { type: "string", description: "Authorized StageContext root identity" },
          checkId: { type: "string", description: "Frozen local-check identity" },
        },
        required: ["rootId", "checkId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_verification_case",
      description: "Run one Gateway-controlled verification case from the frozen Workflow v2 execution profile. Actions and arguments cannot be supplied by the model.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          rootId: { type: "string", description: "Authorized StageContext root identity" },
          caseId: { type: "string", description: "Frozen verification-case identity" },
        },
        required: ["rootId", "caseId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_binary_metadata",
      description: "Return deterministic metadata for a binary file without embedding file bytes in the prompt.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative binary file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_image",
      description: "Inspect an image file. Local execution returns metadata; Agent V2 may upload the image to a configured vision backend for OCR/visual analysis.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative PNG/JPEG/GIF/WebP image path" },
          prompt: { type: "string", description: "Optional visual question or OCR focus" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_pdf",
      description: "Inspect a PDF deterministically: metadata, page count estimate, and bounded text extraction. It does not upload the whole PDF.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative PDF file path" },
          max_chars: { type: "integer", description: "Maximum extracted text characters, default 12000, max 50000" },
          render_pages: { type: "array", items: { type: "integer" }, description: "Optional 1-based page numbers to render as images for visual/OCR inspection" },
          output_dir: { type: "string", description: "Directory for rendered pages; story tasks default to the story's external StoryDev tempFiles/pdf-pages directory" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_archive",
      description: "List entries in a ZIP archive with size limits. Does not extract files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative ZIP archive path" },
          max_entries: { type: "integer", description: "Maximum entries to return, default 200, max 2000" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_archive_entry",
      description: "Read or extract one ZIP entry with Zip Slip protection and size limits. Binary entries return metadata unless output_path is provided.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative ZIP archive path" },
          entry_path: { type: "string", description: "Exact entry path inside the archive" },
          output_path: { type: "string", description: "Optional workspace-relative output file path for extraction" },
          max_bytes: { type: "integer", description: "Maximum entry bytes, default 1MB, max 10MB" },
        },
        required: ["path", "entry_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_video",
      description: "Inspect video metadata using ffprobe and optionally extract bounded key frames with ffmpeg when available.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative video path" },
          timestamps: { type: "array", items: { type: "number" }, description: "Optional seconds to extract frames at" },
          output_dir: { type: "string", description: "Directory for extracted frames; story tasks default to the story's external StoryDev tempFiles/video-frames directory" },
        },
        required: ["path"],
      },
    },
  },
];

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "run_bash", "run_command", "start_process", "stop_process", "run_tests"]);
const READ_ONLY_TOOL_NAMES = new Set([
  "search_files",
  "read_file",
  "list_dir",
  "git_status",
  "git_diff",
  "git_inspect",
  "read_binary_metadata",
  "inspect_image",
  "inspect_pdf",
  "list_archive",
  "extract_archive_entry",
  "inspect_video",
  // These tools may run external actions, but they remain safe in a read-only
  // stage because the model can only select a frozen profile entry. The API
  // engine executes them through the Workflow v2 receipt recorder, never via
  // executeTool or a caller-supplied command string.
  "run_local_check",
  "run_verification_case",
]);
const WORKFLOW_V2_CONTROLLED_TOOLS = new Set(["run_local_check", "run_verification_case"]);

function agentConfig() {
  return getConfig().apiAgent || {};
}

function commandPolicy(ctx = {}) {
  return ctx.commandPolicy || agentConfig().commandPolicy || "workspace";
}

export function getToolDefinitions(ctx = {}) {
  return ALL_TOOL_DEFINITIONS.filter((tool) => {
    const name = tool.function.name;
    if (WORKFLOW_V2_CONTROLLED_TOOLS.has(name) && ctx.workflowV2ControlledExecution !== true) return false;
    return commandPolicy(ctx) !== "read_only" || READ_ONLY_TOOL_NAMES.has(name);
  });
}

// Backward-compatible export for callers that only need the schema.
export const TOOL_DEFINITIONS = ALL_TOOL_DEFINITIONS;

function normalizePath(p) {
  const value = resolve(String(p || ""));
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveBaseDir(ctx = {}) {
  const configured = ctx.cwd || getConfig().workDir || homedir();
  const base = resolve(configured);
  if (!existsSync(base)) throw new Error(`工作目录不存在: ${base}`);
  return base;
}

function workspaceRoots(ctx = {}) {
  const base = resolveBaseDir(ctx);
  const roots = [base, ...(ctx.allowedRoots || ctx.addDirs || [])]
    .filter(Boolean)
    .map((item) => resolve(String(item)));
  return [...new Map(roots.map((root) => [normalizePath(root), root])).values()];
}

// Resolve symlinks/junctions for both existing targets and new files whose
// nearest existing parent may itself be a link outside the workspace.
function canonicalTarget(target) {
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (!existsSync(existing)) return resolve(target);
  const realExisting = realpathSync.native ? realpathSync.native(existing) : realpathSync(existing);
  return resolve(realExisting, relative(existing, target));
}

export function resolveWorkspacePath(p, ctx = {}) {
  const base = resolveBaseDir(ctx);
  const target = isAbsolute(String(p || "")) ? resolve(String(p)) : resolve(base, String(p || "."));
  const isolation = ctx.workspaceIsolation ?? agentConfig().workspaceIsolation ?? true;
  if (isolation) {
    const normalizedTarget = normalizePath(canonicalTarget(target));
    const allowed = workspaceRoots(ctx).some((root) => isWithin(normalizePath(canonicalTarget(root)), normalizedTarget));
    if (!allowed) throw new Error(`路径越界，目标不在故事点工作区内: ${p}`);
  }
  return target;
}

function resolveGeneratedArtifactPath(p, ctx = {}, fallback = "") {
  if (!ctx.tempRoot) {
    throw new Error("生成产物缺少外置 tempFiles 目录，拒绝回退写入源码工作区");
  }
  const target = resolveWorkspacePath(p || fallback, ctx);
  const tempRoot = resolveWorkspacePath(ctx.tempRoot, ctx);
  const normalizedRoot = normalizePath(canonicalTarget(tempRoot));
  const normalizedTarget = normalizePath(canonicalTarget(target));
  if (!isWithin(normalizedRoot, normalizedTarget)) {
    throw new Error(`生成产物必须写入故事点外置 tempFiles 目录: ${p || fallback}`);
  }
  return target;
}

function ensurePlainGeneratedArtifactDirectory(directory, ctx = {}) {
  const tempRoot = resolveWorkspacePath(ctx.tempRoot, ctx);
  const target = resolveGeneratedArtifactPath(directory, ctx);
  const relativePath = relative(tempRoot, target);
  if (!isWithin(normalizePath(tempRoot), normalizePath(target))) {
    throw new Error("generated artifact directory escapes tempRoot");
  }
  let current = tempRoot;
  const rootStat = lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("generated artifact tempRoot is not a plain directory");
  }
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) {
      try { mkdirSync(current); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("generated artifact directory traverses a symlink or junction");
    }
  }
  return target;
}

function assertPlainGeneratedArtifactFile(file, directory, { mustExist = false, mustNotExist = false } = {}) {
  const parent = resolve(directory);
  const target = resolve(file);
  if (!isWithin(normalizePath(parent), normalizePath(target)) || dirname(target) !== parent) {
    throw new Error("generated artifact file escapes its output directory");
  }
  if (!existsSync(target)) {
    if (mustExist) throw new Error("generated artifact file is missing");
    return target;
  }
  if (mustNotExist) {
    throw new Error("generated artifact file already exists");
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("generated artifact file is not a plain file");
  }
  const realParent = realpathSync.native ? realpathSync.native(parent) : realpathSync(parent);
  const realTarget = realpathSync.native ? realpathSync.native(target) : realpathSync(target);
  if (dirname(realTarget) !== realParent) {
    throw new Error("generated artifact file resolves outside its plain output directory");
  }
  return target;
}

function assertWriteAllowed(ctx = {}) {
  if (commandPolicy(ctx) === "read_only") throw new Error("当前 API Agent 命令权限为只读，禁止修改文件");
}

export function authorizeCommand(command, ctx = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) throw new Error("command 不能为空");
  const policy = commandPolicy(ctx);
  if (policy === "read_only") {
    throw new Error("当前 API Agent 为只读模式，禁止执行自由 Shell 命令；请使用参数化只读工具");
  }
  if (policy !== "trusted") {
    const denied = DANGEROUS_COMMANDS.find((pattern) => pattern.test(cmd));
    if (denied) throw new Error("命令包含高风险系统、强制 Git 或递归删除操作；请改用受控文件工具，或由用户切换为完全信任模式");
  }
  return cmd;
}

function gitRevision(value, field = "revision", fallback = "HEAD") {
  const revision = String(value || fallback).trim();
  if (!revision
    || revision.length > 240
    || revision.startsWith("-")
    || /[\s:\u0000-\u001f\u007f\\]/u.test(revision)) {
    throw new Error(`${field} 不是安全的 Git revision`);
  }
  return revision;
}

function gitRepoRelativeFile(cwd, value, ctx = {}, { required = false } = {}) {
  if (value == null || String(value).trim() === "") {
    if (required) throw new Error("该 Git 检查必须提供 file");
    return "";
  }
  const target = resolveWorkspacePath(String(value), { ...ctx, cwd });
  const canonicalRoot = normalizePath(canonicalTarget(cwd));
  const canonicalFile = normalizePath(canonicalTarget(target));
  if (!isWithin(canonicalRoot, canonicalFile)) {
    throw new Error(`Git 文件路径越出当前仓库: ${value}`);
  }
  const repoPath = relative(cwd, target).split(sep).join("/");
  if (!repoPath || repoPath === "." || repoPath.startsWith("../") || repoPath.includes("\u0000")) {
    throw new Error(`Git 文件路径无效: ${value}`);
  }
  return repoPath;
}

function gitReadOnlyOptions(ctx = {}) {
  return {
    signal: ctx.signal || undefined,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
      PAGER: "cat",
    },
  };
}

function gitReadOnlyArgs(cwd, commandArgs) {
  return [
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "color.ui=false",
    "-C", cwd,
    ...commandArgs,
  ];
}

async function executeGitInspect(args, ctx = {}) {
  const cwd = resolveWorkspacePath(args.path || ".", ctx);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Git 仓库目录不存在: ${args.path || "."}`);
  }
  const operation = String(args.operation || "");
  const file = gitRepoRelativeFile(cwd, args.file, ctx);
  let commandArgs;

  switch (operation) {
    case "show": {
      const revision = gitRevision(args.revision);
      commandArgs = ["show", "--no-ext-diff", "--no-textconv", "--format=fuller", "--stat", "--patch", revision];
      if (file) commandArgs.push("--", file);
      break;
    }
    case "diff": {
      const target = gitRevision(args.target || args.revision, "target");
      const base = gitRevision(args.base || `${target}^`, "base");
      commandArgs = ["diff", "--no-ext-diff", "--no-textconv"];
      if (args.stat) commandArgs.push("--stat");
      commandArgs.push(base, target);
      if (file) commandArgs.push("--", file);
      break;
    }
    case "log": {
      const revision = gitRevision(args.revision);
      const maxCount = clampInt(args.max_count, 20, 1, 100);
      commandArgs = [
        "log",
        "--no-decorate",
        `--max-count=${maxCount}`,
        "--format=%H%x09%aI%x09%an%x09%s",
        revision,
      ];
      if (file) commandArgs.push("--", file);
      break;
    }
    case "rev_parse": {
      const revision = gitRevision(args.revision);
      commandArgs = ["rev-parse", "--verify", `${revision}^{commit}`];
      break;
    }
    case "file_at_revision": {
      const revision = gitRevision(args.revision);
      const revisionFile = gitRepoRelativeFile(cwd, args.file, ctx, { required: true });
      if (revisionFile.includes(":")) throw new Error("Git 历史文件路径不能包含冒号");
      commandArgs = ["show", "--no-ext-diff", "--no-textconv", `${revision}:${revisionFile}`];
      break;
    }
    case "ls_files":
      commandArgs = ["ls-files"];
      if (file) commandArgs.push("--", file);
      break;
    case "grep": {
      const pattern = String(args.pattern || "");
      if (!pattern || pattern.length > 2_000 || pattern.includes("\u0000")) {
        throw new Error("grep pattern 不能为空且最多 2000 字符");
      }
      commandArgs = ["grep", "-n", "--full-name", "-e", pattern];
      if (args.revision) commandArgs.push(gitRevision(args.revision));
      commandArgs.push("--");
      if (file) commandArgs.push(file);
      break;
    }
    case "merge_base": {
      if (!args.base || !args.target) throw new Error("merge_base 必须提供 base 和 target");
      commandArgs = ["merge-base", gitRevision(args.base, "base"), gitRevision(args.target, "target")];
      break;
    }
    case "branch_list":
      commandArgs = ["branch", "--list", "--all", "--no-color", "--format=%(refname)%09%(objectname)"];
      break;
    default:
      throw new Error(`不支持的 Git 只读检查: ${operation || "(empty)"}`);
  }

  const result = await execFileResult(
    "git",
    gitReadOnlyArgs(cwd, commandArgs),
    { cwd, ...gitReadOnlyOptions(ctx) },
  );
  const max = clampInt(args.max_chars, 30_000, 1_000, 100_000);
  if (result.exitCode !== 0) {
    return `git ${operation} 失败: ${trimOutput(result.stderr || result.stdout, 8_000)}`;
  }
  return trimOutput(result.stdout, max) || `(git ${operation} 无输出)`;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function trimOutput(value, max = MAX_TOOL_OUTPUT) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `...(前部已截断 ${text.length - max} 字符)\n${text.slice(-max)}`;
}

const IMAGE_EXT_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const EXT_MIME = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};

function detectMime(buffer, file) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return EXT_MIME[extname(file).toLowerCase()] || "application/octet-stream";
}

function imageDimensions(buffer, mime) {
  try {
    if (mime === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mime === "image/webp" && buffer.length >= 30) {
      const chunk = buffer.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X" && buffer.length >= 30) {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      }
      if (chunk === "VP8 " && buffer.length >= 30) {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L" && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) break;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {}
  return { width: null, height: null };
}

function readFileHead(file, size) {
  const length = Math.max(0, Math.min(Number(size) || 0, MAX_MIME_SNIFF_BYTES));
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function binaryMetadata(file, stat, options = {}) {
  const allowLarge = options.allowLarge === true;
  if (stat.size > MAX_BINARY_METADATA_BYTES && !allowLarge) {
    throw new Error(`binary file too large for metadata hashing (${stat.size} bytes)`);
  }
  const fullHash = stat.size <= MAX_BINARY_METADATA_BYTES;
  const buffer = fullHash ? readFileSync(file) : readFileHead(file, stat.size);
  const mime = detectMime(buffer, file);
  const isImage = mime.startsWith("image/");
  const dimensions = isImage ? imageDimensions(buffer, mime) : { width: null, height: null };
  return {
    size: stat.size,
    mime,
    sha256: fullHash ? createHash("sha256").update(buffer).digest("hex") : null,
    hashTruncated: !fullHash,
    image: isImage ? dimensions : null,
  };
}

function pdfLiteralText(literal) {
  return String(literal)
    .replace(/\\([nrtbf()\\])/g, (match, ch) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[ch] || match))
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function inspectPdfBuffer(buffer, maxChars) {
  const latin = buffer.toString("latin1");
  const pageCount = (latin.match(/\/Type\s*\/Page\b/g) || []).length;
  const title = latin.match(/\/Title\s*\(([^)]{0,500})\)/)?.[1] || "";
  const author = latin.match(/\/Author\s*\(([^)]{0,500})\)/)?.[1] || "";
  const fragments = [];
  const textObjectPattern = /BT([\s\S]*?)ET/g;
  let block;
  while ((block = textObjectPattern.exec(latin)) && fragments.join("\n").length < maxChars) {
    const body = block[1];
    for (const match of body.matchAll(/\(((?:\\.|[^\\)]){1,2000})\)\s*(?:Tj|'|"|TJ)/g)) {
      fragments.push(pdfLiteralText(match[1]));
      if (fragments.join("\n").length >= maxChars) break;
    }
  }
  if (!fragments.length) {
    for (const match of latin.matchAll(/\(([\x20-\x7e]{4,500})\)/g)) {
      fragments.push(pdfLiteralText(match[1]));
      if (fragments.join("\n").length >= maxChars) break;
    }
  }
  const text = fragments.join("\n").replace(/[ \t]+\n/g, "\n").trim();
  return {
    pageCount: pageCount || null,
    info: { title: title ? pdfLiteralText(title) : "", author: author ? pdfLiteralText(author) : "" },
    extractedText: compactText(text, maxChars),
    textTruncated: text.length > maxChars,
    note: "PDF text extraction is deterministic and bounded; scanned or compressed PDFs may require page rendering/vision in a later tool.",
  };
}

async function renderPdfPages(file, args, ctx) {
  const requested = Array.isArray(args.render_pages)
    ? args.render_pages.map((item) => Math.floor(Number(item))).filter((item) => item > 0)
    : [];
  const pages = [...new Set(requested)].slice(0, MAX_PDF_RENDER_PAGES);
  if (!pages.length) return [];
  const outputDir = resolveGeneratedArtifactPath(
    args.output_dir || resolve(ctx.tempRoot, "pdf-pages"),
    ctx,
  );
  ensurePlainGeneratedArtifactDirectory(outputDir, ctx);
  const rendered = [];
  for (const page of pages) {
    const baseName = `page_${String(page).padStart(4, "0")}`;
    const outBase = resolve(outputDir, baseName);
    const outFile = `${outBase}.png`;
    try {
      assertPlainGeneratedArtifactFile(outFile, outputDir, { mustNotExist: true });
    } catch (error) {
      rendered.push({
        page,
        path: relative(resolveBaseDir(ctx), outFile).replace(/\\/g, "/"),
        ok: false,
        error: trimOutput(error.message, 4000),
      });
      continue;
    }
    const result = await execFileResult("pdftoppm", ["-f", String(page), "-l", String(page), "-png", "-singlefile", file, outBase], { timeout: 60000 });
    let outputError = "";
    let outputSha256 = null;
    if (result.exitCode === 0) {
      try {
        assertPlainGeneratedArtifactFile(outFile, outputDir, { mustExist: true });
        outputSha256 = createHash("sha256").update(readFileSync(outFile)).digest("hex");
      }
      catch (error) { outputError = error.message; }
    }
    rendered.push({
      page,
      path: relative(resolveBaseDir(ctx), outFile).replace(/\\/g, "/"),
      ok: result.exitCode === 0 && !outputError,
      error: result.exitCode === 0 ? trimOutput(outputError, 4000) : trimOutput(result.stderr || "pdftoppm not available", 4000),
      sha256: outputSha256,
    });
  }
  return rendered;
}

async function inspectPdfFile(file, stat, args, ctx) {
  const metadata = binaryMetadata(file, stat);
  if (metadata.mime !== "application/pdf") return { error: `not a PDF file (${metadata.mime})`, metadata };
  const maxChars = clampInt(args.max_chars, 12_000, 1000, 50_000);
  return {
    path: args.path,
    ...metadata,
    pdf: inspectPdfBuffer(readFileSync(file), maxChars),
    renderedPages: await renderPdfPages(file, args, ctx),
  };
}

function compactText(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}...(truncated ${value.length - max} chars)` : value;
}

function archiveEntrySafe(name) {
  const normalized = String(name || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function entrySize(entry) {
  return entry?._data?.uncompressedSize ?? entry?._data?.compressedSize ?? null;
}

function textLikePath(name) {
  return /\.(?:txt|md|json|xml|html?|css|js|ts|tsx|jsx|java|kt|gradle|properties|yaml|yml|csv|log|ini|cfg|conf)$/i.test(String(name || ""));
}

async function loadZipArchive(file, stat) {
  if (stat.size > MAX_ARCHIVE_BYTES) throw new Error(`archive too large (${stat.size} bytes)`);
  return JSZip.loadAsync(readFileSync(file));
}

async function listZipArchive(file, stat, maxEntries) {
  const zip = await loadZipArchive(file, stat);
  const entries = Object.values(zip.files);
  const shown = entries.slice(0, maxEntries).map((entry) => ({
    path: entry.name,
    dir: entry.dir,
    unsafe: !archiveEntrySafe(entry.name),
    uncompressedSize: entrySize(entry),
  }));
  return { entryCount: entries.length, shown: shown.length, truncated: entries.length > shown.length, entries: shown };
}

async function extractZipEntry({ file, stat, entryPath, outputPath, ctx, maxBytes }) {
  const zip = await loadZipArchive(file, stat);
  const normalized = String(entryPath || "").replace(/\\/g, "/");
  if (!archiveEntrySafe(normalized)) throw new Error("unsafe archive entry path");
  const entry = zip.file(normalized);
  if (!entry) throw new Error(`archive entry not found: ${entryPath}`);
  const declaredSize = entrySize(entry);
  if (declaredSize != null && declaredSize > maxBytes) throw new Error(`archive entry too large (${declaredSize} bytes)`);
  const buffer = await entry.async("nodebuffer");
  if (buffer.length > maxBytes) throw new Error(`archive entry too large (${buffer.length} bytes)`);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (outputPath) {
    const output = resolveGeneratedArtifactPath(outputPath, ctx);
    const outputDirectory = ensurePlainGeneratedArtifactDirectory(dirname(output), ctx);
    assertPlainGeneratedArtifactFile(output, outputDirectory, { mustNotExist: true });
    writeFileSync(output, buffer, { flag: "wx", mode: 0o600 });
    assertPlainGeneratedArtifactFile(output, outputDirectory, { mustExist: true });
    if (createHash("sha256").update(readFileSync(output)).digest("hex") !== sha256) {
      throw new Error("extracted archive entry hash changed after write");
    }
    return { entryPath: normalized, outputPath, size: buffer.length, sha256, extracted: true };
  }
  const hasNul = buffer.includes(0);
  const text = !hasNul && textLikePath(normalized) ? buffer.toString("utf8") : "";
  return {
    entryPath: normalized,
    size: buffer.length,
    sha256,
    extracted: false,
    text: text ? compactText(text, MAX_TOOL_OUTPUT) : "",
    binary: !text,
    note: text ? undefined : "Binary archive entry was not embedded in the prompt. Provide output_path to extract it into the workspace.",
  };
}

async function inspectVideoFile(file, args, ctx) {
  const stat = statSync(file);
  const metadata = binaryMetadata(file, stat, { allowLarge: true });
  const result = { path: args.path, metadata, ffprobe: null, frames: [] };
  const probe = await execFileResult("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-print_format", "json", file], { timeout: 30000 });
  if (probe.exitCode === 0 && probe.stdout) {
    try { result.ffprobe = { ok: true, data: JSON.parse(probe.stdout) }; }
    catch { result.ffprobe = { ok: false, error: "ffprobe returned invalid JSON", raw: trimOutput(probe.stdout, 4000) }; }
  } else {
    result.ffprobe = { ok: false, error: trimOutput(probe.stderr || "ffprobe not available", 4000) };
  }
  const timestamps = Array.isArray(args.timestamps) ? args.timestamps.filter((n) => Number.isFinite(Number(n))).slice(0, 10) : [];
  if (!timestamps.length) return result;
  const outputDir = resolveGeneratedArtifactPath(
    args.output_dir || resolve(ctx.tempRoot, "video-frames"),
    ctx,
  );
  ensurePlainGeneratedArtifactDirectory(outputDir, ctx);
  for (const seconds of timestamps) {
    const safeTs = Math.max(0, Number(seconds));
    const outName = `frame_${String(Math.round(safeTs * 1000)).padStart(8, "0")}.png`;
    const outFile = resolve(outputDir, outName);
    try {
      assertPlainGeneratedArtifactFile(outFile, outputDir, { mustNotExist: true });
    } catch (error) {
      result.frames.push({
        timestamp: safeTs,
        path: relative(resolveBaseDir(ctx), outFile).replace(/\\/g, "/"),
        ok: false,
        error: trimOutput(error.message, 4000),
      });
      continue;
    }
    const frame = await execFileResult("ffmpeg", ["-n", "-ss", String(safeTs), "-i", file, "-frames:v", "1", outFile], { timeout: 60000 });
    let outputError = "";
    let outputSha256 = null;
    if (frame.exitCode === 0) {
      try {
        assertPlainGeneratedArtifactFile(outFile, outputDir, { mustExist: true });
        outputSha256 = createHash("sha256").update(readFileSync(outFile)).digest("hex");
      }
      catch (error) { outputError = error.message; }
    }
    result.frames.push({
      timestamp: safeTs,
      path: relative(resolveBaseDir(ctx), outFile).replace(/\\/g, "/"),
      ok: frame.exitCode === 0 && !outputError,
      error: frame.exitCode === 0 ? trimOutput(outputError, 4000) : trimOutput(frame.stderr || "ffmpeg not available", 4000),
      sha256: outputSha256,
    });
  }
  return result;
}

const FALLBACK_SEARCH_SKIP_DIRS = new Set([".git", ".gradle", ".idea", "node_modules", "build", "dist", "out", "target"]);
const FALLBACK_SEARCH_SKIP_EXT = /\.(?:aar|apk|class|dex|jar|zip|7z|png|jpe?g|gif|webp|ico|pdf|so|dll|exe|bin|db|sqlite|pftrace)$/i;

function globRegex(glob) {
  if (!glob) return null;
  const source = String(glob).replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i");
}

function fallbackSearchFiles({ pattern, root, glob, caseSensitive, maxResults, signal }) {
  let matcher;
  try { matcher = new RegExp(String(pattern), caseSensitive ? "" : "i"); }
  catch { matcher = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i"); }
  const globMatcher = globRegex(glob);
  const results = [];
  let scannedFiles = 0;
  const walk = (dir) => {
    if (signal?.aborted || results.length >= maxResults || scannedFiles >= 20_000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (signal?.aborted || results.length >= maxResults || scannedFiles >= 20_000) break;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FALLBACK_SEARCH_SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || FALLBACK_SEARCH_SKIP_EXT.test(entry.name)) continue;
      const rel = relative(root, full).replace(/\\/g, "/");
      if (globMatcher && !globMatcher.test(rel) && !globMatcher.test(entry.name)) continue;
      scannedFiles++;
      let text;
      try {
        const stat = statSync(full);
        if (stat.size > 2 * 1024 * 1024) continue;
        text = readFileSync(full, "utf-8");
        if (text.includes("\0")) continue;
      } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index++) {
        const match = matcher.exec(lines[index]);
        if (!match) continue;
        results.push(`${full}:${index + 1}:${(match.index || 0) + 1}:${lines[index]}`);
      }
    }
  };
  walk(root);
  return `${results.join("\n") || "(未找到匹配)"}\n[search_files: 内置搜索回退，扫描 ${scannedFiles} 个文件]`;
}

function shellOptions(cwd) {
  return {
    cwd,
    env: process.env,
    windowsHide: true,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
  };
}

function terminateProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.unref?.();
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  }
}

function runShell(command, cwd, timeoutMs, signal = null, runtime = {}) {
  return new Promise((resolveRun) => {
    const spawnProcess = typeof runtime.spawnProcess === "function" ? runtime.spawnProcess : spawn;
    const terminate = typeof runtime.terminateProcess === "function" ? runtime.terminateProcess : terminateProcess;
    const terminationGraceMs = Number.isFinite(Number(runtime.terminationGraceMs))
      ? Math.max(0, Number(runtime.terminationGraceMs))
      : SHELL_TERMINATION_GRACE_MS;
    const child = spawnProcess(command, [], { ...shellOptions(cwd), detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer = null;
    let terminationTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolveRun({ ...result, aborted });
    };
    const requestTermination = (reason) => {
      if (settled || terminationTimer) return;
      timedOut = reason === "timeout";
      aborted = aborted || reason === "abort";
      terminate(child);
      terminationTimer = setTimeout(() => {
        finish({
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          terminationUnconfirmed: true,
          terminationGraceMs,
        });
      }, terminationGraceMs);
    };
    const onAbort = () => requestTermination("abort");
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); if (stdout.length > MAX_PROCESS_OUTPUT) stdout = stdout.slice(-MAX_PROCESS_OUTPUT); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > MAX_PROCESS_OUTPUT) stderr = stderr.slice(-MAX_PROCESS_OUTPUT); });
    child.on("error", (error) => {
      finish({ exitCode: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut });
    });
    timer = setTimeout(() => requestTermination("timeout"), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function assertShellTerminationConverged(result, toolName) {
  if (!result?.terminationUnconfirmed) return result;
  const reason = result.timedOut ? "超时" : (result.aborted ? "取消" : "终止");
  throw Object.assign(
    new Error(`${toolName} ${reason}后未确认进程树退出，本轮已终止；工作树改动已保留，请检查残留进程后重试`),
    {
      code: "API_TOOL_TERMINATION_UNCONFIRMED",
      terminalFailure: true,
      toolName,
      timedOut: !!result.timedOut,
      aborted: !!result.aborted,
    },
  );
}

export const __testRunShell = runShell;
export const __testAssertShellTerminationConverged = assertShellTerminationConverged;

function formatCommandResult(result) {
  const output = `${result.stdout || ""}${result.stderr ? `${result.stdout ? "\n" : ""}[stderr]\n${result.stderr}` : ""}`;
  return [`exit_code: ${result.exitCode ?? "unknown"}`, `timed_out: ${!!result.timedOut}`, `aborted: ${!!result.aborted}`, "output:", trimOutput(output, MAX_TOOL_OUTPUT) || "(命令无输出)"].join("\n");
}

async function execFileResult(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, { windowsHide: true, maxBuffer: MAX_PROCESS_OUTPUT, ...options });
    return { exitCode: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    if (process.platform === "win32" && error?.code === "ENOENT" && WINDOWS_CMD_FALLBACK_TOOLS.has(command)) {
      try {
        const result = await execFileAsync("cmd.exe", ["/d", "/s", "/c", command, ...args], { windowsHide: true, maxBuffer: MAX_PROCESS_OUTPUT, ...options });
        return { exitCode: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
      } catch (fallbackError) {
        return { exitCode: Number.isInteger(fallbackError.code) ? fallbackError.code : null, stdout: fallbackError.stdout || "", stderr: fallbackError.stderr || fallbackError.message || "" };
      }
    }
    return { exitCode: Number.isInteger(error.code) ? error.code : null, stdout: error.stdout || "", stderr: error.stderr || error.message || "" };
  }
}

function extractCount(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

export function parseTestOutput(output, exitCode = 0, timedOut = false) {
  const text = String(output || "");
  const passed = extractCount(text, [/(?:Tests?:\s*)?(\d+)\s+passed\b/i, /# pass\s+(\d+)/i, /Tests:\s+.*?(\d+)\s+passed/i]);
  const failed = extractCount(text, [/(?:Tests?:\s*)?(\d+)\s+failed\b/i, /# fail\s+(\d+)/i, /Tests:\s+(\d+)\s+failed/i]);
  const skipped = extractCount(text, [/(\d+)\s+(?:skipped|pending|todo)\b/i, /# skipped\s+(\d+)/i]);
  const buildSuccess = /\bBUILD SUCCESSFUL\b|\bBUILD SUCCESS\b/i.test(text);
  const buildFailed = /\bBUILD FAILED\b|\bBUILD FAILURE\b/i.test(text);
  const status = timedOut ? "timeout" : ((exitCode === 0 && !failed && !buildFailed) ? "passed" : "failed");
  return { status, exitCode, passed, failed, skipped, buildSuccess, buildFailed, timedOut };
}

function appendProcessOutput(entry, channel, chunk) {
  const prefix = channel === "stderr" ? "[stderr] " : "";
  entry.output += prefix + chunk.toString();
  if (entry.output.length > MAX_PROCESS_OUTPUT) {
    const removed = entry.output.length - MAX_PROCESS_OUTPUT;
    entry.output = entry.output.slice(removed);
    entry.readOffset = Math.max(0, entry.readOffset - removed);
  }
  entry.updatedAt = Date.now();
}

function scheduleProcessCleanup(entry) {
  const timer = setTimeout(() => processes.delete(entry.id), PROCESS_RETENTION_MS);
  timer.unref?.();
}

function storyRuntimeTaskId(ctx = {}) {
  if (ctx.artifactScope?.kind !== "story") return "";
  return String(ctx.storyTaskId || "").trim();
}

function refreshProcessRuntimeLease(entry) {
  if (!entry?.runtimeTaskId || entry.runtimeLeaseReleased) return true;
  const result = upsertTaskRuntimeLease({
    leaseId: entry.runtimeLeaseId,
    taskId: entry.runtimeTaskId,
    ownerInstance: processRuntimeOwner,
    ownerPid: process.pid,
    workerPid: entry.runtimeWorkerRegistered ? (entry.child?.pid || null) : null,
    workerIdentity: entry.runtimeWorkerRegistered ? (entry.runtimeWorkerIdentity || "") : "",
    ttlMs: PROCESS_RUNTIME_LEASE_TTL_MS,
  });
  if (result?.changes !== 1) return false;
  entry.runtimeLeaseHeartbeatAt = Date.now();
  return true;
}

function releaseProcessRuntimeLease(entry) {
  if (!entry?.runtimeLeaseId || entry.runtimeLeaseReleased) return;
  entry.runtimeLeaseReleased = true;
  try {
    removeTaskRuntimeLease(entry.runtimeLeaseId, processRuntimeOwner);
  } catch {
    // The worker PID remains in the persisted row. Cleanup inspection will
    // conservatively keep blocking while that PID is alive.
  }
}

const processRuntimeLeaseHeartbeat = setInterval(() => {
  for (const entry of processes.values()) {
    if (entry.runtimeTreeSettled || !entry.runtimeTaskId || entry.runtimeLeaseReleased) continue;
    try {
      if (refreshProcessRuntimeLease(entry)) continue;
    } catch {}
    if (Date.now() - Number(entry.runtimeLeaseHeartbeatAt || 0) < PROCESS_RUNTIME_LEASE_TTL_MS / 2) {
      continue;
    }
    if (!entry.runtimeTerminationRequested) {
      entry.runtimeTerminationRequested = true;
      entry.status = "failed";
      appendProcessOutput(entry, "stderr", "后台进程运行租约续期失败，已终止进程以保护故事点 worktree\n");
      requestLongProcessStop(entry);
    }
  }
}, PROCESS_RUNTIME_LEASE_HEARTBEAT_MS);
processRuntimeLeaseHeartbeat.unref?.();

function processStoreFile(cwd, id, tempRoot = "") {
  const safeId = String(id || "");
  if (!tempRoot || !/^[A-Za-z0-9_.-]+$/.test(safeId)) return null;
  const root = resolve(tempRoot);
  const directory = ensurePlainExternalChildDirectory(root, "api-tool-processes", {
    avoidRoots: [cwd],
  });
  return resolve(directory, `${safeId}.json`);
}

function processSnapshot(entry) {
  return {
    id: entry.id,
    command: entry.command,
    purpose: entry.purpose,
    kind: entry.kind,
    status: entry.status,
    exitCode: entry.exitCode,
    output: entry.output || "",
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt || Date.now(),
    timedOut: !!entry.timedOut,
  };
}

function persistProcessSnapshot(entry) {
  try {
    const file = processStoreFile(entry.cwd, entry.id, entry.tempRoot);
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(processSnapshot(entry), null, 2), "utf8");
  } catch {
    // Process snapshots are best-effort recovery data.
  }
}

function loadPersistedProcess(cwd, id, tempRoot = "") {
  try {
    const file = processStoreFile(cwd, id, tempRoot);
    if (!file || !existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const updatedAt = Number(raw.updatedAt || raw.startedAt || 0);
    if (updatedAt && Date.now() - updatedAt > PROCESS_RETENTION_MS) {
      try { unlinkSync(file); } catch {}
      return null;
    }
    let status = String(raw.status || "completed");
    let output = String(raw.output || "");
    if (status === "running") {
      status = "lost";
      output += `${output ? "\n" : ""}[process lost after gateway restart]\n`;
    }
    return {
      id: String(raw.id || id),
      child: null,
      command: String(raw.command || ""),
      purpose: String(raw.purpose || ""),
      kind: raw.kind === "test" ? "test" : "command",
      cwd,
      tempRoot,
      status,
      exitCode: raw.exitCode ?? null,
      output,
      readOffset: 0,
      startedAt: Number(raw.startedAt || Date.now()),
      updatedAt: Date.now(),
      timedOut: !!raw.timedOut,
      restored: true,
    };
  } catch {
    return null;
  }
}

function supervisedShellPayload(command, startGateToken, processTreeToken) {
  const windows = process.platform === "win32";
  return Buffer.from(JSON.stringify({
    // Windows launcher uses shell:true for the original command string. This
    // preserves cmd.exe quoting semantics for commands such as node -e "...",
    // while the launcher and all shell descendants remain inside the Job.
    command: windows ? command : "/bin/bash",
    args: windows
      ? []
      : ["-lc", command],
    parentPid: process.pid,
    startGateToken,
    processTreeToken,
  }), "utf8").toString("base64url");
}

function reserveProcessRuntimeLease(runtimeTaskId, runtimeLeaseId) {
  if (!runtimeTaskId) return;
  const result = upsertTaskRuntimeLease({
    leaseId: runtimeLeaseId,
    taskId: runtimeTaskId,
    ownerInstance: processRuntimeOwner,
    ownerPid: process.pid,
    workerPid: null,
    workerIdentity: "",
    ttlMs: PROCESS_RUNTIME_RESERVATION_TTL_MS,
  });
  if (result?.changes !== 1) {
    throw new Error("SQLite runtime lease reservation was not persisted");
  }
}

function requestLongProcessStop(entry) {
  if (!entry?.child || entry.runtimeTreeSettled) return;
  entry.runtimeTerminationRequested = true;
  let requested = false;
  if (entry.startGateToken && entry.child.stdin?.writable) {
    try {
      requested = entry.child.stdin.write(`STOP:${entry.startGateToken}\n`);
    } catch {}
  }
  if (!requested && !entry.child.stdin?.writable) {
    terminateProcess(entry.child);
    return;
  }
  if (entry.forceStopTimer) return;
  entry.forceStopTimer = setTimeout(() => {
    if (!entry.runtimeTreeSettled) terminateProcess(entry.child);
  }, 8_000);
  entry.forceStopTimer.unref?.();
}

function startLongProcess(command, cwd, args, ctx) {
  const cmd = authorizeCommand(command, ctx);
  const maxMinutes = clampInt(args.max_minutes, agentConfig().processMaxMinutes || 120, 1, 720);
  const runtimeTaskId = storyRuntimeTaskId(ctx);
  if (ctx.artifactScope?.kind === "story" && !runtimeTaskId) {
    throw new Error("故事点 start_process 缺少可验证的 storyTaskId");
  }
  if (runtimeTaskId && process.platform !== "win32"
    && /(?:^|[;&|()\s])(?:setsid|daemonize|start-stop-daemon|systemd-run)(?:$|[;&|()\s])|\bdisown\b/i.test(cmd)) {
    throw new Error("故事点 start_process 禁止可脱离监督进程组的后台语法");
  }

  // 故事点后台进程必须先有一个不含 worker 的保护性预留租约。只有预留
  // 成功后才允许创建 supervisor；真实 shell 又会被 supervisor 的门闩
  // 挡住，直到 supervisor PID 与不可变启动身份都写回同一租约。
  const runtimeLeaseId = runtimeTaskId ? `${processRuntimeOwner}:${randomUUID()}` : "";
  if (runtimeTaskId) {
    try {
      reserveProcessRuntimeLease(runtimeTaskId, runtimeLeaseId);
    } catch (error) {
      throw new Error(`无法预登记故事点后台进程运行租约: ${error.message}`);
    }
  }

  const startGateToken = randomUUID();
  const processTreeToken = randomUUID();
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        API_PROCESS_SUPERVISOR,
        supervisedShellPayload(cmd, startGateToken, processTreeToken),
      ],
      {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
  } catch (error) {
    if (runtimeLeaseId) {
      try { removeTaskRuntimeLease(runtimeLeaseId, processRuntimeOwner); } catch {}
    }
    throw error;
  }

  const entry = {
    id: randomUUID(), child, command: cmd, purpose: String(args.purpose || ""), kind: args.kind === "test" ? "test" : "command",
    cwd, tempRoot: ctx.tempRoot || "", status: "running", exitCode: null, output: "", readOffset: 0, startedAt: Date.now(), updatedAt: Date.now(), timedOut: false,
    runtimeTaskId,
    runtimeLeaseId,
    runtimeWorkerIdentity: "",
    runtimeWorkerRegistered: false,
    runtimeLeaseHeartbeatAt: runtimeTaskId ? Date.now() : 0,
    runtimeLeaseReleased: false,
    runtimeTreeSettled: false,
    runtimeTerminationRequested: false,
    startGateToken,
    forceStopTimer: null,
  };
  processes.set(entry.id, entry);
  persistProcessSnapshot(entry);
  // EPIPE can race with a very short command or a supervisor shutdown. Always
  // observe the stream error so it cannot become an uncaught Gateway error.
  child.stdin?.on("error", () => {});
  child.stdout?.on("data", (chunk) => appendProcessOutput(entry, "stdout", chunk));
  child.stderr?.on("data", (chunk) => appendProcessOutput(entry, "stderr", chunk));
  const detachAbort = () => ctx.signal?.removeEventListener?.("abort", entry.abortListener);
  entry.abortListener = () => {
    if (entry.status !== "running") return;
    entry.status = "stopped";
    entry.runtimeTerminationRequested = true;
    appendProcessOutput(entry, "stderr", "任务被用户手动终止\n");
    requestLongProcessStop(entry);
  };
  if (ctx.signal?.aborted) entry.abortListener();
  else ctx.signal?.addEventListener?.("abort", entry.abortListener, { once: true });
  child.on("error", (error) => {
    detachAbort();
    entry.status = "failed";
    entry.runtimeTerminationRequested = true;
    appendProcessOutput(entry, "stderr", error.message);
    if (!child.pid) {
      entry.runtimeTreeSettled = true;
      releaseProcessRuntimeLease(entry);
      persistProcessSnapshot(entry);
      scheduleProcessCleanup(entry);
    } else {
      requestLongProcessStop(entry);
    }
  });
  child.on("close", (code) => {
    detachAbort();
    entry.runtimeTreeSettled = true;
    entry.exitCode = code;
    if (entry.status === "running") entry.status = code === 0 ? "completed" : "failed";
    entry.updatedAt = Date.now();
    clearTimeout(entry.timeout);
    clearTimeout(entry.forceStopTimer);
    releaseProcessRuntimeLease(entry);
    persistProcessSnapshot(entry);
    scheduleProcessCleanup(entry);
  });
  entry.timeout = setTimeout(() => {
    if (entry.status !== "running") return;
    entry.status = "timeout";
    entry.timedOut = true;
    entry.runtimeTerminationRequested = true;
    requestLongProcessStop(entry);
  }, maxMinutes * 60 * 1000);
  entry.timeout.unref?.();

  startProcessTreeWatchdog(child.pid, process.pid).catch(() => {});
  if (runtimeTaskId) {
    entry.runtimeWorkerIdentity = captureProcessIdentity(child.pid);
    entry.runtimeWorkerRegistered = true;
    try {
      if (!refreshProcessRuntimeLease(entry)) throw new Error("SQLite runtime lease was not persisted");
    } catch (error) {
      entry.runtimeWorkerRegistered = false;
      entry.status = "failed";
      entry.runtimeTerminationRequested = true;
      appendProcessOutput(entry, "stderr", `无法建立后台进程运行租约: ${error.message}\n`);
      requestLongProcessStop(entry);
      throw new Error(`无法建立故事点后台进程运行租约: ${error.message}`);
    }
    if (!entry.runtimeWorkerIdentity) {
      captureProcessIdentityAsync(child.pid).then((identity) => {
        if (identity && entry.status === "running") {
          entry.runtimeWorkerIdentity = identity;
          try { refreshProcessRuntimeLease(entry); } catch {}
        }
      }).catch(() => {});
    }
  }

  try {
    // 不关闭 stdin：它同时是 owner-liveness 管道。Gateway 崩溃或重启时
    // 管道 EOF 会让 supervisor 立即收敛整棵进程树，规避父 PID 复用。
    child.stdin.write(`${startGateToken}\n`);
  } catch (error) {
    entry.status = "failed";
    entry.runtimeTerminationRequested = true;
    appendProcessOutput(entry, "stderr", `无法放行后台进程监督器: ${error.message}\n`);
    requestLongProcessStop(entry);
    throw new Error(`无法放行后台进程监督器: ${error.message}`);
  }
  return entry;
}

function patchPaths(patch) {
  const paths = [];
  for (const line of String(patch).split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+|rename from|rename to)\s+(.+?)(?:\t.*)?$/);
    if (!match) continue;
    let value = match[1].trim().replace(/^"|"$/g, "");
    if (value === "/dev/null") continue;
    if (/^[ab]\//.test(value)) value = value.slice(2);
    paths.push(value);
  }
  return paths;
}

function gitApply(cwd, patch, checkOnly) {
  return new Promise((resolveApply) => {
    const args = ["apply", ...(checkOnly ? ["--check"] : []), "--whitespace=nowarn", "-"];
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolveApply({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolveApply({ exitCode: code, stdout, stderr }));
    child.stdin.end(patch);
  });
}

/** Execute one tool and return a compact text result for the model. */
export async function executeTool(name, args = {}, ctx = {}) {
  try {
    if (ctx.signal?.aborted) throw new Error("用户手动终止");
    if (isAppMarketMcpTool(name)) {
      return await callAppMarketMcpTool(name, args, { signal: ctx.signal || null });
    }
    if (MUTATING_TOOLS.has(name) && commandPolicy(ctx) === "read_only") assertWriteAllowed(ctx);
    switch (name) {
      case "search_files": {
        const searchRoot = resolveWorkspacePath(args.path || ".", ctx);
        const maxResults = clampInt(args.max_results, 200, 1, 1000);
        const rgArgs = ["--line-number", "--column", "--no-heading", "--color=never", "--glob", "!.git/**", "--glob", "!node_modules/**"];
        if (!args.case_sensitive) rgArgs.push("--ignore-case");
        if (args.glob) rgArgs.push("--glob", String(args.glob));
        rgArgs.push("--", String(args.pattern || ""), searchRoot);
        const result = await execFileResult("rg", rgArgs, { cwd: resolveBaseDir(ctx), signal: ctx.signal || undefined });
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          if (/ENOENT|not found|not recognized|找不到/i.test(String(result.stderr || ""))) {
            return fallbackSearchFiles({
              pattern: args.pattern || "",
              root: searchRoot,
              glob: args.glob || "",
              caseSensitive: !!args.case_sensitive,
              maxResults,
              signal: ctx.signal,
            });
          }
          return `搜索失败: ${trimOutput(result.stderr, 4000)}`;
        }
        const lines = String(result.stdout || "").split(/\r?\n/).filter(Boolean);
        const shown = lines.slice(0, maxResults);
        return `${shown.join("\n") || "(未找到匹配)"}${lines.length > maxResults ? `\n...(还有 ${lines.length - maxResults} 条结果未显示)` : ""}`;
      }
      case "read_file": {
        const file = resolveWorkspacePath(args.path, ctx);
        if (!existsSync(file)) return `错误: 文件不存在 ${args.path}`;
        const stat = statSync(file);
        if (stat.isDirectory()) return `错误: ${args.path} 是目录`;
        if (args.start_byte != null || args.max_bytes != null) {
          const startByte = clampInt(args.start_byte, 0, 0, stat.size);
          const maxBytes = clampInt(args.max_bytes, 65_536, 1, MAX_TOOL_OUTPUT);
          const endByte = Math.min(stat.size, startByte + maxBytes);
          const size = Math.max(0, endByte - startByte);
          const buffer = Buffer.alloc(size);
          const fd = openSync(file, "r");
          let bytesRead = 0;
          try {
            bytesRead = readSync(fd, buffer, 0, size, startByte);
          } finally {
            closeSync(fd);
          }
          const body = buffer.subarray(0, bytesRead).toString("utf8");
          const actualEnd = startByte + bytesRead;
          const displayEnd = bytesRead > 0 ? actualEnd - 1 : startByte;
          const next = actualEnd < stat.size ? `; next_start_byte=${actualEnd}` : "";
          return `[${args.path}: bytes ${startByte}-${displayEnd} of ${stat.size}${next}]\n${body || "(no bytes read)"}`;
        }
        if (stat.size > MAX_READ_BYTES) return `错误: 文件过大 (${stat.size} 字节)，请使用 search_files 定位内容`;
        const lines = readFileSync(file, "utf-8").split(/\r?\n/);
        const start = clampInt(args.start_line, 1, 1, Math.max(1, lines.length));
        const count = clampInt(args.line_count, 400, 1, 2000);
        const end = Math.min(lines.length, start + count - 1);
        const width = String(end).length;
        const body = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(width, " ")} | ${line}`).join("\n");
        const next = end < lines.length ? `; next_start_line=${end + 1}` : "";
        return `[${args.path}: lines ${start}-${end} of ${lines.length}${next}]\n${body}`;
      }
      case "write_file": {
        assertWriteAllowed(ctx);
        const file = resolveWorkspacePath(args.path, ctx);
        mkdirSync(dirname(file), { recursive: true });
        const content = String(args.content ?? "");
        writeFileSync(file, content, "utf-8");
        return `已写入 ${args.path} (${content.length} 字符)`;
      }
      case "edit_file": {
        assertWriteAllowed(ctx);
        const file = resolveWorkspacePath(args.path, ctx);
        if (!existsSync(file)) return `错误: 文件不存在 ${args.path}`;
        const original = readFileSync(file, "utf-8");
        const oldString = String(args.old_string || "");
        if (!oldString) return "错误: old_string 不能为空";
        const occurrences = original.split(oldString).length - 1;
        if (occurrences !== 1) return `错误: old_string 匹配 ${occurrences} 次，必须精确且唯一`;
        writeFileSync(file, original.replace(oldString, String(args.new_string ?? "")), "utf-8");
        return `已编辑 ${args.path}`;
      }
      case "apply_patch": {
        assertWriteAllowed(ctx);
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const patch = String(args.patch || "");
        if (!patch.trim()) return "错误: patch 不能为空";
        if (patch.includes("*** Begin Patch")) return "错误: apply_patch 需要 unified diff，请改用 diff --git / --- / +++ / @@ 格式";
        const paths = patchPaths(patch);
        if (!paths.length) return "错误: 未从补丁中识别到文件路径";
        for (const value of paths) resolveWorkspacePath(resolve(cwd, value), { ...ctx, cwd });
        const checked = await gitApply(cwd, patch, true);
        if (checked.exitCode !== 0) return `补丁校验失败:\n${trimOutput(checked.stderr || checked.stdout, 12000)}`;
        const applied = await gitApply(cwd, patch, false);
        if (applied.exitCode !== 0) return `补丁应用失败:\n${trimOutput(applied.stderr || applied.stdout, 12000)}`;
        return `补丁已应用 (${new Set(paths).size} 个文件)`;
      }
      case "list_dir": {
        const dir = resolveWorkspacePath(args.path || ".", ctx);
        if (!existsSync(dir)) return `错误: 目录不存在 ${args.path || "."}`;
        if (!statSync(dir).isDirectory()) return `错误: ${args.path} 不是目录`;
        const entries = readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
          .slice(0, 500)
          .map((entry) => `${entry.isDirectory() ? "[dir] " : "[file]"} ${entry.name}`);
        return entries.join("\n") || "(空目录)";
      }
      case "git_status": {
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const result = await execFileResult(
          "git",
          gitReadOnlyArgs(cwd, ["status", "--short", "--branch", "--untracked-files=all"]),
          { cwd, ...gitReadOnlyOptions(ctx) },
        );
        return result.exitCode === 0 ? (result.stdout || "(工作区干净)") : `git status 失败: ${trimOutput(result.stderr, 8000)}`;
      }
      case "git_diff": {
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const gitArgs = ["diff", "--no-ext-diff", "--no-textconv"];
        if (args.staged) gitArgs.push("--staged");
        if (args.stat) gitArgs.push("--stat");
        if (args.file) {
          gitArgs.push("--", gitRepoRelativeFile(cwd, args.file, ctx, { required: true }));
        }
        const result = await execFileResult(
          "git",
          gitReadOnlyArgs(cwd, gitArgs),
          { cwd, ...gitReadOnlyOptions(ctx) },
        );
        const max = clampInt(args.max_chars, 20_000, 1000, 100_000);
        return result.exitCode === 0 ? (trimOutput(result.stdout, max) || "(无差异)") : `git diff 失败: ${trimOutput(result.stderr, 8000)}`;
      }
      case "git_inspect":
        return await executeGitInspect(args, ctx);
      case "run_bash":
      case "run_command": {
        const command = authorizeCommand(args.command, ctx);
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const timeout = clampInt(args.timeout_seconds, agentConfig().commandTimeoutSeconds || 120, 1, 600) * 1000;
        const result = assertShellTerminationConverged(
          await runShell(command, cwd, timeout, ctx.signal),
          name,
        );
        return formatCommandResult(result);
      }
      case "run_tests": {
        const command = authorizeCommand(args.command, ctx);
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const timeout = clampInt(args.timeout_seconds, 600, 1, 1800) * 1000;
        const result = assertShellTerminationConverged(
          await runShell(command, cwd, timeout, ctx.signal),
          name,
        );
        const output = `${result.stdout || ""}\n${result.stderr || ""}`;
        const parsed = parseTestOutput(output, result.exitCode, result.timedOut);
        return `test_summary: ${JSON.stringify(parsed)}\n${formatCommandResult(result)}`;
      }
      case "start_process": {
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const entry = startLongProcess(args.command, cwd, args, ctx);
        return JSON.stringify({ process_id: entry.id, status: entry.status, pid: entry.child.pid, kind: entry.kind, started_at: entry.startedAt });
      }
      case "poll_process": {
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const entry = processes.get(String(args.process_id || ""))
          || loadPersistedProcess(cwd, String(args.process_id || ""), ctx.tempRoot);
        if (!entry) return "error: process_id not found or expired";
        const explicitCursor = args.cursor != null;
        const cursor = explicitCursor
          ? clampInt(args.cursor, 0, 0, entry.output.length)
          : entry.readOffset;
        const maxChars = clampInt(args.max_chars, MAX_TOOL_OUTPUT, 1, MAX_TOOL_OUTPUT);
        const nextCursor = Math.min(entry.output.length, cursor + maxChars);
        const output = entry.output.slice(cursor, nextCursor);
        if (!explicitCursor) entry.readOffset = nextCursor;
        const result = {
          process_id: entry.id,
          status: entry.status,
          exit_code: entry.exitCode,
          running: entry.status === "running",
          output: output || "(no new output)",
          cursor,
          nextCursor,
          truncated: nextCursor < entry.output.length,
          totalOutputChars: entry.output.length,
          restored: !!entry.restored,
        };
        if (entry.kind === "test" && entry.status !== "running") result.test_summary = parseTestOutput(entry.output, entry.exitCode, entry.timedOut);
        persistProcessSnapshot(entry);
        return JSON.stringify(result);
      }
      case "stop_process": {
        const cwd = resolveWorkspacePath(args.path || ".", ctx);
        const entry = processes.get(String(args.process_id || ""))
          || loadPersistedProcess(cwd, String(args.process_id || ""), ctx.tempRoot);
        if (!entry) return "错误: process_id 不存在或已过期";
        if (entry.status === "running" && entry.child) {
          entry.status = "stopped";
          requestLongProcessStop(entry);
        }
        persistProcessSnapshot(entry);
        return JSON.stringify({ process_id: entry.id, status: entry.status, exit_code: entry.exitCode });
      }
      case "read_binary_metadata":
      case "inspect_image": {
        const file = resolveWorkspacePath(args.path, ctx);
        if (!existsSync(file)) return `错误: 文件不存在 ${args.path}`;
        const stat = statSync(file);
        if (stat.isDirectory()) return `错误: ${args.path} 是目录`;
        const metadata = binaryMetadata(file, stat);
        if (name === "inspect_image" && !String(metadata.mime || "").startsWith("image/")) {
          return `错误: ${args.path} 不是支持的图片文件 (${metadata.mime})`;
        }
        return JSON.stringify({
          path: args.path,
          ...metadata,
          note: name === "inspect_image"
            ? "Local inspect_image returned metadata only. Agent V2 can forward image bytes to a configured vision backend for OCR/visual analysis."
            : undefined,
        });
      }
      case "inspect_pdf": {
        const file = resolveWorkspacePath(args.path, ctx);
        if (!existsSync(file)) return `error: file not found: ${args.path}`;
        const stat = statSync(file);
        if (stat.isDirectory()) return `error: ${args.path} is a directory`;
        const inspected = await inspectPdfFile(file, stat, args, ctx);
        if (inspected.error) return `error: ${args.path} is not a PDF file (${inspected.metadata?.mime || "unknown"})`;
        return JSON.stringify(inspected);
      }
      case "list_archive": {
        const file = resolveWorkspacePath(args.path, ctx);
        if (!existsSync(file)) return `错误: 文件不存在 ${args.path}`;
        const stat = statSync(file);
        if (stat.isDirectory()) return `错误: ${args.path} 是目录`;
        const metadata = binaryMetadata(file, stat);
        if (metadata.mime !== "application/zip") return `错误: ${args.path} 不是 ZIP 文件 (${metadata.mime})`;
        const maxEntries = clampInt(args.max_entries, 200, 1, 2000);
        return JSON.stringify({ path: args.path, ...metadata, archive: await listZipArchive(file, stat, maxEntries) });
      }
      case "extract_archive_entry": {
        const file = resolveWorkspacePath(args.path, ctx);
        if (!existsSync(file)) return `错误: 文件不存在 ${args.path}`;
        const stat = statSync(file);
        if (stat.isDirectory()) return `错误: ${args.path} 是目录`;
        const maxBytes = clampInt(args.max_bytes, 1024 * 1024, 1, MAX_ARCHIVE_ENTRY_BYTES);
        const extracted = await extractZipEntry({
          file,
          stat,
          entryPath: args.entry_path,
          outputPath: args.output_path || "",
          ctx,
          maxBytes,
        });
        return JSON.stringify({ path: args.path, ...extracted });
      }
      case "inspect_video": {
        const file = resolveWorkspacePath(args.path, ctx);
        if (!existsSync(file)) return `错误: 文件不存在 ${args.path}`;
        const stat = statSync(file);
        if (stat.isDirectory()) return `错误: ${args.path} 是目录`;
        const metadata = binaryMetadata(file, stat, { allowLarge: true });
        if (!String(metadata.mime || "").startsWith("video/")) return `错误: ${args.path} 不是视频文件 (${metadata.mime})`;
        return JSON.stringify(await inspectVideoFile(file, args, ctx));
      }
      default:
        return `错误: 未知工具 ${name}`;
    }
  } catch (error) {
    if (error?.code === "API_TOOL_TERMINATION_UNCONFIRMED" && error?.terminalFailure === true) throw error;
    return `工具执行异常: ${error.message}`;
  }
}

export function getProcessSnapshot(processId) {
  const entry = processes.get(processId);
  if (!entry) return null;
  return { id: entry.id, status: entry.status, exitCode: entry.exitCode, output: entry.output, kind: entry.kind };
}

export function clearToolProcessesForTest() {
  processes.clear();
}
