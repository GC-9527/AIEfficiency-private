import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "performance-resource-artifacts-"));
const runName = "run_dynamic_artifacts";
const runDir = path.join(temp, runName);
const detail = {
  id: "dynamic-artifact-session",
  profile: { artifact_dir: `docs/tempFiles/appmarket-performance/${runName}` },
};
let artifacts;

before(async () => {
  for (const directory of ["flow/ui", "flow/video", "trace", "raw", "analysis"]) {
    fs.mkdirSync(path.join(runDir, ...directory.split("/")), { recursive: true });
  }
  fs.writeFileSync(
    path.join(runDir, "run_manifest.json"),
    JSON.stringify({ session_id: detail.id }),
  );
  fs.writeFileSync(path.join(runDir, "flow/ui/01_home_ready.xml"), "<hierarchy />", "utf8");
  fs.writeFileSync(path.join(runDir, "flow/ui/01_home_ready.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(runDir, "flow/video/segment_001.mp4"), Buffer.from("video-evidence"));
  fs.writeFileSync(path.join(runDir, "trace/appmarket.pftrace"), Buffer.from("trace-evidence"));
  fs.writeFileSync(path.join(runDir, "analysis/analyzer.log"), "analysis log", "utf8");
  fs.writeFileSync(path.join(runDir, "unlisted-secret.txt"), "must stay hidden", "utf8");
  process.env.APPMARKET_PERF_ARTIFACT_ROOT = temp;
  artifacts = await import("../services/performance-resource-artifacts.js");
});

after(() => {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("dynamic UI, recording, trace, and analyzer artifacts are safely listed", () => {
  const listed = artifacts.listResourceArtifacts(detail);
  const paths = listed.map((item) => item.path);
  for (const relative of [
    "flow/ui/01_home_ready.xml",
    "flow/ui/01_home_ready.png",
    "flow/video/segment_001.mp4",
    "trace/appmarket.pftrace",
    "analysis/analyzer.log",
  ]) {
    assert.ok(paths.some((value) => value.endsWith(relative)), relative);
  }
  assert.equal(paths.some((value) => value.endsWith("unlisted-secret.txt")), false);
  const dynamic = listed.filter((item) => item.key.startsWith("run_file."));
  assert.equal(dynamic.length, 5);
});

test("dynamic text can be previewed and binary evidence can be downloaded by opaque key", () => {
  const listed = artifacts.listResourceArtifacts(detail);
  const xml = listed.find((item) => item.path.endsWith("flow/ui/01_home_ready.xml"));
  const video = listed.find((item) => item.path.endsWith("flow/video/segment_001.mp4"));
  assert.ok(xml?.previewable);
  assert.equal(video?.previewable, false);
  assert.equal(artifacts.readResourceArtifact(detail, xml.key).content, "<hierarchy />");
  const opened = artifacts.openResourceArtifactDownload(detail, video.key);
  assert.equal(fs.readFileSync(opened.absolutePath, "utf8"), "video-evidence");
});

test("forged dynamic keys and non-allowlisted files remain inaccessible", () => {
  const forgedTraversal = `run_file.${Buffer.from("../unlisted-secret.txt").toString("base64url")}`;
  const hidden = `run_file.${Buffer.from("unlisted-secret.txt").toString("base64url")}`;
  assert.throws(() => artifacts.openResourceArtifactDownload(detail, forgedTraversal), /未知原始产物 key/);
  assert.throws(() => artifacts.openResourceArtifactDownload(detail, hidden), /未知原始产物 key/);
});
