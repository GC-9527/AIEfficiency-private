import {
  GIT_CONTROLLER_FIXED_CLIENT_CONFIG_PATH,
  createGitControllerProcessRuntime,
} from "./git-controller-client.js";

function parseArguments(values) {
  const [command, ...rest] = values;
  if (command !== "standalone-hooks-uninstall") {
    throw Object.assign(
      new Error("Unsupported Git Controller helper command"),
      { code: "GIT_CONTROLLER_COMMAND_NOT_ALLOWED" },
    );
  }
  const allowed = new Set([
    "--repository-id",
    "--installation-id",
    "--manifest-sha256",
    "--idempotency-key",
  ]);
  const parsed = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(flag) || value == null) {
      throw Object.assign(
        new Error("Invalid structured Git Controller helper arguments"),
        { code: "GIT_CONTROLLER_HELPER_ARGUMENT_INVALID" },
      );
    }
    if (parsed[flag] !== undefined) {
      throw Object.assign(
        new Error("Duplicate Git Controller helper argument"),
        { code: "GIT_CONTROLLER_HELPER_ARGUMENT_INVALID" },
      );
    }
    parsed[flag] = value;
  }
  if ([...allowed].some((flag) => !parsed[flag])) {
    throw Object.assign(
      new Error("Missing Git Controller helper argument"),
      { code: "GIT_CONTROLLER_HELPER_ARGUMENT_REQUIRED" },
    );
  }
  return {
    repositoryId: parsed["--repository-id"],
    installationId: parsed["--installation-id"],
    manifestSha256: parsed["--manifest-sha256"],
    idempotencyKey: parsed["--idempotency-key"],
  };
}

try {
  const request = parseArguments(process.argv.slice(2));
  const runtime = await createGitControllerProcessRuntime({
    configPath: GIT_CONTROLLER_FIXED_CLIENT_CONFIG_PATH,
  });
  const result = await runtime.hooks.standaloneUninstall(request);
  process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: String(error?.code || "GIT_CONTROLLER_HELPER_FAILED"),
      message: String(error?.message || "Git Controller helper failed").slice(0, 500),
    },
  })}\n`);
  process.exitCode = 1;
}

export const __test = Object.freeze({ parseArguments });
