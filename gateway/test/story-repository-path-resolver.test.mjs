import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRepositoryPath,
  resolveStoryRepositoryPaths,
} from "../services/devbench/story-repository-path-resolver.js";

function story(entries, id = "story-current") {
  return { id, worktreeStatus: "ready", worktree: { managed: true, entries } };
}

function entry(overrides = {}) {
  return {
    role: "primary",
    active: true,
    name: "AppMarket",
    repositoryId: "appmarket",
    baseProjectId: "local-appmarket",
    basePath: "D:\\workspace\\AppMarket",
    baseRepositoryPath: "D:\\workspace\\AppMarket",
    path: "D:\\workspace\\WorktreeSpace\\story-appmarket",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-appmarket",
    gitCommonDir: "D:\\workspace\\AppMarket\\.git",
    branch: "story/CARB-100",
    ...overrides,
  };
}

const alwaysExists = () => true;
const pathKeyForTest = (value) => normalizeRepositoryPath(value).toLowerCase();

test("maps an exact Windows base root and preserves visible original text", () => {
  const content = "请检查 D:\\workspace\\AppMarket";
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content,
    projects: [{ id: "local-appmarket", name: "AppMarket", path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.originalContent, content);
  assert.equal(result.mappedContent, "请检查 D:\\workspace\\WorktreeSpace\\story-appmarket");
  assert.equal(result.mappings[0].branch, "story/CARB-100");
  assert.match(result.mappingContext, /基础仓库路径确定性映射/);
});

test("reports a direct safe worktree reference for precise persistent-alert clearing", () => {
  const currentEntry = entry();
  const result = resolveStoryRepositoryPaths({
    tab: story([currentEntry]),
    content: `继续处理 ${currentEntry.worktreePath}`,
    projects: [{ id: currentEntry.baseProjectId, path: currentEntry.basePath }],
    pathExists: alwaysExists,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mappings, []);
  assert.deepEqual(result.resolvedRepositoryPaths, [normalizeRepositoryPath(currentEntry.worktreePath)]);
});

test("maps a nested file with case-insensitive and slash-flexible Windows matching", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "修改 d:/WORKSPACE/appmarket/src/main/A.kt",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, "修改 D:\\workspace\\WorktreeSpace\\story-appmarket\\src\\main\\A.kt");
});

test("maps quoted Windows paths containing spaces", () => {
  const spaced = entry({
    basePath: "D:\\workspace\\Base Repositories\\App Market",
    baseRepositoryPath: "D:\\workspace\\Base Repositories\\App Market",
    path: "D:\\workspace\\Worktree Space\\story-app-market",
    worktreePath: "D:\\workspace\\Worktree Space\\story-app-market",
  });
  const result = resolveStoryRepositoryPaths({
    tab: story([spaced]),
    content: "请打开 `D:/workspace/Base Repositories/App Market/src/Main.kt`",
    projects: [{ path: spaced.basePath }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, "请打开 `D:\\workspace\\Worktree Space\\story-app-market\\src\\Main.kt`");
});

test("maps UNC repository paths without losing the share prefix", () => {
  const unc = entry({
    basePath: "\\\\build-server\\source share\\AppMarket",
    baseRepositoryPath: "\\\\build-server\\source share\\AppMarket",
    path: "\\\\build-server\\story worktrees\\CARB-100\\AppMarket",
    worktreePath: "\\\\build-server\\story worktrees\\CARB-100\\AppMarket",
  });
  const result = resolveStoryRepositoryPaths({
    tab: story([unc]),
    content: "检查 \\\\BUILD-SERVER\\source share\\AppMarket\\README.md",
    projects: [{ path: unc.basePath }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, "检查 \\\\build-server\\story worktrees\\CARB-100\\AppMarket\\README.md");
});

test("rejects unknown UNC paths without probing the attacker-controlled network share", () => {
  const probes = [];
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "读取 \\\\attacker-host\\share\\secret.txt",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: (candidate) => { probes.push(String(candidate)); return true; },
    realPath: (candidate) => { probes.push(String(candidate)); return candidate; },
  });

  assert.equal(result.ok, false);
  assert.match(result.failures[0].reason, /系统未访问该网络路径/);
  assert.equal(probes.some((candidate) => /attacker-host/i.test(candidate)), false);
});

test("maps Windows extended drive and UNC namespace aliases to normal worktree paths", () => {
  const drive = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "检查 \\\\?\\D:\\workspace\\AppMarket\\README.md",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(drive.ok, true);
  assert.equal(drive.mappedContent, "检查 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md");

  const uncEntry = entry({
    basePath: "\\\\build-server\\source share\\AppMarket",
    baseRepositoryPath: "\\\\build-server\\source share\\AppMarket",
    path: "\\\\build-server\\story worktrees\\CARB-100\\AppMarket",
    worktreePath: "\\\\build-server\\story worktrees\\CARB-100\\AppMarket",
  });
  const unc = resolveStoryRepositoryPaths({
    tab: story([uncEntry]),
    content: "检查 \\\\?\\UNC\\build-server\\source share\\AppMarket\\README.md",
    projects: [{ path: uncEntry.basePath }],
    pathExists: alwaysExists,
  });
  assert.equal(unc.ok, true);
  assert.equal(unc.mappedContent, "检查 \\\\build-server\\story worktrees\\CARB-100\\AppMarket\\README.md");
});

test("maps single-root Windows paths using the current story worktree drive", () => {
  for (const referencedPath of ["\\workspace\\AppMarket\\README.md", "/workspace/AppMarket/README.md"]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content: `读取 ${referencedPath}`,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, true, referencedPath);
    assert.equal(result.mappedContent, "读取 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md");
  }
});

test("maps single-root Windows paths within the current UNC share", () => {
  const uncEntry = entry({
    basePath: "\\\\server\\share\\source\\AppMarket",
    baseRepositoryPath: "\\\\server\\share\\source\\AppMarket",
    path: "\\\\server\\share\\worktrees\\story\\AppMarket",
    worktreePath: "\\\\server\\share\\worktrees\\story\\AppMarket",
  });
  for (const referencedPath of ["\\source\\AppMarket\\README.md", "/source/AppMarket/README.md"]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([uncEntry]),
      content: `读取 ${referencedPath}`,
      projects: [{ path: uncEntry.basePath }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, true, referencedPath);
    assert.equal(result.mappedContent, "读取 \\\\server\\share\\worktrees\\story\\AppMarket\\README.md");
  }
});

test("fails closed for drive-relative paths whose meaning depends on process state", () => {
  for (const referencedPath of ["D:..\\..\\AppMarket\\README.md", "D:AppMarket\\README.md"]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content: `读取 ${referencedPath}`,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false, referencedPath);
    assert.equal(result.failures[0].kind, "unsafe-path");
    assert.match(result.failures[0].reason, /驱动器相对路径/);
  }
});

test("fails closed when relative traversal from the agent cwd escapes all story worktrees", () => {
  for (const referencedPath of [
    "..\\..\\AppMarket\\secret.txt",
    "../../AppMarket/secret.txt",
    "..\\../AppMarket\\secret.txt",
  ]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content: `读取 \`${referencedPath}\``,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false, referencedPath);
    assert.equal(result.failures[0].kind, "unsafe-path");
    assert.match(result.failures[0].reason, /相对路径包含 \.\./);
  }

  const safe = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "读取 src\\feature\\..\\Main.kt",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(safe.ok, true);
});

test("fails closed for a single traversal segment after natural-language delimiters", () => {
  const siblingEntry = entry({
    basePath: "D:\\workspace\\Base",
    baseRepositoryPath: "D:\\workspace\\Base",
    path: "D:\\workspace\\story",
    worktreePath: "D:\\workspace\\story",
  });
  for (const content of [
    "请处理 ..\\Base\\secret.txt",
    "请处理\n..\\Base\\secret.txt",
    "请处理 '..\\Base\\secret.txt'",
    "请处理（..\\Base\\secret.txt）",
  ]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([siblingEntry]),
      content,
      projects: [{ path: siblingEntry.basePath }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false, content);
    assert.equal(result.failures[0].kind, "unsafe-path");
    assert.match(result.failures[0].reason, /相对路径包含 \.\./);
  }
});

test("fails closed when a single traversal segment targets a sibling story worktree", () => {
  const currentEntry = entry({
    path: "D:\\workspace\\WorktreeSpace\\story-a",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-a",
    branch: "story/a",
  });
  const otherEntry = entry({
    path: "D:\\workspace\\WorktreeSpace\\story-b",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-b",
    branch: "story/b",
  });
  const current = story([currentEntry], "story-a");
  const other = story([otherEntry], "story-b");
  for (const content of [
    "请读取 ..\\story-b\\secret.txt",
    "请读取\n..\\story-b\\secret.txt",
    "请读取 `..\\story-b\\secret.txt`",
  ]) {
    const result = resolveStoryRepositoryPaths({
      tab: current,
      content,
      projects: [{ path: currentEntry.basePath }],
      allTabs: [current, other],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false, content);
    assert.equal(result.failures[0].kind, "unsafe-path");
    assert.match(result.failures[0].reason, /相对路径包含 \.\./);
  }
});

test("fails closed when shell expansion can turn traversal into another story checkout", () => {
  const current = story([entry()]);
  const other = story([entry({
    path: "D:\\workspace\\WorktreeSpace\\story-other",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-other",
    branch: "story/other",
  })], "story-other");
  for (const content of [
    "读取 $PWD\\..\\story-other\\secret.txt",
    "cmd /c type %CD%\\..\\story-other\\secret.txt",
    "读取 ${PWD}\\..\\story-other\\secret.txt",
  ]) {
    const result = resolveStoryRepositoryPaths({
      tab: current,
      content,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      allTabs: [current, other],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false, content);
    assert.equal(result.failures[0].kind, "unsafe-path");
    assert.match(result.failures[0].reason, /shell 或环境变量展开/);
  }
});

test("fails closed when a mapped suffix traverses outside the story worktree", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "读取 D:\\workspace\\AppMarket\\..\\..\\AppMarket\\README.md",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_BASE_WORKTREE_MISSING");
  assert.equal(result.failures[0].kind, "unsafe-path");
  assert.match(result.repositoryPathAlert.title, /越出当前故事点 worktree/);
});

test("fails closed when punctuation or spaces inside an unquoted filename precede traversal", () => {
  for (const punctuation of [",", "，", ")", "]", " name"]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content: `读取 D:\\workspace\\AppMarket\\safe${punctuation}\\..\\..\\..\\AppMarket\\README.md`,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false, punctuation);
    assert.equal(result.failures[0].kind, "unsafe-path");
  }
});

test("checks the complete unquoted path when a spaced junction escapes the story worktree", () => {
  const currentEntry = entry();
  const spacedLink = `${currentEntry.worktreePath}\\link name`;
  const probes = [];
  const result = resolveStoryRepositoryPaths({
    tab: story([currentEntry]),
    content: `读取 ${currentEntry.basePath}\\link name\\secret.txt`,
    projects: [{ path: currentEntry.basePath }],
    pathExists: alwaysExists,
    realPath: (candidate) => {
      const normalized = normalizeRepositoryPath(candidate);
      probes.push(normalized);
      if (pathKeyForTest(normalized).startsWith(pathKeyForTest(spacedLink))) {
        return `${currentEntry.basePath}${normalized.slice(normalizeRepositoryPath(spacedLink).length)}`;
      }
      return candidate;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "unsafe-path");
  assert.ok(probes.some((candidate) => candidate.includes("link name/secret.txt")));
});

test("checks an unquoted spaced junction directory even without a child separator", () => {
  const currentEntry = entry();
  const spacedLink = `${currentEntry.worktreePath}\\link name`;
  const probes = [];
  const result = resolveStoryRepositoryPaths({
    tab: story([currentEntry]),
    content: `读取 ${currentEntry.basePath}\\link name`,
    projects: [{ path: currentEntry.basePath }],
    pathExists: alwaysExists,
    realPath: (candidate) => {
      const normalized = normalizeRepositoryPath(candidate);
      probes.push(normalized);
      return pathKeyForTest(normalized) === pathKeyForTest(spacedLink)
        ? currentEntry.basePath
        : candidate;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "unsafe-path");
  assert.ok(probes.some((candidate) => candidate.endsWith("/link name")));
});

test("canonicalizes safe dot segments while keeping the provider inside the story worktree", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "读取 `D:\\workspace\\AppMarket\\src\\feature\\..\\Main.kt`",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, "读取 `D:\\workspace\\WorktreeSpace\\story-appmarket\\src\\Main.kt`");
});

test("maps equivalent base paths whose dot segments appear before the registered root", () => {
  for (const content of [
    "读取 D:\\workspace\\.\\AppMarket\\README.md",
    "读取 D:\\workspace\\placeholder\\..\\AppMarket\\README.md",
  ]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, true, content);
    assert.equal(result.mappedContent, "读取 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md");
    assert.equal(result.mappings.length, 1);
  }
});

test("uses the longest monorepo sub-project mapping", () => {
  const root = entry({ name: "Root" });
  const web = entry({
    role: "webapp",
    name: "WebApp",
    basePath: "D:\\workspace\\AppMarket\\WebApp",
    path: "D:\\workspace\\WorktreeSpace\\story-appmarket\\WebApp",
  });
  const result = resolveStoryRepositoryPaths({
    tab: story([root, web]),
    content: "打开 D:\\workspace\\AppMarket\\WebApp\\src\\index.jsx",
    projects: [{ path: "D:\\workspace\\AppMarket", webAppPath: "D:\\workspace\\AppMarket\\WebApp" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, "打开 D:\\workspace\\WorktreeSpace\\story-appmarket\\WebApp\\src\\index.jsx");
  assert.equal(result.mappings[0].role, "webapp");
});

test("does not match a repository-name prefix collision", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "请检查 D:\\workspace\\AppMarket-old\\README.md",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, "请检查 D:\\workspace\\AppMarket-old\\README.md");
  assert.equal(result.mappings.length, 0);
});

test("maps a Win32 trailing-dot alias instead of leaking the base repository", () => {
  for (const [content, expected] of [
    ["请检查 D:\\workspace\\AppMarket.", "请检查 D:\\workspace\\WorktreeSpace\\story-appmarket"],
    ["请检查 D:\\workspace\\AppMarket.\\README.md", "请检查 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md"],
  ]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mappedContent, expected);
    assert.equal(result.mappings.length, 1);
  }
});

test("blocks a registered base repository without a current story worktree", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "去 D:\\workspace\\SdkFactory 修改接口",
    projects: [
      { name: "AppMarket", path: "D:\\workspace\\AppMarket" },
      { name: "SdkFactory", path: "D:\\workspace\\SdkFactory" },
    ],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_BASE_WORKTREE_MISSING");
  assert.match(result.error, /AI 未启动、未注入、未排队/);
  assert.deepEqual(result.repositoryPathAlert.paths, ["D:/workspace/SdkFactory"]);
});

test("keeps a previously blocked base path protected even if registry data later disappears", () => {
  const tab = {
    ...story([entry()]),
    repositoryPathAlert: { paths: ["D:\\workspace\\SdkFactory"] },
  };
  const result = resolveStoryRepositoryPaths({
    tab,
    content: "继续修改 D:\\workspace\\SdkFactory\\README.md",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_BASE_WORKTREE_MISSING");
});

test("repaired unsafe/shared worktree alerts do not poison a now healthy checkout as a protected base", () => {
  for (const kind of ["unsafe-worktree", "shared-worktree"]) {
    const currentEntry = entry();
    const tab = {
      ...story([currentEntry]),
      repositoryPathAlert: {
        paths: [currentEntry.worktreePath],
        repositories: [{ kind, path: currentEntry.worktreePath }],
      },
    };
    const result = resolveStoryRepositoryPaths({
      tab,
      content: "继续处理刚才的问题",
      projects: [{ path: currentEntry.basePath }],
      allTabs: [tab],
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, true, kind);
    assert.equal(result.worktreeOwnershipVerified, true);
  }
});

test("an escaped current-worktree reference does not poison later path-free messages or other tabs", () => {
  const currentEntry = entry();
  const initialTab = story([currentEntry]);
  const first = resolveStoryRepositoryPaths({
    tab: initialTab,
    content: `读取 ${currentEntry.worktreePath}\\..\\..\\outside.txt`,
    projects: [{ path: currentEntry.basePath }],
    allTabs: [initialTab],
    pathExists: alwaysExists,
  });
  assert.equal(first.ok, false);
  assert.equal(first.failures[0].kind, "unsafe-path");
  assert.equal(first.failures[0].path, normalizeRepositoryPath(currentEntry.worktreePath));
  assert.equal(first.failures[0].basePath, normalizeRepositoryPath(currentEntry.basePath));

  const persistedTab = { ...initialTab, repositoryPathAlert: first.repositoryPathAlert };
  const next = resolveStoryRepositoryPaths({
    tab: persistedTab,
    content: "继续",
    projects: [{ path: currentEntry.basePath }],
    allTabs: [persistedTab],
    pathExists: alwaysExists,
  });
  assert.equal(next.ok, true);
  assert.equal(next.worktreeOwnershipVerified, true);

  const otherAlertOwner = {
    id: "story-alert-owner",
    worktree: { managed: false, entries: [] },
    repositoryPathAlert: first.repositoryPathAlert,
  };
  const unaffected = resolveStoryRepositoryPaths({
    tab: initialTab,
    content: "继续",
    projects: [{ path: currentEntry.basePath }],
    allTabs: [initialTab, otherAlertOwner],
    pathExists: alwaysExists,
  });
  assert.equal(unaffected.ok, true);
  assert.equal(unaffected.worktreeOwnershipVerified, true);
});

test("blocks ambiguous active mappings instead of guessing by branch", () => {
  const second = entry({
    role: "extra",
    path: "D:\\workspace\\WorktreeSpace\\story-appmarket-second",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-appmarket-second",
    branch: "story/other",
  });
  const result = resolveStoryRepositoryPaths({
    tab: story([entry(), second]),
    content: "检查 D:\\workspace\\AppMarket\\build.gradle",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_BASE_WORKTREE_AMBIGUOUS");
  assert.equal(result.failures[0].candidates.length, 2);
});

test("blocks path-free sends when a managed story has more than one active primary", () => {
  const sameBaseSecond = entry({
    path: "D:\\workspace\\WorktreeSpace\\story-appmarket-second",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-appmarket-second",
    branch: "story/other",
  });
  const differentBaseSecond = entry({
    name: "SdkFactory",
    repositoryId: "sdk",
    baseProjectId: "local-sdk",
    basePath: "D:\\workspace\\SdkFactory",
    baseRepositoryPath: "D:\\workspace\\SdkFactory",
    path: "D:\\workspace\\WorktreeSpace\\story-sdk",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-sdk",
  });

  for (const entries of [[entry(), sameBaseSecond], [entry(), differentBaseSecond]]) {
    const result = resolveStoryRepositoryPaths({
      tab: story(entries),
      content: "继续处理刚才的问题",
      projects: entries.map((item) => ({ path: item.basePath })),
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "STORY_WORKTREE_INTEGRITY_INVALID");
    assert.match(result.failures.map((failure) => failure.reason).join("\n"), /2 个 active 主 worktree/);
  }
});

test("allows this story worktree but blocks a foreign story worktree", () => {
  const current = story([entry()]);
  const otherEntry = entry({
    path: "D:\\workspace\\WorktreeSpace\\other-appmarket",
    worktreePath: "D:\\workspace\\WorktreeSpace\\other-appmarket",
    branch: "story/other",
  });
  const allowed = resolveStoryRepositoryPaths({
    tab: current,
    content: "读取 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md",
    projects: [],
    allTabs: [current, story([otherEntry], "story-other")],
    pathExists: alwaysExists,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.mappings.length, 0);

  const foreign = resolveStoryRepositoryPaths({
    tab: current,
    content: "读取 D:\\workspace\\WorktreeSpace\\other-appmarket\\README.md",
    projects: [],
    allTabs: [current, { ...story([otherEntry], "story-other"), title: "其它修复" }],
    pathExists: alwaysExists,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.failures[0].kind, "foreign-worktree");
});

test("blocks a physical checkout registered by both current and another story", () => {
  const sharedPath = "D:\\workspace\\WorktreeSpace\\shared-appmarket";
  const currentEntry = entry({ path: sharedPath, worktreePath: sharedPath });
  const otherEntry = entry({ path: "D:\\alias\\shared-appmarket", worktreePath: "D:\\alias\\shared-appmarket" });
  const current = story([currentEntry]);
  const other = { ...story([otherEntry], "story-other"), title: "其它故事点" };
  const realPath = (candidate) => (
    normalizeRepositoryPath(candidate).includes("shared-appmarket") ? sharedPath : candidate
  );

  const baseReference = resolveStoryRepositoryPaths({
    tab: current,
    content: "修改 D:\\workspace\\AppMarket\\README.md",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    allTabs: [current, other],
    pathExists: alwaysExists,
    realPath,
  });
  assert.equal(baseReference.ok, false);
  assert.equal(baseReference.failures[0].kind, "shared-worktree");

  const checkoutReference = resolveStoryRepositoryPaths({
    tab: current,
    content: `修改 ${sharedPath}\\README.md`,
    allTabs: [current, other],
    pathExists: alwaysExists,
    realPath,
  });
  assert.equal(checkoutReference.ok, false);
  assert.equal(checkoutReference.failures[0].kind, "shared-worktree");

  const pathFreeReference = resolveStoryRepositoryPaths({
    tab: current,
    content: "继续处理刚才的问题",
    allTabs: [current, other],
    pathExists: alwaysExists,
    realPath,
  });
  assert.equal(pathFreeReference.ok, false);
  assert.equal(pathFreeReference.failures[0].kind, "shared-worktree");
});

test("blocks a stale mapping whose worktree directory disappeared", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "修改 D:\\workspace\\AppMarket\\src\\Main.kt",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: (candidate) => !normalizeRepositoryPath(candidate).includes("WorktreeSpace"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_WORKTREE_INTEGRITY_INVALID");
  assert.equal(result.failures[0].kind, "unsafe-worktree");
});

test("blocks direct references to missing or out-of-root active worktree entries", () => {
  const missing = entry();
  const missingResult = resolveStoryRepositoryPaths({
    tab: story([missing]),
    content: `读取 ${missing.worktreePath}\\README.md`,
    pathExists: (candidate) => !normalizeRepositoryPath(candidate).includes("WorktreeSpace"),
  });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.failures[0].kind, "unsafe-worktree");

  const escaped = entry({
    path: "D:\\workspace\\outside-story",
    worktreePath: "D:\\workspace\\WorktreeSpace\\story-appmarket",
  });
  const escapedResult = resolveStoryRepositoryPaths({
    tab: story([escaped]),
    content: "读取 D:\\workspace\\outside-story\\README.md",
    pathExists: alwaysExists,
  });
  assert.equal(escapedResult.ok, false);
  assert.equal(escapedResult.failures[0].kind, "unsafe-worktree");
  assert.match(escapedResult.failures[0].reason, /越出/);

  const pathFreeMissing = resolveStoryRepositoryPaths({
    tab: story([missing]),
    content: "继续处理刚才的问题",
    pathExists: (candidate) => !normalizeRepositoryPath(candidate).includes("WorktreeSpace"),
  });
  assert.equal(pathFreeMissing.ok, false);
  assert.equal(pathFreeMissing.code, "STORY_WORKTREE_INTEGRITY_INVALID");

  const pathFreeEscaped = resolveStoryRepositoryPaths({
    tab: story([escaped]),
    content: "继续处理刚才的问题",
    pathExists: alwaysExists,
  });
  assert.equal(pathFreeEscaped.ok, false);
  assert.equal(pathFreeEscaped.failures[0].kind, "unsafe-worktree");
});

test("blocks a mapped subproject whose physical path is a junction back to the base repository", () => {
  const storyRoot = "D:\\workspace\\WorktreeSpace\\story-appmarket";
  const webBase = "D:\\workspace\\AppMarket\\WebApp";
  const webPath = `${storyRoot}\\WebApp`;
  const main = entry({ path: storyRoot, worktreePath: storyRoot });
  const web = entry({
    role: "webapp",
    name: "WebApp",
    basePath: webBase,
    baseRepositoryPath: "D:\\workspace\\AppMarket",
    path: webPath,
    worktreePath: storyRoot,
  });
  const realPath = (candidate) => {
    const normalized = normalizeRepositoryPath(candidate);
    if (normalized.toLowerCase().startsWith(normalizeRepositoryPath(webPath).toLowerCase())) {
      return normalized.replace(new RegExp(`^${normalizeRepositoryPath(webPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), normalizeRepositoryPath(webBase));
    }
    return candidate;
  };
  const result = resolveStoryRepositoryPaths({
    tab: story([main, web]),
    content: `修改 ${webBase}\\src\\A.kt`,
    projects: [{ path: "D:\\workspace\\AppMarket", webAppPath: webBase }],
    pathExists: alwaysExists,
    realPath,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "unsafe-worktree");
  assert.match(result.failures[0].reason, /真实位置指向基础仓库/);
});

test("blocks a worktree root junction that physically points back to the base repository", () => {
  const worktreeAlias = "D:\\workspace\\WorktreeSpace\\story-appmarket";
  const basePath = "D:\\workspace\\AppMarket";
  const result = resolveStoryRepositoryPaths({
    tab: story([entry({ path: worktreeAlias, worktreePath: worktreeAlias })]),
    content: "继续处理刚才的问题",
    projects: [{ path: basePath }],
    pathExists: alwaysExists,
    realPath: (candidate) => pathKeyForTest(candidate) === pathKeyForTest(worktreeAlias) ? basePath : candidate,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "unsafe-worktree");
  assert.match(result.repositoryPathAlert.title, /未与基础仓库隔离/);
  assert.match(result.failures[0].reason, /真实位置指向基础仓库/);
});

test("blocks a managed entry that directly registers the base repository as its worktree", () => {
  const basePath = "D:\\workspace\\AppMarket";
  const result = resolveStoryRepositoryPaths({
    tab: story([entry({ path: basePath, worktreePath: basePath })]),
    content: `修改 ${basePath}\\README.md`,
    projects: [{ path: basePath }],
    pathExists: alwaysExists,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "unsafe-worktree");
  assert.match(result.failures[0].reason, /重合|包含/);
  assert.equal(result.mappedContent, result.originalContent);
});

test("blocks a managed worktree root that contains the base repository", () => {
  const basePath = "D:\\workspace\\AppMarket";
  const containingRoot = "D:\\workspace";
  const result = resolveStoryRepositoryPaths({
    tab: story([entry({ path: containingRoot, worktreePath: containingRoot })]),
    content: "继续处理刚才的问题",
    projects: [{ path: basePath }],
    pathExists: alwaysExists,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "unsafe-worktree");
  assert.match(result.failures[0].reason, /互相包含/);
});

test("blocks a broad current worktree root containing another registered base repository", () => {
  const broad = entry({
    basePath: "E:\\source\\App",
    baseRepositoryPath: "E:\\source\\App",
    path: "D:\\workspace",
    worktreePath: "D:\\workspace",
  });
  const result = resolveStoryRepositoryPaths({
    tab: story([broad]),
    content: "继续处理刚才的问题",
    projects: [
      { path: "E:\\source\\App" },
      { path: "D:\\workspace\\SdkFactory" },
    ],
    pathExists: alwaysExists,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "unsafe-worktree");
  assert.match(result.failures[0].reason, /互相包含/);
});

test("blocks a current broad root that contains another story checkout", () => {
  const current = story([entry({
    basePath: "E:\\source\\App",
    baseRepositoryPath: "E:\\source\\App",
    path: "D:\\WorktreeSpace",
    worktreePath: "D:\\WorktreeSpace",
  })]);
  const other = story([entry({
    basePath: "F:\\source\\Sdk",
    baseRepositoryPath: "F:\\source\\Sdk",
    path: "D:\\WorktreeSpace\\other",
    worktreePath: "D:\\WorktreeSpace\\other",
  })], "story-other");
  const result = resolveStoryRepositoryPaths({
    tab: current,
    content: "继续处理刚才的问题",
    allTabs: [current, other],
    pathExists: alwaysExists,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "shared-worktree");
});

test("blocks relative managed worktree paths before an agent can inherit Gateway cwd", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry({ path: ".", worktreePath: "." })]),
    content: "继续处理刚才的问题",
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_WORKTREE_INTEGRITY_INVALID");
  assert.match(result.failures[0].reason, /绝对路径/);
});

test("blocks path-free AI sends after a managed worktree was cleaned or lost its primary entry", () => {
  for (const worktree of [
    { managed: true, root: "", entries: [], cleanedEntries: [] },
    { managed: true, root: "D:\\workspace\\WorktreeSpace\\partial", entries: [entry({ role: "extra" })] },
  ]) {
    const result = resolveStoryRepositoryPaths({
      tab: { id: "cleaned-story", worktree },
      content: "继续处理刚才的问题",
      pathExists: alwaysExists,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "STORY_WORKTREE_INTEGRITY_INVALID");
    assert.match(result.failures[0].reason, /没有 active 主 worktree/);
  }
});

test("Bundle 固定兄弟目录被篡改后，AI 派发前失败关闭", () => {
  const root = "D:\\workspace\\WorktreeSpace\\CARB-100-a13f";
  const app = entry({
    path: `${root}\\AppMarket`,
    worktreePath: `${root}\\AppMarket`,
    checkoutDirName: "AppMarket",
    logicalBranch: "v202605_ui",
    mode: "EDITABLE",
  });
  const web = entry({
    role: "webapp",
    repositoryId: "appmarket-web",
    baseProjectId: "local-web",
    basePath: "D:\\workspace\\AppMarketWeb",
    baseRepositoryPath: "D:\\workspace\\AppMarketWeb",
    path: `${root}\\WrongWebName`,
    worktreePath: `${root}\\WrongWebName`,
    checkoutDirName: "AppMarketWeb",
    logicalBranch: "v202605_ui",
    mode: "READ_ONLY",
    detached: true,
  });
  const tab = story([app, web]);
  tab.worktree.root = root;
  tab.worktree.bundle = {
    enabled: true,
    buildEntryRepositoryId: "appmarket",
    members: [
      { repositoryId: "appmarket", checkoutDirName: "AppMarket", mode: "EDITABLE" },
      { repositoryId: "appmarket-web", checkoutDirName: "AppMarketWeb", mode: "READ_ONLY" },
    ],
  };

  const result = resolveStoryRepositoryPaths({ tab, content: "继续处理", pathExists: alwaysExists });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_WORKTREE_INTEGRITY_INVALID");
  assert.match(result.failures[0].reason, /目录名不是固定值 AppMarketWeb/);
});

test("blocks path-free sends for legacy base-backed tabs and failed worktree lifecycle states", () => {
  const legacy = resolveStoryRepositoryPaths({
    tab: {
      id: "legacy-local",
      mode: "local",
      primaryProjectId: "local-appmarket",
      worktree: { managed: false, entries: [] },
    },
    content: "继续",
    projects: [{ id: "local-appmarket", path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.code, "STORY_WORKTREE_INTEGRITY_INVALID");
  assert.match(legacy.failures[0].reason, /基础工程作为 AI cwd/);

  const failed = resolveStoryRepositoryPaths({
    tab: { ...story([entry()]), worktreeStatus: "error" },
    content: "继续",
    projects: [{ id: "local-appmarket", path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "STORY_WORKTREE_INTEGRITY_INVALID");
  assert.match(failed.failures[0].reason, /尚未安全就绪/);
});

test("Windows 基础仓拒绝当前驱动器隐式的 slash-root worktree 路径", () => {
  const result = resolveStoryRepositoryPaths({
    tab: story([entry({ path: "/workspace", worktreePath: "/workspace" })]),
    content: "继续处理刚才的问题",
    pathExists: alwaysExists,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "STORY_WORKTREE_INTEGRITY_INVALID");
  assert.match(result.failures[0].reason, /Windows 基础仓库/);
});

test("单次解析缓存 exists 和 realpath，重复仓库与引用不重复阻塞探测", () => {
  const existsCalls = new Map();
  const realCalls = new Map();
  const count = (map, candidate) => {
    const key = pathKeyForTest(candidate);
    map.set(key, (map.get(key) || 0) + 1);
  };
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: "比较 D:\\workspace\\AppMarket\\README.md 与 D:\\workspace\\AppMarket\\build.gradle",
    projects: [
      { path: "D:\\workspace\\AppMarket" },
      { path: "D:\\workspace\\AppMarket" },
    ],
    pathExists: (candidate) => { count(existsCalls, candidate); return true; },
    realPath: (candidate) => { count(realCalls, candidate); return candidate; },
  });

  assert.equal(result.ok, true);
  assert.ok([...existsCalls.values()].every((calls) => calls === 1));
  assert.ok([...realCalls.values()].every((calls) => calls === 1));
});

test("maps an arbitrary junction alias whose physical target is a registered base repository", () => {
  const aliasRoot = "D:\\aliases\\base-appmarket";
  const baseRoot = "D:\\workspace\\AppMarket";
  const realPath = (candidate) => {
    const normalized = normalizeRepositoryPath(candidate);
    if (pathKeyForTest(normalized).startsWith(pathKeyForTest(aliasRoot))) {
      return `${baseRoot}${normalized.slice(normalizeRepositoryPath(aliasRoot).length)}`;
    }
    return candidate;
  };
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content: `修改 ${aliasRoot}\\README.md`,
    projects: [{ path: baseRoot }],
    pathExists: alwaysExists,
    realPath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, "修改 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md");
  assert.equal(result.mappings.length, 1);
});

test("maps an arbitrary volume-root-relative junction alias to the current story worktree", () => {
  const aliasRoot = "D:\\aliases\\base-appmarket";
  const baseRoot = "D:\\workspace\\AppMarket";
  const realPath = (candidate) => {
    const normalized = normalizeRepositoryPath(candidate);
    if (pathKeyForTest(normalized).startsWith(pathKeyForTest(aliasRoot))) {
      return `${baseRoot}${normalized.slice(normalizeRepositoryPath(aliasRoot).length)}`;
    }
    return candidate;
  };
  for (const referencedPath of ["\\aliases\\base-appmarket\\README.md", "/aliases/base-appmarket/README.md"]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content: `修改 ${referencedPath}`,
      projects: [{ path: baseRoot }],
      pathExists: alwaysExists,
      realPath,
    });
    assert.equal(result.ok, true, referencedPath);
    assert.equal(result.mappedContent, "修改 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md");
  }
});

test("maps arbitrary absolute and root-relative spaced junction aliases", () => {
  const aliasRoot = "D:\\aliases\\link name";
  const baseRoot = "D:\\workspace\\AppMarket";
  const probes = [];
  const realPath = (candidate) => {
    const normalized = normalizeRepositoryPath(candidate);
    probes.push(normalized);
    if (pathKeyForTest(normalized).startsWith(pathKeyForTest(aliasRoot))) {
      return `${baseRoot}${normalized.slice(normalizeRepositoryPath(aliasRoot).length)}`;
    }
    return candidate;
  };
  for (const referencedPath of ["D:\\aliases\\link name\\README.md", "\\aliases\\link name\\README.md"]) {
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content: `修改 ${referencedPath}`,
      projects: [{ path: baseRoot }],
      pathExists: alwaysExists,
      realPath,
    });
    assert.equal(result.ok, true, referencedPath);
    assert.equal(result.mappedContent, "修改 D:\\workspace\\WorktreeSpace\\story-appmarket\\README.md");
  }
  assert.ok(probes.some((candidate) => candidate.includes("/link name/README.md")));
});

test("blocks an arbitrary junction alias whose physical target belongs to another story", () => {
  const aliasRoot = "D:\\aliases\\foreign-story";
  const foreignRoot = "D:\\workspace\\WorktreeSpace\\other-appmarket";
  const current = story([entry()]);
  const other = story([entry({
    path: foreignRoot,
    worktreePath: foreignRoot,
    branch: "story/other",
  })], "story-other");
  const realPath = (candidate) => {
    const normalized = normalizeRepositoryPath(candidate);
    if (pathKeyForTest(normalized).startsWith(pathKeyForTest(aliasRoot))) {
      return `${foreignRoot}${normalized.slice(normalizeRepositoryPath(aliasRoot).length)}`;
    }
    return candidate;
  };
  const result = resolveStoryRepositoryPaths({
    tab: current,
    content: `修改 ${aliasRoot}\\README.md`,
    allTabs: [current, other],
    pathExists: alwaysExists,
    realPath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, "foreign-worktree");
  assert.match(result.repositoryPathAlert.title, /未找到对应故事点 worktree/);
});

test("leaves branch names and unknown paths on a registered volume untouched", () => {
  const content = "在 release/main 分支看看 D:\\Windows\\Temp\\trace.log";
  const result = resolveStoryRepositoryPaths({
    tab: story([entry()]),
    content,
    projects: [{ path: "D:\\workspace\\AppMarket" }],
    pathExists: alwaysExists,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mappedContent, content);
  assert.equal(result.mappings.length, 0);
});

test("blocks unknown Windows volumes without probing cross-volume aliases", () => {
  for (const referencedPath of ["C:\\alias-to-base\\secret.txt", "Z:\\network-drive\\secret.txt"]) {
    const probes = [];
    const result = resolveStoryRepositoryPaths({
      tab: story([entry()]),
      content: `读取 ${referencedPath}`,
      projects: [{ path: "D:\\workspace\\AppMarket" }],
      pathExists: (candidate) => { probes.push(String(candidate)); return true; },
      realPath: (candidate) => {
        probes.push(String(candidate));
        return /^C:/i.test(String(candidate))
          ? "D:\\workspace\\AppMarket\\secret.txt"
          : candidate;
      },
    });
    assert.equal(result.ok, false, referencedPath);
    assert.match(result.failures.map((failure) => failure.reason).join("\n"), /不属于当前故事点已登记仓库/);
    assert.equal(probes.some((candidate) => candidate.toLowerCase().startsWith(referencedPath.slice(0, 2).toLowerCase())), false);
  }
});
