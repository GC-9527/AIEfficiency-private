const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
  gatewayUrl: "http://localhost:3001",
  // 模式选择
  selectMode: (config) => ipcRenderer.send("mode-selected", config),
  getConfig: () => ipcRenderer.invoke("get-connection-config"),
  switchMode: (config) => ipcRenderer.invoke("switch-mode", config),
  restartForDeploymentRole: (role) => ipcRenderer.invoke("restart-for-deployment-role", role),
  switchClientToStandalone: () => ipcRenderer.invoke("switch-client-to-standalone"),
  // 网关版本更新
  getLocalVersion: () => ipcRenderer.invoke("get-local-version"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  doUpdate: () => ipcRenderer.invoke("do-update"),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  // 桌面版更新
  getDesktopVersion: () => ipcRenderer.invoke("get-desktop-version"),
  checkDesktopUpdate: () => ipcRenderer.invoke("check-desktop-update"),
  doDesktopUpdate: () => ipcRenderer.invoke("do-desktop-update"),
  // 菜单触发事件
  onTriggerUpdateCheck: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("trigger-update-check", handler);
    return () => ipcRenderer.removeListener("trigger-update-check", handler);
  },
  // CarDev 模块原生能力（仅 desktop 模式可用）
  cardev: {
    pickFile: (opts) => ipcRenderer.invoke("cardev:pick-file", opts),
    pickFolder: (opts) => ipcRenderer.invoke("cardev:pick-folder", opts),
    showInFolder: (target) => ipcRenderer.invoke("cardev:show-in-folder", target),
    openExternal: (target) => ipcRenderer.invoke("cardev:open-external", target),
    getPaths: () => ipcRenderer.invoke("cardev:get-paths"),
  },
});
