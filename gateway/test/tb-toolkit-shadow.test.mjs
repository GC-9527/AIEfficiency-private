import assert from "node:assert/strict";
import test from "node:test";

import { resolveTbToolkitMode, runTbToolkitContextShadow } from "../services/devbench/tb-toolkit-shadow.js";

test("Gateway TB toolkit 默认关闭且关闭时不启动 runtime", async () => {
  let boots = 0;
  const result = await runTbToolkitContextShadow({ mode: "off", bootstrap: async () => { boots += 1; } });
  assert.deepEqual(result, { enabled: false, mode: "off" });
  assert.equal(boots, 0);
  assert.equal(resolveTbToolkitMode({ config: {}, env: {} }), "off");
  assert.equal(resolveTbToolkitMode({ config: { tbTicketToolkit: { mode: "canonical" } }, env: {} }), "off");
});

test("Gateway shadow 强制 read profile、关闭写开关且不泄露凭据", async () => {
  let closed = 0;
  let options;
  const application = {
    async readContext() {
      return { context: { comments: [1], attachments: [], contextDigest: "digest" }, snapshot: {} };
    },
  };
  const result = await runTbToolkitContextShadow({
    mode: "shadow",
    tab: { taskId: "0123456789abcdef01234567", taskNo: "CARB-1" },
    legacySnapshot: { comments: [1], attachments: [] },
    repoPath: "D:/fixture",
    teambitionConfig: { appId: "app", appSecret: "secret", orgId: "org", userCookie: "cookie" },
    bootstrap: async (value) => { options = value; return { application, async close() { closed += 1; } }; },
    createAdapter: ({ legacyReader }) => ({ async read() {
      const legacy = await legacyReader();
      assert.equal(legacy.comments.length, 1);
      return { shadow: { ok: true, matched: true } };
    } }),
  });
  assert.deepEqual(result, { enabled: true, mode: "shadow", ok: true, matched: true });
  assert.equal(options.profile, "read");
  assert.equal(options.env.TB_TOOLKIT_WRITE_ENABLED, "false");
  assert.equal(options.env.TB_TOOLKIT_WRITE_ALLOWLIST, "");
  assert.equal(closed, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret|cookie/);
});
