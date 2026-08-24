import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 源码契约：Git 提交整理的冲突处理中心必须在 devbench.js 中实现
// 检查关键函数与路由是否存在，防止重构时丢失冲突处理能力

const source = fs.readFileSync(
  new URL("../routes/devbench.js", import.meta.url),
  "utf8",
);

test("冲突处理中心：analyzeSquashConflicts 函数存在", () => {
  assert.match(source, /async function analyzeSquashConflicts\(/, "必须有 analyzeSquashConflicts 函数");
});

test("冲突处理中心：completeReworkWorkflow 函数存在（主流程与恢复路径共用）", () => {
  assert.match(source, /async function completeReworkWorkflow\(/, "必须有 completeReworkWorkflow 函数");
  assert.match(source, /return completeReworkWorkflow\(/, "reworkBranchWorkflow 必须调用 completeReworkWorkflow");
});

test("冲突处理中心：resumeReworkWorkflow 函数存在（冲突解决后恢复流程）", () => {
  assert.match(source, /async function resumeReworkWorkflow\(/, "必须有 resumeReworkWorkflow 函数");
});

test("冲突处理中心：abortReworkWorktree 函数存在（放弃重整）", () => {
  assert.match(source, /async function abortReworkWorktree\(/, "必须有 abortReworkWorktree 函数");
});

test("冲突处理中心：上下文持久化函数存在", () => {
  assert.match(source, /function writeReworkContext\(/, "必须有 writeReworkContext");
  assert.match(source, /function readReworkContext\(/, "必须有 readReworkContext");
  assert.match(source, /function deleteReworkContext\(/, "必须有 deleteReworkContext");
});

test("冲突处理中心：squash 冲突返回 CONFLICT needDecision（而非硬报错）", () => {
  assert.match(
    source,
    /code:\s*"CONFLICT"[\s\S]{0,200}needDecision:[\s\S]{0,200}type:\s*"conflict"/,
    "squash 冲突时必须返回 code=CONFLICT + needDecision.type=conflict",
  );
  // 确保不再用旧方式直接返回硬错误（禁止自动选择 ours/theirs 的旧提示应已被替换）
  assert.doesNotMatch(
    source,
    /禁止自动选择 ours\/theirs，请人工解决/,
    "旧的硬报错提示应已替换为冲突处理中心决策卡片",
  );
});

test("冲突处理中心：resume / abort 路由存在", () => {
  assert.match(source, /\/tabs\/:id\/git\/commit-reorganize\/resume/, "必须有 resume 路由");
  assert.match(source, /\/tabs\/:id\/git\/commit-reorganize\/abort/, "必须有 abort 路由");
});

test("冲突处理中心：completeReworkWorkflow 的 merge 检查仍用增量范围", () => {
  // 确保重构后 completeReworkWorkflow 中的 merge commit 检查仍限定 targetSha..HEAD
  assert.match(
    source,
    /rev-list[\s\S]{0,200}--merges[\s\S]{0,200}\$\{targetSha\}\.\.HEAD/,
    "completeReworkWorkflow 中的 merge 检查必须用 `${targetSha}..HEAD` 增量范围",
  );
});

test("临时 worktree 落点：必须放在「已配置的 worktree 父目录」下，不再用 os.tmpdir()", () => {
  // reworkWorktreeBase 用 store.ensureCloneParentReady() + WORKTREE_SPACE_DIRNAME 拼目录
  assert.match(
    source,
    /function reworkWorktreeBase\(\)/,
    "必须有 reworkWorktreeBase 函数",
  );
  // 函数体里必须用 ensureCloneParentReady 拿 cloneParent，再与 WORKTREE_SPACE_DIRNAME 拼接
  const reworkBaseBody = source.slice(
    source.indexOf("function reworkWorktreeBase()"),
    source.indexOf("function reworkWorktreeBase()") + 1200,
  );
  assert.match(
    reworkBaseBody,
    /ensureCloneParentReady/,
    "reworkWorktreeBase 必须用 store.ensureCloneParentReady() 拿克隆父路径",
  );
  assert.match(
    reworkBaseBody,
    /WORKTREE_SPACE_DIRNAME/,
    "reworkWorktreeBase 必须拼上 WORKTREE_SPACE_DIRNAME（= WorktreeSpace）",
  );
  // 构造函数存在，按 tabId+repoPath 派生
  assert.match(
    source,
    /function newReworkWorktreePath\(/,
    "必须有 newReworkWorktreePath 派生函数",
  );
  const newReworkBody = source.slice(
    source.indexOf("function newReworkWorktreePath("),
    source.indexOf("function newReworkWorktreePath(") + 1500,
  );
  assert.match(
    newReworkBody,
    /tabId/,
    "newReworkWorktreePath 必须接收 tabId",
  );
  assert.match(
    newReworkBody,
    /repoPath/,
    "newReworkWorktreePath 必须接收 repoPath 并校验不与工程路径重叠",
  );
  // 显式禁止：主流程里不能再用 os.tmpdir() 直接拼 aieff-rework 路径（只允许 LEGACY 兼容读取/删除）
  const reworkFlow = source.slice(
    source.indexOf("async function reworkBranchWorkflow"),
    source.indexOf("async function reworkBranchWorkflow") + 8000,
  );
  assert.doesNotMatch(
    reworkFlow,
    /path\.join\(os\.tmpdir\(\),\s*[`"]aieff-rework-/,
    "reworkBranchWorkflow 主流程里不能再用 os.tmpdir() 拼 aieff-rework 路径",
  );
});

test("临时 worktree 落点：resume/abort 必须校验 tmpDir 在受控 worktree 父目录内", () => {
  assert.match(
    source,
    /function resolveReworkWorktreePath\(/,
    "必须有 resolveReworkWorktreePath 守护函数",
  );
  // resumeReworkWorkflow 入口必须先 resolve 再用
  assert.match(
    source,
    /async function resumeReworkWorkflow\([\s\S]{0,400}resolveReworkWorktreePath\(tmpDir\)[\s\S]{0,400}tmpDir\s*=\s*safeTmpDir/,
    "resumeReworkWorkflow 必须用 resolveReworkWorktreePath 校验 tmpDir 后再赋值",
  );
  // abortReworkWorktree 同上
  assert.match(
    source,
    /async function abortReworkWorktree\([\s\S]{0,400}resolveReworkWorktreePath\(tmpDir\)[\s\S]{0,400}tmpDir\s*=\s*safeTmpDir/,
    "abortReworkWorktree 必须用 resolveReworkWorktreePath 校验 tmpDir 后再赋值",
  );
  // 升级前旧路径仍要兼容（容错读取/清理）
  assert.match(
    source,
    /LEGACY_REWORK_WORKTREE_PREFIX/,
    "升级前遗留在 os.tmpdir() 下的 aieff-rework-* 必须仍可读 ctx（避免打断正在处理冲突的用户）",
  );
});

test("上下文文件：必须与临时 worktree 同级落盘（不再放 os.tmpdir()）", () => {
  // reworkContextFile 必须以 <dirname(tmpDir)>/<basename>.ctx.json 形式拼路径
  assert.match(
    source,
    /function reworkContextFile\(/,
    "必须有 reworkContextFile 函数",
  );
  const ctxFileBody = source.slice(
    source.indexOf("function reworkContextFile("),
    source.indexOf("function reworkContextFile(") + 1500,
  );
  assert.match(
    ctxFileBody,
    /path\.dirname/,
    "reworkContextFile 必须用 path.dirname 取 worktree 父目录",
  );
  assert.match(
    ctxFileBody,
    /path\.basename/,
    "reworkContextFile 必须用 path.basename 取 worktree 名",
  );
  assert.match(
    ctxFileBody,
    /\.ctx\.json/,
    "reworkContextFile 必须以 .ctx.json 结尾（同 worktree 同级）",
  );
  // 必须存在 legacy 兼容路径
  assert.match(
    source,
    /function legacyReworkContextFile\(/,
    "升级前遗留在 os.tmpdir() 下的 ctx 必须有 legacyReworkContextFile 兼容读取",
  );
  // readReworkContext 必须尝试 legacy 路径
  assert.match(
    source,
    /function readReworkContext\([\s\S]{0,500}legacyReworkContextFile\(tmpDir\)/,
    "readReworkContext 必须尝试 legacy 路径（os.tmpdir() 里的旧 ctx）以兼容升级前的会话",
  );
  // deleteReworkContext 同理
  assert.match(
    source,
    /function deleteReworkContext\([\s\S]{0,500}legacyReworkContextFile\(tmpDir\)/,
    "deleteReworkContext 必须同时清理 legacy 路径下的旧 ctx",
  );
});
