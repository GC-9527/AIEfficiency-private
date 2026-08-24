import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IDENTITY_PATH = path.resolve(__dirname, "..", "..", ".secrets", "lan-sync-identity.json");
let cached = null;
let cachedPath = "";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function fingerprintPublicKey(publicKeyPem) {
  const key = createPublicKey(String(publicKeyPem || ""));
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function identityPath() {
  return path.resolve(process.env.LAN_SYNC_IDENTITY_PATH || DEFAULT_IDENTITY_PATH);
}

function createIdentity(target) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const data = {
    version: 1,
    algorithm: "Ed25519",
    createdAt: Date.now(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  try { chmodSync(target, 0o600); } catch {}
  return data;
}

function readIdentity(target) {
  const raw = JSON.parse(readFileSync(target, "utf8"));
  if (raw?.version !== 1 || !raw.publicKey || !raw.privateKey) {
    throw new Error("LAN 同步设备身份文件格式不正确");
  }
  const fingerprint = fingerprintPublicKey(raw.publicKey);
  // 同时解析私钥，启动时尽早发现截断或被替换的本机身份文件。
  createPrivateKey(raw.privateKey);
  return { ...raw, fingerprint };
}

export function getLanSyncIdentity() {
  const target = identityPath();
  if (cached && cachedPath === target) return cached;
  if (!existsSync(target)) createIdentity(target);
  cached = readIdentity(target);
  cachedPath = target;
  return cached;
}

export function lanSyncNodeId() {
  return `lan-${getLanSyncIdentity().fingerprint.slice(0, 24)}`;
}

export function signLanSyncValue(value) {
  const identity = getLanSyncIdentity();
  return sign(
    null,
    Buffer.from(canonicalJson(value), "utf8"),
    createPrivateKey(identity.privateKey),
  ).toString("base64");
}

export function verifyLanSyncValue(value, signature, publicKeyPem) {
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(value), "utf8"),
      createPublicKey(String(publicKeyPem || "")),
      Buffer.from(String(signature || ""), "base64"),
    );
  } catch {
    return false;
  }
}
