/**
 * P1d' 归属解析 + 三层回查 冒烟测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveOwnership,
  resolveLogcat,
  resolveAnrTrace,
  resolveDumpsys,
  resolveSystrace,
} from "../ingest/ownership-resolver.js";

import {
  verifyClaim,
  verifyReasoning,
  adjustConfidence,
} from "../classifier/evidence-verifier.js";

// ---------- ownership-resolver: logcat ----------

test("logcat: Start proc 映射 pid → pkg", () => {
  const log = `
04-24 10:00:00.100  1000  1001 I ActivityManager: Start proc 1234:com.xxx.music/u0a10 for activity
04-24 10:00:01.200  1234  1235 E MediaPlayer: play failed
04-24 10:00:02.300  5678  5679 I SomeService: hello
`.trim();
  const spans = resolveLogcat(log);
  const musicSpan = spans.find((s) => s.owner_package === "com.xxx.music");
  assert.ok(musicSpan, "应识别出 com.xxx.music 归属");
  assert.equal(musicSpan.ownership_confidence, 1.0);
});

test("logcat: FATAL EXCEPTION Process 字段", () => {
  const log = `
04-24 10:00:00.000  2000  2001 E AndroidRuntime: FATAL EXCEPTION: main
04-24 10:00:00.000  2000  2001 E AndroidRuntime: Process: com.xxx.music, PID: 2000
04-24 10:00:00.000  2000  2001 E AndroidRuntime: java.lang.NullPointerException
`.trim();
  const spans = resolveLogcat(log);
  const hit = spans.find((s) => s.owner_package === "com.xxx.music");
  assert.ok(hit);
  assert.ok(hit.ownership_confidence >= 0.9);
});

test("logcat: ANR in <pkg>", () => {
  const log = "10-10 10:10:10.010  1  2 I ActivityManager: ANR in com.xxx.map (not responding in 5000ms)";
  const spans = resolveLogcat(log);
  const hit = spans.find((s) => s.owner_package === "com.xxx.map");
  assert.ok(hit);
  assert.equal(hit.ownership_confidence, 1.0);
});

test("logcat: 切分多条 span（不同归属）", () => {
  const log = `
04-24 10:00:00.100  1000  1001 I ActivityManager: Start proc 1234:com.xxx.music/u0a10 for x
04-24 10:00:00.200  1234  1235 E MediaPlayer: music error
04-24 10:00:01.000  1000  1002 I ActivityManager: Start proc 5678:com.xxx.map/u0a11 for y
04-24 10:00:01.100  5678  5679 E MapRender: map error
`.trim();
  const spans = resolveLogcat(log);
  const pkgs = [...new Set(spans.map((s) => s.owner_package))];
  assert.ok(pkgs.includes("com.xxx.music"));
  assert.ok(pkgs.includes("com.xxx.map"));
});

// ---------- ownership-resolver: anr ----------

test("anr: Cmd line 识别", () => {
  const trace = `
----- pid 1234 at 2026-04-24 10:00:00 -----
Cmd line: com.xxx.music
DALVIK THREADS (42):
...
`.trim();
  const spans = resolveAnrTrace(trace);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].owner_package, "com.xxx.music");
  assert.equal(spans[0].ownership_confidence, 1.0);
});

test("anr: 无 Cmd line fallback 到 unknown", () => {
  const trace = "some random trace without identifying info";
  const spans = resolveAnrTrace(trace);
  assert.equal(spans[0].owner_package, "unknown");
  assert.ok(spans[0].ownership_confidence <= 0.5);
});

// ---------- ownership-resolver: dumpsys ----------

test("dumpsys: 带包参数归对应包", () => {
  const dump = `
DUMP OF SERVICE meminfo [com.xxx.music]
** MEMINFO in pid 1234 [com.xxx.music] **

DUMP OF SERVICE alarm
Current Alarm Manager state:
`.trim();
  const spans = resolveDumpsys(dump);
  const music = spans.find((s) => s.owner_package === "com.xxx.music");
  const framework = spans.find((s) => s.owner_package === "framework");
  assert.ok(music);
  assert.ok(framework);
});

test("dumpsys: body 里的 packageName 也能识别", () => {
  const dump = `
DUMP OF SERVICE activity
  Proc #0: fg  T/A/LCM  trm: 0 1234:com.xxx.music/u0a10 (top-activity)
    packageName=com.xxx.music versionCode=100
`.trim();
  const spans = resolveDumpsys(dump);
  const music = spans.find((s) => s.owner_package === "com.xxx.music");
  assert.ok(music);
  assert.ok(music.ownership_confidence >= 0.9);
});

// ---------- ownership-resolver: systrace ----------

test("systrace: tgid header 识别", () => {
  const content = `# tgid = 1234 comm = com.xxx.music\n...`;
  const spans = resolveSystrace(content);
  assert.equal(spans[0].owner_package, "com.xxx.music");
});

// ---------- ownership-resolver: dispatch ----------

test("resolveOwnership: tb_content 天然归属", () => {
  const spans = resolveOwnership({
    source_type: "tb_content",
    content: "用户描述",
    case_package: "com.xxx.music",
  });
  assert.equal(spans[0].owner_package, "com.xxx.music");
  assert.equal(spans[0].ownership_confidence, 1.0);
});

test("resolveOwnership: 未知 source_type 归 unknown", () => {
  const spans = resolveOwnership({
    source_type: "unknown_type",
    content: "x",
    case_package: "com.xxx.music",
  });
  assert.equal(spans[0].owner_package, "unknown");
});

// ---------- evidence-verifier ----------

test("verifier: Tier 1 精确子串通过", () => {
  const r = verifyClaim({
    claim: "FATAL EXCEPTION: main",
    refEvidences: [{ id: 1, text_snapshot: "some stuff FATAL EXCEPTION: main\nMore" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 1);
});

test("verifier: Tier 2 归一化后通过（全角/空白）", () => {
  const r = verifyClaim({
    claim: "NullPointerException  at line 42",    // 双空格
    refEvidences: [{ id: 1, text_snapshot: "java.lang.NullPointerException at line 42\nxx" }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.tier === 1 || r.tier === 2);
});

test("verifier: Tier 2 处理全角冒号", () => {
  const r = verifyClaim({
    claim: "Process：com.xxx.music",   // 全角冒号
    refEvidences: [{ id: 1, text_snapshot: "... Process: com.xxx.music, PID: 1234 ..." }],
  });
  assert.equal(r.ok, true);
});

test("verifier: Tier 3 结构化引用（类名:行号）", () => {
  const r = verifyClaim({
    claim: "发生在 AudioFocusHelper:142",
    refEvidences: [{ id: 1, text_snapshot: "at com.xxx.AudioFocusHelper:142 call failed" }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.tier === 1 || r.tier === 2 || r.tier === 3);
});

test("verifier: 完全无关的 claim 被拒", () => {
  const r = verifyClaim({
    claim: "无中生有的断言，不在任何证据里",
    refEvidences: [{ id: 1, text_snapshot: "FATAL EXCEPTION: main" }],
  });
  assert.equal(r.ok, false);
});

test("verifier: 空 claim 被拒", () => {
  const r = verifyClaim({ claim: "", refEvidences: [{ id: 1, text_snapshot: "x" }] });
  assert.equal(r.ok, false);
});

test("verifier: 无 evidence 被拒", () => {
  const r = verifyClaim({ claim: "x", refEvidences: [] });
  assert.equal(r.ok, false);
});

// ---------- verifyReasoning + adjustConfidence ----------

test("verifyReasoning: 全部通过 → mismatch=0", () => {
  const r = verifyReasoning({
    reasoning_steps: [
      { claim: "FATAL EXCEPTION", evidence_refs: ["e:1"] },
    ],
    evidences: [{ id: 1, text_snapshot: "FATAL EXCEPTION: main\n..." }],
  });
  assert.equal(r.mismatch, 0);
  assert.equal(r.pass, 1);
});

test("verifyReasoning: unknown evidence_ref 记 mismatch", () => {
  const r = verifyReasoning({
    reasoning_steps: [{ claim: "x", evidence_refs: ["e:999"] }],
    evidences: [{ id: 1, text_snapshot: "y" }],
  });
  assert.equal(r.mismatch, 1);
});

test("adjustConfidence: 任意 mismatch → *0.7", () => {
  const c = adjustConfidence(0.9, { mismatch: 1, pass: 0, total: 1 });
  assert.ok(Math.abs(c - 0.63) < 1e-6);
});

test("adjustConfidence: mismatch > 3 → 封顶 0.4", () => {
  const c = adjustConfidence(0.95, { mismatch: 5, pass: 0, total: 5 });
  assert.ok(c <= 0.4);
});
