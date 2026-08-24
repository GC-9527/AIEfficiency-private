#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  return `Usage:
  npm run accept -- route --task <id> [--manifest context.json] [--dry-run]
  npm run accept -- project --task <id> --mode quick|standard|release [--manifest result.json]
  npm run accept -- story --story <id> --mode auto|fast|standard|critical [--manifest result.json]
  npm run accept -- resume --run <run-id> --manifest result.json

The CLI consumes structured JSON evidence only. It never executes manifest shell commands,
deploys production, or writes back to a source system.`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["dry-run", "help"].includes(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new TypeError(`--${key} requires a value`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function readManifest(file) {
  if (!file) return {};
  const resolved = path.resolve(file);
  const text = fs.readFileSync(resolved, "utf8");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("manifest must be a JSON object");
  }
  return value;
}

function projectMode(value) {
  const mode = String(value || "standard").toLowerCase();
  const mapped = { quick: "PROJECT-QUICK", standard: "PROJECT-STANDARD", release: "PROJECT-RELEASE" }[mode];
  if (!mapped) throw new TypeError(`unsupported project mode: ${value}`);
  return mapped;
}

function storyTier(value) {
  const mode = String(value || "auto").toLowerCase();
  if (mode === "auto") return null;
  const mapped = { fast: "STORY-FAST", standard: "STORY-STANDARD", critical: "STORY-CRITICAL" }[mode];
  if (!mapped) throw new TypeError(`unsupported story mode: ${value}`);
  return mapped;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (args.help || !command) {
    console.log(usage());
    return;
  }
  if (args["dry-run"] && command !== "route") {
    throw new TypeError("--dry-run is supported only by the route command");
  }
  const manifest = readManifest(args.manifest);
  let result;
  if (command === "route" && args["dry-run"]) {
    const { routeAcceptance } = await import("../services/acceptance/core.js");
    result = {
      route: routeAcceptance({
        ...manifest,
        project_task_id: manifest.project_task_id || args.task || null,
      }),
      context: null,
    };
  } else {
    const { default: acceptanceService } = await import("../services/acceptance/service.js");
    if (command === "route") {
      result = acceptanceService.routeTask({
        ...manifest,
        project_task_id: manifest.project_task_id || args.task || null,
      });
    } else if (command === "project") {
      if (!args.task && !manifest.project_task_id) throw new TypeError("--task is required");
      result = acceptanceService.createProjectRun({
        ...manifest,
        project_task_id: manifest.project_task_id || args.task,
        mode: projectMode(args.mode || manifest.mode),
      });
    } else if (command === "story") {
      if (!args.story && !manifest.story_point_id) throw new TypeError("--story is required");
      result = acceptanceService.createStoryRun({
        ...manifest,
        story_point_id: manifest.story_point_id || args.story,
        ...(storyTier(args.mode || manifest.mode) ? { risk_tier: storyTier(args.mode || manifest.mode) } : {}),
      });
    } else if (command === "resume") {
      const runId = args.run || manifest.run_id || manifest.runId;
      if (!runId) throw new TypeError("--run or manifest.run_id is required");
      result = acceptanceService.resumeRun(runId, manifest);
    } else {
      throw new TypeError(`unsupported command: ${command}`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
