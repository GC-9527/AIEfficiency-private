import {
  gitRemoteUrlCandidates,
  safeGitRemoteError,
  safeGitRemoteUrl,
} from "./git-remote.js";

function remoteTransport(url) {
  const value = String(url || "").trim();
  if (/^https?:\/\//i.test(value)) return "https";
  if (/^(?:[^@/\s]+@)?[^:/\s]+:.+/.test(value) || /^ssh:\/\//i.test(value)) return "ssh";
  return "git";
}

export function buildRepoAccessCandidates(definition = {}, localRemoteUrls = []) {
  const rows = [
    ...localRemoteUrls.flatMap((url) => (
      gitRemoteUrlCandidates(url).map((candidateUrl) => ({ url: candidateUrl, source: "local-origin" }))
    )),
    ...gitRemoteUrlCandidates(definition.https).map((url) => ({ url, source: "definition" })),
    ...gitRemoteUrlCandidates(definition.ssh).map((url) => ({ url, source: "definition" })),
  ];
  const seen = new Set();
  return rows
    .map((row) => ({ ...row, url: String(row.url || "").trim() }))
    .filter((row) => {
      if (!row.url || seen.has(row.url)) return false;
      seen.add(row.url);
      return true;
    })
    .map((row) => ({ ...row, transport: remoteTransport(row.url) }));
}

export async function checkRepositoryAccess({
  definition = {},
  localRemoteUrls = [],
  force = false,
  probe,
} = {}) {
  if (typeof probe !== "function") throw new TypeError("probe 必须是函数");
  const candidates = buildRepoAccessCandidates(definition, localRemoteUrls);
  if (!candidates.length) {
    return { hasAccess: false, url: "", transport: "", attempts: [], error: "该仓库未配置 git 地址" };
  }

  const attempts = [];
  for (const candidate of candidates) {
    let result;
    try {
      result = await probe(candidate.url, force);
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    const attempt = {
      url: safeGitRemoteUrl(candidate.url),
      transport: candidate.transport,
      source: candidate.source,
      ok: result?.ok === true,
      cached: result?.cached === true,
      error: result?.ok === true ? null : safeGitRemoteError(result?.error, candidate.url),
    };
    attempts.push(attempt);
    if (attempt.ok) {
      return {
        hasAccess: true,
        url: attempt.url,
        transport: attempt.transport,
        source: attempt.source,
        cached: attempt.cached,
        attempts,
        error: null,
      };
    }
  }

  const error = attempts
    .map((attempt) => `[${attempt.transport.toUpperCase()}] ${attempt.error}`)
    .join("\n")
    .slice(0, 1200);
  return {
    hasAccess: false,
    url: attempts[0]?.url || "",
    transport: "",
    attempts,
    error,
  };
}
