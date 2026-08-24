import { Router } from "express";
import { getConfig } from "../services/config.js";
import { analyzeImage } from "../services/claude-proxy.js";
import { verifyAgentRequestSignature } from "../services/agent-protocol.js";
import {
  addAgentArtifact,
  cancelAgentSession,
  createAgentSession,
  getAgentSession,
  getAgentV2Capabilities,
  interruptAgentSession,
  listAgentEvents,
  startAgentTurn,
  submitAgentToolResults,
  subscribeAgentEvents,
  updateAgentArtifact,
} from "../services/agent-session.js";

const router = Router();

function checkAuth(req) {
  const root = getConfig();
  const cfg = root.claudeProxy || {};
  const dist = root.distributedExecution || {};
  if (!cfg.enabled) return { ok: false, code: 403, error: "center AI proxy is not enabled" };
  const expected = String(root.servers?.inboundToken || cfg.token || "").trim();
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const allowMissingToken = environment === "test"
    || (
      environment === "development"
      && String(process.env.AIEFFICIENCY_ALLOW_UNAUTHENTICATED_AGENT_V2 || "") === "1"
    );
  if (!expected && !allowMissingToken) {
    return { ok: false, code: 503, error: "Agent V2 inbound token is not configured" };
  }
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (expected && token !== expected) return { ok: false, code: 401, error: "invalid token" };
  const timestamp = req.headers["x-agent-v2-timestamp"];
  const signature = req.headers["x-agent-v2-signature"];
  const hasSignature = timestamp != null || signature != null;
  if (hasSignature || dist.requireV2Signature) {
    if (!expected) return { ok: false, code: 401, error: "Agent V2 request signing requires a configured token" };
    if (!timestamp || !signature) return { ok: false, code: 401, error: "missing Agent V2 request signature" };
    const verified = verifyAgentRequestSignature({
      method: req.method,
      path: req.originalUrl || req.url || "/",
      timestamp,
      signature,
      body: req.method === "GET" ? null : (req.body || {}),
      secret: expected,
    });
    if (!verified.ok) return { ok: false, code: 401, error: verified.error };
  }
  return { ok: true };
}

function requireAuth(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) {
    res.status(auth.code).json({ ok: false, error: auth.error });
    return false;
  }
  return true;
}

function sessionOr404(req, res) {
  const session = getAgentSession(req.params.id);
  if (!session) {
    res.status(404).json({ ok: false, error: "session not found" });
    return null;
  }
  return session;
}

function writeSse(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.get("/capabilities", (req, res) => {
  res.json({ ok: true, data: getAgentV2Capabilities() });
});

router.post("/sessions", (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const session = createAgentSession(req.body || {});
    res.json({
      ok: true,
      data: {
        id: session.id,
        protocolVersion: session.protocolVersion,
        status: session.status,
        lastEventId: session.lastEventId,
        aiSnapshot: session.aiSnapshot,
      },
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.post("/sessions/:id/turn", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!sessionOr404(req, res)) return;
  try {
    const session = await startAgentTurn(req.params.id, req.body || {});
    res.json({ ok: true, data: {
      id: session.id,
      status: session.status,
      lastEventId: session.lastEventId,
      aiSnapshot: session.aiSnapshot,
    } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.post("/sessions/:id/tool-results", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!sessionOr404(req, res)) return;
  try {
    const session = await submitAgentToolResults(req.params.id, req.body || {});
    res.json({ ok: true, data: { id: session.id, status: session.status, lastEventId: session.lastEventId } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.post("/sessions/:id/artifacts", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!sessionOr404(req, res)) return;
  try {
    const body = req.body || {};
    const artifact = addAgentArtifact(req.params.id, body);
    if (body.inspect && String(body.mime || body.mediaType || "").startsWith("image/") && body.base64) {
      const analysis = await analyzeImage({
        base64: String(body.base64),
        mediaType: String(body.mime || body.mediaType || "image/png"),
        prompt: body.prompt || "Describe this image, including OCR text, visible UI state, and relevant evidence.",
      });
      const updated = updateAgentArtifact(req.params.id, artifact.id, {
        analysis: analysis.ok
          ? { ok: true, text: analysis.text }
          : { ok: false, error: analysis.error || "vision backend unavailable" },
      });
      Object.assign(artifact, updated);
    }
    res.json({ ok: true, data: artifact });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.post("/sessions/:id/interrupt", (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!sessionOr404(req, res)) return;
  try {
    const session = interruptAgentSession(req.params.id, req.body?.message || req.body?.content || "");
    res.json({ ok: true, data: { id: session.id, status: session.status, lastEventId: session.lastEventId } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.post("/sessions/:id/cancel", (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!sessionOr404(req, res)) return;
  try {
    const session = cancelAgentSession(req.params.id, req.body?.reason || "");
    res.json({ ok: true, data: { id: session.id, status: session.status, lastEventId: session.lastEventId } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.get("/sessions/:id/events", (req, res) => {
  const auth = checkAuth(req);
  if (!auth.ok) {
    res.status(auth.code).json({ ok: false, error: auth.error });
    return;
  }
  const session = sessionOr404(req, res);
  if (!session) return;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  let after = Number(req.query.after || req.headers["last-event-id"] || 0) || 0;
  for (const event of listAgentEvents(session.id, after)) {
    writeSse(res, event);
    after = event.id;
  }
  const unsubscribe = subscribeAgentEvents(session.id, (event) => writeSse(res, event));
  const keepAlive = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {}
  }, 25000);
  keepAlive.unref?.();
  res.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

export default router;
