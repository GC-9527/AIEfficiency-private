const INSTALL_PACKAGE_PATH = /(?<![:/\\])(?:storydev:\/|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/]|\.{1,2}[\\/]|(?:[A-Za-z0-9_@.+()-]+[\\/])+)[^\r\n`"'<>|?*]*?\.(?:apk|apks|aab|xapk|hap)\b/giu;

function normalizedKey(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

export function installPackageName(value) {
  const segments = String(value || "").replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || String(value || "");
}

export function extractInstallPackagePaths(content, limit = 8) {
  const text = String(content || "");
  const result = [];
  const seen = new Set();
  for (const match of text.matchAll(INSTALL_PACKAGE_PATH)) {
    const value = String(match[0] || "").trim();
    if (value.includes("://")) continue;
    const key = normalizedKey(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}
