import assert from "node:assert/strict";
import test from "node:test";

import {
  createStoryCreateReviewScope,
  DEFAULT_STORY_AI_REVIEW_TTL_MS,
  MAX_STORY_AI_REVIEW_TTL_MS,
  storyAiReviewTtlMs,
  validateStoryCreateReviewRun,
  validateStoryCreateReviewScope,
} from "../services/devbench/story-create-review.js";

function reviewedRun(scope, decision = "insufficient") {
  const identities = scope.evidenceTicketIdentities || [];
  const tbTaskId = identities.find((value) => value.startsWith("tb-task:"))?.slice("tb-task:".length) || "";
  const carbId = identities.find((value) => value.startsWith("carb:"))?.slice("carb:".length) || "";
  return {
    projectId: scope.projectId,
    trigger: scope.trigger,
    createScope: scope,
    ticket: {
      ...(tbTaskId ? { tbTaskId } : {}),
      ...(carbId ? { carbId } : {}),
      ticketBound: scope.evidenceTicketBound === true,
    },
    review: { decision, reviewer: scope.ownerId, reviewedAt: 130 },
    stalePrediction: false,
  };
}

test("故事点初始化默认给人工核对保留一小时，显式短窗口和上限仍生效", () => {
  assert.equal(storyAiReviewTtlMs(undefined), 60 * 60 * 1000);
  assert.equal(storyAiReviewTtlMs(10 * 60 * 1000), 10 * 60 * 1000);
  assert.equal(storyAiReviewTtlMs(2 * 60 * 60 * 1000), 60 * 60 * 1000);
  assert.equal(DEFAULT_STORY_AI_REVIEW_TTL_MS, MAX_STORY_AI_REVIEW_TTL_MS);

  const scope = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_initialization",
    ticket: { projectId: "project-a", title: "需要较长时间核对的故事点" },
    storyEntry: {
      kind: "story_initialization",
      createEntries: [{ kind: "blank_story", title: "需要较长时间核对的故事点" }],
    },
  }, { ownerId: "owner-a", now: 100 });
  const run = reviewedRun(scope.data);
  const request = {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "blank_story" },
    title: "需要较长时间核对的故事点",
    now: 130 + (11 * 60 * 1000),
  };

  assert.equal(validateStoryCreateReviewRun(run, {
    ...request,
    ttlMs: storyAiReviewTtlMs(undefined),
  }).ok, true);
  assert.equal(validateStoryCreateReviewRun(run, {
    ...request,
    ttlMs: storyAiReviewTtlMs(10 * 60 * 1000),
  }).code, "STORY_CREATE_AI_REVIEW_EXPIRED");
});

test("创建复核范围冻结 owner、consumer、标题、任务和复制来源", () => {
  const issued = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_initialization",
    ticket: { projectId: "project-a", title: "复制故事点" },
    storyEntry: {
      kind: "story_initialization",
      createEntries: [
        { kind: "story_copy", title: "复制故事点", copyFromId: "closed-1", copyFromKind: "closed" },
      ],
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(issued.ok, true);
  assert.equal(issued.data.consumer, "tabs");
  assert.equal(issued.data.entries.length, 1);
  assert.equal(validateStoryCreateReviewScope(issued.data, {
    ownerId: "owner-a",
    projectId: "project-a",
    trigger: "story_initialization",
    consumer: "tabs",
  }).ok, true);

  const run = reviewedRun(issued.data);
  const allowed = validateStoryCreateReviewRun(run, {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "story_copy", copyFromId: "closed-1", copyFromKind: "closed" },
    title: "复制故事点",
    now: 140,
    ttlMs: 20,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.decision, "insufficient");
  assert.equal(allowed.expiresAt, 150);

  assert.equal(validateStoryCreateReviewRun(run, {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "story_copy", copyFromId: "closed-2", copyFromKind: "closed" },
    title: "复制故事点",
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
  assert.equal(validateStoryCreateReviewRun(run, {
    ownerId: "owner-b",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "blank_story" },
    title: "空白故事点",
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_OWNER_MISMATCH");
  assert.equal(validateStoryCreateReviewRun(run, {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "git_commit_story",
    entry: { kind: "blank_story" },
    title: "空白故事点",
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_CONSUMER_MISMATCH");
  assert.equal(validateStoryCreateReviewRun(run, {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "blank_story" },
    title: "空白故事点",
    now: 151,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_EXPIRED");
});

test("任务组只授权冻结的任务身份，负向人工决定也能形成创建证明", () => {
  const taskATbTaskId = "111111111111111111111111";
  const taskBTbTaskId = "222222222222222222222222";
  const scope = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "task_group_execute",
    ticket: {
      projectId: "project-a",
      title: "任务 A",
      tbTaskId: taskATbTaskId,
    },
    storyEntry: {
      kind: "task_group",
      items: [
        { id: "task-a", tbTaskId: taskATbTaskId.toUpperCase(), title: "任务 A" },
        {
          id: "task-b",
          ticketUrl: `https://www.teambition.com/task/${taskBTbTaskId}`,
          ticketId: "CARB-12011",
          title: "任务 B",
        },
      ],
    },
  }, { ownerId: "owner-a", now: 120 }).data;
  assert.deepEqual(scope.entries.map((row) => row.kind), ["task_story", "task_story"]);
  assert.deepEqual(scope.entries.map((row) => row.ticketIdentity), [
    `tb-task:${taskATbTaskId}`,
    `tb-task:${taskBTbTaskId}`,
  ]);
  assert.equal(scope.entries[1].ticketIdentity, `tb-task:${taskBTbTaskId}`);
  const wrongEvidence = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "task_group_execute",
    ticket: { projectId: "project-a", tbTaskId: taskBTbTaskId, title: "任务 B" },
    storyEntry: {
      kind: "task_group",
      items: [
        { id: "task-a", tbTaskId: taskATbTaskId, title: "任务 A" },
        { id: "task-b", tbTaskId: taskBTbTaskId, title: "任务 B" },
      ],
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(wrongEvidence.code, "STORY_CREATE_SCOPE_TICKET_MISMATCH");
  for (const decision of ["correct", "corrected", "insufficient", "ticket_wrong"]) {
    const checked = validateStoryCreateReviewRun(reviewedRun(scope, decision), {
      ownerId: "owner-a",
      projectId: "project-a",
      consumer: "tabs",
      entry: {
        kind: "task_story",
        taskId: "task-b",
        tbTaskId: taskBTbTaskId.toUpperCase(),
        title: "任务 B",
      },
      title: "任务 B",
      ticket: {
        tbTaskId: taskBTbTaskId,
        ticketUrl: `https://www.teambition.com/task/${taskBTbTaskId}`,
        ticketId: "CARB-12011",
      },
      now: 140,
      ttlMs: 20,
    });
    assert.equal(checked.ok, true, decision);
  }
  assert.equal(validateStoryCreateReviewRun(reviewedRun(scope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: {
      kind: "task_story",
      taskId: "task-b",
      ticketUrl: `https://www.teambition.com/task/${taskATbTaskId}`,
      title: "任务 B",
    },
    title: "任务 B",
    ticket: {
      tbTaskId: taskBTbTaskId,
      ticketUrl: `https://www.teambition.com/task/${taskBTbTaskId}`,
      ticketId: "CARB-12011",
    },
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
  for (const scenario of [
    {
      name: "server_ticket_changed",
      entry: { kind: "task_story", taskId: "task-a", tbTaskId: taskATbTaskId, title: "任务 A" },
      title: "任务 A",
      ticket: { tbTaskId: taskBTbTaskId, ticketUrl: `https://www.teambition.com/task/${taskBTbTaskId}` },
    },
    {
      name: "server_ticket_removed",
      entry: { kind: "task_story", taskId: "task-a", tbTaskId: taskATbTaskId, title: "任务 A" },
      title: "任务 A",
      ticket: {},
    },
    {
      name: "title_changed",
      entry: { kind: "task_story", taskId: "task-a", tbTaskId: taskATbTaskId, title: "任务 A（改）" },
      title: "任务 A（改）",
      ticket: { tbTaskId: taskATbTaskId, ticketUrl: `https://www.teambition.com/task/${taskATbTaskId}` },
    },
  ]) {
    assert.equal(validateStoryCreateReviewRun(reviewedRun(scope), {
      ownerId: "owner-a",
      projectId: "project-a",
      consumer: "tabs",
      entry: scenario.entry,
      title: scenario.title,
      ticket: scenario.ticket,
      now: 140,
      ttlMs: 20,
    }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH", scenario.name);
  }
  assert.equal(validateStoryCreateReviewRun(reviewedRun(scope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "task_story", taskId: "task-b", title: "任务 B" },
    title: "任务 B",
    ticket: {
      tbTaskId: taskBTbTaskId,
      ticketUrl: `https://www.teambition.com/task/${taskBTbTaskId}`,
      ticketId: "CARB-12011",
    },
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
  assert.equal(validateStoryCreateReviewRun(reviewedRun(scope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "task_story", taskId: "task-c" },
    title: "任务 C",
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
});

test("创建 scope 的 source kind 与 trigger 必须匹配，panel handoff 保留合法 story_created", () => {
  const task = {
    id: "task-trigger",
    tbTaskId: "dddddddddddddddddddddddd",
    title: "入口冻结任务",
  };
  const mismatched = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "task_team_execute",
    ticket: { projectId: "project-a", title: task.title, tbTaskId: task.tbTaskId },
    storyEntry: { kind: "task_group", items: [task] },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(mismatched.code, "STORY_CREATE_AI_REVIEW_TRIGGER_MISMATCH");

  const panel = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_created",
    ticket: { projectId: "project-a", title: task.title, tbTaskId: task.tbTaskId },
    storyEntry: {
      kind: "story_initialization_panel",
      createEntries: [{ kind: "task_story", ...task }],
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(panel.ok, true);
  assert.equal(panel.data.entryKind, "story_initialization_panel");
  const panelCrossTicket = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_created",
    ticket: { projectId: "project-a", title: task.title, tbTaskId: "eeeeeeeeeeeeeeeeeeeeeeee" },
    storyEntry: {
      kind: "story_initialization_panel",
      createEntries: [{ kind: "task_story", ...task }],
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(panelCrossTicket.code, "STORY_CREATE_SCOPE_TICKET_MISMATCH");
});

test("team_dev 的首任务身份同时绑定 AI 证据，且不把证据注入其它 entry", () => {
  const scope = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "task_team_execute",
    ticket: {
      projectId: "project-a",
      ticketId: "CARB-13001",
      title: "团队任务",
    },
    storyEntry: {
      kind: "team_dev",
      task: { id: "team-task", ticketId: "carb-13001", title: "团队任务" },
    },
  }, { ownerId: "owner-a", now: 120 }).data;
  assert.equal(scope.entries[0].ticketIdentity, "carb:CARB-13001");
  const wrongEvidence = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "task_team_execute",
    ticket: { projectId: "project-a", ticketId: "CARB-13002", title: "其它团队任务" },
    storyEntry: {
      kind: "team_dev",
      task: { id: "team-task", ticketId: "CARB-13001", title: "团队任务" },
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(wrongEvidence.code, "STORY_CREATE_SCOPE_TICKET_MISMATCH");
  assert.equal(validateStoryCreateReviewRun(reviewedRun(scope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "task_story", taskId: "team-task", carbId: "CARB-13001", title: "团队任务" },
    title: "团队任务",
    ticket: {
      tbTaskId: "cccccccccccccccccccccccc",
      ticketUrl: "https://www.teambition.com/task/cccccccccccccccccccccccc",
      ticketId: "CARB-13001",
    },
    now: 140,
    ttlMs: 20,
  }).ok, true);
  assert.equal(validateStoryCreateReviewRun(reviewedRun(scope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "task_story", taskId: "team-task", ticketId: "CARB-13002", title: "团队任务" },
    title: "团队任务",
    ticket: {
      tbTaskId: "cccccccccccccccccccccccc",
      ticketUrl: "https://www.teambition.com/task/cccccccccccccccccccccccc",
      ticketId: "CARB-13001",
    },
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
});

test("Git 创建证明绑定仓库与 revision，普通旧 run 不能补造范围", () => {
  const scope = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "git_commit_story_entry",
    ticket: { projectId: "project-a", ticketId: "git:abcdef123456" },
    storyEntry: {
      kind: "git_commit",
      createEntries: [{ kind: "git_commit", repositoryId: "repo-a", revision: "ABCDEF123456" }],
    },
  }, { ownerId: "owner-a", now: 120 }).data;
  assert.equal(scope.consumer, "git_commit_story");
  assert.equal(validateStoryCreateReviewRun(reviewedRun(scope, "ticket_wrong"), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "git_commit_story",
    entry: { kind: "git_commit", repositoryId: "repo-a", revision: "abcdef123456" },
    now: 140,
    ttlMs: 20,
  }).ok, true);
  assert.equal(validateStoryCreateReviewRun(reviewedRun(scope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "git_commit_story",
    entry: { kind: "git_commit", repositoryId: "repo-b", revision: "abcdef123456" },
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
  assert.equal(validateStoryCreateReviewRun({
    projectId: "project-a",
    trigger: "manual",
    review: { decision: "correct", reviewer: "owner-a", reviewedAt: 130 },
  }, {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "blank_story" },
    title: "任意标题",
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_REQUIRED");
});

test("空白和复制范围的标题必须与用户实际看到的推理标题一致", () => {
  const mismatched = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_initialization",
    ticket: { projectId: "project-a", title: "用户看到的标题" },
    storyEntry: {
      kind: "story_initialization",
      createEntries: [{ kind: "blank_story", title: "偷偷替换的标题" }],
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, "STORY_CREATE_SCOPE_MISMATCH");
});

test("空白和复制创建范围冻结规范化 TB 身份，同任务 URL/CARB 可通过且跨任务被拒", () => {
  const tbTaskId = "abcdefabcdefabcdefabcdef";
  const otherTbTaskId = "1234567890abcdef12345678";
  const blankScope = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_initialization",
    ticket: {
      projectId: "project-a",
      title: "CARB-12001 空白故事点",
      ticketId: "CARB-12001",
      ticketUrl: `https://www.teambition.com/task/${tbTaskId}`,
    },
    storyEntry: {
      kind: "story_initialization",
      createEntries: [{ kind: "blank_story", title: "CARB-12001 空白故事点" }],
    },
  }, { ownerId: "owner-a", now: 120 }).data;
  assert.equal(blankScope.entries[0].ticketIdentity, `tb-task:${tbTaskId}`);
  const blankRun = reviewedRun(blankScope);
  assert.equal(validateStoryCreateReviewRun(blankRun, {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "blank_story" },
    title: "CARB-12001 空白故事点",
    ticket: { tbTaskId: tbTaskId.toUpperCase() },
    now: 140,
    ttlMs: 20,
  }).ok, true);
  assert.equal(validateStoryCreateReviewRun(blankRun, {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "blank_story" },
    title: "CARB-12001 空白故事点",
    ticket: { ticketUrl: `https://www.teambition.com/task/${otherTbTaskId}` },
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");

  const copyScope = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_initialization",
    ticket: { projectId: "project-a", title: "# CARB-12002 # 复制故事点" },
    storyEntry: {
      kind: "story_initialization",
      createEntries: [{
        kind: "story_copy",
        title: "# CARB-12002 # 复制故事点",
        copyFromId: "closed-2",
        copyFromKind: "closed",
      }],
    },
  }, { ownerId: "owner-a", now: 120 }).data;
  // 标题中的 CARB 只用于命名；没有显式 ticket 字段时 scope 必须保持未绑定。
  assert.equal(copyScope.entries[0].ticketBound, false);
  assert.equal(copyScope.entries[0].ticketIdentity, undefined);
  assert.equal(validateStoryCreateReviewRun(reviewedRun(copyScope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "story_copy", copyFromId: "closed-2", copyFromKind: "closed" },
    title: "# CARB-12002 # 复制故事点",
    ticket: { ticketId: "carb-12002", inputProvided: false, ticketBound: false },
    now: 140,
    ttlMs: 20,
  }).ok, true);
  assert.equal(validateStoryCreateReviewRun(reviewedRun(copyScope), {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "story_copy", copyFromId: "closed-2", copyFromKind: "closed" },
    title: "# CARB-12002 # 澶嶅埗鏁呬簨鐐?",
    ticket: { tbTaskId, inputProvided: true, ticketBound: true },
    now: 140,
    ttlMs: 20,
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
});

test("单任务入口的 task 身份必须与 AI 实际读取的 TB 证据一致", () => {
  const taskA = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const taskB = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const mismatched = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "task_execute",
    ticket: { projectId: "project-a", tbTaskId: taskB, title: "任务 B" },
    storyEntry: {
      kind: "task",
      task: { id: "local-a", tbTaskId: taskA, title: "任务 A" },
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, "STORY_CREATE_SCOPE_TICKET_MISMATCH");

  const matched = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "task_execute",
    ticket: { projectId: "project-a", tbTaskId: taskA, title: "任务 A" },
    storyEntry: {
      kind: "task",
      task: { id: "local-a", tbTaskId: taskA, title: "任务 A" },
    },
  }, { ownerId: "owner-a", now: 120 });
  assert.equal(matched.ok, true);
  assert.deepEqual(matched.data.evidenceTicketIdentities, [`tb-task:${taskA}`]);
});

test("显式任意 URL 会冻结到 AI 创建复核范围，同 URL 可创建而换 URL 被拒绝", () => {
  const ticketUrl = "https://example.invalid/devbench-ticket-race";
  const issued = createStoryCreateReviewScope({
    projectId: "project-a",
    trigger: "story_initialization",
    ticket: {
      projectId: "project-a",
      title: "URL 绑定故事点",
      ticketUrl,
      inputProvided: true,
      ticketBound: true,
    },
    storyEntry: {
      kind: "story_initialization",
      createEntries: [{ kind: "blank_story", title: "URL 绑定故事点" }],
    },
  }, { ownerId: "owner-a", now: 120 });

  assert.equal(issued.ok, true);
  assert.equal(issued.data.evidenceTicketBound, true);
  assert.match(issued.data.evidenceTicketIdentities[0], /^url:[0-9a-f]{64}$/);
  assert.equal(issued.data.entries[0].ticketIdentity, issued.data.evidenceTicketIdentities[0]);

  const run = {
    ...reviewedRun(issued.data),
    ticket: { ticketUrl, inputProvided: true, ticketBound: true },
  };
  const request = {
    ownerId: "owner-a",
    projectId: "project-a",
    consumer: "tabs",
    entry: { kind: "blank_story" },
    title: "URL 绑定故事点",
    now: 140,
    ttlMs: 20,
  };
  assert.equal(validateStoryCreateReviewRun(run, {
    ...request,
    ticket: { ticketUrl, inputProvided: true, ticketBound: true },
  }).ok, true);
  assert.equal(validateStoryCreateReviewRun(run, {
    ...request,
    ticket: {
      ticketUrl: "https://example.invalid/another-ticket",
      inputProvided: true,
      ticketBound: true,
    },
  }).code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
});
