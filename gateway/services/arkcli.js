/**
 * 火山方舟 Ark CLI（arkcli）：文档要求用 `arkcli helper` / `arkcli +connect` 等接入 Agent。
 * Windows 需全局安装 `@volcengine/ark-cli`，否则会出现「无法将 arkcli 项识别为…」。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const ARKCLI_NPM_PACKAGE = "@volcengine/ark-cli";
export const ARKCLI_INSTALL_CMD = `npm install -g ${ARKCLI_NPM_PACKAGE}@latest`;

function runShell(cmd, args, { timeout = 20000 } = {}) {
  return execFileAsync(cmd, args, {
    shell: true,
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  });
}

/** 本机是否已有 arkcli 命令 */
export async function probeArkCli() {
  try {
    const { stdout, stderr } = await runShell("arkcli", ["--version"], { timeout: 15000 });
    const text = `${stdout || ""}\n${stderr || ""}`.trim();
    const version = (text.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/) || [])[1] || text.split(/\r?\n/)[0] || "";
    return { installed: true, version, error: null };
  } catch (err) {
    return {
      installed: false,
      version: "",
      error: err?.message || "未安装 arkcli（请 npm i -g @volcengine/ark-cli）",
    };
  }
}

/**
 * 全局安装 @volcengine/ark-cli（异步，可能数十秒）。
 * @returns {Promise<{ ok: boolean, installed: boolean, version?: string, output: string, error?: string }>}
 */
export function installArkCli() {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["install", "-g", `${ARKCLI_NPM_PACKAGE}@latest`], {
      shell: true,
      windowsHide: true,
    });
    let output = "";
    proc.stdout?.on("data", (d) => { output += d.toString(); });
    proc.stderr?.on("data", (d) => { output += d.toString(); });
    proc.on("error", (err) => {
      resolve({ ok: false, installed: false, output, error: err?.message || String(err) });
    });
    proc.on("close", async (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          installed: false,
          output,
          error: `npm 安装失败（exit ${code}）。可手动执行：${ARKCLI_INSTALL_CMD}`,
        });
        return;
      }
      const probe = await probeArkCli();
      resolve({
        ok: !!probe.installed,
        installed: !!probe.installed,
        version: probe.version,
        output,
        error: probe.installed ? undefined : (probe.error || "安装后仍找不到 arkcli，请新开终端或检查 npm 全局 PATH"),
      });
    });
  });
}

/**
 * 若未安装则安装；已安装则直接返回探测结果。
 */
export async function ensureArkCliInstalled({ force = false } = {}) {
  if (!force) {
    const probe = await probeArkCli();
    if (probe.installed) {
      return { ok: true, installed: true, version: probe.version, skipped: true, output: "" };
    }
  }
  return installArkCli();
}
