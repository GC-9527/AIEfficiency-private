import fs from "node:fs";
import { spawn } from "node:child_process";
import { resolveWindowsCliSpawnSpec } from "./windows-cli-spawn.js";

const gatePath = String(process.env.AIEFF_CLI_JOB_GATE || "");
const encodedPayload = String(process.env.AIEFF_CLI_JOB_PAYLOAD || "");
const deadline = Date.now() + 15_000;

while (gatePath && !fs.existsSync(gatePath) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!gatePath || !fs.existsSync(gatePath)) {
  process.stderr.write("CLI Job launcher 等待门闩超时\n");
  process.exit(124);
}
try { fs.unlinkSync(gatePath); } catch {}

let payload;
try {
  payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
} catch {
  process.stderr.write("CLI Job launcher payload 无效\n");
  process.exit(125);
}

const command = String(payload.command || "");
const spawnSpec = resolveWindowsCliSpawnSpec(command, payload.args, { env: process.env });
const child = spawn(spawnSpec.command, spawnSpec.args, {
  cwd: process.cwd(),
  shell: false,
  windowsHide: true,
  env: { ...process.env },
  stdio: "inherit",
});
child.once("error", (error) => {
  process.stderr.write(`启动 CLI 失败: ${error.message}\n`);
  process.exit(127);
});
child.once("exit", (code, signal) => {
  process.exit(Number.isInteger(code) ? code : (signal ? 128 : 0));
});
