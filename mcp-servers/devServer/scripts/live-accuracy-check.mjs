import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const FORWARDED_ENV = [
  "APPMARKET_ADMIN_TOKEN",
  "APPMARKET_ADMIN_USERNAME",
  "APPMARKET_ADMIN_PASSWORD",
  "APPMARKET_ADMIN_LOGIN_CURL_FILE",
  "APPMARKET_ADMIN_BASE_URL",
  "APPMARKET_ADMIN_ALLOWED_ORIGINS",
  "APPMARKET_ADMIN_ENVIRONMENT",
  "APPMARKET_ADMIN_TIMEOUT_MS",
  "APPMARKET_ADMIN_MAX_RESPONSE_BYTES",
  "APPMARKET_ADMIN_TOKEN_TTL_MS",
];

const env = getDefaultEnvironment();
for (const name of FORWARDED_ENV) {
  if (process.env[name]) env[name] = process.env[name];
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stderr: "pipe",
});
const client = new Client({
  name: "appmarket-admin-live-accuracy-check",
  version: "1.0.0",
});

let stderrSeen = false;
let currentStage = "connect";
let lastToolErrorCode = null;
transport.stderr?.on("data", () => {
  stderrSeen = true;
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError || result.structuredContent?.status === "error") {
    lastToolErrorCode =
      result.structuredContent?.error?.code || "TOOL_CALL_FAILED";
    throw new Error(`${name} failed`);
  }
  return result.structuredContent;
}

function optionalExpected(record, inputName, fieldName) {
  const value = record?.[fieldName];
  return value === undefined ||
    value === null ||
    value === "" ||
    !["string", "number"].includes(typeof value)
    ? {}
    : { [inputName]: value };
}

function validationWarnings(payload) {
  return (payload?.meta?.validation?.warnings || [])
    .filter((item) => typeof item === "string")
    .slice(0, 10);
}

async function findAppWithVoiceKey(maxPages = 20) {
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const payload = await call("appmarket_admin_list_apps", {
      source: "full",
      pageNum,
      pageSize: 100,
    });
    const items = payload?.data?.items || [];
    const match = items.find(
      (item) =>
        String(item?.appKey || "").trim() &&
        (item?.appId || item?.id || item?.appName)
    );
    if (match) return { record: match, evidence: payload.meta?.evidenceSha256 };
    if (items.length < 100) break;
  }
  return { record: null, evidence: null };
}

try {
  await client.connect(transport);
  currentStage = "auth-check";
  await call("appmarket_admin_auth_check");
  const checks = [];

  currentStage = "list-banners";
  const banners = await call("appmarket_admin_list_banners", {
    pageNum: 1,
    pageSize: 50,
  });
  const banner = (banners?.data?.items || []).find(
    (item) => item?.appId || item?.appName
  );
  if (banner) {
    currentStage = "verify-banner";
    const verification = await call("appmarket_admin_verify_banner", {
      ...(banner.appId ? { appId: String(banner.appId) } : {}),
      ...(banner.appName ? { appName: String(banner.appName) } : {}),
      ...optionalExpected(banner, "expectedState", "state"),
      ...optionalExpected(banner, "expectedSort", "sort"),
      maxPages: 20,
    });
    checks.push({
      name: "banner-round-trip",
      status: verification.status,
      evidenceSha256: verification.meta?.evidenceSha256 || null,
      warnings: validationWarnings(verification),
    });
  } else {
    checks.push({
      name: "banner-round-trip",
      status: "partial",
      reason: "no-banner-record",
      evidenceSha256: banners.meta?.evidenceSha256 || null,
    });
  }

  currentStage = "find-voice-key";
  const voiceCandidate = await findAppWithVoiceKey();
  if (voiceCandidate.record) {
    const record = voiceCandidate.record;
    const expectedKey = String(record.appKey)
      .split(",")
      .map((item) => item.trim())
      .find(Boolean);
    currentStage = "verify-voice-key";
    const verification = await call("appmarket_admin_verify_voice_key", {
      ...(record.appId || record.id
        ? { appId: String(record.appId || record.id) }
        : { appName: String(record.appName) }),
      expectedKey,
      maxPages: 50,
    });
    checks.push({
      name: "voice-key-round-trip",
      status: verification.status,
      evidenceSha256: verification.meta?.evidenceSha256 || null,
      warnings: validationWarnings(verification),
    });
  } else {
    checks.push({
      name: "voice-key-round-trip",
      status: "partial",
      reason: "no-app-with-appKey",
      evidenceSha256: voiceCandidate.evidence,
    });
  }

  const failed = checks.filter((item) => item.status === "fail").length;
  const partial = checks.filter((item) => item.status === "partial").length;
  const status = failed ? "fail" : partial ? "partial" : "pass";
  process.stdout.write(
    `${JSON.stringify(
      {
        status,
        passed: checks.filter((item) => item.status === "pass").length,
        partial,
        failed,
        checks,
      },
      null,
      2
    )}\n`
  );
  if (failed) process.exitCode = 1;
} catch {
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      code: "MCP_LIVE_ACCURACY_CHECK_FAILED",
      stage: currentStage,
      toolErrorCode: lastToolErrorCode,
      serverStderrPresent: stderrSeen,
    })}\n`
  );
  process.exitCode = 1;
} finally {
  await transport.close();
}
