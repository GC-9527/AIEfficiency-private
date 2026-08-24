"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeNodeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertPinnedNodeRuntime(options = {}) {
  const repoRoot = path.resolve(
    options.repoRoot || path.join(__dirname, "..", ".."),
  );
  const expectedVersion = normalizeNodeVersion(
    fs.readFileSync(path.join(repoRoot, ".node-version"), "utf8"),
  );
  const actualVersion = normalizeNodeVersion(
    options.actualNodeVersion || process.version,
  );
  const problems = [];

  if (!expectedVersion) {
    problems.push(".node-version is empty");
  }
  if (actualVersion !== expectedVersion) {
    problems.push(
      `build Node is ${actualVersion || "unknown"}, expected ${expectedVersion || "unknown"}`,
    );
  }

  const projects = ["desktop", "gateway"];
  for (const project of projects) {
    const packagePath = path.join(repoRoot, project, "package.json");
    const lockPath = path.join(repoRoot, project, "package-lock.json");
    const packageConfig = readJson(packagePath);
    const lockConfig = readJson(lockPath);
    const packageEngine = normalizeNodeVersion(packageConfig.engines?.node);
    const lockEngine = normalizeNodeVersion(
      lockConfig.packages?.[""]?.engines?.node,
    );

    if (packageEngine !== expectedVersion) {
      problems.push(
        `${project}/package.json engines.node is ${packageEngine || "missing"}, expected ${expectedVersion}`,
      );
    }
    if (lockEngine !== expectedVersion) {
      problems.push(
        `${project}/package-lock.json root engines.node is ${lockEngine || "missing"}, expected ${expectedVersion}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Pinned Node runtime policy violation:\n- ${problems.join("\n- ")}`,
    );
  }

  return {
    actualVersion,
    expectedVersion,
    modules: String(process.versions.modules || ""),
  };
}

function printRuntimePolicySuccess(policy, label = "runtime policy OK") {
  console.log(
    `[desktop-runtime] ${label}: Node ${policy.actualVersion} `
    + `(ABI ${policy.modules || "unknown"})`,
  );
}

module.exports = {
  assertPinnedNodeRuntime,
  normalizeNodeVersion,
  printRuntimePolicySuccess,
};
