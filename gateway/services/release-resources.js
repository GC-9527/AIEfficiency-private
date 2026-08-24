import fs from "fs";
import path from "path";

const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".secrets",
  ".tmp",
  "__tests__",
  "fixture",
  "fixtures",
  "node_modules",
  "tempfiles",
  "test",
  "tests",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".7z",
  ".gz",
  ".jks",
  ".jar",
  ".key",
  ".keystore",
  ".mobileprovision",
  ".p12",
  ".pem",
  ".pfx",
  ".rar",
  ".tar",
  ".tgz",
  ".zip",
]);

const BLOCKED_FILE_NAMES = new Set([
  ".env",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "service-account.json",
]);

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|["'\s])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"']*/m;
const MOBILE_NUMBER_PATTERN = /(^|\D)1[3-9]\d{9}(?=\D|$)/;

function isBlockedFileName(name) {
  const lower = name.toLowerCase();
  return BLOCKED_FILE_NAMES.has(lower)
    || lower.startsWith(".env.")
    || BLOCKED_EXTENSIONS.has(path.extname(lower));
}

function containsPrivateKey(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile() || stat.size > 1024 * 1024) return false;
  try { return PRIVATE_KEY_PATTERN.test(fs.readFileSync(filePath, "utf8")); } catch { return false; }
}

function copySafeTree(source, destination, skipped, relative = "") {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    const src = path.join(source, entry.name);
    const dest = path.join(destination, entry.name);

    if (entry.isSymbolicLink()) {
      skipped.push({ path: rel, reason: "symbolic-link" });
      continue;
    }
    if (entry.isDirectory()) {
      if (BLOCKED_DIRECTORIES.has(entry.name.toLowerCase())) {
        skipped.push({ path: rel, reason: "blocked-directory" });
        continue;
      }
      copySafeTree(src, dest, skipped, rel);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isBlockedFileName(entry.name) || containsPrivateKey(src)) {
      skipped.push({ path: rel, reason: "sensitive-file" });
      continue;
    }
    fs.copyFileSync(src, dest);
  }
}

function releaseMarketConfig() {
  return {
    _comment: "Release template. Add machine-specific values after installation.",
    projects: [],
  };
}

export function prepareReleaseResources(repoRoot, destinationRoot) {
  const skillsSource = path.join(repoRoot, "skills");
  const configsSource = path.join(repoRoot, "configs");
  const skillsDestination = path.join(destinationRoot, "skills");
  const configsDestination = path.join(destinationRoot, "configs");

  if (!fs.existsSync(skillsSource)) throw new Error(`Skills source not found: ${skillsSource}`);
  if (!fs.existsSync(configsSource)) throw new Error(`Configs source not found: ${configsSource}`);

  fs.rmSync(skillsDestination, { recursive: true, force: true });
  fs.rmSync(configsDestination, { recursive: true, force: true });

  const skipped = [];
  copySafeTree(skillsSource, skillsDestination, skipped);
  fs.mkdirSync(configsDestination, { recursive: true });

  const deviceProfiles = path.join(configsSource, "device-profiles.json");
  if (fs.existsSync(deviceProfiles)) {
    fs.copyFileSync(deviceProfiles, path.join(configsDestination, "device-profiles.json"));
  }
  fs.writeFileSync(
    path.join(configsDestination, "market-projects.json"),
    `${JSON.stringify(releaseMarketConfig(), null, 2)}\n`,
    "utf8",
  );

  const violations = findReleaseResourceViolations(destinationRoot);
  if (violations.length) {
    throw new Error(`Unsafe release resources: ${violations.join("; ")}`);
  }

  return { skipped };
}

export function findReleaseResourceViolations(root) {
  const violations = [];
  const skillsRoot = path.join(root, "skills");
  const configsRoot = path.join(root, "configs");

  const walk = (dir, relative = "") => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        violations.push(`symbolic link: ${rel}`);
      } else if (entry.isDirectory()) {
        if (BLOCKED_DIRECTORIES.has(entry.name.toLowerCase())) violations.push(`blocked directory: ${rel}`);
        else walk(full, rel);
      } else if (entry.isFile() && (isBlockedFileName(entry.name) || containsPrivateKey(full))) {
        violations.push(`sensitive file: ${rel}`);
      }
    }
  };
  walk(skillsRoot, "skills");

  if (!fs.existsSync(configsRoot)) {
    violations.push("configs directory missing");
    return violations;
  }
  const configFiles = fs.readdirSync(configsRoot, { withFileTypes: true });
  for (const entry of configFiles) {
    if (!entry.isFile() || !["device-profiles.json", "market-projects.json"].includes(entry.name)) {
      violations.push(`unexpected config: ${entry.name}`);
    }
  }

  const marketPath = path.join(configsRoot, "market-projects.json");
  try {
    const text = fs.readFileSync(marketPath, "utf8");
    const config = JSON.parse(text);
    if (!Array.isArray(config.projects) || config.projects.length !== 0) {
      violations.push("market-projects.json must contain an empty projects array");
    }
    if (Object.hasOwn(config, "dingtalkMsgConfig")) {
      violations.push("market-projects.json contains notification recipients");
    }
    if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(text)) {
      violations.push("market-projects.json contains an absolute local path");
    }
    if (MOBILE_NUMBER_PATTERN.test(text)) {
      violations.push("market-projects.json contains a mobile number");
    }
  } catch (error) {
    violations.push(`invalid market-projects.json: ${error.message}`);
  }

  return violations;
}
