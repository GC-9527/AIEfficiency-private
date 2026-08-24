"use strict";

const crypto = require("crypto");
const path = require("path");

function sourceInstanceKey(sourceRoot, platform = process.platform) {
  const normalizedRoot = String(sourceRoot || "").trim();
  if (!normalizedRoot) throw new Error("A source repository root is required for the Service Control instance identity.");
  const stableRoot = platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  return crypto.createHash("sha256").update(stableRoot).digest("hex").slice(0, 12);
}

function sourceUserDataPath(appDataPath, sourceRoot, platform = process.platform) {
  if (!appDataPath) throw new Error("Electron appData path is required for the Service Control instance identity.");
  return path.join(appDataPath, `aiefficiency-service-control-dev-${sourceInstanceKey(sourceRoot, platform)}`);
}

module.exports = {
  sourceInstanceKey,
  sourceUserDataPath,
};
