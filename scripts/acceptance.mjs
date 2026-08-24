#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function npmCommand(args) {
  if (process.platform !== "win32") return { cmd: "npm", args };

  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.cjs"),
  ].filter(Boolean);
  const cli = candidates.find((p) => /\.(c?js)$/i.test(p) && existsSync(p));
  if (cli) return { cmd: process.execPath, args: [cli, ...args] };

  return { cmd: "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] };
}

function npmStep(name, cwd, args) {
  return { name, cwd, ...npmCommand(args) };
}

function has(flag) {
  return argv.includes(flag);
}

function valueOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : "";
}

if (has("--help") || has("-h")) {
  console.log(`Usage: node scripts/acceptance.mjs [options]

Runs deterministic local acceptance checks for this repository.

Options:
  --quick             Run unit/integration tests only; skip bug-agent and build.
  --skip-bug-agent    Skip gateway bug-agent smoke/regression tests.
  --skip-build        Skip web-dashboard production build.
  --only <target>     Limit to "gateway" or "web".
`);
  process.exit(0);
}

const quick = has("--quick");
const only = valueOf("--only").toLowerCase();
if (only && !["gateway", "web"].includes(only)) {
  console.error(`Invalid --only target: ${only}`);
  process.exit(2);
}

const steps = [];
if (!only || only === "gateway") {
  steps.push(npmStep("AppMarket MCP tests", path.join(root, "mcp-servers", "devServer"), ["test"]));
  steps.push(npmStep("AppMarket MCP stdio smoke", path.join(root, "mcp-servers", "devServer"), ["run", "smoke"]));
  steps.push(npmStep("gateway npm test", path.join(root, "gateway"), ["test"]));
  if (!quick && !has("--skip-bug-agent")) {
    steps.push(npmStep("gateway bug-agent tests", path.join(root, "gateway"), ["run", "test:bug-agent"]));
  }
}
if (!only || only === "web") {
  steps.push(npmStep("web-dashboard npm test", path.join(root, "web-dashboard"), ["test"]));
  if (!quick && !has("--skip-build")) {
    steps.push(npmStep("web-dashboard production build", path.join(root, "web-dashboard"), ["run", "build"]));
  }
}

const results = [];
const startedAt = Date.now();
for (const step of steps) {
  const t0 = Date.now();
  console.log(`\n=== ${step.name} ===`);
  const r = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    env: process.env,
    stdio: "inherit",
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const code = r.error ? 1 : (r.status ?? 1);
  results.push({ ...step, ok: code === 0, code, seconds, error: r.error?.message || "" });
  if (code !== 0) {
    console.error(`\nFAILED: ${step.name}${r.error ? ` (${r.error.message})` : ""}`);
    break;
  }
}

console.log("\n=== acceptance summary ===");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} (${r.seconds}s)`);
}
const failed = results.filter((r) => !r.ok);
const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Total: ${results.length}/${steps.length} steps completed in ${totalSeconds}s`);

if (failed.length) process.exit(failed[0].code || 1);
process.exit(0);
