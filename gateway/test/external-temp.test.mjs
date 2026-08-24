import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureExternalTempDirectory,
  ensurePlainExternalChildDirectory,
} from "../services/external-temp.js";

test("外置系统临时目录逐级创建普通目录", () => {
  const leaf = `external-temp-${randomUUID()}`;
  const target = ensureExternalTempDirectory(["aiefficiency-tests", leaf]);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  fs.rmdirSync(target);
  try { fs.rmdirSync(path.dirname(target)); } catch {}
});

test("固定临时子目录为 junction 时拒绝跟随", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "external-temp-parent-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "external-temp-source-"));
  const linked = path.join(parent, "prompts");
  try {
    fs.symlinkSync(source, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
    t.skip(`当前环境无法创建目录链接：${error.message}`);
    return;
  }
  assert.throws(
    () => ensurePlainExternalChildDirectory(parent, "prompts"),
    /临时目录不是普通目录/,
  );
  assert.deepEqual(fs.readdirSync(source), []);
  fs.unlinkSync(linked);
  fs.rmdirSync(parent);
  fs.rmdirSync(source);
});

test("TEMP/TMP 指向源码路径时在创建固定目录前失败关闭", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "external-temp-env-source-"));
  const before = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  try {
    process.env.TEMP = source;
    process.env.TMP = source;
    process.env.TMPDIR = source;
    assert.throws(
      () => ensureExternalTempDirectory(["aiefficiency", "must-not-create"], {
        avoidRoots: [source],
      }),
      (error) => error?.code === "EXTERNAL_TEMP_SOURCE_OVERLAP",
    );
    assert.equal(fs.existsSync(path.join(source, "aiefficiency")), false);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmdirSync(source);
  }
});
