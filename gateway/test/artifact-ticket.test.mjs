import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectStoryArtifactTicket,
  issueStoryArtifactTicket,
  StoryArtifactSnapshotStore,
  verifyStoryArtifactTicket,
} from "../services/devbench/artifact-ticket.js";

const artifactTicketSource = fs.readFileSync(
  new URL("../services/devbench/artifact-ticket.js", import.meta.url),
  "utf8",
);

function temporaryTree(t, content = "0123456789", storeOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-artifact-ticket-"));
  const file = path.join(root, "artifact.bin");
  fs.writeFileSync(file, content);
  const store = new StoryArtifactSnapshotStore({
    root: path.join(root, "snapshots"),
    ...storeOptions,
  });
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return { root, file, store };
}

async function snapshotSource(tree, {
  now = Date.now(),
  ttlMs = 10_000,
} = {}) {
  const fd = fs.openSync(tree.file, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const snapshot = await tree.store.createSnapshot({
      sourceFd: fd,
      sourceStat: stat,
      now,
      expiresAt: now + ttlMs,
    });
    return { stat, snapshot, now, expiresAt: now + ttlMs };
  } finally {
    fs.closeSync(fd);
  }
}

test("artifact snapshot security probes never block the Gateway event loop", async (t) => {
  assert.doesNotMatch(artifactTicketSource, /\b(?:execFileSync|execSync|spawnSync)\b/);
  assert.doesNotMatch(artifactTicketSource, /\bfs\.fsyncSync\b/);
  assert.doesNotMatch(artifactTicketSource, /\.readSync\(\)/);
  assert.doesNotMatch(artifactTicketSource, /\bopendirSync\b/);
  if (process.platform !== "win32") return;

  const tree = temporaryTree(t, "event-loop-responsive");
  const startedAt = Date.now();
  let timerLagMs = null;
  const timer = new Promise((resolve) => {
    setTimeout(() => {
      timerLagMs = Date.now() - startedAt;
      resolve();
    }, 25);
  });
  await Promise.all([snapshotSource(tree), timer]);
  assert.ok(
    timerLagMs < 300,
    `Windows ACL verification blocked the event loop for ${timerLagMs}ms`,
  );
});

test("repeated snapshot verification is cached so Range streaming never re-hashes the whole file", async (t) => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 7);
  const tree = temporaryTree(t, payload);
  const bound = await snapshotSource(tree);
  const fd = fs.openSync(tree.file, fs.constants.O_RDONLY);
  try {
    const opened = await tree.store.openSnapshot({
      id: bound.snapshot.id,
      expiresAt: bound.expiresAt,
      now: bound.now + 1,
    });
    try {
      const first = await tree.store.verifyOpenedSnapshot({
        fd: opened.fd,
        stat: opened.stat,
        expectedSha256: bound.snapshot.sha256,
        expectedStat: bound.snapshot.stat,
      });
      assert.equal(first, true);
      const cacheSizeBefore = tree.store.verifiedSnapshots.size;
      const second = await tree.store.verifyOpenedSnapshot({
        fd: opened.fd,
        stat: opened.stat,
        expectedSha256: bound.snapshot.sha256,
        expectedStat: bound.snapshot.stat,
      });
      assert.equal(second, true);
      assert.equal(
        tree.store.verifiedSnapshots.size,
        cacheSizeBefore,
        "cached verification must not re-hash the immutable snapshot",
      );
    } finally {
      fs.closeSync(opened.fd);
    }
  } finally {
    fs.closeSync(fd);
  }
});

test("ticket is reusable for GET/HEAD and binds source plus immutable snapshot", async (t) => {
  const tree = temporaryTree(t);
  const bound = await snapshotSource(tree);
  const issued = issueStoryArtifactTicket({
    tabId: "story-a",
    ref: "storydev:/reports/video.webm",
    sourceStat: bound.stat,
    snapshot: bound.snapshot,
    now: bound.now,
    expiresAt: bound.expiresAt,
  });
  const opened = await tree.store.openSnapshot({
    id: bound.snapshot.id,
    expiresAt: bound.expiresAt,
    now: bound.now + 1,
  });
  try {
    await tree.store.verifyOpenedSnapshot({
      fd: opened.fd,
      stat: opened.stat,
      expectedSha256: bound.snapshot.sha256,
      expectedStat: bound.snapshot.stat,
    });
    for (const method of ["GET", "HEAD", "GET"]) {
      const result = verifyStoryArtifactTicket(issued.token, {
        tabId: "story-a",
        ref: "storydev:/reports/video.webm",
        sourceStat: fs.statSync(tree.file, { bigint: true }),
        snapshotStat: opened.stat,
        snapshotId: bound.snapshot.id,
        snapshotSha256: bound.snapshot.sha256,
        method,
        now: bound.now + 1_000,
      });
      assert.equal(result.expiresAt, issued.expiresAt);
      assert.equal(result.snapshot.id, bound.snapshot.id);
    }
  } finally {
    fs.closeSync(opened.fd);
  }

  for (const mismatch of [
    { tabId: "story-b", ref: "storydev:/reports/video.webm", download: false },
    { tabId: "story-a", ref: "storydev:/reports/other.webm", download: false },
    { tabId: "story-a", ref: "storydev:/reports/video.webm", download: true },
  ]) {
    assert.throws(
      () => inspectStoryArtifactTicket(issued.token, {
        ...mismatch,
        now: bound.now + 1_000,
      }),
      { code: "STORY_ARTIFACT_TICKET_SCOPE_MISMATCH" },
    );
  }
});

test("ticket rejects tampering, expiry and replacement of the bound source", async (t) => {
  const tree = temporaryTree(t, "before");
  const bound = await snapshotSource(tree, { ttlMs: 1_000 });
  const issued = issueStoryArtifactTicket({
    tabId: "story-a",
    ref: "storydev:/reports/result.txt",
    download: true,
    sourceStat: bound.stat,
    snapshot: bound.snapshot,
    now: bound.now,
    expiresAt: bound.expiresAt,
  });
  const changed = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () => inspectStoryArtifactTicket(changed, {
      tabId: "story-a",
      ref: "storydev:/reports/result.txt",
      download: true,
      now: bound.now + 100,
    }),
    { code: "STORY_ARTIFACT_TICKET_INVALID" },
  );
  assert.throws(
    () => inspectStoryArtifactTicket(issued.token, {
      tabId: "story-a",
      ref: "storydev:/reports/result.txt",
      download: true,
      now: bound.now + 1_001,
    }),
    { code: "STORY_ARTIFACT_TICKET_EXPIRED" },
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.writeFileSync(tree.file, "after-and-different");
  assert.throws(
    () => verifyStoryArtifactTicket(issued.token, {
      tabId: "story-a",
      ref: "storydev:/reports/result.txt",
      download: true,
      sourceStat: fs.statSync(tree.file, { bigint: true }),
      snapshotStat: bound.snapshot.stat,
      snapshotId: bound.snapshot.id,
      snapshotSha256: bound.snapshot.sha256,
      now: bound.now + 100,
    }),
    { code: "STORY_ARTIFACT_TICKET_FILE_CHANGED" },
  );
});

test("snapshot is copied from one source fd and remains independent from source replacement", async (t) => {
  const tree = temporaryTree(t, "trusted-snapshot");
  const bound = await snapshotSource(tree);
  fs.writeFileSync(tree.file, "untrusted-replacement");
  const opened = await tree.store.openSnapshot({
    id: bound.snapshot.id,
    expiresAt: bound.expiresAt,
    now: bound.now + 1,
  });
  try {
    await tree.store.verifyOpenedSnapshot({
      fd: opened.fd,
      stat: opened.stat,
      expectedSha256: bound.snapshot.sha256,
      expectedStat: bound.snapshot.stat,
    });
    const buffer = Buffer.alloc(Number(opened.stat.size));
    assert.equal(fs.readSync(opened.fd, buffer, 0, buffer.length, 0), buffer.length);
    assert.equal(buffer.toString("utf8"), "trusted-snapshot");
  } finally {
    fs.closeSync(opened.fd);
  }
});

test("snapshot capacity fails closed and bounded GC reclaims expired objects", async (t) => {
  const tree = temporaryTree(t, "123456", {
    maxSnapshotBytes: 8,
    maxTotalBytes: 10,
    maxSnapshots: 1,
    gcBatchSize: 1,
  });
  const first = await snapshotSource(tree, { now: 10_000, ttlMs: 1_000 });
  await assert.rejects(
    snapshotSource(tree, { now: 10_100, ttlMs: 1_000 }),
    { code: "STORY_ARTIFACT_SNAPSHOT_CAPACITY_EXCEEDED" },
  );

  const gc = await tree.store.garbageCollect({ now: 11_001 });
  assert.equal(gc.removed, 1);
  const second = await snapshotSource(tree, { now: 11_100, ttlMs: 1_000 });
  assert.notEqual(second.snapshot.id, first.snapshot.id);

  fs.writeFileSync(tree.file, "123456789");
  await assert.rejects(
    snapshotSource(tree, { now: 11_200, ttlMs: 1_000 }),
    { code: "STORY_ARTIFACT_SNAPSHOT_TOO_LARGE" },
  );
});
