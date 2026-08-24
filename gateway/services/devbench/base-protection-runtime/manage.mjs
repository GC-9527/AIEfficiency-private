// This file must be launched by the absolute Node.js path pinned in manifest.json.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_ENV,
  diagnoseManagedRoot,
  guardManagedHook,
  invokeStandaloneController,
} from "./core.mjs";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const managedRoot = path.resolve(runtimeDirectory, "..");
const command = String(process.argv[2] || "");
const argv = process.argv.slice(3);

function option(name) {
  const prefix = `--${name}=`;
  const withValue = argv.find((item) => item.startsWith(prefix));
  if (withValue) return withValue.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function positionalAfterSeparator() {
  const index = argv.indexOf("--");
  return index >= 0 ? argv.slice(index + 1) : [];
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  if (command === "guard") {
    const result = await guardManagedHook(managedRoot, {
      hook: option("hook"),
      args: positionalAfterSeparator(),
      capability: process.env[CAPABILITY_ENV] || "",
    });
    if (!result.ok) {
      process.stderr.write(`devbench: protected repository operation denied (${result.reason}).\n`);
      process.exitCode = 92;
    }
    return;
  }
  if (command === "hooks-uninstall-preview") {
    const result = {
      status: "CONTROLLER_REQUIRED",
      canUninstall: false,
      issues: ["AUTHENTICATED_CONTROLLER_PREVIEW_REQUIRED"],
    };
    print(result);
    process.exitCode = 3;
    return;
  }
  if (command === "hooks-uninstall") {
    const result = invokeStandaloneController(managedRoot, "uninstall", {
      launcher: option("launcher") || "cli",
    });
    print(result);
    process.exitCode = ["UNINSTALLED", "ALREADY_UNINSTALLED"].includes(result.status) ? 0 : 3;
    return;
  }
  if (command === "hooks-diagnose") {
    const result = diagnoseManagedRoot(managedRoot);
    print(result);
    process.exitCode = ["ACTIVE", "ALREADY_UNINSTALLED"].includes(result.status) ? 0 : 3;
    return;
  }
  print({ status: "ERROR", error: `未知命令: ${command || "（空）"}` });
  process.exitCode = 2;
}

await main();
