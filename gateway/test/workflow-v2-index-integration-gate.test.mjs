import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Windows core.autocrlf 会让 checkout 工作树出现 CRLF（git 视为等价），
// 源码锚点匹配前归一化行尾，避免多行锚点在 CRLF 文件上误报缺失。
const source = fs.readFileSync(
  new URL("../services/devbench/index.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function section(from, to, within = source) {
  const start = within.indexOf(from);
  const end = within.indexOf(to, start + from.length);
  assert.ok(start >= 0, `missing source anchor: ${from}`);
  assert.ok(end > start, `missing source end anchor: ${to}`);
  return within.slice(start, end);
}

const dispatchBoundary = section(
  "async function sendTurnAtDispatchBoundary",
  "export async function sendTurnWithDeviceRuntime",
);
const sendTurn = section(
  "export function sendTurn(tab, content, opts = {})",
  "export async function kickGroupNextDevelopment",
);

test("REPAIR resume service is local-only and never calls a Provider", () => {
  const recoveryService = section(
    "export async function resumeWorkflowV2RepairSettlement",
    "function workflowV2DistributedProtocolUnsafe",
  );
  assert.match(recoveryService, /resumePendingStructuredRepairRecovery/);
  assert.match(recoveryService, /recordStructuredResult/);
  assert.match(recoveryService, /recordCompatibilityResult/);
  assert.match(recoveryService, /applyWorkflow:\s*applyWorkflowFn/);
  assert.doesNotMatch(recoveryService, /runTask|sendTurn|runRemoteAgent|Provider/i);
});

test("M3 dispatch boundary keeps flag/cohort misses legacy and selected preparation fail-closed", () => {
  const recoveryResume = dispatchBoundary.indexOf("await resumeWorkflowV2RepairSettlement(latest.id)");
  const providerSelection = dispatchBoundary.indexOf("const engine = turnEngineForDispatch(latest)");
  assert.ok(recoveryResume >= 0 && providerSelection > recoveryResume,
    "durable REPAIR recovery must run before any new Provider dispatch is selected");
  const recoveryOnly = dispatchBoundary.slice(recoveryResume, providerSelection);
  assert.match(recoveryOnly, /if \(recovery\?\.resumed\)[\s\S]*return \{[\s\S]*recoveryOnly:\s*true[\s\S]*retryRequired:\s*true/,
    "a recovery request must return before selecting or invoking a Provider");
  assert.match(
    dispatchBoundary,
    /if \(!stageId \|\| !configSnapshot\.workflowV2\?\.featureFlags\?\.promptV2\) \{[\s\S]*?const blocked = await prepareSourceWrite\(\);[\s\S]*?return blocked \|\| sendTurn\(latest, content, opts\);[\s\S]*?\}/,
  );
  assert.match(
    dispatchBoundary,
    /if \(!rollout\.selected\)[\s\S]*?const blocked = await prepareSourceWrite\(\);[\s\S]*?return blocked \|\| sendTurn\(latest, content, opts\);/,
  );

  const prepare = dispatchBoundary.indexOf('import(".\/workflow-v2\/compatibility-dispatch.js")');
  const gate = dispatchBoundary.indexOf('import(".\/workflow-v2\/compatibility-result-gate.js")');
  const legacyReturn = dispatchBoundary.indexOf("return blocked || sendTurn(latest, content, opts)");
  assert.ok(legacyReturn >= 0 && prepare > legacyReturn && gate > legacyReturn,
    "v2 runtime assets must remain lazy and must not be needed by the legacy path");
  assert.match(dispatchBoundary, /workflowV2Dispatch:\s*dispatch/);
  assert.match(dispatchBoundary, /workflowV2ResultRecorder:\s*compatibility\.recordWorkflowV2CompatibilityResult/);
  assert.match(dispatchBoundary, /workflowV2ResultGate:\s*compatibilityGate\.validateCompatibilityWorkflowResult/);
  assert.match(dispatchBoundary, /if \(!dispatch\)[\s\S]*WORKFLOW_V2_COMPATIBILITY_DISPATCH_MISSING/);

  const directDispatchGuard = section(
    "export function sendTurn(tab, content, opts = {})",
    "const repositoryPathResolution",
    sendTurn,
  );
  assert.match(directDispatchGuard, /dispatchRollout\.selected && !opts\.workflowV2Dispatch/);
  assert.match(directDispatchGuard, /WORKFLOW_V2_COMPATIBILITY_DISPATCH_MISSING/);

  const preDispatchValidation = section("if (opts.workflowV2Dispatch)", "// 旧故事点 docSlug", sendTurn);
  assert.match(preDispatchValidation, /typeof opts\.workflowV2DispatchValidator !== "function"/);
  assert.match(preDispatchValidation, /typeof opts\.workflowV2ResultGate !== "function"/);
  assert.match(preDispatchValidation, /typeof opts\.workflowV2ResultRecorder !== "function"/);
  assert.match(preDispatchValidation, /WORKFLOW_V2_COMPATIBILITY_SETTLEMENT_MISSING/);
  assert.match(preDispatchValidation, /opts\.workflowV2DispatchValidator\(\{/);
});

test("M3 selected turn atomically persists and actually dispatches the frozen prompt", () => {
  const promptSetup = section("const frozenTelemetryContext", "const storyStorage", sendTurn);
  const observation = promptSetup.indexOf("const frozenPromptObservation");
  const userMetadata = promptSetup.indexOf("const userMetadata");
  const append = promptSetup.indexOf("store.appendConversationNode");
  assert.ok(observation >= 0 && userMetadata > observation && append > userMetadata,
    "frozen prompt observation must exist before the initial user-node append");

  const atomicMetadata = section("const userMetadata", "conversationStart =", promptSetup);
  assert.match(atomicMetadata, /workflowV2PromptTurn \? \{/);
  assert.match(atomicMetadata, /aiPrompt:\s*opts\.workflowV2Dispatch\.prompt/);
  assert.match(atomicMetadata, /aiPromptTelemetry:\s*frozenPromptObservation/);
  assert.match(atomicMetadata, /aiPromptAttempts:\s*\[frozenPromptObservation\]/);

  assert.match(
    promptSetup,
    /const promptOverride = workflowV2PromptTurn\s*\? opts\.workflowV2Dispatch\.prompt\s*:\s*buildTurnPrompt\(/,
  );
  const legacyBuilder = section("const promptOverride", "const telemetryContext", promptSetup);
  assert.equal((legacyBuilder.match(/buildTurnPrompt\(/g) || []).length, 1);
  assert.match(
    legacyBuilder,
    /includeHistory:\s*workflowTurnRequiresFreshProviderSession\(workflowKind\) \? false : !resumeCliSessionId/,
  );
  assert.doesNotMatch(legacyBuilder.slice(0, legacyBuilder.indexOf(":")), /buildTurnPrompt|includeHistory/);

  assert.match(promptSetup, /if \(!workflowV2PromptTurn\)\s*\{[\s\S]*patchConversationNodeFields/);
  for (const field of ["contextId", "contextRevision", "contextHash", "checkpointRevision", "manifestRevision"]) {
    assert.match(promptSetup, new RegExp(`${field}:\\s*opts\\.workflowV2Dispatch\\.${field}`));
  }
});

test("M3 selected provider task forbids history/session/steering side channels", () => {
  const taskSetup = section("const resumeCliSessionId", "const onTurnSuccess", sendTurn);
  assert.match(taskSetup, /forceFreshProviderSession \|\| workflowV2PromptTurn\s*\? null/);
  assert.match(taskSetup, /streamingInput:\s*workflowV2PromptTurn \? false/);
  assert.match(taskSetup, /imagePaths:\s*turnImagePaths/);
  assert.match(taskSetup, /const turnImagePaths = workflowV2PromptTurn \? \[\]/);
  assert.match(taskSetup, /promptMode:\s*workflowV2PromptTurn \? opts\.workflowV2Dispatch\.promptMode : "legacy"/);
  assert.match(taskSetup, /promptSha256:\s*promptObservation\.sha256/);
  assert.match(taskSetup, /cliSessionId:\s*resumeCliSessionId/);

  const remoteSetup = section("let activeRemoteAgentSessionId", "if (aiWorktreeLeaseLost || deviceRuntimeLeaseLost)", sendTurn);
  assert.match(remoteSetup, /forceFreshProviderSession \|\| workflowV2PromptTurn[\s\S]*\? ""/);
  assert.match(remoteSetup, /remoteAgentSessionId:\s*forceFreshProviderSession \|\| workflowV2PromptTurn \? ""/);
  assert.match(remoteSetup, /remoteAgentLastEventId:\s*forceFreshProviderSession \|\| workflowV2PromptTurn \? 0/);
});

test("M3 stale-session retry reuses the byte-identical frozen prompt", () => {
  assert.match(
    sendTurn,
    /const frozenPromptRetryTurn = workflowV2PromptTurn \|\| promptOverlayTurn/,
  );
  const stale = section(
    "if (!userStopped && err && err.staleSession && !retriedStale)",
    "if (isWorkflowTab(tab)",
    sendTurn,
  );
  assert.match(
    stale,
    /const freshPrompt = frozenPromptRetryTurn\s*\? promptOverride\s*:\s*buildTurnPrompt\(/,
  );
  const retryChoice = section("const freshPrompt", "const retryReasons", stale);
  assert.equal((retryChoice.match(/buildTurnPrompt\(/g) || []).length, 1);
  assert.match(retryChoice, /includeHistory:\s*true/);
  assert.doesNotMatch(retryChoice.slice(0, retryChoice.indexOf(":")), /buildTurnPrompt|includeHistory/);
  assert.match(stale, /__testBuildPromptObservation\(freshPrompt, retryTelemetryContext\)/);
  assert.match(stale, /aiPromptAttempts:\s*\[promptObservation, retryPromptObservation\]/);
  assert.match(stale, /promptOverride:\s*freshPrompt/);
});

test("M3 compatibility completion uses only the explicit result gate", () => {
  const success = section("const onTurnSuccess", "const onTurnFailure", sendTurn);
  assert.match(success, /compatibilityPromptTurn[\s\S]*opts\.workflowV2ResultGate/);
  assert.match(success, /stageId:\s*opts\.workflowV2Dispatch\.stageId/);
  assert.match(success, /text:\s*reviewClean/);

  const naturalInference = success.indexOf("inferWorkflowMarkerFromNaturalConclusion");
  assert.ok(naturalInference >= 0, "legacy natural-language marker inference must remain available");
  const compatGate = success.indexOf("opts.workflowV2ResultGate");
  assert.ok(compatGate >= 0 && compatGate < naturalInference,
    "compatibility must choose its explicit gate before the legacy natural-language fallback");
  const aroundNatural = success.slice(Math.max(0, naturalInference - 300), naturalInference + 200);
  assert.match(aroundNatural, /!compatibilityPromptTurn|else/,
    "natural conclusion inference must be structurally limited to the legacy branch");
});

test("M3 compatibility settlement finishes recorder and workflow before clearing/draining", () => {
  const success = section("const onTurnSuccess", "const onTurnFailure", sendTurn);
  assert.match(success, /const onTurnSuccess = async \(result\)/);
  assert.match(success, /await opts\.workflowV2ResultRecorder\(/);
  assert.match(success, /await applyWorkflow\(/);

  const settlement = success.indexOf("await opts.workflowV2ResultRecorder(");
  const workflow = success.indexOf("await applyWorkflow(", settlement);
  const clearRunning = success.indexOf("runningTaskId: null", settlement);
  const drain = success.indexOf("drainQueue(tab.id)", settlement);
  assert.ok(settlement >= 0 && workflow > settlement,
    "immutable result recording must settle before compatibility workflow mutation");
  assert.ok(clearRunning > workflow && drain > clearRunning,
    "runningTaskId and queue must remain blocked until compatibility settlement succeeds");

  assert.match(success, /compatibilitySettlement(?:Succeeded|Ok)/);
  assert.match(success, /const released = releaseDeviceRuntimeLease\("turn_completed"\)[\s\S]{0,500}void released\.finally\(\(\) => drainQueue\(tab\.id\)\)/,
    "success drains normally; failed settlement performs one drain so unresolved-settlement preflight can mark the exact head blocked");
});

test("M3 compatibility settlement/provider failure deterministically settles the persistent queue", () => {
  const success = section("const onTurnSuccess", "const onTurnFailure", sendTurn);
  const catchAnchor = success.search(/catch \([^)]*\)\s*\{[\s\S]{0,500}compatibilitySettlement(?:Succeeded|Ok)\s*=\s*false/);
  assert.ok(catchAnchor >= 0, "compatibility settlement needs an explicit failure state");
  const failedSettlement = success.slice(catchAnchor, Math.min(success.length, catchAnchor + 1_200));
  assert.match(failedSettlement, /保留排队消息|queueRetained:\s*true/);

  const finalization = section("if (workflowV2PromptTurn) {\n        const settledTab", "} else {\n        // legacy timing", success);
  assert.match(finalization, /if \(settlement\.status !== "settled"\)[\s\S]*devbench_workflow_v2_blocked/);
  assert.match(finalization, /queueRetained:\s*\(\(store\.getTab\(tab\.id\) \|\| \{\}\)\.queue \|\| \[\]\)\.length > 0/);
  assert.match(finalization, /void released\.finally\(\(\) => drainQueue\(tab\.id\)\)/);

  const failure = section("const onTurnFailure", "let activeRemoteAgentSessionId", sendTurn);
  assert.match(
    failure,
    /const released = releaseDeviceRuntimeLease[\s\S]{0,180}void released\.finally\(\(\) => drainQueue\(tab\.id\)\)/,
    "compatibility execution failures must continue the finite FIFO instead of leaving pending work inert",
  );
});

test("M3 compatibility never persists provider resume cursors", () => {
  const success = section("const onTurnSuccess", "const onTurnFailure", sendTurn);
  const failure = section("const onTurnFailure", "let activeRemoteAgentSessionId", sendTurn);
  const remote = section("let activeRemoteAgentSessionId", "if (aiWorktreeLeaseLost || deviceRuntimeLeaseLost)", sendTurn);

  assert.match(success, /workflowV2PromptTurn[\s\S]{0,500}(?:clearAllAiSessionUpdates|cliSessionId:\s*null)/);
  assert.match(failure, /workflowV2PromptTurn[\s\S]{0,500}(?:clearAllAiSessionUpdates|cliSessionId:\s*null)/);
  assert.match(remote, /onSession:[\s\S]{0,500}!workflowV2PromptTurn/);
  assert.match(remote, /onEvent:[\s\S]{0,500}!workflowV2PromptTurn/);
});

test("M4 result flags select legacy, compatibility, and structured tracks with transport fail-closed", () => {
  const policy = section(
    "function workflowV2ResultDispatchPolicy",
    "function workflowV2ReportModeMismatch",
  );
  assert.match(policy, /structuredResultsV2 === true/);
  assert.match(policy, /if \(!structured\) return \{ resultMode: "compatibility", structuredStrategy: "" \}/);
  assert.match(policy, /\["center", "claude-proxy"\]\.includes\(normalizedEngine\)/);
  assert.match(policy, /WORKFLOW_V2_STRUCTURED_TRANSPORT_UNSUPPORTED/);
  assert.match(policy, /workflowV2ExecutionTransport\(config, engine, remoteTarget\)/);
  assert.match(policy, /assertWorkflowV2ReceiptTransport\(/);
  assert.match(policy, /resultMode: "structured"/);
  assert.match(policy, /structuredStrategy: apiTransport \? "finish_stage" : "json_text"/);

  assert.match(
    dispatchBoundary,
    /if \(!stageId \|\| !configSnapshot\.workflowV2\?\.featureFlags\?\.promptV2\) \{[\s\S]*?const blocked = await prepareSourceWrite\(\);[\s\S]*?return blocked \|\| sendTurn\(latest, content, opts\);[\s\S]*?\}/,
    "promptV2=false must stay on the legacy track after the shared source-write preflight",
  );
  assert.match(dispatchBoundary, /resultPolicy = workflowV2ResultDispatchPolicy\(configSnapshot, engine, stageId/);
  assert.match(dispatchBoundary, /resultMode:\s*resultPolicy\.resultMode/);
  assert.match(dispatchBoundary, /structuredStrategy:\s*resultPolicy\.structuredStrategy/);
  assert.match(
    dispatchBoundary,
    /const structuredGate = resultPolicy\.resultMode === "structured"[\s\S]*import\("\.\/workflow-v2\/structured-result-gate\.js"\)/,
  );
  assert.match(
    dispatchBoundary,
    /const structuredStore = resultPolicy\.resultMode === "structured"[\s\S]*import\("\.\/workflow-v2\/structured-result-store\.js"\)/,
  );
  assert.match(
    dispatchBoundary,
    /const repairCommitSettlement = resultPolicy\.resultMode === "structured"[\s\S]*import\("\.\/workflow-v2\/repair-commit-settlement\.js"\)/,
  );
  assert.match(dispatchBoundary, /workflowV2RepairCommitSettler:\s*repairCommitSettlement\?\.settleStructuredRepairCommit/);
  assert.match(dispatchBoundary, /workflowV2RepairRecoveryRunner:\s*repairCommitSettlement\?\.completeStructuredRepairRecovery/);

  const directDispatchGuard = section(
    "export function sendTurn(tab, content, opts = {})",
    "const repositoryPathResolution",
    sendTurn,
  );
  assert.match(
    directDispatchGuard,
    /liveResultPolicy = workflowV2ResultDispatchPolicy\(dispatchConfig, engine, compatibilityStage, \{[\s\S]*remoteTarget: shouldUseRemoteCenter\(tab, opts\)/,
  );
  const validation = section("if (opts.workflowV2Dispatch)", "// 旧故事点 docSlug", sendTurn);
  assert.match(validation, /resultMode:\s*liveResultPolicy\.resultMode/);
  assert.match(validation, /structuredStrategy:\s*liveResultPolicy\.structuredStrategy/);
  assert.match(validation, /promptMode === "structured"[\s\S]*workflowV2StructuredResultGate/);
  assert.match(validation, /promptMode === "structured"[\s\S]*workflowV2StructuredResultRecorder/);
  assert.match(validation, /stageId === "REPAIR"[\s\S]*workflowV2RepairRecoveryRunner/);
});

test("M4 structured JSON is gated and immutably settled before any user-visible projection", () => {
  const liveStream = section("const appendLiveStream =", "addCommLog(\"start\"", sendTurn);
  const rawTextGuard = liveStream.indexOf('if (structuredPromptTurn && deltaType === "text") return;');
  const liveTextWrite = liveStream.indexOf("liveDraft.text = appendTailText");
  assert.ok(rawTextGuard >= 0 && liveTextWrite > rawTextGuard,
    "structured JSON text must be discarded before live draft / websocket text mutation");

  const modeSetup = section("const compatibilityPromptTurn", "const resumeCliSessionId", sendTurn);
  assert.match(modeSetup, /const structuredPromptTurn = opts\.workflowV2Dispatch\?\.promptMode === "structured"/);
  assert.match(modeSetup, /const workflowV2PromptTurn = compatibilityPromptTurn \|\| structuredPromptTurn/);
  const taskSetup = section("const resumeCliSessionId", "const onTurnSuccess", sendTurn);
  assert.match(taskSetup, /\.\.\.\(structuredPromptTurn \? \{ structuredOutput: opts\.workflowV2Dispatch\.structuredOutput \} : \{\}\)/);
  assert.match(taskSetup, /const turnImagePaths = workflowV2PromptTurn \? \[\]/);
  assert.match(taskSetup, /streamingInput:\s*workflowV2PromptTurn \? false/);

  const success = section("const onTurnSuccess", "const onTurnFailure", sendTurn);
  const structuredGate = success.indexOf("await opts.workflowV2StructuredResultGate(");
  const immutableRecord = success.indexOf("await opts.workflowV2StructuredResultRecorder(", structuredGate);
  const recoveryRunner = success.indexOf("await opts.workflowV2RepairRecoveryRunner(", immutableRecord);
  const checkpointRecord = success.indexOf("await opts.workflowV2ResultRecorder(", recoveryRunner);
  const workflowTransition = success.indexOf("await applyWorkflow(", checkpointRecord);
  const conversationProjection = success.indexOf("appendAssistantConversationNode({", workflowTransition);
  const archiveProjection = success.indexOf("appendArchive(archiveFile", conversationProjection);
  const websocketProjection = success.indexOf("broadcastChatMessage({", archiveProjection);
  assert.ok(structuredGate >= 0, "structured result gate must execute");
  assert.ok(immutableRecord > structuredGate, "non-REPAIR structured results must enter the immutable result stream");
  assert.match(
    success.slice(structuredGate, immutableRecord + 120),
    /const durableRepairRecoveryRequired =[\s\S]*stageId === "REPAIR"[\s\S]*legacyEvent\?\.kind === "fix_done"[\s\S]*!durableRepairRecoveryRequired/,
    "committable REPAIR must defer stage-result until the durable outbox exists and Git is committed",
  );
  assert.ok(recoveryRunner > immutableRecord, "REPAIR must enter the durable outbox/Controller recovery runner");
  assert.ok(checkpointRecord > recoveryRunner, "non-REPAIR checkpoint settlement remains after the recovery branch");
  assert.ok(workflowTransition > checkpointRecord, "non-REPAIR workflow projection follows its immutable record");
  assert.ok(conversationProjection > workflowTransition, "conversation display must wait for full settlement");
  assert.ok(archiveProjection > conversationProjection, "archive must receive only the settled display projection");
  assert.ok(websocketProjection > archiveProjection, "websocket must receive only the settled display projection");

  const afterDisplayStarts = success.slice(conversationProjection);
  assert.match(afterDisplayStarts, /if \(compatibilityPromptTurn\)[\s\S]*await opts\.workflowV2ResultRecorder\(/,
    "the pre-existing compatibility-only settlement remains isolated from structured turns");
  assert.doesNotMatch(
    afterDisplayStarts,
    /if \((?:structuredPromptTurn|workflowV2PromptTurn)\)[\s\S]{0,1200}await opts\.workflowV2(?:Structured)?ResultRecorder\(/,
    "a structured turn must not run another immutable settlement after conversation exposure",
  );
  assert.equal((success.match(/await opts\.workflowV2StructuredResultRecorder\(/g) || []).length, 1);
  const recoveryCall = section("await opts.workflowV2RepairRecoveryRunner(", "structuredWorkflowResult = recovered.workflowResult", success);
  assert.match(recoveryCall, /recordStructuredResult:\s*opts\.workflowV2StructuredResultRecorder/);
  assert.match(recoveryCall, /recordCompatibilityResult:\s*opts\.workflowV2ResultRecorder/);
  assert.match(recoveryCall, /commitSettler:\s*opts\.workflowV2RepairCommitSettler/);
  assert.match(recoveryCall, /applyWorkflow/);
  assert.match(success, /const report = [\s\S]*structuredGate\?\.displayText/);
  assert.match(success, /const transcript = structuredPromptTurn \? \[\]/);

  const settledProjection = success.slice(success.indexOf("const report ="));
  assert.doesNotMatch(settledProjection, /rawProviderResult/,
    "raw Provider JSON must not reach conversation, archive, or websocket code");
  assert.match(settledProjection, /role: "assistant", content: report/);
  assert.match(settledProjection, /appendArchive\(archiveFile,[\s\S]{0,200}\$\{report\}/);
  assert.match(settledProjection, /broadcastChatMessage\(\{[\s\S]*content: report/);
});
