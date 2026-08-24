import { createHash } from "node:crypto";

const TOKEN_VERSION = "devbench-controller-internal-ref-v1";
// 192 SHA-256 bits provide a collision-resistant production identifier while
// leaving enough MAX_PATH headroom for the Controller's already-hashed mirror
// directory and Git's transient ".lock" suffix on Windows.
const TOKEN_LENGTH = 32;

function requiredPart(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`${label} is required for a Controller internal ref`);
  }
  return normalized;
}

/**
 * Return a fixed-width, domain-separated SHA-256 token.
 *
 * Each logical part is length-prefixed before hashing so distinct tuples
 * cannot alias through separators. The full digest is encoded as unpadded
 * base64url and truncated to 192 bits (32 ASCII characters), keeping loose-ref
 * paths short on Windows.
 */
export function controllerInternalRefToken(domain, parts = []) {
  const normalizedDomain = requiredPart(domain, "internal ref domain");
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("Controller internal ref token requires logical parts");
  }
  const hash = createHash("sha256");
  hash.update(`${TOKEN_VERSION.length}:${TOKEN_VERSION}`);
  hash.update(`${normalizedDomain.length}:${normalizedDomain}`);
  for (const [index, rawPart] of parts.entries()) {
    const part = requiredPart(rawPart, `internal ref part ${index}`);
    const bytes = Buffer.from(part, "utf8");
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  const token = hash.digest("base64url").slice(0, TOKEN_LENGTH);
  if (token.length !== TOKEN_LENGTH) {
    throw new Error("Unexpected SHA-256 base64url token width");
  }
  return token;
}

export function controllerAcceptedRef(remoteId, branch) {
  return `refs/devbench/accepted/a-${
    controllerInternalRefToken("accepted", [remoteId, branch])
  }`;
}

export function controllerAcceptedHistoryRef(remoteId, branch, generation) {
  const normalizedGeneration = Number(generation);
  if (!Number.isSafeInteger(normalizedGeneration) || normalizedGeneration < 1) {
    throw new TypeError(
      "Accepted history Controller ref requires a positive safe generation",
    );
  }
  return `refs/devbench/accepted-history/h-${
    controllerInternalRefToken("accepted-history", [
      remoteId,
      branch,
      String(normalizedGeneration),
    ])
  }`;
}

export function controllerIncomingRef(operationId, branch) {
  return `refs/devbench/incoming/i-${
    controllerInternalRefToken("incoming", [operationId, branch])
  }`;
}

export function controllerBaseDestinationRef(remoteId, branch) {
  return `refs/remotes/devbench/b-${
    controllerInternalRefToken("base-destination", [remoteId, branch])
  }`;
}

export const INTERNAL_REF_TOKEN_LENGTH = TOKEN_LENGTH;
