import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AppMarketAdminClient,
  __test as adminClientTest,
} from "../src/admin-client.js";
import { ENDPOINTS } from "../src/catalog.js";
import { AppMarketError } from "../src/security.js";
import { runWithRequestContext } from "../src/request-context.js";

const EXPECTED_ENDPOINTS = Object.freeze({
  "auth.login": ["POST", "/login", true, false],
  "session.info": ["GET", "/getInfo", false, false],
  "session.routers": ["GET", "/getRouters", false, false],
  "dashboard.user_activity.summary": [
    "POST",
    "/api/dashboard/user-activity/summary",
    false,
    true,
  ],
  "dashboard.user_activity.daily_trend": [
    "POST",
    "/api/dashboard/user-activity/daily-trend",
    false,
    true,
  ],
  "dashboard.user_activity.monthly_trend": [
    "POST",
    "/api/dashboard/user-activity/monthly-trend",
    false,
    true,
  ],
  "dashboard.user_activity.rank_distribution": [
    "POST",
    "/api/dashboard/user-activity/rank-distribution",
    false,
    true,
  ],
  "dashboard.app_usage.daily_download_trend": [
    "POST",
    "/api/dashboard/app-usage/daily-download-trend",
    false,
    true,
  ],
  "dashboard.app_usage.download_source_distribution": [
    "POST",
    "/api/dashboard/app-usage/download-source-distribution",
    false,
    true,
  ],
  "dashboard.app_usage.app_download_stats": [
    "POST",
    "/api/dashboard/app-usage/app-download-stats",
    false,
    true,
  ],
  "dashboard.app_usage.download_by_vehicle_model": [
    "POST",
    "/api/dashboard/app-usage/download-by-vehicle-model",
    false,
    true,
  ],
  "dashboard.app_usage.download_by_country": [
    "POST",
    "/api/dashboard/app-usage/download-by-country",
    false,
    true,
  ],
  "dashboard.app_usage.app_open_stats": [
    "POST",
    "/api/dashboard/app-usage/app-open-stats",
    false,
    true,
  ],
  "dashboard.app_usage.app_uninstall_stats": [
    "POST",
    "/api/dashboard/app-usage/app-uninstall-stats",
    false,
    true,
  ],
  "dashboard.app_usage.app_update_stats": [
    "POST",
    "/api/dashboard/app-usage/app-update-stats",
    false,
    true,
  ],
  "dashboard.app_usage.web_app_duration_stats": [
    "POST",
    "/api/dashboard/app-usage/web-app-duration-stats",
    false,
    true,
  ],
  "dictionary.by_type": [
    "GET",
    "/system/dict/data/type/{dictType}",
    false,
    false,
  ],
  "dictionary.list": ["GET", "/system/dict/data/list", false, false],
  "application.type_list": [
    "GET",
    "/system/app_type/data/list",
    false,
    false,
  ],
  "application.departments": [
    "GET",
    "/system/appinfo/getDept",
    false,
    false,
  ],
  "application.plugin_list": [
    "GET",
    "/system/appinfo/getPluginList",
    false,
    false,
  ],
  "application.web_name_list": [
    "GET",
    "/system/appinfo/getWebNameList",
    false,
    false,
  ],
  "application.list": ["GET", "/system/appinfo/list", false, false],
  "application.android_versions": [
    "GET",
    "/system/appinfo/listAndroidVersion",
    false,
    false,
  ],
  "car_model.list": ["GET", "/system/carmodel/list", false, false],
  "car_model.departments": [
    "GET",
    "/system/carmodel/listDept",
    false,
    false,
  ],
  "country.list": ["GET", "/system/country/list", false, false],
  "language.list": ["GET", "/system/language/list", false, false],
  "webapp_config.list": [
    "GET",
    "/api/webappconfig/getList",
    false,
    false,
  ],
  "application.country_list": [
    "GET",
    "/system/appinfo/appInfoCountryList",
    false,
    false,
  ],
  "car_model.country_map": [
    "GET",
    "/system/carmodel/list/country/car-model",
    false,
    false,
  ],
  "carousel.list": ["GET", "/system/carouselmap/list", false, false],
  "application.list_simple": [
    "GET",
    "/system/appinfo/listAppInfo",
    false,
    false,
  ],
  "application.channel_list": [
    "GET",
    "/system/appInfoChannel/list",
    false,
    false,
  ],
  "application.name_list": [
    "GET",
    "/system/appinfo/getNameList",
    false,
    false,
  ],
  "application.car_name_list": [
    "GET",
    "/system/appinfo/getCarNameList",
    false,
    false,
  ],
});

function makeConfig(overrides = {}) {
  return {
    environment: "test",
    baseUrl: "http://admin.test",
    apiPrefix: "/admin-api",
    allowedOrigins: new Set(["http://admin.test"]),
    token: "fixture-static-token",
    username: "",
    password: "",
    loginCurlFile: "",
    timeoutMs: 1_000,
    maxResponseBytes: 1024 * 1024,
    tokenTtlMs: 60_000,
    ...overrides,
  };
}

function makeClient(configOverrides = {}, options = {}) {
  return new AppMarketAdminClient(makeConfig(configOverrides), {
    audit: () => {},
    ...options,
  });
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function errorWithCode(code, status) {
  return (error) => {
    assert.ok(error instanceof AppMarketError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleWithin(promise, timeoutMs = 250) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`fixture did not settle within ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCondition(predicate, timeoutMs = 250) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`fixture condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("endpoint catalog is an exact read-only allowlist", () => {
  const actual = Object.fromEntries(
    Object.entries(ENDPOINTS).map(([id, endpoint]) => [
      id,
      [
        endpoint.method,
        endpoint.path,
        Boolean(endpoint.internalAuth),
        Boolean(endpoint.readOnlyPost),
      ],
    ])
  );
  assert.deepEqual(actual, EXPECTED_ENDPOINTS);

  for (const [id, endpoint] of Object.entries(ENDPOINTS)) {
    if (endpoint.internalAuth) continue;
    assert.equal(adminClientTest.assertEndpointAllowed(id), endpoint);
    assert.ok(
      endpoint.method === "GET" ||
        (endpoint.method === "POST" && endpoint.readOnlyPost === true),
      `${id} must remain GET or an explicitly reviewed read-only POST`
    );
  }
});

test("unknown endpoint identifiers and internal login are rejected before fetch", async () => {
  let fetchCalls = 0;
  const client = makeClient(
    {},
    {
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({ code: 200 });
      },
    }
  );

  for (const endpointId of [
    "auth.login",
    "unknown.endpoint",
    "country.list?state=0",
    "/system/country/list",
    "__proto__",
    "constructor",
  ]) {
    await assert.rejects(
      client.request(endpointId),
      errorWithCode("ENDPOINT_NOT_ALLOWED")
    );
  }
  assert.equal(fetchCalls, 0);
});

test("query, body, path, and dashboard dimension inputs are exact allowlists", () => {
  const client = makeClient();

  assert.throws(
    () =>
      client.buildRequest(ENDPOINTS["country.list"], {
        query: { pageNum: 1, redirect: "http://evil.test" },
        body: {},
        pathValues: {},
      }),
    errorWithCode("INVALID_ARGUMENT")
  );

  assert.throws(
    () =>
      client.buildRequest(ENDPOINTS["dashboard.user_activity.summary"], {
        query: {},
        body: {
          startDate: "2026-07-01",
          endDate: "2026-07-02",
          command: "delete",
        },
        pathValues: {},
      }),
    errorWithCode("INVALID_ARGUMENT")
  );

  assert.throws(
    () =>
      client.buildRequest(
        ENDPOINTS["dashboard.user_activity.rank_distribution"],
        {
          query: {},
          body: {
            startDate: "2026-07-01",
            endDate: "2026-07-02",
            dimension: "../../login",
          },
          pathValues: {},
        }
      ),
    errorWithCode("INVALID_ARGUMENT")
  );

  assert.throws(
    () =>
      client.buildRequest(ENDPOINTS["dictionary.by_type"], {
        query: {},
        body: {},
        pathValues: { dictType: "../../login" },
      }),
    errorWithCode("INVALID_ARGUMENT")
  );

  const allowed = client.buildRequest(
    ENDPOINTS["dashboard.user_activity.rank_distribution"],
    {
      query: {},
      body: {
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        dimension: "country",
      },
      pathValues: {},
    }
  );
  assert.equal(
    allowed.url.href,
    "http://admin.test/admin-api/api/dashboard/user-activity/rank-distribution"
  );
  assert.equal(allowed.options.method, "POST");
  assert.deepEqual(JSON.parse(allowed.options.body), {
    startDate: "2026-07-01",
    endDate: "2026-07-02",
    dimension: "country",
  });
});

test("concurrent and subsequent requests share the cached login token", async () => {
  let loginCalls = 0;
  let endpointCalls = 0;
  const authorizationHeaders = [];
  const auditEvents = [];
  const client = makeClient(
    {
      token: "",
      username: "fixture-user",
      password: "fixture-password",
    },
    {
      now: () => 1_000,
      audit: (event) => auditEvents.push(event),
      fetchImpl: async (url, options) => {
        if (String(url).endsWith("/admin-api/login")) {
          loginCalls += 1;
          return jsonResponse({ token: "fixture-login-token" });
        }
        endpointCalls += 1;
        authorizationHeaders.push(options.headers.Authorization);
        return jsonResponse({ code: 200, rows: [] });
      },
    }
  );

  await Promise.all([
    client.request("country.list", { query: { pageNum: 1, pageSize: 10 } }),
    client.request("application.list", {
      query: { pageNum: 1, pageSize: 10 },
    }),
  ]);
  await client.request("country.list", {
    query: { pageNum: 2, pageSize: 10 },
  });

  assert.equal(loginCalls, 1);
  assert.equal(endpointCalls, 3);
  assert.deepEqual(authorizationHeaders, [
    "Bearer fixture-login-token",
    "Bearer fixture-login-token",
    "Bearer fixture-login-token",
  ]);
  const auditText = JSON.stringify(auditEvents);
  assert.ok(!auditText.includes("fixture-password"));
  assert.ok(!auditText.includes("fixture-login-token"));
});

test("shared login isolates cancellation for every waiter", async (t) => {
  const credentialConfig = {
    token: "",
    username: "fixture-user",
    password: "fixture-password",
  };

  await t.test("a later waiter cancels without interrupting the initiator", async () => {
    const loginGate = deferred();
    let endpointCalls = 0;
    let loginCalls = 0;
    let loginSignal;
    const client = makeClient(credentialConfig, {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith("/admin-api/login")) {
          loginCalls += 1;
          loginSignal = options.signal;
          return loginGate.promise;
        }
        endpointCalls += 1;
        return jsonResponse({ code: 200, rows: [] });
      },
    });
    const initiator = new AbortController();
    const waiter = new AbortController();
    const initiatorRequest = runWithRequestContext(
      { signal: initiator.signal },
      () => client.request("country.list"),
      1_000
    );
    const waiterRequest = runWithRequestContext(
      { signal: waiter.signal },
      () => client.request("application.list"),
      1_000
    );

    waiter.abort();
    await settleWithin(
      assert.rejects(waiterRequest, errorWithCode("REQUEST_CANCELLED"))
    );
    assert.equal(loginSignal.aborted, false);
    loginGate.resolve(jsonResponse({ token: "fixture-shared-token" }));
    const result = await settleWithin(initiatorRequest);

    assert.equal(result.data.code, 200);
    assert.equal(loginCalls, 1);
    assert.equal(endpointCalls, 1);
  });

  await t.test("initiator cancellation does not interrupt a valid waiter", async () => {
    const loginGate = deferred();
    let endpointCalls = 0;
    let loginCalls = 0;
    let loginSignal;
    const client = makeClient(credentialConfig, {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith("/admin-api/login")) {
          loginCalls += 1;
          loginSignal = options.signal;
          return loginGate.promise;
        }
        endpointCalls += 1;
        return jsonResponse({ code: 200, rows: [] });
      },
    });
    const initiator = new AbortController();
    const waiter = new AbortController();
    const initiatorRequest = runWithRequestContext(
      { signal: initiator.signal },
      () => client.request("country.list"),
      1_000
    );
    const waiterRequest = runWithRequestContext(
      { signal: waiter.signal },
      () => client.request("application.list"),
      1_000
    );

    initiator.abort();
    await settleWithin(
      assert.rejects(initiatorRequest, errorWithCode("REQUEST_CANCELLED"))
    );
    assert.equal(loginSignal.aborted, false);
    loginGate.resolve(jsonResponse({ token: "fixture-shared-token" }));
    const result = await settleWithin(waiterRequest);

    assert.equal(result.data.code, 200);
    assert.equal(loginCalls, 1);
    assert.equal(endpointCalls, 1);
  });

  await t.test("the last cancelled waiter aborts login and a new request starts fresh", async () => {
    const firstLoginGate = deferred();
    const replacementLoginGate = deferred();
    const authorizationHeaders = [];
    let endpointCalls = 0;
    let firstLoginSignal;
    let loginCalls = 0;
    const client = makeClient(credentialConfig, {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith("/admin-api/login")) {
          loginCalls += 1;
          if (loginCalls === 1) {
            firstLoginSignal = options.signal;
            return firstLoginGate.promise;
          }
          return replacementLoginGate.promise;
        }
        endpointCalls += 1;
        authorizationHeaders.push(options.headers.Authorization);
        return jsonResponse({ code: 200, rows: [] });
      },
    });
    const initiator = new AbortController();
    const waiter = new AbortController();
    const initiatorRequest = runWithRequestContext(
      { signal: initiator.signal },
      () => client.request("country.list"),
      1_000
    );
    const waiterRequest = runWithRequestContext(
      { signal: waiter.signal },
      () => client.request("application.list"),
      1_000
    );

    await waitForCondition(() => loginCalls === 1);
    initiator.abort();
    waiter.abort();
    await settleWithin(
      Promise.all([
        assert.rejects(initiatorRequest, errorWithCode("REQUEST_CANCELLED")),
        assert.rejects(waiterRequest, errorWithCode("REQUEST_CANCELLED")),
      ])
    );
    assert.equal(firstLoginSignal.aborted, true);

    const replacementRequest = runWithRequestContext(
      {},
      () => client.request("country.list"),
      1_000
    );
    await waitForCondition(() => loginCalls === 2);
    firstLoginGate.resolve(jsonResponse({ token: "fixture-abandoned-token" }));
    replacementLoginGate.resolve(
      jsonResponse({ token: "fixture-replacement-token" })
    );
    const replacement = await settleWithin(replacementRequest);
    const cached = await settleWithin(
      runWithRequestContext({}, () => client.request("application.list"), 1_000)
    );

    assert.equal(replacement.data.code, 200);
    assert.equal(cached.data.code, 200);
    assert.equal(loginCalls, 2);
    assert.equal(endpointCalls, 2);
    assert.deepEqual(authorizationHeaders, [
      "Bearer fixture-replacement-token",
      "Bearer fixture-replacement-token",
    ]);
  });
});

test("a 401 performs one re-login and retries once with the refreshed token", async () => {
  let loginCalls = 0;
  let endpointCalls = 0;
  const authorizationHeaders = [];
  const client = makeClient(
    {
      token: "",
      username: "fixture-user",
      password: "fixture-password",
    },
    {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith("/admin-api/login")) {
          loginCalls += 1;
          return jsonResponse({ token: `fixture-token-${loginCalls}` });
        }
        endpointCalls += 1;
        authorizationHeaders.push(options.headers.Authorization);
        if (endpointCalls === 1) {
          return jsonResponse({ code: 401 }, 401);
        }
        return jsonResponse({ code: 200, rows: [] });
      },
    }
  );

  const result = await client.request("country.list", {
    query: { pageNum: 1, pageSize: 10 },
  });

  assert.equal(result.data.code, 200);
  assert.equal(loginCalls, 2);
  assert.equal(endpointCalls, 2);
  assert.deepEqual(authorizationHeaders, [
    "Bearer fixture-token-1",
    "Bearer fixture-token-2",
  ]);
});

test("a stale concurrent 401 reuses the refreshed token without a third login", async () => {
  const firstCountry401 = deferred();
  const firstApplication401 = deferred();
  const authorizationHeaders = [];
  let loginCalls = 0;
  let oldTokenCalls = 0;
  const client = makeClient(
    {
      token: "",
      username: "fixture-user",
      password: "fixture-password",
    },
    {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith("/admin-api/login")) {
          loginCalls += 1;
          return jsonResponse({ token: `fixture-token-${loginCalls}` });
        }
        authorizationHeaders.push(options.headers.Authorization);
        if (options.headers.Authorization === "Bearer fixture-token-1") {
          oldTokenCalls += 1;
          return String(url).includes("/system/appinfo/list")
            ? firstApplication401.promise
            : firstCountry401.promise;
        }
        return jsonResponse({ code: 200, rows: [] });
      },
    }
  );

  const countryRequest = client.request("country.list", {
    query: { pageNum: 1, pageSize: 10 },
  });
  const applicationRequest = client.request("application.list", {
    query: { pageNum: 1, pageSize: 10 },
  });
  await waitForCondition(() => oldTokenCalls === 2);

  firstCountry401.resolve(jsonResponse({ code: 401 }, 401));
  const countryResult = await settleWithin(countryRequest);
  assert.equal(countryResult.data.code, 200);
  assert.equal(loginCalls, 2);

  firstApplication401.resolve(jsonResponse({ code: 401 }, 401));
  const applicationResult = await settleWithin(applicationRequest);

  assert.equal(applicationResult.data.code, 200);
  assert.equal(loginCalls, 2);
  assert.deepEqual(authorizationHeaders, [
    "Bearer fixture-token-1",
    "Bearer fixture-token-1",
    "Bearer fixture-token-2",
    "Bearer fixture-token-2",
  ]);
});

test("a second 401 fails without a third login or retry loop", async () => {
  let loginCalls = 0;
  let endpointCalls = 0;
  const client = makeClient(
    {
      token: "",
      username: "fixture-user",
      password: "fixture-password",
    },
    {
      fetchImpl: async (url) => {
        if (String(url).endsWith("/admin-api/login")) {
          loginCalls += 1;
          return jsonResponse({ token: `fixture-token-${loginCalls}` });
        }
        endpointCalls += 1;
        return jsonResponse({ code: 401 }, 401);
      },
    }
  );

  await assert.rejects(
    client.request("country.list"),
    errorWithCode("AUTH_FAILED", 401)
  );
  assert.equal(loginCalls, 2);
  assert.equal(endpointCalls, 2);
});

test("403 is surfaced as one stable non-retryable permission error", async () => {
  let fetchCalls = 0;
  const client = makeClient(
    {},
    {
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(
          {
            code: 403,
            msg: "fixture upstream details must not replace the stable error",
          },
          403
        );
      },
    }
  );

  let caught;
  try {
    await client.request("country.list");
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AppMarketError);
  assert.equal(caught.code, "FORBIDDEN");
  assert.equal(caught.status, 403);
  assert.equal(caught.retryable, false);
  assert.equal(caught.message, "当前后台账号无此只读接口权限");
  assert.equal(fetchCalls, 1);
});

test("read and login redirects are blocked with manual redirect handling", async (t) => {
  await t.test("read redirect", async () => {
    let redirectMode;
    let fetchCalls = 0;
    const client = makeClient(
      {},
      {
        fetchImpl: async (_url, options) => {
          fetchCalls += 1;
          redirectMode = options.redirect;
          return new Response(null, {
            status: 302,
            headers: {
              location: "http://evil.test/collect",
            },
          });
        },
      }
    );

    await assert.rejects(
      client.request("country.list"),
      errorWithCode("UPSTREAM_REDIRECT_BLOCKED", 302)
    );
    assert.equal(redirectMode, "manual");
    assert.equal(fetchCalls, 1);
  });

  await t.test("login redirect", async () => {
    let redirectMode;
    let fetchCalls = 0;
    const client = makeClient(
      {
        token: "",
        username: "fixture-user",
        password: "fixture-password",
      },
      {
        fetchImpl: async (_url, options) => {
          fetchCalls += 1;
          redirectMode = options.redirect;
          return new Response(null, {
            status: 307,
            headers: {
              location: "http://evil.test/collect",
            },
          });
        },
      }
    );

    await assert.rejects(
      client.request("country.list"),
      errorWithCode("UPSTREAM_REDIRECT_BLOCKED", 307)
    );
    assert.equal(redirectMode, "manual");
    assert.equal(fetchCalls, 1);
  });
});

test("declared and streamed oversized responses are rejected", async (t) => {
  await t.test("declared content length", async () => {
    const client = makeClient(
      { maxResponseBytes: 32 },
      {
        fetchImpl: async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "content-length": "33",
              "content-type": "application/json",
            },
          }),
      }
    );

    await assert.rejects(
      client.request("country.list"),
      errorWithCode("RESPONSE_TOO_LARGE", 200)
    );
  });

  await t.test("streamed body without content length", async () => {
    const client = makeClient(
      { maxResponseBytes: 32 },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ code: 200, data: "x".repeat(64) }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
      }
    );

    await assert.rejects(
      client.request("country.list"),
      errorWithCode("RESPONSE_TOO_LARGE", 200)
    );
  });
});

test("request timeout covers a stalled response body, not only headers", async () => {
  const client = makeClient(
    { timeoutMs: 20 },
    {
      fetchImpl: async (_url, options) => {
        const body = new ReadableStream({
          start(controller) {
            const delayedBody = setTimeout(() => {
              controller.enqueue(
                new TextEncoder().encode('{"code":200,"rows":[]}')
              );
              controller.close();
            }, 200);
            options.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(delayedBody);
                const error = new Error("fixture body aborted");
                error.name = "AbortError";
                controller.error(error);
              },
              { once: true }
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }
  );

  const startedAt = Date.now();
  await assert.rejects(
    client.request("country.list"),
    errorWithCode("UPSTREAM_TIMEOUT")
  );
  assert.ok(Date.now() - startedAt < 150);
});

test("MCP cancellation and the overall operation deadline stop pending I/O", async (t) => {
  const neverRespond = async () => new Promise(() => {});

  await t.test("caller cancellation", async () => {
    const caller = new AbortController();
    const client = makeClient({}, { fetchImpl: neverRespond });
    const pending = runWithRequestContext(
      { signal: caller.signal },
      () => client.request("country.list"),
      1_000
    );
    setTimeout(() => caller.abort(), 10);
    await assert.rejects(pending, errorWithCode("REQUEST_CANCELLED"));
  });

  await t.test("operation deadline", async () => {
    const client = makeClient({}, { fetchImpl: neverRespond });
    await assert.rejects(
      runWithRequestContext(
        {},
        () => client.request("country.list"),
        20
      ),
      errorWithCode("OPERATION_TIMEOUT")
    );
  });

  await t.test("caller cancellation stops initial login", async () => {
    const caller = new AbortController();
    let loginSignal;
    const client = makeClient(
      {
        token: "",
        username: "fixture-user",
        password: "fixture-password",
      },
      {
        fetchImpl: async (_url, options) => {
          loginSignal = options.signal;
          return new Promise(() => {});
        },
      }
    );
    const pending = runWithRequestContext(
      { signal: caller.signal },
      () => client.request("country.list"),
      1_000
    );
    setTimeout(() => caller.abort(), 10);
    await assert.rejects(pending, errorWithCode("REQUEST_CANCELLED"));
    assert.equal(loginSignal.aborted, true);
  });

  await t.test("immediate cancellation prevents initial login I/O", async () => {
    const caller = new AbortController();
    let fetchCalls = 0;
    const client = makeClient(
      {
        token: "",
        username: "fixture-user",
        password: "fixture-password",
      },
      {
        fetchImpl: async () => {
          fetchCalls += 1;
          return jsonResponse({ token: "must-not-be-used" });
        },
      }
    );
    const pending = runWithRequestContext(
      { signal: caller.signal },
      () => client.request("country.list"),
      1_000
    );

    caller.abort();
    await assert.rejects(pending, errorWithCode("REQUEST_CANCELLED"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls, 0);
  });

  await t.test("caller cancellation stops a 401 token refresh", async () => {
    const caller = new AbortController();
    let loginCalls = 0;
    let refreshSignal;
    const client = makeClient(
      {
        token: "",
        username: "fixture-user",
        password: "fixture-password",
      },
      {
        fetchImpl: async (url, options) => {
          if (String(url).endsWith("/admin-api/login")) {
            loginCalls += 1;
            if (loginCalls === 1) {
              return jsonResponse({ token: "fixture-initial-token" });
            }
            refreshSignal = options.signal;
            return new Promise(() => {});
          }
          return jsonResponse({ code: 401 }, 401);
        },
      }
    );
    const pending = runWithRequestContext(
      { signal: caller.signal },
      () => client.request("country.list"),
      1_000
    );
    setTimeout(() => caller.abort(), 20);
    await assert.rejects(pending, errorWithCode("REQUEST_CANCELLED"));
    assert.equal(loginCalls, 2);
    assert.equal(refreshSignal.aborted, true);
  });

  await t.test("cancellation before refresh login I/O prevents the fetch", async () => {
    const caller = new AbortController();
    const refreshCredentialsGate = deferred();
    const credentials = {
      username: "fixture-user",
      password: "fixture-password",
    };
    let credentialsCalls = 0;
    let loginFetchCalls = 0;
    const client = makeClient(
      {
        token: "",
        ...credentials,
      },
      {
        fetchImpl: async (url) => {
          if (String(url).endsWith("/admin-api/login")) {
            loginFetchCalls += 1;
            return jsonResponse({ token: "fixture-initial-token" });
          }
          return jsonResponse({ code: 401 }, 401);
        },
      }
    );
    client.credentials = async () => {
      credentialsCalls += 1;
      if (credentialsCalls === 3) {
        return refreshCredentialsGate.promise;
      }
      return credentials;
    };
    const pending = runWithRequestContext(
      { signal: caller.signal },
      () => client.request("country.list"),
      1_000
    );
    await waitForCondition(() => credentialsCalls === 3);

    caller.abort();
    await assert.rejects(pending, errorWithCode("REQUEST_CANCELLED"));
    refreshCredentialsGate.resolve(credentials);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(loginFetchCalls, 1);
  });
});
