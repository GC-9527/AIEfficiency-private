import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("../services/devbench/index.js", import.meta.url)), "utf8");
const start = source.indexOf("export async function continueGroupDevelopment");
const end = source.indexOf("\nexport ", start + 1);
const implementation = source.slice(start, end > start ? end : source.length);

test("组内续跑不再要求 TB 全来源齐备，但仍保留复核、目标和应用指纹门禁", () => {
  assert.equal(start >= 0, true);
  assert.doesNotMatch(implementation, /sourceCoverageGate\?\.complete/);
  assert.match(implementation, /reviewedRun\?\.review/);
  assert.match(implementation, /reviewedTargets\.length/);
  assert.match(implementation, /configInferenceAppliedTargetFingerprint/);
  assert.match(implementation, /configInferenceTargetGraphFingerprint\(actualTargets\)/);
});
