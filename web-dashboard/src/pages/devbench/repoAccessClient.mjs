export const DEFAULT_LOCAL_GATEWAY_URL = "http://127.0.0.1:3001";

export function isLoopbackGatewayUrl(url) {
  try {
    const hostname = new URL(String(url || "")).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export function needsDedicatedLocalGateway({ gatewayUrl = "", browserOrigin = "" } = {}) {
  return !isLoopbackGatewayUrl(gatewayUrl || browserOrigin);
}

function localGatewayUnavailable(localGatewayUrl) {
  return {
    ok: true,
    data: {
      hasAccess: null,
      needsLocalGateway: true,
      localGatewayUrl,
      error: "当前页面无法连接这台电脑的本机 Gateway，因而不能读取本机 Git 凭证。",
    },
  };
}

function isNetworkFailure(result) {
  return result?.ok === false && result?.code === "NETWORK_ERROR";
}

export async function requestRepoAccessFromLocalGateway({
  gatewayUrl = "",
  browserOrigin = "",
  localGatewayUrl = DEFAULT_LOCAL_GATEWAY_URL,
  probeLocalGateway,
  requestRepoAccess,
} = {}) {
  if (typeof requestRepoAccess !== "function") throw new TypeError("requestRepoAccess 必须是函数");
  const explicitLoopbackGateway = isLoopbackGatewayUrl(gatewayUrl) ? gatewayUrl : "";
  if (explicitLoopbackGateway) {
    const localReady = typeof probeLocalGateway === "function"
      ? await probeLocalGateway(explicitLoopbackGateway)
      : true;
    if (!localReady) return localGatewayUnavailable(explicitLoopbackGateway);
    const result = await requestRepoAccess();
    return isNetworkFailure(result)
      ? localGatewayUnavailable(explicitLoopbackGateway)
      : result;
  }

  if (!needsDedicatedLocalGateway({ gatewayUrl, browserOrigin })) {
    const result = await requestRepoAccess();
    return isNetworkFailure(result)
      ? localGatewayUnavailable(localGatewayUrl)
      : result;
  }

  const localReady = typeof probeLocalGateway === "function"
    ? await probeLocalGateway(localGatewayUrl)
    : false;
  if (!localReady) return localGatewayUnavailable(localGatewayUrl);

  const result = await requestRepoAccess(localGatewayUrl);
  if (isNetworkFailure(result)) return localGatewayUnavailable(localGatewayUrl);
  if (result?.ok && result.data) {
    result.data = {
      ...result.data,
      checkedBy: "local-gateway",
      localGatewayUrl,
    };
  }
  return result;
}
