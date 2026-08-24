import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runRemoteTool,
  runRemoteToolResult,
  sanitizeArtifactScope,
} from "../services/remote-tools.js";

test("sanitizeArtifactScope 仅保留 story/generic 逻辑字段", () => {
  assert.deepEqual(sanitizeArtifactScope({
    kind: "story",
    id: " tab-1 ",
    title: " 故事点 ",
    docSlug: " story-1 ",
    tempRoot: "D:/caller/temp",
    extra: "drop-me",
  }), {
    kind: "story",
    id: "tab-1",
    title: "故事点",
    docSlug: "story-1",
  });
  assert.deepEqual(sanitizeArtifactScope({
    kind: "generic",
    id: " task-1 ",
    title: "drop-me",
    tempRoot: "D:/caller/temp",
  }), {
    kind: "generic",
    id: "task-1",
  });
  assert.throws(() => sanitizeArtifactScope({ kind: "story", id: "", title: "x", docSlug: "x" }), /artifactScope\.id/);
  assert.throws(() => sanitizeArtifactScope({ kind: "other", id: "x" }), /story 或 generic/);
});

test("runRemoteTool 两条转发路径都使用白名单清洗后的 artifactScope", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: "done" }),
    };
  };
  try {
    const target = {
      host: "http://executor.invalid",
      token: "token",
      root: "D:/workspace/project",
      tempRoot: "D:/caller/target-temp",
    };
    const story = await runRemoteToolResult(target, "read_file", { path: "README.md" }, null, {
      taskId: "task-story",
      artifactScope: {
        kind: "story",
        id: "tab-story",
        title: "远端故事点",
        docSlug: "remote-story",
        tempRoot: "D:/caller/scope-temp",
        extra: "drop-me",
      },
      tempRoot: "D:/caller/meta-temp",
      commandPolicy: "read_only",
    });
    assert.equal(story.ok, true);

    const generic = await runRemoteTool(target, "read_file", { path: "README.md" }, null, {
      taskId: "task-generic",
      artifactScope: {
        kind: "generic",
        id: "generic-task",
        title: "drop-me",
        tempRoot: "D:/caller/scope-temp",
      },
      tempRoot: "D:/caller/meta-temp",
    });
    assert.equal(generic, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].artifactScope, {
    kind: "story",
    id: "tab-story",
    title: "远端故事点",
    docSlug: "remote-story",
  });
  assert.equal(requests[0].taskId, "task-story");
  assert.equal(requests[0].commandPolicy, "read_only");
  assert.deepEqual(requests[1].artifactScope, {
    kind: "generic",
    id: "generic-task",
  });
  assert.equal(requests[1].taskId, "task-generic");
  assert.equal(Object.hasOwn(requests[1], "commandPolicy"), false);
  for (const body of requests) {
    assert.equal(Object.hasOwn(body, "tempRoot"), false);
    assert.equal(Object.hasOwn(body.artifactScope, "tempRoot"), false);
  }
});

test("无效 artifactScope 在发起网络请求前 fail closed", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("不应调用");
  };
  try {
    const target = { host: "http://executor.invalid", root: "D:/workspace/project" };
    const result = await runRemoteToolResult(target, "read_file", {}, null, {
      artifactScope: { kind: "generic", id: "" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /artifactScope\.id/);

    const text = await runRemoteTool(target, "read_file", {}, null, {
      artifactScope: { kind: "story", id: "tab", title: "", docSlug: "story" },
    });
    assert.match(text, /artifactScope\.title/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
