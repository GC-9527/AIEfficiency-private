import test from "node:test";
import assert from "node:assert/strict";
import {
  extractInstallPackagePaths,
  installPackageName,
} from "./artifactPathModel.mjs";

test("extracts relative, storydev and Windows install package paths", () => {
  const content = [
    "验证包：`.\\tempFiles\\verification-apks\\carb13906-device-signed.apk`",
    "测试集合 storydev:/reports/regression.apks",
    "工程相对路径 app/build/outputs/apk/release/app-release.apk",
    "多模块路径 feature-x\\build\\outputs\\apk\\debug\\feature-debug.apk",
    "release：E:\\work tree\\app\\build\\outputs\\apk\\release\\app-release.apk",
  ].join("\n");

  assert.deepEqual(extractInstallPackagePaths(content), [
    ".\\tempFiles\\verification-apks\\carb13906-device-signed.apk",
    "storydev:/reports/regression.apks",
    "app/build/outputs/apk/release/app-release.apk",
    "feature-x\\build\\outputs\\apk\\debug\\feature-debug.apk",
    "E:\\work tree\\app\\build\\outputs\\apk\\release\\app-release.apk",
  ]);
});

test("deduplicates slash variants and ignores non-package paths", () => {
  const content = [
    "./tempFiles/output.apk",
    ".\\tempFiles\\output.apk",
    "./tempFiles/output.log",
    "下载地址 https://example.com/releases/output.apk 不属于本地路径",
    "普通文件 output.apk 没有目录，不作为可定位路径",
  ].join("\n");

  assert.deepEqual(extractInstallPackagePaths(content), ["./tempFiles/output.apk"]);
  assert.equal(installPackageName(".\\tempFiles\\output.apk"), "output.apk");
});

test("limits the number of rendered package links", () => {
  const content = Array.from({ length: 12 }, (_, index) => `build/output-${index}.apk`).join("\n");
  assert.equal(extractInstallPackagePaths(content).length, 8);
});
