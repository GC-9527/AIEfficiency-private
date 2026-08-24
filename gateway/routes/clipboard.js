import { Router } from "express";
import { readClipboardFilePaths } from "../services/clipboard-files.js";
import { isTrustedPerformanceResourceRequest } from "../services/performance-resource-local-access.js";

export function createClipboardRouter({ readClipboardPaths = readClipboardFilePaths } = {}) {
  const router = Router();

  // 系统剪贴板属于 Gateway 主机，只允许该主机上的页面读取，避免向局域网暴露绝对路径。
  router.get("/files", (req, res) => {
    if (!isTrustedPerformanceResourceRequest(req)) {
      return res.status(403).json({ success: false, code: "CLIPBOARD_LOCAL_ONLY", error: "系统剪贴板文件只能由 Gateway 本机页面读取" });
    }
    return res.json({ success: true, data: readClipboardPaths() });
  });

  return router;
}

export default createClipboardRouter();
