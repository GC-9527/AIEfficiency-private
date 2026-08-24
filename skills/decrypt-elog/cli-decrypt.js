#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// ── 默认私钥路径 ──────────────────────────────────────────────
// 密钥随 skill 一起分发，位于 skill 目录下的 keys/ 子目录，保证跨设备可用
const DEFAULT_KEY_PATH = path.resolve(
  __dirname,
  "keys/rsa_private_pkcs8.pem"
);

// ── 编码检测 & 文件读取 ──────────────────────────────────────
function readFileWithEncoding(filePath) {
  const buffer = fs.readFileSync(filePath);
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString("utf8");
  }
  // UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }
  // UTF-16 BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString("utf16le");
  }
  // 默认 UTF-8
  return buffer.toString("utf8");
}

// ── 解析 ─────────────────────────────────────────────────────
function parseHeader(line) {
  const idx = line.indexOf("ELOG_HEADER|");
  if (idx === -1) return null;
  const parts = line.substring(idx).split("|");
  if (parts.length < 3) return null;
  return { sessionId: parts[1], encryptedKeyBase64: parts[2] };
}

function parsePacket(line) {
  const idx = line.indexOf("ELOG|");
  if (idx === -1) return null;
  const parts = line.substring(idx).split("|");
  if (parts.length < 6) return null;
  const index = Number(parts[3]);
  const total = Number(parts[4]);
  if (!Number.isFinite(index) || !Number.isFinite(total)) return null;
  return {
    sessionId: parts[1],
    packetId: parts[2],
    index,
    total,
    payload: parts[5],
  };
}

// ── RSA 解密 AES 密钥 ────────────────────────────────────────
function decryptAesKey(privateKeyPem, encryptedKeyBase64) {
  const encBuf = Buffer.from(encryptedKeyBase64, "base64");
  try {
    return crypto.privateDecrypt(
      { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      encBuf
    );
  } catch (_) {
    // 回退 PKCS1
    return crypto.privateDecrypt(privateKeyPem, encBuf);
  }
}

// ── AES-GCM 解密 + gzip 解压 ─────────────────────────────────
function decryptPayload(aesKey, mergedBase64) {
  const encrypted = Buffer.from(mergedBase64, "base64");
  if (encrypted.length < 28) throw new Error(`数据过短: ${encrypted.length} bytes`);
  const iv = encrypted.subarray(0, 12);
  const ciphertextWithTag = encrypted.subarray(12);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return zlib.gunzipSync(decrypted).toString("utf8");
}

// ── 主流程 ───────────────────────────────────────────────────
function decrypt(inputPath, privateKeyPem) {
  const text = readFileWithEncoding(inputPath);
  const lines = text.split(/\r?\n/);

  // 收集 headers 和 packets
  const headers = new Map(); // sessionId -> encryptedKeyBase64
  const packets = [];        // { sessionId, packetId, index, total, payload }
  const lineTypes = [];      // per-line: { type, sessionId?, packetId? }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = parseHeader(line);
    if (h) {
      headers.set(h.sessionId, h.encryptedKeyBase64);
      lineTypes.push({ type: "header", sessionId: h.sessionId });
      continue;
    }
    const p = parsePacket(line);
    if (p) {
      packets.push(p);
      lineTypes.push({ type: "packet", sessionId: p.sessionId, packetId: p.packetId, index: p.index });
      continue;
    }
    lineTypes.push({ type: "normal" });
  }

  if (headers.size === 0) {
    console.error("未找到 ELOG_HEADER 行");
    process.exit(1);
  }

  // 按 sessionId 解密 AES 密钥
  const aesKeys = new Map();
  for (const [sid, encKey] of headers) {
    try {
      aesKeys.set(sid, decryptAesKey(privateKeyPem, encKey));
    } catch (e) {
      console.error(`[错误] RSA 解密会话 ${sid} 失败: ${e.message}`);
    }
  }

  // 按 (sessionId, packetId) 分组
  const groups = new Map();
  for (const p of packets) {
    const key = `${p.sessionId}::${p.packetId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  // 解密每组
  const decrypted = new Map(); // packetId -> plaintext
  const losses = [];
  let successCount = 0;

  for (const [key, list] of groups) {
    const [sessionId] = key.split("::");
    const packetId = list[0].packetId;
    const aesKey = aesKeys.get(sessionId);
    if (!aesKey) {
      losses.push({ packetId, reason: "无对应的 AES 密钥" });
      continue;
    }

    const total = list[0].total;
    const maxIndex = Math.max(...list.map((p) => p.index));
    if (total !== maxIndex || list.length !== total) {
      losses.push({ packetId, reason: `分片缺失, 期望=${total}, 实际=${list.length}` });
      continue;
    }

    list.sort((a, b) => a.index - b.index);
    const mergedBase64 = list.map((p) => p.payload).join("");

    try {
      const plain = decryptPayload(aesKey, mergedBase64);
      decrypted.set(packetId, plain);
      successCount++;
    } catch (e) {
      losses.push({ packetId, reason: e.message });
    }
  }

  // 构建输出：替换加密行为明文
  const outputLines = [];
  const replacedPackets = new Set();

  for (let i = 0; i < lines.length; i++) {
    const info = lineTypes[i];
    if (info.type === "header") {
      // 保留 header 行（注释化）
      outputLines.push(lines[i]);
    } else if (info.type === "packet") {
      const pid = info.packetId;
      // 仅在该 packet 第一个分片处输出解密内容
      if (info.index === 1 && decrypted.has(pid) && !replacedPackets.has(pid)) {
        replacedPackets.add(pid);
        // 提取前缀（时间戳等）
        const elogIdx = lines[i].indexOf("ELOG|");
        const prefix = elogIdx > 0 ? lines[i].substring(0, elogIdx) : "";
        const plain = decrypted.get(pid);
        // 将每行明文加上前缀
        const plainLines = plain.split(/\r?\n/);
        for (const pl of plainLines) {
          if (pl.length > 0) {
            outputLines.push(prefix + pl);
          }
        }
      }
      // 其余分片行省略
    } else {
      outputLines.push(lines[i]);
    }
  }

  return { output: outputLines.join("\n"), successCount, lossCount: losses.length, losses, totalPackets: groups.size };
}

// ── CLI ──────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`用法: node cli-decrypt.js <input-file> [--key <privkey-path>] [--out <output-file>]

参数:
  <input-file>          包含 ELOG 加密日志的文件
  --key <privkey-path>  RSA 私钥路径 (默认: <skill-dir>/keys/rsa_private_pkcs8.pem)
  --out <output-file>   输出文件路径 (默认: <input-file>.decrypted.log)`);
    process.exit(0);
  }

  let inputFile = null;
  let keyPath = DEFAULT_KEY_PATH;
  let outPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && i + 1 < args.length) {
      keyPath = args[++i];
    } else if (args[i] === "--out" && i + 1 < args.length) {
      outPath = args[++i];
    } else if (!inputFile) {
      inputFile = args[i];
    }
  }

  if (!inputFile) {
    console.error("错误: 请指定输入文件");
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`错误: 文件不存在: ${inputFile}`);
    process.exit(1);
  }

  if (!fs.existsSync(keyPath)) {
    console.error(`错误: 私钥文件不存在: ${keyPath}`);
    process.exit(1);
  }

  const privateKeyPem = fs.readFileSync(keyPath, "utf8");
  if (!outPath) {
    const ext = path.extname(inputFile);
    outPath = inputFile.replace(ext, ".decrypted" + ext);
    if (outPath === inputFile) outPath = inputFile + ".decrypted.log";
  }

  console.log(`输入文件: ${inputFile}`);
  console.log(`私钥文件: ${keyPath}`);
  console.log(`输出文件: ${outPath}`);
  console.log("---");

  const result = decrypt(inputFile, privateKeyPem);

  fs.writeFileSync(outPath, result.output, "utf8");

  console.log("---");
  console.log(`解密完成:`);
  console.log(`  总数据包: ${result.totalPackets}`);
  console.log(`  成功解密: ${result.successCount}`);
  console.log(`  解密失败: ${result.lossCount}`);
  if (result.losses.length > 0) {
    console.log("  失败详情:");
    for (const l of result.losses) {
      console.log(`    - packetId=${l.packetId}: ${l.reason}`);
    }
  }
  console.log(`输出已写入: ${outPath}`);
}

main();
