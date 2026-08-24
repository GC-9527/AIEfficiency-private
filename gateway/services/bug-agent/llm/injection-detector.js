/**
 * Prompt 注入预检（方案 §5.2）
 *
 * 扫描用户输入，识别常见注入特征。命中不阻断流程，
 * 仅设置 `cases.suspicious_prompt_injection = 1`，前端标 ⚠️。
 */

const PATTERNS = [
  { id: "ignore-en", re: /ignore\s+(?:the\s+)?(?:previous|above|all|prior)\s+instructions?/i },
  { id: "ignore-zh", re: /忽略(?:以上|之前|前面|前述|所有).{0,10}?(?:指令|命令|规则|prompt|提示|要求|内容|输出)/i },
  { id: "roleplay-en", re: /\byou\s+are\s+(?:a|an)\s+[\w-]{2,40}\s+(?:assistant|AI|model|bot)/i },
  { id: "roleplay-zh", re: /你(?:现在)?是(?:一个|一位)?[一-鿿\w]{2,20}(?:助手|模型|机器人|AI)/ },
  { id: "system-tag", re: /\[SYSTEM\]|\[INSTRUCTION\]|\<\|system\|\>/i },
  { id: "tag-breakout", re: /<\/user_content>|<\/evidence>|<\/tb_body>|<\/tb_title>/i },
  { id: "override", re: /system\s+override|override\s+(?:the\s+)?(?:system|instructions?)/i },
  { id: "reveal", re: /(?:reveal|show|print)\s+(?:the\s+)?(?:system\s+)?prompt|输出之前的(?:指令|prompt)/i },
];

/**
 * @param {string} text - 用户输入的完整原文
 * @returns {{ suspicious: boolean, matched: string[] }}
 */
export function detectPromptInjection(text) {
  if (!text || typeof text !== "string") return { suspicious: false, matched: [] };
  const matched = [];
  for (const p of PATTERNS) {
    if (p.re.test(text)) matched.push(p.id);
  }
  return { suspicious: matched.length > 0, matched };
}

/**
 * 对即将进入 Prompt 的文本做保护性转义：
 * 防止用户在输入里闭合我们的 XML 包装标签（最后一道防线）。
 */
export function escapeForXmlWrap(text) {
  if (!text) return "";
  return String(text)
    .replace(/<(\/)?\s*(user_content|tb_title|tb_body|evidence|system)\b/gi,
             (_m, slash, tag) => `&lt;${slash || ""}${tag}`);
}
