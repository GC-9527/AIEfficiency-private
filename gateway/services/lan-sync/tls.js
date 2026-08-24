import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_ROOT = path.resolve(__dirname, "..", "..");

function resolveCredentialPath(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const base = process.env.GATEWAY_CONFIG_PATH
    ? path.dirname(path.resolve(process.env.GATEWAY_CONFIG_PATH))
    : GATEWAY_ROOT;
  return path.resolve(base, input);
}

export function lanSyncTlsConfig(config = getConfig()) {
  const raw = config.lanSync?.mtls || {};
  return {
    enabled: raw.enabled === true,
    required: raw.enabled === true && raw.required !== false,
    caPath: resolveCredentialPath(process.env.LAN_SYNC_TLS_CA_PATH || raw.caPath),
    certPath: resolveCredentialPath(process.env.LAN_SYNC_TLS_CERT_PATH || raw.certPath),
    keyPath: resolveCredentialPath(process.env.LAN_SYNC_TLS_KEY_PATH || raw.keyPath),
    serverName: String(process.env.LAN_SYNC_TLS_SERVER_NAME || raw.serverName || "").trim(),
  };
}

function credentialFiles(config = getConfig()) {
  const tls = lanSyncTlsConfig(config);
  if (!tls.enabled) return { tls };
  for (const [label, target] of [["CA", tls.caPath], ["certificate", tls.certPath], ["private key", tls.keyPath]]) {
    if (!target) throw new Error(`LAN sync mTLS ${label} path is required`);
  }
  return {
    tls,
    ca: readFileSync(tls.caPath),
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
  };
}

export function lanSyncServerTlsOptions(config = getConfig()) {
  const files = credentialFiles(config);
  if (!files.tls.enabled) return null;
  return {
    ca: files.ca,
    cert: files.cert,
    key: files.key,
    requestCert: true,
    // 普通 Dashboard 浏览器不持有设备证书；LAN channel 在升级后单独强制 authorized。
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
  };
}

export function lanSyncClientTlsOptions(config = getConfig()) {
  const files = credentialFiles(config);
  if (!files.tls.enabled) return {};
  return {
    ca: files.ca,
    cert: files.cert,
    key: files.key,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    ...(files.tls.serverName ? { servername: files.tls.serverName } : {}),
  };
}
