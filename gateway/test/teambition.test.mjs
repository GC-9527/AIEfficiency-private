/**
 * teambition 纯逻辑单元测试：标题关键词提取（全角/半角/去重/空）、TB 项目列表（配置驱动 + 旧默认回退）。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbtb-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({}));

let tb, cfg;
before(async () => {
  tb = await import("../services/teambition.js");
  cfg = await import("../services/config.js");
});

test("extractTitleKeywords：全角【】", () => {
  assert.deepEqual(tb.extractTitleKeywords("【阿维塔_8678】【应用市场】语音控制"), ["阿维塔_8678", "应用市场"]);
});
test("extractTitleKeywords：半角[] + 混合 + 去重", () => {
  assert.deepEqual(tb.extractTitleKeywords("[Web][SDK]【Web】功能"), ["Web", "SDK"]);
});
test("extractTitleKeywords：无括号 / 空 / 非字符串", () => {
  assert.deepEqual(tb.extractTitleKeywords("没有括号的标题"), []);
  assert.deepEqual(tb.extractTitleKeywords(""), []);
  assert.deepEqual(tb.extractTitleKeywords(null), []);
  assert.deepEqual(tb.extractTitleKeywords(undefined), []);
});
test("extractTitleKeywords：嵌套/空括号忽略空值", () => {
  assert.deepEqual(tb.extractTitleKeywords("【】【 A 】【B】"), ["A", "B"]);
});

test("getTbProjects：空配置回退旧默认（平台组件）", () => {
  cfg.updateConfig({ teambition: { ...cfg.getConfig().teambition, projects: [] } });
  const ps = tb.getTbProjects();
  assert.equal(ps.length, 1);
  assert.equal(ps[0].id, "65a5f274950780b816cf905e");
  assert.deepEqual(tb.getTbProjectIds(), ["65a5f274950780b816cf905e"]);
});

test("getTbProjects：配置多项目则用配置", () => {
  cfg.updateConfig({ teambition: { ...cfg.getConfig().teambition, projects: [{ id: "p1", name: "项目一" }, { id: "p2", name: "项目二" }] } });
  assert.deepEqual(tb.getTbProjectIds(), ["p1", "p2"]);
  assert.equal(tb.getTbProjects()[0].name, "项目一");
});

test("getTbProjects：过滤掉无 id 的脏项", () => {
  cfg.updateConfig({ teambition: { ...cfg.getConfig().teambition, projects: [{ name: "无id" }, { id: "ok", name: "有id" }] } });
  assert.deepEqual(tb.getTbProjectIds(), ["ok"]);
});

test("parseTeambitionTrainingSourceUrl 严格解析迭代和任务列表并生成规范 URL", () => {
  const sprint = tb.parseTeambitionTrainingSourceUrl(
    "https://WWW.Teambition.com/project/65A5F274950780B816CF905E/sprint/section/6A4DB00CC9339B8E79167473/?from=training#tasks",
  );
  assert.equal(sprint.type, "sprint");
  assert.equal(sprint.projectId, "65a5f274950780b816cf905e");
  assert.equal(sprint.sprintId, "6a4db00cc9339b8e79167473");
  assert.equal(sprint.sectionId, sprint.sprintId);
  assert.equal(sprint.url, "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473");

  const tasklist = tb.parseTeambitionTrainingSourceUrl(
    "http://teambition.com/project/65a5f274950780b816cf905e/tasks/scrum/field/69ddf574378cadfc7cbaa819",
  );
  assert.equal(tasklist.type, "tasklist");
  assert.equal(tasklist.tasklistId, "69ddf574378cadfc7cbaa819");
  assert.equal(tasklist.url, "https://www.teambition.com/project/65a5f274950780b816cf905e/tasks/scrum/field/69ddf574378cadfc7cbaa819");
});

test("parseTeambitionTrainingSourceUrl 拒绝伪造域名、危险协议、宽松路径和非法 ID", () => {
  const validPath = "/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473";
  assert.throws(() => tb.parseTeambitionTrainingSourceUrl(`https://teambition.com.evil.example${validPath}`), /必须属于 teambition\.com/);
  assert.throws(() => tb.parseTeambitionTrainingSourceUrl(`ftp://www.teambition.com${validPath}`), /仅支持 HTTP\/HTTPS/);
  assert.throws(() => tb.parseTeambitionTrainingSourceUrl("https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/other/6a4db00cc9339b8e79167473"), /仅支持 Teambition/);
  assert.throws(() => tb.parseTeambitionTrainingSourceUrl("https://www.teambition.com/project/not-an-object-id/sprint/section/6a4db00cc9339b8e79167473"), /24 位十六进制/);
  assert.throws(() => tb.parseTeambitionTrainingSourceUrl("javascript:alert(1)"), /仅支持 HTTP\/HTTPS/);
});

test("filterTeambitionTrainingSourceTasks 严格按迭代和项目过滤、去重并识别完成状态", () => {
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  const tasks = tb.filterTeambitionTrainingSourceTasks([
    {
      _id: "6a5616856c37ca48a1557874",
      content: "数字完成状态",
      _projectId: source.projectId,
      _sprintId: source.sprintId,
      _tasklistId: "69ddf574378cadfc7cbaa819",
      isDone: 1,
      rawSecret: "不得输出",
    },
    {
      _id: "6a543d941b9d2ce56ddd8f65",
      title: "字符串完成状态",
      projectId: source.projectId,
      sprintId: source.sprintId,
      isDone: "1",
    },
    {
      _id: "6a5616282d4c53fbbda38521",
      title: "布尔完成状态",
      project: { _id: source.projectId, name: "平台组件" },
      sprint: { _id: source.sprintId, name: "【应用市场】0716版本" },
      tasklist: { _id: "69ddf574378cadfc7cbaa819", title: "应用市场" },
      isDone: true,
    },
    {
      _id: "6a55cde765f091195ce0a3f3",
      title: "未完成状态",
      _projectId: source.projectId,
      sprint: { sprintId: source.sprintId },
      isDone: "false",
    },
    {
      _id: "6a5616856c37ca48a1557874",
      title: "重复任务补充完成状态",
      _projectId: source.projectId,
      _sprintId: source.sprintId,
      done: false,
    },
    { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", title: "其它迭代", _projectId: source.projectId, _sprintId: "bbbbbbbbbbbbbbbbbbbbbbbb", isDone: true },
    { _id: "cccccccccccccccccccccccc", title: "其它项目", _projectId: "dddddddddddddddddddddddd", _sprintId: source.sprintId, isDone: true },
    { _id: "eeeeeeeeeeeeeeeeeeeeeeee", title: "缺少项目身份", _sprintId: source.sprintId, isDone: true },
  ], source);

  assert.equal(tasks.length, 4);
  assert.equal(tasks.filter((task) => task.done).length, 3);
  assert.equal(tasks.find((task) => task.tbTaskId === "6a55cde765f091195ce0a3f3")?.done, false);
  assert.ok(tasks.every((task) => task.projectId === source.projectId));
  assert.ok(tasks.every((task) => task.sprintId === source.sprintId));
  assert.ok(tasks.every((task) => task.ticketUrl === `https://www.teambition.com/task/${task.tbTaskId}`));
  assert.ok(tasks.every((task) => !Object.hasOwn(task, "raw") && !Object.hasOwn(task, "rawSecret")));
});

test("filterTeambitionTrainingSourceTasks 支持 tasklistId 列表且不混入同项目其它列表", () => {
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/tasks/scrum/field/69ddf574378cadfc7cbaa819",
  );
  const tasks = tb.filterTeambitionTrainingSourceTasks([
    { _id: "111111111111111111111111", title: "目标列表一", _projectId: source.projectId, _tasklistId: source.tasklistId },
    { _id: "222222222222222222222222", title: "目标列表二", projectId: source.projectId, tasklist: { id: source.tasklistId, title: "应用市场" } },
    { _id: "333333333333333333333333", title: "其它列表", _projectId: source.projectId, _tasklistId: "444444444444444444444444" },
  ], source);
  assert.deepEqual(tasks.map((task) => task.tbTaskId), ["111111111111111111111111", "222222222222222222222222"]);
  assert.ok(tasks.every((task) => task.tasklistId === source.tasklistId));
});

test("listTeambitionTrainingSourceTasks 合并 OpenAPI 成功子集与 Cookie 全量 42 单且保留全部状态", async () => {
  const origFetch = globalThis.fetch;
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  const statuses = [
    { id: "111111111111111111111111", name: "处理中", count: 1, done: false },
    { id: "222222222222222222222222", name: "关闭", count: 18, done: true },
    { id: "333333333333333333333333", name: "可提测", count: 21, done: true },
    { id: "444444444444444444444444", name: "已拒绝", count: 1, done: true },
    { id: "555555555555555555555555", name: "已完成", count: 1, done: true },
  ];
  let sequence = 1000;
  const allTasks = statuses.flatMap((status) => Array.from({ length: status.count }, (_, index) => ({
    _id: (sequence++).toString(16).padStart(24, "0"),
    content: `${status.name}任务 ${index + 1}`,
    _projectId: source.projectId,
    _sprintId: source.sprintId,
    _taskflowstatusId: status.id,
    isDone: status.done,
  })));
  const pendingTasks = allTasks.filter((task) => !task.isDone);
  const completedTasks = allTasks.filter((task) => task.isDone);
  const openApiSubset = [
    allTasks.find((task) => task.content === "关闭任务 1"),
    ...allTasks.filter((task) => task.content.startsWith("可提测任务 ")).slice(0, 3),
  ];
  const statusById = Object.fromEntries(statuses.map((status) => [status.id, status.name]));

  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-training-source-full-42",
      appSecret: "secret-training-source-full-42",
      orgId: "org-training-source-full-42",
      userCookie: "TEAMBITION_SESSIONID=training-source-full-42",
    },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("open.teambition.com/api/appToken")) return mockJson({ appToken: "token-training-source-full-42", expire: 1 });
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=false")) return mockJson({ result: [] });
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=true")) return mockJson({ result: openApiSubset });
    if (value.includes(`/api/v2/projects/${source.projectId}/tasks?`)) {
      return mockJson({ result: allTasks, totalSize: 42, nextPageToken: "" });
    }
    if (value.includes(`/api/projects/${source.projectId}/tasks?count=500&isDone=false`)) return mockJson(pendingTasks);
    if (value.includes(`/api/projects/${source.projectId}/tasks?count=500&isDone=true`)) return mockJson(completedTasks);
    if (value.includes(`/api/projects/${source.projectId}/tasks?count=500`)) return mockJson(pendingTasks);
    if (value.includes(`/api/projects/${source.projectId}/tasks?count=60`)) return mockJson([]);
    if (value.includes(`/api/projects/${source.projectId}/taskflows`)) return mockJson([]);
    if (value.includes("/api/v2/tasks")) return mockJson({ result: [], nextPageToken: "" });
    if (value.includes(`/api/sprints/${source.sprintId}`)) {
      return mockJson({ _id: source.sprintId, _projectId: source.projectId, name: "【应用市场】0716版本", status: "active" });
    }
    const detailMatch = value.match(/\/api\/tasks\/([0-9a-f]{24})$/i);
    if (detailMatch) {
      const task = allTasks.find((row) => row._id === detailMatch[1]);
      return mockJson({ ...task, taskflowstatus: { _id: task._taskflowstatusId, name: statusById[task._taskflowstatusId], _taskflowId: "666666666666666666666666" } });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    const listing = await tb.listTeambitionTrainingSourceTasks(source);
    assert.equal(listing.source.fetchSource, "open-api+cookie-source");
    assert.deepEqual(listing.counts, { all: 42, pending: 1, completed: 41 });
    assert.deepEqual(
      Object.fromEntries(listing.statusCounts.map((row) => [row.name, row.count])),
      { 可提测: 21, 关闭: 18, 处理中: 1, 已完成: 1, 已拒绝: 1 },
    );
    assert.deepEqual(listing.acquisition, {
      fetchSource: "open-api+cookie-source",
      openApiMatched: 4,
      cookieMatched: 42,
      mergedMatched: 42,
      completionStates: ["pending", "completed"],
      taskflowStatusFilter: "none",
      cookieComplete: true,
      cookiePages: 1,
      cookieReportedTotal: 42,
      openApiFailures: 0,
    });
    assert.ok(listing.tasks.every((task) => task.statusKey && task.statusName));
    assert.equal(new Set(listing.tasks.map((task) => task.tbTaskId)).size, 42);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("listTeambitionTrainingSourceTasks OpenAPI 成功返回非空子集但无 Cookie 时拒绝伪装完整", async () => {
  const origFetch = globalThis.fetch;
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-training-source-no-cookie",
      appSecret: "secret-training-source-no-cookie",
      orgId: "org-training-source-no-cookie",
      userCookie: "",
    },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/api/appToken")) return mockJson({ appToken: "token-training-source-no-cookie", expire: 1 });
    if (value.includes("/api/task/query") && value.includes("isDone=false")) return mockJson({ result: [] });
    if (value.includes("/api/task/query") && value.includes("isDone=true")) {
      return mockJson({ result: [{
        _id: "777777777777777777777777",
        _projectId: source.projectId,
        _sprintId: source.sprintId,
        content: "OpenAPI 非空但不完整子集",
        isDone: true,
      }] });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    await assert.rejects(
      () => tb.listTeambitionTrainingSourceTasks(source),
      /读取不完整.*必须通过 TB Cookie/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("listTeambitionTrainingSourceTasks 来源级 Cookie 分页失败时拒绝 OpenAPI 成功子集", async () => {
  const origFetch = globalThis.fetch;
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  const subset = [{
    _id: "888888888888888888888888",
    _projectId: source.projectId,
    _sprintId: source.sprintId,
    content: "OpenAPI 成功子集",
    isDone: true,
  }];
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-training-source-cookie-page-fail",
      appSecret: "secret-training-source-cookie-page-fail",
      orgId: "org-training-source-cookie-page-fail",
      userCookie: "TEAMBITION_SESSIONID=training-source-cookie-page-fail",
    },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("open.teambition.com/api/appToken")) return mockJson({ appToken: "token-training-source-cookie-page-fail", expire: 1 });
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=false")) return mockJson({ result: [] });
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=true")) return mockJson({ result: subset });
    if (value.includes(`/api/v2/projects/${source.projectId}/tasks?`) && value.includes("pageToken=next-page")) {
      return mockJson({ message: "source page failed" }, 503);
    }
    if (value.includes(`/api/v2/projects/${source.projectId}/tasks?`)) {
      return mockJson({ result: subset, totalSize: 42, nextPageToken: "next-page" });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    await assert.rejects(
      () => tb.listTeambitionTrainingSourceTasks(source),
      /读取不完整.*HTTP 503/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("listTeambitionTrainingSourceTasks 来源响应缺少 totalSize 时拒绝把无下一页的小集合当作全量", async () => {
  const origFetch = globalThis.fetch;
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  const subset = [{
    _id: "999999999999999999999999",
    _projectId: source.projectId,
    _sprintId: source.sprintId,
    content: "来源响应缺少总数的小集合",
    isDone: true,
  }];
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-training-source-missing-total",
      appSecret: "secret-training-source-missing-total",
      orgId: "org-training-source-missing-total",
      userCookie: "TEAMBITION_SESSIONID=training-source-missing-total",
    },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("open.teambition.com/api/appToken")) return mockJson({ appToken: "token-training-source-missing-total", expire: 1 });
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=false")) return mockJson({ result: [] });
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=true")) return mockJson({ result: subset });
    if (value.includes(`/api/v2/projects/${source.projectId}/tasks?`)) {
      return mockJson({ result: subset, nextPageToken: "" });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    await assert.rejects(
      () => tb.listTeambitionTrainingSourceTasks(source),
      /读取不完整.*缺少 totalSize/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("listTeambitionTrainingSourceTasks 任一完成状态读取失败且无完整 Cookie 兜底时拒绝不完整列表", async () => {
  const origFetch = globalThis.fetch;
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-training-source-partial",
      appSecret: "secret-training-source-partial",
      orgId: "org-training-source-partial",
      userCookie: "",
    },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/api/appToken")) return mockJson({ appToken: "token-training-source-partial", expire: 1 });
    if (value.includes("/api/task/query") && value.includes("isDone=false")) {
      return mockJson({ result: [{
        _id: "6a5616856c37ca48a1557874",
        _projectId: source.projectId,
        _sprintId: source.sprintId,
        content: "未完成任务",
        isDone: false,
      }] });
    }
    if (value.includes("/api/task/query") && value.includes("isDone=true")) {
      return mockJson({ message: "completed query failed" }, 503);
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    await assert.rejects(
      () => tb.listTeambitionTrainingSourceTasks(source),
      /任务列表读取不完整/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("listTeambitionTrainingSourceTasks Cookie 分页遇到非 2xx 时不得误报状态已完整", async () => {
  const origFetch = globalThis.fetch;
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  const completedPage = Array.from({ length: 500 }, (_, index) => ({
    _id: (index + 1).toString(16).padStart(24, "0"),
    title: `Cookie 完成任务 ${index + 1}`,
    _projectId: source.projectId,
    _sprintId: source.sprintId,
    isDone: true,
  }));
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-training-source-cookie-partial",
      appSecret: "secret-training-source-cookie-partial",
      orgId: "org-training-source-cookie-partial",
      userCookie: "TEAMBITION_SESSIONID=training-source-cookie-partial",
    },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("open.teambition.com/api/appToken")) {
      return mockJson({ appToken: "token-training-source-cookie-partial", expire: 1 });
    }
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=false")) {
      return mockJson({ result: [{
        _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
        title: "OpenAPI 未完成任务",
        _projectId: source.projectId,
        _sprintId: source.sprintId,
        isDone: false,
      }] });
    }
    if (value.includes("open.teambition.com/api/task/query") && value.includes("isDone=true")) {
      return mockJson({ message: "completed query failed" }, 503);
    }
    if (value.includes(`/api/projects/${source.projectId}/tasks`) && value.includes("isDone=true")) {
      return mockJson(completedPage);
    }
    if (value.includes(`/api/projects/${source.projectId}/tasks`)) return mockJson([]);
    if (value.includes("/api/v2/tasks") && value.includes("isDone=false")) return mockJson({ result: [] });
    if (value.includes("/api/v2/tasks") && value.includes("isDone=true") && value.includes("pageToken=next-completed")) {
      return mockJson({ message: "cookie page failed" }, 503);
    }
    if (value.includes("/api/v2/tasks") && value.includes("isDone=true")) {
      return mockJson({ result: completedPage, nextPageToken: "next-completed" });
    }
    if (value.includes(`/api/sprints/${source.sprintId}`)) {
      return mockJson({ _id: source.sprintId, _projectId: source.projectId, name: "目标迭代" });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    await assert.rejects(
      () => tb.listTeambitionTrainingSourceTasks(source),
      /任务列表读取不完整/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("listTeambitionTrainingSourceTasks 空列表的元数据归属不一致时 fail closed", async () => {
  const origFetch = globalThis.fetch;
  const source = tb.parseTeambitionTrainingSourceUrl(
    "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
  );
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-training-source-owner",
      appSecret: "secret-training-source-owner",
      orgId: "org-training-source-owner",
      userCookie: "TEAMBITION_SESSIONID=training-source-owner",
    },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("open.teambition.com/api/appToken")) return mockJson({ appToken: "token-training-source-owner", expire: 1 });
    if (value.includes("open.teambition.com/api/task/query")) return mockJson({ result: [] });
    if (value.includes(`/api/sprints/${source.sprintId}`)) {
      return mockJson({ _id: source.sprintId, _projectId: "dddddddddddddddddddddddd", name: "其它项目迭代" });
    }
    if (value.includes("www.teambition.com/api/")) return mockJson({ result: [], totalSize: 0, nextPageToken: "" });
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    await assert.rejects(
      () => tb.listTeambitionTrainingSourceTasks(source),
      /不存在或不属于/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("getTaskTagNames：将任务 tagIds 映射为项目标签名并保留直接标签", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      userCookie: "TEAMBITION_SESSIONID=task-tags",
      projects: [{ id: "project-tags", name: "标签项目" }],
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.pathname, "/api/tags");
    assert.equal(u.searchParams.get("tagType"), "project");
    assert.equal(u.searchParams.get("_projectId"), "project-tags");
    return mockJson([
      { _id: "tag-avatr", name: "【阿维塔】" },
      { _id: "tag-other", name: "其它标签" },
    ]);
  };
  try {
    const names = await tb.getTaskTagNames({
      projectId: "project-tags",
      tagIds: ["tag-avatr"],
      tags: [{ name: "直接标签" }],
    });
    assert.deepEqual(names, ["直接标签", "【阿维塔】"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

function mockJson(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mockCookieJson(body, status = 200) {
  const text = body == null ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Bad Request",
    json: async () => body,
    text: async () => text,
  };
}

test("updateTaskStatus：遇到 TB 必填弹窗时按抓包契约补字段并重试目标状态", async () => {
  const origFetch = globalThis.fetch;
  const projectId = "project-required-transition";
  const taskId = "task-required-transition";
  const taskflowId = "taskflow-required-transition";
  const scenarioId = "scenario-defect";
  const currentStatusId = "status-fixing";
  const targetStatusId = "status-testable";
  const statusBodies = [];
  let taskUpdateBody = null;
  let statusPutCount = 0;
  let advanced = false;

  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      userCookie: "TEAMBITION_SESSIONID=required-transition",
      projects: [{ id: projectId, name: "测试项目" }],
    },
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    if (u.pathname === `/api/tasks/${taskId}` && method === "GET") {
      return mockCookieJson({
        _id: taskId,
        _projectId: projectId,
        content: "【P162-G】【应用市场】状态流转必填字段回归",
        _scenariofieldconfigId: scenarioId,
        taskflowstatus: {
          _id: advanced ? targetStatusId : currentStatusId,
          name: advanced ? "可提测" : "修复中",
          _taskflowId: taskflowId,
          pos: advanced ? 2 : 1,
        },
      });
    }
    if (u.pathname === `/api/taskflows/${taskflowId}/taskflowstatus` && method === "GET") {
      return mockCookieJson({ result: [
        { _id: currentStatusId, name: "修复中", pos: 1 },
        { _id: targetStatusId, name: "可提测", pos: 2 },
      ] });
    }
    if (u.pathname === `/api/tasks/${taskId}/taskflowstatus` && method === "PUT") {
      statusBodies.push(JSON.parse(init.body || "{}"));
      statusPutCount += 1;
      if (statusPutCount === 1) {
        return mockCookieJson({
          code: "MissingRequiredField",
          message: "操作失败。标签、应用分类、缺陷分类、复现概率",
        }, 400);
      }
      advanced = true;
      return mockCookieJson(null, 204);
    }
    if (u.pathname === `/api/projects/${projectId}/tags` && method === "GET") {
      return mockCookieJson({ message: "legacy endpoint unavailable" }, 404);
    }
    if (u.pathname === "/api/tags" && u.searchParams.get("tagType") === "project") {
      return mockCookieJson([
        { _id: "tag-geely", name: "Geely" },
        { _id: "tag-avatr", name: "阿维塔" },
      ]);
    }
    if (u.pathname === "/api/customfields") {
      return mockCookieJson([
        { _id: "cf-application", name: "应用分类", choices: [{ value: "App Market" }] },
        { _id: "cf-reproducibility", name: "复现概率", type: "text" },
      ]);
    }
    if (u.pathname === `/api/v2/projects/${projectId}/scenariofieldconfigs`) {
      return mockCookieJson({ result: [{
        _id: scenarioId,
        name: "缺陷",
        scenarioFields: [{
          scenarioField: {
            _customfieldId: "cf-defect",
            name: "缺陷分类",
            customfield: { choices: [{ _id: "choice-functional-bug", value: "功能使用BUG" }] },
          },
        }],
      }] });
    }
    if (u.pathname === `/api/v2/projects/${projectId}/customfieldentities/choices`) {
      assert.equal(u.searchParams.get("customfieldId"), "cf-application");
      return mockCookieJson({ choices: [{ _id: "choice-app-market", value: "App Market" }] });
    }
    if (u.pathname === `/api/projects/${projectId}/scenariofields/search`) return mockCookieJson({ result: [] });
    if (u.pathname === `/api/projects/${projectId}/customfieldlinks`) return mockCookieJson([]);
    if (u.pathname === `/api/projects/${projectId}/appscenariofieldconfigs`) return mockCookieJson([]);
    if (u.pathname === `/api/v2/tasks/${taskId}` && method === "PUT") {
      taskUpdateBody = JSON.parse(init.body || "{}");
      return mockCookieJson({ _id: taskId });
    }
    throw new Error(`unexpected fetch ${method} ${u.pathname}${u.search}`);
  };

  try {
    const result = await tb.updateTaskStatus(taskId, "可提测");
    assert.equal(result.ok, true);
    assert.equal(result.recoveredRequiredFields, true);
    assert.deepEqual(taskUpdateBody, {
      tagIds: ["tag-geely"],
      customfields: [
        {
          value: [{ title: "App Market", _id: "choice-app-market" }],
          _customfieldId: "cf-application",
          type: "dropDown",
        },
        {
          value: [{ title: "功能使用BUG", _id: "choice-functional-bug" }],
          _customfieldId: "cf-defect",
          type: "commongroup",
        },
        {
          value: [{ title: "一般" }],
          _customfieldId: "cf-reproducibility",
          type: "text",
        },
      ],
      targetSfcId: scenarioId,
      targetProjectId: projectId,
    });
    assert.equal(statusBodies.length, 2);
    assert.deepEqual(statusBodies[1], {
      _taskflowstatusId: targetStatusId,
      sfcRequiredValidateEnable: true,
      _scenariofieldconfigId: scenarioId,
      persistentValidatorEnable: false,
      disableRequiredCfIds: [],
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("updateTaskStatus：自动补必填项时保留已有标签和人工字段值", async () => {
  const origFetch = globalThis.fetch;
  const projectId = "project-preserve-required";
  const taskId = "task-preserve-required";
  const taskflowId = "taskflow-preserve-required";
  const scenarioId = "scenario-preserve-required";
  let advanced = false;
  let statusPutCount = 0;
  let taskUpdateBody = null;

  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      userCookie: "TEAMBITION_SESSIONID=preserve-required",
      projects: [{ id: projectId, name: "保留字段测试" }],
    },
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    if (u.pathname === `/api/tasks/${taskId}` && method === "GET") {
      return mockCookieJson({
        _id: taskId,
        _projectId: projectId,
        content: "【应用市场】保留人工字段",
        _tagIds: ["tag-manual"],
        _scenariofieldconfigId: scenarioId,
        customfields: [
          { _customfieldId: "cf-application-preserve", customfield: { name: "应用分类" }, value: [{ _id: "choice-s", title: "S" }] },
          { _customfieldId: "cf-defect-preserve", customfield: { name: "缺陷分类" }, value: [{ _id: "choice-interaction", title: "交互体验类（一般）" }] },
          { _customfieldId: "cf-reproducibility-preserve", customfield: { name: "复现概率" }, value: [{ title: "较高" }] },
        ],
        taskflowstatus: {
          _id: advanced ? "status-preserved" : "status-current-preserved",
          name: advanced ? "可提测" : "修复中",
          _taskflowId: taskflowId,
        },
      });
    }
    if (u.pathname === `/api/taskflows/${taskflowId}/taskflowstatus`) {
      return mockCookieJson({ result: [
        { _id: "status-current-preserved", name: "修复中", pos: 1 },
        { _id: "status-preserved", name: "可提测", pos: 2 },
      ] });
    }
    if (u.pathname === `/api/tasks/${taskId}/taskflowstatus` && method === "PUT") {
      statusPutCount += 1;
      if (statusPutCount === 1) return mockCookieJson({ code: "MissingRequiredField", message: "操作失败。必填字段" }, 400);
      advanced = true;
      return mockCookieJson(null, 204);
    }
    if (u.pathname === `/api/projects/${projectId}/tags`) {
      return mockCookieJson([{ _id: "tag-manual", name: "人工标签" }]);
    }
    if (u.pathname === "/api/customfields") {
      return mockCookieJson([
        { _id: "cf-application-preserve", name: "应用分类" },
        { _id: "cf-defect-preserve", name: "缺陷分类" },
        { _id: "cf-reproducibility-preserve", name: "复现概率" },
      ]);
    }
    if (u.pathname === `/api/v2/projects/${projectId}/scenariofieldconfigs`) return mockCookieJson({ result: [] });
    if (u.pathname === `/api/projects/${projectId}/scenariofields/search`) return mockCookieJson({ result: [] });
    if (u.pathname === `/api/projects/${projectId}/customfieldlinks`) return mockCookieJson([]);
    if (u.pathname === `/api/projects/${projectId}/appscenariofieldconfigs`) return mockCookieJson([]);
    if (u.pathname === `/api/v2/tasks/${taskId}` && method === "PUT") {
      taskUpdateBody = JSON.parse(init.body || "{}");
      return mockCookieJson({ _id: taskId });
    }
    if (u.pathname.includes("/customfieldentities/choices")) throw new Error("已有选项 ID 时不应重新猜选项");
    throw new Error(`unexpected fetch ${method} ${u.pathname}${u.search}`);
  };

  try {
    const result = await tb.updateTaskStatus(taskId, "可提测");
    assert.equal(result.ok, true);
    assert.equal(result.recoveredRequiredFields, true);
    assert.deepEqual(taskUpdateBody.tagIds, ["tag-manual"]);
    assert.deepEqual(taskUpdateBody.customfields.map((field) => field.value[0]), [
      { title: "S", _id: "choice-s" },
      { title: "交互体验类（一般）", _id: "choice-interaction" },
      { title: "较高" },
    ]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("updateTaskStatus：无法唯一解析必填标签时失败关闭且不写任务字段", async () => {
  const origFetch = globalThis.fetch;
  const projectId = "project-unresolved-required";
  const taskId = "task-unresolved-required";
  const taskflowId = "taskflow-unresolved-required";
  let taskUpdateCount = 0;
  let statusPutCount = 0;

  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      userCookie: "TEAMBITION_SESSIONID=unresolved-required",
      projects: [{ id: projectId, name: "无法解析标签测试" }],
    },
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    if (u.pathname === `/api/tasks/${taskId}` && method === "GET") {
      return mockCookieJson({
        _id: taskId,
        _projectId: projectId,
        content: "没有车型线索的任务",
        _scenariofieldconfigId: "scenario-unresolved-required",
        taskflowstatus: { _id: "status-current-unresolved", name: "修复中", _taskflowId: taskflowId },
      });
    }
    if (u.pathname === `/api/taskflows/${taskflowId}/taskflowstatus`) {
      return mockCookieJson({ result: [
        { _id: "status-current-unresolved", name: "修复中", pos: 1 },
        { _id: "status-target-unresolved", name: "可提测", pos: 2 },
      ] });
    }
    if (u.pathname === `/api/tasks/${taskId}/taskflowstatus` && method === "PUT") {
      statusPutCount += 1;
      return mockCookieJson({ code: "MissingRequiredField", message: "操作失败。标签" }, 400);
    }
    if (u.pathname === `/api/projects/${projectId}/tags`) {
      return mockCookieJson([{ _id: "tag-geely", name: "Geely" }, { _id: "tag-avatr", name: "阿维塔" }]);
    }
    if (u.pathname === "/api/customfields") {
      return mockCookieJson([
        { _id: "cf-app-unresolved", name: "应用分类" },
        { _id: "cf-defect-unresolved", name: "缺陷分类" },
        { _id: "cf-reproducibility-unresolved", name: "复现概率" },
      ]);
    }
    if (u.pathname === `/api/v2/projects/${projectId}/scenariofieldconfigs`) return mockCookieJson({ result: [] });
    if (u.pathname === `/api/projects/${projectId}/scenariofields/search`) return mockCookieJson({ result: [] });
    if (u.pathname === `/api/projects/${projectId}/customfieldlinks`) return mockCookieJson([]);
    if (u.pathname === `/api/projects/${projectId}/appscenariofieldconfigs`) return mockCookieJson([]);
    if (u.pathname === `/api/v2/tasks/${taskId}` && method === "PUT") {
      taskUpdateCount += 1;
      return mockCookieJson({ _id: taskId });
    }
    throw new Error(`unexpected fetch ${method} ${u.pathname}${u.search}`);
  };

  try {
    const result = await tb.updateTaskStatus(taskId, "可提测");
    assert.equal(result.ok, false);
    assert.equal(result.needFields, true);
    assert.match(result.error, /无法从 TB 标题或已有标签唯一确定/);
    assert.equal(statusPutCount, 1);
    assert.equal(taskUpdateCount, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("listTeambitionTaskCustomFieldDefs merges scenario field customfield aliases", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      userCookie: "TEAMBITION_SESSIONID=scenario-field-defs",
      projects: [{ id: "p-scenario-defs", name: "P Scenario Defs" }],
    },
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/api/customfields?_projectId=p-scenario-defs&_boundToObjectType=task")) {
      return mockJson([
        {
          _id: "cf-app-category",
          name: "\u5e94\u7528\u5206\u7c7b",
          choices: [{ value: "S" }, { value: "App Market" }],
        },
      ]);
    }
    if (u.includes("/api/v2/projects/p-scenario-defs/scenariofieldconfigs")) {
      return mockJson({
        result: [
          {
            scenarioFields: [
              {
                scenarioField: {
                  _customfieldId: "cf-defect-category",
                  name: "\u7f3a\u9677\u5206\u7c7b",
                  customfield: {
                    choices: [
                      { value: "\u529f\u80fd\u4f7f\u7528BUG" },
                      { name: "\u4ea4\u4e92\u4f53\u9a8c\u7c7b\uff08\u4e00\u822c\uff09" },
                    ],
                  },
                },
              },
            ],
          },
        ],
      });
    }
    if (u.includes("/api/projects/p-scenario-defs/scenariofields/search")) return mockJson({ result: [] });
    if (u.includes("/api/projects/p-scenario-defs/customfieldlinks")) return mockJson([]);
    if (u.includes("/api/projects/p-scenario-defs/appscenariofieldconfigs")) return mockJson([]);
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const defs = await tb.listTeambitionTaskCustomFieldDefs({ projectId: "p-scenario-defs", force: true });
    const byName = Object.fromEntries(defs.map((def) => [def.name, def]));
    assert.equal(byName["\u5e94\u7528\u5206\u7c7b"].id, "cf-app-category");
    assert.equal(byName["\u7f3a\u9677\u5206\u7c7b"].id, "cf-defect-category");
    assert.ok(byName["\u7f3a\u9677\u5206\u7c7b"].choices.includes("\u529f\u80fd\u4f7f\u7528BUG"));
    assert.ok(byName["\u7f3a\u9677\u5206\u7c7b"].choices.includes("\u4ea4\u4e92\u4f53\u9a8c\u7c7b\uff08\u4e00\u822c\uff09"));
    assert.ok(urls.some((u) => u.includes("/scenariofieldconfigs")));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("getTaskDetail merges cookie customfields when OpenAPI detail omits them", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-detail",
      appSecret: "secret-detail",
      orgId: "org-detail",
      userCookie: "TEAMBITION_SESSIONID=detail",
      projects: [{ id: "p-detail", name: "P Detail" }],
    },
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/appToken")) return mockJson({ appToken: "token-detail", expire: 1 });
    if (u.includes("open.teambition.com/api/task/query?taskId=tb-detail")) {
      return mockJson({ result: [{ taskId: "tb-detail", content: "OpenAPI title", uniqueId: 13036 }] });
    }
    if (u.includes("www.teambition.com/api/tasks/tb-detail")) {
      return mockJson({
        _id: "tb-detail",
        uniqueId: 13036,
        content: "Cookie title",
        customfields: [
          {
            _customfieldId: "cf-app-category",
            customfield: { name: "\u5e94\u7528\u5206\u7c7b" },
            value: { label: "S", value: "S" },
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const detail = await tb.getTaskDetail("tb-detail");
    assert.equal(detail.content, "OpenAPI title");
    assert.equal(detail.customfields[0].customfield.name, "\u5e94\u7528\u5206\u7c7b");
    assert.equal(detail.customfields[0].value.label, "S");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("checkTeambitionStatus: invalid app token falls back to valid cookie", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app",
      appSecret: "bad",
      orgId: "org",
      userCookie: "TEAMBITION_SESSIONID=x",
    },
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/appToken")) return mockJson({ error: "InternalServerError", message: "invalid appSecret" });
    if (u.includes("/api/users/me")) return mockJson({ _id: "u-cookie", name: "Cookie User" });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const st = await tb.checkTeambitionStatus();
    assert.equal(st.available, true);
    assert.equal(st.source, "cookie");
    assert.match(st.openApiReason, /invalid appSecret/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("getMyActiveTasks: open api failure falls back to cookie task list", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app",
      appSecret: "bad",
      orgId: "org",
      operatorId: "u1",
      userCookie: "TEAMBITION_SESSIONID=x",
      projects: [{ id: "p1", name: "P1" }],
    },
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/appToken")) return mockJson({ error: "InternalServerError", message: "invalid appSecret" });
    if (u.includes("/api/projects/p1/taskflows")) return mockJson([]);
    if (u.includes("/api/projects/p1/tasks?count=60")) return mockJson([]);
    if (u.includes("/api/projects/p1/tasks?count=500")) {
      return mockJson([
        {
          _id: "tb1",
          _projectId: "p1",
          _executorId: "u1",
          isDone: false,
          uniqueId: 123,
          content: "Cookie task",
          dueDate: "2026-07-02T00:00:00.000Z",
        },
      ]);
    }
    if (u.includes("/api/v2/tasks")) return mockJson({ result: [], count: 0 });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const r = await tb.getMyActiveTasks("u1");
    assert.equal(r.source, "cookie");
    assert.equal(r.tasks.length, 1);
    assert.equal(r.tasks[0].tbTaskId, "tb1");
    assert.equal(r.tasks[0].carbId, "CARB-123");
    assert.equal(r.tasks[0].deadline, "2026-07-02");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("findTeambitionTaskByContent: cookie project task list fallback returns task id", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-find",
      appSecret: "secret-find",
      orgId: "org",
      userCookie: "TEAMBITION_SESSIONID=x",
      projects: [{ id: "p-cookie", name: "P Cookie" }],
    },
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/appToken")) return mockJson({ appToken: "token-find", expire: 3600 });
    if (u.includes("open.teambition.com/api/task/query")) return mockJson({ result: { list: [] } });
    if (u.includes("www.teambition.com/api/projects/p-cookie/tasks?count=500&isDone=false")) {
      return mockJson([
        {
          _id: "tb-cookie-found",
          _projectId: "p-cookie",
          content: "Recover Title",
          uniqueId: 13095,
          updatedAt: "2026-07-05T00:00:00.000Z",
        },
      ]);
    }
    if (u.includes("www.teambition.com/api/projects/p-cookie/tasks?count=500")) return mockJson([]);
    if (u.includes("www.teambition.com/api/v2/tasks")) return mockJson({ result: [], nextPageToken: "" });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const found = await tb.findTeambitionTaskByContent("Recover   Title", { projectId: "p-cookie" });
    assert.equal(found?._id, "tb-cookie-found");
    assert.equal(found?.uniqueId, 13095);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("findTeambitionTaskBySourceId: cookie project task list fallback matches task note", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-source",
      appSecret: "secret-source",
      orgId: "org",
      userCookie: "TEAMBITION_SESSIONID=x",
      projects: [{ id: "p-source", name: "P Source" }],
    },
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/appToken")) return mockJson({ appToken: "token-source", expire: 3600 });
    if (u.includes("open.teambition.com/api/task/query")) return mockJson({ result: { list: [] } });
    if (u.includes("www.teambition.com/api/projects/p-source/tasks?count=500&isDone=false")) {
      return mockJson([
        {
          _id: "tb-source-found",
          _projectId: "p-source",
          content: "Title changed after original sync",
          note: "Source: Feishu Project\nSource ID: intelligentspace/bug/remote-source-1",
          uniqueId: 13096,
          updatedAt: "2026-07-05T00:00:00.000Z",
        },
      ]);
    }
    if (u.includes("www.teambition.com/api/projects/p-source/tasks?count=500")) return mockJson([]);
    if (u.includes("www.teambition.com/api/v2/tasks")) return mockJson({ result: [], nextPageToken: "" });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const found = await tb.findTeambitionTaskBySourceId("intelligentspace/bug/remote-source-1", { projectId: "p-source" });
    assert.equal(found?._id, "tb-source-found");
    assert.equal(found?.uniqueId, 13096);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("createTeambitionTaskSearchSession reuses one remote task scan for source and title lookups", async () => {
  const origFetch = globalThis.fetch;
  let taskQueryCalls = 0;
  let cookieTaskCalls = 0;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-session",
      appSecret: "secret-session",
      orgId: "org",
      userCookie: "TEAMBITION_SESSIONID=x",
      projects: [{ id: "p-session", name: "P Session" }],
    },
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/appToken")) return mockJson({ appToken: "token-session", expire: 3600 });
    if (u.includes("open.teambition.com/api/task/query")) {
      taskQueryCalls += 1;
      return mockJson({ result: [{ _id: "tb-session-title", content: "Session Title", uniqueId: 14001 }] });
    }
    if (u.includes("www.teambition.com/api/projects/p-session/tasks") || u.includes("www.teambition.com/api/v2/tasks")) {
      cookieTaskCalls += 1;
      return mockJson([
        {
          _id: "tb-session-source",
          _projectId: "p-session",
          content: "Renamed Session Title",
          note: "Source: Feishu Project\nSource ID: intelligentspace/bug/session-source-1",
          uniqueId: 14002,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const session = tb.createTeambitionTaskSearchSession();
    const bySource = await session.findBySourceId("intelligentspace/bug/session-source-1", { projectId: "p-session" });
    const countsAfterFirst = { taskQueryCalls, cookieTaskCalls };
    const byTitle = await session.findByContent("Session Title", { projectId: "p-session" });
    assert.equal(bySource?._id, "tb-session-source");
    assert.equal(byTitle?._id, "tb-session-title");
    assert.deepEqual({ taskQueryCalls, cookieTaskCalls }, countsAfterFirst);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("updateTeambitionTask cookie move fallback supplies organization and current stage", async () => {
  const origFetch = globalThis.fetch;
  const calls = [];
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-move",
      appSecret: "secret-move",
      orgId: "org-move",
      userCookie: "TEAMBITION_SESSIONID=move",
    },
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, path: u.pathname, method, body });
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-move", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/task/update") {
      return mockJson({ code: 404, message: "unexpected /api/v3/task/update" }, 404);
    }
    if (u.host === "www.teambition.com" && u.pathname === "/api/tasks/tb-move-required" && method === "GET") {
      return mockJson({
        _id: "tb-move-required",
        _projectId: "p-current",
        _tasklistId: "list-current",
        _sprintId: "sprint-current",
        _stageId: "stage-current",
        _organizationId: "org-current",
      });
    }
    if (u.host === "www.teambition.com" && u.pathname === "/api/tasks/tb-move-required/move" && method === "PUT") {
      return mockJson({ _id: "tb-move-required", moved: true });
    }
    throw new Error(`unexpected fetch ${method} ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.updateTeambitionTask("tb-move-required", {
      projectId: "p-target",
      tasklistId: "list-target",
      sprintId: "sprint-current",
    });
    assert.equal(result.moved, true);
    const moveCall = calls.find((call) => call.path === "/api/tasks/tb-move-required/move");
    assert.equal(moveCall.body._projectId, "p-target");
    assert.equal(moveCall.body._tasklistId, "list-target");
    assert.equal(moveCall.body._sprintId, "sprint-current");
    assert.equal(moveCall.body._stageId, "stage-current");
    assert.equal(moveCall.body._organizationId, "org-move");
    assert.equal(moveCall.body.organizationId, "org-move");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("updateTeambitionTask cookie move fallback skips unchanged target location", async () => {
  const origFetch = globalThis.fetch;
  const calls = [];
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-move-same",
      appSecret: "secret-move-same",
      orgId: "org-move-same",
      userCookie: "TEAMBITION_SESSIONID=move-same",
    },
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, path: u.pathname, method, body });
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-move-same", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/task/update") {
      return mockJson({ code: 404, message: "unexpected /api/v3/task/update" }, 404);
    }
    if (u.host === "www.teambition.com" && u.pathname === "/api/tasks/tb-move-same" && method === "GET") {
      return mockJson({
        _id: "tb-move-same",
        _projectId: "p-current",
        _tasklistId: "list-current",
        _sprintId: "sprint-current",
        _stageId: "stage-current",
        _organizationId: "org-current",
      });
    }
    if (u.host === "www.teambition.com" && u.pathname === "/api/tasks/tb-move-same/move") {
      throw new Error("unchanged task location should not call move");
    }
    throw new Error(`unexpected fetch ${method} ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.updateTeambitionTask("tb-move-same", {
      projectId: "p-current",
      tasklistId: "list-current",
      sprintId: "sprint-current",
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "move-target-unchanged");
    assert.equal(calls.some((call) => call.path === "/api/tasks/tb-move-same/move"), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("updateTeambitionTaskCustomFields continues after a field returns no-change code 204", async () => {
  const origFetch = globalThis.fetch;
  const calls = [];
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-customfield-no-change",
      appSecret: "secret-customfield-no-change",
      orgId: "org-customfield-no-change",
      operatorId: "configured-operator",
    },
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-customfield-no-change", expire: 3600 });
    if (u.pathname === "/api/v3/task/tb-customfield/customfield/update") {
      const body = JSON.parse(init.body || "{}");
      calls.push({ body, operatorId: init.headers?.["X-Operator-Id"] });
      if (body.customfieldId === "cf-same") return mockJson({ code: 204, errorMessage: "", result: null });
      return mockJson({ code: 200, result: { updated: "2026-07-20T13:10:00.000Z" } });
    }
    throw new Error(`unexpected fetch ${u.pathname}`);
  };
  try {
    const result = await tb.updateTeambitionTaskCustomFields("tb-customfield", [
      { customfieldId: "cf-same", value: "same" },
      { customfieldId: "cf-next", value: "next" },
    ], { operatorId: "task-executor" });
    assert.equal(result.length, 2);
    assert.equal(result[0].noChange, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.operatorId), ["task-executor", "task-executor"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("getTaskCommentsWithStatus falls back to Cookie activities when OpenAPI is unavailable", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-comment-cookie-fallback",
      appSecret: "secret-comment-cookie-fallback",
      orgId: "org-comment-cookie-fallback",
      userCookie: "TEAMBITION_SESSIONID=comment-cookie-fallback",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-comment-cookie-fallback", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) {
      return mockJson({ message: "open api unavailable" }, 503);
    }
    if (u.host === "www.teambition.com" && u.pathname === "/api/v2/tasks/tb-comment-cookie/activities") {
      return mockJson({
        result: [
          {
            _id: "activity-comment",
            action: "activity.comment.create",
            created: "2026-07-25T09:31:08.820Z",
            creator: { name: "测试用户" },
            content: { comment: "请检查安装失败日志" },
          },
          {
            _id: "activity-update",
            action: "activity.task.update",
            content: { title: "状态变化" },
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.getTaskCommentsWithStatus("tb-comment-cookie", "comment");
    assert.equal(result.available, true);
    assert.equal(result.complete, true);
    assert.equal(result.source, "cookie");
    assert.deepEqual(result.items.map((item) => item._id), ["activity-comment"]);
    assert.deepEqual(await tb.getTaskComments("tb-comment-cookie", "comment"), result.items);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("getTaskAttachmentsWithStatus independently enumerates Cookie comment files", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-attachment-cookie-fallback",
      appSecret: "secret-attachment-cookie-fallback",
      orgId: "org-attachment-cookie-fallback",
      userCookie: "TEAMBITION_SESSIONID=attachment-cookie-fallback",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-attachment-cookie-fallback", expire: 3600 });
    if (u.host === "open.teambition.com") return mockJson({ message: "open api unavailable" }, 503);
    if (u.host === "www.teambition.com" && u.pathname === "/api/v2/tasks/tb-attachment-cookie/activities") {
      return mockJson({
        result: [{
          _id: "activity-attachments",
          action: "activity.comment.attachments",
          created: "2026-07-25T09:31:08.820Z",
          content: {
            files: [
              { _id: "file-log", name: "app.txt", ext: "txt", size: 5160968, mimeType: "text/plain", url: "https://download.example/app.txt" },
              { _id: "file-video", name: "recording", ext: ".mp4", size: 251511, mimeType: "video/mp4", url: "https://download.example/recording.mp4" },
            ],
          },
        }],
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.getTaskAttachmentsWithStatus("tb-attachment-cookie");
    assert.equal(result.available, true);
    assert.equal(result.complete, false);
    assert.equal(result.source, "cookie");
    assert.match(result.error, /TB 附件读取不完整/);
    assert.deepEqual(result.items.map((item) => item.fileName), ["app.txt", "recording.mp4"]);
    assert.deepEqual(result.items.map((item) => item.id), ["file-log", "file-video"]);
    assert.equal(result.items.every((item) => item.downloadUrl), true);
    assert.deepEqual(result.items.map((item) => item.createdAt), [
      "2026-07-25T09:31:08.820Z",
      "2026-07-25T09:31:08.820Z",
    ]);
    assert.equal((await tb.getTaskAttachments("tb-attachment-cookie")).length, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("TB comment and attachment reads report unavailable instead of false empty arrays", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-read-unavailable",
      appSecret: "secret-read-unavailable",
      orgId: "org-read-unavailable",
      userCookie: "",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-read-unavailable", expire: 3600 });
    if (u.host === "open.teambition.com") return mockJson({ message: "open api unavailable" }, 503);
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const comments = await tb.getTaskCommentsWithStatus("tb-read-unavailable", "comment");
    assert.equal(comments.available, false);
    assert.equal(comments.items.length, 0);
    assert.match(comments.error, /未配置 TB Cookie/);
    await assert.rejects(() => tb.getTaskComments("tb-read-unavailable", "comment"), /TB 评论读取失败/);

    const attachments = await tb.getTaskAttachmentsWithStatus("tb-read-unavailable");
    assert.equal(attachments.available, false);
    assert.equal(attachments.items.length, 0);
    assert.match(attachments.error, /未配置 TB Cookie/);
    await assert.rejects(() => tb.getTaskAttachments("tb-read-unavailable"), /TB 附件读取失败/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("successful OpenAPI empty reads remain authoritative empty results", async () => {
  const origFetch = globalThis.fetch;
  let cookieActivityCalls = 0;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-authoritative-empty",
      appSecret: "secret-authoritative-empty",
      orgId: "org-authoritative-empty",
      userCookie: "TEAMBITION_SESSIONID=authoritative-empty",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-authoritative-empty", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/work/list") return mockJson({ result: [] });
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) return mockJson({ result: [] });
    if (u.host === "www.teambition.com" && u.pathname.endsWith("/activities")) {
      cookieActivityCalls++;
      return mockJson({ result: [] });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const comments = await tb.getTaskCommentsWithStatus("tb-authoritative-empty", "comment");
    assert.deepEqual(
      { available: comments.available, complete: comments.complete, source: comments.source, count: comments.items.length },
      { available: true, complete: true, source: "open-api", count: 0 },
    );

    const attachments = await tb.getTaskAttachmentsWithStatus("tb-authoritative-empty");
    assert.deepEqual(
      { available: attachments.available, complete: attachments.complete, source: attachments.source, count: attachments.items.length },
      { available: true, complete: true, source: "open-api", count: 0 },
    );
    assert.equal(cookieActivityCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("malformed 2xx OpenAPI activity and work payloads fall back to Cookie instead of false empty", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-malformed-fallback",
      appSecret: "secret-malformed-fallback",
      orgId: "org-malformed-fallback",
      userCookie: "TEAMBITION_SESSIONID=malformed-fallback",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-malformed-fallback", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/work/list") return mockJson({ code: 200 });
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) return mockJson({ result: { unexpected: true } });
    if (u.host === "www.teambition.com" && u.pathname === "/api/v2/tasks/tb-malformed-fallback/activities") {
      return mockJson({
        result: [{
          _id: "activity-malformed-fallback",
          action: "activity.comment.attachments",
          content: {
            files: [{ _id: "file-malformed-fallback", name: "fallback.log", size: 12, url: "https://download.example/fallback.log" }],
          },
        }],
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const comments = await tb.getTaskCommentsWithStatus("tb-malformed-fallback", "comment");
    assert.equal(comments.available, true);
    assert.equal(comments.complete, true);
    assert.equal(comments.source, "cookie");
    assert.equal(comments.items.length, 1);

    const attachments = await tb.getTaskAttachmentsWithStatus("tb-malformed-fallback");
    assert.equal(attachments.available, true);
    assert.equal(attachments.complete, false);
    assert.equal(attachments.source, "cookie");
    assert.deepEqual(attachments.items.map((item) => item.fileName), ["fallback.log"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("comment pagination limit is reported as partial when Cookie fallback is unavailable", async () => {
  const origFetch = globalThis.fetch;
  let activityCalls = 0;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-comment-page-limit",
      appSecret: "secret-comment-page-limit",
      orgId: "org-comment-page-limit",
      userCookie: "",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-comment-page-limit", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) {
      activityCalls++;
      return mockJson({
        result: [{ _id: `page-comment-${activityCalls}`, action: "activity.comment.create", content: { comment: `第 ${activityCalls} 页` } }],
        nextPageToken: `next-${activityCalls}`,
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.getTaskCommentsWithStatus("tb-comment-page-limit", "comment");
    assert.equal(result.available, true);
    assert.equal(result.complete, false);
    assert.equal(result.source, "open-api");
    assert.equal(result.items.length, 5);
    assert.equal(activityCalls, 5);
    assert.match(result.error, /超过 5 页/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("attachment comment activities paginate before resolving file details", async () => {
  const origFetch = globalThis.fetch;
  let activityCalls = 0;
  let cookieActivityCalls = 0;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-attachment-pagination",
      appSecret: "secret-attachment-pagination",
      orgId: "org-attachment-pagination",
      userCookie: "TEAMBITION_SESSIONID=attachment-pagination",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-attachment-pagination", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/work/list") return mockJson({ result: [] });
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) {
      activityCalls++;
      const secondPage = u.searchParams.get("pageToken") === "attachment-page-2";
      return mockJson({
        result: [{
          _id: secondPage ? "activity-page-2" : "activity-page-1",
          action: "activity.comment.attachments",
          created: secondPage ? "2026-07-26T02:00:00.000Z" : "2026-07-25T01:00:00.000Z",
          content: { files: [secondPage ? "file-page-2" : "file-page-1"] },
        }],
        nextPageToken: secondPage ? "" : "attachment-page-2",
      });
    }
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/work/query") {
      assert.equal(u.searchParams.get("workIds"), "file-page-1,file-page-2");
      return mockJson({
        result: [
          { id: "file-page-1", fileName: "page-1.log", downloadUrl: "https://download.example/page-1.log" },
          { id: "file-page-2", fileName: "page-2.log", downloadUrl: "https://download.example/page-2.log" },
        ],
      });
    }
    if (u.host === "www.teambition.com" && u.pathname.endsWith("/activities")) {
      cookieActivityCalls++;
      return mockJson({ result: [] });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.getTaskAttachmentsWithStatus("tb-attachment-pagination");
    assert.equal(result.available, true);
    assert.equal(result.complete, true);
    assert.equal(result.source, "open-api");
    assert.deepEqual(result.items.map((item) => item.fileName), ["page-1.log", "page-2.log"]);
    assert.deepEqual(result.items.map((item) => item.createdAt), [
      "2026-07-25T01:00:00.000Z",
      "2026-07-26T02:00:00.000Z",
    ]);
    assert.equal(activityCalls, 2);
    assert.equal(cookieActivityCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Cookie activity total prevents a truncated response from being marked complete", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-cookie-truncated",
      appSecret: "secret-cookie-truncated",
      orgId: "org-cookie-truncated",
      userCookie: "TEAMBITION_SESSIONID=cookie-truncated",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-cookie-truncated", expire: 3600 });
    if (u.host === "open.teambition.com") return mockJson({ message: "open api unavailable" }, 503);
    if (u.host === "www.teambition.com" && u.pathname === "/api/v2/tasks/tb-cookie-truncated/activities") {
      return mockJson({
        result: [{
          _id: "activity-cookie-truncated",
          action: "activity.comment.attachments",
          content: {
            files: [{ _id: "file-cookie-truncated", name: "partial.log", size: 8, url: "https://download.example/partial.log" }],
          },
        }],
        total: 2,
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const comments = await tb.getTaskCommentsWithStatus("tb-cookie-truncated", "comment");
    assert.equal(comments.available, true);
    assert.equal(comments.complete, false);
    assert.equal(comments.source, "cookie");
    assert.match(comments.error, /只返回 1\/2 条/);

    const attachments = await tb.getTaskAttachmentsWithStatus("tb-cookie-truncated");
    assert.equal(attachments.available, true);
    assert.equal(attachments.complete, false);
    assert.deepEqual(attachments.items.map((item) => item.fileName), ["partial.log"]);
    assert.match(attachments.error, /只返回 1\/2 条/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("direct attachment work list paginates before reporting a complete result", async () => {
  const origFetch = globalThis.fetch;
  let workCalls = 0;
  let cookieActivityCalls = 0;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-work-pagination",
      appSecret: "secret-work-pagination",
      orgId: "org-work-pagination",
      userCookie: "TEAMBITION_SESSIONID=work-pagination",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-work-pagination", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/work/list") {
      workCalls++;
      const secondPage = u.searchParams.get("pageToken") === "work-page-2";
      return mockJson({
        result: [{
          id: secondPage ? "direct-file-2" : "direct-file-1",
          fileName: secondPage ? "direct-2.log" : "direct-1.log",
          downloadUrl: secondPage ? "https://download.example/direct-2.log" : "https://download.example/direct-1.log",
        }],
        nextPageToken: secondPage ? "" : "work-page-2",
      });
    }
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) return mockJson({ result: [] });
    if (u.host === "www.teambition.com" && u.pathname.endsWith("/activities")) {
      cookieActivityCalls++;
      return mockJson({ result: [] });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.getTaskAttachmentsWithStatus("tb-work-pagination");
    assert.equal(result.available, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.items.map((item) => item.fileName), ["direct-1.log", "direct-2.log"]);
    assert.equal(workCalls, 2);
    assert.equal(cookieActivityCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("later-page failures preserve already-read comments and attachments as partial evidence", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-later-page-failure",
      appSecret: "secret-later-page-failure",
      orgId: "org-later-page-failure",
      userCookie: "",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-later-page-failure", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/work/list") {
      if (u.searchParams.has("pageToken")) return mockJson({ message: "work page 2 unavailable" }, 503);
      return mockJson({
        result: [{ id: "direct-before-failure", fileName: "direct-before-failure.log", downloadUrl: "https://download.example/direct-before-failure.log" }],
        nextPageToken: "work-page-failure",
      });
    }
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) {
      if (u.searchParams.has("pageToken")) return mockJson({ message: "activity page 2 unavailable" }, 503);
      const isAttachmentTask = u.pathname.includes("tb-attachment-later-page-failure");
      return mockJson({
        result: isAttachmentTask
          ? [{ _id: "attachment-activity-before-failure", action: "activity.comment.attachments", content: { files: ["comment-file-before-failure"] } }]
          : [{ _id: "comment-before-failure", action: "activity.comment.create", content: { comment: "第一页评论" } }],
        nextPageToken: "activity-page-failure",
      });
    }
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/work/query") {
      return mockJson({
        result: [{ id: "comment-file-before-failure", fileName: "comment-before-failure.log", downloadUrl: "https://download.example/comment-before-failure.log" }],
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const comments = await tb.getTaskCommentsWithStatus("tb-comment-later-page-failure", "comment");
    assert.equal(comments.available, true);
    assert.equal(comments.complete, false);
    assert.deepEqual(comments.items.map((item) => item._id), ["comment-before-failure"]);
    assert.match(comments.error, /第 2 页读取失败/);

    const attachments = await tb.getTaskAttachmentsWithStatus("tb-attachment-later-page-failure");
    assert.equal(attachments.available, true);
    assert.equal(attachments.complete, false);
    assert.deepEqual(
      attachments.items.map((item) => item.fileName),
      ["direct-before-failure.log", "comment-before-failure.log"],
    );
    assert.match(attachments.error, /第 2 页读取失败/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("comment activities are deduplicated by id across OpenAPI pages", async () => {
  const origFetch = globalThis.fetch;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-comment-dedupe",
      appSecret: "secret-comment-dedupe",
      orgId: "org-comment-dedupe",
      userCookie: "",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-comment-dedupe", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) {
      const secondPage = u.searchParams.get("pageToken") === "comment-dedupe-page-2";
      return mockJson({
        result: secondPage
          ? [
              { _id: "comment-shared", action: "activity.comment.create", content: { comment: "重复评论" } },
              { _id: "comment-unique", action: "activity.comment.create", content: { comment: "新增评论" } },
            ]
          : [{ _id: "comment-shared", action: "activity.comment.create", content: { comment: "重复评论" } }],
        nextPageToken: secondPage ? "" : "comment-dedupe-page-2",
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.getTaskCommentsWithStatus("tb-comment-dedupe", "comment");
    assert.equal(result.complete, true);
    assert.deepEqual(result.items.map((item) => item._id), ["comment-shared", "comment-unique"]);
    assert.deepEqual(
      (await tb.getTaskComments("tb-comment-dedupe", "comment")).map((item) => item._id),
      ["comment-shared", "comment-unique"],
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("partial Cookie fallback merges with partial OpenAPI comments without losing evidence", async () => {
  const origFetch = globalThis.fetch;
  let openApiPage = 0;
  cfg.updateConfig({
    teambition: {
      ...cfg.getConfig().teambition,
      appId: "app-cross-source-partial",
      appSecret: "secret-cross-source-partial",
      orgId: "org-cross-source-partial",
      userCookie: "TEAMBITION_SESSIONID=cross-source-partial",
    },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/appToken") return mockJson({ appToken: "token-cross-source-partial", expire: 3600 });
    if (u.host === "open.teambition.com" && u.pathname.includes("/activity/list")) {
      openApiPage++;
      return mockJson({
        result: [{
          _id: `open-comment-${openApiPage}`,
          action: "activity.comment.create",
          content: { comment: `OpenAPI 第 ${openApiPage} 页` },
        }],
        nextPageToken: `cross-source-next-${openApiPage}`,
      });
    }
    if (u.host === "www.teambition.com" && u.pathname === "/api/v2/tasks/tb-cross-source-partial/activities") {
      return mockJson({
        result: [
          { _id: "open-comment-5", action: "activity.comment.create", content: { comment: "重复的第 5 条" } },
          { _id: "cookie-comment-6", action: "activity.comment.create", content: { comment: "Cookie 新增第 6 条" } },
        ],
        total: 6,
      });
    }
    throw new Error(`unexpected fetch ${u.host}${u.pathname}`);
  };
  try {
    const result = await tb.getTaskCommentsWithStatus("tb-cross-source-partial", "comment");
    assert.equal(result.available, true);
    assert.equal(result.complete, false);
    assert.equal(result.source, "open-api+cookie");
    assert.deepEqual(
      result.items.map((item) => item._id),
      ["open-comment-1", "open-comment-2", "open-comment-3", "open-comment-4", "open-comment-5", "cookie-comment-6"],
    );
    assert.match(result.error, /超过 5 页/);
    assert.match(result.error, /只返回 2\/6 条/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
