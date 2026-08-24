import net from "node:net";

function headerText(value) {
  if (Array.isArray(value)) return value.length === 1 ? String(value[0] || "").trim() : "";
  return String(value || "").trim();
}

function normalizedAddress(address) {
  let value = String(address || "").trim().toLowerCase().split("%")[0];
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return value;
}

export function isPerformanceResourceLoopbackAddress(address) {
  const value = normalizedAddress(address);
  if (value === "::1") return true;
  if (net.isIP(value) !== 4) return false;
  return Number(value.split(".")[0]) === 127;
}

export function performanceResourceClientAddress(req) {
  const socketAddress = headerText(req?.socket?.remoteAddress);
  // Only a loopback proxy may contribute forwarding metadata. Vite/http-proxy
  // appends the actual browser peer, therefore the final hop is authoritative.
  if (!isPerformanceResourceLoopbackAddress(socketAddress)) return socketAddress;
  const forwarded = headerText(req?.headers?.["x-forwarded-for"])
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.at(-1) || socketAddress;
}

function hostnameFromAuthority(value) {
  const authority = headerText(value);
  if (!authority || /[\s,]/.test(authority)) return "";
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function isAllowedPerformanceResourceHost(value) {
  const hostname = hostnameFromAuthority(value);
  return hostname === "localhost" || isPerformanceResourceLoopbackAddress(hostname);
}

export function isAllowedPerformanceResourceOrigin(
  value,
  { allowElectronOpaqueOrigin = process.env.ELECTRON === "1" } = {},
) {
  const origin = headerText(value);
  if (!origin) return true; // curl/CLI and same-process non-browser callers
  if (origin === "null") return allowElectronOpaqueOrigin;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "localhost" || isPerformanceResourceLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

export function isTrustedPerformanceResourceRequest(req) {
  return isPerformanceResourceLoopbackAddress(performanceResourceClientAddress(req))
    && isAllowedPerformanceResourceHost(req?.headers?.host)
    && isAllowedPerformanceResourceOrigin(req?.headers?.origin);
}

export function isPerformanceResourceLocalOnlyPath(value) {
  const rawPathname = String(value || "").split("?", 1)[0];
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, "") : rawPathname;
  return pathname === "/api/performance/resource-config"
    || pathname === "/api/performance/resource-run"
    || pathname.startsWith("/api/performance/resource-run/")
    || pathname === "/api/performance/resource-runs"
    || pathname.startsWith("/api/performance/resource-runs/");
}
