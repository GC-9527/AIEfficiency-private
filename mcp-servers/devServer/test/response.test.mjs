import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionPayload,
  compareExpected,
  extractCollection,
  extractTotal,
  filterItems,
  mergeVoiceRecords,
  normalizeVoiceKey,
  voiceKeysForRecord,
} from "../src/response.js";
import { __test as toolTest } from "../src/tools.js";
import { AppMarketError } from "../src/security.js";

test("extractCollection uses endpoint-specific observed containers", () => {
  assert.deepEqual(extractCollection({ rows: [{ id: 1 }] }), {
    items: [{ id: 1 }],
    adapter: "rows",
  });
  assert.deepEqual(
    extractCollection({ data: { records: [{ id: 2 }] } }),
    {
      items: [{ id: 2 }],
      adapter: "data.records",
    }
  );
  assert.deepEqual(extractCollection({ data: { rows: [{ id: 3 }] } }), {
    items: [{ id: 3 }],
    adapter: "data.rows",
  });

  const inherited = Object.create({
    data: { rows: [{ appId: "inherited-app" }] },
  });
  assert.deepEqual(extractCollection(inherited), {
    items: [],
    adapter: "none",
  });
  assert.deepEqual(filterItems([Object.create({ appId: "inherited-app" })], {
    appId: "inherited-app",
  }), []);
});

test("null and blank totals stay unknown instead of becoming zero", () => {
  assert.equal(extractTotal({ total: null }, null), null);
  assert.equal(extractTotal({ total: "" }, null), null);
  assert.equal(extractTotal({ data: { total: "  " } }, null), null);
  assert.equal(extractTotal({ total: "3" }, null), 3);
});

test("voice key normalization matches VoiceAppConfigIndex behavior", () => {
  assert.equal(normalizeVoiceKey(" Apple Music "), "applemusic");
  assert.equal(normalizeVoiceKey("APPLE 123"), "apple123");
  assert.equal(normalizeVoiceKey(" 苹果 音乐 "), "苹果 音乐");
  assert.deepEqual(
    voiceKeysForRecord({
      appName: "Apple Music",
      appKey: "apple music web,苹果音乐",
    }),
    ["applemusicweb", "苹果音乐", "applemusic"]
  );
});

test("catalog and detailed voice records merge aliases without dropping fallback identity", () => {
  const merged = mergeVoiceRecords(
    [
      {
        appId: "1",
        appName: "Apple Music",
        appKey: "applemusic,apple music web",
        packageName: "com.example.music",
      },
    ],
    [
      {
        appId: "1",
        appName: "Apple Music",
        appKey: "applemusic",
        configJson: { inject: true },
      },
    ]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].packageName, "com.example.music");
  assert.equal(merged[0].appKey, "applemusic,applemusicweb");
  assert.deepEqual(merged[0].configJson, { inject: true });
});

test("local record filters cover application distribution fields", () => {
  const items = [
    {
      id: "app-1",
      appName: "Spotify",
      packageName: "com.spotify.music",
      deptId: "dept-a",
      carModelIds: ["car-1", "car-2"],
      countryList: [{ internationalCode: "DE" }],
      state: 0,
    },
  ];
  assert.equal(
    filterItems(items, {
      appName: "spot",
      packageName: "spotify",
      deptId: "dept-a",
      carModelId: "car-2",
      country: "de",
      state: 0,
    }).length,
    1
  );
  assert.equal(filterItems(items, { carModelId: "car-3" }).length, 0);

  const banner = {
    id: "requested-app",
    appId: "different-app",
    carModelIds: ["different-car"],
  };
  assert.equal(filterItems([banner], { appId: "requested-app" }).length, 0);
  assert.equal(filterItems([banner], { carModelId: "requested-app" }).length, 0);
  assert.equal(
    filterItems([{ id: "requested-app" }], {
      catalogAppId: "requested-app",
    }).length,
    1
  );
});

test("collection payload omits configJson by default and warns on schema drift", () => {
  const result = {
    endpointId: "webapp_config.list",
    requestId: "request-1",
    fetchedAt: "2026-07-23T00:00:00.000Z",
    data: {
      code: 200,
      data: {
        rows: [
          {
            id: "1",
            appId: "app-1",
            appName: "Example",
            configJson: '{"token":"SECRET","appKey":"voice-key"}',
          },
        ],
        total: 1,
      },
    },
  };
  const payload = collectionPayload(result, {
    query: { pageNum: 1, pageSize: 20 },
    expectedAdapter: "data.records",
  });
  assert.equal(payload.status, "partial");
  assert.equal(payload.data.items[0].configJson, undefined);
  assert.match(payload.meta.validation.warnings[0], /响应容器/);
});

test("included invalid configJson is replaced instead of returning raw text", () => {
  const payload = collectionPayload(
    {
      endpointId: "webapp_config.list",
      requestId: "request-invalid-json",
      fetchedAt: "2026-07-23T00:00:00.000Z",
      environment: "custom-stg",
      data: {
        data: {
          records: [
            {
              id: "1",
              appId: "app-1",
              appName: "Example",
              configJson: '{"token":"must-not-be-returned"',
            },
          ],
          total: 1,
        },
      },
    },
    {
      query: { pageNum: 1, pageSize: 20 },
      includeConfigJson: true,
      expectedAdapter: "data.records",
    }
  );

  assert.equal(payload.data.items[0].configJson, "[CONFIG_JSON_INVALID]");
  assert.equal(payload.meta.environment, "custom-stg");
});

test("expected comparison supports scalar and repeated backend fields", () => {
  const checks = compareExpected(
    {
      state: 0,
      carModelIds: ["car-1", "car-2"],
      countryList: ["DE", "AT"],
    },
    {
      state: 0,
      carModelIds: "car-2",
      countryList: ["DE", "AT"],
    }
  );
  assert.ok(checks.every((item) => item.pass));
});

test("voice key lookup uses bounded upstream pages for large WebApp configs", async () => {
  const requests = [];
  const client = {
    async request(endpointId, { query }) {
      requests.push({ endpointId, query });
      return {
        endpointId,
        requestId: `request-${requests.length}`,
        fetchedAt: "2026-07-23T00:00:00.000Z",
        data:
          endpointId === "application.list"
            ? {
                data: {
                  rows: [
                    {
                      id: "app-1",
                      appName: "Example",
                      appKey: "example voice",
                    },
                  ],
                  total: 1,
                },
              }
            : {
                data: {
                  records: [
                    {
                      id: "web-1",
                      appId: "app-1",
                      appName: "Example",
                      configJson: '{"appKey":"example web"}',
                    },
                  ],
                  total: 1,
                },
              },
      };
    },
  };

  const payload = await toolTest.voiceOpenKeyPayload(client, {
    appId: "app-1",
    maxPages: 2,
  });

  assert.equal(payload.data.items.length, 1);
  assert.equal(
    payload.data.items[0].normalizedVoiceKeys.includes("exampleweb"),
    false
  );
  assert.ok(requests.length >= 2);
  assert.equal(
    requests.find(({ endpointId }) => endpointId === "application.list").query
      .pageSize,
    20
  );
  assert.equal(
    requests.find(({ endpointId }) => endpointId === "webapp_config.list").query
      .pageSize,
    10
  );
});

test("a complete voice lookup with no matching app remains definitive", async () => {
  const client = {
    async request(endpointId) {
      const container =
        endpointId === "application.list"
          ? { data: { rows: [], total: 0 } }
          : { data: { records: [], total: 0 } };
      return {
        endpointId,
        requestId: `request-${endpointId}`,
        fetchedAt: "2026-07-23T00:00:00.000Z",
        data: container,
      };
    },
  };

  const payload = await toolTest.voiceOpenKeyPayload(client, {
    appId: "missing-app",
    maxPages: 2,
  });

  assert.equal(payload.status, "ok");
  assert.deepEqual(payload.data.items, []);
  assert.equal(
    toolTest.mergeVerificationMeta(payload, { matches: [], pass: false }, "fail")
      .status,
    "fail"
  );
});

test("verification cannot upgrade incomplete evidence to pass or fail", () => {
  const payload = {
    status: "partial",
    meta: {
      validation: {
        schema: "warning",
        warnings: ["pagination truncated"],
      },
    },
  };

  assert.equal(
    toolTest.mergeVerificationMeta(payload, { pass: true }, "pass").status,
    "partial"
  );
  assert.equal(
    toolTest.mergeVerificationMeta(payload, { pass: false }, "fail").status,
    "partial"
  );
});

test("paginated reads retry with smaller pages after a response-size failure", async () => {
  const requests = [];
  const client = {
    async request(endpointId, { query }) {
      requests.push({ endpointId, query });
      if (query.pageSize === 4) {
        throw new AppMarketError(
          "RESPONSE_TOO_LARGE",
          "fixture response too large"
        );
      }
      const rows =
        query.pageNum === 1
          ? [{ id: "1" }, { id: "2" }]
          : [{ id: "3" }];
      return {
        endpointId,
        requestId: `request-${requests.length}`,
        fetchedAt: "2026-07-23T00:00:00.000Z",
        data: { data: { rows, total: 3 } },
      };
    },
  };

  const payload = await toolTest.fetchAllPages(client, "application.list", {
    pageSize: 4,
    maxPages: 1,
  });

  assert.deepEqual(
    requests.map(({ query }) => [query.pageNum, query.pageSize]),
    [
      [1, 4],
      [1, 2],
      [2, 2],
    ]
  );
  assert.equal(payload.status, "ok");
  assert.equal(payload.data.items.length, 3);
  assert.equal(payload.meta.page.complete, true);
});

test("missing pagination total is never reported as proven complete", async () => {
  const requests = [];
  const client = {
    async request(endpointId, { query }) {
      requests.push({ endpointId, query });
      return {
        endpointId,
        requestId: `request-${requests.length}`,
        fetchedAt: "2026-07-23T00:00:00.000Z",
        data: {
          data: {
            rows:
              query.pageNum === 1
                ? [{ id: "1" }, { id: "2" }]
                : [{ id: "3" }],
          },
        },
      };
    },
  };

  const payload = await toolTest.fetchAllPages(client, "application.list", {
    pageSize: 2,
    maxPages: 3,
  });

  assert.equal(requests.length, 2);
  assert.equal(payload.data.items.length, 3);
  assert.equal(payload.status, "partial");
  assert.equal(payload.meta.page.complete, false);
  assert.match(payload.meta.validation.warnings[0], /未返回 total/);
});

test("self-check reports a changed response container as partial", async () => {
  const client = {
    async request(endpointId) {
      return {
        endpointId,
        requestId: "request-wrong-adapter",
        fetchedAt: "2026-07-23T00:00:00.000Z",
        data: {
          rows: [
            {
              id: "banner-1",
              appId: "app-1",
              imgUrl: "https://cdn.test/banner.png",
              state: 1,
              sort: 1,
            },
          ],
        },
      };
    },
  };

  const result = await toolTest.runSelfCheckCase(client, {
    name: "banners",
    endpointId: "carousel.list",
    query: { pageNum: 1, pageSize: 1 },
  });

  assert.equal(result.status, "partial");
  assert.match(result.warnings.join(" "), /响应容器/);
});

test("channel distribution matches both channel and expected state", () => {
  const packageNames = new Set(["com.example.app"]);
  const args = { expectedChannel: "global", expectedState: 1 };

  assert.equal(
    toolTest.matchesChannelDistribution(
      { appPkg: "com.example.app", channel: "global", state: 0 },
      packageNames,
      args
    ),
    false
  );
  assert.equal(
    toolTest.matchesChannelDistribution(
      { appPkg: "com.example.app", channel: "global", state: 1 },
      packageNames,
      args
    ),
    true
  );
});

test("dashboard date ranges require real ordered dates within 366 days", () => {
  assert.doesNotThrow(() =>
    toolTest.validateDashboardDateRange("2024-02-29", "2025-02-28")
  );
  for (const [startDate, endDate] of [
    ["2025-02-30", "2025-03-01"],
    ["2025-03-02", "2025-03-01"],
    ["2025-01-01", "2026-01-02"],
  ]) {
    assert.throws(
      () => toolTest.validateDashboardDateRange(startDate, endDate),
      (error) =>
        error instanceof AppMarketError &&
        error.code === "INVALID_ARGUMENT"
    );
  }
});
