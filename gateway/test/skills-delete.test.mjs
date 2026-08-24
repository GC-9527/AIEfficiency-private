import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteSkillEntry,
  resolveSkillDeleteTarget,
} from "../routes/skills.js";

function withSkillsRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-delete-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("deleting a packaged SKILL.md removes only that package directory", () => {
  withSkillsRoot((root) => {
    const targetDir = path.join(root, "software-development", "unused-skill");
    const siblingDir = path.join(root, "software-development", "keep-skill");
    fs.mkdirSync(path.join(targetDir, "references"), { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), "---\nname: unused\n---\n");
    fs.writeFileSync(path.join(targetDir, "references", "guide.md"), "guide\n");
    fs.writeFileSync(path.join(siblingDir, "SKILL.md"), "---\nname: keep\n---\n");

    const result = deleteSkillEntry("software-development/unused-skill/SKILL", { skillsDir: root });

    assert.equal(result.ok, true);
    assert.equal(result.data.scope, "package");
    assert.equal(result.data.path, "software-development/unused-skill");
    assert.equal(fs.existsSync(targetDir), false);
    assert.equal(fs.existsSync(siblingDir), true);
  });
});

test("deleting a standalone or non-package markdown keeps adjacent assets", () => {
  withSkillsRoot((root) => {
    const groupDir = path.join(root, "group");
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, "guide.md"), "guide\n");
    fs.writeFileSync(path.join(groupDir, "asset.txt"), "keep\n");

    const result = deleteSkillEntry("group/guide", { skillsDir: root });

    assert.equal(result.ok, true);
    assert.equal(result.data.scope, "file");
    assert.equal(fs.existsSync(path.join(groupDir, "guide.md")), false);
    assert.equal(fs.existsSync(path.join(groupDir, "asset.txt")), true);
  });
});

test("delete target rejects path traversal and reports missing skills", () => {
  withSkillsRoot((root) => {
    assert.equal(resolveSkillDeleteTarget("../outside", root), null);
    assert.equal(resolveSkillDeleteTarget("group/../../outside", root), null);

    const result = deleteSkillEntry("missing", { skillsDir: root });
    assert.deepEqual(result, { ok: false, status: 404, error: "Skill 不存在" });
  });
});
