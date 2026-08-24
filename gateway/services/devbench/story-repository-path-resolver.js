import path from "node:path";
import { inspectWorkspaceBundleIntegrity } from "./workspace-bundle.js";

/**
 * Resolve base-repository paths mentioned by a user to this story's managed
 * worktree. The visible user text is never changed; only provider execution
 * content receives the deterministic replacement.
 */

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE = /^(?:\\\\|\/\/)/;

function cleanLine(value, limit = 2_000) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function stripTrailingSeparators(value) {
  if (/^[A-Za-z]:\/$/.test(value) || value === "/" || value === "//") return value;
  return value.replace(/\/+$/, "");
}

export function normalizeRepositoryPath(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  raw = raw.replace(/^["'`]+|["'`]+$/g, "").replace(/\\/g, "/");
  // Windows extended-length/device namespace aliases must resolve to the same
  // identity as their normal drive/UNC form. Otherwise \\?\UNC\... can bypass
  // a registered base repository root entirely.
  if (/^\/\/[?.]\/UNC\//i.test(raw) || /^\/\?\?\/UNC\//i.test(raw)) {
    raw = `//${raw.slice(8)}`;
  } else if (/^\/\/[?.]\/(?=[A-Za-z]:\/)/.test(raw) || /^\/\?\?\/(?=[A-Za-z]:\/)/.test(raw)) {
    raw = raw.slice(4);
  }
  const unc = raw.startsWith("//");
  raw = raw.replace(/\/{2,}/g, "/");
  if (unc) raw = `/${raw}`;
  return stripTrailingSeparators(raw);
}

function isWindowsLike(value) {
  return WINDOWS_ABSOLUTE.test(String(value || "")) || UNC_ABSOLUTE.test(String(value || ""));
}

function windowsVolumeRootForReference(value) {
  const canonical = canonicalRepositoryPath(value);
  return isWindowsLike(canonical)
    ? canonicalRepositoryPath(path.win32.parse(canonical).root)
    : "";
}

function canonicalRepositoryPath(value) {
  const normalized = normalizeRepositoryPath(value);
  if (!normalized) return "";
  if (isWindowsLike(normalized)) {
    const canonical = path.win32.normalize(normalized.replace(/\//g, "\\"));
    const parsed = path.win32.parse(canonical);
    const tail = canonical.slice(parsed.root.length)
      .split("\\")
      // Standard Win32 file APIs ignore trailing dots/spaces in components.
      // Canonicalize that alias so `Repo.` cannot bypass a registered `Repo`.
      .map((segment) => segment.replace(/[. ]+$/g, ""))
      .join("\\");
    return `${parsed.root}${tail}`;
  }
  if (normalized.startsWith("/")) return path.posix.normalize(normalized);
  return normalized;
}

function pathKey(value) {
  const normalized = normalizeRepositoryPath(canonicalRepositoryPath(value));
  return isWindowsLike(normalized) ? normalized.toLowerCase() : normalized;
}

function pathInside(child, root) {
  const childKey = pathKey(child);
  const rootKey = pathKey(root);
  return !!childKey && !!rootKey && (childKey === rootKey || childKey.startsWith(`${rootKey}/`));
}

function pathsOverlap(left, right) {
  return pathInside(left, right) || pathInside(right, left);
}

function isAbsoluteRepositoryPath(value) {
  const canonical = canonicalRepositoryPath(value);
  return !!canonical && (isWindowsLike(canonical) || canonical.startsWith("/"));
}

function managedEntryPathStyleReasons(entry, target, worktreeRoot) {
  const sources = [entry?.basePath, entry?.baseRepositoryPath]
    .map(canonicalRepositoryPath)
    .filter(Boolean);
  const targetPath = canonicalRepositoryPath(target);
  const rootPath = canonicalRepositoryPath(worktreeRoot);
  if (!sources.length) return ["登记的 worktree 缺少可验证的基础仓库绝对路径"];
  const windowsSource = sources.some(isWindowsLike);
  const posixSource = sources.some((source) => source.startsWith("/") && !isWindowsLike(source));
  const mixedSourceStyles = windowsSource && posixSource;
  const valid = !mixedSourceStyles && (windowsSource
    ? isWindowsLike(targetPath) && isWindowsLike(rootPath)
    : posixSource
      ? targetPath.startsWith("/") && rootPath.startsWith("/")
      : false);
  return valid ? [] : [
    windowsSource
      ? "Windows 基础仓库只允许 drive-absolute 或 UNC worktree 路径，禁止当前驱动器隐式路径"
      : "POSIX 基础仓库只允许以 / 开头的绝对 worktree 路径",
  ];
}

function memoizedPathCallbacks(pathExists, realPath) {
  const existsCache = new Map();
  const realCache = new Map();
  const keyOf = (candidate) => pathKey(candidate) || String(candidate || "");
  const cachedPathExists = typeof pathExists === "function" ? (candidate) => {
    const key = keyOf(candidate);
    if (!existsCache.has(key)) existsCache.set(key, !!pathExists(candidate));
    return existsCache.get(key);
  } : pathExists;
  const cachedRealPath = typeof realPath === "function" ? (candidate) => {
    const key = keyOf(candidate);
    if (!realCache.has(key)) {
      try { realCache.set(key, { ok: true, value: realPath(candidate) }); }
      catch (error) { realCache.set(key, { ok: false, error }); }
    }
    const cached = realCache.get(key);
    if (!cached.ok) throw cached.error;
    return cached.value;
  } : realPath;
  return { pathExists: cachedPathExists, realPath: cachedRealPath };
}

function physicalRepositoryPath(value, pathExists, realPath) {
  const canonical = canonicalRepositoryPath(value);
  if (!canonical || typeof realPath !== "function") return canonical;
  const windows = isWindowsLike(canonical);
  const pathApi = windows ? path.win32 : path.posix;
  let probe = canonical;
  const tail = [];
  for (let depth = 0; depth < 256; depth += 1) {
    const exists = typeof pathExists !== "function" || pathExists(probe);
    if (exists) {
      try {
        const physicalAncestor = canonicalRepositoryPath(realPath(probe));
        if (!physicalAncestor) return "";
        return canonicalRepositoryPath(pathApi.join(physicalAncestor, ...tail.reverse()));
      } catch {
        return "";
      }
    }
    const parent = pathApi.dirname(probe);
    if (!parent || pathKey(parent) === pathKey(probe)) return "";
    tail.push(pathApi.basename(probe));
    probe = parent;
  }
  return "";
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flexiblePathPatterns(root) {
  const normalized = normalizeRepositoryPath(root);
  if (!normalized) return [];
  let prefix = "";
  let body = normalized;
  if (body.startsWith("//")) {
    prefix = "[\\\\/]{2}";
    body = body.slice(2);
  } else if (body.startsWith("/")) {
    prefix = "[\\\\/]";
    body = body.slice(1);
  }
  const bodyPattern = body.split("/").filter(Boolean).map(escapeRegex).join("[\\\\/]+");
  const patterns = [`${prefix}${bodyPattern}`];
  if (normalized.startsWith("//")) {
    // \\?\UNC\server\share and \\.\UNC\server\share do not contain the
    // normal UNC root contiguously, so they need explicit variants.
    patterns.push(`[\\\\/]{2}[?.][\\\\/]UNC[\\\\/]+${bodyPattern}`);
    patterns.push(`[\\\\/]\\?\\?[\\\\/]UNC[\\\\/]+${bodyPattern}`);
  }
  return [...new Set(patterns)];
}

function expandDriveNamespaceStart(content, start, root) {
  if (!WINDOWS_ABSOLUTE.test(normalizeRepositoryPath(root)) || start < 4) return start;
  const prefix = String(content || "").slice(start - 4, start).replace(/\\/g, "/");
  return ["//?/", "//./", "/??/"].includes(prefix) ? start - 4 : start;
}

function rootMatches(content, root, windowsVolumeRoot = "") {
  const patterns = flexiblePathPatterns(root).map((pattern) => ({ pattern, driveImplicit: false }));
  const canonicalRoot = canonicalRepositoryPath(root);
  const candidateVolumeRoot = windowsVolumeRootForReference(canonicalRoot);
  if (candidateVolumeRoot && windowsVolumeRoot
    && pathKey(candidateVolumeRoot) === pathKey(windowsVolumeRoot)) {
    const volumeRelative = path.win32.relative(candidateVolumeRoot, canonicalRoot);
    for (const pattern of flexiblePathPatterns(`\\${volumeRelative}`)) {
      patterns.push({ pattern, driveImplicit: true });
    }
  }
  if (!patterns.length) return [];
  // The right boundary deliberately rejects letters, digits, dots, underscores
  // and dashes so D:\\repo never matches D:\\repo-old.
  const flags = isWindowsLike(root) ? "giu" : "gu";
  const matches = [];
  const seen = new Set();
  for (const { pattern, driveImplicit } of patterns) {
    const leftBoundary = driveImplicit ? "(^|[^A-Za-z0-9_.:\\\\/-])" : "(^|[^A-Za-z0-9_.-])";
    const matcher = new RegExp(`${leftBoundary}(${pattern})(?=$|[\\\\/\\s"'\x60<>()\\[\\]{},;，。；：:!?！？])`, flags);
    let match;
    while ((match = matcher.exec(String(content || ""))) !== null) {
      let start = match.index + match[1].length;
      start = expandDriveNamespaceStart(content, start, root);
      const end = match.index + match[1].length + match[2].length;
      const key = `${start}:${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ start, end, text: String(content || "").slice(start, end) });
      }
      if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
    }
  }
  return matches;
}

function driveRelativePathOccurrences(content) {
  const source = String(content || "");
  const matcher = /(^|[^A-Za-z0-9_.-])([A-Za-z]:(?![\\/\s])[^\r\n"'`<>]*)/gu;
  const occurrences = [];
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const start = match.index + match[1].length;
    occurrences.push({ start, end: start + match[2].length, text: match[2] });
    if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
  }
  return occurrences;
}

const RELATIVE_PATH_TOKEN_DELIMITER = /[\s"'`<>()\[\]{},;，。；：:!?！？（）【】《》「」『』“”‘’]/u;

function hasRelativeTraversalSegment(content) {
  const source = String(content || "");
  const matcher = /\.\.(?=$|[\\/])/gu;
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const previous = match.index > 0 ? source.charAt(match.index - 1) : "";
    if (!previous || previous === "\\" || previous === "/" || RELATIVE_PATH_TOKEN_DELIMITER.test(previous)) return true;
  }
  return false;
}

function relativeTraversalOccurrences(content) {
  const source = String(content || "");
  // Match the traversal segment itself, then validate its left token boundary.
  // Consuming only slash boundaries used to miss a very common form such as
  // `请处理 ..\\Base\\secret.txt`: the `..` was preceded by whitespace instead
  // of a slash, so an agent running in a sibling worktree could reach the base
  // repository directly.
  const matcher = /\.\.(?=$|[\\/])/gu;
  const occurrences = [];
  const seen = new Set();
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const segmentStart = match.index;
    const previous = segmentStart > 0 ? source.charAt(segmentStart - 1) : "";
    if (segmentStart > 0 && previous !== "\\" && previous !== "/" && !RELATIVE_PATH_TOKEN_DELIMITER.test(previous)) continue;
    let start = segmentStart;
    let end = segmentStart + match[0].length;
    if (previous === "\\" || previous === "/") start -= 1;
    while (start > 0 && !RELATIVE_PATH_TOKEN_DELIMITER.test(source.charAt(start - 1))) start -= 1;
    while (end < source.length && !RELATIVE_PATH_TOKEN_DELIMITER.test(source.charAt(end))) end += 1;
    const text = source.slice(start, end);
    if (!text || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(text)
      || isAbsoluteRepositoryPath(text)
      || /^[A-Za-z]:/u.test(text)) continue;
    const key = `${start}:${end}`;
    if (!seen.has(key)) {
      seen.add(key);
      occurrences.push({ start, end, text });
    }
    if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
  }
  return occurrences;
}

function absolutePathTokenEnd(content, start, minimumEnd) {
  const source = String(content || "");
  const closing = PAIRED_PATH_DELIMITERS.get(source.charAt(start - 1));
  if (closing) {
    const closingAt = source.indexOf(closing, minimumEnd);
    return closingAt >= minimumEnd ? closingAt : source.length;
  }
  let end = minimumEnd;
  // Unquoted Windows filenames may legally contain commas, semicolons,
  // brackets and most punctuation. Stopping there lets a later `\..` escape
  // the mapped root, so only whitespace or an actual quote terminates a token.
  while (end < source.length && !/[\s"'`]/u.test(source.charAt(end))) end += 1;
  return end;
}

function absolutePathOccurrences(content, windowsVolumeRoot = "") {
  const source = String(content || "");
  const occurrences = [];
  const seen = new Set();
  const add = (start, minimumEnd, canonicalOverride = "") => {
    if (start < 0 || minimumEnd <= start) return;
    const previous = source.charAt(start - 1);
    if (previous && /[A-Za-z0-9_.-]/.test(previous)) return;
    const end = absolutePathTokenEnd(source, start, minimumEnd);
    const raw = source.slice(start, end);
    const canonical = canonicalRepositoryPath(canonicalOverride || raw);
    if (!canonical || (!isWindowsLike(canonical) && !canonical.startsWith("/"))) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push({ start, end, text: raw, referencedPath: raw, canonicalReferencePath: canonical });
  };

  const driveMatcher = /[A-Za-z]:[\\/]/g;
  let match;
  while ((match = driveMatcher.exec(source)) !== null) {
    const start = expandDriveNamespaceStart(source, match.index, match[0]);
    add(start, match.index + match[0].length);
  }

  const uncMatcher = /(?:[\\/]{2}[?.][\\/]UNC[\\/]|[\\/]\?\?[\\/]UNC[\\/]|[\\/]{2})(?=[^\\/\s])/giu;
  while ((match = uncMatcher.exec(source)) !== null) {
    if (match[0] === "//" && source.charAt(match.index - 1) === ":") continue;
    add(match.index, match.index + match[0].length);
  }
  if (windowsVolumeRoot) {
    const rootRelativeMatcher = /(^|[^A-Za-z0-9_.:\\/-])([\\/](?![\\/])(?=[^\s\\/]))/gu;
    while ((match = rootRelativeMatcher.exec(source)) !== null) {
      const start = match.index + match[1].length;
      const end = absolutePathTokenEnd(source, start, start + match[2].length);
      const raw = source.slice(start, end);
      const expanded = path.win32.join(windowsVolumeRoot, raw.replace(/^[\\/]+/, ""));
      add(start, start + match[2].length, expanded);
      if (rootRelativeMatcher.lastIndex === match.index) rootRelativeMatcher.lastIndex += 1;
    }
  }
  // An arbitrary absolute/root-relative alias may itself contain spaces before
  // it reaches any registered repository root. Generate plausible unquoted
  // continuations before candidate matching so realPath sees `link name`, not
  // only the truncated `link` token.
  const expanded = [...occurrences];
  for (const occurrence of occurrences) {
    if (PAIRED_PATH_DELIMITERS.has(source.charAt(occurrence.start - 1))) continue;
    const lineEnds = [source.indexOf("\n", occurrence.end), source.indexOf("\r", occurrence.end)]
      .filter((index) => index >= 0);
    const lineEnd = lineEnds.length ? Math.min(...lineEnds) : source.length;
    const continuation = source.slice(occurrence.end, lineEnd);
    if (!/^\s+\S/u.test(continuation)) continue;
    const bounded = continuation;
    const ends = [];
    for (let index = 1; index < bounded.length; index += 1) {
      if (/\s/u.test(bounded.charAt(index)) && !/\s/u.test(bounded.charAt(index - 1))) ends.push(index);
    }
    ends.push(bounded.length);
    for (const continuationEnd of [...new Set(ends)]) {
      const end = occurrence.end + continuationEnd;
      const key = `${occurrence.start}:${end}`;
      if (seen.has(key)) continue;
      const rootRelativeOnCurrentVolume = /^[\\/](?![\\/])/u.test(occurrence.text)
        && WINDOWS_ABSOLUTE.test(occurrence.canonicalReferencePath);
      const canonical = canonicalRepositoryPath(rootRelativeOnCurrentVolume
        ? `${occurrence.canonicalReferencePath}${bounded.slice(0, continuationEnd)}`
        : source.slice(occurrence.start, end));
      if (!canonical) continue;
      seen.add(key);
      expanded.push({
        ...occurrence,
        end,
        text: source.slice(occurrence.start, end),
        referencedPath: source.slice(occurrence.start, end),
        canonicalReferencePath: canonical,
      });
    }
  }
  return expanded;
}

function activeWorktreeEntries(tab) {
  if (tab?.worktree?.managed !== true) return [];
  return (Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [])
    .filter((entry) => entry && entry.role !== "inactive" && entry.active !== false);
}

function currentStoryWindowsVolumeRoot(tab) {
  const entries = activeWorktreeEntries(tab);
  const primary = entries.find((entry) => entry.role === "primary") || entries[0];
  for (const candidate of [primary?.worktreePath, primary?.path, primary?.basePath, primary?.baseRepositoryPath]) {
    const canonical = canonicalRepositoryPath(candidate);
    if (isWindowsLike(canonical)) {
      const volumeRoot = windowsVolumeRootForReference(canonical);
      if (volumeRoot) return volumeRoot;
    }
  }
  return "";
}

function currentStoryPrimaryWorktreeRoot(tab) {
  const entries = activeWorktreeEntries(tab);
  const primary = entries.find((entry) => entry.role === "primary") || entries[0];
  return canonicalRepositoryPath(primary?.worktreePath || primary?.path);
}

function inactiveWorktreeEntries(tab) {
  return (Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [])
    .filter((entry) => entry && (entry.role === "inactive" || entry.active === false));
}

function mappingIdentity(entry, targetPath) {
  return [
    pathKey(entry?.gitCommonDir),
    pathKey(entry?.worktreePath || targetPath),
    String(entry?.repositoryId || "").trim(),
    String(entry?.baseProjectId || "").trim(),
  ].join("|");
}

function addKnownRoot(map, root, metadata = {}) {
  const normalized = normalizeRepositoryPath(root);
  const key = pathKey(normalized);
  if (!key || !normalized) return;
  const current = map.get(key) || { root: normalized, names: new Set(), sources: new Set() };
  if (metadata.name) current.names.add(cleanLine(metadata.name, 300));
  if (metadata.source) current.sources.add(metadata.source);
  map.set(key, current);
}

function protectedBaseAlertPaths(alert) {
  const repositories = Array.isArray(alert?.repositories) ? alert.repositories : [];
  if (!repositories.length) return Array.isArray(alert?.paths) ? alert.paths : [];
  const protectedKinds = new Set(["missing", "ambiguous", "stale-mapping"]);
  return repositories.flatMap((item) => {
    const kind = String(item?.kind || "");
    if (protectedKinds.has(kind)) return item?.path ? [item.path] : [];
    // An unsafe reference can originate from the current worktree itself. Its
    // display path must never become a persistent protected-base root, or the
    // next path-free message would make a healthy checkout poison itself.
    if (kind === "unsafe-path" && item?.basePath) return [item.basePath];
    return [];
  });
}

function baseIsolationReasons(sourcePath, targetPath, worktreeRoot, pathExists, realPath) {
  const source = canonicalRepositoryPath(sourcePath);
  const target = canonicalRepositoryPath(targetPath);
  const root = canonicalRepositoryPath(worktreeRoot || targetPath);
  if (!source || !target || !root) return [];
  const reasons = [];
  if (pathsOverlap(target, source) || pathsOverlap(root, source)) {
    reasons.push("登记的 worktree 与基础仓库目录重合、互相包含，未形成目录隔离");
  }
  if (typeof realPath === "function") {
    const physicalSource = physicalRepositoryPath(source, pathExists, realPath);
    const physicalTarget = physicalRepositoryPath(target, pathExists, realPath);
    const physicalRoot = physicalRepositoryPath(root, pathExists, realPath);
    if (physicalSource && physicalTarget && physicalRoot
      && (pathsOverlap(physicalTarget, physicalSource) || pathsOverlap(physicalRoot, physicalSource))) {
      reasons.push("登记的 worktree 真实位置指向基础仓库，未形成物理隔离");
    }
  }
  return [...new Set(reasons)];
}

function addMapping(map, sourcePath, targetPath, entry, pathExists, realPath, additionalReasons = []) {
  const source = normalizeRepositoryPath(sourcePath);
  const target = String(targetPath || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  const normalizedTarget = normalizeRepositoryPath(target);
  const sourceKey = pathKey(source);
  if (!sourceKey || !normalizedTarget) return;
  const worktreeRoot = String(entry?.worktreePath || target || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  const staleReasons = [
    ...additionalReasons,
    ...baseIsolationReasons(source, target, worktreeRoot, pathExists, realPath),
  ];
  if (worktreeRoot && !pathInside(target, worktreeRoot)) {
    staleReasons.push("映射目标超出该故事点登记的 worktree 根目录");
  }
  if (typeof pathExists === "function" && (!pathExists(target) || (worktreeRoot && !pathExists(worktreeRoot)))) {
    staleReasons.push("登记的 worktree 目录不存在");
  }
  if (typeof realPath === "function") {
    const physicalTarget = physicalRepositoryPath(target, pathExists, realPath);
    const physicalRoot = physicalRepositoryPath(worktreeRoot, pathExists, realPath);
    if (!physicalTarget || !physicalRoot || !pathInside(physicalTarget, physicalRoot)) {
      staleReasons.push("登记路径的真实位置越出当前故事点 worktree 根目录");
    }
  }
  const targetKey = pathKey(target);
  const current = map.get(sourceKey) || new Map();
  const existing = current.get(targetKey) || {
    source,
    target,
    worktreeRoot,
    identity: mappingIdentity(entry, target),
    name: cleanLine(entry?.name || entry?.repositoryId || entry?.baseProjectId || source, 300),
    repositoryId: cleanLine(entry?.repositoryId, 300),
    baseProjectId: cleanLine(entry?.baseProjectId, 300),
    branch: cleanLine(entry?.branch, 500),
    logicalBranch: cleanLine(entry?.logicalBranch, 500),
    mode: cleanLine(entry?.mode || "EDITABLE", 80),
    role: cleanLine(entry?.role || "extra", 80),
    staleReasons: [],
  };
  existing.staleReasons = [...new Set([...existing.staleReasons, ...staleReasons])];
  current.set(targetKey, existing);
  map.set(sourceKey, current);
}

function physicalPathKey(value, realPath) {
  let resolved = String(value || "").trim();
  if (!resolved) return "";
  if (typeof realPath === "function") {
    try { resolved = realPath(resolved) || resolved; } catch {}
  }
  return pathKey(resolved);
}

function collectTopology(tab, projects, allTabs, pathExists, realPath) {
  const aliases = new Map();
  const knownRoots = new Map();
  const allowedRoots = new Map();
  const staleRoots = new Map();
  const foreignRoots = new Map();
  const ownershipConflicts = new Map();
  const integrityConflicts = new Map();
  const conflictingPhysicalRoots = new Map();
  const activeEntries = activeWorktreeEntries(tab);
  const configuredPrimary = (Array.isArray(projects) ? projects : []).find((project) => (
    String(project?.id || "") === String(tab?.primaryProjectId || "")
  ));
  const localStoryConfigured = !!String(tab?.primaryProjectId || "").trim()
    || (tab?.mode === "local" && !!configuredPrimary);

  if (localStoryConfigured && tab?.worktree?.managed !== true) {
    const unsafeRoot = normalizeRepositoryPath(configuredPrimary?.path || `story-worktree:${tab?.id || "unknown"}`);
    integrityConflicts.set(pathKey(unsafeRoot) || unsafeRoot, {
      kind: "unsafe-worktree",
      priority: 55,
      root: unsafeRoot,
      entry: null,
      staleReasons: ["本地故事点尚未建立受管 worktree；禁止把基础工程作为 AI cwd"],
    });
  }
  const lifecycleStatus = String(tab?.worktreeStatus || "").trim();
  if (tab?.worktree?.managed === true
    && ["queued", "preparing", "error", "cleaned", "cleanup_partial"].includes(lifecycleStatus)) {
    const unsafeRoot = normalizeRepositoryPath(
      tab.worktree.root
      || activeEntries.find((entry) => entry.role === "primary")?.worktreePath
      || activeEntries.find((entry) => entry.role === "primary")?.path
      || `story-worktree:${tab?.id || "unknown"}`,
    );
    integrityConflicts.set(pathKey(unsafeRoot) || unsafeRoot, {
      kind: "unsafe-worktree",
      priority: 55,
      root: unsafeRoot,
      entry: activeEntries.find((entry) => entry.role === "primary") || null,
      staleReasons: [`故事点 worktree 生命周期状态为 ${lifecycleStatus}，尚未安全就绪`],
    });
  }
  const bundleIntegrity = inspectWorkspaceBundleIntegrity(tab?.worktree, { pathExists });
  if (!bundleIntegrity.ok) {
    const unsafeRoot = normalizeRepositoryPath(
      bundleIntegrity.workspaceRoot
      || tab?.worktree?.root
      || `story-workspace-bundle:${tab?.id || "unknown"}`,
    );
    integrityConflicts.set(pathKey(unsafeRoot) || unsafeRoot, {
      kind: "unsafe-worktree",
      priority: 65,
      root: unsafeRoot,
      entry: activeEntries.find((entry) => entry.role === "primary") || null,
      staleReasons: bundleIntegrity.issues,
    });
  }

  for (const project of Array.isArray(projects) ? projects : []) {
    addKnownRoot(knownRoots, project?.path, { name: project?.name, source: "registered-project" });
    addKnownRoot(knownRoots, project?.webAppPath, { name: `${project?.name || "工程"}/WebApp`, source: "registered-webapp" });
  }
  for (const entry of Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : []) {
    addKnownRoot(knownRoots, entry?.basePath, { name: entry?.name, source: entry?.active === false ? "inactive-entry" : "story-entry" });
    addKnownRoot(knownRoots, entry?.baseRepositoryPath, { name: entry?.name, source: entry?.active === false ? "inactive-entry" : "story-entry" });
  }
  for (const extra of Array.isArray(tab?.baseExtraProjects) ? tab.baseExtraProjects : []) {
    addKnownRoot(knownRoots, extra?.basePath || extra?.path, { name: extra?.name, source: "story-config" });
  }
  for (const extra of Array.isArray(tab?.extraProjects) ? tab.extraProjects : []) {
    addKnownRoot(knownRoots, extra?.basePath, { name: extra?.name, source: "story-config" });
  }
  for (const alertedPath of protectedBaseAlertPaths(tab?.repositoryPathAlert)) {
    addKnownRoot(knownRoots, alertedPath, { name: alertedPath, source: "persistent-alert" });
  }
  // Build the complete protected-base topology before validating the current
  // checkout. A broad/stale current root must not contain a base repository
  // owned by another project or story merely because it is not this entry's
  // own basePath.
  for (const ownerTab of Array.isArray(allTabs) ? allTabs : []) {
    for (const ownerEntry of Array.isArray(ownerTab?.worktree?.entries) ? ownerTab.worktree.entries : []) {
      addKnownRoot(knownRoots, ownerEntry?.basePath, { name: ownerEntry?.name, source: "all-story-entry" });
      addKnownRoot(knownRoots, ownerEntry?.baseRepositoryPath, { name: ownerEntry?.name, source: "all-story-entry" });
    }
    for (const extra of Array.isArray(ownerTab?.baseExtraProjects) ? ownerTab.baseExtraProjects : []) {
      addKnownRoot(knownRoots, extra?.basePath || extra?.path, { name: extra?.name, source: "all-story-config" });
    }
    for (const extra of Array.isArray(ownerTab?.extraProjects) ? ownerTab.extraProjects : []) {
      addKnownRoot(knownRoots, extra?.basePath, { name: extra?.name, source: "all-story-config" });
    }
    for (const alertedPath of protectedBaseAlertPaths(ownerTab?.repositoryPathAlert)) {
      addKnownRoot(knownRoots, alertedPath, { name: alertedPath, source: "all-story-alert" });
    }
  }
  const activePrimaryEntries = activeEntries.filter((entry) => entry.role === "primary");
  if (tab?.worktree?.managed === true && activePrimaryEntries.length !== 1) {
    const missingRoot = normalizeRepositoryPath(
      tab.worktree.root
      || tab.worktree.cleanedEntries?.[0]?.worktreePath
      || tab.worktree.cleanedEntries?.[0]?.path
      || `story-worktree:${tab?.id || "unknown"}`,
    );
    integrityConflicts.set(pathKey(missingRoot) || missingRoot, {
      kind: "unsafe-worktree",
      priority: 55,
      root: missingRoot,
      entry: activePrimaryEntries[0] || null,
      staleReasons: [activePrimaryEntries.length === 0
        ? "受管故事点没有 active 主 worktree；可能已清理、部分清理或配置损坏"
        : `受管故事点登记了 ${activePrimaryEntries.length} 个 active 主 worktree，系统拒绝猜测 AI 工作目录`],
    });
  }

  for (const entry of activeEntries) {
    const target = entry?.path || entry?.worktreePath;
    const worktreeRoot = entry?.worktreePath || target;
    const protectedIsolationReasons = [...knownRoots.values()]
      .flatMap((known) => baseIsolationReasons(known.root, target, worktreeRoot, pathExists, realPath));
    const staleReasons = [...new Set([
      ...(!isAbsoluteRepositoryPath(target) || !isAbsoluteRepositoryPath(worktreeRoot)
        ? ["登记的 worktree 路径必须是绝对路径，禁止相对路径或隐式 cwd"]
        : []),
      ...managedEntryPathStyleReasons(entry, target, worktreeRoot),
      ...protectedIsolationReasons,
    ])];
    if (target && worktreeRoot && !pathInside(canonicalRepositoryPath(target), canonicalRepositoryPath(worktreeRoot))) {
      staleReasons.push("登记路径越出当前故事点 worktree 根目录");
    }
    if (typeof pathExists === "function" && (
      (target && !pathExists(target))
      || (worktreeRoot && !pathExists(worktreeRoot))
    )) {
      staleReasons.push("登记的 worktree 目录不存在");
    }
    if (typeof realPath === "function") {
      const physicalTarget = physicalRepositoryPath(target, pathExists, realPath);
      const physicalRoot = physicalRepositoryPath(worktreeRoot, pathExists, realPath);
      if (!physicalTarget || !physicalRoot || !pathInside(physicalTarget, physicalRoot)) {
        staleReasons.push("登记路径的真实位置越出当前故事点 worktree 根目录");
      }
    }
    for (const candidate of [target, worktreeRoot]) {
      if (!candidate) continue;
      const key = pathKey(candidate);
      const value = { root: normalizeRepositoryPath(candidate), entry, staleReasons };
      if (staleReasons.length) {
        staleRoots.set(key, value);
        integrityConflicts.set(key, {
          kind: "unsafe-worktree",
          priority: 55,
          ...value,
        });
      }
      else allowedRoots.set(key, value);
    }
    addMapping(aliases, entry?.basePath, target, entry, pathExists, realPath, staleReasons);
    addMapping(aliases, entry?.baseRepositoryPath, worktreeRoot, entry, pathExists, realPath, staleReasons);
  }

  const currentPhysicalOwners = [];
  for (const entry of activeEntries) {
    for (const candidate of [entry?.worktreePath, entry?.path]) {
      const root = normalizeRepositoryPath(candidate);
      const physicalRoot = physicalPathKey(candidate, realPath);
      if (!root || !physicalRoot) continue;
      currentPhysicalOwners.push({ root, physicalRoot, entry });
    }
  }

  for (const entry of inactiveWorktreeEntries(tab)) {
    for (const candidate of [entry?.path, entry?.worktreePath]) {
      const root = normalizeRepositoryPath(candidate);
      if (root && !allowedRoots.has(pathKey(root))) staleRoots.set(pathKey(root), { root, entry });
    }
  }

  for (const other of Array.isArray(allTabs) ? allTabs : []) {
    if (!other || String(other.id || "") === String(tab?.id || "")) continue;
    for (const entry of activeWorktreeEntries(other)) {
      for (const candidate of [entry?.path, entry?.worktreePath]) {
        const root = normalizeRepositoryPath(candidate);
        if (!root) continue;
        const physicalKey = physicalPathKey(candidate, realPath);
        const currentOwners = currentPhysicalOwners.filter((owner) => (
          pathsOverlap(root, owner.root)
          || (physicalKey && owner.physicalRoot && pathsOverlap(physicalKey, owner.physicalRoot))
        ));
        if (currentOwners.length) {
          const conflict = {
            tabId: other.id,
            tabTitle: other.title || "其它故事点",
            entry,
            path: root,
            physicalKey,
          };
          const conflicts = conflictingPhysicalRoots.get(physicalKey) || [];
          conflicts.push(conflict);
          conflictingPhysicalRoots.set(physicalKey, conflicts);
          for (const owner of currentOwners) {
            for (const currentRoot of [owner.entry?.path, owner.entry?.worktreePath]) {
              const currentRootKey = pathKey(currentRoot);
              if (!currentRootKey) continue;
              ownershipConflicts.set(currentRootKey, {
                kind: "shared-worktree",
                priority: 60,
                root: normalizeRepositoryPath(currentRoot),
                entry: owner.entry,
                conflicts,
              });
            }
          }
          continue;
        }
        if (!allowedRoots.has(pathKey(root))) {
          foreignRoots.set(pathKey(root), { root, entry, tabId: other.id, tabTitle: other.title || "其它故事点" });
        }
      }
      addKnownRoot(knownRoots, entry?.basePath, { name: entry?.name, source: "other-story-entry" });
      addKnownRoot(knownRoots, entry?.baseRepositoryPath, { name: entry?.name, source: "other-story-entry" });
    }
  }
  for (const targetMap of aliases.values()) {
    for (const target of targetMap.values()) {
      const conflicts = [...new Set(
        [target.worktreeRoot, target.target]
          .flatMap((candidate) => ownershipConflicts.get(pathKey(candidate))?.conflicts || []),
      )];
      if (conflicts.length) target.ownershipConflicts = conflicts;
    }
  }
  return { aliases, knownRoots, allowedRoots, staleRoots, foreignRoots, ownershipConflicts, integrityConflicts };
}

function candidateRoots(topology) {
  const candidates = [];
  for (const value of topology.ownershipConflicts.values()) candidates.push(value);
  for (const value of topology.integrityConflicts.values()) candidates.push(value);
  for (const value of topology.allowedRoots.values()) candidates.push({ kind: "allowed", priority: 50, ...value });
  for (const value of topology.staleRoots.values()) candidates.push({ kind: "stale-worktree", priority: 45, ...value });
  for (const value of topology.foreignRoots.values()) candidates.push({ kind: "foreign-worktree", priority: 40, ...value });
  for (const [key, value] of topology.knownRoots.entries()) {
    const targets = [...(topology.aliases.get(key)?.values() || [])];
    const healthy = targets.filter((target) => !target.staleReasons.length && !target.ownershipConflicts?.length);
    let kind = "missing";
    if (targets.some((target) => target.ownershipConflicts?.length)) kind = "shared-worktree";
    else if (healthy.length === 1) kind = "mapped";
    else if (healthy.length > 1) kind = "ambiguous";
    else if (targets.length) kind = "stale-mapping";
    candidates.push({ kind, priority: 30, root: value.root, known: value, targets });
  }
  // An active alias may come from a base path not present in the registered
  // project list. It is still authoritative for this story.
  for (const [key, targetMap] of topology.aliases.entries()) {
    if (topology.knownRoots.has(key)) continue;
    const targets = [...targetMap.values()];
    const healthy = targets.filter((target) => !target.staleReasons.length && !target.ownershipConflicts?.length);
    candidates.push({
      kind: targets.some((target) => target.ownershipConflicts?.length)
        ? "shared-worktree"
        : (healthy.length === 1 ? "mapped" : (healthy.length > 1 ? "ambiguous" : "stale-mapping")),
      priority: 30,
      root: targets[0]?.source || "",
      known: { root: targets[0]?.source || "", names: new Set(targets.map((target) => target.name).filter(Boolean)) },
      targets,
    });
  }
  return candidates.filter((candidate) => candidate.root);
}

function selectNonOverlappingMatches(content, candidates, {
  pathExists,
  realPath,
  windowsVolumeRoot = "",
  allowedWindowsVolumeRoots = [],
  allowPhysicalOccurrenceProbe = true,
} = {}) {
  const matches = [];
  for (const candidate of candidates) {
    for (const occurrence of rootMatches(content, candidate.root, windowsVolumeRoot)) {
      matches.push({ ...occurrence, candidate, rootLength: normalizeRepositoryPath(candidate.root).length });
    }
  }
  for (const occurrence of absolutePathOccurrences(content, windowsVolumeRoot)) {
    const occurrenceVolume = windowsVolumeRootForReference(occurrence.canonicalReferencePath);
    if (occurrenceVolume && !allowedWindowsVolumeRoots.includes(pathKey(occurrenceVolume))) continue;
    const lexicalCandidates = candidates
      .filter((candidate) => pathInside(occurrence.canonicalReferencePath, canonicalRepositoryPath(candidate.root)))
      .map((candidate) => ({ candidate, matchRoot: canonicalRepositoryPath(candidate.root), physicalMatch: false }));
    const physicalReferencePath = allowPhysicalOccurrenceProbe && typeof realPath === "function"
      ? physicalRepositoryPath(occurrence.canonicalReferencePath, pathExists, realPath)
      : "";
    const physicalCandidates = physicalReferencePath
      ? candidates.map((candidate) => ({
        candidate,
        matchRoot: physicalRepositoryPath(candidate.root, pathExists, realPath),
        physicalMatch: true,
      })).filter((item) => item.matchRoot && pathInside(physicalReferencePath, item.matchRoot))
      : [];
    const matchingCandidates = [...lexicalCandidates, ...physicalCandidates]
      .sort((left, right) => (
        canonicalRepositoryPath(right.matchRoot).length - canonicalRepositoryPath(left.matchRoot).length
        || right.candidate.priority - left.candidate.priority
        || Number(right.physicalMatch) - Number(left.physicalMatch)
      ));
    if (matchingCandidates[0]) {
      const best = matchingCandidates[0];
      matches.push({
        ...occurrence,
        candidate: best.candidate,
        rootLength: canonicalRepositoryPath(best.matchRoot).length,
        canonicalMatch: true,
        physicalMatch: best.physicalMatch,
        canonicalSourceRoot: best.matchRoot,
        canonicalReferencePath: best.physicalMatch ? physicalReferencePath : occurrence.canonicalReferencePath,
      });
    }
  }
  matches.sort((left, right) => (
    left.start - right.start
    || right.rootLength - left.rootLength
    || right.candidate.priority - left.candidate.priority
    || Number(right.physicalMatch === true) - Number(left.physicalMatch === true)
    || Number(right.canonicalMatch === true) - Number(left.canonicalMatch === true)
  ));
  const selected = [];
  for (const match of matches) {
    if (selected.some((current) => match.start < current.end && match.end > current.start)) continue;
    selected.push(match);
  }
  return selected.sort((left, right) => left.start - right.start);
}

const PAIRED_PATH_DELIMITERS = new Map([
  ['"', '"'], ["'", "'"], ["`", "`"], ["<", ">"], ["(", ")"], ["[", "]"], ["{", "}"], ["“", "”"], ["‘", "’"],
]);

function extendPathReference(content, match) {
  const source = String(content || "");
  if (!/[\\/]/.test(source.charAt(match.end))) {
    return { ...match, referenceEnd: match.end, referencedPath: source.slice(match.start, match.end), suffix: "" };
  }
  const closing = PAIRED_PATH_DELIMITERS.get(source.charAt(match.start - 1));
  let end = match.end;
  if (closing) {
    const closingAt = source.indexOf(closing, match.end);
    end = closingAt >= match.end ? closingAt : source.length;
  } else {
    while (end < source.length && !/[\s"'`]/u.test(source.charAt(end))) end += 1;
  }
  return {
    ...match,
    referenceEnd: end,
    referencedPath: source.slice(match.start, end),
    suffix: source.slice(match.end, end),
    paired: !!closing,
  };
}

function healthyMappingTarget(candidate) {
  return (candidate?.targets || []).find((target) => (
    !target.staleReasons?.length && !target.ownershipConflicts?.length
  )) || null;
}

function annotateResolvedReference(content, match, { pathExists, realPath } = {}) {
  const reference = extendPathReference(content, match);
  let target = null;
  let replacementRoot = "";
  let containmentRoot = "";
  if (match.candidate.kind === "mapped") {
    target = healthyMappingTarget(match.candidate);
    replacementRoot = target?.target || "";
    containmentRoot = target?.worktreeRoot || replacementRoot;
  } else if (match.candidate.kind === "allowed") {
    replacementRoot = match.candidate.root;
    containmentRoot = match.candidate.entry?.worktreePath || replacementRoot;
  }
  if (!replacementRoot) return reference;

  let replacementPath;
  if (match.canonicalMatch && match.canonicalReferencePath) {
    const canonicalSourceRoot = canonicalRepositoryPath(match.canonicalSourceRoot || match.candidate.root);
    const relative = isWindowsLike(canonicalSourceRoot)
      ? path.win32.relative(canonicalSourceRoot, match.canonicalReferencePath)
      : path.posix.relative(canonicalSourceRoot, match.canonicalReferencePath);
    replacementPath = canonicalRepositoryPath(
      isWindowsLike(replacementRoot)
        ? path.win32.join(replacementRoot, relative)
        : path.posix.join(replacementRoot, relative),
    );
  } else {
    replacementPath = canonicalRepositoryPath(`${replacementRoot}${reference.suffix}`);
  }
  const canonicalContainment = canonicalRepositoryPath(containmentRoot);
  let unsafe = !replacementPath
    || !canonicalContainment
    || !pathInside(replacementPath, canonicalContainment);
  const continuationPaths = [];
  if (!unsafe) {
    const lineEndCandidates = [content.indexOf("\n", reference.referenceEnd), content.indexOf("\r", reference.referenceEnd)]
      .filter((index) => index >= 0);
    const lineEnd = lineEndCandidates.length ? Math.min(...lineEndCandidates) : content.length;
    const continuation = content.slice(reference.referenceEnd, lineEnd);
    // An unquoted path may contain spaces. The first whitespace is not a safe
    // containment boundary: both `Repo\link name` and
    // `Repo\link name\secret` may traverse a junction even though the token
    // before the space (`link`) remains inside. Probe every plausible prefix
    // ending at a later whitespace plus the complete continuation. This also
    // catches a valid spaced path followed by natural-language instructions.
    if (!reference.paired && /^\s+\S/u.test(continuation)) {
      const bounded = continuation;
      const ends = [];
      for (let index = 1; index < bounded.length; index += 1) {
        if (/\s/u.test(bounded.charAt(index)) && !/\s/u.test(bounded.charAt(index - 1))) ends.push(index);
      }
      ends.push(bounded.length);
      for (const end of [...new Set(ends)]) {
        const candidate = canonicalRepositoryPath(`${replacementPath}${bounded.slice(0, end)}`);
        if (candidate && !continuationPaths.some((current) => pathKey(current) === pathKey(candidate))) {
          continuationPaths.push(candidate);
        }
      }
      unsafe = continuationPaths.some((candidate) => !pathInside(candidate, canonicalContainment));
    }
  }
  if (!unsafe && typeof realPath === "function") {
    const physicalContainment = physicalRepositoryPath(canonicalContainment, pathExists, realPath);
    unsafe = !physicalContainment || [replacementPath, ...continuationPaths].some((candidate) => {
      const physicalCandidate = physicalRepositoryPath(candidate, pathExists, realPath);
      return !physicalCandidate || !pathInside(physicalCandidate, physicalContainment);
    });
  }
  return {
    ...reference,
    target,
    replacementPath,
    unsafe,
    unsafeReason: unsafe
      ? "引用路径经规范化后越出当前故事点 worktree；系统拒绝处理 ..、设备路径或重解析别名造成的目录逃逸"
      : "",
  };
}

function failureItem(match) {
  const candidate = match.candidate;
  const targets = (candidate.targets || []).map((target) => ({
    path: target.target,
    branch: target.branch,
    reason: target.staleReasons.join("；"),
  }));
  const name = [...(candidate.known?.names || [])][0]
    || candidate.entry?.name
    || candidate.entry?.repositoryId
    || candidate.root;
  const reason = match.unsafeReason || {
    missing: "当前故事点没有关联该基础仓库的 active worktree",
    ambiguous: "同一基础仓库对应多个当前故事点 worktree，系统拒绝猜测",
    "stale-mapping": "当前故事点登记的 worktree 已丢失或映射越界",
    "stale-worktree": candidate.staleReasons?.length
      ? candidate.staleReasons.join("；")
      : "消息引用了当前故事点已停用、丢失或越界的旧 worktree",
    "foreign-worktree": `消息引用了其它故事点${candidate.tabTitle ? `“${candidate.tabTitle}”` : ""}的 worktree`,
    "shared-worktree": "当前 checkout 同时被多个故事点登记，归属不唯一，禁止 AI 使用",
    "unsafe-worktree": candidate.staleReasons?.length
      ? candidate.staleReasons.join("；")
      : "当前 checkout 与基础仓库未形成物理隔离",
  }[candidate.kind] || "未找到安全且唯一的 worktree 映射";
  const protectedBasePath = match.unsafe
    ? normalizeRepositoryPath(
      candidate.kind === "mapped"
        ? candidate.root
        : candidate.entry?.basePath
          || candidate.entry?.baseRepositoryPath
          || candidate.targets?.[0]?.source,
    )
    : "";
  return {
    kind: match.unsafe ? "unsafe-path" : candidate.kind,
    name: cleanLine(name, 300),
    path: candidate.root,
    ...(protectedBasePath ? { basePath: protectedBasePath } : {}),
    referencedPath: match.referencedPath || match.text,
    reason,
    candidates: targets,
  };
}

function buildAlert(items, ambiguous) {
  const paths = [...new Set(items.map((item) => item.path).filter(Boolean))];
  const title = items.some((item) => item.kind === "unsafe-path")
    ? "仓库路径越出当前故事点 worktree，AI 未执行"
    : items.some((item) => item.kind === "unsafe-worktree")
      ? "worktree 未与基础仓库隔离，AI 未执行"
    : items.some((item) => item.kind === "shared-worktree")
      ? "worktree 被多个故事点共用，AI 未执行"
      : ambiguous
        ? "基础仓库对应多个 worktree，AI 未执行"
        : "未找到对应故事点 worktree，AI 未执行";
  return {
    level: "error",
    title,
    message: `🚨 ${title}。AI 未启动、未注入、未排队，也未读取或修改基础仓库。请进入“编辑故事点配置 → 关联工程”补齐或重建 worktree 后重试。`,
    reason: items.map((item) => `${item.name || item.path}：${item.reason}`).join("；"),
    paths,
    repositories: items,
    action: "open-story-config",
  };
}

function buildMappingContext(mappings) {
  if (!mappings.length) return "";
  const lines = [
    "## 本轮基础仓库引用映射（系统生成，最高优先级）",
    "用户可见原文保持不变；系统已把其中的基础仓库路径确定性映射到当前故事点 worktree。基础仓库绝对路径不会提供给 AI；所有读取、编辑和 Git 操作只能使用下方 worktree。",
  ];
  for (const mapping of mappings) {
    const readOnly = mapping.mode === "READ_ONLY";
    const branch = readOnly ? mapping.logicalBranch : mapping.branch;
    lines.push(`- ${mapping.name || "工程"} → ${mapping.worktreePath}${branch ? `（${readOnly ? "来源分支" : "故事分支"}：${branch}）` : ""}${readOnly ? "；只读依赖，只允许读取和参与构建，禁止编辑、提交或复制其源码到主工程" : ""}`);
  }
  return lines.join("\n");
}

export function resolveStoryRepositoryPaths({ tab, content, projects = [], allTabs = [], pathExists, realPath } = {}) {
  const originalContent = String(content || "");
  const memoized = memoizedPathCallbacks(pathExists, realPath);
  const topology = collectTopology(tab, projects, allTabs, memoized.pathExists, memoized.realPath);
  const candidates = candidateRoots(topology);
  const currentVolumeRoot = currentStoryWindowsVolumeRoot(tab);
  const allowedWindowsVolumeRoots = [...new Set(candidates
    .map((candidate) => windowsVolumeRootForReference(candidate.root))
    .filter(Boolean)
    .map(pathKey))];
  const absoluteOccurrences = absolutePathOccurrences(originalContent, currentVolumeRoot);
  const isAllowedWindowsOccurrence = (occurrence) => {
    const canonical = canonicalRepositoryPath(occurrence.canonicalReferencePath);
    if (!isWindowsLike(canonical)) return false;
    if (allowedWindowsVolumeRoots.includes(pathKey(windowsVolumeRootForReference(canonical)))) return true;
    // A spaced UNC share can first be tokenized at the whitespace and then be
    // expanded to the full path. Treat the full occurrence as registered when
    // it is lexically inside a known candidate even if Win32 root parsing of a
    // partial prefix produced a different share root.
    return candidates.some((candidate) => pathInside(canonical, candidate.root));
  };
  const allowedWindowsOccurrences = absoluteOccurrences.filter(isAllowedWindowsOccurrence);
  const unknownVolumeFailures = absoluteOccurrences.flatMap((occurrence) => {
    const canonical = canonicalRepositoryPath(occurrence.canonicalReferencePath);
    const normalized = normalizeRepositoryPath(canonical);
    if (!isWindowsLike(canonical) || isAllowedWindowsOccurrence(occurrence)) return [];
    if (allowedWindowsOccurrences.some((allowed) => (
      allowed.start === occurrence.start && allowed.end >= occurrence.end
    ))) return [];
    return [{
      kind: "unsafe-path",
      name: normalized.startsWith("//") ? "未登记网络路径" : "未登记存储卷路径",
      path: occurrence.text,
      referencedPath: occurrence.text,
      reason: normalized.startsWith("//")
        ? "该 UNC/网络共享不属于当前故事点已登记仓库；系统未访问该网络路径，也未启动 AI"
        : "该 Windows 存储卷不属于当前故事点已登记仓库；系统未探测该路径，也未启动 AI",
      candidates: [],
    }];
  });
  const probeBudgetExceeded = absoluteOccurrences.length > 512
    || absoluteOccurrences.some((occurrence) => occurrence.text.length > 8_192);
  const referenceBudgetFailures = probeBudgetExceeded ? [{
    kind: "unsafe-path",
    name: "路径解析预算超限",
    path: "（消息中的路径数量或长度超限）",
    referencedPath: "（已隔离）",
    reason: "消息中的路径候选过多或过长，系统为避免文件系统探测阻塞而拒绝执行；请缩短消息后重试",
    candidates: [],
  }] : [];
  const selected = selectNonOverlappingMatches(originalContent, candidates, {
    ...memoized,
    windowsVolumeRoot: currentVolumeRoot,
    allowedWindowsVolumeRoots,
    allowPhysicalOccurrenceProbe: !probeBudgetExceeded,
  })
    .map((match) => annotateResolvedReference(originalContent, match, memoized));
  const driveRelativeFailures = driveRelativePathOccurrences(originalContent).map((occurrence) => ({
    kind: "unsafe-path",
    name: "驱动器相对路径",
    path: occurrence.text,
    referencedPath: occurrence.text,
    reason: "驱动器相对路径依赖进程级每驱动器当前目录，无法确定映射到当前故事点 worktree；请改用完整绝对路径",
    candidates: [],
  }));
  const primaryWorktreeRoot = currentStoryPrimaryWorktreeRoot(tab);
  const allowedWorktreeRoots = [...topology.allowedRoots.values()]
    .map((entry) => canonicalRepositoryPath(entry.root))
    .filter(Boolean);
  const relativeTraversals = relativeTraversalOccurrences(originalContent);
  const shellExpansionInTraversal = hasRelativeTraversalSegment(originalContent)
    && /\$(?:env:)?[A-Za-z_{(]|%[^%\r\n]+%|![^!\r\n]+!/iu.test(originalContent);
  const shellExpansionFailures = shellExpansionInTraversal ? [{
    kind: "unsafe-path",
    name: "动态相对目录逃逸",
    path: cleanLine(originalContent, 500),
    referencedPath: cleanLine(originalContent, 500),
    reason: "包含 .. 的路径同时使用 shell 或环境变量展开，实际位置只能在命令执行时确定；为防止跨出故事点 worktree，AI 未执行",
    candidates: [],
  }] : [];
  const relativeTraversalFailures = relativeTraversals.flatMap((occurrence) => {
    if (shellExpansionInTraversal) return [];
    if (!primaryWorktreeRoot) {
      return [{
        kind: "unsafe-path",
        name: "相对目录逃逸",
        path: occurrence.text,
        referencedPath: occurrence.text,
        reason: "相对路径包含 ..，但当前故事点没有可验证的主 worktree 根目录",
        candidates: [],
      }];
    }
    const pathApi = isWindowsLike(primaryWorktreeRoot) ? path.win32 : path.posix;
    const token = isWindowsLike(primaryWorktreeRoot)
      ? occurrence.text.replace(/\//g, "\\")
      : occurrence.text.replace(/\\/g, "/");
    const resolved = canonicalRepositoryPath(pathApi.resolve(primaryWorktreeRoot, token));
    let safe = allowedWorktreeRoots.some((root) => pathInside(resolved, root));
    if (safe && typeof memoized.realPath === "function") {
      const physicalResolved = physicalRepositoryPath(resolved, memoized.pathExists, memoized.realPath);
      safe = !!physicalResolved && allowedWorktreeRoots.some((root) => {
        const physicalRoot = physicalRepositoryPath(root, memoized.pathExists, memoized.realPath);
        return !!physicalRoot && pathInside(physicalResolved, physicalRoot);
      });
    }
    return safe ? [] : [{
      kind: "unsafe-path",
      name: "相对目录逃逸",
      path: occurrence.text,
      referencedPath: occurrence.text,
      reason: `相对路径包含 ..，按主 worktree 解析后越出本故事点允许范围：${resolved || occurrence.text}`,
      candidates: [],
    }];
  });
  const matchedFailures = selected
    .filter((match) => match.unsafe || !["allowed", "mapped"].includes(match.candidate.kind))
    .map(failureItem);
  // A checkout with multiple story owners is unsafe even when the new message
  // does not repeat an absolute path. Otherwise “继续” could launch an agent in
  // a physically shared working tree.
  const ownershipFailures = [...topology.ownershipConflicts.values()].map((candidate) => failureItem({
    candidate,
    text: candidate.root,
    referencedPath: candidate.root,
  }));
  const integrityFailures = [...topology.integrityConflicts.values()].map((candidate) => failureItem({
    candidate,
    text: candidate.root,
    referencedPath: candidate.root,
  }));
  const failures = [];
  const failureKeys = new Set();
  for (const item of [
    ...integrityFailures,
    ...ownershipFailures,
    ...unknownVolumeFailures,
    ...referenceBudgetFailures,
    ...driveRelativeFailures,
    ...shellExpansionFailures,
    ...relativeTraversalFailures,
    ...matchedFailures,
  ]) {
    const key = `${item.kind}|${pathKey(item.path)}|${item.reason}`;
    if (failureKeys.has(key)) continue;
    failureKeys.add(key);
    failures.push(item);
  }
  if (failures.length) {
    const ambiguous = failures.some((item) => item.kind === "ambiguous");
    const code = failures.some((item) => item.kind === "unsafe-worktree")
      ? "STORY_WORKTREE_INTEGRITY_INVALID"
      : ambiguous ? "STORY_BASE_WORKTREE_AMBIGUOUS" : "STORY_BASE_WORKTREE_MISSING";
    const alert = buildAlert(failures, ambiguous);
    alert.code = code;
    return {
      ok: false,
      code,
      statusCode: 409,
      error: alert.message,
      repositoryPathAlert: alert,
      originalContent,
      mappedContent: originalContent,
      mappings: [],
      failures,
    };
  }

  const replacements = selected
    .filter((match) => ["mapped", "allowed"].includes(match.candidate.kind) && match.replacementPath)
    .map((match) => {
      const target = match.target || healthyMappingTarget(match.candidate);
      return { ...match, target, replacementEnd: match.referenceEnd || match.end };
    });
  const resolvedRepositoryPathMap = new Map();
  for (const replacement of replacements) {
    const target = replacement.target;
    const verifiedRoots = replacement.candidate.kind === "mapped"
      ? [replacement.candidate.root, target?.source, target?.target, target?.worktreeRoot]
      : [
        replacement.candidate.root,
        replacement.candidate.entry?.path,
        replacement.candidate.entry?.worktreePath,
      ];
    for (const value of verifiedRoots) {
      const normalized = normalizeRepositoryPath(value);
      const key = pathKey(normalized);
      if (key && normalized && !resolvedRepositoryPathMap.has(key)) {
        resolvedRepositoryPathMap.set(key, normalized);
      }
    }
  }
  const resolvedRepositoryPaths = [...resolvedRepositoryPathMap.values()];
  let cursor = 0;
  let mappedContent = "";
  for (const replacement of replacements) {
    mappedContent += originalContent.slice(cursor, replacement.start);
    mappedContent += replacement.replacementPath;
    cursor = replacement.replacementEnd;
  }
  mappedContent += originalContent.slice(cursor);

  const aggregate = new Map();
  for (const replacement of replacements.filter((item) => item.candidate.kind === "mapped")) {
    const target = replacement.target;
    const key = `${pathKey(target.source)}=>${pathKey(target.target)}`;
    const current = aggregate.get(key) || {
      basePath: target.source,
      worktreePath: target.target,
      worktreeRoot: target.worktreeRoot,
      name: target.name,
      repositoryId: target.repositoryId,
      baseProjectId: target.baseProjectId,
      branch: target.branch,
      role: target.role,
      count: 0,
    };
    current.count += 1;
    aggregate.set(key, current);
  }
  const mappings = [...aggregate.values()];
  const mappingContext = buildMappingContext(mappings);
  return {
    ok: true,
    code: "STORY_REPOSITORY_PATHS_RESOLVED",
    originalContent,
    mappedContent,
    mappings,
    resolvedRepositoryPaths,
    mappingContext,
    worktreeOwnershipVerified: true,
    executionContent: mappingContext
      ? `${mappingContext}\n\n## 用户追加消息（基础仓库路径已映射）\n${mappedContent}`
      : mappedContent,
    audit: mappings.map((mapping) => ({
      basePath: mapping.basePath,
      worktreePath: mapping.worktreePath,
      repositoryId: mapping.repositoryId,
      baseProjectId: mapping.baseProjectId,
      branch: mapping.branch,
      role: mapping.role,
      count: mapping.count,
    })),
  };
}
