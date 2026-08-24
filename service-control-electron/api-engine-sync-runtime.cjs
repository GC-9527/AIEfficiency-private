const http = require("http");
const https = require("https");

function requestJson(url, { method = "GET", body, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, error: "invalid url" });
      return;
    }
    const data = body === undefined ? "" : JSON.stringify(body);
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search || ""}`,
      method,
      headers: data
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
        : {},
      timeout: timeoutMs,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text,
          json,
        });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    if (data) req.write(data);
    req.end();
  });
}

function compareSyncedEngines(expectedEngines = {}, actualEngines = {}) {
  const mismatches = [];
  for (const [id, expected] of Object.entries(expectedEngines || {})) {
    if (!expected || typeof expected !== "object" || expected._delete === true) continue;
    const actual = actualEngines?.[id];
    if (!actual) {
      mismatches.push(`${id}: missing`);
      continue;
    }
    for (const field of ["enabled", "baseUrl", "model", "name"]) {
      if (expected[field] !== undefined && actual[field] !== expected[field]) {
        mismatches.push(`${id}.${field}: mismatch`);
      }
    }
    if (String(expected.apiKey || "").trim() && !String(actual.apiKey || "").trim()) {
      mismatches.push(`${id}.apiKey: missing`);
    }
  }
  return mismatches;
}

async function syncApiEnginesToGateway(gatewayUrl, sourceEngines, { timeoutMs = 6000 } = {}) {
  const base = String(gatewayUrl || "").replace(/\/+$/, "");
  const put = await requestJson(`${base}/api/config`, {
    method: "PUT",
    body: { apiEngines: sourceEngines },
    timeoutMs,
  });
  if (!put.ok || put.json?.success === false) {
    return {
      ok: false,
      error: put.error || put.json?.error || `target gateway responded ${put.status || "without a status"}`,
    };
  }

  const readback = await requestJson(`${base}/api/config`, { timeoutMs });
  if (!readback.ok || readback.json?.success !== true) {
    return {
      ok: false,
      error: readback.error || readback.json?.error || `target readback responded ${readback.status || "without a status"}`,
    };
  }
  const mismatches = compareSyncedEngines(sourceEngines, readback.json?.data?.apiEngines || {});
  if (mismatches.length) {
    return { ok: false, error: `target readback mismatch: ${mismatches.join(", ")}` };
  }
  return { ok: true, pushed: true, verified: true };
}

module.exports = {
  compareSyncedEngines,
  requestJson,
  syncApiEnginesToGateway,
};
