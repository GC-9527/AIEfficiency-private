import { Router } from "express";
import { getConfig } from "../services/config.js";

const router = Router();

function pickEngine(engineId) {
  const config = getConfig();
  const apiEngines = config.apiEngines || {};

  if (engineId && apiEngines[engineId]?.apiKey) {
    return { id: engineId, ...apiEngines[engineId] };
  }

  const preferred = ["qwen", "openai", "deepseek", "kimi"];
  for (const id of preferred) {
    if (apiEngines[id]?.apiKey) {
      return { id, ...apiEngines[id] };
    }
  }

  for (const [id, cfg] of Object.entries(apiEngines)) {
    if (cfg?.apiKey) {
      return { id, ...cfg };
    }
  }

  return null;
}

function extractTextContent(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        return "";
      })
      .join("");
  }
  return "";
}

router.post("/chat", async (req, res) => {
  const { messages, system, engine } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: "messages 不能为空" });
  }

  const target = pickEngine(engine);
  if (!target) {
    return res.status(500).json({ success: false, error: "未找到可用的 API engine" });
  }

  try {
    const upstreamMessages = [];
    if (system) {
      upstreamMessages.push({ role: "system", content: String(system) });
    }
    upstreamMessages.push(
      ...messages.map((msg) => ({
        role: msg.role || "user",
        content: extractTextContent(msg),
      }))
    );

    const response = await fetch(`${target.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model: target.model,
        messages: upstreamMessages,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return res.status(502).json({
        success: false,
        error: `upstream ${response.status}: ${errText.slice(0, 300)}`,
        engine: target.id,
      });
    }

    const result = await response.json();
    const text = result?.choices?.[0]?.message?.content || "";
    return res.json({
      success: true,
      data: {
        engine: target.id,
        model: target.model,
        text,
        raw: result,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      engine: target.id,
    });
  }
});

export default router;
