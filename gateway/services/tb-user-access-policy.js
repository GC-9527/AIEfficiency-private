const PUBLIC_TB_USER_LOGIN_WRITES = new Set(["/login", "/login/cancel"]);

export function tbTasksWriteRequiresAdmin(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return false;
  return !PUBLIC_TB_USER_LOGIN_WRITES.has(String(pathname || ""));
}

