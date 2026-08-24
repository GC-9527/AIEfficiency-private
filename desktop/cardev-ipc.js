/**
 * CarDev 桌面原生能力 IPC 模块（独立，与 main.js 解耦）
 *
 * 仅提供前端 cardev 模块需要的原生功能：
 *   - 文件/目录选择对话框
 *   - shell.showItemInFolder
 *   - 在外部应用中打开 URL / 文件
 *   - 查询常用 userData 路径
 *
 * 使用方式（main.js）:
 *   require("./cardev-ipc.js").register();
 */
const { app, ipcMain, dialog, shell, BrowserWindow } = require("electron");
const path = require("path");
const { normalizeExternalUrl } = require("./external-url.js");

function getCallerWindow(event) {
  try {
    const wc = event?.sender;
    if (!wc) return null;
    return BrowserWindow.fromWebContents(wc);
  } catch { return null; }
}

function register() {
  // 选择单个文件
  ipcMain.handle("cardev:pick-file", async (event, opts = {}) => {
    const win = getCallerWindow(event);
    const filters = Array.isArray(opts.filters) && opts.filters.length
      ? opts.filters
      : [{ name: "All files", extensions: ["*"] }];
    const result = await dialog.showOpenDialog(win || undefined, {
      title: opts.title || "选择文件",
      defaultPath: opts.defaultPath || undefined,
      properties: ["openFile"],
      filters,
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  // 选择文件夹
  ipcMain.handle("cardev:pick-folder", async (event, opts = {}) => {
    const win = getCallerWindow(event);
    const result = await dialog.showOpenDialog(win || undefined, {
      title: opts.title || "选择文件夹",
      defaultPath: opts.defaultPath || undefined,
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  // 在文件资源管理器定位指定文件 / 文件夹
  ipcMain.handle("cardev:show-in-folder", async (_e, target) => {
    if (!target) return { ok: false, error: "target required" };
    try { shell.showItemInFolder(target); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // 在外部默认应用中打开
  ipcMain.handle("cardev:open-external", async (_e, target) => {
    if (!target) return { ok: false, error: "target required" };
    const externalUrl = normalizeExternalUrl(target);
    if (!externalUrl) return { ok: false, error: "only canonical HTTP(S) URLs are allowed" };
    try {
      await shell.openExternal(externalUrl);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // 返回 cardev 模块常用路径（让前端可以显示 / 跳转）
  ipcMain.handle("cardev:get-paths", () => {
    const userData = app.getPath("userData");
    return {
      ok: true,
      userData,
      cardev: path.join(userData, "cardev"),
      logs: path.join(userData, "logs"),
      temp: app.getPath("temp"),
    };
  });
}

module.exports = { register };
