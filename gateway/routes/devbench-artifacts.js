import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as defaultStore from "../services/devbench/store.js";
import { readClipboardFilePaths } from "../services/clipboard-files.js";
import { isTrustedPerformanceResourceRequest } from "../services/performance-resource-local-access.js";
import {
  resolveInstallPackageReference,
  revealFileInManager,
} from "../services/devbench/artifact-path.js";

export function createDevbenchArtifactsRouter({
  store = defaultStore,
  revealFile = revealFileInManager,
  readClipboardPaths = readClipboardFilePaths,
} = {}) {
  const router = Router();

  const safeLeafName = (value, fallback = "attachment.bin") => {
    const cleaned = String(value || "")
      .replace(/[:*?"<>|]/g, "_")
      .replace(/[\\/]+/g, "_")
      .replace(/\.\.+/g, "_")
      .trim()
      .slice(0, 120);
    return cleaned && cleaned !== "." ? cleaned : fallback;
  };

  const uniqueDestination = (directory, filename) => {
    const extension = path.extname(filename);
    const stem = filename.slice(0, filename.length - extension.length) || "attachment";
    let candidate = path.join(directory, filename);
    let suffix = 2;
    while (fs.existsSync(candidate)) candidate = path.join(directory, `${stem} (${suffix++})${extension}`);
    return candidate;
  };

  router.post("/tabs/:id/artifacts/open", async (req, res) => {
    const tab = store.getTab(req.params.id);
    if (!tab) return res.status(404).json({ ok: false, error: "故事点不存在" });
    if (!isTrustedPerformanceResourceRequest(req)) {
      return res.status(403).json({ ok: false, code: "ARTIFACT_REVEAL_LOCAL_ONLY", error: "资源管理器定位只能由 Gateway 本机页面调用" });
    }

    let storage;
    try {
      storage = store.getStoryStoragePaths(tab, { create: false, persist: false });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ ok: false, error: error.message });
    }

    const resolved = resolveInstallPackageReference(req.body?.path, {
      storyDirectory: storage.storyDirectory,
      projectRoots: store.tabProjectPaths(tab).map((item) => item.path),
    });
    if (!resolved.ok) {
      return res.status(resolved.status || 400).json({
        ok: false,
        code: resolved.code,
        error: resolved.error,
      });
    }
    if (resolved.source === "storydev") {
      try {
        store.validateStoryStorageTarget(tab, resolved.file, {
          mustExist: true,
          expectedType: "file",
        });
      } catch (error) {
        return res.status(error.statusCode || 400).json({
          ok: false,
          code: error.code || "ARTIFACT_PATH_INVALID",
          error: error.message,
        });
      }
    }

    const opened = await revealFile(resolved.file);
    if (!opened?.ok) {
      return res.status(500).json({
        ok: false,
        code: "ARTIFACT_REVEAL_FAILED",
        error: `调用系统资源管理器失败：${opened?.error || "unknown error"}`,
      });
    }

    return res.json({
      ok: true,
      data: {
        name: resolved.name,
        reference: resolved.reference,
        source: resolved.source,
      },
    });
  });

  router.post("/tabs/:id/artifacts/reveal", async (req, res) => {
    const tab = store.getTab(req.params.id);
    if (!tab) return res.status(404).json({ ok: false, error: "故事点不存在" });
    if (!isTrustedPerformanceResourceRequest(req)) {
      return res.status(403).json({ ok: false, code: "ARTIFACT_REVEAL_LOCAL_ONLY", error: "资源管理器定位只能由 Gateway 本机页面调用" });
    }
    const reference = String(req.body?.ref || "").trim();
    if (!/^storydev:\/(?!\/)/i.test(reference) || reference.includes("\\") || reference.includes("\0")) {
      return res.status(400).json({ ok: false, code: "ARTIFACT_REFERENCE_INVALID", error: "只允许定位当前故事点的 storydev:/ 附件" });
    }

    let target;
    let stat;
    try {
      const storage = store.getStoryStoragePaths(tab, { create: false, persist: false });
      const relative = reference.slice("storydev:/".length);
      if (!relative || path.isAbsolute(relative) || relative.split("/").some((segment) => segment === "." || segment === "..")) {
        throw Object.assign(new Error("附件引用无效"), { code: "ARTIFACT_REFERENCE_INVALID" });
      }
      target = path.resolve(storage.storyDirectory, relative);
      store.validateStoryStorageTarget(tab, target, { mustExist: true });
      stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw Object.assign(new Error("附件不是普通文件或目录"), { code: "ARTIFACT_TYPE_UNSUPPORTED" });
      }
    } catch (error) {
      const missing = error?.code === "STORY_STORAGE_PATH_MISSING" || error?.code === "ENOENT";
      return res.status(missing ? 404 : 400).json({
        ok: false,
        code: missing ? "ARTIFACT_NOT_FOUND" : (error?.code || "ARTIFACT_REFERENCE_INVALID"),
        error: missing ? "附件不存在" : "附件引用无效或超出当前故事点目录",
      });
    }

    const opened = await revealFile(target);
    if (!opened?.ok) {
      return res.status(500).json({ ok: false, code: "ARTIFACT_REVEAL_FAILED", error: `调用系统资源管理器失败：${opened?.error || "unknown error"}` });
    }
    return res.json({
      ok: true,
      data: {
        name: path.basename(target),
        reference,
        kind: stat.isDirectory() ? "folder" : "file",
      },
    });
  });

  // Chromium 在 Windows 资源管理器“复制文件”场景经常不给 ClipboardEvent.files。
  // 此端点不接收任意客户端路径，而是由当前本机 Gateway 直接读取系统 FileDropList，
  // 再把普通文件复制进当前故事点隔离目录，保留真实 basename 供消息 UI 展示。
  router.post("/tabs/:id/attachments/import-clipboard", async (req, res) => {
    const tab = store.getTab(req.params.id);
    if (!tab) return res.status(404).json({ ok: false, error: "故事点不存在" });
    if (!isTrustedPerformanceResourceRequest(req)) {
      return res.status(403).json({ ok: false, code: "CLIPBOARD_LOCAL_ONLY", error: "系统剪贴板附件只能由 Gateway 本机页面导入" });
    }
    let storage;
    try {
      storage = store.getStoryStoragePaths(tab, { create: true, persist: false });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ ok: false, error: error.message });
    }

    let clipboardPaths = [];
    try { clipboardPaths = readClipboardPaths(); } catch {}
    const sources = Array.from(new Set(Array.isArray(clipboardPaths) ? clipboardPaths : [])).slice(0, 50);
    if (!sources.length) return res.json({ ok: true, data: [], skipped: [] });
    const batchId = `${Date.now()}-${randomUUID().slice(0, 12)}`;
    const chatRoot = path.join(storage.attachmentDirectory, "chat-attachments");
    const batchDirectory = path.join(chatRoot, batchId);
    try {
      store.validateStoryStorageTarget(tab, chatRoot, {
        baseDirectory: storage.attachmentDirectory,
        createDirectory: true,
        expectedType: "directory",
      });
      store.validateStoryStorageTarget(tab, batchDirectory, {
        baseDirectory: chatRoot,
        createDirectory: true,
        expectedType: "directory",
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ ok: false, error: error.message });
    }

    const imported = [];
    const skipped = [];
    let totalBytes = 0;
    const maxBytes = 1024 * 1024 * 1024;
    for (const sourceValue of sources) {
      if (!String(sourceValue || "").trim()) continue;
      const source = path.resolve(String(sourceValue));
      const originalName = path.basename(source);
      try {
        const sourceStat = fs.lstatSync(source);
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
          skipped.push({ name: originalName || sourceValue, reason: sourceStat.isDirectory() ? "文件夹请使用拖拽上传" : "不是普通文件" });
          continue;
        }
        if (totalBytes + sourceStat.size > maxBytes) {
          skipped.push({ name: originalName, reason: "本次剪贴板附件总大小超过 1 GB" });
          continue;
        }
        const storageName = safeLeafName(originalName);
        const destination = uniqueDestination(batchDirectory, storageName);
        store.validateStoryStorageTarget(tab, destination, {
          baseDirectory: batchDirectory,
          mustExist: false,
        });
        await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        store.validateStoryStorageTarget(tab, destination, {
          baseDirectory: batchDirectory,
          mustExist: true,
          expectedType: "file",
        });
        totalBytes += sourceStat.size;
        const relative = path.relative(storage.storyDirectory, destination).split(path.sep).join("/");
        imported.push({
          id: randomUUID(),
          name: originalName,
          originalName,
          storageName: path.basename(destination),
          path: destination,
          relPath: `storydev:/${relative}`,
          kind: "file",
          size: sourceStat.size,
          source: "system-clipboard",
          scope: "message",
        });
      } catch (error) {
        skipped.push({ name: originalName || sourceValue, reason: error?.code === "ENOENT" ? "源文件不存在" : "复制失败" });
      }
    }
    return res.json({ ok: true, data: imported, skipped });
  });

  return router;
}

export default createDevbenchArtifactsRouter();
