import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  evaluateTestProcess,
  excerptFailureStream,
  main,
  parseNodeTestSummary,
  runTestFiles,
  summarizeResults,
} from "../scripts/run-tests.mjs";

const PASS_TAP = `TAP version 13
ok 1 - succeeds
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1
`;

const FAIL_TAP = `TAP version 13
not ok 1 - fails once
  ---
  error: 'expected true'
  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (fixture.test.mjs:10:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1
`;

test("parseNodeTestSummary parses TAP and Node spec reporter summaries", () => {
  assert.deepEqual(parseNodeTestSummary(PASS_TAP), {
    tests: 1,
    pass: 1,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    complete: true,
    consistent: true,
    accounted: 1,
  });
  assert.equal(parseNodeTestSummary(`ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n`).fail, 1);
});

test("a zero exit without a complete and consistent Node summary fails closed", () => {
  const missing = evaluateTestProcess("missing.test.mjs", { status: 0, stdout: "ok 1\n", stderr: "" });
  assert.equal(missing.ok, false);
  assert.match(missing.protocolIssues.join("\n"), /缺少 Node 测试最终汇总/);

  const inconsistent = evaluateTestProcess("bad-count.test.mjs", {
    status: 0,
    stdout: PASS_TAP.replace("# tests 1", "# tests 2"),
    stderr: "",
  });
  assert.equal(inconsistent.ok, false);
  assert.match(inconsistent.protocolIssues.join("\n"), /汇总不一致/);
});

test("runTestFiles executes each file once and keeps the first nonzero result visible", () => {
  const calls = [];
  const lines = [];
  const spawnImpl = (_nodePath, args) => {
    const file = args.at(-1);
    calls.push(file);
    if (file.endsWith("first.test.mjs")) {
      return { status: 1, signal: null, stdout: FAIL_TAP, stderr: "fixture stderr marker\n" };
    }
    return { status: 0, signal: null, stdout: PASS_TAP, stderr: "" };
  };

  const results = runTestFiles(["first.test.mjs", "second.test.mjs"], {
    spawnImpl,
    nodePath: "node",
    write: (line) => lines.push(line),
  });
  const aggregate = summarizeResults(results);

  assert.deepEqual(calls, [path.join("test", "first.test.mjs"), path.join("test", "second.test.mjs")]);
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.failedFiles[0].file, "first.test.mjs");
  assert.deepEqual(aggregate.totals, {
    tests: 2,
    pass: 1,
    fail: 1,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
  assert.match(lines.join("\n"), /expected true/);
  assert.match(lines.join("\n"), /fixture stderr marker/);
});

test("main returns nonzero and audits file and case counts when any child fails", () => {
  const lines = [];
  const statuses = [1, 0];
  let invocation = 0;
  const exitCode = main({
    filters: [],
    listFiles: () => ["failure.test.mjs", "success.test.mjs"],
    spawnImpl: () => {
      const status = statuses[invocation++];
      // 即使 reporter 文本声称全部 PASS，非零退出码仍必须让总命令失败。
      return { status, signal: null, stdout: PASS_TAP, stderr: "" };
    },
    write: (line) => lines.push(line),
    now: (() => {
      const values = [1000, 1250];
      return () => values.shift();
    })(),
  });

  assert.equal(exitCode, 1);
  assert.equal(invocation, 2);
  assert.match(lines.join("\n"), /文件 2（通过 1 \/ 失败 1）/);
  assert.match(lines.join("\n"), /用例 tests=2 pass=2 fail=0/);
  assert.match(lines.join("\n"), /失败文件：failure\.test\.mjs/);
});

test("failure excerpts keep each not-ok block and final counters", () => {
  const noise = Array.from({ length: 100 }, (_, index) => `noise ${index}`).join("\n");
  const excerpt = excerptFailureStream(`${noise}\n${FAIL_TAP}`);
  assert.match(excerpt, /not ok 1 - fails once/);
  assert.match(excerpt, /ERR_ASSERTION/);
  assert.match(excerpt, /# fail 1/);
  assert.match(excerpt, /省略 \d+ 行/);
});
