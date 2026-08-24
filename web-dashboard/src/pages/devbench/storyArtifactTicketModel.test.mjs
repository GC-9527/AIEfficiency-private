import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptedArtifactTickets,
  chunkArtifactRefs,
  storyArtifactRefsInText,
} from "./storyArtifactTicketModel.mjs";

test("extracts and deduplicates safe story artifact references from Markdown", () => {
  assert.deepEqual(
    storyArtifactRefsInText([
      "![截图](storydev:/reports/result.png)",
      "[日志](storydev:/archives/logs/run%201.log)",
      "重复 storydev:/reports/result.png。",
      "拒绝 storydev:/../other/secret.txt",
    ].join("\n")),
    [
      "storydev:/reports/result.png",
      "storydev:/archives/logs/run%201.log",
    ],
  );
});

test("accepts only requested, unexpired and structurally valid ticket results", () => {
  const previousNow = Date.now;
  Date.now = () => 1_000;
  try {
    const ticket = `${"e30"}.${"a".repeat(43)}`;
    assert.deepEqual(
      acceptedArtifactTickets({
        ok: true,
        data: {
          items: [
            { ref: "storydev:/reports/a.png", ticket, expiresAt: 2_000 },
            { ref: "storydev:/reports/not-requested.png", ticket, expiresAt: 2_000 },
            { ref: "storydev:/reports/expired.png", ticket, expiresAt: 999 },
          ],
        },
      }, [
        "storydev:/reports/a.png",
        "storydev:/reports/expired.png",
      ]),
      {
        "storydev:/reports/a.png": { ticket, expiresAt: 2_000 },
      },
    );
  } finally {
    Date.now = previousNow;
  }
});

test("splits long conversations into server-sized batches", () => {
  const refs = Array.from({ length: 205 }, (_, index) => `storydev:/reports/${index}.png`);
  const chunks = chunkArtifactRefs(refs);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 5]);
  assert.deepEqual(chunks.flat(), refs);
});
