#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(gatewayRoot, "..");
const packageRoot = path.join(
  repoRoot,
  "features",
  "AIBot",
  "DevDocs",
  "Step2",
  "AIEfficiency_Codex_Acceptance_V4_1_Project_StoryPoint",
);
const manifestPath = path.join(packageRoot, "MANIFEST.json");
const failures = [];
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function relativeFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

const manifest = readJson(manifestPath);
record("manifest version", manifest.version === "4.1.0", String(manifest.version));
record("manifest paths unique", new Set(manifest.files.map((entry) => entry.path)).size === manifest.files.length);

for (const entry of manifest.files) {
  const full = path.join(packageRoot, ...entry.path.split("/"));
  if (!fs.existsSync(full)) {
    record(`package file ${entry.path}`, false, "missing");
    continue;
  }
  const bytes = fs.readFileSync(full);
  record(`package hash ${entry.path}`, sha256(bytes) === entry.sha256, sha256(bytes));
  record(`package size ${entry.path}`, bytes.length === entry.size, String(bytes.length));
}

const packageFiles = relativeFiles(packageRoot);
const expectedPackageFiles = [...manifest.files.map((entry) => entry.path), "MANIFEST.json"].sort();
record(
  "package file set",
  JSON.stringify(packageFiles) === JSON.stringify(expectedPackageFiles),
  `${packageFiles.length} files; MANIFEST intentionally does not list itself`,
);

const packageOnlyMetadata = new Set([
  "CHANGELOG.md",
  "README.md",
  "patches/AGENTS-current-to-v4.1.diff",
]);
const landed = manifest.files.filter((entry) => !packageOnlyMetadata.has(entry.path));
for (const entry of landed) {
  const source = path.join(packageRoot, ...entry.path.split("/"));
  const target = path.join(repoRoot, ...entry.path.split("/"));
  if (!fs.existsSync(target)) {
    record(`landed file ${entry.path}`, false, "missing");
    continue;
  }
  record(
    `landed bytes ${entry.path}`,
    fs.readFileSync(source).equals(fs.readFileSync(target)),
    "must stay byte-identical to the reviewed package",
  );
}
record("landed package asset count", landed.length === 23, String(landed.length));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const schemaName of [
  "acceptance-context.schema.json",
  "project-engineering-acceptance.schema.json",
  "runtime-story-point-assurance.schema.json",
]) {
  try {
    ajv.compile(readJson(path.join(repoRoot, "schemas", schemaName)));
    record(`schema ${schemaName}`, true);
  } catch (error) {
    record(`schema ${schemaName}`, false, error.message);
  }
}

for (const skillName of [
  "acceptance-router",
  "project-engineering-acceptance",
  "runtime-story-point-assurance",
]) {
  const text = fs.readFileSync(path.join(repoRoot, ".agents", "skills", skillName, "SKILL.md"), "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  record(`skill frontmatter ${skillName}`, Boolean(frontmatter), frontmatter ? "" : "missing YAML frontmatter");
  record(`skill name ${skillName}`, Boolean(frontmatter?.[1].match(new RegExp(`^name:\\s*${skillName}$`, "m"))));
  record(`skill description ${skillName}`, Boolean(frontmatter?.[1].match(/^description:\s*\S.+$/m)));
}

for (const reviewerName of ["project-engineering-reviewer", "runtime-story-point-reviewer"]) {
  const text = fs.readFileSync(path.join(repoRoot, ".codex", "agents", `${reviewerName}.toml`), "utf8");
  record(`reviewer name ${reviewerName}`, text.includes(`name = "${reviewerName}"`));
  record(`reviewer read-only ${reviewerName}`, /sandbox_mode\s*=\s*"read-only"/.test(text));
  record(`reviewer instructions ${reviewerName}`, /developer_instructions\s*=\s*"""[\s\S]+"""/.test(text));
}

const wrapper = fs.readFileSync(path.join(repoRoot, ".agents", "skills", "story-acceptance-protocol", "SKILL.md"), "utf8");
record("legacy skill is deprecated", /deprecated/i.test(wrapper));
for (const nextSkill of ["acceptance-router", "project-engineering-acceptance", "runtime-story-point-assurance"]) {
  record(`legacy skill routes to ${nextSkill}`, wrapper.includes(nextSkill));
}

const routingCases = fs.readFileSync(path.join(repoRoot, "examples", "routing-cases.md"), "utf8");
const routingRows = routingCases.split(/\r?\n/).filter((line) => /^\|.+\|$/.test(line) && !/^\|\s*-/.test(line)).length - 1;
record("routing example count", routingRows >= 10, String(routingRows));

const portableFiles = landed.map((entry) => entry.path);
const absolutePathPattern = /(?:^|[\s"'`(])(?:[A-Za-z]:[\\/]|file:\/\/)/m;
for (const relative of portableFiles) {
  const text = fs.readFileSync(path.join(repoRoot, ...relative.split("/")), "utf8");
  record(`portable path ${relative}`, !absolutePathPattern.test(text));
}

const cliText = fs.readFileSync(path.join(gatewayRoot, "tools", "accept.mjs"), "utf8");
record("accept CLI does not execute manifest commands", !/node:child_process|\bexec(?:File)?Sync?\b|\bspawnSync?\b/.test(cliText));
const webPackage = readJson(path.join(repoRoot, "web-dashboard", "package.json"));
record(
  "acceptance UI test is in the standard Web pretest",
  String(webPackage.scripts?.pretest || "").includes("aiautowork/acceptanceModel.test.mjs"),
);

for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
}
console.log(`\nAcceptance v4.1 validation: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
