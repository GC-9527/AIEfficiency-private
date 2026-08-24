import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { canonicalJson } from "./identity.js";

const CHANNEL_VERSION = 1;
const NONCE_PREFIX_BYTES = 4;
const NONCE_COUNTER_BYTES = 8;
const KEY_BYTES = 32;

function fail(message, code = "LAN_SYNC_CHANNEL_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function decode(value, label) {
  try {
    const bytes = Buffer.from(String(value || ""), "base64url");
    if (!bytes.length) fail(`${label} 为空`);
    return bytes;
  } catch {
    return fail(`${label} 格式无效`);
  }
}

function directionMaterial(sharedSecret, salt, fromNodeId, toNodeId) {
  const info = Buffer.from(`aiefficiency-lan-sync/channel/v1/${fromNodeId}->${toNodeId}`, "utf8");
  const material = Buffer.from(hkdfSync(
    "sha256",
    sharedSecret,
    salt,
    info,
    KEY_BYTES + NONCE_PREFIX_BYTES,
  ));
  return {
    key: material.subarray(0, KEY_BYTES),
    noncePrefix: material.subarray(KEY_BYTES),
  };
}

function nonce(prefix, counter) {
  const value = Buffer.alloc(NONCE_PREFIX_BYTES + NONCE_COUNTER_BYTES);
  prefix.copy(value, 0);
  value.writeBigUInt64BE(BigInt(counter), NONCE_PREFIX_BYTES);
  return value;
}

function aad(message) {
  return Buffer.from(canonicalJson({
    version: Number(message.version),
    type: String(message.type || ""),
    fromNodeId: String(message.fromNodeId || ""),
    toNodeId: String(message.toNodeId || ""),
    counter: Number(message.counter),
  }), "utf8");
}

export function createLanSyncKeyAgreement() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
  };
}

export function deriveLanSyncChannel({
  localNodeId,
  remoteNodeId,
  localAgreement,
  remotePublicKey,
  remoteNonce,
} = {}) {
  const localId = String(localNodeId || "").trim();
  const remoteId = String(remoteNodeId || "").trim();
  if (!localId || !remoteId || localId === remoteId) fail("LAN 同步通道节点身份无效");
  if (!localAgreement?.privateKey || !localAgreement.publicKey || !localAgreement.nonce) {
    fail("LAN 同步本机临时密钥无效");
  }
  let remoteKey;
  try {
    remoteKey = createPublicKey({
      key: decode(remotePublicKey, "远端临时公钥"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("远端临时公钥格式无效");
  }
  if (remoteKey.asymmetricKeyType !== "x25519") fail("远端临时公钥算法无效");
  const remoteNonceBytes = decode(remoteNonce, "远端握手随机数");
  if (remoteNonceBytes.length !== 32) fail("远端握手随机数长度无效");

  const participants = [
    { nodeId: localId, publicKey: localAgreement.publicKey, nonce: localAgreement.nonce },
    { nodeId: remoteId, publicKey: String(remotePublicKey), nonce: String(remoteNonce) },
  ].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const transcript = canonicalJson({ version: CHANNEL_VERSION, participants });
  const salt = createHash("sha256").update(transcript, "utf8").digest();
  const sharedSecret = diffieHellman({ privateKey: localAgreement.privateKey, publicKey: remoteKey });
  const send = directionMaterial(sharedSecret, salt, localId, remoteId);
  const receive = directionMaterial(sharedSecret, salt, remoteId, localId);
  return {
    version: CHANNEL_VERSION,
    localNodeId: localId,
    remoteNodeId: remoteId,
    sendKey: send.key,
    receiveKey: receive.key,
    sendNoncePrefix: send.noncePrefix,
    receiveNoncePrefix: receive.noncePrefix,
    sendCounter: 0,
    receiveCounter: 0,
  };
}

export function encryptLanSyncMessage(channel, value) {
  if (!channel?.sendKey || !channel.sendNoncePrefix) fail("LAN 同步加密通道尚未建立");
  const counter = Number(channel.sendCounter) + 1;
  if (!Number.isSafeInteger(counter) || counter <= 0) fail("LAN 同步发送序号耗尽");
  const message = {
    version: CHANNEL_VERSION,
    type: "ENCRYPTED",
    fromNodeId: channel.localNodeId,
    toNodeId: channel.remoteNodeId,
    counter,
  };
  const cipher = createCipheriv("aes-256-gcm", channel.sendKey, nonce(channel.sendNoncePrefix, counter));
  cipher.setAAD(aad(message));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  channel.sendCounter = counter;
  return {
    ...message,
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptLanSyncMessage(channel, message) {
  if (!channel?.receiveKey || !channel.receiveNoncePrefix) fail("LAN 同步解密通道尚未建立");
  const counter = Number(message?.counter);
  if (Number(message?.version) !== CHANNEL_VERSION
    || message?.type !== "ENCRYPTED"
    || message?.fromNodeId !== channel.remoteNodeId
    || message?.toNodeId !== channel.localNodeId) {
    fail("LAN 同步密文目标或版本无效");
  }
  if (!Number.isSafeInteger(counter) || counter !== Number(channel.receiveCounter) + 1) {
    fail("LAN 同步密文顺序无效或检测到重放", "LAN_SYNC_CHANNEL_REPLAYED");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      channel.receiveKey,
      nonce(channel.receiveNoncePrefix, counter),
    );
    decipher.setAAD(aad(message));
    decipher.setAuthTag(decode(message.tag, "认证标签"));
    const plaintext = Buffer.concat([
      decipher.update(decode(message.ciphertext, "密文")),
      decipher.final(),
    ]);
    const value = JSON.parse(plaintext.toString("utf8"));
    channel.receiveCounter = counter;
    return value;
  } catch (error) {
    if (error?.code === "LAN_SYNC_CHANNEL_REPLAYED") throw error;
    fail("LAN 同步密文校验失败", "LAN_SYNC_CHANNEL_AUTH_FAILED");
  }
}

export function lanSyncChannelVersion() {
  return CHANNEL_VERSION;
}
