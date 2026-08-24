import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { ToolkitError, redactErrorMessage, redactSecrets } from "../../tb-domain/src/index.js";

const DEFAULT_WEB_BASE = "https://www.teambition.com";

function privateAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  if (!value || value === "::" || value === "::1" || /^(?:fc|fd|fe[89ab]|ff)/.test(value)) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || (isIP(value) === 4 ? value : "");
  if (!ipv4) return false;
  const octets = ipv4.split(".").map(Number);
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
}

function trustedCookieHost(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return value === "teambition.com" || value.endsWith(".teambition.com");
}

async function validateUrl(value, { allowPrivateHostsForTests = false, dnsLookup = lookup } = {}) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw new ToolkitError("ATTACHMENT_URL_INVALID", "附件下载地址无效"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ToolkitError("ATTACHMENT_URL_INVALID", "附件下载地址无效");
  }
  if (parsed.protocol !== "https:" && !allowPrivateHostsForTests) throw new ToolkitError("ATTACHMENT_URL_INVALID", "附件下载只允许 HTTPS");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ToolkitError("ATTACHMENT_SSRF_BLOCKED", "附件下载地址禁止访问本机或私有网络");
  }
  const rows = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await dnsLookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(rows) || !rows.length) throw new ToolkitError("ATTACHMENT_DNS_FAILED", "附件下载域名解析失败");
  const normalized = rows.map((row) => ({ address: String(row.address), family: Number(row.family || isIP(row.address)) }));
  if (!allowPrivateHostsForTests && normalized.some((row) => privateAddress(row.address))) {
    throw new ToolkitError("ATTACHMENT_SSRF_BLOCKED", "附件下载地址禁止访问本机或私有网络");
  }
  return { url: parsed, ...normalized[0] };
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    let settings = options;
    let done = callback;
    if (typeof settings === "function") { done = settings; settings = {}; }
    if (settings?.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

function requestOnce(validated, { cookie, signal }) {
  const parsed = validated.url;
  const headers = { Host: parsed.host };
  if (cookie && trustedCookieHost(parsed.hostname)) headers.Cookie = cookie;
  const options = {
    protocol: parsed.protocol,
    hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
    port: parsed.port || undefined,
    method: "GET",
    path: `${parsed.pathname}${parsed.search}`,
    headers,
    lookup: pinnedLookup(validated.address, validated.family),
    signal,
    ...(parsed.protocol === "https:" && !isIP(parsed.hostname) ? { servername: parsed.hostname } : {}),
  };
  const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(options, resolve);
    req.once("error", reject);
    req.end();
  });
}

export function createSafeAttachmentReader({
  cookie = "",
  maxBytes = 100 * 1024 * 1024,
  timeoutMs = 30_000,
  allowPrivateHostsForTests = false,
  dnsLookup = lookup,
} = {}) {
  return async function readAttachment(source = {}) {
    const limit = Math.max(1, Number(source.maxBytes || maxBytes));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs)));
    try {
      let current = await validateUrl(source.url, { allowPrivateHostsForTests, dnsLookup });
      for (let redirect = 0; redirect <= 3; redirect += 1) {
        const response = await requestOnce(current, { cookie, signal: controller.signal });
        const status = Number(response.statusCode || 0);
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          current = await validateUrl(new URL(response.headers.location, current.url).toString(), { allowPrivateHostsForTests, dnsLookup });
          continue;
        }
        if (status === 401 || status === 403) {
          response.resume();
          throw new ToolkitError("ATTACHMENT_URL_EXPIRED", `附件下载授权失效（HTTP ${status}）`);
        }
        if (status < 200 || status >= 300) {
          response.resume();
          throw new ToolkitError("ATTACHMENT_DOWNLOAD_FAILED", `附件下载失败（HTTP ${status}）`);
        }
        const declared = Number(response.headers["content-length"] || 0);
        if (declared > limit) {
          response.destroy();
          throw new ToolkitError("ATTACHMENT_TOO_LARGE", "附件超过单文件上限");
        }
        async function* boundedBody() {
          let count = 0;
          for await (const chunk of response) {
            count += chunk.length;
            if (count > limit) {
              response.destroy();
              throw new ToolkitError("ATTACHMENT_TOO_LARGE", "附件超过单文件上限");
            }
            yield chunk;
          }
        }
        return { body: boundedBody(), size: declared || Number(source.size || 0), contentType: String(response.headers["content-type"] || source.mimeType || "") };
      }
      throw new ToolkitError("ATTACHMENT_REDIRECT_LIMIT", "附件下载重定向过多");
    } catch (error) {
      if (controller.signal.aborted) throw new ToolkitError("ATTACHMENT_TIMEOUT", "附件下载超时");
      throw error instanceof ToolkitError ? error : new ToolkitError("ATTACHMENT_DOWNLOAD_FAILED", redactErrorMessage(error));
    } finally {
      clearTimeout(timer);
    }
  };
}

function activityContent(activity) {
  let content = activity?.content;
  if (typeof content === "string") {
    try { content = JSON.parse(content); }
    catch { throw new ToolkitError("UPSTREAM_INVALID", "Teambition activity content is invalid JSON"); }
  }
  return content && typeof content === "object" ? content : {};
}

function attachmentId(value) {
  return String(value?.attachmentId || value?._id || value?.id || "").trim();
}

function attachmentUrl(value) {
  return String(value?.downloadUrl || value?.url || value?.signed || value?.signedUrl || "").trim();
}

function cookieFile(file, activity) {
  const base = String(file?.name || file?.fileName || "attachment");
  const ext = String(file?.ext || "").replace(/^\./, "");
  return {
    attachmentId: attachmentId(file), source: "comment", sourceRef: String(activity?._id || activity?.id || "") || null,
    originalName: ext && !base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${base}.${ext}` : base,
    size: Number(file?.size || file?.fileSize || 0), mimeType: String(file?.mimeType || ""),
    uploader: activity?.creator || file?.creator || null,
    createdAt: file?.createdAt || file?.created || activity?.createdAt || activity?.created || null,
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nodeText(node) {
  if (typeof node === "string") return node;
  if (!Array.isArray(node)) return "";
  return node.slice(2).map(nodeText).join("");
}

function parseRtfNote(tree, attachmentMap = {}) {
  const images = [];
  const links = [];
  let markdown = "";
  let html = "";
  const signOf = (source) => {
    if (!source) return "";
    let pathname = source;
    try { pathname = new URL(source).pathname; } catch {}
    return attachmentMap[pathname] || attachmentMap[decodeURIComponent(pathname)] || attachmentMap[encodeURI(pathname)] || "";
  };
  const walk = (node) => {
    if (typeof node === "string") { markdown += node; html += escapeHtml(node); return; }
    if (!Array.isArray(node)) return;
    const tag = node[0];
    const attrs = node[1] || {};
    if (tag === "img") {
      const name = attrs.name || `image_${images.length + 1}`;
      images.push({ attachmentId: `remark-${images.length + 1}`, name, src: attrs.src || "", signed: signOf(attrs.src), width: attrs.width, height: attrs.height });
      markdown += `\n![${name}](${attrs.src || ""})\n`;
      html += `<img src="${escapeHtml(attrs.src || "")}" alt="${escapeHtml(name)}" />`;
      return;
    }
    if (tag === "a") {
      const text = nodeText(node) || attrs.href || "";
      if (attrs.href) links.push(attrs.href);
      markdown += `[${text}](${attrs.href || ""})`;
      html += `<a href="${escapeHtml(attrs.href || "")}">${escapeHtml(text)}</a>`;
      return;
    }
    if (tag === "p") {
      html += "<p>";
      node.slice(2).forEach(walk);
      html += "</p>";
      markdown += "\n\n";
      return;
    }
    node.slice(2).forEach(walk);
  };
  walk(tree);
  return { markdown: markdown.replace(/\n{3,}/g, "\n\n").trim(), html, images, links: [...new Set(links)] };
}

function mergeAttachments(left, right) {
  const output = [];
  const positions = new Map();
  for (const item of [...(left || []), ...(right || [])].filter(Boolean)) {
    const id = attachmentId(item);
    if (!id) continue;
    if (!positions.has(id)) { positions.set(id, output.length); output.push(item); }
    else {
      const index = positions.get(id);
      output[index] = { ...output[index], ...Object.fromEntries(Object.entries(item).filter(([, value]) => value != null && value !== "")) };
    }
  }
  return output;
}

export function createSupplementedTeambitionProvider({
  official,
  cookie = "",
  fetchImpl = fetch,
  webBaseUrl = DEFAULT_WEB_BASE,
  attachmentReader = createSafeAttachmentReader({ cookie }),
} = {}) {
  if (!official || typeof official.readTicket !== "function") throw new ToolkitError("PROVIDER_CONFIG_INVALID", "official Teambition MCP gateway is required");
  const sources = new Map();
  const refsByAttachment = new Map();

  async function cookieJson(pathname) {
    if (!cookie) throw new ToolkitError("AUTH_REQUIRED", "TB_WEB_COOKIE is required for this official MCP gap");
    const response = await fetchImpl(new URL(pathname, webBaseUrl), { headers: { Cookie: cookie, Accept: "application/json" } });
    let data;
    try { data = await response.json(); } catch { throw new ToolkitError("UPSTREAM_INVALID", `Teambition Cookie API returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok) {
      const code = response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "FORBIDDEN" : "UPSTREAM_UNAVAILABLE";
      throw new ToolkitError(code, `Teambition Cookie API failed (HTTP ${response.status})`);
    }
    return data?.result ?? data;
  }

  async function cookieActivities(taskId) {
    const payload = await cookieJson(`/api/v2/tasks/${encodeURIComponent(taskId)}/activities`);
    const items = Array.isArray(payload) ? payload : (Array.isArray(payload?.result) ? payload.result : []);
    const total = Number(payload?.total);
    const complete = !Number.isFinite(total) || items.length >= total;
    return { items, complete, error: complete ? "" : `Cookie activities returned ${items.length}/${total}` };
  }

  async function readNote(taskId) {
    if (!cookie) return { ok: false, error: "TB_WEB_COOKIE is not configured; rich note coverage is unavailable" };
    try {
      let note = await cookieJson(`/api/tasks/${encodeURIComponent(taskId)}/note`);
      if (note?.url && (!note.attachments || Object.keys(note.attachments).length === 0)) {
        const refreshed = await cookieJson(`/api/tasks/${encodeURIComponent(taskId)}/note`);
        if (refreshed?.attachments && Object.keys(refreshed.attachments).length) note = refreshed;
      }
      if (note?.renderMode === "rtf" && note.url) {
        const response = await attachmentReader({ url: note.url, maxBytes: 10 * 1024 * 1024 });
        const chunks = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
        const parsed = parseRtfNote(JSON.parse(Buffer.concat(chunks).toString("utf8")), note.attachments || {});
        for (const image of parsed.images) if (image.signed) sources.set(image.attachmentId, { url: image.signed, taskRef: taskId, mimeType: "image/*" });
        return redactSecrets({ ok: true, renderMode: "rtf", ...parsed });
      }
      return { ok: true, renderMode: "markdown", markdown: String(note?.markdown || note?.text || ""), html: String(note?.html || ""), images: [], links: [] };
    } catch (error) {
      return { ok: false, error: redactErrorMessage(error) };
    }
  }

  async function readTicket(taskRef) {
    const snapshot = await official.readTicket(taskRef);
    let comments = snapshot.comments;
    let attachments = snapshot.attachments;
    if ((!comments.complete || !attachments.complete) && cookie) {
      try {
        const activities = await cookieActivities(snapshot.resolved.taskId);
        const commentItems = activities.items.filter((activity) => {
          const action = String(activity?.action || activity?.actionType || activity?.type || "").toLowerCase();
          return action.includes("comment") || activityContent(activity)?.comment != null;
        });
        const cookieFiles = [];
        for (const activity of commentItems) {
          for (const file of activityContent(activity).files || []) {
            const normalized = cookieFile(file, activity);
            cookieFiles.push(normalized);
            const url = attachmentUrl(file);
            if (url) sources.set(normalized.attachmentId, { url, size: normalized.size, mimeType: normalized.mimeType, taskRef });
          }
        }
        if (!comments.complete) comments = { available: true, complete: activities.complete, source: "official-mcp+cookie-gap-fallback", items: commentItems, error: activities.error };
        if (!attachments.complete) {
          const merged = mergeAttachments(attachments.items, cookieFiles);
          const missing = merged.filter((item) => !sources.has(attachmentId(item)) && !official.getAttachmentSource?.(attachmentId(item)));
          attachments = {
            available: true, complete: activities.complete && missing.length === 0,
            source: "official-mcp+cookie-gap-fallback", items: merged,
            error: missing.length ? `${missing.length} attachment download source(s) unavailable` : activities.error,
          };
        }
      } catch (error) {
        const message = redactErrorMessage(error);
        if (!comments.complete) comments = { ...comments, error: [comments.error, message].filter(Boolean).join("; ") };
        if (!attachments.complete) attachments = { ...attachments, error: [attachments.error, message].filter(Boolean).join("; ") };
      }
    }
    const note = await readNote(snapshot.resolved.taskId);
    const noteAttachments = (note.images || []).map((image) => ({
      attachmentId: image.attachmentId, source: "remark", originalName: image.name,
      size: null, mimeType: "image/*", createdAt: null,
    }));
    attachments = {
      ...attachments,
      items: mergeAttachments(attachments.items, noteAttachments),
      complete: attachments.complete && (note.ok || !cookie),
      error: attachments.complete && (note.ok || !cookie) ? "" : [attachments.error, note.ok || !cookie ? "" : note.error].filter(Boolean).join("; "),
    };
    for (const item of attachments.items || []) refsByAttachment.set(attachmentId(item), taskRef);
    return redactSecrets({ ...snapshot, comments, attachments, note });
  }

  async function openAttachment(id) {
    const attachmentIdValue = String(id || "");
    let source = sources.get(attachmentIdValue) || official.getAttachmentSource?.(attachmentIdValue);
    if (!source) throw new ToolkitError("ATTACHMENT_NOT_FOUND", "attachment source is unavailable; refresh ticket context");
    try {
      return await attachmentReader(source);
    } catch (error) {
      if (error?.code !== "ATTACHMENT_URL_EXPIRED") throw error;
      const taskRef = refsByAttachment.get(attachmentIdValue) || source.taskRef;
      if (!taskRef) throw error;
      await readTicket(taskRef);
      source = sources.get(attachmentIdValue) || official.getAttachmentSource?.(attachmentIdValue);
      if (!source) throw error;
      return attachmentReader(source);
    }
  }

  return Object.freeze({
    kind: "official-mcp-with-audited-gap-supplement",
    readTicket,
    openAttachment,
    getWorkflow: (taskRef) => official.getWorkflow(taskRef),
    async listComments(taskRef) {
      const snapshot = await readTicket(taskRef);
      if (snapshot.comments?.complete !== true) {
        throw new ToolkitError("CONTEXT_INCOMPLETE", snapshot.comments?.error || "comment readback is incomplete");
      }
      return snapshot.comments.items || [];
    },
    writeComment: (...args) => official.writeComment(...args),
    updateStatus: (...args) => official.updateStatus(...args),
  });
}
