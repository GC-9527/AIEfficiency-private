import { createOfficialTeambitionGateway, connectOfficialTeambitionMcp } from "../../tb-official-mcp/src/index.js";
import { createSafeAttachmentReader, createSupplementedTeambitionProvider } from "../../tb-provider-teambition/src/index.js";
import { createToolkitApplication } from "./update-service.js";

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

export async function bootstrapToolkit({
  env = process.env,
  repoPath = env.TB_TOOLKIT_REPO || process.cwd(),
  profile = env.TB_TOOLKIT_PROFILE === "write" ? "write" : "read",
  session = null,
  basePath = "",
} = {}) {
  const ownSession = !session;
  const officialSession = session || await connectOfficialTeambitionMcp({
    env,
    profile,
    ...(basePath ? { basePath } : {}),
  });
  const cookie = String(env.TB_WEB_COOKIE || "");
  const attachmentReader = createSafeAttachmentReader({ cookie });
  const official = createOfficialTeambitionGateway(officialSession, {
    operatorId: env.TB_MCP_OPERATOR_ID,
    attachmentReader,
  });
  const provider = createSupplementedTeambitionProvider({ official, cookie, attachmentReader });
  const application = createToolkitApplication({
    provider,
    repoPath,
    profile,
    writeEnabled: enabled(env.TB_TOOLKIT_WRITE_ENABLED),
    allowedTaskRefs: String(env.TB_TOOLKIT_WRITE_ALLOWLIST || "").split(",").map((value) => value.trim()).filter(Boolean),
  });
  return {
    application,
    provider,
    official,
    session: officialSession,
    async close() { if (ownSession) await officialSession.close(); },
  };
}
