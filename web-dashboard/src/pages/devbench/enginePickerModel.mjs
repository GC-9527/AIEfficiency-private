const ENGINE_GROUPS = Object.freeze([
  Object.freeze({ id: "claude-code", name: "Claude Code" }),
  Object.freeze({ id: "codex-cli", name: "Codex CLI" }),
  Object.freeze({ id: "gemini-cli", name: "Gemini CLI" }),
  Object.freeze({ id: "hermes", name: "Hermes" }),
  Object.freeze({ id: "api-direct", name: "API 直连" }),
  Object.freeze({ id: "other", name: "其他 CLI" }),
]);

export const BASE_DEVBENCH_ENGINES = Object.freeze([
  Object.freeze({ id: "claude", name: "Claude（官方）", short: "官", groupId: "claude-code", productName: "Anthropic 官方" }),
  Object.freeze({ id: "claude-volcengine", name: "Claude（火山方舟）", short: "舟", groupId: "claude-code", productName: "火山方舟" }),
  Object.freeze({ id: "claude-minimax", name: "Claude（MiniMax）", short: "CM", groupId: "claude-code", productName: "MiniMax" }),
  Object.freeze({ id: "claude-atlas", name: "Claude Code（Atlas Coding Plan）", short: "AC", groupId: "claude-code", productName: "Atlas Coding Plan" }),
  Object.freeze({ id: "codex", name: "Codex（OpenAI 官方）", short: "Cx", groupId: "codex-cli", productName: "OpenAI 官方" }),
  Object.freeze({ id: "codex-minimax", name: "Codex（MiniMax）", short: "Mx", groupId: "codex-cli", productName: "MiniMax" }),
  Object.freeze({ id: "codex-atlas", name: "Codex CLI（Atlas Coding Plan）", short: "AX", groupId: "codex-cli", productName: "Atlas Coding Plan" }),
  Object.freeze({ id: "gemini", name: "Gemini（Google）", short: "Gm", groupId: "gemini-cli", productName: "Google 官方" }),
  Object.freeze({ id: "hermes", name: "Hermes Agent（本地）", short: "Hm", groupId: "hermes", productName: "本地配置" }),
  Object.freeze({ id: "hermes-atlas", name: "Hermes（Atlas Coding Plan）", short: "AH", groupId: "hermes", productName: "Atlas Coding Plan" }),
]);

const GROUP_BY_ID = new Map(ENGINE_GROUPS.map((group) => [group.id, group]));
const ENGINE_BY_ID = new Map(BASE_DEVBENCH_ENGINES.map((engine) => [engine.id, engine]));

export function engineGroupId(engineOrOption) {
  const option = typeof engineOrOption === "object" && engineOrOption
    ? engineOrOption
    : ENGINE_BY_ID.get(String(engineOrOption || ""));
  if (option?.groupId && GROUP_BY_ID.has(option.groupId)) return option.groupId;
  if (option?.api) return "api-direct";
  return "other";
}

export function compactEngineProductName(engineOrOption, fallbackName = "") {
  const option = typeof engineOrOption === "object" && engineOrOption
    ? engineOrOption
    : ENGINE_BY_ID.get(String(engineOrOption || ""));
  const definition = ENGINE_BY_ID.get(String(option?.id || engineOrOption || ""));
  const source = String(
    option?.productName
      || definition?.productName
      || fallbackName
      || option?.name
      || definition?.name
      || option?.id
      || "AI",
  ).trim();
  const identity = `${option?.id || engineOrOption || ""} ${source}`.toLowerCase();

  if (identity.includes("atlas")) return "Atlas";
  if (identity.includes("minimax")) return "MiniMax";
  if (identity.includes("anthropic")) return "Claude";
  if (identity.includes("openai")) return "Codex";
  if (identity.includes("火山方舟") || identity.includes("volcengine")) return "方舟";
  if (identity.includes("google")) return "Gemini";
  if (String(option?.id || "").startsWith("hermes") && source === "本地配置") return "Hermes";

  return source.replace(/\s+Coding\s+Plan$/i, "").replace(/\s+官方$/, "").trim() || "AI";
}

export function buildEnginePickerGroups(engineOptions = [], currentEngine = "") {
  const grouped = new Map();
  (Array.isArray(engineOptions) ? engineOptions : []).forEach((option) => {
    if (!option?.id) return;
    const definition = ENGINE_BY_ID.get(option.id);
    const groupId = engineGroupId(option);
    const groupDefinition = GROUP_BY_ID.get(groupId) || GROUP_BY_ID.get("other");
    if (!grouped.has(groupId)) {
      grouped.set(groupId, {
        ...groupDefinition,
        selected: false,
        selectedProductName: "",
        options: [],
      });
    }
    const productName = String(option.productName || definition?.productName || option.name || option.id);
    const normalized = { ...option, groupId, productName };
    const group = grouped.get(groupId);
    group.options.push(normalized);
    if (option.id === currentEngine) {
      group.selected = true;
      group.selectedProductName = productName;
    }
  });

  return ENGINE_GROUPS
    .map((definition) => grouped.get(definition.id))
    .filter((group) => group && group.options.length > 0);
}
