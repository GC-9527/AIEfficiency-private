const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

let tray = null;

function initTray(mainWindow, app) {
  const iconPath = path.join(__dirname, "icons", "icon.png");
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("AI 工作提效");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "打开主窗口",
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  return tray;
}

module.exports = { initTray };
