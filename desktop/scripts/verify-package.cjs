"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const RESOLVABLE_EXTENSIONS = [".js", ".cjs", ".mjs", ".json"];
const WALK_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tmp",
  "dist",
  "gateway-bundled",
  "node-runtime",
  "node_modules",
]);

function normalizeRelative(filePath) {
  return String(filePath || "")
    .replace(/^[\\/]+/, "")
    .replace(/\\/g, "/");
}

function globToRegExp(pattern) {
  const normalized = normalizeRelative(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function packageFilePatterns(buildFiles) {
  return (Array.isArray(buildFiles) ? buildFiles : [])
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim());
}

function isMatchedByBuildFiles(relativePath, patterns) {
  const normalized = normalizeRelative(relativePath);
  let included = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    if (globToRegExp(pattern).test(normalized)) included = !excluded;
  }
  return included;
}

function listDeclaredScripts(appDir, patterns) {
  const scripts = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && WALK_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const relativePath = normalizeRelative(path.relative(appDir, absolutePath));
      if (isMatchedByBuildFiles(relativePath, patterns)) scripts.push(relativePath);
    }
  }
  walk(appDir);
  return scripts;
}

function extractStaticLocalDependencies(source) {
  const dependencies = new Set();
  const patterns = [
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      if (match[1].startsWith(".")) dependencies.add(match[1]);
    }
  }
  return [...dependencies];
}

function resolveLocalDependency(parentFile, specifier) {
  const basePath = path.resolve(path.dirname(parentFile), specifier);
  const candidates = [
    basePath,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => path.join(basePath, `index${extension}`)),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || "";
}

function relativePathInside(appDir, absolutePath) {
  const relativePath = normalizeRelative(path.relative(appDir, absolutePath));
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`Packaged local dependency resolves outside the Desktop app directory: ${absolutePath}`);
  }
  return relativePath;
}

function verifyPackageConfig(appDir = path.resolve(__dirname, "..")) {
  const resolvedAppDir = path.resolve(appDir);
  const packagePath = path.join(resolvedAppDir, "package.json");
  const packageConfig = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const patterns = packageFilePatterns(packageConfig.build?.files);
  if (patterns.length === 0) {
    throw new Error("desktop/package.json build.files must contain an explicit packaged-file allowlist.");
  }

  const mainFile = normalizeRelative(packageConfig.main || "main.js");
  if (!isMatchedByBuildFiles(mainFile, patterns)) {
    throw new Error(`Desktop entry point is not matched by build.files: ${mainFile}`);
  }

  const pendingScripts = [...new Set([mainFile, ...listDeclaredScripts(resolvedAppDir, patterns)])];
  const requiredFiles = new Set(pendingScripts);
  const inspectedScripts = new Set();
  const dependencyEdges = [];

  while (pendingScripts.length > 0) {
    const parentRelative = pendingScripts.shift();
    if (inspectedScripts.has(parentRelative)) continue;
    inspectedScripts.add(parentRelative);

    const parentAbsolute = path.join(resolvedAppDir, parentRelative);
    if (!fs.existsSync(parentAbsolute)) {
      throw new Error(`Packaged script does not exist in the source tree: ${parentRelative}`);
    }

    const source = fs.readFileSync(parentAbsolute, "utf8");
    for (const specifier of extractStaticLocalDependencies(source)) {
      const dependencyAbsolute = resolveLocalDependency(parentAbsolute, specifier);
      if (!dependencyAbsolute) {
        throw new Error(`Cannot resolve local dependency ${specifier} required by ${parentRelative}`);
      }
      const dependencyRelative = relativePathInside(resolvedAppDir, dependencyAbsolute);
      if (!isMatchedByBuildFiles(dependencyRelative, patterns)) {
        throw new Error(
          `Local dependency is required by ${parentRelative} but is not matched by build.files: `
          + `${dependencyRelative}. Add it to desktop/package.json build.files.`,
        );
      }
      requiredFiles.add(dependencyRelative);
      dependencyEdges.push([parentRelative, dependencyRelative]);
      if (SCRIPT_EXTENSIONS.has(path.extname(dependencyRelative).toLowerCase())) {
        pendingScripts.push(dependencyRelative);
      }
    }
  }

  return {
    appDir: resolvedAppDir,
    dependencyEdges,
    inspectedScripts: [...inspectedScripts].sort(),
    packageConfig,
    requiredFiles: [...requiredFiles].sort(),
  };
}

function verifyPackagedEntries(verification, packagedEntries, sourceLabel = "app.asar") {
  const entries = new Set(
    [...packagedEntries].map((entry) => normalizeRelative(entry)),
  );
  const missing = verification.requiredFiles.filter((relativePath) => !entries.has(relativePath));
  if (missing.length > 0) {
    throw new Error(
      `${sourceLabel} is missing required Desktop runtime module(s): ${missing.join(", ")}`,
    );
  }
  return verification;
}

function verifyPackagedApp(appDir, appOutDir) {
  const verification = verifyPackageConfig(appDir);
  const resourceRoots = [
    path.join(appOutDir, "resources"),
    path.join(appOutDir, "Contents", "Resources"),
  ];

  for (const resourcesDir of resourceRoots) {
    const asarPath = path.join(resourcesDir, "app.asar");
    if (fs.existsSync(asarPath)) {
      const { listPackage } = require("@electron/asar");
      return verifyPackagedEntries(verification, listPackage(asarPath), asarPath);
    }

    const unpackedAppDir = path.join(resourcesDir, "app");
    if (fs.existsSync(unpackedAppDir)) {
      const entries = verification.requiredFiles.filter((relativePath) =>
        fs.existsSync(path.join(unpackedAppDir, relativePath)));
      return verifyPackagedEntries(verification, entries, unpackedAppDir);
    }
  }

  throw new Error(`Cannot find packaged Desktop app.asar/resources under: ${appOutDir}`);
}

function printSuccess(verification, label) {
  console.log(
    `[desktop-package] ${label}: ${verification.inspectedScripts.length} script(s), `
    + `${verification.dependencyEdges.length} local dependency edge(s) verified.`,
  );
}

if (require.main === module) {
  try {
    printSuccess(verifyPackageConfig(), "package manifest OK");
  } catch (error) {
    console.error(`[desktop-package] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  extractStaticLocalDependencies,
  isMatchedByBuildFiles,
  printSuccess,
  verifyPackageConfig,
  verifyPackagedApp,
  verifyPackagedEntries,
};
