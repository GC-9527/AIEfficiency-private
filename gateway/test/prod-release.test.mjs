/**
 * 发布生产纯逻辑单测：日期目录(本周五/下周五)、Temp_ 透传、路径分隔符、
 * apk/mapping 在 build/outputs 下的 prod+release 评分定位。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { datedReleaseDir, findProdReleaseApk, findMappingFile, collectOutputRoots, filterChangeLinesByFlavor, publishExpectedFingerprint } from "../services/devbench/prod-release.js";

// 2026-06 月历：15周一 16周二 17周三 18周四 19周五 20周六 21周日 22周一
test("datedReleaseDir：周一~周五都归到【本周五 2026-0619】", () => {
  for (const [d, label] of [[15, "周一"], [16, "周二"], [17, "周三"], [18, "周四"], [19, "周五"]]) {
    const r = datedReleaseDir("/base", new Date(2026, 5, d));
    assert.equal(r, `/base/2026-0619/Temp_202606${String(d).padStart(2, "0")}`, `${label}应归本周五`);
  }
});

test("datedReleaseDir：周六/周日已过本周五 → 用【下周五 2026-0626】", () => {
  assert.equal(datedReleaseDir("/base", new Date(2026, 5, 20)), "/base/2026-0626/Temp_20260620"); // 周六
  assert.equal(datedReleaseDir("/base", new Date(2026, 5, 21)), "/base/2026-0626/Temp_20260621"); // 周日
});

test("datedReleaseDir：跨月也正确（2026-07-31 周五当天）", () => {
  // 2026-07-31 是周五
  assert.equal(datedReleaseDir("/b", new Date(2026, 6, 31)), "/b/2026-0731/Temp_20260731");
});

test("datedReleaseDir：UNC/Windows 用反斜杠，POSIX 用正斜杠", () => {
  assert.equal(datedReleaseDir("\\\\srv\\rel", new Date(2026, 5, 19)), "\\\\srv\\rel\\2026-0619\\Temp_20260619");
  assert.equal(datedReleaseDir("D:\\rel", new Date(2026, 5, 19)), "D:\\rel\\2026-0619\\Temp_20260619");
  assert.equal(datedReleaseDir("/mnt/rel", new Date(2026, 5, 19)), "/mnt/rel/2026-0619/Temp_20260619");
});

test("datedReleaseDir：去尾部斜杠后再补", () => {
  assert.equal(datedReleaseDir("/base///", new Date(2026, 5, 19)), "/base/2026-0619/Temp_20260619");
});

test("datedReleaseDir：已是含 Temp_<日期> 的完整目录 → 原样返回(去尾斜杠)", () => {
  const full = "//srv/rel/2026-0619/Temp_20260617";
  assert.equal(datedReleaseDir(full, new Date(2026, 5, 21)), full);
  assert.equal(datedReleaseDir(full + "/", new Date(2026, 5, 21)), full);
});

test("filterChangeLinesByFlavor：按【】与关键词过滤其它 flavor，公共提交保留", () => {
  const lines = [
    "【极氪9x】修复语音 SDK 回调",
    "fix zeekr9x voice sdk init",
    "【avatr8678】调整首页资源",
    "avatr8678 修复埋点",
    "公共：升级基础依赖",
    "同时支持 zeekr9x 与 avatr8678 的公共脚本",
  ];
  assert.deepEqual(filterChangeLinesByFlavor(lines, "zeekr9xProd", ["zeekr9xProd", "avatr8678"]), [
    "【极氪9x】修复语音 SDK 回调",
    "fix zeekr9x voice sdk init",
    "公共：升级基础依赖",
    "同时支持 zeekr9x 与 avatr8678 的公共脚本",
  ]);
});

test("filterChangeLinesByFlavor：当前为 avatr8678 时过滤极氪9x/zeekr9x 改动", () => {
  const lines = [
    "【极氪9x】修复语音 SDK 回调",
    "fix zeekr9x voice sdk init",
    "【avatr8678】调整首页资源",
    "公共：升级基础依赖",
  ];
  assert.deepEqual(filterChangeLinesByFlavor(lines, "avatr8678", ["zeekr9xProd", "avatr8678"]), [
    "【avatr8678】调整首页资源",
    "公共：升级基础依赖",
  ]);
});

test("filterChangeLinesByFlavor：显式 #flavor# 提交标签不是当前 flavor 时过滤", () => {
  const lines = [
    "#CARB-12920# #1.2.60# #avatr8678# 【阿维塔】【性能优化】应用详情页截图新增缩略图处理",
    "#CARB-11934# #1.0.70# #baicn5# 【通用】license管控替换CAI新接口方案 #提交baicn5 AppMock签名校验修复#",
    "公共：发布脚本调整",
  ];
  assert.deepEqual(filterChangeLinesByFlavor(lines, "avatr8678", ["avatr8678"]), [
    "#CARB-12920# #1.2.60# #avatr8678# 【阿维塔】【性能优化】应用详情页截图新增缩略图处理",
    "公共：发布脚本调整",
  ]);
});

test("filterChangeLinesByFlavor：按当前车厂过滤品牌标签，且不让品牌泛化吞掉其它同品牌 flavor", () => {
  const lines = [
    "【阿维塔】应用详情页截图新增缩略图处理",
    "【北汽】license 管控替换 CAI 新接口",
    "avatr8155 国家码兜底",
    "【阿维塔8155】新增国家码兜底",
    "公共：升级图片加载组件",
  ];
  assert.deepEqual(filterChangeLinesByFlavor(lines, "avatr8678", ["avatr8678", "avatr8155"]), [
    "【阿维塔】应用详情页截图新增缩略图处理",
    "公共：升级图片加载组件",
  ]);
});

test("filterChangeLinesByFlavor：普通技术标签不误判为其它 flavor", () => {
  const lines = [
    "#H5# 应用详情页截图缩略图渲染优化",
    "#html5# Web 容器兼容调整",
  ];
  assert.deepEqual(filterChangeLinesByFlavor(lines, "avatr8678", ["avatr8678"]), lines);
});

test("publishExpectedFingerprint：未配置二签指纹时返回空字符串，不抛空指针", () => {
  assert.equal(publishExpectedFingerprint(null), "");
  assert.equal(publishExpectedFingerprint({}), "");
  assert.equal(publishExpectedFingerprint({ sha256: "  AA:BB  " }), "AA:BB");
});

// ---- apk / mapping 定位 ----
function mkApkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prodapk-"));
  // app 模块：prod release / dev release / prod debug
  const mk = (rel) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); return f; };
  mk("app/build/outputs/apk/devRelease/app-dev-release.apk");
  const prodRel = mk("app/build/outputs/apk/prodRelease/app-prod-release.apk");
  mk("app/build/outputs/apk/prodDebug/app-prod-debug.apk");
  mk("app/build/outputs/mapping/devRelease/mapping.txt");
  const prodMap = mk("app/build/outputs/mapping/prodRelease/mapping.txt");
  return { root, prodRel, prodMap };
}

test("findProdReleaseApk：优先 prod+release 变体", () => {
  const { root, prodRel } = mkApkTree();
  assert.equal(findProdReleaseApk(root), prodRel);
  fs.rmSync(root, { recursive: true, force: true });
});

test("findMappingFile：优先 prod+release 的 mapping.txt", () => {
  const { root, prodMap } = mkApkTree();
  assert.equal(findMappingFile(root), prodMap);
  fs.rmSync(root, { recursive: true, force: true });
});

test("findProdReleaseApk/findMappingFile：无产物返回 null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prodempty-"));
  assert.equal(findProdReleaseApk(root), null);
  assert.equal(findMappingFile(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- 回归：debug 包绝不能被当成生产发布包（否则会把 debug 包发到生产）----
test("findProdReleaseApk：只有 prodDebug + devRelease 时，绝不选 debug 包", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proddbg-"));
  const mk = (rel, mtime) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); if (mtime) fs.utimesSync(f, mtime, mtime); return f; };
  // 让 prodDebug 的 mtime 更新(若仅按 mtime 兜底会胜出)，从而真正考验"不选 debug"
  mk("app/build/outputs/apk/devRelease/app-dev-release.apk", new Date(2020, 0, 1));
  const devRel = path.join(root, "app/build/outputs/apk/devRelease/app-dev-release.apk");
  mk("app/build/outputs/apk/prodDebug/app-prod-debug.apk", new Date(2030, 0, 1)); // 更新但是 debug
  assert.equal(findProdReleaseApk(root), devRel, "应选 release 包而非更新的 prod-debug 包");
  fs.rmSync(root, { recursive: true, force: true });
});

test("findProdReleaseApk：release 主信号——dev-release 胜过仅 prod(非 release) 包", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prodrel-"));
  const mk = (rel, mtime) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); if (mtime) fs.utimesSync(f, mtime, mtime); return f; };
  const devRel = mk("app/build/outputs/apk/devRelease/app-dev-release.apk", new Date(2020, 0, 1));
  // 一个含 prod 但不含 release 也不含 debug 的诡异变体(更新 mtime)
  mk("app/build/outputs/apk/prodStaging/app-prodStaging.apk", new Date(2030, 0, 1));
  assert.equal(findProdReleaseApk(root), devRel, "release 应优先于仅 prod 的包");
  fs.rmSync(root, { recursive: true, force: true });
});

test("findProdReleaseApk：只有 debug 包时返回 null（宁缺勿发 debug 到生产）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proddbgonly-"));
  const mk = (rel) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); return f; };
  mk("app/build/outputs/apk/prodDebug/app-prod-debug.apk");
  mk("app/build/outputs/apk/debug/app-debug.apk");
  assert.equal(findProdReleaseApk(root), null, "无 release 包时不应回退到 debug 包");
  fs.rmSync(root, { recursive: true, force: true });
});

test("findProdReleaseApk：prodRelease 仍优先于 devRelease（既有优先级不变）", () => {
  const { root, prodRel } = mkApkTree();
  assert.equal(findProdReleaseApk(root), prodRel);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- 回归：克隆仓库根多套一层（root/<子工程>/app/build/outputs/apk）也能命中 ----
// 此前 collectOutputRoots 只扫 root + 直接子级，apk 在 2 级深处时漏判 → 📦 按钮始终置灰。
test("collectOutputRoots：递归命中 root/子工程/app 两级深处的 build/outputs/apk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prodnested-"));
  const mk = (rel) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); return f; };
  const prodRel = mk("AppMarketProjects/app/build/outputs/apk/prodRelease/app-prod-release.apk");
  mk("WebApp/app/build/outputs/apk/dev/app-dev-debug.apk");
  // 源码树/依赖不应被遍历（仅确保不报错、不漏判）
  mk("AppMarketProjects/app/src/main/java/A.java");
  mk("AppMarketProjects/node_modules/pkg/build/outputs/apk/x/y.apk"); // SKIP 目录里的 apk 不应被选
  const roots = collectOutputRoots(root, "apk");
  assert.ok(roots.some((r) => r.includes(path.join("AppMarketProjects", "app", "build", "outputs", "apk"))), "应发现深层 build/outputs/apk");
  assert.ok(!roots.some((r) => r.includes("node_modules")), "node_modules 内的产物不应纳入");
  assert.equal(findProdReleaseApk(root), prodRel, "克隆仓库根布局也能定位 prod release apk");
  fs.rmSync(root, { recursive: true, force: true });
});
