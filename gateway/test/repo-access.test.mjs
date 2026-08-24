import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRepoAccessCandidates,
  checkRepositoryAccess,
} from "../services/devbench/repo-access.js";

const definition = {
  https: "https://codeup.aliyun.com/xunihezi/AppMarket",
  ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git",
};

test("仓库权限候选优先使用本地 checkout 的 origin，再尝试规范 HTTPS 和 SSH", () => {
  assert.deepEqual(
    buildRepoAccessCandidates(definition, ["https://codeup.aliyun.com/xunihezi/AppMarket.git"]),
    [
      {
        url: "https://codeup.aliyun.com/xunihezi/AppMarket.git",
        source: "local-origin",
        transport: "https",
      },
      {
        url: "git@codeup.aliyun.com:xunihezi/AppMarket.git",
        source: "definition",
        transport: "ssh",
      },
    ],
  );
});

test("SSH 公钥失败但 HTTPS 凭证可用时仍判定有拉取权限", async () => {
  const calls = [];
  const result = await checkRepositoryAccess({
    definition,
    // 模拟用户本地仓库的 origin 使用 SSH；它失败后应继续回退到定义中的 HTTPS。
    localRemoteUrls: [definition.ssh],
    probe: async (url) => {
      calls.push(url);
      if (url === definition.ssh) return { ok: false, error: "Permission denied (publickey)." };
      return { ok: true, branches: ["main"] };
    },
  });

  assert.equal(result.hasAccess, true);
  assert.equal(result.transport, "https");
  assert.equal(result.url, `${definition.https}.git`);
  assert.deepEqual(calls, [definition.ssh, `${definition.https}.git`]);
  assert.deepEqual(result.attempts.map((item) => item.ok), [false, true]);
});

test("HTTPS 凭证失败但 SSH Key 可用时仍判定有拉取权限", async () => {
  const result = await checkRepositoryAccess({
    definition,
    probe: async (url) => (
      url.startsWith("https:")
        ? { ok: false, error: "HTTP Basic: Access denied" }
        : { ok: true, branches: ["main"] }
    ),
  });

  assert.equal(result.hasAccess, true);
  assert.equal(result.transport, "ssh");
  assert.equal(result.url, definition.ssh);
  assert.deepEqual(result.attempts.map((item) => item.ok), [false, true]);
});

test("所有协议失败时返回逐协议诊断，不再把 HTTPS 失败误写成 SSH 失败", async () => {
  const result = await checkRepositoryAccess({
    definition,
    probe: async (url) => ({
      ok: false,
      error: url.startsWith("http") ? "HTTP Basic: Access denied" : "Permission denied (publickey).",
    }),
  });

  assert.equal(result.hasAccess, false);
  assert.deepEqual(result.attempts.map((item) => item.transport), ["https", "ssh"]);
  assert.match(result.error, /\[HTTPS\] HTTP Basic: Access denied/);
  assert.match(result.error, /\[SSH\] Permission denied \(publickey\)/);
});

test("返回给前端的 HTTPS 地址会遮蔽内嵌凭证", async () => {
  const credentialUrl = "https://alice:secret@example.com/team/repo.git";
  const result = await checkRepositoryAccess({
    definition: { https: credentialUrl },
    probe: async () => ({
      ok: false,
      error: `fatal: Authentication failed for '${credentialUrl}'`,
    }),
  });

  assert.equal(result.hasAccess, false);
  assert.doesNotMatch(result.url, /alice|secret/);
  assert.match(result.url, /\*\*\*/);
  assert.doesNotMatch(result.error, /alice|secret/);
  assert.match(result.error, /\*\*\*/);
});
