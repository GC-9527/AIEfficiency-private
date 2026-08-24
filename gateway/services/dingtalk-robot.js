import { createHmac } from "crypto";

function stripSignParams(webhook) {
  const raw = String(webhook || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.searchParams.delete("timestamp");
    url.searchParams.delete("sign");
    return url.toString();
  } catch {
    return raw
      .replace(/([?&])(?:timestamp|sign)=[^&]*&?/gi, "$1")
      .replace(/[?&]$/, "");
  }
}

export function buildDingtalkRobotSendUrl(webhook, secret, now = Date.now) {
  const base = stripSignParams(webhook);
  const dingSecret = String(secret || "").trim();
  if (!dingSecret) return base;
  const timestamp = Number(now());
  const sign = createHmac("sha256", dingSecret)
    .update(`${timestamp}\n${dingSecret}`)
    .digest("base64");
  return `${base}${base.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

export function explainDingtalkRobotError(message) {
  const msg = String(message || "").trim();
  if (!/(?:签名不匹配|sign|310000)/i.test(msg)) return msg;
  return [
    "钉钉机器人加签不匹配：请检查发布生产使用的机器人 webhook 与 dingtalkSecret 是否属于同一个机器人。",
    "这是钉钉机器人安全设置的加签，不是 APK/avatr8678 证书签名问题。",
    msg,
  ].filter(Boolean).join("\n");
}
