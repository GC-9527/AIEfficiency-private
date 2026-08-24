# AIEfficiency Codex Rules

- Do not automatically stage or commit AI-generated temporary artifacts.
- Temporary artifacts include generated reports, documents, one-off scripts, logs, traces, screenshots, videos, images, archives, and runtime outputs.
- In this repository, keep AI temporary artifacts under `docs/tempFiles/` when possible.
- Do not commit `docs/PerformanceReports/`, `docs/devbench/script*/`, `docs/devbench/day*/performance/`, or `docs/devbench/day*/ask_*.txt` unless the user explicitly asks to commit those exact paths.
- Before every commit, run `git status --short` or inspect the staged list and remove unrelated temporary artifacts from the commit.

## Commit Hygiene And Split Commits

- Write the descriptive content of Git commit messages in Chinese, including the summary after the colon and the commit body. Conventional Commit type/scope prefixes such as `feat(scope):` and `fix(scope):` may remain in English. Use another language only when the user explicitly requests it.
- Treat the current index as untrusted before every commit. After running the git safety checks, unstage unrelated or pre-existing entries with `git restore --staged -- <path>` until `git diff --cached --name-status` contains only the intended commit.
- If a task touches unrelated concerns, create separate commits by feature/module. Prefer narrow scopes such as `devbench-backend`, `devbench-ui`, `feishu-sync`, `service-control`, `tests`, and `repo-rules`; do not combine them unless the user explicitly asks for one commit.
- Use exact pathspecs or `git add -p`/equivalent hunk staging. Never rely on a previously staged set as proof that a file belongs to the next commit.
- Before each commit, inspect `git diff --cached --stat` and `git diff --cached`; if any file cannot be explained by the commit message scope, unstage it and commit it separately or leave it uncommitted.
- Do not include repo-rules/config changes (`AGENTS.md`, `.gitignore`, `.codex/**`, `reasonix.toml`, local configs) with product code unless the commit's only purpose is repo/tooling configuration.

## Story Point Execution Reporting

- For every story point/devbench task, the AI must explicitly state the current problem it is solving before or at the start of real work.
- Final or status responses must include: files/logs/attachments/videos/images actually read, provided materials not read, actions performed, artifacts produced, code/config changes, behavior impact, residual risk, and suggested tests.
- Do not claim a material was read unless it was actually inspected. If a provided attachment/video/image/log was not read, name it and state the reason, such as unavailable, unsupported, too large, not downloaded, or not relevant.
- When referencing evidence in user-facing text, prefer file names or repo-relative paths and avoid leaking local absolute paths unless the user specifically needs a local handoff path.

## Defect Knowledge And Regression Gates

- Treat chat context and ignored acceptance artifacts as temporary evidence, not durable project memory. Durable defect knowledge belongs in `docs/engineering/regression-ledger.md` and in executable tests or build gates.
- Before reverting or rolling back code, identify the exact introducing change and list the behaviors that must remain. Prefer the narrowest file/hunk-level change; do not reset an entire file when only one feature must be removed.
- A bug fix is not complete until it has: a reproducible failure mode, an automated regression test, an appropriate preflight/build/runtime guard, a ledger entry, and an acceptance result with residual risks.
- For packaging defects, validate the final packaged artifact and its runtime behavior. Source-tree existence or a successful import that does not exercise lazy/native code is insufficient.
- When a defect class recurs, strengthen the shared guard instead of adding another one-off check. Keep the guard close to the build or runtime boundary that can prevent delivery of the bad artifact.

## Story Point Acceptance Protocol

- After a story point/devbench development or fix is complete, use `$story-acceptance-protocol` before final handoff unless the user explicitly says to skip acceptance.
- The acceptance flow must build the specified project/flavor release package, prepare the requested device or declared app-mock scope, run the relevant scenario checks, collect screenshots/recordings/logs/traces/DB evidence as applicable, and produce a concise acceptance report.
- The acceptance build and evidence source must target the same backend environment. If production DB evidence is unavailable but development DB evidence is available, build the dev-backed release variant and validate against the development DB; report the result as dev-environment acceptance, not production acceptance.
- The acceptance flow must launch a fresh sub-agent for independent verification. The sub-agent must receive only the handoff packet and raw artifacts/evidence, not the development Agent's private conclusions or prior chat context.
- Overall story acceptance cannot be marked `PASS` unless both self-acceptance and the fresh sub-agent's independent acceptance are `PASS`. If a sub-agent tool is unavailable, mark independent acceptance `BLOCKED` or the overall result `PARTIAL/BLOCKED` unless the user explicitly waives this gate.
- Use specialty skills when relevant, such as `$asgo-skill` for ASGO voice/media verification. Prepare required runtime setup, such as `adb forward tcp:22300 tcp:8088`, when the active specialty skill requires it.
- Store temporary acceptance evidence under `docs/tempFiles/story-acceptance/<story-id-or-date>/` when possible. Do not stage or commit those artifacts unless the user explicitly asks for those exact paths.
- Do not require the user to restate the acceptance protocol for each story point; infer missing non-risky details from the repo/task context and ask only for required details that cannot be discovered safely.

## Git Safety And Portable Paths

- Use the current repository root from `git rev-parse --show-toplevel`; do not encode machine-specific absolute paths into project rules, scripts, reports, or commit messages.
- Before `git pull`, `merge`, `rebase`, `commit`, `checkout`, `restore`, `reset`, or `stash`, run `git status -sb`, `git diff --stat`, `git diff --cached --stat`, and check hidden index flags with `git ls-files -v | findstr /R "^[Ssh]"` on Windows.
- If any file is marked `S` or `h`, stop and list it. Clear only when needed with `git update-index --no-skip-worktree -- <file>` or `git update-index --no-assume-unchanged -- <file>`, then inspect the real diff.
- Treat `start.ps1`, `stop.*`, `web-dashboard/vite.config.js`, `gateway/config.json`, and local runtime configuration as high-risk: verify they are intentional before staging.
- Do not use `git add .` for routine commits. Stage only the exact files for the task and verify `git diff --cached --stat` plus `git diff --cached`.
- Do not commit temporary docs, reports, generated scripts, logs, screenshots, videos, secrets, tokens, local account configuration, build outputs, caches, or unrelated line-ending churn.
