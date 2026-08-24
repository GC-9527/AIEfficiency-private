import { execFile } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const TICKET_VERSION = 2;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const MAX_TICKET_BYTES = 8192;
const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOTS = 2048;
const DEFAULT_GC_BATCH_SIZE = 128;
const DEFAULT_PENDING_MAX_AGE_MS = 20 * 60 * 1000;
const processKey = randomBytes(32);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const fsyncAsync = promisify(fs.fsync);
let cachedWindowsSid = "";
let pendingWindowsSid = null;

export const STORY_ARTIFACT_SNAPSHOT_ROOT = path.resolve(
  moduleDirectory,
  "../../.secrets/story-artifact-snapshots",
);

export class StoryArtifactTicketError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = "StoryArtifactTicketError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, httpStatus = 400) {
  throw new StoryArtifactTicketError(code, message, httpStatus);
}

function requiredText(value, code, message, maxLength = 2048) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    fail(code, message);
  }
  return text;
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function storyArtifactFileIdentity(stat) {
  if (!stat || typeof stat !== "object" || !stat.isFile?.()) {
    fail(
      "STORY_ARTIFACT_TICKET_FILE_INVALID",
      "产物票据只能绑定已存在的普通文件",
    );
  }
  const exactInteger = (value) => {
    if (typeof value === "bigint") return value >= 0n ? value.toString(10) : "0";
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? String(Math.trunc(parsed))
      : "0";
  };
  const exactNanos = (nativeNanos, milliseconds) => {
    if (typeof nativeNanos === "bigint") return exactInteger(nativeNanos);
    return exactInteger(Math.trunc(Number(milliseconds || 0) * 1_000_000));
  };
  return {
    size: integer(stat.size),
    mtimeNanos: exactNanos(stat.mtimeNs, stat.mtimeMs),
    ctimeNanos: exactNanos(stat.ctimeNs, stat.ctimeMs),
    dev: exactInteger(stat.dev),
    ino: exactInteger(stat.ino),
  };
}

function sameFileIdentity(left, right) {
  return JSON.stringify(storyArtifactFileIdentity(left))
    === JSON.stringify(storyArtifactFileIdentity(right));
}

function sameEncodedIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function encodedIdentityIsValid(value) {
  return !!(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "ctimeNanos,dev,ino,mtimeNanos,size"
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && ["mtimeNanos", "ctimeNanos", "dev", "ino"]
      .every((field) => /^\d+$/.test(String(value[field] || "")))
  );
}

function canonicalPayload(payload) {
  return JSON.stringify({
    v: TICKET_VERSION,
    tabId: payload.tabId,
    ref: payload.ref,
    download: payload.download === true,
    method: "GET_OR_HEAD",
    iat: payload.iat,
    exp: payload.exp,
    source: {
      size: payload.source.size,
      mtimeNanos: payload.source.mtimeNanos,
      ctimeNanos: payload.source.ctimeNanos,
      dev: payload.source.dev,
      ino: payload.source.ino,
    },
    snapshot: {
      id: payload.snapshot.id,
      sha256: payload.snapshot.sha256,
      file: {
        size: payload.snapshot.file.size,
        mtimeNanos: payload.snapshot.file.mtimeNanos,
        ctimeNanos: payload.snapshot.file.ctimeNanos,
        dev: payload.snapshot.file.dev,
        ino: payload.snapshot.file.ino,
      },
    },
  });
}

function signature(encodedPayload) {
  return createHmac("sha256", processKey).update(encodedPayload).digest("base64url");
}

function normalizeSnapshotDescriptor(snapshot, expiresAt) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail("STORY_ARTIFACT_SNAPSHOT_REQUIRED", "产物票据缺少不可变快照");
  }
  const id = String(snapshot.id || "").toLowerCase();
  const sha256 = String(snapshot.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha256)) {
    fail("STORY_ARTIFACT_SNAPSHOT_INVALID", "产物快照标识或哈希无效");
  }
  if (integer(snapshot.expiresAt) !== expiresAt) {
    fail("STORY_ARTIFACT_SNAPSHOT_EXPIRY_MISMATCH", "产物快照与票据有效期不一致");
  }
  return {
    id,
    sha256,
    file: storyArtifactFileIdentity(snapshot.stat),
  };
}

export function issueStoryArtifactTicket({
  tabId,
  ref,
  download = false,
  stat,
  sourceStat = stat,
  snapshot,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  expiresAt,
} = {}) {
  const issuedAt = integer(now);
  const boundedTtl = Math.min(MAX_TTL_MS, Math.max(1_000, integer(ttlMs, DEFAULT_TTL_MS)));
  const effectiveExpiry = expiresAt == null ? issuedAt + boundedTtl : integer(expiresAt);
  if (
    effectiveExpiry <= issuedAt
    || effectiveExpiry - issuedAt > MAX_TTL_MS
  ) {
    fail("STORY_ARTIFACT_TICKET_EXPIRY_INVALID", "产物票据有效期无效");
  }
  const payload = {
    tabId: requiredText(
      tabId,
      "STORY_ARTIFACT_TICKET_TAB_REQUIRED",
      "产物票据缺少故事点身份",
      256,
    ),
    ref: requiredText(
      ref,
      "STORY_ARTIFACT_TICKET_REFERENCE_REQUIRED",
      "产物票据缺少产物引用",
    ),
    download: download === true,
    iat: issuedAt,
    exp: effectiveExpiry,
    source: storyArtifactFileIdentity(sourceStat),
    snapshot: normalizeSnapshotDescriptor(snapshot, effectiveExpiry),
  };
  const encodedPayload = Buffer.from(canonicalPayload(payload), "utf8").toString("base64url");
  return {
    token: `${encodedPayload}.${signature(encodedPayload)}`,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    snapshot: {
      id: payload.snapshot.id,
      sha256: payload.snapshot.sha256,
      stat: snapshot.stat,
      expiresAt: payload.exp,
    },
  };
}

function parseTicket(token) {
  const input = requiredText(
    token,
    "STORY_ARTIFACT_TICKET_REQUIRED",
    "缺少产物访问票据",
    MAX_TICKET_BYTES,
  );
  const parts = input.split(".");
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9_-]+$/.test(parts[0])
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
  ) {
    fail("STORY_ARTIFACT_TICKET_INVALID", "产物访问票据格式无效", 403);
  }
  const expected = Buffer.from(signature(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail("STORY_ARTIFACT_TICKET_INVALID", "产物访问票据签名无效", 403);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    fail("STORY_ARTIFACT_TICKET_INVALID", "产物访问票据载荷无效", 403);
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || payload.v !== TICKET_VERSION
    || payload.method !== "GET_OR_HEAD"
    || typeof payload.download !== "boolean"
    || !payload.source
    || typeof payload.source !== "object"
    || Array.isArray(payload.source)
    || !payload.snapshot
    || typeof payload.snapshot !== "object"
    || Array.isArray(payload.snapshot)
    || !payload.snapshot.file
    || typeof payload.snapshot.file !== "object"
    || Array.isArray(payload.snapshot.file)
    || !encodedIdentityIsValid(payload.source)
    || !encodedIdentityIsValid(payload.snapshot.file)
    || !/^[a-f0-9]{64}$/.test(String(payload.snapshot.id || ""))
    || !/^[a-f0-9]{64}$/.test(String(payload.snapshot.sha256 || ""))
  ) {
    fail("STORY_ARTIFACT_TICKET_INVALID", "产物访问票据版本或字段无效", 403);
  }
  const canonical = canonicalPayload(payload);
  const reencoded = Buffer.from(canonical, "utf8").toString("base64url");
  if (reencoded !== parts[0]) {
    fail(
      "STORY_ARTIFACT_TICKET_INVALID",
      "产物访问票据包含未建模字段或非规范编码",
      403,
    );
  }
  return payload;
}

export function inspectStoryArtifactTicket(token, {
  tabId,
  ref,
  download = false,
  method = "GET",
  now = Date.now(),
} = {}) {
  const payload = parseTicket(token);
  const checkedAt = integer(now);
  if (
    !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || payload.iat < 0
    || payload.exp <= payload.iat
    || payload.exp - payload.iat > MAX_TTL_MS
    || payload.iat > checkedAt + CLOCK_SKEW_MS
    || payload.exp < checkedAt
  ) {
    fail(
      "STORY_ARTIFACT_TICKET_EXPIRED",
      "产物访问票据已过期或时间范围无效",
      403,
    );
  }
  const expectedMethod = String(method || "").toUpperCase();
  if (!["GET", "HEAD"].includes(expectedMethod)) {
    fail(
      "STORY_ARTIFACT_TICKET_METHOD_INVALID",
      "产物访问票据不允许该请求方法",
      405,
    );
  }
  if (
    payload.tabId !== String(tabId || "").trim()
    || payload.ref !== String(ref || "").trim()
    || payload.download !== (download === true)
  ) {
    fail(
      "STORY_ARTIFACT_TICKET_SCOPE_MISMATCH",
      "产物访问票据与故事点、引用或下载模式不匹配",
      403,
    );
  }
  return {
    tabId: payload.tabId,
    ref: payload.ref,
    download: payload.download,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    source: { ...payload.source },
    snapshot: {
      id: payload.snapshot.id,
      sha256: payload.snapshot.sha256,
      file: { ...payload.snapshot.file },
    },
  };
}

export function verifyStoryArtifactTicket(token, {
  tabId,
  ref,
  download = false,
  method = "GET",
  stat,
  sourceStat = stat,
  snapshotStat,
  snapshotId,
  snapshotSha256,
  now = Date.now(),
} = {}) {
  const inspected = inspectStoryArtifactTicket(token, {
    tabId,
    ref,
    download,
    method,
    now,
  });
  if (!sameEncodedIdentity(inspected.source, storyArtifactFileIdentity(sourceStat))) {
    fail(
      "STORY_ARTIFACT_TICKET_FILE_CHANGED",
      "票据签发后产物源文件已变化",
      403,
    );
  }
  if (
    inspected.snapshot.id !== String(snapshotId || "").toLowerCase()
    || inspected.snapshot.sha256 !== String(snapshotSha256 || "").toLowerCase()
    || !sameEncodedIdentity(inspected.snapshot.file, storyArtifactFileIdentity(snapshotStat))
  ) {
    fail(
      "STORY_ARTIFACT_SNAPSHOT_CHANGED",
      "票据绑定的不可变快照已变化",
      403,
    );
  }
  return inspected;
}

function snapshotError(code, message, httpStatus = 503) {
  return new StoryArtifactTicketError(code, message, httpStatus);
}

function snapshotFilename(expiresAt, id) {
  const expiry = integer(expiresAt);
  const normalizedId = String(id || "").toLowerCase();
  if (!expiry || !/^[a-f0-9]{64}$/.test(normalizedId)) {
    throw snapshotError("STORY_ARTIFACT_SNAPSHOT_ID_INVALID", "不可变快照标识无效", 403);
  }
  return `${expiry}-${normalizedId}.snapshot`;
}

function snapshotPathInside(root, expiresAt, id) {
  const target = path.join(root, snapshotFilename(expiresAt, id));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw snapshotError("STORY_ARTIFACT_SNAPSHOT_PATH_INVALID", "不可变快照路径无效", 403);
  }
  return target;
}

async function fsyncDirectory(target) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await fs.promises.open(target, "r");
    await handle.sync();
  } finally {
    if (handle != null) { try { await handle.close(); } catch {} }
  }
}

function assertNoLinkedDirectory(target, label) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw snapshotError("STORY_ARTIFACT_SNAPSHOT_ROOT_MISSING", `${label}不存在`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw snapshotError("STORY_ARTIFACT_SNAPSHOT_ROOT_UNSAFE", `${label}必须是非链接目录`);
  }
  const real = fs.realpathSync.native(target);
  if (path.resolve(real) !== path.resolve(target)) {
    throw snapshotError("STORY_ARTIFACT_SNAPSHOT_ROOT_UNSAFE", `${label}不能经过链接或联接点`);
  }
  return stat;
}

async function windowsCurrentSid() {
  if (cachedWindowsSid) return cachedWindowsSid;
  if (pendingWindowsSid) return pendingWindowsSid;
  pendingWindowsSid = (async () => {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        { windowsHide: true, timeout: 10_000, encoding: "utf8" },
      );
      const sid = String(stdout || "").trim().toUpperCase();
      if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw new Error("Windows SID 输出无效");
      cachedWindowsSid = sid;
      return sid;
    } catch (cause) {
      throw snapshotError(
        "STORY_ARTIFACT_SNAPSHOT_ACL_UNVERIFIED",
        `无法读取 Gateway Windows SID：${String(cause?.message || cause).slice(0, 200)}`,
      );
    } finally {
      pendingWindowsSid = null;
    }
  })();
  return pendingWindowsSid;
}

async function hardenNewWindowsSnapshotRoot(root) {
  const currentSid = await windowsCurrentSid();
  try {
    await execFileAsync(
      "icacls.exe",
      [
        root,
        "/inheritance:r",
        "/grant:r",
        `*${currentSid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
      { windowsHide: true, timeout: 15_000, stdio: "ignore" },
    );
  } catch (cause) {
    throw snapshotError(
      "STORY_ARTIFACT_SNAPSHOT_ACL_UNSAFE",
      `无法收紧不可变快照目录 ACL：${String(cause?.message || cause).slice(0, 200)}`,
    );
  }
}

async function assertWindowsSnapshotRootAcl(root) {
  const currentSid = await windowsCurrentSid();
  const encodedRoot = Buffer.from(root, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}'))`,
    `$current='${currentSid}'`,
    "$allowed=@($current,'S-1-5-18','S-1-5-32-544')",
    "$acl=Get-Acl -LiteralPath $target",
    "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "if($allowed -notcontains $owner){exit 11}",
    "$hasCurrentFull=$false",
    "foreach($rule in @($acl.Access)){",
    " $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    " if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){exit 12}",
    " if($allowed -notcontains $sid){exit 13}",
    " if($sid -eq $current -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)){$hasCurrentFull=$true}",
    "}",
    "if(-not $hasCurrentFull){exit 14}",
  ].join(";");
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, stdio: "ignore" },
    );
  } catch (cause) {
    throw snapshotError(
      "STORY_ARTIFACT_SNAPSHOT_ACL_UNSAFE",
      `不可变快照目录 owner/DACL 未通过 allowlist 校验（acl-check=${cause?.status ?? "error"}）`,
    );
  }
}

function assertPosixSnapshotRoot(root) {
  const stat = assertNoLinkedDirectory(root, "不可变快照目录");
  if (
    (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw snapshotError(
      "STORY_ARTIFACT_SNAPSHOT_ACL_UNSAFE",
      "不可变快照目录必须由 Gateway 身份持有且不能允许 group/other 访问",
    );
  }
}

function parseSnapshotEntry(name) {
  const published = /^(\d{1,16})-([a-f0-9]{64})\.snapshot$/.exec(name);
  if (published) {
    return {
      type: "snapshot",
      expiresAt: Number(published[1]),
      id: published[2],
    };
  }
  const pending = /^\.pending-(\d{1,16})-([a-f0-9]{64})-(\d+)$/.exec(name);
  if (pending) {
    return {
      type: "pending",
      createdAt: Number(pending[1]),
      id: pending[2],
      expectedSize: Number(pending[3]),
    };
  }
  return null;
}

function safeUnlink(target) {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Gateway-owned, write-once artifact snapshot store.
 *
 * The production singleton always uses gateway/.secrets.  Constructor
 * injection exists so the storage and capacity rules can be tested without
 * touching live secrets; routes never accept a root from a request or env var.
 */
export class StoryArtifactSnapshotStore {
  constructor({
    root = STORY_ARTIFACT_SNAPSHOT_ROOT,
    maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
    gcBatchSize = DEFAULT_GC_BATCH_SIZE,
    pendingMaxAgeMs = DEFAULT_PENDING_MAX_AGE_MS,
  } = {}) {
    this.root = path.resolve(root);
    this.maxSnapshotBytes = positiveInteger(maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES);
    this.maxTotalBytes = positiveInteger(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.maxSnapshots = positiveInteger(maxSnapshots, DEFAULT_MAX_SNAPSHOTS);
    this.gcBatchSize = positiveInteger(gcBatchSize, DEFAULT_GC_BATCH_SIZE);
    this.pendingMaxAgeMs = positiveInteger(pendingMaxAgeMs, DEFAULT_PENDING_MAX_AGE_MS);
    this.reservations = new Map();
    this.exclusiveTail = Promise.resolve();
    this.rootSecurityTail = Promise.resolve();
    this.rootSecurityFingerprint = "";
    this.verifiedSnapshots = new Map();
    this.maxVerifiedCacheEntries = 1024;
  }

  async rootSecurityExclusive(callback) {
    const previous = this.rootSecurityTail;
    let release;
    this.rootSecurityTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async ensureProtectedRoot() {
    return this.rootSecurityExclusive(async () => this.ensureProtectedRootOnce());
  }

  async ensureProtectedRootOnce() {
    const parent = path.dirname(this.root);
    if (this.root === STORY_ARTIFACT_SNAPSHOT_ROOT && !fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") fs.chmodSync(parent, 0o700);
    }
    if (this.root === STORY_ARTIFACT_SNAPSHOT_ROOT) {
      assertNoLinkedDirectory(parent, "Gateway .secrets 目录");
      if (process.platform !== "win32") {
        const parentStat = fs.lstatSync(parent);
        if (
          (parentStat.mode & 0o077) !== 0
          || (typeof process.getuid === "function" && parentStat.uid !== process.getuid())
        ) {
          throw snapshotError(
            "STORY_ARTIFACT_SNAPSHOT_ACL_UNSAFE",
            "Gateway .secrets 目录必须由 Gateway 身份持有且不能允许 group/other 访问",
          );
        }
      }
    }
    let created = false;
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: false, mode: 0o700 });
      created = true;
    }
    const rootStat = assertNoLinkedDirectory(this.root, "不可变快照目录");
    const fingerprint = JSON.stringify({
      dev: integer(rootStat.dev),
      ino: integer(rootStat.ino),
      ctimeMicros: integer(Math.trunc(Number(rootStat.ctimeMs || 0) * 1000)),
      mode: integer(rootStat.mode),
      uid: integer(rootStat.uid),
    });
    if (!created && fingerprint === this.rootSecurityFingerprint) return this.root;
    if (process.platform === "win32") {
      if (created) await hardenNewWindowsSnapshotRoot(this.root);
      await assertWindowsSnapshotRootAcl(this.root);
    } else {
      if (created) fs.chmodSync(this.root, 0o700);
      assertPosixSnapshotRoot(this.root);
    }
    const verified = fs.lstatSync(this.root);
    this.rootSecurityFingerprint = JSON.stringify({
      dev: integer(verified.dev),
      ino: integer(verified.ino),
      ctimeMicros: integer(Math.trunc(Number(verified.ctimeMs || 0) * 1000)),
      mode: integer(verified.mode),
      uid: integer(verified.uid),
    });
    return this.root;
  }

  async exclusive(callback) {
    const previous = this.exclusiveTail;
    let release;
    this.exclusiveTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async scanAndCollect(now = Date.now()) {
    await this.ensureProtectedRoot();
    let count = 0;
    let bytes = 0;
    let removed = 0;
    let scanned = 0;
    const scanLimit = this.maxSnapshots + this.gcBatchSize + 1024;
    const directory = await fs.promises.opendir(this.root);
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > scanLimit) {
          throw snapshotError(
            "STORY_ARTIFACT_SNAPSHOT_CAPACITY_EXCEEDED",
            "不可变快照目录条目数量超过安全扫描上限",
            507,
          );
        }
        const parsed = parseSnapshotEntry(entry.name);
        if (!parsed || !entry.isFile() || entry.isSymbolicLink()) {
          throw snapshotError(
            "STORY_ARTIFACT_SNAPSHOT_ROOT_UNSAFE",
            "不可变快照目录包含未受管条目",
          );
        }
        const target = path.join(this.root, entry.name);
        let stat;
        try {
          stat = await fs.promises.lstat(target);
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
          throw snapshotError(
            "STORY_ARTIFACT_SNAPSHOT_ROOT_UNSAFE",
            "不可变快照目录包含链接或非普通文件",
          );
        }
        const expired = (
          parsed.type === "snapshot"
            ? parsed.expiresAt < now
            : parsed.createdAt + this.pendingMaxAgeMs < now
        );
        if (expired && removed < this.gcBatchSize) {
          safeUnlink(target);
          removed += 1;
          continue;
        }
        if (parsed.type === "pending" && this.reservations.has(parsed.id)) {
          continue;
        }
        count += 1;
        bytes += parsed.type === "pending"
          ? positiveInteger(parsed.expectedSize, integer(stat.size))
          : integer(stat.size);
        if (!Number.isSafeInteger(bytes)) {
          throw snapshotError(
            "STORY_ARTIFACT_SNAPSHOT_CAPACITY_EXCEEDED",
            "不可变快照容量统计溢出",
            507,
          );
        }
      }
    } finally {
      try { await directory.close(); } catch {}
    }
    if (removed) await fsyncDirectory(this.root);
    return { count, bytes, removed, scanned };
  }

  async garbageCollect({ now = Date.now() } = {}) {
    return this.exclusive(async () => this.scanAndCollect(now));
  }

  async createSnapshot({
    sourceFd,
    sourceStat,
    expiresAt,
    now = Date.now(),
  } = {}) {
    if (!Number.isInteger(sourceFd) || sourceFd < 0) {
      throw snapshotError("STORY_ARTIFACT_SOURCE_FD_INVALID", "产物源文件句柄无效", 400);
    }
    const expectedSource = storyArtifactFileIdentity(sourceStat);
    if (expectedSource.size > this.maxSnapshotBytes) {
      throw snapshotError(
        "STORY_ARTIFACT_SNAPSHOT_TOO_LARGE",
        "产物超过单个不可变快照容量上限",
        413,
      );
    }
    const effectiveExpiry = integer(expiresAt);
    if (effectiveExpiry <= integer(now) || effectiveExpiry - integer(now) > MAX_TTL_MS) {
      throw snapshotError("STORY_ARTIFACT_SNAPSHOT_EXPIRY_INVALID", "不可变快照有效期无效");
    }
    const id = randomBytes(32).toString("hex");
    const createdAt = integer(now);
    const pendingName = `.pending-${createdAt}-${id}-${expectedSource.size}`;
    const pendingPath = path.join(this.root, pendingName);
    const finalPath = snapshotPathInside(this.root, effectiveExpiry, id);
    await this.exclusive(async () => {
      const usage = await this.scanAndCollect(createdAt);
      let reservedBytes = 0;
      for (const value of this.reservations.values()) reservedBytes += value;
      if (
        usage.count + this.reservations.size >= this.maxSnapshots
        || usage.bytes + reservedBytes + expectedSource.size > this.maxTotalBytes
      ) {
        throw snapshotError(
          "STORY_ARTIFACT_SNAPSHOT_CAPACITY_EXCEEDED",
          "不可变快照容量已满，拒绝签发新票据",
          507,
        );
      }
      this.reservations.set(id, expectedSource.size);
    });

    let destinationFd = null;
    try {
      await this.ensureProtectedRoot();
      const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
      destinationFd = fs.openSync(
        pendingPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      const sourceBefore = fs.fstatSync(sourceFd, { bigint: true });
      if (
        !sourceBefore.isFile()
        || Number(sourceBefore.nlink || 1) !== 1
        || !sameFileIdentity(sourceBefore, sourceStat)
      ) {
        throw snapshotError(
          "STORY_ARTIFACT_SOURCE_CHANGED",
          "产物源文件在快照开始前已变化",
          409,
        );
      }
      const hash = createHash("sha256");
      if (expectedSource.size > 0) {
        const hashing = new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          fs.createReadStream(pendingPath, {
            fd: sourceFd,
            autoClose: false,
            start: 0,
            end: expectedSource.size - 1,
          }),
          hashing,
          fs.createWriteStream(pendingPath, {
            fd: destinationFd,
            autoClose: false,
          }),
        );
      }
      const sha256 = hash.digest("hex");
      await fsyncAsync(destinationFd);
      const sourceAfter = fs.fstatSync(sourceFd, { bigint: true });
      const destination = fs.fstatSync(destinationFd, { bigint: true });
      if (
        !sameFileIdentity(sourceBefore, sourceAfter)
        || !destination.isFile()
        || Number(destination.nlink || 1) !== 1
        || integer(destination.size) !== expectedSource.size
      ) {
        throw snapshotError(
          "STORY_ARTIFACT_SOURCE_CHANGED",
          "产物源文件在不可变快照复制期间发生变化",
          409,
        );
      }
      fs.closeSync(destinationFd);
      destinationFd = null;
      if (process.platform !== "win32") fs.chmodSync(pendingPath, 0o400);
      if (fs.existsSync(finalPath)) {
        throw snapshotError(
          "STORY_ARTIFACT_SNAPSHOT_COLLISION",
          "不可变快照标识冲突",
        );
      }
      // A same-volume hard-link publish is atomic and, unlike rename(), fails
      // if an unexpected final name already exists. The private pending name
      // is removed before the descriptor is returned, so the published object
      // is always an ordinary single-link file.
      fs.linkSync(pendingPath, finalPath);
      fs.unlinkSync(pendingPath);
      await fsyncDirectory(this.root);
      const published = fs.lstatSync(finalPath, { bigint: true });
      if (
        !published.isFile()
        || published.isSymbolicLink()
        || Number(published.nlink || 1) !== 1
        || integer(published.size) !== expectedSource.size
      ) {
        throw snapshotError(
          "STORY_ARTIFACT_SNAPSHOT_PUBLISH_FAILED",
          "不可变快照原子发布后校验失败",
        );
      }
      return {
        id,
        sha256,
        stat: published,
        expiresAt: effectiveExpiry,
      };
    } catch (error) {
      if (destinationFd != null) {
        try { fs.closeSync(destinationFd); } catch {}
      }
      try { safeUnlink(pendingPath); } catch {}
      try { safeUnlink(finalPath); } catch {}
      throw error;
    } finally {
      await this.exclusive(async () => {
        this.reservations.delete(id);
      });
    }
  }

  async openSnapshot({ id, expiresAt, now = Date.now() } = {}) {
    if (integer(expiresAt) < integer(now)) {
      throw snapshotError("STORY_ARTIFACT_TICKET_EXPIRED", "不可变快照已过期", 403);
    }
    await this.ensureProtectedRoot();
    const target = snapshotPathInside(this.root, expiresAt, id);
    let before;
    try {
      before = fs.lstatSync(target, { bigint: true });
    } catch {
      throw snapshotError("STORY_ARTIFACT_SNAPSHOT_NOT_FOUND", "不可变快照不存在", 403);
    }
    if (!before.isFile() || before.isSymbolicLink() || Number(before.nlink || 1) !== 1) {
      throw snapshotError("STORY_ARTIFACT_SNAPSHOT_CHANGED", "不可变快照类型或链接数无效", 403);
    }
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd, { bigint: true });
      const after = fs.lstatSync(target, { bigint: true });
      if (
        !opened.isFile()
        || Number(opened.nlink || 1) !== 1
        || !sameFileIdentity(before, opened)
        || !sameFileIdentity(opened, after)
      ) {
        throw snapshotError("STORY_ARTIFACT_SNAPSHOT_CHANGED", "不可变快照打开期间发生变化", 403);
      }
      return { fd, stat: opened, target };
    } catch (error) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
      throw error;
    }
  }

  async verifyOpenedSnapshot({
    fd,
    stat,
    expectedSha256,
    expectedStat,
  } = {}) {
    if (!Number.isInteger(fd) || fd < 0) {
      throw snapshotError("STORY_ARTIFACT_SNAPSHOT_FD_INVALID", "不可变快照句柄无效", 403);
    }
    const before = fs.fstatSync(fd, { bigint: true });
    const encodedExpectedStat = expectedStat?.isFile?.()
      ? storyArtifactFileIdentity(expectedStat)
      : expectedStat;
    if (
      !sameFileIdentity(before, stat)
      || !sameEncodedIdentity(
        storyArtifactFileIdentity(before),
        encodedExpectedStat,
      )
    ) {
      throw snapshotError("STORY_ARTIFACT_SNAPSHOT_CHANGED", "不可变快照身份不匹配", 403);
    }
    const identityKey = `${JSON.stringify(storyArtifactFileIdentity(before))}:${String(expectedSha256 || "").toLowerCase()}`;
    if (this.verifiedSnapshots.get(identityKey) === true) {
      const after = fs.fstatSync(fd, { bigint: true });
      if (!sameFileIdentity(before, after)) {
        throw snapshotError("STORY_ARTIFACT_SNAPSHOT_CHANGED", "不可变快照身份不匹配", 403);
      }
      return true;
    }
    const hash = createHash("sha256");
    if (integer(before.size) > 0) {
      const stream = fs.createReadStream(this.root, {
        fd,
        autoClose: false,
        start: 0,
        end: integer(before.size) - 1,
      });
      for await (const chunk of stream) hash.update(chunk);
    }
    const actual = Buffer.from(hash.digest("hex"), "ascii");
    const expected = Buffer.from(String(expectedSha256 || "").toLowerCase(), "ascii");
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      expected.length !== actual.length
      || !timingSafeEqual(expected, actual)
      || !sameFileIdentity(before, after)
    ) {
      throw snapshotError("STORY_ARTIFACT_SNAPSHOT_CHANGED", "不可变快照哈希或身份不匹配", 403);
    }
    if (this.verifiedSnapshots.size >= this.maxVerifiedCacheEntries) {
      const firstKey = this.verifiedSnapshots.keys().next().value;
      if (firstKey !== undefined) this.verifiedSnapshots.delete(firstKey);
    }
    this.verifiedSnapshots.set(identityKey, true);
    return true;
  }

  async deleteSnapshot({ id, expiresAt, stat } = {}) {
    await this.ensureProtectedRoot();
    const target = snapshotPathInside(this.root, expiresAt, id);
    let live;
    try {
      live = fs.lstatSync(target, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (
      !live.isFile()
      || live.isSymbolicLink()
      || Number(live.nlink || 1) !== 1
      || (stat && !sameEncodedIdentity(
        storyArtifactFileIdentity(live),
        storyArtifactFileIdentity(stat),
      ))
    ) {
      throw snapshotError("STORY_ARTIFACT_SNAPSHOT_CHANGED", "拒绝删除身份不匹配的不可变快照");
    }
    const removed = safeUnlink(target);
    if (removed) await fsyncDirectory(this.root);
    return removed;
  }
}

export const storyArtifactSnapshotStore = new StoryArtifactSnapshotStore();
export const STORY_ARTIFACT_TICKET_TTL_MS = DEFAULT_TTL_MS;
