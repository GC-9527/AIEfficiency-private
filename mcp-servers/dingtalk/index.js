import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ==========================================
// Teambition 开放平台 MCP Server
// 功能：企业信息、成员管理、任务读写、项目管理
// 前置条件：需要 Teambition 企业内部应用的 AppId 和 AppSecret
// ==========================================

const TB_CONFIG = {
  appId: process.env.TB_APP_ID || process.env.DINGTALK_APP_KEY || "",
  appSecret: process.env.TB_APP_SECRET || process.env.DINGTALK_APP_SECRET || "",
  orgId: process.env.TB_ORG_ID || "",
  operatorId: process.env.TB_OPERATOR_ID || "",
  baseUrl: "https://open.teambition.com",
};

let appToken = "";
let tokenExpireTime = 0;

// ---------- 认证 ----------

async function getAppToken() {
  if (appToken && Date.now() < tokenExpireTime) {
    return appToken;
  }

  if (!TB_CONFIG.appId || !TB_CONFIG.appSecret) {
    throw new Error(
      "未配置 Teambition AppId/AppSecret，请设置环境变量 TB_APP_ID 和 TB_APP_SECRET"
    );
  }

  const resp = await fetch(`${TB_CONFIG.baseUrl}/api/appToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: TB_CONFIG.appId,
      appSecret: TB_CONFIG.appSecret,
    }),
  });
  const data = await resp.json();

  if (!data.appToken) {
    throw new Error(`获取appToken失败: ${JSON.stringify(data)}`);
  }

  appToken = data.appToken;
  // appToken 有效期 1800 秒，提前 5 分钟刷新
  tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
  return appToken;
}

// ---------- API 调用 ----------

async function tbAPI(method, path, body = null) {
  const token = await getAppToken();

  if (!TB_CONFIG.orgId) {
    throw new Error("未配置企业ID，请设置环境变量 TB_ORG_ID");
  }

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Tenant-Id": TB_CONFIG.orgId,
      "X-Tenant-Type": "organization",
    },
  };

  if (TB_CONFIG.operatorId) {
    options.headers["X-Operator-Id"] = TB_CONFIG.operatorId;
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(`${TB_CONFIG.baseUrl}${path}`, options);
  const data = await resp.json();

  if (data.code && data.code !== 200) {
    throw new Error(
      `API错误 [${data.code}]: ${data.errorMessage || JSON.stringify(data)}`
    );
  }

  return data;
}

// ---------- MCP Server 定义 ----------

const server = new McpServer({
  name: "teambition",
  version: "2.0.0",
  description: "Teambition 开放平台 - 企业信息、任务管理、项目协作",
});

// 工具: 获取企业信息
server.tool(
  "get_org_info",
  "获取 Teambition 企业/组织的基本信息",
  {},
  async () => {
    try {
      const data = await tbAPI("GET", "/api/org/info");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 获取企业成员列表
server.tool(
  "get_org_members",
  "获取企业成员列表",
  {
    pageSize: z
      .number()
      .optional()
      .default(50)
      .describe("每页数量，默认50"),
    pageToken: z.string().optional().describe("分页token"),
  },
  async ({ pageSize, pageToken }) => {
    try {
      let path = `/api/org/member/list?pageSize=${pageSize}`;
      if (pageToken) path += `&pageToken=${pageToken}`;

      const data = await tbAPI("GET", path);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 查询任务
server.tool(
  "get_tasks",
  "查询 Teambition 项目任务列表",
  {
    pageSize: z
      .number()
      .optional()
      .default(20)
      .describe("每页数量，默认20"),
    pageToken: z.string().optional().describe("分页token"),
  },
  async ({ pageSize, pageToken }) => {
    try {
      let path = `/api/task/query?pageSize=${pageSize}`;
      if (pageToken) path += `&pageToken=${pageToken}`;

      const data = await tbAPI("GET", path);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 创建任务
server.tool(
  "create_task",
  "在 Teambition 项目中创建任务",
  {
    projectId: z.string().describe("项目ID"),
    content: z.string().describe("任务标题/内容"),
    note: z.string().optional().describe("任务描述/备注"),
  },
  async ({ projectId, content, note }) => {
    try {
      const body = { projectId, content };
      if (note) body.note = note;

      const data = await tbAPI("POST", "/api/task/create", body);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 删除任务（移入回收站）
server.tool(
  "delete_task",
  "删除 Teambition 任务（移入回收站/归档）。操作不可逆，请确认后再调用。",
  {
    taskId: z.string().describe("任务ID"),
  },
  async ({ taskId }) => {
    try {
      const data = await tbAPI(
        "POST",
        `/api/v3/task/${encodeURIComponent(taskId)}/archive`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 分析任务（汇总详情 + 评论 + 附件）
server.tool(
  "analyze_task",
  "综合分析一个 Teambition 任务：拉取任务详情、最近评论/动态、附件列表，汇总返回。",
  {
    taskId: z.string().describe("任务ID"),
    commentLimit: z.number().optional().default(20).describe("拉取评论/动态条数"),
  },
  async ({ taskId, commentLimit }) => {
    const result = {};
    const errors = [];

    // 1. 任务详情（v3 query by taskIds）
    try {
      const detail = await tbAPI(
        "GET",
        `/api/v3/task/query?taskIds=${encodeURIComponent(taskId)}`
      );
      const tasks = detail?.result || [];
      result.task = Array.isArray(tasks) && tasks.length > 0 ? tasks[0] : detail;
    } catch (e) {
      errors.push(`详情: ${e.message}`);
      // 兜底用旧接口
      try {
        const old = await tbAPI("GET", `/api/task/query?taskId=${encodeURIComponent(taskId)}&pageSize=1`);
        result.task = old?.result?.[0] || old;
      } catch {}
    }

    // 2. 任务描述/备注
    try {
      const note = await tbAPI(
        "GET",
        `/api/v3/task/${encodeURIComponent(taskId)}/content`
      );
      result.content = note?.result || note;
    } catch (e) {
      errors.push(`描述: ${e.message}`);
    }

    // 3. 评论/动态
    try {
      const acts = await tbAPI(
        "GET",
        `/api/v3/task/${encodeURIComponent(taskId)}/activity/list?pageSize=${commentLimit}`
      );
      result.activities = acts?.result || [];
    } catch (e) {
      errors.push(`动态: ${e.message}`);
    }

    // 4. 附件
    try {
      const works = await tbAPI(
        "GET",
        `/api/v3/work/list?parentId=${encodeURIComponent(taskId)}&pageSize=50`
      );
      result.attachments = works?.result || [];
    } catch (e) {
      errors.push(`附件: ${e.message}`);
    }

    if (errors.length) result._errors = errors;

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// 工具: 获取项目成员
server.tool(
  "get_project_members",
  "获取 Teambition 项目的成员列表",
  {
    projectId: z.string().describe("项目ID"),
    pageSize: z
      .number()
      .optional()
      .default(30)
      .describe("每页数量，默认30"),
    pageToken: z.string().optional().describe("分页token"),
  },
  async ({ projectId, pageSize, pageToken }) => {
    try {
      let path = `/api/project/member/list?projectId=${projectId}&pageSize=${pageSize}`;
      if (pageToken) path += `&pageToken=${pageToken}`;

      const data = await tbAPI("GET", path);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 查询用户信息
server.tool(
  "get_user_info",
  "根据用户ID获取 Teambition 用户信息",
  {
    userId: z.string().describe("用户ID"),
  },
  async ({ userId }) => {
    try {
      const data = await tbAPI("GET", `/api/user/info?userId=${userId}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 查询任务评论/活动列表（评论属于 activity 的一种）
server.tool(
  "get_task_comments",
  "查询 Teambition 任务的活动列表（评论属于 activity）。默认过滤 actions=comment 只拉评论；去掉 actions 可看全部动态。",
  {
    taskId: z.string().describe("任务ID"),
    pageSize: z.number().optional().default(50).describe("每页数量"),
    pageToken: z.string().optional().describe("分页 token"),
    actions: z.string().optional().default("comment").describe("过滤动态类型，逗号分隔；默认 comment（仅评论）。传空字符串拉全部"),
    excludeActions: z.string().optional().describe("排除的动态类型，逗号分隔"),
  },
  async ({ taskId, pageSize, pageToken, actions, excludeActions }) => {
    try {
      let path = `/api/v3/task/${encodeURIComponent(taskId)}/activity/list?pageSize=${pageSize}`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      if (actions) path += `&actions=${encodeURIComponent(actions)}`;
      if (excludeActions) path += `&excludeActions=${encodeURIComponent(excludeActions)}`;
      const data = await tbAPI("GET", path);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 查询附件列表（work 对象，可按 parentId 或 projectId 过滤）
server.tool(
  "get_attachments",
  "查询 Teambition 附件（work）列表。parentId 可以是 taskId 或文件夹 ID。",
  {
    parentId: z.string().optional().describe("父对象 ID（任务 ID / 文件夹 ID）"),
    projectId: z.string().optional().describe("项目 ID"),
    pageSize: z.number().optional().default(50).describe("每页数量"),
    pageToken: z.string().optional().describe("分页 token"),
  },
  async ({ parentId, projectId, pageSize, pageToken }) => {
    try {
      let path = `/api/v3/work/list?pageSize=${pageSize}`;
      if (parentId) path += `&parentId=${encodeURIComponent(parentId)}`;
      if (projectId) path += `&projectId=${encodeURIComponent(projectId)}`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await tbAPI("GET", path);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 按 ID 批量查询附件（work/query）
server.tool(
  "query_attachments_by_ids",
  "根据附件 ID 列表批量查询附件详情（含下载链接）。",
  {
    workIds: z.string().describe("逗号分隔的附件 ID 列表"),
  },
  async ({ workIds }) => {
    try {
      const path = `/api/v3/work/query?workIds=${encodeURIComponent(workIds)}`;
      const data = await tbAPI("GET", path);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 添加任务评论（可选附件 token + 可选写后校验）
server.tool(
  "create_task_comment",
  "在 Teambition 任务下添加一条评论。支持 markdown (renderMode='markdown')、附件 (fileTokens)、@成员 (mentionUserIds)。可选 verify=true 在写入后自动拉取活动列表校验。",
  {
    taskId: z.string().describe("任务ID"),
    content: z.string().describe("评论正文"),
    renderMode: z.string().optional().describe("内容渲染模式：默认原文，可传 'markdown'"),
    fileTokens: z
      .array(z.string())
      .optional()
      .describe("评论附件 token 列表（需先通过 /api/v3/awos/upload-token 上传获取 token）"),
    mentionUserIds: z
      .array(z.string())
      .optional()
      .describe("@成员的用户 ID 列表，单次上限30"),
    verify: z.boolean().optional().default(false).describe("创建后是否自动拉取活动列表校验评论是否可见"),
  },
  async ({ taskId, content, renderMode, fileTokens, mentionUserIds, verify }) => {
    try {
      const body = { content };
      if (renderMode) body.renderMode = renderMode;
      if (fileTokens?.length) body.fileTokens = fileTokens;
      if (mentionUserIds?.length) body.mentionUserIds = mentionUserIds;

      const created = await tbAPI(
        "POST",
        `/api/v3/task/${encodeURIComponent(taskId)}/comment`,
        body
      );

      const output = { created };

      if (verify) {
        try {
          const list = await tbAPI(
            "GET",
            `/api/v3/task/${encodeURIComponent(taskId)}/activity/list?pageSize=20&actions=comment`
          );
          const items = list?.result || [];
          const newId = created?.result?.id;
          const matched = Array.isArray(items)
            ? items.find((c) => c.id === newId)
            : null;
          output.verify = {
            commentId: newId || null,
            found: !!matched,
            sampleListSize: Array.isArray(items) ? items.length : 0,
            matchedItem: matched || null,
          };
        } catch (e) {
          output.verify = { error: e.message };
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 工具: 通用 API 调试（按需探测 endpoint，沿用鉴权头）
server.tool(
  "tb_request",
  "通用 Teambition API 调用（调试用）。当专用工具 endpoint 不匹配时，用它手动调任意路径探测。",
  {
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("HTTP 方法"),
    path: z.string().describe("API 路径，以 / 开头，如 /api/task/comment/list?taskId=xxx"),
    body: z.any().optional().describe("请求体 JSON（POST/PUT/PATCH 时使用）"),
  },
  async ({ method, path, body }) => {
    try {
      const data = await tbAPI(method, path, body ?? null);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ---------- 启动 ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Teambition MCP Server 已启动");
}

main().catch(console.error);
