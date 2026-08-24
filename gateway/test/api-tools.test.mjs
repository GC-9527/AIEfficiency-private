import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import JSZip from "jszip";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-tools-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "api-tools-outside-"));
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway-config.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  workDir: root,
  apiMaxToolIterations: 15,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
}));

let tools;
const artifactRoot = path.join(outside, "generic-artifacts");
fs.mkdirSync(artifactRoot, { recursive: true });
const ctx = {
  cwd: root,
  allowedRoots: [artifactRoot],
  tempRoot: artifactRoot,
  workspaceIsolation: true,
  commandPolicy: "workspace",
};

before(async () => {
  tools = await import("../services/api-tools.js");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "sample.js"), "one\nconst target = 42;\nthree\nfour\n", "utf8");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("分段读取文件并返回行号", async () => {
  const result = await tools.executeTool("read_file", { path: "src/sample.js", start_line: 2, line_count: 2 }, ctx);
  assert.match(result, /lines 2-3 of 5/);
  assert.match(result, /next_start_line=4/);
  assert.match(result, /2 \| const target = 42/);
  assert.doesNotMatch(result, /1 \| one/);
});

test("read_file supports byte cursor pagination for large logs", async () => {
  fs.writeFileSync(path.join(root, "src", "byte-log.txt"), "abcdefghij", "utf8");
  const first = await tools.executeTool("read_file", { path: "src/byte-log.txt", start_byte: 2, max_bytes: 4 }, ctx);
  assert.match(first, /bytes 2-5 of 10/);
  assert.match(first, /next_start_byte=6/);
  assert.match(first, /\ncdef$/);

  const second = await tools.executeTool("read_file", { path: "src/byte-log.txt", start_byte: 6, max_bytes: 100 }, ctx);
  assert.match(second, /bytes 6-9 of 10/);
  assert.doesNotMatch(second, /next_start_byte/);
  assert.match(second, /\nghij$/);
});

test("search_files 使用 rg 返回文件和行号", async () => {
  const result = await tools.executeTool("search_files", { pattern: "target", path: "src" }, ctx);
  assert.match(result, /sample\.js:2:/);
  assert.match(result, /const target = 42/);
});

test("search_files 在 rg 不可用时自动使用内置搜索", async () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const result = await tools.executeTool("search_files", { pattern: "target", path: "src" }, ctx);
    assert.match(result, /sample\.js:2:/);
    assert.match(result, /内置搜索回退/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("旧版 15 轮默认值自动迁移为有限安全上限", async () => {
  const { getConfig } = await import("../services/config.js");
  assert.equal(getConfig().apiMaxToolIterations, 80);
});

test("路径隔离阻止读取和写入工作区外", async () => {
  const escaped = path.join(outside, "escape.txt");
  const write = await tools.executeTool("write_file", { path: escaped, content: "bad" }, ctx);
  assert.match(write, /路径越界/);
  assert.equal(fs.existsSync(escaped), false);
  const read = await tools.executeTool("read_file", { path: escaped }, ctx);
  assert.match(read, /路径越界/);
});

test("路径隔离不能通过目录链接逃逸", async (t) => {
  const link = path.join(root, "outside-link");
  try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { t.skip(`当前环境无法创建目录链接: ${error.message}`); return; }
  const result = await tools.executeTool("write_file", { path: "outside-link/linked.txt", content: "bad" }, ctx);
  assert.match(result, /路径越界/);
  assert.equal(fs.existsSync(path.join(outside, "linked.txt")), false);
});

test("apply_patch 应用 unified diff，git_status/git_diff 可验证", async () => {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "patch.txt"), "old\n", "utf8");
  const patch = [
    "diff --git a/patch.txt b/patch.txt",
    "--- a/patch.txt",
    "+++ b/patch.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const applied = await tools.executeTool("apply_patch", { patch }, ctx);
  assert.match(applied, /补丁已应用/);
  assert.equal(fs.readFileSync(path.join(root, "patch.txt"), "utf8").trim(), "new");
  assert.match(await tools.executeTool("git_status", {}, ctx), /patch\.txt/);
  // Untracked files do not appear in git diff, so stage the fixture before changing it again.
  execFileSync("git", ["add", "patch.txt"], { cwd: root });
  fs.writeFileSync(path.join(root, "patch.txt"), "newer\n", "utf8");
  assert.match(await tools.executeTool("git_diff", { file: "patch.txt" }, ctx), /\+newer/);
});

test("git_inspect 通过固定参数只读检查提交、历史文件和分支", async () => {
  const reviewRoot = path.join(root, "review-repo");
  fs.mkdirSync(reviewRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: reviewRoot, stdio: "ignore" });
  fs.writeFileSync(path.join(reviewRoot, "patch.txt"), "newer\n", "utf8");
  execFileSync("git", ["add", "patch.txt"], { cwd: reviewRoot });
  execFileSync("git", [
    "-c", "user.name=API Tools Test",
    "-c", "user.email=api-tools@example.invalid",
    "commit", "-m", "fixture",
  ], { cwd: reviewRoot, stdio: "ignore" });

  const readOnly = { ...ctx, cwd: reviewRoot, commandPolicy: "read_only" };
  assert.match(await tools.executeTool("git_inspect", { operation: "show", revision: "HEAD" }, readOnly), /fixture/);
  assert.equal((await tools.executeTool("git_inspect", {
    operation: "file_at_revision",
    revision: "HEAD",
    file: "patch.txt",
  }, readOnly)).trim(), "newer");
  assert.match(await tools.executeTool("git_inspect", {
    operation: "grep",
    revision: "HEAD",
    pattern: "newer",
  }, readOnly), /patch\.txt:1:newer/);
  assert.match(await tools.executeTool("git_inspect", { operation: "rev_parse", revision: "HEAD" }, readOnly), /^[0-9a-f]{40}\s*$/i);
  assert.match(await tools.executeTool("git_inspect", { operation: "branch_list" }, readOnly), /refs\/heads\//);

  const injected = await tools.executeTool("git_inspect", {
    operation: "show",
    revision: "--output=owned.txt",
  }, readOnly);
  assert.match(injected, /不是安全的 Git revision/);
  assert.equal(fs.existsSync(path.join(reviewRoot, "owned.txt")), false);
});

test("命令授权阻止危险命令，只读模式关闭自由 Shell 并仅暴露白名单工具", async () => {
  assert.throws(() => tools.authorizeCommand("git reset --hard HEAD", ctx), /高风险/);
  const attackRoot = path.join(root, "attack-repo");
  fs.mkdirSync(attackRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: attackRoot, stdio: "ignore" });
  const readOnly = { ...ctx, cwd: attackRoot, commandPolicy: "read_only" };
  const attacks = [
    "node build.js",
    "git status --short",
    "git status & echo pwned > owned.txt",
    "git status; echo pwned > owned.txt",
    "git status | echo pwned",
    "git status > owned.txt",
    "git branch owned",
    "git diff --output=owned.txt",
    "git show HEAD --output=owned.txt",
  ];
  for (const command of attacks) {
    assert.throws(() => tools.authorizeCommand(command, readOnly), /禁止执行自由 Shell/);
  }

  const toolNames = tools.getToolDefinitions(readOnly).map((item) => item.function.name);
  assert.equal(toolNames.includes("run_command"), false);
  assert.equal(toolNames.includes("start_process"), false);
  assert.equal(toolNames.includes("write_file"), false);
  assert.equal(toolNames.includes("git_inspect"), true);

  assert.match(
    await tools.executeTool("run_command", {
      command: "git status & echo pwned > owned.txt",
      purpose: "escape attempt",
    }, readOnly),
    /只读/,
  );
  assert.match(
    await tools.executeTool("run_bash", {
      command: "git branch owned",
      purpose: "hidden alias escape attempt",
    }, readOnly),
    /只读/,
  );
  assert.equal(fs.existsSync(path.join(attackRoot, "owned.txt")), false);
  assert.equal(execFileSync("git", ["branch", "--list", "owned"], { cwd: attackRoot, encoding: "utf8" }).trim(), "");
});

test("测试输出解析", () => {
  assert.deepEqual(tools.parseTestOutput("12 passed, 1 skipped", 0), {
    status: "passed", exitCode: 0, passed: 12, failed: 0, skipped: 1,
    buildSuccess: false, buildFailed: false, timedOut: false,
  });
  assert.equal(tools.parseTestOutput("BUILD FAILED\n2 failed", 1).status, "failed");
});

test("inspect_image/read_binary_metadata 返回哈希、MIME 和尺寸，不读取为文本", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lH9sWAAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(root, "src", "pixel.png"), png);
  const image = JSON.parse(await tools.executeTool("inspect_image", { path: "src/pixel.png" }, ctx));
  assert.equal(image.mime, "image/png");
  assert.equal(image.size, png.length);
  assert.equal(image.image.width, 1);
  assert.equal(image.image.height, 1);
  assert.equal(image.sha256.length, 64);
  const binary = JSON.parse(await tools.executeTool("read_binary_metadata", { path: "src/pixel.png" }, ctx));
  assert.equal(binary.sha256, image.sha256);
});

test("inspect_pdf 提取 PDF 元数据和有界文本", async () => {
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj",
    "4 0 obj << /Length 44 >> stream",
    "BT /F1 12 Tf 72 720 Td (Hello PDF Tool) Tj ET",
    "endstream endobj",
    "trailer << /Root 1 0 R /Title (Fixture PDF) >>",
    "%%EOF",
  ].join("\n");
  fs.writeFileSync(path.join(root, "src", "fixture.pdf"), pdf, "latin1");
  const result = JSON.parse(await tools.executeTool("inspect_pdf", { path: "src/fixture.pdf" }, ctx));
  assert.equal(result.mime, "application/pdf");
  assert.equal(result.pdf.pageCount, 1);
  assert.match(result.pdf.extractedText, /Hello PDF Tool/);
});

test("list_archive/extract_archive_entry 限定 ZIP 条目并阻止 Zip Slip", async () => {
  const zip = new JSZip();
  zip.file("dir/readme.txt", "hello zip");
  zip.file("../escape.txt", "bad");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(path.join(root, "src", "fixture.zip"), buffer);
  const listed = JSON.parse(await tools.executeTool("list_archive", { path: "src/fixture.zip" }, ctx));
  assert.equal(listed.mime, "application/zip");
  assert.ok(listed.archive.entries.some((entry) => entry.path === "dir/readme.txt"));
  assert.ok(listed.archive.entries.some((entry) => entry.unsafe));
  const extracted = JSON.parse(await tools.executeTool("extract_archive_entry", { path: "src/fixture.zip", entry_path: "dir/readme.txt" }, ctx));
  assert.equal(extracted.text, "hello zip");
  const blocked = await tools.executeTool("extract_archive_entry", { path: "src/fixture.zip", entry_path: "../escape.txt" }, ctx);
  assert.match(blocked, /unsafe archive entry path|路径越界|文件不存在/);
});

test("故事点媒体帧与压缩包提取产物只能写入外置 tempFiles", async () => {
  const storyTemp = path.join(outside, "story-temp");
  fs.mkdirSync(storyTemp, { recursive: true });
  const storyCtx = {
    ...ctx,
    allowedRoots: [storyTemp],
    tempRoot: storyTemp,
  };

  const unsafeExtract = path.join(root, "src", "must-not-extract.txt");
  const blockedExtract = await tools.executeTool("extract_archive_entry", {
    path: "src/fixture.zip",
    entry_path: "dir/readme.txt",
    output_path: unsafeExtract,
  }, storyCtx);
  assert.match(blockedExtract, /生成产物必须写入故事点外置 tempFiles/);
  assert.equal(fs.existsSync(unsafeExtract), false);

  const safeExtract = path.join(storyTemp, "archive-entries", "readme.txt");
  const extracted = JSON.parse(await tools.executeTool("extract_archive_entry", {
    path: "src/fixture.zip",
    entry_path: "dir/readme.txt",
    output_path: safeExtract,
  }, storyCtx));
  assert.equal(extracted.extracted, true);
  assert.equal(fs.readFileSync(safeExtract, "utf8"), "hello zip");

  const blockedPdf = await tools.executeTool("inspect_pdf", {
    path: "src/fixture.pdf",
    render_pages: [1],
    output_dir: path.join(root, "src", "pdf-pages"),
  }, storyCtx);
  assert.match(blockedPdf, /生成产物必须写入故事点外置 tempFiles/);
  assert.equal(fs.existsSync(path.join(root, "src", "pdf-pages")), false);

  fs.writeFileSync(path.join(root, "src", "artifact-boundary.mp4"), Buffer.from("not a real mp4"));
  const blockedVideo = await tools.executeTool("inspect_video", {
    path: "src/artifact-boundary.mp4",
    timestamps: [0],
    output_dir: path.join(root, "src", "video-frames"),
  }, storyCtx);
  assert.match(blockedVideo, /生成产物必须写入故事点外置 tempFiles/);
  assert.equal(fs.existsSync(path.join(root, "src", "video-frames")), false);
});

test("生成产物缺少外置 tempFiles 时拒绝回退到源码 docs/tempFiles", async () => {
  const noArtifactCtx = { ...ctx, allowedRoots: [], tempRoot: "" };
  const sourceOutput = path.join(root, "docs", "tempFiles", "readme.txt");
  const result = await tools.executeTool("extract_archive_entry", {
    path: "src/fixture.zip",
    entry_path: "dir/readme.txt",
    output_path: sourceOutput,
  }, noArtifactCtx);
  assert.match(result, /缺少外置 tempFiles/);
  assert.equal(fs.existsSync(sourceOutput), false);
});

test("media and archive generated outputs reject precreated symlink or junction targets without outside writes", async (t) => {
  const storyTemp = path.join(outside, "plain-generated-artifacts");
  fs.mkdirSync(storyTemp, { recursive: true });
  const storyCtx = {
    ...ctx,
    allowedRoots: [storyTemp],
    tempRoot: storyTemp,
  };
  const createDirectoryLink = (target, link) => {
    fs.mkdirSync(target, { recursive: true });
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      return true;
    } catch (error) {
      t.skip(`current environment cannot create a directory link: ${error.message}`);
      return false;
    }
  };

  const videoFile = path.join(root, "src", "linked-output.mp4");
  fs.writeFileSync(videoFile, Buffer.from("not a real mp4"));

  const linkedOutputTarget = path.join(outside, "linked-output-target");
  const linkedOutputDir = path.join(storyTemp, "linked-output-dir");
  if (!createDirectoryLink(linkedOutputTarget, linkedOutputDir)) return;
  const linkedOutputResult = await tools.executeTool("inspect_video", {
    path: "src/linked-output.mp4",
    timestamps: [0],
    output_dir: linkedOutputDir,
  }, storyCtx);
  assert.equal(String(linkedOutputResult).startsWith("{"), false);
  assert.deepEqual(fs.readdirSync(linkedOutputTarget), []);

  const videoDir = path.join(storyTemp, "video-frames");
  const videoLeafTarget = path.join(outside, "video-leaf-target");
  fs.mkdirSync(videoDir, { recursive: true });
  if (!createDirectoryLink(videoLeafTarget, path.join(videoDir, "frame_00000000.png"))) return;
  const videoResult = JSON.parse(await tools.executeTool("inspect_video", {
    path: "src/linked-output.mp4",
    timestamps: [0],
    output_dir: videoDir,
  }, storyCtx));
  assert.equal(videoResult.frames[0].ok, false);
  assert.match(videoResult.frames[0].error, /already exists|plain file|symlink|junction/i);
  assert.deepEqual(fs.readdirSync(videoLeafTarget), []);

  const pdfFile = path.join(root, "src", "linked-output.pdf");
  fs.writeFileSync(pdfFile, [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n"), "latin1");
  const pdfDir = path.join(storyTemp, "pdf-pages");
  const pdfLeafTarget = path.join(outside, "pdf-leaf-target");
  fs.mkdirSync(pdfDir, { recursive: true });
  if (!createDirectoryLink(pdfLeafTarget, path.join(pdfDir, "page_0001.png"))) return;
  const pdfResult = JSON.parse(await tools.executeTool("inspect_pdf", {
    path: "src/linked-output.pdf",
    render_pages: [1],
    output_dir: pdfDir,
  }, storyCtx));
  assert.equal(pdfResult.renderedPages[0].ok, false);
  assert.match(pdfResult.renderedPages[0].error, /already exists|plain file|symlink|junction/i);
  assert.deepEqual(fs.readdirSync(pdfLeafTarget), []);

  const zip = new JSZip();
  zip.file("dir/readme.txt", "never outside");
  const zipFile = path.join(root, "src", "linked-output.zip");
  fs.writeFileSync(zipFile, await zip.generateAsync({ type: "nodebuffer" }));
  const archiveDir = path.join(storyTemp, "archive-entries");
  const archiveLeafTarget = path.join(outside, "archive-leaf-target");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archiveLeaf = path.join(archiveDir, "readme.txt");
  if (!createDirectoryLink(archiveLeafTarget, archiveLeaf)) return;
  const archiveResult = await tools.executeTool("extract_archive_entry", {
    path: "src/linked-output.zip",
    entry_path: "dir/readme.txt",
    output_path: archiveLeaf,
  }, storyCtx);
  assert.match(archiveResult, /already exists|plain file|symlink|junction|路径越界/i);
  assert.deepEqual(fs.readdirSync(archiveLeafTarget), []);
});

test("inspect_video 返回视频元数据并明确 ffprobe 状态", async () => {
  fs.writeFileSync(path.join(root, "src", "sample.mp4"), Buffer.from("not a real mp4"));
  const result = JSON.parse(await tools.executeTool("inspect_video", { path: "src/sample.mp4" }, ctx));
  assert.equal(result.metadata.mime, "video/mp4");
  assert.equal(typeof result.ffprobe.ok, "boolean");
});

test("inspect_video accepts large video metadata without hashing whole file", async () => {
  const file = path.join(root, "src", "large.mp4");
  fs.writeFileSync(file, "");
  fs.truncateSync(file, 51 * 1024 * 1024);
  const result = JSON.parse(await tools.executeTool("inspect_video", { path: "src/large.mp4" }, ctx));
  assert.equal(result.metadata.mime, "video/mp4");
  assert.equal(result.metadata.sha256, null);
  assert.equal(result.metadata.hashTruncated, true);
  assert.equal(typeof result.ffprobe.ok, "boolean");
});

test("长进程可启动、轮询续接并获得终态", async () => {
  const started = JSON.parse(await tools.executeTool("start_process", {
    command: "node -e \"setTimeout(() => console.log('long-done'), 80)\"",
    purpose: "测试长进程续接",
    max_minutes: 1,
  }, ctx));
  assert.equal(started.status, "running");
  let polled;
  let combinedOutput = "";
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    polled = JSON.parse(await tools.executeTool("poll_process", { process_id: started.process_id }, ctx));
    if (polled.output !== "(暂无新输出)") combinedOutput += polled.output;
    if (!polled.running) break;
  }
  assert.equal(polled.status, "completed");
  assert.match(combinedOutput, /long-done/);
});

test("poll_process supports absolute cursor pagination", async () => {
  const started = JSON.parse(await tools.executeTool("start_process", {
    command: "node -e \"process.stdout.write('abcdefg')\"",
    purpose: "cursor pagination test",
    max_minutes: 1,
  }, ctx));
  assert.equal(started.status, "running");
  let polled;
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    polled = JSON.parse(await tools.executeTool("poll_process", { process_id: started.process_id }, ctx));
    if (!polled.running) break;
  }
  assert.equal(polled.status, "completed");

  const first = JSON.parse(await tools.executeTool("poll_process", { process_id: started.process_id, cursor: 0, max_chars: 4 }, ctx));
  assert.equal(first.output, "abcd");
  assert.equal(first.cursor, 0);
  assert.equal(first.nextCursor, 4);
  assert.equal(first.truncated, true);

  const second = JSON.parse(await tools.executeTool("poll_process", { process_id: started.process_id, cursor: first.nextCursor, max_chars: 20 }, ctx));
  assert.equal(second.output, "efg");
  assert.equal(second.cursor, 4);
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, second.totalOutputChars);
});

test("poll_process restores completed process output from temp snapshot", async () => {
  const started = JSON.parse(await tools.executeTool("start_process", {
    command: "node -e \"console.log('persisted-done')\"",
    purpose: "process snapshot recovery test",
    max_minutes: 1,
  }, ctx));
  let polled;
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    polled = JSON.parse(await tools.executeTool("poll_process", { process_id: started.process_id }, ctx));
    if (!polled.running) break;
  }
  assert.equal(polled.status, "completed");
  tools.clearToolProcessesForTest();

  const restored = JSON.parse(await tools.executeTool("poll_process", { process_id: started.process_id, cursor: 0 }, ctx));
  assert.equal(restored.status, "completed");
  assert.equal(restored.restored, true);
  assert.match(restored.output, /persisted-done/);
});

test("任务取消信号会停止长进程", async () => {
  const controller = new AbortController();
  const cancellableCtx = { ...ctx, signal: controller.signal };
  const started = JSON.parse(await tools.executeTool("start_process", {
    command: "node -e \"setInterval(() => {}, 1000)\"",
    purpose: "验证停止按钮",
    max_minutes: 1,
  }, cancellableCtx));
  controller.abort();
  let polled;
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    polled = JSON.parse(await tools.executeTool("poll_process", { process_id: started.process_id }, ctx));
    if (!polled.running && polled.exit_code != null) break;
  }
  assert.equal(polled.status, "stopped");
  assert.notEqual(polled.exit_code, null);
});

test("短命令终止后未收到 close 事件时有限收敛并转为终止错误", async () => {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let terminateCalls = 0;
  const safetyTimer = setTimeout(() => child.emit("close", -1), 500);

  try {
    const startedAt = Date.now();
    const result = await tools.__testRunShell("ignored", root, 10, null, {
      spawnProcess: () => child,
      terminateProcess: () => { terminateCalls++; },
      terminationGraceMs: 20,
    });

    assert.ok(Date.now() - startedAt < 250, "收尾不得继续依赖永远不来的 close 事件");
    assert.equal(terminateCalls, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationUnconfirmed, true);
    assert.throws(
      () => tools.__testAssertShellTerminationConverged(result, "run_command"),
      (error) => {
        assert.equal(error?.code, "API_TOOL_TERMINATION_UNCONFIRMED");
        assert.equal(error?.terminalFailure, true);
        assert.match(error?.message || "", /本轮已终止/);
        return true;
      },
    );
  } finally {
    clearTimeout(safetyTimer);
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test("短命令超时后正常收到 close 时保留原有超时结果", async () => {
  const child = new EventEmitter();
  child.pid = 424243;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let terminateCalls = 0;

  try {
    const resultPromise = tools.__testRunShell("ignored", root, 10, null, {
      spawnProcess: () => child,
      terminateProcess: () => {
        terminateCalls++;
        setTimeout(() => child.emit("close", -1), 5);
      },
      terminationGraceMs: 100,
    });
    const result = await resultPromise;

    assert.equal(terminateCalls, 1);
    assert.equal(result.exitCode, -1);
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    assert.equal(result.terminationUnconfirmed, undefined);
    assert.equal(tools.__testAssertShellTerminationConverged(result, "run_tests"), result);
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test("短命令取消后未收到 close 事件时提示取消并有限收敛", async () => {
  const child = new EventEmitter();
  child.pid = 424244;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const controller = new AbortController();
  let terminateCalls = 0;

  try {
    const resultPromise = tools.__testRunShell("ignored", root, 60_000, controller.signal, {
      spawnProcess: () => child,
      terminateProcess: () => { terminateCalls++; },
      terminationGraceMs: 20,
    });
    controller.abort();
    const result = await resultPromise;

    assert.equal(terminateCalls, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, true);
    assert.equal(result.terminationUnconfirmed, true);
    assert.throws(
      () => tools.__testAssertShellTerminationConverged(result, "run_command"),
      (error) => {
        assert.equal(error?.code, "API_TOOL_TERMINATION_UNCONFIRMED");
        assert.match(error?.message || "", /取消后未确认进程树退出/);
        return true;
      },
    );
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
