#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createConfigInferenceDatasetVersion,
  evaluateConfigInferenceDataset,
  renderConfigInferenceEvaluationHtml,
  validateConfigInferenceDataset,
} from "../services/devbench/machine-learn/evaluator.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.resolve(SCRIPT_DIR, "..");

function usage() {
  console.log(`用法:
  node tools/evaluate-config-inference.mjs --input <dataset.json> [--split test] [--output report.json] [--html report.html] [--fail-on-leak]

输入 schema:
  {
    "datasetVersion": "golden-v1",
    "cases": [{
      "id": "CARB-1",
      "split": "test",
      "inferenceAt": "2026-01-01T00:00:00Z",
      "evidence": [{"availableAt": "2025-12-31T00:00:00Z"}],
      "prediction": {"status":"NEED_HUMAN_CONFIRMATION","confidenceScore":0.8,"targets":[]},
      "approvedLabel": {"status":"approved","targets":[]}
    }]
  }`);
}

function args(argv) {
  const result = { split: "", failOnLeak: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--input") result.input = argv[++index];
    else if (value === "--output") result.output = argv[++index];
    else if (value === "--html") result.html = argv[++index];
    else if (value === "--split") result.split = argv[++index];
    else if (value === "--fail-on-leak") result.failOnLeak = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

function resolveFile(value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(GATEWAY_DIR, value);
}

let options;
try {
  options = args(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(2);
}
if (options.help || !options.input) {
  usage();
  process.exit(options.help ? 0 : 2);
}

const inputPath = resolveFile(options.input);
let dataset;
try {
  dataset = JSON.parse(fs.readFileSync(inputPath, "utf8"));
} catch (error) {
  console.error(`读取评测集失败：${error.message}`);
  process.exit(2);
}

const versioned = dataset.hash && dataset.validation
  ? dataset
  : createConfigInferenceDatasetVersion(dataset);
const validation = validateConfigInferenceDataset(versioned);
const report = {
  ...evaluateConfigInferenceDataset(versioned, { split: options.split }),
  datasetHash: versioned.hash,
  validation,
};

if (options.output) {
  const outputPath = resolveFile(options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (options.html) {
  const htmlPath = resolveFile(options.html);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, renderConfigInferenceEvaluationHtml(report, validation), "utf8");
}
if (!options.output) console.log(JSON.stringify(report, null, 2));
if (options.failOnLeak && !validation.ok) process.exit(1);
