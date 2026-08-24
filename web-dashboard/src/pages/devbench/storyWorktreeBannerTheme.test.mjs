import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyTabSource = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
const branchMismatchSource = fs.readFileSync(new URL("./WorktreeBranchMismatchBanner.jsx", import.meta.url), "utf8");
const cleanupModalSource = fs.readFileSync(new URL("./WorktreeCleanupModal.jsx", import.meta.url), "utf8");
const envCheckSource = fs.readFileSync(new URL("./EnvCheckModal.jsx", import.meta.url), "utf8");
const initializationSource = fs.readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
const configInferenceSource = fs.readFileSync(new URL("./ConfigInferenceReview.jsx", import.meta.url), "utf8");
const trainingSource = fs.readFileSync(new URL("./AiTrainingPanel.jsx", import.meta.url), "utf8");
const globalStyles = fs.readFileSync(new URL("../../index.css", import.meta.url), "utf8");

test("DevBench 的状态提示层使用浅色语义状态面，而不是多色深色渐变", () => {
  assert.match(storyTabSource, /data-testid="story-repository-path-alert"[\s\S]{0,240}className="mb-3 rounded-xl border devbench-status-surface devbench-status-surface--danger px-3 py-2\.5"/);
  assert.match(storyTabSource, /backgroundInitializationFailed\s*\?\s*"devbench-status-banner devbench-status-banner--danger"\s*:\s*"devbench-status-banner devbench-status-banner--info"/);
  assert.match(storyTabSource, /className="shrink-0 border-b devbench-status-banner devbench-status-banner--info px-4 py-2\.5"[\s\S]{0,180}data-testid="git-commit-review-banner"/);
  assert.match(storyTabSource, /data-testid="story-worktree-banner"\s+className="border-t devbench-status-banner devbench-status-banner--success px-4 py-2"/);
  assert.match(storyTabSource, /data-testid="story-worktree-partial-banner"\s+className="border-t devbench-status-banner devbench-status-banner--warning px-4 py-2"/);
  assert.match(storyTabSource, /data-testid="story-worktree-cleaned-banner"\s+className="border-t devbench-status-banner devbench-status-banner--success px-4 py-2"/);
  assert.match(branchMismatchSource, /className="border-t devbench-status-banner devbench-status-banner--warning"[\s\S]{0,180}data-testid="worktree-branch-mismatch-banner"/);
  assert.match(cleanupModalSource, /className="overflow-hidden rounded-2xl border devbench-status-surface devbench-status-surface--danger"[\s\S]{0,240}data-testid="worktree-force-panel"/);
  assert.match(envCheckSource, /className="rounded-xl border devbench-status-surface devbench-status-surface--warning px-3\.5 py-3 flex items-center gap-3 flex-wrap"[\s\S]{0,180}data-testid="ai-upgrade-banner"/);
  assert.match(initializationSource, /inferencePhase === "applying"\s*\? "cursor-default devbench-status-surface devbench-status-surface--warning"/);
  assert.match(initializationSource, /inferenceResultAvailable\s*\? "devbench-status-surface devbench-status-surface--success hover:border-emerald-300"/);
  assert.match(initializationSource, /"cursor-default devbench-status-surface devbench-status-surface--info"/);
  assert.match(configInferenceSource, /data-testid="config-local-project-resolution" className="border-b devbench-status-banner devbench-status-banner--info p-3 sm:p-4"/);
  assert.match(trainingSource, /data-testid="ai-training-latest-learned" className="overflow-hidden rounded-xl border devbench-status-surface devbench-status-surface--success"/);
  assert.match(
    globalStyles,
    /\.devbench-status-banner--success,\s*\.devbench-status-surface--success\s*\{[\s\S]*background:\s*color-mix\(in oklab, var\(--status-success-soft\) 72%, var\(--color-canvas\)\);/
  );
  assert.match(globalStyles, /\.devbench-status-banner--warning,\s*\.devbench-status-surface--warning\s*\{[\s\S]*var\(--status-warning-soft\)/);
  assert.match(globalStyles, /\.devbench-status-banner--danger,\s*\.devbench-status-surface--danger\s*\{[\s\S]*var\(--status-danger-soft\)/);
  assert.match(globalStyles, /\.devbench-status-banner--info,\s*\.devbench-status-surface--info\s*\{[\s\S]*var\(--color-accent-soft\)/);
});
