import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureFeishuProjectMcpItems,
  clearFeishuProjectMcpStatusCache,
  getFeishuProjectMcpFilterMetadata,
  getFeishuProjectMcpStatus,
  refreshFeishuProjectMcpAttachmentDownload,
} from "../../features/FeiShuProjects/src/feishu-mcp-client.js";
import { syncFeishuProjectWorkItem } from "../../features/FeiShuProjects/src/gateway-sync-service.js";

const TRANSIENT_BITS_ERROR = "id=1000053838, code=1000053838, message=error occurs, chain=[bytedance.bits.search_public:metadata error (Code: 3001) | Context: internal error | Cause: remote or network error[remote]: error_code=1115 cds_key=THRIFT_INGRESS|bytedance.bits.search_public:default:lf:|bytedance.bits.workitem_public:default:lf::|MultiQueryFieldsV3|prod| get connection failed, reason=POOL_FAILURE_RemoteConnectionFailure]";

test("MCP status reuses recent success and deduplicates repeated tool discovery", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (_url, init = {}) => {
    requestCount += 1;
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") return mcpResponse(payload.id, { tools: [briefTool()] });
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  clearFeishuProjectMcpStatusCache();
  try {
    const config = syncConfig({ token: "status-cache-token", retryAttempts: 0 });
    const first = await getFeishuProjectMcpStatus(config);
    const callsAfterFirst = requestCount;
    const second = await getFeishuProjectMcpStatus(config);
    assert.equal(first.connected, true);
    assert.equal(second.connected, true);
    assert.equal(requestCount, callsAfterFirst);

    await getFeishuProjectMcpStatus(config, { forceRefresh: true });
    assert.ok(requestCount > callsAfterFirst);
  } finally {
    clearFeishuProjectMcpStatusCache();
    globalThis.fetch = originalFetch;
  }
});

test("MCP status redacts a header token reflected by error bodies and authentication headers", async () => {
  const originalFetch = globalThis.fetch;
  const token = "error-reflection-sentinel-81f032";
  globalThis.fetch = async (_url, init = {}) => {
    const reflected = init.headers?.["X-Mcp-Token"] || "";
    return {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: {
        get: (name) => {
          if (String(name).toLowerCase() === "location") {
            return `https://mcp.test/authorize?access_token=${encodeURIComponent(reflected)}`;
          }
          if (String(name).toLowerCase() === "www-authenticate") return `Bearer error="${reflected}"`;
          return null;
        },
      },
      text: async () => `upstream echoed ${reflected}`,
    };
  };

  clearFeishuProjectMcpStatusCache();
  try {
    const status = await getFeishuProjectMcpStatus(syncConfig({ token }), { forceRefresh: true });
    const serialized = JSON.stringify(status);
    assert.equal(status.connected, false);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(encodeURIComponent(token)), false);
    assert.match(serialized, /\[REDACTED\]/);
  } finally {
    clearFeishuProjectMcpStatusCache();
    globalThis.fetch = originalFetch;
  }
});

test("MCP status redacts a header token reflected by tool metadata", async () => {
  const originalFetch = globalThis.fetch;
  const token = "tool-reflection-sentinel-2a994d";
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") {
      return mcpResponse(payload.id, {
        tools: [{
          name: `tool-${token}`,
          title: token,
          description: `description ${token}`,
          inputSchema: { properties: { [token]: { type: "string" } } },
        }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  clearFeishuProjectMcpStatusCache();
  try {
    const status = await getFeishuProjectMcpStatus(syncConfig({ token }), { forceRefresh: true });
    const serialized = JSON.stringify(status);
    assert.equal(status.connected, true);
    assert.equal(serialized.includes(token), false);
    assert.match(serialized, /\[REDACTED\]/);
  } finally {
    clearFeishuProjectMcpStatusCache();
    globalThis.fetch = originalFetch;
  }
});

test("default MCP metadata and capture clients redact reflected tokens before throwing", async () => {
  const originalFetch = globalThis.fetch;
  const token = "default-client-reflection-sentinel-3d482b";
  globalThis.fetch = async (_url, init = {}) => {
    const reflected = init.headers?.["X-Mcp-Token"] || "";
    return {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: {
        get: (name) => {
          if (String(name).toLowerCase() === "location") return `https://mcp.test/authorize?token=${reflected}`;
          if (String(name).toLowerCase() === "www-authenticate") return `Bearer error="${reflected}"`;
          return null;
        },
      },
      text: async () => `upstream echoed ${reflected}`,
    };
  };

  const config = syncConfig({ token, retryAttempts: 0 });
  const assertSanitizedRejection = async (action) => {
    await assert.rejects(action, (error) => {
      const serialized = JSON.stringify({
        message: error?.message,
        body: error?.body,
        location: error?.location,
        wwwAuthenticate: error?.wwwAuthenticate,
      });
      assert.equal(serialized.includes(token), false);
      assert.match(serialized, /\[REDACTED\]/);
      return true;
    });
  };

  try {
    await assertSanitizedRejection(() => getFeishuProjectMcpFilterMetadata(config));
    await assertSanitizedRejection(() => captureFeishuProjectMcpItems(config, { includeAttachments: false }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture retries transient Bits metadata failures from get_workitem_brief", async () => {
  const originalFetch = globalThis.fetch;
  const toolCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") {
      return mcpResponse(payload.id, {
        tools: [briefTool()],
      });
    }
    if (payload.method === "tools/call") {
      toolCalls.push(payload.params);
      if (toolCalls.length === 1) {
        return mcpResponse(payload.id, {
          isError: true,
          content: [{ type: "text", text: TRANSIENT_BITS_ERROR }],
        });
      }
      return mcpResponse(payload.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            work_item_attribute: {
              work_item_id: "1000053838",
              work_item_name: "Recovered detail",
            },
            work_item_fields: [
              { key: "description", name: "Description", value: "Recovered after retry" },
            ],
          }),
        }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  try {
    const result = await captureFeishuProjectMcpItems(syncConfig({ retryAttempts: 2 }), {
      workItemIds: ["1000053838"],
      includeAttachments: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.items[0].work_item_id, "1000053838");
    assert.equal(result.items[0].title, "Recovered detail");
    assert.equal(toolCalls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NSCP-17420 direct brief capture exposes role_members to read-scope filtering", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") return mcpResponse(payload.id, { tools: [briefTool()] });
    if (payload.method === "tools/call") {
      return mcpResponse(payload.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            work_item_attribute: {
              work_item_id: "7036093080",
              work_item_name: "NSCP-17420",
              work_item_status: { key: "open", name: "OPEN" },
              role_members: [{
                key: "role_bd6222",
                name: "问题责任人（角色）",
                members: [
                  { key: "liu-li", name: "刘力" },
                  { key: "yang-rongfeng", name: "阳荣峰" },
                  { key: "liu-jiao", name: "刘姣" },
                  { key: "li-shengjie", name: "李胜杰" },
                ],
              }],
            },
            work_item_fields: [
              {
                key: "__role_mql_role_bd6222",
                name: "问题责任人（角色）",
                value: [{ key: "liu-li", name: "刘力" }],
              },
              {
                key: "current_status_operator",
                name: "当前负责人",
                value: [
                  { key: "liu-li", name: "刘力" },
                  { key: "yang-rongfeng", name: "阳荣峰" },
                  { key: "liu-jiao", name: "刘姣" },
                  { key: "li-shengjie", name: "李胜杰" },
                ],
              },
            ],
          }),
        }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  try {
    const config = syncConfig();
    config.sync.readScope = {
      enabled: true,
      match: "all",
      filters: [{
        enabled: true,
        kind: "role",
        fieldKey: "role_bd6222",
        fieldName: "问题责任人（角色）",
        operator: "containsAny",
        values: ["阳荣峰", "徐博超", "彭俊维", "冯国梁"],
      }],
    };
    const capture = await captureFeishuProjectMcpItems(config, {
      workItemIds: ["7036093080"],
      includeAttachments: false,
    });
    assert.equal(capture.ok, true);
    const ownerRole = capture.items[0].fields.find((field) => field.field_key === "role_bd6222");
    assert.equal(ownerRole?.field_name, "问题责任人（角色）");
    assert.deepEqual(ownerRole?.value.map((member) => member.name), ["刘力", "阳荣峰", "刘姣", "李胜杰"]);

    const preview = await syncFeishuProjectWorkItem(capture.items[0], {
      dryRun: true,
      checkRemoteExisting: false,
      config,
    });
    assert.equal(preview.ok, true);
    assert.notEqual(preview.action, "skip");
    assert.equal(preview.scopeStatus, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture degrades explicit-id dry-run when transient Bits metadata keeps failing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") return mcpResponse(payload.id, { tools: [briefTool()] });
    if (payload.method === "tools/call") {
      return mcpResponse(payload.id, {
        isError: true,
        content: [{ type: "text", text: TRANSIENT_BITS_ERROR }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  try {
    const result = await captureFeishuProjectMcpItems(syncConfig({ retryAttempts: 1 }), {
      workItemIds: ["1000053838"],
      includeAttachments: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.equal(result.items[0].work_item_id, "1000053838");
    assert.equal(result.items[0].raw._mcpDegraded, true);
    assert.match(result.warning, /transient remote metadata\/network error/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture filters explicit problem-number dry-run by Feishu problem number", async () => {
  const originalFetch = globalThis.fetch;
  const toolCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") {
      return mcpResponse(payload.id, {
        tools: [mqlTool()],
      });
    }
    if (payload.method === "tools/call") {
      toolCalls.push(payload.params);
      return mcpResponse(payload.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            data: {
              rows: [
                mqlWorkItem("1000050001", "Unrelated bug", "1"),
                mqlWorkItem("1000057542", "Actual bug summary", "17542"),
              ],
            },
          }),
        }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  try {
    const config = syncConfig();
    config.sync.requiredAssigneeKeywords = ["徐博超"];
    config.sync.readScope = {
      enabled: true,
      filters: [{ fieldKey: "__role_owner", operator: "containsAny", values: ["徐博超"] }],
    };
    const result = await captureFeishuProjectMcpItems(config, {
      workItemNos: ["nscp-17542"],
      limit: 1,
      includeAttachments: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].work_item_id, "1000057542");
    assert.equal(result.items[0].title, "Actual bug summary");
    assert.equal(result.items[0].work_item_no, "NSCP-17542");
    assert.equal(result.items[0].sourceProblemNo, "NSCP-17542");
    assert.deepEqual(result.requestedProblemNos, ["NSCP-17542"]);
    assert.equal(result.missingWorkItemNos, undefined);
    assert.equal(toolCalls.length, 1);
    assert.match(toolCalls[0].arguments.mql, /`auto_number` = '17542'/);
    assert.match(toolCalls[0].arguments.mql, /`name` = 'NSCP-17542'/);
    assert.doesNotMatch(toolCalls[0].arguments.mql, /any_match/);
    assert.match(toolCalls[0].arguments.mql, /LIMIT 50/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture resolves an ambiguous user label through project teams and retries MQL with user_key", async () => {
  const originalFetch = globalThis.fetch;
  const toolCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") {
      return mcpResponse(payload.id, {
        tools: [
          mqlTool(),
          { name: "search_user_info", inputSchema: { properties: {} } },
          { name: "list_project_team", inputSchema: { properties: {} } },
          { name: "list_team_members", inputSchema: { properties: {} } },
        ],
      });
    }
    if (payload.method === "tools/call") {
      toolCalls.push(payload.params);
      const { name, arguments: args } = payload.params;
      if (name === "search_by_mql" && !args.mql.includes("<id:li-min-user-key>")) {
        return mcpResponse(payload.id, {
          isError: true,
          content: [{
            type: "text",
            text: "attribute key or value error (Code: 3010) | Context: user label '李敏' is not unique",
          }],
        });
      }
      if (name === "search_user_info" && args.user_keys[0] === "李敏") {
        return mcpResponse(payload.id, { content: [{ type: "text", text: "[]" }] });
      }
      if (name === "list_project_team") {
        return mcpResponse(payload.id, {
          content: [{
            type: "text",
            text: JSON.stringify({ data: [{ team_id: "team-1", team_name: "测试团队" }] }),
          }],
        });
      }
      if (name === "list_team_members") {
        assert.equal(args.project_key, "intelligentspace");
        assert.equal(args.team_id, "team-1");
        assert.equal(args.query, "李敏");
        return mcpResponse(payload.id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              members: ["li-min-user-key", "other-user-key", "inactive-li-min-key"],
              match_member_count: 3,
            }),
          }],
        });
      }
      if (name === "search_user_info" && args.user_keys[0] === "li-min-user-key") {
        assert.equal(args.project_key, "intelligentspace");
        assert.equal(args.need_all_status, false);
        assert.deepEqual(args.user_keys, ["li-min-user-key", "other-user-key", "inactive-li-min-key"]);
        return mcpResponse(payload.id, {
          content: [{
            type: "text",
            text: JSON.stringify([
              { user_key: "li-min-user-key", name_cn: "李敏", status: "activated" },
              { user_key: "other-user-key", name_cn: "王五", status: "activated" },
              { user_key: "inactive-li-min-key", name_cn: "李敏", status: "deactivated" },
            ]),
          }],
        });
      }
      if (name === "search_by_mql") {
        return mcpResponse(payload.id, {
          content: [{
            type: "text",
            text: JSON.stringify({ data: { rows: [mqlWorkItem("1000088888", "Resolved duplicate user", "18888")] } }),
          }],
        });
      }
      throw new Error(`unexpected MCP tool ${name}`);
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  clearFeishuProjectMcpStatusCache();
  try {
    const config = syncConfig({ workItemTypeName: "缺陷管理-AOS2.0(8678)" });
    config.sync.readScope = {
      enabled: true,
      match: "all",
      filters: [{
        enabled: true,
        kind: "role",
        fieldKey: "role_bd6222",
        fieldName: "问题责任人（角色）",
        operator: "containsAny",
        values: ["李敏", "徐博超"],
      }, {
        enabled: true,
        kind: "field",
        fieldKey: "name",
        fieldName: "标题",
        operator: "equals",
        values: ["李敏"],
      }],
    };
    const result = await captureFeishuProjectMcpItems(config, {
      limit: 1,
      includeAttachments: false,
    });

    assert.equal(result.ok, true, JSON.stringify({
      error: result.error,
      calls: toolCalls.filter((call) => call.name === "search_by_mql"),
    }));
    assert.equal(result.items[0].work_item_id, "1000088888");
    assert.equal(result.fallback?.reason, "ambiguous_user_label_resolved");
    assert.equal(result.fallback?.resolvedUserCount, 1);
    assert.match(result.warning, /李敏.*user_key/);
    const mqlCalls = toolCalls.filter((call) => call.name === "search_by_mql");
    assert.equal(mqlCalls.length, 2);
    assert.match(mqlCalls[0].arguments.mql, /'李敏'/);
    assert.equal((mqlCalls[0].arguments.mql.match(/'李敏'/g) || []).length, 2);
    assert.equal((mqlCalls[1].arguments.mql.match(/'李敏'/g) || []).length, 1);
    assert.match(mqlCalls[1].arguments.mql, /`name` = '李敏'/);
    assert.match(mqlCalls[1].arguments.mql, /'<id:li-min-user-key>'/);
    assert.match(mqlCalls[1].arguments.mql, /'徐博超'/);
    assert.doesNotMatch(mqlCalls[1].arguments.mql, /other-user-key|inactive-li-min-key/);
  } finally {
    clearFeishuProjectMcpStatusCache();
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture keeps each explicit source type when work-item type discovery is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const mqlCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") return mcpResponse(payload.id, { tools: [mqlTool()] });
    if (payload.method === "tools/call") {
      mqlCalls.push(payload.params.arguments.mql);
      return mcpResponse(payload.id, {
        content: [{ type: "text", text: JSON.stringify({ data: { rows: [] } }) }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  try {
    const config = syncConfig({ workItemTypeName: "shared-global-label" });
    await captureFeishuProjectMcpItems(config, {
      typeKey: "bug",
      includeAttachments: false,
    });
    await captureFeishuProjectMcpItems(config, {
      typeKey: "bug_double_eight",
      includeAttachments: false,
    });

    assert.equal(mqlCalls.length, 2);
    assert.match(mqlCalls[0], /FROM `intelligentspace`\.`bug`/);
    assert.match(mqlCalls[1], /FROM `intelligentspace`\.`bug_double_eight`/);
    assert.doesNotMatch(mqlCalls.join("\n"), /shared-global-label/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture reports duplicate user Code 3010 without mislabeling it as a work-item-type failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") return mcpResponse(payload.id, { tools: [mqlTool()] });
    if (payload.method === "tools/call") {
      return mcpResponse(payload.id, {
        isError: true,
        content: [{
          type: "text",
          text: "attribute key or value error (Code: 3010) | Context: user label '李敏' is not unique",
        }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  clearFeishuProjectMcpStatusCache();
  try {
    const config = syncConfig({ workItemTypeName: "缺陷管理-AOS2.0(8678)" });
    config.sync.readScope = {
      enabled: true,
      filters: [{
        kind: "role",
        fieldKey: "role_bd6222",
        fieldName: "问题责任人（角色）",
        values: ["李敏"],
      }],
    };
    const result = await captureFeishuProjectMcpItems(config, { includeAttachments: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /could not uniquely resolve user label "李敏"/i);
    assert.doesNotMatch(result.error, /configured work item type label/i);
  } finally {
    clearFeishuProjectMcpStatusCache();
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture preserves an unrelated Code 3010 without attempting user or work-item-type fallback", async () => {
  const originalFetch = globalThis.fetch;
  const toolCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") {
      return mcpResponse(payload.id, {
        tools: [
          mqlTool(),
          { name: "search_user_info", inputSchema: { properties: {} } },
          { name: "list_project_team", inputSchema: { properties: {} } },
          { name: "list_team_members", inputSchema: { properties: {} } },
        ],
      });
    }
    if (payload.method === "tools/call") {
      toolCalls.push(payload.params);
      return mcpResponse(payload.id, {
        isError: true,
        content: [{
          type: "text",
          text: "attribute key or value error (Code: 3010) | Context: field operator mismatch",
        }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  clearFeishuProjectMcpStatusCache();
  try {
    const result = await captureFeishuProjectMcpItems(
      syncConfig({ workItemTypeName: "缺陷管理-AOS2.0(8678)" }),
      { includeAttachments: false },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /field operator mismatch/);
    assert.doesNotMatch(result.error, /work item type label|could not uniquely resolve user label/i);
    assert.deepEqual(toolCalls.map((call) => call.name), ["search_by_mql"]);
  } finally {
    clearFeishuProjectMcpStatusCache();
    globalThis.fetch = originalFetch;
  }
});

test("MCP capture signs work-item field attachments and structured attachments from empty comments", async () => {
  const originalFetch = globalThis.fetch;
  const toolCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/list") {
      return mcpResponse(payload.id, {
        tools: [briefTool(), commentsTool(), downloadTool()],
      });
    }
    if (payload.method === "tools/call") {
      toolCalls.push(payload.params);
      if (payload.params.name === "get_workitem_brief") {
        return mcpResponse(payload.id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              work_item_attribute: {
                work_item_id: "7048159726",
                work_item_name: "Attachment field ticket",
              },
              work_item_fields: [
                {
                  key: "field_2cb6f7",
                  name: "附件",
                  value: [
                    {
                      uid: "field-file-uid",
                      name: "field.log",
                      size: "123",
                      type: "text/plain",
                      url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/field-file-uid",
                    },
                  ],
                },
              ],
            }),
          }],
        });
      }
      if (payload.params.name === "list_workitem_comments") {
        return mcpResponse(payload.id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              comments: [
                {
                  comment_id: "empty-comment",
                  content: "",
                  files: [
                    {
                      file_id: "comment-file-id",
                      file_name: "comment.png",
                      url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/comment-file-id",
                    },
                  ],
                },
              ],
              pagination: { has_more: false },
            }),
          }],
        });
      }
      if (payload.params.name === "get_download_url") {
        const fileUrl = new URL(payload.params.arguments.file_url);
        const fileName = fileUrl.pathname.split("/").at(-1);
        return mcpResponse(payload.id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              download_url: `https://download.test/${fileName}`,
              sign: `sign-${fileName}`,
              sign_expire_time: 1784100000,
            }),
          }],
        });
      }
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  try {
    const result = await captureFeishuProjectMcpItems(syncConfig(), {
      workItemIds: ["7048159726"],
      includeAttachments: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].attachments.map((attachment) => attachment.id), ["field-file-uid", "comment-file-id"]);
    assert.deepEqual(result.items[0].attachments.map((attachment) => attachment.fileName), ["field.log", "comment.png"]);
    assert.deepEqual(result.items[0].attachments.map((attachment) => attachment.sourceCommentId || ""), ["", "empty-comment"]);
    assert.deepEqual(result.items[0].attachments.map((attachment) => attachment.url), [
      "https://download.test/field-file-uid",
      "https://download.test/comment-file-id",
    ]);
    const downloadCalls = toolCalls.filter((call) => call.name === "get_download_url");
    assert.equal(downloadCalls.length, 2);
    assert.ok(downloadCalls.every((call) => new URL(call.arguments.file_url).searchParams.get("dflag") === null));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP attachment download refresh falls back to the explicit download flag and keeps attachment origin", async () => {
  const originalFetch = globalThis.fetch;
  const toolCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || "{}");
    if (payload.method === "initialize") return mcpResponse(payload.id, {});
    if (payload.method === "notifications/initialized") return emptyMcpResponse(202);
    if (payload.method === "tools/call") {
      toolCalls.push(payload.params);
      if (new URL(payload.params.arguments.file_url).searchParams.get("dflag") !== "t") {
        return mcpResponse(payload.id, {
          isError: true,
          content: [{ type: "text", text: "file URL requires download flag" }],
        });
      }
      return mcpResponse(payload.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            download_url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/refreshed",
            sign: "refreshed-sign",
            sign_expire_time: 1784101000,
            is_multipart: true,
            multipart: {
              part_count: 2,
              part_size: 4,
              need: [
                { part_index: 0, start_byte: 0, end_byte: 3 },
                { part_index: 1, start_byte: 4, end_byte: 7 },
              ],
            },
          }),
        }],
      });
    }
    throw new Error(`unexpected MCP method ${payload.method}`);
  };

  try {
    const attachment = await refreshFeishuProjectMcpAttachmentDownload({
      id: "source-file-id",
      fileName: "large.zip",
      url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/stale",
      sourceUrl: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/source-file-id",
      sourceWorkItemId: "7048999999",
      sourceProjectKey: "intelligentspace",
      downloadHeaders: { "X-Meego-File-Sign": "stale-sign" },
    }, {
      sourceWorkItemId: "7048217531",
      sourceProjectKey: "intelligentspace",
    }, syncConfig());

    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].name, "get_download_url");
    assert.equal(toolCalls[0].arguments.work_item_id, "7048999999");
    assert.equal(new URL(toolCalls[0].arguments.file_url).searchParams.get("dflag"), null);
    assert.equal(new URL(toolCalls[1].arguments.file_url).searchParams.get("dflag"), "t");
    assert.equal(attachment.url, "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/refreshed");
    assert.deepEqual(attachment.downloadHeaders, { "X-Meego-File-Sign": "refreshed-sign" });
    assert.equal(attachment.isMultipart, true);
    assert.equal(attachment.multipart.part_count, 2);
    assert.deepEqual(attachment.multipart.need.map((part) => part.part_index), [0, 1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function briefTool() {
  return {
    name: "get_workitem_brief",
    inputSchema: {
      properties: {
        project_key: { type: "string" },
        work_item_id: { type: "string" },
        fields: { type: "array" },
        page_size: { type: "number" },
      },
    },
  };
}

function commentsTool() {
  return {
    name: "list_workitem_comments",
    inputSchema: {
      properties: {
        project_key: { type: "string" },
        work_item_id: { type: "string" },
        page_num: { type: "number" },
      },
    },
  };
}

function downloadTool() {
  return {
    name: "get_download_url",
    inputSchema: {
      properties: {
        project_key: { type: "string" },
        work_item_id: { type: "string" },
        file_url: { type: "string" },
      },
    },
  };
}

function mqlTool() {
  return {
    name: "search_by_mql",
    inputSchema: {
      properties: {
        mql: { type: "string" },
      },
    },
  };
}

function mqlWorkItem(id, name, autoNumber) {
  return {
    moql_field_list: [
      { key: "work_item_id", name: "work_item_id", value: { string_value: id }, value_type: "text" },
      { key: "name", name: "name", value: { string_value: name }, value_type: "text" },
      { key: "auto_number", name: "auto_number", value: { string_value: autoNumber }, value_type: "text" },
    ],
  };
}

function syncConfig(mcp = {}) {
  return {
    feishu: {
      spaceKey: "intelligentspace",
      workItemTypeKey: "bug",
      mcp: {
        serverUrl: "https://mcp.test/v1",
        transport: "http-header",
        token: "test-token",
        retryBaseDelayMs: 0,
        retryMaxDelayMs: 0,
        ...mcp,
      },
    },
    sync: {
      batchSize: 1,
      includeComments: false,
      includeAttachments: false,
      readScope: { enabled: false, filters: [] },
      requiredAssigneeKeywords: [],
    },
  };
}

function mcpResponse(id, result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

function emptyMcpResponse(status = 202) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "Accepted",
    headers: { get: () => null },
    text: async () => "",
  };
}
