#!/usr/bin/env node
import {
  formatWorkerDeploymentFailure,
  runWorkerIsolationDeploymentPreflight,
} from "./services/worker-isolation-deployment.js";

function usage() {
  return [
    "用法：",
    "  node gateway/worker-isolation-preflight.mjs --story-id <故事点ID>",
    "  node gateway/worker-isolation-preflight.mjs --story-id <故事点ID> --static",
    "",
    "默认执行真实受管 launcher 跨身份探测；--static 只检查固定配置，结果仍为 BLOCKED。",
    "命令不接受 launcher 路径、任意 command/args/env 或密钥参数。",
  ].join("\n");
}

function parseArgs(argv) {
  const input = argv.slice(2);
  let storyId = "";
  let staticOnly = false;
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--static") {
      staticOnly = true;
      continue;
    }
    if (arg === "--story-id") {
      if (storyId || !input[index + 1] || input[index + 1].startsWith("-")) {
        throw new Error("--story-id 必须且只能提供一次非空值");
      }
      storyId = input[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`不支持的参数：${arg}`);
  }
  if (!storyId.trim()) throw new Error("缺少 --story-id");
  return { storyId: storyId.trim(), staticOnly };
}

let result;
try {
  const options = parseArgs(process.argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  result = runWorkerIsolationDeploymentPreflight(options);
} catch (error) {
  result = formatWorkerDeploymentFailure(error);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok === true && result.status === "READY" ? 0 : 2);
