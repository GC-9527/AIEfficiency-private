/**
 * devbench 第三步·自我验收 —— 验收资产铺设
 *
 * 验收开始时由系统确定性地：① 建好证据目录 reports/{cases,screenshots,videos,traces,logs,buried-point}；
 * ② 把录屏包装器 verify-record.mjs 复制进该故事点的 reports 目录（命名 _devbench-record.mjs）。
 * 之后验收 Agent 只需用这个包装器跑每条用例命令，录像/截图/日志便自动落盘，不依赖 LLM 记得录屏。
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as store from "./store.js";

const REPORT_SUBDIRS = ["cases", "screenshots", "videos", "traces", "logs", "buried-point"];
const RECORDER_NAME = "_devbench-record.mjs";
const TEMPLATE_PATH = fileURLToPath(new URL("./verify-record.mjs", import.meta.url));

// 铺设验收资产，返回相对工程根的路径（供 prompt 引用）；失败返回 null。幂等：仅在内容变化时重写录制器。
export function prepareVerifyAssets(tab) {
  try {
    const project = store.getPrimaryProject(tab);
    if (!project || !project.path) return null;
    const storage = store.getStoryStoragePaths(tab, { create: true });
    const slug = storage.docSlug || store.ensureDocSlug(tab);
    const reportsAbs = storage.reportsDirectory;
    for (const d of REPORT_SUBDIRS) {
      store.validateStoryStorageTarget(tab, path.join(reportsAbs, d), {
        baseDirectory: reportsAbs,
        createDirectory: true,
        mustExist: true,
        expectedType: "directory",
      });
    }

    const recorderAbs = path.join(reportsAbs, RECORDER_NAME);
    store.validateStoryStorageTarget(tab, recorderAbs, {
      baseDirectory: reportsAbs,
      mustExist: false,
    });
    let src = "";
    try { src = readFileSync(TEMPLATE_PATH, "utf8"); } catch { src = ""; }
    if (src) {
      let need = true;
      try { if (existsSync(recorderAbs) && readFileSync(recorderAbs, "utf8") === src) need = false; } catch {}
      if (need) {
        writeFileSync(recorderAbs, src, "utf8");
        store.validateStoryStorageTarget(tab, recorderAbs, {
          baseDirectory: reportsAbs,
          mustExist: true,
          expectedType: "file",
        });
      }
    }

    const reportsRel = "storydev:/reports";
    return {
      ok: true,
      slug,
      reportsAbs,
      reportsRel,
      recorderAbs,
      recorderRel: `${reportsRel}/${RECORDER_NAME}`,
      hasRecorder: !!src,
    };
  } catch {
    return null;
  }
}
