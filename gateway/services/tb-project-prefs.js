import os from "os";
import { createHash } from "crypto";
import { getConfig } from "./config.js";
import { getUserDataRecord, setUserData } from "../db/sqlite.js";

const KIND = "tb-projects";

function normalizeProject(p) {
  const id = String(p?.id || "").trim();
  const name = String(p?.name || id).trim();
  return id ? { id, name: name || id } : null;
}

export function normalizeProjectList(projects) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(projects) ? projects : []) {
    const next = normalizeProject(p);
    if (!next || seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next);
  }
  return out;
}

function localDeviceKey() {
  const cfg = getConfig();
  const seed = `${os.hostname() || "machine"}|${cfg.servers?.nodeId || ""}`;
  return `device:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export function tbProjectUserKey(principal = null) {
  const subjectIssuer = String(principal?.subject?.issuer || "").trim().toLowerCase();
  const subjectId = String(principal?.subject?.id || "").trim();
  if (subjectIssuer === "teambition" && subjectId) return `tb:${subjectId}`;

  const loginId = String(principal?.dingUserid || "").trim();
  if (loginId) return `account:${loginId}`;

  const cfg = getConfig();
  const tbId = String(cfg.teambition?.operatorId || "").trim();
  if (tbId) return `tb:${tbId}`;

  const dingId = String(cfg.adminAuth?.dingUserid || "").trim();
  if (dingId) return `ding:${dingId}`;

  return localDeviceKey();
}

function legacyConfiguredProjects() {
  return normalizeProjectList(getConfig().teambition?.projects || []);
}

export function getUserTbProjectSelection(principal = null) {
  const userKey = tbProjectUserKey(principal);
  const rec = getUserDataRecord(userKey, KIND);
  if (rec && Array.isArray(rec.data)) {
    return { userKey, source: "account", projects: normalizeProjectList(rec.data) };
  }
  const legacy = legacyConfiguredProjects();
  return { userKey, source: legacy.length ? "legacy-config" : "unset", projects: legacy };
}

export function setUserTbProjectSelection(principal = null, projects = []) {
  const userKey = tbProjectUserKey(principal);
  const list = normalizeProjectList(projects);
  const node = String(getConfig().servers?.nodeId || "");
  setUserData(userKey, KIND, list, node);
  return { userKey, source: "account", projects: list };
}
