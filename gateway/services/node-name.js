import os from "os";

export function cleanNodeNamePart(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function formatNodeDisplayName(ownerName, nodeName, fallback = os.hostname()) {
  const owner = cleanNodeNamePart(ownerName);
  const name = cleanNodeNamePart(nodeName) || cleanNodeNamePart(fallback) || os.hostname();
  if (!owner) return name;
  return name.startsWith(`${owner}-`) ? name : `${owner}-${name}`;
}

export function configuredNodeDisplayName(config, fallback = os.hostname()) {
  const servers = config?.servers || {};
  return formatNodeDisplayName(servers.nodeOwnerName, servers.nodeName, fallback);
}
