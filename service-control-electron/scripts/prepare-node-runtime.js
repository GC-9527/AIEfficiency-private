const fs = require("fs");
const path = require("path");

const controllerDir = path.resolve(__dirname, "..");
const destRoot = path.join(controllerDir, "node-runtime");
const sourceNode = process.execPath;

if (!fs.existsSync(sourceNode)) {
  throw new Error(`Current Node runtime not found: ${sourceNode}`);
}

fs.rmSync(destRoot, { recursive: true, force: true });

if (process.platform === "win32") {
  fs.mkdirSync(destRoot, { recursive: true });
  fs.copyFileSync(sourceNode, path.join(destRoot, "node.exe"));
} else {
  const binDir = path.join(destRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const destNode = path.join(binDir, "node");
  fs.copyFileSync(sourceNode, destNode);
  fs.chmodSync(destNode, 0o755);
}

fs.writeFileSync(path.join(destRoot, "runtime.json"), JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  version: process.version,
  modules: process.versions.modules,
}, null, 2));

console.log(`Prepared Node runtime: ${destRoot}`);
