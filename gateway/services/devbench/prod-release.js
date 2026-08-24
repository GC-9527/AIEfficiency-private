/**
 * 发布生产纯逻辑（无 IO 副作用之外的依赖，便于单测）：
 *   - findProdReleaseApk / findMappingFile：在 build/outputs 下定位 prod release 产物（prod+release 优先，取最新）
 *   - datedReleaseDir：把「车型基目录」按规则补成实际发布目录 <base>\<本周五 YYYY-MMDD>\Temp_<今天 YYYYMMDD>
 * 从 routes/devbench.js 抽出，避免单测被路由层重依赖(puppeteer/claude-proxy 等)拖累。
 */
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";

const DEFAULT_FLAVOR_ALIAS_GROUPS = [
  ["zeekr9x", "zeekr 9x", "极氪9x", "极氪 9x"],
  ["avatr8678", "avatr 8678", "阿维塔8678", "阿维塔 8678"],
  ["avatr8155", "avatr 8155", "阿维塔8155", "阿维塔 8155"],
  ["geelye22", "geely e22", "e22"],
  ["geelyp162", "geely p162", "p162"],
  ["geelyss21", "geely ss21", "ss21"],
];

const DEFAULT_BRAND_ALIAS_GROUPS = [
  ["avatr", "avatar", "阿维塔"],
  ["zeekr", "极氪"],
  ["geely", "吉利"],
  ["baic", "北汽"],
  ["seres", "赛力斯"],
];

function compactToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()#]/g, "")
    .replace(/[\s_\-./\\]+/g, "")
    .trim();
}

function stripBuildVariant(value) {
  let s = compactToken(value);
  for (;;) {
    const next = s.replace(/(?:prod|production|release|debug|dev|staging|beta)$/i, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

function usableKeyword(value) {
  const s = compactToken(value);
  if (!s) return "";
  if (s.length >= 3) return s;
  return /[\u4e00-\u9fff]/.test(s) ? s : "";
}

function expandFlavorAliases(flavor) {
  const raw = String(flavor || "").trim();
  const variants = new Set([usableKeyword(raw), usableKeyword(stripBuildVariant(raw))].filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of DEFAULT_FLAVOR_ALIAS_GROUPS) {
      const normalized = group.map(usableKeyword).filter(Boolean);
      if (!normalized.some((item) => variants.has(item))) continue;
      for (const item of normalized) {
        if (!variants.has(item)) { variants.add(item); changed = true; }
      }
    }
  }
  return [...variants];
}

function lineMatchesAnyKeyword(line, keywords) {
  const haystack = compactToken(line);
  return keywords.some((keyword) => keyword && haystack.includes(keyword));
}

function flavorBrandAliases(flavor) {
  const compact = compactToken(flavor);
  const hit = DEFAULT_BRAND_ALIAS_GROUPS.find((group) => group.map(compactToken).some((keyword) => compact.includes(keyword)));
  return hit ? hit.map(usableKeyword).filter(Boolean) : [];
}

function lineMatchesBrandKeyword(line, keywords) {
  if (!keywords.length) return false;
  const text = String(line || "");
  const bracketTokens = [];
  text.replace(/[【\[]([^】\]\r\n]+)[】\]]/g, (_, token) => {
    bracketTokens.push(compactToken(token));
    return "";
  });
  const loose = compactToken(text);
  return keywords.some((keyword) => {
    const k = compactToken(keyword);
    if (!k) return false;
    if (/[\u4e00-\u9fff]/.test(k)) return loose.includes(k);
    if (bracketTokens.some((token) => token === k)) return true;
    return new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`, "i").test(text);
  });
}

function isVersionToken(value) {
  return /^\d+(?:\.\d+){1,4}$/.test(String(value || "").trim()) || /^\d{4,}$/.test(String(value || "").trim());
}

function isTicketToken(value) {
  return /^[A-Z]+-\d+$/i.test(String(value || "").trim());
}

function flavorLikeFragments(value) {
  const raw = String(value || "").trim();
  if (!raw || isVersionToken(raw) || isTicketToken(raw)) return [];
  const lower = raw.toLowerCase();
  const fragments = new Set();
  const pattern = /\b(?:avatr|avatar|zeekr|geely|baic|seres|chery|byd|gwm|haval|neta|changan|lynk|voyah|nio|xpeng)[a-z0-9_-]*\b/g;
  let match;
  while ((match = pattern.exec(lower))) {
    const fragment = stripBuildVariant(match[0]);
    if (fragment && !isTicketToken(fragment) && !isVersionToken(fragment)) fragments.add(fragment);
  }
  return [...fragments];
}

function explicitFlavorTokens(line, knownFlavors = []) {
  const known = new Set([
    ...knownFlavors,
    ...DEFAULT_FLAVOR_ALIAS_GROUPS.flat(),
  ].map(stripBuildVariant).map(usableKeyword).filter(Boolean));
  const tokens = [];
  String(line || "").replace(/#([^#\r\n]+)#/g, (_, token) => {
    const direct = usableKeyword(stripBuildVariant(token));
    if (known.has(direct)) tokens.push(direct);
    for (const fragment of flavorLikeFragments(token)) tokens.push(fragment);
    return "";
  });
  return [...new Set(tokens)];
}

/**
 * 过滤发版改动列表中的其它 flavor/车型改动。
 *
 * 规则：
 * - commit message 中有 #flavor# 等显式 flavor 标签时，只保留当前 flavor；
 * - 明确命中当前 flavor/车型别名：保留；
 * - 明确命中其它已知 flavor/车型别名，且未命中当前 flavor：过滤；
 * - 只有车厂级标签（如【阿维塔】/【北汽】）时，按当前 flavor 所属车厂过滤；
 * - 没有 flavor 信号的提交视为公共改动：保留。
 */
export function filterChangeLinesByFlavor(lines, flavor, knownFlavors = []) {
  const source = Array.isArray(lines)
    ? lines
    : String(lines || "").split(/\r?\n/);
  const cleaned = source.map((line) => String(line || "").trim()).filter(Boolean);
  if (!flavor) return cleaned;

  const currentKeywords = expandFlavorAliases(flavor);
  if (!currentKeywords.length) return cleaned;
  const currentBrandKeywords = flavorBrandAliases(flavor);

  const allFlavorSeeds = new Set([
    ...DEFAULT_FLAVOR_ALIAS_GROUPS.flat(),
    ...knownFlavors,
    flavor,
  ].map((item) => String(item || "").trim()).filter(Boolean));
  const otherKeywordGroups = [];
  for (const item of allFlavorSeeds) {
    const group = expandFlavorAliases(item);
    if (!group.length) continue;
    if (group.some((keyword) => currentKeywords.includes(keyword))) continue;
    if (otherKeywordGroups.some((existing) => existing.some((keyword) => group.includes(keyword)))) continue;
    otherKeywordGroups.push(group);
  }
  const otherBrandGroups = [];
  for (const group of DEFAULT_BRAND_ALIAS_GROUPS) {
    const normalized = group.map(usableKeyword).filter(Boolean);
    if (!normalized.length) continue;
    if (normalized.some((keyword) => currentBrandKeywords.includes(keyword))) continue;
    otherBrandGroups.push(normalized);
  }

  return cleaned.filter((line) => {
    const explicit = explicitFlavorTokens(line, knownFlavors);
    if (explicit.length) return explicit.some((token) => lineMatchesAnyKeyword(token, currentKeywords));

    const matchesCurrentFlavor = lineMatchesAnyKeyword(line, currentKeywords);
    if (matchesCurrentFlavor) return true;
    const matchesOtherFlavor = otherKeywordGroups.some((group) => lineMatchesAnyKeyword(line, group));
    if (matchesOtherFlavor) return false;

    const matchesCurrentBrand = lineMatchesBrandKeyword(line, currentBrandKeywords);
    if (matchesCurrentBrand) return true;
    const matchesOtherBrand = otherBrandGroups.some((group) => lineMatchesBrandKeyword(line, group));
    return !matchesOtherBrand;
  });
}

export function publishExpectedFingerprint(expected) {
  return String(expected?.sha256 || "").trim();
}

// 在 root 下递归发现所有 build/outputs/<kind> 目录（任意层级，限深防爆、跳过无关重目录）。
// 兼容三种工程布局：① root 本身即模块(build 在 root 下)；② root/app（标准单层模块）；
// ③ root/<子工程>/app（远程拉取/克隆仓库根多套一层，apk 在 2 级深处）—— 此前只扫 root + 直接子级会漏掉③导致「有 apk 却判无」。
export function collectOutputRoots(root, kind, maxDepth = 3) {
  const found = [];
  if (!root || !existsSync(root)) return found;
  // 这些目录不可能含 build/outputs，递归时跳过以免遍历源码树/依赖拖慢
  const SKIP = new Set(["node_modules", ".git", ".gradle", ".idea", "src", "assets", "res", "java", "kotlin"]);
  const walk = (dir, depth) => {
    const cand = path.join(dir, "build", "outputs", kind);
    if (existsSync(cand)) found.push(cand);
    if (depth >= maxDepth) return;
    let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory()) continue;
      const n = e.name;
      if (n === "build" || n.startsWith(".") || SKIP.has(n)) continue;
      walk(path.join(dir, n), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

// 找 prod release apk（prod+release 路径优先，再按 mtime 最新）。无则 null。
export function findProdReleaseApk(root) {
  const out = [];
  const roots = collectOutputRoots(root, "apk");
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      // debug 包绝不能发到生产：路径含 debug 直接排除（宁缺勿发 debug）。
      else if (e.isFile() && e.name.toLowerCase().endsWith(".apk") && !/debug/i.test(full)) { try { out.push({ p: full, t: statSync(full).mtimeMs }); } catch {} }
    }
  };
  for (const r of roots) walk(r);
  if (!out.length) return null;
  // 发布生产要的是 prod **release**：release 是主信号(权重更高)，故 prod+release > 任意 release > 仅 prod。
  // 只按工程根内的相对产物路径评分。绝对路径的父目录名可能恰好含 prod
  // （测试临时目录 prodapk-*、真实工程名 Product 等），不能让它污染变体判断。
  const score = (p) => { const s = path.relative(root, p).toLowerCase(); return (/release/.test(s) ? 2 : 0) + (/prod/.test(s) ? 1 : 0); };
  out.sort((a, b) => (score(b.p) - score(a.p)) || (b.t - a.t));
  return out[0].p;
}

// 找对应 mapping.txt（优先 prod+release 变体，取最新）
export function findMappingFile(root) {
  const bases = collectOutputRoots(root, "mapping");
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      // 与 apk 配套：debug 变体的 mapping 不纳入候选，避免给 release apk 配错 mapping。
      else if (e.isFile() && e.name.toLowerCase() === "mapping.txt" && !/debug/i.test(full)) { try { out.push({ p: full, t: statSync(full).mtimeMs }); } catch {} }
    }
  };
  for (const b of bases) walk(b);
  if (!out.length) return null;
  // Score only the path inside the project. Parent directories such as a
  // temporary "prodapk-*" folder must not make every candidate look like prod.
  const score = (p) => { const s = path.relative(root, p).toLowerCase(); return (/release/.test(s) ? 2 : 0) + (/prod/.test(s) ? 1 : 0); };
  out.sort((a, b) => (score(b.p) - score(a.p)) || (b.t - a.t));
  return out[0].p;
}

// 按规则把「车型基目录」补成实际发布目录：<base>\<本周五 YYYY-MMDD>\Temp_<今天 YYYYMMDD>
// 本周五：本周(周一为起)的周五；若今天已过本周五(周六/日)则用下周五。
// 智能识别：若用户已填到含 Temp_<日期> 段的【完整目录】，则原样使用、不再追加日期子级。
// now 可注入(默认当前时间)，便于确定性单测。
export function datedReleaseDir(base, now = new Date()) {
  const b = String(base || "").replace(/[\\/]+$/, "");
  if (/(^|[\\/])Temp_\d{6,}([\\/]|$)/i.test(b)) return b; // 已是完整发布目录，直接用
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isoDow = today.getDay() === 0 ? 7 : today.getDay(); // 周一=1..周日=7
  let diff = 5 - isoDow; if (diff < 0) diff += 7; // 到（本/下）周五的天数
  const fri = new Date(today); fri.setDate(fri.getDate() + diff);
  const friStr = `${fri.getFullYear()}-${pad(fri.getMonth() + 1)}${pad(fri.getDate())}`; // 2026-0619
  const todayStr = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`; // 20260619
  const sep = (/^\\\\|^[a-zA-Z]:\\|\\/.test(b)) ? "\\" : "/"; // UNC/Windows 用反斜杠
  return `${b}${sep}${friStr}${sep}Temp_${todayStr}`;
}
