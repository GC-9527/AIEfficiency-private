import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const NODE_ENTRY_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

function locateWindowsCommand(command, env) {
  const raw = String(command || "").trim();
  if (!raw || /[\\/]/.test(raw) || path.win32.extname(raw)) return raw;
  try {
    const found = spawnSync("where.exe", [raw], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env,
    });
    const candidates = String(found.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const executable = candidates.find((candidate) => {
      const ext = path.win32.extname(candidate).toLowerCase();
      return WINDOWS_NATIVE_EXTENSIONS.has(ext) || [".cmd", ".bat", ".ps1"].includes(ext);
    });
    return executable || candidates[0] || raw;
  } catch {
    return raw;
  }
}

/**
 * npm 在 Windows 上通常生成 .cmd shim。直接对该 shim 使用 shell:true 会让
 * Node 把参数拼成一条未转义的命令串；包含空格/引号的 Codex -c TOML 参数会被拆散。
 * 标准 npm shim 已经声明真实的 JS/EXE 入口，这里解析入口后直接执行，完整保留 argv。
 */
function resolveNpmShimTarget(shimPath) {
  let source = "";
  try {
    source = readFileSync(shimPath, "utf8");
  } catch {
    return "";
  }
  const matches = [...source.matchAll(/"(%dp0%[\\/][^"\r\n]+)"\s+%\*/gi)];
  const token = matches.at(-1)?.[1] || "";
  if (!token) return "";
  const relative = token.replace(/^%dp0%[\\/]?/i, "").replace(/[\\/]/g, path.win32.sep);
  const target = path.win32.resolve(path.win32.dirname(shimPath), relative);
  return existsSync(target) ? target : "";
}

export function resolveWindowsCliSpawnSpec(command, args = [], options = {}) {
  const env = options.env || process.env;
  const resolved = options.resolvedCommand
    ? String(options.resolvedCommand)
    : locateWindowsCommand(command, env);
  const originalArgs = Array.isArray(args) ? [...args] : [];
  const ext = path.win32.extname(resolved).toLowerCase();

  if (WINDOWS_NATIVE_EXTENSIONS.has(ext)) {
    return { command: resolved, args: originalArgs, shell: false, transport: "native" };
  }

  if (ext === ".cmd" || ext === ".bat") {
    const target = resolveNpmShimTarget(resolved);
    const targetExt = path.win32.extname(target).toLowerCase();
    if (WINDOWS_NATIVE_EXTENSIONS.has(targetExt)) {
      return { command: target, args: originalArgs, shell: false, transport: "npm-native-shim" };
    }
    if (NODE_ENTRY_EXTENSIONS.has(targetExt)) {
      const localNode = path.win32.join(path.win32.dirname(resolved), "node.exe");
      return {
        command: existsSync(localNode) ? localNode : (options.execPath || process.execPath),
        args: [target, ...originalArgs],
        shell: false,
        transport: "npm-node-shim",
      };
    }
    // 非标准批处理仍显式调用 cmd.exe；spawn 本身始终 shell:false，避免 DEP0190。
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", resolved, ...originalArgs],
      shell: false,
      transport: "cmd-fallback",
    };
  }

  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...originalArgs],
      shell: false,
      transport: "powershell-script",
    };
  }

  // PATH 中找不到可解析入口时保留历史命令查找语义，但不再开启 Node shell 模式。
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", resolved || String(command || ""), ...originalArgs],
    shell: false,
    transport: "cmd-fallback",
  };
}
