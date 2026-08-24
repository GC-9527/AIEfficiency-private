import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const taskRootRelative = "features/PerformanceFeature/performance-test-scripts/tasks";
const taskRoot = path.resolve(repoRoot, ...taskRootRelative.split("/"));
const legacyDocsFragment = "features/PerformanceFeature/step20260714/docs";
const baselineTaskIds = ["appmarket-default", "appmarket-launch-only"];
const builtinSources = new Set(["samples", "diagnosticSamples"]);

function collectTaskManifests(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTaskManifests(absolute, result);
    else if (entry.isFile() && entry.name === "task.json") result.push(absolute);
  }
  return result;
}

function readTask(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function assertUnique(values, message) {
  assert.equal(new Set(values).size, values.length, message);
}

function taskPackageRelative(manifestPath) {
  const parts = path.relative(taskRoot, manifestPath).split(path.sep);
  assert.equal(parts.length, 5, `${manifestPath} 必须位于 <platform>/<task-package>/profiles/<profile-id>/task.json`);
  assert.equal(parts[2], "profiles", `${manifestPath} profiles 目录`);
  assert.match(parts[0], /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${manifestPath} platform`);
  assert.match(parts[1], /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${manifestPath} task-package`);
  assert.match(parts[3], /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${manifestPath} profile-id`);
  return `${taskRootRelative}/${parts[0]}/${parts[1]}`;
}

function assertValidUiReference(task, manifestPath) {
  const ui = task.ui;
  assert.equal(ui?.schemaVersion, 1, `${manifestPath} ui.schemaVersion`);
  assert.ok(Array.isArray(ui.runSections), `${manifestPath} ui.runSections`);
  assert.ok(Array.isArray(ui.views) && ui.views.length > 0, `${manifestPath} ui.views`);
  const allSections = [...ui.runSections, ...ui.views];
  const ids = allSections.map((section) => section.id);
  assertUnique(ids, `${manifestPath} UI 区块 ID 必须全局唯一`);
  assert.ok(ui.views.some((view) => view.id === ui.defaultView), `${manifestPath} ui.defaultView 必须引用 views`);
  for (const section of allSections) {
    assert.match(section.id, /^[A-Za-z][A-Za-z0-9_.-]*$/, `${manifestPath} UI 区块 ID`);
    if (section.source) {
      assert.ok(
        builtinSources.has(section.source) || /^event:[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(section.source),
        `${manifestPath} ${section.id}.source`,
      );
    }
    if (section.kind === "live") {
      assert.ok(section.source, `${manifestPath} ${section.id} 实时区块必须声明 source`);
      assert.ok(Array.isArray(section.metrics) && section.metrics.length > 0, `${manifestPath} ${section.id}.metrics`);
    }
    for (const fieldName of ["metrics", "columns"]) {
      const fields = section[fieldName] || [];
      assertUnique(fields.map((field) => field.key), `${manifestPath} ${section.id}.${fieldName} 字段不能重复`);
    }
  }
}

test("production task library keeps baseline tasks while allowing additional manifests", () => {
  const manifests = collectTaskManifests(taskRoot);
  const tasks = manifests.map(readTask);
  assert.ok(tasks.length >= baselineTaskIds.length);
  assertUnique(tasks.map((task) => task.id), "task.id 必须在脚本库中唯一");
  for (const id of baselineTaskIds) assert.ok(tasks.some((task) => task.id === id), `缺少基线任务 ${id}`);
  assert.equal(tasks.some((task) => task.id === "template-must-not-be-discovered"), false);
});

test("every managed task keeps its runner and sources inside its own task package", () => {
  for (const manifestPath of collectTaskManifests(taskRoot)) {
    const task = readTask(manifestPath);
    const packageRootRelative = taskPackageRelative(manifestPath);
    assert.ok(Array.isArray(task.sourceFiles) && task.sourceFiles.length > 0, `${task.id} sourceFiles`);
    assert.ok(task.sourceFiles.includes(task.runner), `${task.id} sourceFiles 必须登记 runner`);
    for (const relative of [task.runner, ...task.sourceFiles]) {
      assert.equal(relative.includes(legacyDocsFragment), false, `${task.id}: ${relative}`);
      assert.ok(relative.startsWith(`${packageRootRelative}/`), `${task.id}: ${relative}`);
      const absolute = path.resolve(repoRoot, ...relative.split("/"));
      assert.ok(fs.existsSync(absolute) && fs.statSync(absolute).isFile(), `${task.id}: ${relative}`);
    }
  }
});

test("every managed task declares valid workflow and UI references", () => {
  for (const manifestPath of collectTaskManifests(taskRoot)) {
    const task = readTask(manifestPath);
    assert.match(task.id, /^[A-Za-z][A-Za-z0-9_.-]*$/, `${manifestPath} task.id`);
    assert.ok(Array.isArray(task.workflow?.steps) && task.workflow.steps.length > 0, `${task.id} workflow.steps`);
    assertUnique(task.workflow.steps.map((step) => step.key), `${task.id} workflow step key 不能重复`);
    assertUnique(
      task.workflow.steps.flatMap((step) => step.eventSteps || []),
      `${task.id} workflow eventSteps 必须一一映射`,
    );
    assertValidUiReference(task, manifestPath);
  }
});

test("production Gateway defaults no longer reference the story docs runtime", () => {
  for (const relative of [
    "gateway/services/performance-resource-config.js",
    "gateway/services/performance-resource-runner.js",
  ]) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.equal(source.includes("step20260714"), false, relative);
    assert.equal(source.includes("performance-test-scripts"), true, relative);
    assert.equal(source.includes("tasks"), true, relative);
  }
});

test("desktop release bundles and synchronizes the performance task library", () => {
  const packageConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "desktop", "package.json"), "utf8"));
  const expectedSource = "../features/PerformanceFeature/performance-test-scripts/tasks";
  const expectedDestination = "features/PerformanceFeature/performance-test-scripts/tasks";
  const packagedResource = packageConfig.build?.extraResources?.find(
    (resource) => resource?.to === expectedDestination,
  );

  assert.equal(packagedResource?.from, expectedSource);
  assert.ok(packagedResource?.filter?.includes("**/*"));

  const desktopMain = fs.readFileSync(path.join(repoRoot, "desktop", "main.js"), "utf8");
  assert.match(
    desktopMain,
    /path\.join\("features", "PerformanceFeature", "performance-test-scripts", "tasks"\)/,
  );
  assert.match(desktopMain, /copyGatewaySource\(source, destination, \{ skipNodeModules: true \}\)/);
});
