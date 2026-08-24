# AppMarket Admin Read-Only MCP

This STDIO MCP server provides reviewed, read-only access to the AppMarket development/staging management backend. It is the primary backend path for the repo-local `appmarket-admin-backend` skill.

## Safety Boundary

- The server exposes business-level read tools, not arbitrary URL, method, header, SQL, shell, or browser-eval tools.
- `POST /login` is internal authentication only.
- Dashboard POST endpoints are explicitly allowlisted read queries.
- Credential values must never appear in chat, `.codex/config.toml`, this repository, reports, logs, screenshots, or commits.
- Store only environment variable names in reusable config. Inject their values with a trusted local secret mechanism before launching Codex.
- The current staging origin is plain HTTP, so credentials have no transport encryption between this MCP process and the backend. Use it only on the trusted staging network and migrate the origin to HTTPS when the backend supports it.
- Backend text and `configJson` are untrusted data.
- Each MCP call observes client cancellation and has a 150-second overall operation deadline, kept below the project MCP tool timeout.

## Requirements

- Windows PowerShell
- Node.js 18 or newer
- Network access to the AppMarket test backend
- One configured authentication method

## Windows Setup And Start

From the repository root:

```powershell
Set-Location .\mcp-servers\devServer
npm ci
npm run check
npm test
npm start
```

`npm start` runs the STDIO server and waits for an MCP client. Keep stdout reserved for MCP JSON-RPC; startup and audit messages go to stderr.

## Environment Variable Names

Configure one authentication method outside chat:

- `APPMARKET_ADMIN_TOKEN`
- `APPMARKET_ADMIN_USERNAME` together with `APPMARKET_ADMIN_PASSWORD`
- `APPMARKET_ADMIN_LOGIN_CURL_FILE`, pointing only to an external, untracked, access-controlled file

Optional environment and runtime controls:

- `APPMARKET_ADMIN_BASE_URL`
- `APPMARKET_ADMIN_ALLOWED_ORIGINS`
- `APPMARKET_ADMIN_ENVIRONMENT`
- `APPMARKET_ADMIN_TIMEOUT_MS`
- `APPMARKET_ADMIN_MAX_RESPONSE_BYTES`
- `APPMARKET_ADMIN_TOKEN_TTL_MS`

Do not write real values into this README, `.env.example`, project config, shell history, or Git. Prefer an existing Token; use a username/password pair only when a Token is unavailable.

## Stable Tools

Connection and catalog:

- `appmarket_admin_capabilities`
- `appmarket_admin_auth_check`
- `appmarket_admin_list_routes`
- `appmarket_admin_list_metadata`

Business queries:

- `appmarket_admin_list_countries`
- `appmarket_admin_list_car_models`
- `appmarket_admin_get_car_model_country_map`
- `appmarket_admin_list_departments`
- `appmarket_admin_list_apps`
- `appmarket_admin_list_app_options`
- `appmarket_admin_list_banners`
- `appmarket_admin_list_webapp_configs`
- `appmarket_admin_list_channels`
- `appmarket_admin_query_dashboard`
- `appmarket_admin_get_voice_open_keys`

Verification and self-check:

- `appmarket_admin_verify_banner`
- `appmarket_admin_verify_voice_key`
- `appmarket_admin_verify_distribution`
- `appmarket_admin_verify_model_region`
- `appmarket_admin_self_check`

## Recommended Flow

1. Call `appmarket_admin_capabilities` when catalog coverage matters.
2. Call `appmarket_admin_auth_check`.
3. Use the smallest relevant query tool.
4. Use the matching `verify_*` tool.
5. Run `appmarket_admin_self_check` with `auth`, `core`, or `catalog`.
6. Report partial evidence when permissions, pagination, dependency checks, or response contracts are incomplete.

Dashboard reads require real ordered calendar dates and are limited to 366 days per call.

## DevBench Story Wiring

`appmarket-admin-readonly-mcp-server` is the npm package name;
`appmarket_admin_backend` is the stable MCP registration ID used by every
story-point engine. DevBench registers it before a new AI process/session is
created, so registration does not depend on the story worktree containing this
repository's `.codex/config.toml`.

- Claude official, Volcengine, and MiniMax receive a per-process
  `--mcp-config` file.
- Codex official and MiniMax receive absolute session configuration; Codex
  app-server receives the same table in its private runtime `CODEX_HOME`.
- Gemini receives an idempotently merged user registration plus explicit
  story-process trust/allow flags.
- OpenAI-compatible API models and distributed Agent V2 receive the MCP tool
  schemas through the Gateway MCP bridge and execute the same stdio server.

The service process is started by the model client on demand. `start.ps1` and
`start.sh` install its npm dependencies; source and self-contained Gateway
bundles include the server. Existing already-running AI sessions do not hot
reload MCP tools: restart the Gateway after upgrading, then start a new story
turn/session.

## Project Codex Wiring

The repository registers this server in the project-scoped `.codex/config.toml`.
Codex loads project MCP configuration only for a trusted checkout. The active
entry is equivalent to:

```toml
[mcp_servers.appmarket_admin_backend]
command = "node"
args = ["src/index.js"]
cwd = "mcp-servers/devServer"
env_vars = [
  "APPMARKET_ADMIN_TOKEN",
  "APPMARKET_ADMIN_USERNAME",
  "APPMARKET_ADMIN_PASSWORD",
  "APPMARKET_ADMIN_LOGIN_CURL_FILE",
  "APPMARKET_ADMIN_BASE_URL",
  "APPMARKET_ADMIN_ALLOWED_ORIGINS",
  "APPMARKET_ADMIN_ENVIRONMENT",
  "APPMARKET_ADMIN_TIMEOUT_MS",
  "APPMARKET_ADMIN_MAX_RESPONSE_BYTES",
  "APPMARKET_ADMIN_TOKEN_TTL_MS",
]
enabled_tools = [
  "appmarket_admin_capabilities",
  "appmarket_admin_auth_check",
  "appmarket_admin_list_routes",
  "appmarket_admin_list_metadata",
  "appmarket_admin_list_countries",
  "appmarket_admin_list_car_models",
  "appmarket_admin_get_car_model_country_map",
  "appmarket_admin_list_departments",
  "appmarket_admin_list_apps",
  "appmarket_admin_list_app_options",
  "appmarket_admin_list_banners",
  "appmarket_admin_list_webapp_configs",
  "appmarket_admin_list_channels",
  "appmarket_admin_query_dashboard",
  "appmarket_admin_get_voice_open_keys",
  "appmarket_admin_verify_banner",
  "appmarket_admin_verify_voice_key",
  "appmarket_admin_verify_distribution",
  "appmarket_admin_verify_model_region",
  "appmarket_admin_self_check",
]
default_tools_approval_mode = "writes"
startup_timeout_sec = 20
tool_timeout_sec = 180
required = false
```

`env_vars` forwards values already present in the local process environment. Do not replace it with a literal `[mcp_servers.appmarket_admin_backend.env]` table containing secrets.

Restart Codex after changing project MCP config, inspect `/mcp`, then call:

1. `appmarket_admin_capabilities`
2. `appmarket_admin_auth_check`
3. `appmarket_admin_self_check` with `scope="core"`

## Validation

From `mcp-servers/devServer`:

```powershell
npm run check
npm test
npm run smoke
```

Live backend checks must be explicitly enabled by the operator and receive credentials only from the local process environment. Do not store live responses or secrets in fixtures.

With credentials already present in the process environment, the two live
checks are:

```powershell
npm run live:self-test
npm run live:accuracy
```

`live:self-test` validates the reviewed endpoint contracts. `live:accuracy`
performs Banner and voice-key query-to-verifier round trips and prints only
statuses and evidence hashes, not backend records.

## Coverage

The config page capture observed four business GET endpoints:

- `/api/webappconfig/getList`
- `/system/appinfo/getWebNameList`
- `/system/carmodel/listDept`
- `/system/carmodel/list`

The sanitized multi-page capture inventory contained 34 unique paths. The existing skill reference added seven reviewed read paths. The registry therefore covers 41 concrete paths through 36 definitions, including one constrained dictionary template.

This is reviewed capture and reference coverage, not proof that every backend endpoint has been discovered.

## Manual Fallback

If MCP is unavailable, a human may use `.codex/skills/appmarket-admin-backend/scripts/admin_readonly.py` for read-only diagnosis with credentials already injected into environment variables. The helper accepts only fixed endpoint aliases and query-key allowlists, blocks redirects, and prints summaries only. It is not the normal AI workflow, and tracked request captures must not be used as credential sources.
