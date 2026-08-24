/**
 * TB 任务 → Bug Agent 输入 适配器测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractPackageName,
  transformTbRecordToInput,
} from "../ingest/tb-adapter.js";

// ---------- extractPackageName ----------

test("extractPackageName: 单包名识别（类名不算包名）", () => {
  // `AudioFocusHelper` 是类名（大写）不算包名的一部分，应只匹配到 com.xxx.music
  assert.equal(
    extractPackageName("闪退 at com.xxx.music.AudioFocusHelper:142"),
    "com.xxx.music"
  );
});

test("extractPackageName: 频次最高胜出", () => {
  const text = `
    FATAL EXCEPTION in com.xxx.music
    at com.xxx.music.Player.play
    at com.xxx.music.MediaSession.onPlay
    also com.other.app.Bar is called once
  `;
  assert.equal(extractPackageName(text), "com.xxx.music");
});

test("extractPackageName: 无匹配返回 null", () => {
  assert.equal(extractPackageName("这是中文描述没有包名"), null);
  assert.equal(extractPackageName(""), null);
  assert.equal(extractPackageName(null), null);
});

test("extractPackageName: 黑名单过滤 java.lang", () => {
  const text = "java.lang.NullPointerException at com.xxx.music.Player.play";
  const pkg = extractPackageName(text);
  assert.ok(pkg && pkg.startsWith("com.xxx"));
});

test("extractPackageName: 拒识 system property key (persist.sys.*)", () => {
  // 现实 case：persist.sys.hw_mc.carsecurity.devexist 是 system property，不是包名
  const text = "in persist.sys.hw_mc.carsecurity.devexist with com.xxx.music app";
  const pkg = extractPackageName(text);
  assert.equal(pkg, "com.xxx.music");
});

test("extractPackageName: 拒识 ro.* / sys.* / vendor.* 等系统前缀", () => {
  for (const prefix of ["ro.product.brand", "sys.boot.completed", "vendor.audio.hal", "debug.atrace.tags", "net.dns1"]) {
    const r = extractPackageName(prefix);
    assert.equal(r, null, `${prefix} 应被拒识`);
  }
});

test("extractPackageName: 拒识 com.android.server.* framework 包", () => {
  const r = extractPackageName("FATAL EXCEPTION at com.android.server.wm.WindowManagerService.checkAddPermission");
  assert.equal(r, null, "com.android.server.* 是 framework 服务，不应作为应用包名");
});

test("extractPackageName: 长度优先于首次位置", () => {
  const text = "com.a.b appears first once. later com.xxx.music.player appears once.";
  // 两者都 1 次 → 长度胜出
  assert.equal(extractPackageName(text), "com.xxx.music.player");
});

// ---------- transformTbRecordToInput ----------

test("transformTbRecordToInput: 完整 record 含 description + 附件目录", () => {
  const record = {
    id: "tb-001",
    carb_id: "CARB-123",
    title: "音乐播放闪退",
    description: "打开应用后立即闪退，日志里出现 com.xxx.music",
    local_dir: "/fake/dir",
    executor_id: "user-007",
    analysis_summary: "根据 logcat，发现 NPE",
    attachments_json: JSON.stringify([
      { filename: "logcat.log", size: 12345 },
      { filename: "crash.anr", size: 6789 },
    ]),
  };

  const r = transformTbRecordToInput(record, {
    readAttachments: (dir) => ({
      files: [{ name: "logcat.log", size: 12345 }],
      combined: "FATAL EXCEPTION: main\n  at com.xxx.music.Player.play",
    }),
  });

  assert.equal(r.tb_id, "CARB-123");
  assert.equal(r.title, "音乐播放闪退");
  assert.ok(r.raw_content.includes("打开应用后立即闪退"));
  assert.ok(r.raw_content.includes("【历史 AI 摘要】"));
  assert.ok(r.raw_content.includes("【附件清单】"));
  assert.ok(r.raw_content.includes("logcat.log"));
  assert.ok(r.log_attachment.includes("FATAL EXCEPTION"));
  // `Player` 是类名（大写）不算包名 → 期望 com.xxx.music
  assert.equal(r.package_name, "com.xxx.music");
  assert.equal(r.reporter_id, "user-007");
  assert.equal(r._meta.attachments.length, 1);
  assert.equal(r._meta.warnings.length, 0);
});

test("transformTbRecordToInput: 附件目录不存在 → warning 但不抛", () => {
  const record = {
    id: "tb-002",
    title: "空附件测试",
    description: "纯描述，无 local_dir",
  };
  const r = transformTbRecordToInput(record);
  assert.equal(r.tb_id, "tb-002");
  assert.equal(r.log_attachment, "");
  assert.ok(r._meta.warnings.some((w) => w.includes("local_dir missing")));
});

test("transformTbRecordToInput: 无任何文本 → package_name null + warning", () => {
  const record = {
    id: "tb-003",
    title: "",
    description: "",
  };
  const r = transformTbRecordToInput(record);
  assert.equal(r.package_name, null);
  assert.ok(r._meta.warnings.some((w) => w.includes("package_name not detected")));
  assert.ok(r.raw_content); // fallback 提示
});

test("transformTbRecordToInput: attachments_json 非法 JSON 降级", () => {
  const record = {
    id: "tb-004",
    title: "坏 JSON",
    description: "x",
    attachments_json: "{not valid json",
  };
  const r = transformTbRecordToInput(record);
  assert.ok(r._meta.warnings.some((w) => w.includes("attachments_json")));
  // 其他字段不受影响
  assert.equal(r.tb_id, "tb-004");
});

test("transformTbRecordToInput: 非对象 record 抛错", () => {
  assert.throws(() => transformTbRecordToInput(null));
  assert.throws(() => transformTbRecordToInput("string"));
});

test("transformTbRecordToInput: 附件读取器失败 → warning", () => {
  const record = {
    id: "tb-005",
    title: "读取失败",
    description: "x",
    local_dir: "/fake",
  };
  const r = transformTbRecordToInput(record, {
    readAttachments: () => { throw new Error("IO broken"); },
  });
  assert.ok(r._meta.warnings.some((w) => w.includes("read attachments failed")));
});
