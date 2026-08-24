const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("serviceControl", {
  getState: () => ipcRenderer.invoke("state:get"),
  start: (profileId) => ipcRenderer.invoke("control:start", profileId),
  stop: (profileId) => ipcRenderer.invoke("control:stop", profileId),
  restart: (profileId) => ipcRenderer.invoke("control:restart", profileId),
  forceReleasePort: (profileId, preferredPort) => ipcRenderer.invoke("control:forceReleasePort", profileId, preferredPort),
  openPanel: (profileId) => ipcRenderer.invoke("control:openPanel", profileId),
  openWebTerminal: (profileId) => ipcRenderer.invoke("control:openWebTerminal", profileId),
  openDesktopTerminal: (profileId) => ipcRenderer.invoke("control:openDesktopTerminal", profileId),
  openLogs: (profileId) => ipcRenderer.invoke("control:openLogs", profileId),
  openRepo: (profileId) => ipcRenderer.invoke("control:openRepo", profileId),
  chooseRepo: (profileId) => ipcRenderer.invoke("control:chooseRepo", profileId),
  addDevelopment: () => ipcRenderer.invoke("control:addDevelopment"),
  removeDevelopment: (profileId) => ipcRenderer.invoke("control:removeDevelopment", profileId),
  syncToProduction: (profileId, options) => ipcRenderer.invoke("control:syncToProduction", profileId, options),
  chooseDesktopRuntime: (profileId) => ipcRenderer.invoke("control:chooseDesktopRuntime", profileId),
  openDesktopRuntime: () => ipcRenderer.invoke("control:openDesktopRuntime"),
  syncToDesktopRuntime: (profileId, options) => ipcRenderer.invoke("control:syncToDesktopRuntime", profileId, options),
  startBuild: (profileId, targets) => ipcRenderer.invoke("build:start", profileId, targets),
  exitAll: () => ipcRenderer.invoke("control:exitAll"),
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
  onBuildProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("build:progress", listener);
    return () => ipcRenderer.removeListener("build:progress", listener);
  },
});
