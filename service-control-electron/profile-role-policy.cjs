const path = require("path");

const PRIMARY_DEVELOPMENT_PROFILE_ID = "development";
const DEVELOPMENT_PROFILE_RE = /^development(?:-(\d+))?$/;

function isDevelopmentProfileId(profileId) {
  return DEVELOPMENT_PROFILE_RE.test(String(profileId || ""));
}

function developmentIndexFromId(profileId) {
  if (profileId === PRIMARY_DEVELOPMENT_PROFILE_ID) return 0;
  const match = String(profileId || "").match(DEVELOPMENT_PROFILE_RE);
  const number = match?.[1] ? Number(match[1]) : 1;
  return Number.isInteger(number) && number > 1 ? number - 1 : 0;
}

function configuredDevelopmentIds(profiles = {}) {
  return Object.keys(profiles || {})
    .filter(isDevelopmentProfileId)
    .sort((a, b) => developmentIndexFromId(a) - developmentIndexFromId(b));
}

function nextDevelopmentProfileId(profiles = {}) {
  if (!profiles?.[PRIMARY_DEVELOPMENT_PROFILE_ID]?.repoRoot) return PRIMARY_DEVELOPMENT_PROFILE_ID;
  const used = new Set(configuredDevelopmentIds(profiles));
  for (let n = 2; n < 100; n += 1) {
    const id = `development-${n}`;
    if (!used.has(id)) return id;
  }
  throw new Error("Too many development environments are configured.");
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

function cloneProfiles(profiles = {}) {
  return Object.fromEntries(
    Object.entries(profiles || {}).map(([id, profile]) => [id, { ...(profile || {}) }]),
  );
}

function findDevelopmentByRoot(profiles, repoRoot) {
  return configuredDevelopmentIds(profiles)
    .find((id) => samePath(profiles[id]?.repoRoot, repoRoot)) || "";
}

/**
 * Apply startup repository hints without changing a persisted role implicitly.
 *
 * --repo/AIEFFICIENCY_REPO can seed an empty Production role, but must not
 * overwrite a persisted role. --dev-repo/--dev-repos and the source checkout
 * fallback are Development hints only. If a hinted repository is already
 * configured as Production, Production wins and no duplicate Development tab
 * is created.
 */
function applyStartupRepoRoles(
  profiles = {},
  {
    sourceRoot = "",
    explicitProductionRoot = "",
    explicitDevelopmentRoots = [],
  } = {},
) {
  const next = cloneProfiles(profiles);
  next.production = { ...(next.production || {}) };

  if (explicitProductionRoot && !next.production.repoRoot) {
    next.production.repoRoot = explicitProductionRoot;
  }

  // Heal legacy duplicate state created by older startup logic. A repository
  // cannot be both Production and Development; the persisted Production choice
  // is authoritative.
  for (const id of configuredDevelopmentIds(next)) {
    if (samePath(next[id]?.repoRoot, next.production?.repoRoot)) delete next[id];
  }

  for (const repoRoot of explicitDevelopmentRoots) {
    if (!repoRoot || samePath(next.production?.repoRoot, repoRoot)) continue;
    if (findDevelopmentByRoot(next, repoRoot)) continue;
    const id = nextDevelopmentProfileId(next);
    next[id] = { ...(next[id] || {}), repoRoot };
  }

  if (!explicitProductionRoot && explicitDevelopmentRoots.length === 0 && sourceRoot) {
    const alreadyProduction = samePath(next.production?.repoRoot, sourceRoot);
    const alreadyDevelopment = findDevelopmentByRoot(next, sourceRoot);
    if (!alreadyProduction && !alreadyDevelopment) {
      const id = nextDevelopmentProfileId(next);
      next[id] = { ...(next[id] || {}), repoRoot: sourceRoot };
    }
  }

  return next;
}

module.exports = {
  PRIMARY_DEVELOPMENT_PROFILE_ID,
  applyStartupRepoRoles,
  configuredDevelopmentIds,
  developmentIndexFromId,
  isDevelopmentProfileId,
  nextDevelopmentProfileId,
};
