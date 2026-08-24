import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const styles = fs.readFileSync(new URL("../index.css", import.meta.url), "utf8");
const inlineCodeRule = styles.match(/\.report-content code\s*\{([^}]*)\}/)?.[1] || "";

test("报告内联重点标记使用浅色底和深色文字", () => {
  assert.doesNotMatch(inlineCodeRule, /#27272a/);
  assert.match(inlineCodeRule, /border:\s*var\(--rule-hair\) solid color-mix\(in oklab, var\(--color-accent\) 20%, var\(--color-rule\)\)/);
  assert.match(inlineCodeRule, /background:\s*color-mix\(in oklab, var\(--color-accent-soft\) 78%, var\(--color-canvas\)\)/);
  assert.match(inlineCodeRule, /color:\s*var\(--color-ink\)/);
});
