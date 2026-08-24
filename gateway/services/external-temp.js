import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SERVICE_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function prospectiveRealPath(target) {
  const resolved = path.resolve(String(target || ""));
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (!fs.existsSync(existing)) return resolved;
  const realExisting = fs.realpathSync.native(existing);
  return path.resolve(realExisting, path.relative(existing, resolved));
}

function assertSeparated(target, avoidRoots = []) {
  const lexicalTarget = path.resolve(target);
  const realTarget = prospectiveRealPath(target);
  for (const value of [SERVICE_REPOSITORY_ROOT, ...avoidRoots]) {
    const raw = String(value || "").trim();
    if (!raw || !path.isAbsolute(raw)) continue;
    const lexicalAvoid = path.resolve(raw);
    const realAvoid = prospectiveRealPath(lexicalAvoid);
    const overlaps = inside(lexicalTarget, lexicalAvoid)
      || inside(lexicalAvoid, lexicalTarget)
      || inside(realTarget, realAvoid)
      || inside(realAvoid, realTarget);
    if (overlaps) {
      throw Object.assign(
        new Error(`外置临时目录不能与源码路径重叠：${target}`),
        { code: "EXTERNAL_TEMP_SOURCE_OVERLAP" },
      );
    }
  }
}

function validateSegment(value) {
  const segment = String(value || "").trim();
  if (!segment || segment === "." || segment === ".."
    || path.basename(segment) !== segment
    || path.win32.basename(segment) !== segment
    || path.posix.basename(segment) !== segment) {
    throw new Error(`临时目录名称无效：${value}`);
  }
  return segment;
}

function ensurePlainChild(parent, name) {
  const segment = validateSegment(name);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`临时目录父路径不是普通目录：${parent}`);
  }
  const target = path.join(parent, segment);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`临时目录不是普通目录：${target}`);
    }
  } else {
    fs.mkdirSync(target);
  }
  const realParent = fs.realpathSync.native(parent);
  const realTarget = fs.realpathSync.native(target);
  if (!inside(realParent, realTarget)) {
    throw new Error(`临时目录解析后越界：${target}`);
  }
  return target;
}

export function ensureExternalTempDirectory(segments = [], { avoidRoots = [] } = {}) {
  const names = (Array.isArray(segments) ? segments : [segments]).map(validateSegment);
  const systemTemp = path.resolve(os.tmpdir());
  const stat = fs.statSync(systemTemp);
  if (!stat.isDirectory()) throw new Error(`系统临时路径不是目录：${systemTemp}`);
  const candidate = path.join(systemTemp, ...names);
  assertSeparated(candidate, avoidRoots);

  // 系统临时根在 macOS 等环境可能本身是链接；从其真实目录开始逐级创建，
  // 固定子目录则一律禁止符号链接或 junction。
  let current = fs.realpathSync.native(systemTemp);
  for (const name of names) current = ensurePlainChild(current, name);
  assertSeparated(current, avoidRoots);
  return current;
}

export function ensurePlainExternalChildDirectory(parent, name, { avoidRoots = [] } = {}) {
  const resolvedParent = path.resolve(String(parent || ""));
  if (!fs.existsSync(resolvedParent)) {
    throw new Error(`外置临时目录不存在：${resolvedParent}`);
  }
  assertSeparated(resolvedParent, avoidRoots);
  const target = ensurePlainChild(resolvedParent, name);
  assertSeparated(target, avoidRoots);
  return target;
}
