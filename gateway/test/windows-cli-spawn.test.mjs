import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexAppMarketMcpOverrideArgs } from "../services/appmarket-admin-mcp.js";

const supervisorPath = path.resolve("services", "cli-supervisor.js");

function waitForExit(child, timeoutMs = 15_000) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Windows CLI 参数保真回归测试超时")), timeoutMs).unref();
    }),
  ]);
}

test("CARB-13546：Windows Codex npm shim 保持 MCP TOML 参数边界且不触发 DEP0190", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "carb-13546-codex-shim-"));
  const cliPath = path.join(tempDir, "node_modules", "fake-codex", "bin", "codex.mjs");
  const shimPath = path.join(tempDir, "codex.cmd");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, [
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  process.stdout.write(`${JSON.stringify({ args: process.argv.slice(2), input })}\\n`);',
    '});',
  ].join("\n"), "utf8");
  fs.writeFileSync(shimPath, [
    "@ECHO off",
    "SETLOCAL",
    'SET "dp0=%~dp0"',
    '"node" "%dp0%\\node_modules\\fake-codex\\bin\\codex.mjs" %*',
    "",
  ].join("\r\n"), "utf8");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const expectedArgs = [
    "exec",
    "--skip-git-repo-check",
    "--json",
    ...codexAppMarketMcpOverrideArgs({ serverDir: path.join(tempDir, "server with spaces") }),
    "-c",
    'probe.value="A & B | C"',
    "-",
  ];
  const payload = Buffer.from(JSON.stringify({
    command: "codex",
    args: expectedArgs,
    parentPid: process.pid,
  }), "utf8").toString("base64url");
  const child = spawn(process.execPath, [supervisorPath, payload], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end("CARB-13546 prompt");

  const exit = await waitForExit(child);
  assert.deepEqual(exit, { code: 0, signal: null }, stderr || stdout);
  assert.doesNotMatch(stderr, /DEP0190|shell option true/i);
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result.args, expectedArgs);
  assert.equal(result.input, "CARB-13546 prompt");
  assert.ok(result.args.some((arg) => arg.includes("APPMARKET_ADMIN_PASSWORD")));
});
