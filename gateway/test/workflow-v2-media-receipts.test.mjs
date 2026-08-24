import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { recordWorkflowV2MaterialToolEvidence } from "../services/api-engine.js";
import { verifyControlledReceiptOutput } from "../services/devbench/workflow-v2/controlled-receipt-evidence.js";
import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";
import { buildStageReceiptRecorder } from "../services/devbench/workflow-v2/receipt-producer.js";
import { WORKFLOW_V2_SCHEMA_IDS } from "../services/devbench/workflow-v2/schema-registry.js";

process.env.NODE_ENV = "test";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-media-receipts-"));
let harnessSequence = 0;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function storageApiFor(storyDirectory) {
  return {
    getStoryStoragePaths: () => ({ storyDirectory }),
    validateStoryStorageTarget: (_tab, targetPath, {
      baseDirectory = storyDirectory,
      createDirectory = false,
      mustExist = false,
      expectedType = "",
    } = {}) => {
      const base = path.resolve(baseDirectory);
      const target = path.resolve(targetPath);
      const relative = path.relative(base, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("path escape");
      if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) throw new Error("symlink base");
      let current = base;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink target");
      }
      if (createDirectory && !fs.existsSync(target)) {
        try { fs.mkdirSync(target); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      }
      if (mustExist && !fs.existsSync(target)) throw new Error("missing target");
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) throw new Error("symlink leaf");
        if (expectedType === "directory" && !stat.isDirectory()) throw new Error("not directory");
        if (expectedType === "file" && !stat.isFile()) throw new Error("not file");
      }
      return target;
    },
  };
}

function createHarness(sourceBytesByName) {
  const id = ++harnessSequence;
  const storyDirectory = path.join(tempRoot, `story-${id}`);
  const generatedRoot = path.join(tempRoot, `generated-${id}`);
  const blobDirectory = path.join(storyDirectory, "workflow-v2", "evidence-blobs");
  fs.mkdirSync(blobDirectory, { recursive: true });
  fs.mkdirSync(generatedRoot, { recursive: true });
  const sources = {};
  const evidenceSnapshots = [];
  for (const [name, value] of Object.entries(sourceBytesByName)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const digest = sha256(bytes);
    const absolutePath = path.join(blobDirectory, `${digest}.blob`);
    fs.writeFileSync(absolutePath, bytes, { flag: "wx" });
    const evidenceId = `evidence-${name}`;
    sources[name] = { absolutePath, digest, evidenceId, sizeBytes: bytes.length };
    evidenceSnapshots.push({
      evidenceId,
      contentRef: `storydev:/workflow-v2/evidence-blobs/${digest}.blob`,
      sizeBytes: bytes.length,
      sha256: digest,
    });
  }
  const receipts = [];
  const storageApi = storageApiFor(storyDirectory);
  const appendReceipt = async ({ revision, idempotencyKey, operationArgs, payload }) => {
    const operationArgsSha256 = canonicalSha256({
      action: payload.action,
      toolName: payload.toolName,
      rootId: payload.rootId ?? null,
      selector: payload.selector ?? null,
      operationArgs,
    });
    const replay = receipts.find((entry) => entry.idempotencyKey === idempotencyKey
      || entry.payload.operationId === payload.operationId);
    if (replay) {
      assert.equal(replay.operationArgsSha256, operationArgsSha256);
      return { replayed: true, envelope: replay };
    }
    const unsigned = {
      schemaVersion: "workflow-envelope-v2",
      storyId: `story-media-${id}`,
      recordId: payload.receiptId,
      contextId: null,
      revision,
      idempotencyKey,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
      payloadSha256: canonicalSha256(payload),
      operationArgsSha256,
      previousEnvelopeSha256: receipts.at(-1)?.envelopeSha256 || null,
      createdAt: "2026-08-08T08:00:00.000Z",
      payload,
    };
    const envelope = { ...unsigned, envelopeSha256: canonicalSha256(unsigned), operationArgs };
    receipts.push(envelope);
    return { replayed: false, envelope };
  };
  const recorder = buildStageReceiptRecorder({
    tab: { id: `story-media-${id}` },
    dispatch: {
      contextId: `context-media-${id}`,
      contextRevision: 1,
      evidenceSnapshots,
    },
    storageApi,
    readEnvelopes: async () => [...receipts],
    appendReceipt,
    now: () => "2026-08-08T08:00:00.000Z",
  });
  return {
    generatedRoot,
    recorder,
    receipts,
    sources,
    storageApi,
    storyDirectory,
    tab: { id: `story-media-${id}` },
  };
}

function materialCall(harness, toolName, sourceName, authorizedArgs, result) {
  return recordWorkflowV2MaterialToolEvidence({
    toolName,
    result,
    authorizedArgs: { rootId: "asset", path: `${sourceName}.blob`, ...authorizedArgs },
    executedArgs: { path: harness.sources[sourceName].absolutePath },
    recorder: harness.recorder,
    cwd: harness.generatedRoot,
    generatedRoot: harness.generatedRoot,
  });
}

test("all six frozen material tools emit READ receipts and video/PDF outputs emit bound CAPTURE receipts", async () => {
  const harness = createHarness({
    image: Buffer.from("image-source"),
    pdf: Buffer.from("pdf-source"),
    video: Buffer.from("video-source"),
    archive: Buffer.from("archive-source"),
  });
  const framePath = path.join(harness.generatedRoot, "frame.png");
  const pagePath = path.join(harness.generatedRoot, "page.png");
  fs.writeFileSync(framePath, "frame bytes", "utf8");
  fs.writeFileSync(pagePath, "page bytes", "utf8");
  const frameSha = sha256(fs.readFileSync(framePath));
  const pageSha = sha256(fs.readFileSync(pagePath));

  await materialCall(harness, "read_binary_metadata", "image", {}, {
    size: harness.sources.image.sizeBytes,
    sha256: harness.sources.image.digest,
  });
  await materialCall(harness, "inspect_image", "image", { prompt: "ocr" }, {
    size: harness.sources.image.sizeBytes,
    sha256: harness.sources.image.digest,
  });
  await materialCall(harness, "inspect_pdf", "pdf", { render_pages: [1] }, {
    pdf: { pageCount: 1 },
    renderedPages: [{ page: 1, path: pagePath, ok: true, error: "", sha256: pageSha }],
  });
  await materialCall(harness, "inspect_video", "video", { timestamps: [0, 2.5] }, {
    metadata: { mime: "video/mp4" },
    frames: [
      { timestamp: 0, path: framePath, ok: true, error: "", sha256: frameSha },
      { timestamp: 2.5, path: "missing.png", ok: false, error: "ffmpeg decode failed", sha256: null },
    ],
  });
  await materialCall(harness, "list_archive", "archive", { max_entries: 20 }, {
    archive: { entries: [], entryCount: 0 },
  });
  await materialCall(harness, "extract_archive_entry", "archive", { entry_path: "readme.txt" }, {
    entryPath: "readme.txt",
    sha256: "a".repeat(64),
    extracted: false,
  });

  const readReceipts = harness.receipts.filter((entry) => entry.payload.action === "READ");
  const captureReceipts = harness.receipts.filter((entry) => entry.payload.action === "CAPTURE");
  assert.equal(readReceipts.length, 6);
  assert.deepEqual(readReceipts.map((entry) => entry.payload.toolName), [
    "read_binary_metadata", "inspect_image", "inspect_pdf", "inspect_video", "list_archive", "extract_archive_entry",
  ]);
  assert.equal(new Set(readReceipts.map((entry) => entry.payload.operationId)).size, 6);
  assert.equal(captureReceipts.length, 3);

  const videoPass = captureReceipts.find((entry) => entry.payload.selector.timestamp === 0).payload;
  const videoFail = captureReceipts.find((entry) => entry.payload.selector.timestamp === 2.5).payload;
  const pdfPass = captureReceipts.find((entry) => entry.payload.selector.page === 1).payload;
  assert.equal(videoPass.status, "PASS");
  assert.equal(videoFail.status, "FAIL");
  assert.equal(pdfPass.status, "PASS");
  assert.equal(videoPass.selector.sourceEvidenceId, harness.sources.video.evidenceId);
  assert.equal(videoPass.selector.contextRevision, 1);
  assert.equal(videoPass.selector.captureKind, "video-frame");
  assert.match(videoPass.outputRef, /^storydev:\/workflow-v2\/capture-output\/[a-f0-9]{64}\.bin$/);
  assert.equal(videoPass.outputRef.includes(videoPass.sha256), true);
  assert.equal(verifyControlledReceiptOutput({ tab: harness.tab, receipt: videoPass, storageApi: harness.storageApi }).valid, true);
  assert.equal(verifyControlledReceiptOutput({ tab: harness.tab, receipt: pdfPass, storageApi: harness.storageApi }).valid, true);
  assert.equal(videoFail.outputRef, undefined);
  assert.equal(videoFail.sha256, undefined);
});

test("failed inspection, tampered manifest bytes, and changed capture output never produce false PASS", async () => {
  const harness = createHarness({ image: Buffer.from("image-source"), video: Buffer.from("video-source") });
  const failed = await materialCall(harness, "inspect_image", "image", {}, "error: unsupported image");
  assert.equal(failed.successful, false);
  assert.equal(harness.receipts.length, 0);

  fs.writeFileSync(harness.sources.image.absolutePath, "tampered source", "utf8");
  await assert.rejects(
    materialCall(harness, "inspect_image", "image", {}, { size: 14, sha256: sha256(Buffer.from("tampered source")) }),
    (error) => error.code === "WORKFLOW_V2_MATERIAL_READ_RECEIPT_MISSING",
  );
  assert.equal(harness.receipts.some((entry) => entry.payload.status === "PASS"), false);

  const framePath = path.join(harness.generatedRoot, "changed-frame.png");
  fs.writeFileSync(framePath, "new frame", "utf8");
  const result = await materialCall(harness, "inspect_video", "video", { timestamps: [1] }, {
    metadata: { mime: "video/mp4" },
    frames: [{ timestamp: 1, path: framePath, ok: true, error: "", sha256: "0".repeat(64) }],
  });
  assert.equal(result.successful, true);
  const capture = harness.receipts.find((entry) => entry.payload.action === "CAPTURE").payload;
  assert.equal(capture.status, "BLOCKED");
  assert.equal(capture.outputRef, undefined);
});

test("capture-output symlink/junction is blocked and a later artifact tamper is detected", async () => {
  const harness = createHarness({ video: Buffer.from("video-source") });
  const framePath = path.join(harness.generatedRoot, "frame.png");
  fs.writeFileSync(framePath, "frame bytes", "utf8");
  const workflowDirectory = path.join(harness.storyDirectory, "workflow-v2");
  const outside = path.join(tempRoot, `capture-outside-${harnessSequence}`);
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(workflowDirectory, "capture-output"), process.platform === "win32" ? "junction" : "dir");
  await materialCall(harness, "inspect_video", "video", { timestamps: [0] }, {
    metadata: { mime: "video/mp4" },
    frames: [{ timestamp: 0, path: framePath, ok: true, error: "", sha256: sha256(fs.readFileSync(framePath)) }],
  });
  const blocked = harness.receipts.find((entry) => entry.payload.action === "CAPTURE").payload;
  assert.equal(blocked.status, "BLOCKED");
  assert.deepEqual(fs.readdirSync(outside), []);

  const clean = createHarness({ video: Buffer.from("video-clean") });
  const cleanFrame = path.join(clean.generatedRoot, "clean-frame.png");
  fs.writeFileSync(cleanFrame, "clean frame", "utf8");
  await materialCall(clean, "inspect_video", "video", { timestamps: [0] }, {
    metadata: { mime: "video/mp4" },
    frames: [{ timestamp: 0, path: cleanFrame, ok: true, error: "", sha256: sha256(fs.readFileSync(cleanFrame)) }],
  });
  const receipt = clean.receipts.find((entry) => entry.payload.action === "CAPTURE").payload;
  const outputPath = path.join(clean.storyDirectory, ...receipt.outputRef.slice("storydev:/".length).split("/"));
  fs.writeFileSync(outputPath, "tampered", "utf8");
  assert.equal(verifyControlledReceiptOutput({ tab: clean.tab, receipt, storageApi: clean.storageApi }).valid, false);
  await assert.rejects(
    clean.recorder.recordCapture({
      sourceAbsolutePath: clean.sources.video.absolutePath,
      generatedAbsolutePath: cleanFrame,
      generatedRoot: clean.generatedRoot,
      expectedSha256: sha256(fs.readFileSync(cleanFrame)),
      toolName: "inspect_video",
      rootId: "asset",
      operationArgs: { rootId: "asset", path: "video.blob", timestamps: [0] },
      captureKind: "video-frame",
      timestamp: 0,
      observedStatus: "PASS",
    }),
    (error) => error.code === "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID",
  );
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
