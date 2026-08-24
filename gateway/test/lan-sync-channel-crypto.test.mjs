import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLanSyncKeyAgreement,
  deriveLanSyncChannel,
  decryptLanSyncMessage,
  encryptLanSyncMessage,
} from "../services/lan-sync/channel-crypto.js";

test("LAN 同步使用临时 X25519 与 AES-256-GCM 建立双向保密通道", () => {
  const leftAgreement = createLanSyncKeyAgreement();
  const rightAgreement = createLanSyncKeyAgreement();
  const left = deriveLanSyncChannel({
    localNodeId: "lan-left",
    remoteNodeId: "lan-right",
    localAgreement: leftAgreement,
    remotePublicKey: rightAgreement.publicKey,
    remoteNonce: rightAgreement.nonce,
  });
  const right = deriveLanSyncChannel({
    localNodeId: "lan-right",
    remoteNodeId: "lan-left",
    localAgreement: rightAgreement,
    remotePublicKey: leftAgreement.publicKey,
    remoteNonce: leftAgreement.nonce,
  });

  const plaintext = {
    type: "CHANGE_SET",
    data: { branch: "release/geelyp162", tokenLikeValue: "must-not-appear-on-wire" },
  };
  const encrypted = encryptLanSyncMessage(left, plaintext);
  const wire = JSON.stringify(encrypted);
  assert.equal(wire.includes("release/geelyp162"), false);
  assert.equal(wire.includes("must-not-appear-on-wire"), false);
  assert.deepEqual(decryptLanSyncMessage(right, encrypted), plaintext);
});

test("LAN 同步密文防篡改、防重放且绑定目标节点", () => {
  const leftAgreement = createLanSyncKeyAgreement();
  const rightAgreement = createLanSyncKeyAgreement();
  const left = deriveLanSyncChannel({
    localNodeId: "lan-left",
    remoteNodeId: "lan-right",
    localAgreement: leftAgreement,
    remotePublicKey: rightAgreement.publicKey,
    remoteNonce: rightAgreement.nonce,
  });
  const right = deriveLanSyncChannel({
    localNodeId: "lan-right",
    remoteNodeId: "lan-left",
    localAgreement: rightAgreement,
    remotePublicKey: leftAgreement.publicKey,
    remoteNonce: leftAgreement.nonce,
  });
  const encrypted = encryptLanSyncMessage(left, { type: "ACK", data: { ok: true } });
  const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };
  assert.throws(() => decryptLanSyncMessage(right, tampered), /校验失败|invalid|authenticate/i);
  assert.deepEqual(decryptLanSyncMessage(right, encrypted), { type: "ACK", data: { ok: true } });
  assert.throws(() => decryptLanSyncMessage(right, encrypted), /重放|顺序/);
});
