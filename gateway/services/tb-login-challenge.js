import { createHash, randomBytes } from "crypto";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const challenges = new Map();
let activeChallengeHash = "";

function challengeHash(token) {
  const value = String(token || "").trim();
  return value
    ? createHash("sha256").update(value, "utf8").digest("hex")
    : "";
}

function cleanup(now = Date.now()) {
  for (const [hash, challenge] of challenges) {
    if (challenge.expiresAt <= now || challenge.consumed) challenges.delete(hash);
  }
  if (activeChallengeHash && !challenges.has(activeChallengeHash)) activeChallengeHash = "";
}

export function beginTbLoginChallenge({ now = Date.now() } = {}) {
  cleanup(now);
  const token = randomBytes(32).toString("base64url");
  const hash = challengeHash(token);
  challenges.set(hash, {
    status: "pending",
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
    userInfo: null,
    consumed: false,
  });
  activeChallengeHash = hash;
  return token;
}

export function completeTbLoginChallenge(token, userInfo, { now = Date.now() } = {}) {
  cleanup(now);
  const hash = challengeHash(token);
  const challenge = challenges.get(hash);
  const userId = String(userInfo?.userId || userInfo?.id || "").trim();
  if (!challenge || hash !== activeChallengeHash || challenge.status !== "pending" || !userId) return false;
  challenge.status = "ready";
  challenge.userInfo = {
    userId,
    name: String(userInfo?.name || userInfo?.user || userId),
  };
  challenge.completedAt = now;
  return true;
}

export function cancelTbLoginChallenge(token, { now = Date.now() } = {}) {
  cleanup(now);
  const hash = challengeHash(token);
  const challenge = challenges.get(hash);
  if (!challenge || hash !== activeChallengeHash || challenge.status !== "pending") return false;
  challenge.status = "cancelled";
  challenge.expiresAt = Math.min(challenge.expiresAt, now + 30_000);
  activeChallengeHash = "";
  return true;
}

export function isActiveTbLoginChallenge(token, { now = Date.now() } = {}) {
  cleanup(now);
  const hash = challengeHash(token);
  const challenge = challenges.get(hash);
  return Boolean(challenge && hash === activeChallengeHash && challenge.status === "pending");
}

export function discardTbLoginChallenge(token) {
  const hash = challengeHash(token);
  if (!hash) return false;
  const removed = challenges.delete(hash);
  if (activeChallengeHash === hash) activeChallengeHash = "";
  return removed;
}

export function consumeTbLoginChallenge(token, { now = Date.now() } = {}) {
  cleanup(now);
  const hash = challengeHash(token);
  const challenge = challenges.get(hash);
  if (!challenge) return { ok: false, code: "TB_LOGIN_CHALLENGE_INVALID", error: "TB 登录凭据无效或已过期" };
  if (challenge.status === "pending") {
    return { ok: false, code: "TB_LOGIN_CHALLENGE_PENDING", error: "请先完成 Teambition 扫码登录" };
  }
  if (challenge.status !== "ready" || !challenge.userInfo) {
    challenges.delete(hash);
    return { ok: false, code: "TB_LOGIN_CHALLENGE_INVALID", error: "TB 登录未完成，请重新扫码" };
  }
  challenge.consumed = true;
  challenges.delete(hash);
  if (activeChallengeHash === hash) activeChallengeHash = "";
  return { ok: true, userInfo: challenge.userInfo };
}

export function __resetTbLoginChallengesForTests() {
  challenges.clear();
  activeChallengeHash = "";
}
