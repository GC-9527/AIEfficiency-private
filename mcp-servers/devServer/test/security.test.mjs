import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import {
  AppMarketError,
  parseLoginCurlFile,
  redactSecrets,
  sanitizeUrl,
  stableStringify,
} from "../src/security.js";

function errorWithCode(code) {
  return (error) => {
    assert.ok(error instanceof AppMarketError);
    assert.equal(error.code, code);
    return true;
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("base URL must match an exact configured HTTP(S) origin", () => {
  const config = loadConfig({
    APPMARKET_ADMIN_ALLOWED_ORIGINS:
      "http://admin.test:1080,https://admin-secure.test",
    APPMARKET_ADMIN_BASE_URL: "http://admin.test:1080/",
  });
  assert.equal(config.baseUrl, "http://admin.test:1080");
  assert.deepEqual(
    [...config.allowedOrigins].sort(),
    ["http://admin.test:1080", "https://admin-secure.test"].sort()
  );

  for (const baseUrl of [
    "http://admin.test",
    "http://admin.test:1081",
    "http://admin.test.evil.test:1080",
    "https://admin.test:1080",
  ]) {
    assert.throws(
      () =>
        loadConfig({
          APPMARKET_ADMIN_ALLOWED_ORIGINS: "http://admin.test:1080",
          APPMARKET_ADMIN_BASE_URL: baseUrl,
        }),
      errorWithCode("ORIGIN_NOT_ALLOWED")
    );
  }
});

test("origins and base URLs reject credentials, paths, queries, and fragments", () => {
  for (const allowedOrigins of [
    "ftp://admin.test",
    "http://fixture-user:fixture-password@admin.test",
    "http://admin.test/admin-api",
    "http://admin.test?environment=stg",
    "http://admin.test#fragment",
  ]) {
    assert.throws(
      () =>
        loadConfig({
          APPMARKET_ADMIN_ALLOWED_ORIGINS: allowedOrigins,
          APPMARKET_ADMIN_BASE_URL: "http://admin.test",
        }),
      errorWithCode("CONFIG_INVALID")
    );
  }

  for (const baseUrl of [
    "http://fixture-user:fixture-password@admin.test",
    "http://admin.test/admin-api",
    "http://admin.test?environment=stg",
    "http://admin.test#fragment",
  ]) {
    assert.throws(
      () =>
        loadConfig({
          APPMARKET_ADMIN_ALLOWED_ORIGINS: "http://admin.test",
          APPMARKET_ADMIN_BASE_URL: baseUrl,
        }),
      errorWithCode("CONFIG_INVALID")
    );
  }
});

test("credential curl parsing extracts fixtures without writing them to output", async (t) => {
  const fixtureUser = "fixture-user-not-a-real-account";
  const fixturePassword = "fixture-password-not-a-real-secret";
  const directory = await mkdtemp(join(tmpdir(), "appmarket-mcp-security-"));
  const curlPath = join(directory, "login-curl.txt");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(
    curlPath,
    [
      'curl ^"http://admin.test/admin-api/login^" ^',
      '  -H ^"Content-Type: application/json;charset=UTF-8^" ^',
      `  --data-raw ^"^{^\\^"username^\\^":^\\^"${fixtureUser}^\\^",^\\^"password^\\^":^\\^"${fixturePassword}^\\^"^}^"`,
    ].join("\n"),
    "utf8"
  );

  const parsed = await parseLoginCurlFile(curlPath);
  assert.equal(digest(parsed.username), digest(fixtureUser));
  assert.equal(digest(parsed.password), digest(fixturePassword));

  const moduleUrl = new URL("../src/security.js", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { parseLoginCurlFile } from ${JSON.stringify(
        moduleUrl
      )}; await parseLoginCurlFile(process.env.TEST_LOGIN_CURL_FILE);`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_LOGIN_CURL_FILE: curlPath,
      },
    }
  );

  assert.equal(child.status, 0);
  assert.ok(child.stdout.length === 0, "credential parser must not write stdout");
  assert.ok(child.stderr.length === 0, "credential parser must not write stderr");
  assert.ok(!child.stdout.includes(fixtureUser));
  assert.ok(!child.stdout.includes(fixturePassword));
  assert.ok(!child.stderr.includes(fixtureUser));
  assert.ok(!child.stderr.includes(fixturePassword));
});

test("deep redaction removes credential fields while preserving appKey", () => {
  const circular = { appKey: "circular-voice-key" };
  circular.self = circular;
  const input = {
    appKey: "primary-voice-key",
    Authorization: "Bearer fixture-token",
    nested: {
      password: "fixture-password",
      apiToken: "fixture-api-token",
      id_token: "fixture-id-token",
      api_key: "fixture-api-key",
      "x-api-key": "fixture-x-api-key",
      secretKey: "fixture-secret-key",
      accessKeySecret: "fixture-access-key-secret",
      pwd: "fixture-pwd",
      pass: "fixture-pass",
      appKey: "nested-voice-key",
      rows: [
        {
          "Admin-Token": "fixture-admin-token",
          access_token: "fixture-access-token",
          appKey: "array-voice-key",
        },
        {
          refreshToken: "fixture-refresh-token",
          client_secret: "fixture-client-secret",
          session_id: "fixture-session",
        },
      ],
    },
    circular,
  };

  const redacted = redactSecrets(input);
  assert.equal(redacted.appKey, "primary-voice-key");
  assert.equal(redacted.Authorization, "[REDACTED]");
  assert.equal(redacted.nested.password, "[REDACTED]");
  assert.equal(redacted.nested.apiToken, "[REDACTED]");
  assert.equal(redacted.nested.id_token, "[REDACTED]");
  assert.equal(redacted.nested.api_key, "[REDACTED]");
  assert.equal(redacted.nested["x-api-key"], "[REDACTED]");
  assert.equal(redacted.nested.secretKey, "[REDACTED]");
  assert.equal(redacted.nested.accessKeySecret, "[REDACTED]");
  assert.equal(redacted.nested.pwd, "[REDACTED]");
  assert.equal(redacted.nested.pass, "[REDACTED]");
  assert.equal(redacted.nested.appKey, "nested-voice-key");
  assert.equal(redacted.nested.rows[0]["Admin-Token"], "[REDACTED]");
  assert.equal(redacted.nested.rows[0].access_token, "[REDACTED]");
  assert.equal(redacted.nested.rows[0].appKey, "array-voice-key");
  assert.equal(redacted.nested.rows[1].refreshToken, "[REDACTED]");
  assert.equal(redacted.nested.rows[1].client_secret, "[REDACTED]");
  assert.equal(redacted.nested.rows[1].session_id, "[REDACTED]");
  assert.equal(redacted.circular.appKey, "circular-voice-key");
  assert.equal(redacted.circular.self, "[CIRCULAR]");

  assert.equal(input.appKey, "primary-voice-key");
  assert.equal(input.nested.password, "fixture-password");
});

test("signed URLs redact generic and common object-storage credentials", () => {
  const signedUrl =
    "https://fixture-user:fixture-password@cdn.test/apps/demo.apk" +
    "?appKey=voice-demo" +
    "&apiKey=fixture-api-key" +
    "&username=fixture-user" +
    "&password=fixture-password" +
    "&safe=visible" +
    "&signature=fixture-generic-signature" +
    "&token=fixture-query-token" +
    "&expires=9999999999" +
    "&X-Amz-Credential=fixture-amz-credential" +
    "&X-Amz-Signature=fixture-amz-signature" +
    "&X-Amz-Security-Token=fixture-amz-session" +
    "&X-Amz-Expires=900" +
    "#access_token=fixture-fragment-token";

  const sanitized = new URL(sanitizeUrl(signedUrl));
  assert.equal(sanitized.origin, "https://cdn.test");
  assert.equal(sanitized.username, "");
  assert.equal(sanitized.password, "");
  assert.equal(sanitized.pathname, "/apps/demo.apk");
  assert.equal(sanitized.hash, "");
  assert.equal(sanitized.searchParams.get("appKey"), "voice-demo");
  assert.equal(sanitized.searchParams.get("safe"), "visible");

  for (const name of [
    "signature",
    "token",
    "apiKey",
    "username",
    "password",
    "expires",
    "X-Amz-Credential",
    "X-Amz-Signature",
    "X-Amz-Security-Token",
    "X-Amz-Expires",
  ]) {
    assert.equal(sanitized.searchParams.get(name), "[REDACTED]");
  }

  const nested = redactSecrets({
    appKey: "voice-demo",
    payload: {
      downloadUrl: signedUrl,
    },
  });
  assert.equal(nested.appKey, "voice-demo");
  assert.equal(
    new URL(nested.payload.downloadUrl).searchParams.get("X-Amz-Signature"),
    "[REDACTED]"
  );
});

test("backend __proto__ keys remain data and cannot create inherited records", () => {
  const malicious = JSON.parse(
    '{"__proto__":{"data":{"rows":[{"appId":"inherited-app"}]}}}'
  );
  const redacted = redactSecrets(malicious);

  assert.equal(Object.getPrototypeOf(redacted), null);
  assert.equal(Object.hasOwn(redacted, "__proto__"), true);
  assert.equal(Object.hasOwn(redacted, "data"), false);
  assert.match(stableStringify(redacted), /"__proto__"/);
});
