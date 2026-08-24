import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const {
  DEFAULT_DEGRADED_CONFIRMATIONS,
  DEFAULT_MISSING_CONFIRMATIONS,
  RUNTIME_EVIDENCE,
  decideStartAction,
  evaluateForceReleaseCandidate,
  evaluateForceReleaseProfileState,
  evaluateRuntimeHealth,
  isAIEfficiencyGatewayFingerprint,
  isAIEfficiencyWebCommand,
  isRuntimeHealthObservationCurrent,
  nextRuntimeHealthGeneration,
  resolveSyncScope,
} = require("../../service-control-electron/runtime-health-policy.cjs");

test("force release can recover a configured stopped or failed profile with a live fallback snapshot", () => {
  for (const status of ["running", "stopped", "failed"]) {
    assert.deepEqual(evaluateForceReleaseProfileState({
      configured: true,
      status,
      hasFallback: true,
    }), {
      allowed: true,
      stopBeforeStart: status === "running",
      reason: "recoverable_fallback",
    });
  }

  assert.equal(evaluateForceReleaseProfileState({
    configured: false,
    status: "repo_missing",
    hasFallback: true,
  }).reason, "profile_not_configured");
  assert.equal(evaluateForceReleaseProfileState({
    configured: true,
    status: "stopping",
    hasFallback: true,
  }).reason, "profile_busy");
  assert.equal(evaluateForceReleaseProfileState({
    configured: true,
    status: "stopped",
    hasFallback: false,
  }).reason, "fallback_missing");
});

test("owned 服务的首次 HTTP 超时先快速复查，连续超时才展示降级", () => {
  const first = evaluateRuntimeHealth({
    gatewayHttpOk: false,
    webHttpOk: false,
    gatewayEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
    webEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
    missingStreak: 2,
  });

  assert.equal(first.kind, "degraded_pending");
  assert.equal(first.keepRunning, true);
  assert.equal(first.shouldStop, false);
  assert.equal(first.nextMissingStreak, 0);
  assert.equal(first.nextDegradedStreak, 1);

  const confirmed = evaluateRuntimeHealth({
    gatewayEvidence: RUNTIME_EVIDENCE.OWNED_PROCESS,
    webEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
    degradedStreak: first.nextDegradedStreak,
  });
  assert.equal(confirmed.kind, "degraded");
  assert.equal(confirmed.nextDegradedStreak, DEFAULT_DEGRADED_CONFIRMATIONS);
});

test("进程探测不确定时不累计缺失次数", () => {
  const result = evaluateRuntimeHealth({
    gatewayEvidence: RUNTIME_EVIDENCE.UNKNOWN,
    webEvidence: RUNTIME_EVIDENCE.MISSING,
    missingStreak: 1,
  });

  assert.equal(result.kind, "inconclusive");
  assert.equal(result.shouldStop, false);
  assert.equal(result.nextMissingStreak, 0);
});

test("UNKNOWN breaks the missing streak so only three consecutive definite misses stop", () => {
  let missingStreak = 0;
  for (const evidence of [
    RUNTIME_EVIDENCE.MISSING,
    RUNTIME_EVIDENCE.MISSING,
    RUNTIME_EVIDENCE.UNKNOWN,
    RUNTIME_EVIDENCE.FOREIGN,
    RUNTIME_EVIDENCE.MISSING,
  ]) {
    const result = evaluateRuntimeHealth({
      gatewayEvidence: evidence,
      webEvidence: evidence,
      missingStreak,
    });
    assert.equal(result.shouldStop, false);
    missingStreak = result.nextMissingStreak;
  }
  assert.equal(missingStreak, 2);

  const thirdConsecutiveMiss = evaluateRuntimeHealth({
    gatewayEvidence: RUNTIME_EVIDENCE.MISSING,
    webEvidence: RUNTIME_EVIDENCE.FOREIGN,
    missingStreak,
  });
  assert.equal(thirdConsecutiveMiss.shouldStop, true);
  assert.equal(thirdConsecutiveMiss.nextMissingStreak, DEFAULT_MISSING_CONFIRMATIONS);
});

test("an operation generation invalidates an in-flight async health observation", async () => {
  let currentGeneration = 0;
  let runtimeState = "running";
  let releaseProbe;
  const probe = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const observedGeneration = currentGeneration;
  const inFlightRefresh = (async () => {
    await probe;
    if (isRuntimeHealthObservationCurrent(observedGeneration, currentGeneration)) {
      runtimeState = "stopped";
    }
  })();

  currentGeneration = nextRuntimeHealthGeneration(currentGeneration);
  runtimeState = "stopping";
  releaseProbe();
  await inFlightRefresh;

  assert.equal(runtimeState, "stopping");
  assert.equal(isRuntimeHealthObservationCurrent(observedGeneration, currentGeneration), false);
});

test("只有明确缺失连续达到阈值才停止并清空运行态", () => {
  let missingStreak = 0;
  for (let attempt = 1; attempt <= DEFAULT_MISSING_CONFIRMATIONS; attempt += 1) {
    const result = evaluateRuntimeHealth({
      gatewayEvidence: RUNTIME_EVIDENCE.MISSING,
      webEvidence: RUNTIME_EVIDENCE.MISSING,
      missingStreak,
    });
    missingStreak = result.nextMissingStreak;
    assert.equal(result.shouldStop, attempt === DEFAULT_MISSING_CONFIRMATIONS);
    assert.equal(result.keepRunning, attempt < DEFAULT_MISSING_CONFIRMATIONS);
  }
});

test("恢复健康会清零此前的缺失计数", () => {
  const result = evaluateRuntimeHealth({
    gatewayHttpOk: true,
    webHttpOk: true,
    gatewayEvidence: RUNTIME_EVIDENCE.MISSING,
    webEvidence: RUNTIME_EVIDENCE.MISSING,
    missingStreak: 2,
  });

  assert.equal(result.kind, "healthy");
  assert.equal(result.nextMissingStreak, 0);
  assert.equal(result.nextDegradedStreak, 0);
});

test("任一必需服务明确缺失时优先累计缺失，不被另一 owned 服务掩盖", () => {
  const result = evaluateRuntimeHealth({
    gatewayEvidence: RUNTIME_EVIDENCE.MISSING,
    webEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
    missingStreak: 0,
  });

  assert.equal(result.kind, "missing_pending");
  assert.equal(result.shouldStop, false);
  assert.equal(result.nextMissingStreak, 1);
});

test("Start 仅在全部必需服务都有 owned 证据时采用降级服务", () => {
  assert.equal(decideStartAction({
    gatewayEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
    webEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
  }), "adopt_degraded");
  assert.equal(decideStartAction({
    gatewayEvidence: RUNTIME_EVIDENCE.MISSING,
    webEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
  }), "launch");
  assert.equal(decideStartAction({
    gatewayHttpOk: false,
    webHttpOk: true,
    gatewayEvidence: RUNTIME_EVIDENCE.MISSING,
    webEvidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
  }), "launch");
  assert.equal(decideStartAction({
    gatewayEvidence: RUNTIME_EVIDENCE.OWNED_PROCESS,
    webEvidence: RUNTIME_EVIDENCE.OWNED_PROCESS,
  }), "adopt_degraded");
  assert.equal(decideStartAction({
    gatewayEvidence: RUNTIME_EVIDENCE.UNKNOWN,
    webEvidence: RUNTIME_EVIDENCE.MISSING,
  }), "defer");
});

test("同步域优先使用 profile 或环境配置并以 profile id 作为稳定兜底", () => {
  assert.equal(resolveSyncScope({
    profileId: "development-2",
    profileValue: "configured-dev-two",
    profileEnvValue: "env-dev-two",
    globalEnvValue: "global",
  }), "configured-dev-two");
  assert.equal(resolveSyncScope({
    profileId: "development-2",
    profileEnvValue: "env-dev-two",
    globalEnvValue: "global",
  }), "env-dev-two");
  assert.equal(resolveSyncScope({
    profileId: "development-2",
    globalEnvValue: "global",
  }), "global");
  assert.equal(resolveSyncScope({ profileId: "development-2" }), "profile:development-2");
  assert.equal(resolveSyncScope({ profileId: "production" }), "production");
});

test("强制释放端口只允许已识别的未受管 AIEfficiency Node 服务", () => {
  assert.deepEqual(evaluateForceReleaseCandidate({
    pid: 9460,
    name: "node.exe",
    command: '"node" server.js',
    expectedService: "gateway",
    serviceFingerprintVerified: true,
  }), {
    eligible: true,
    reason: "recognized_unmanaged_node_service",
  });
  assert.equal(evaluateForceReleaseCandidate({
    pid: 9460,
    name: "node.exe",
    command: '"node" server.js',
    managedProfileId: "development",
    expectedService: "gateway",
    serviceFingerprintVerified: true,
  }).reason, "managed_process");
  assert.equal(evaluateForceReleaseCandidate({
    pid: 9460,
    name: "node.exe",
    command: '"node" server.js',
    protectedPids: [9460],
    expectedService: "gateway",
    serviceFingerprintVerified: true,
  }).reason, "protected_process");
  assert.equal(evaluateForceReleaseCandidate({
    pid: 12000,
    name: "postgres.exe",
    command: "postgres -D data",
    expectedService: "gateway",
    serviceFingerprintVerified: true,
  }).reason, "unsupported_process");
  assert.equal(evaluateForceReleaseCandidate({
    pid: 13000,
    name: "node.exe",
    command: "node unrelated-worker.js",
    expectedService: "gateway",
    serviceFingerprintVerified: true,
  }).reason, "unrecognized_service_command");
  assert.equal(evaluateForceReleaseCandidate({
    pid: 14000,
    name: "node.exe",
    command: "node C:\\other-app\\server.js",
    expectedService: "gateway",
    serviceFingerprintVerified: false,
  }).reason, "unverified_aiefficiency_service");
  assert.equal(evaluateForceReleaseCandidate({
    pid: 15000,
    name: "node.exe",
    command: "node C:\\unrelated\\node_modules\\vite\\bin\\vite.js --port 3001",
    expectedService: "web",
    serviceFingerprintVerified: false,
  }).reason, "unverified_aiefficiency_service");
  assert.deepEqual(evaluateForceReleaseCandidate({
    pid: 16000,
    name: "node.exe",
    command: '"node" "D:\\workspace\\AIEfficiency\\web-dashboard\\node_modules\\vite\\bin\\vite.js"',
    expectedService: "web",
    serviceFingerprintVerified: true,
  }), {
    eligible: true,
    reason: "recognized_unmanaged_node_service",
  });
  assert.equal(evaluateForceReleaseCandidate({
    pid: 17000,
    name: "node.exe",
    command: "node unrelated-worker.js",
    expectedService: "web",
    serviceFingerprintVerified: true,
  }).reason, "unrecognized_service_command");
});

test("AIEfficiency Web 指纹只接受已配置仓库内的 Vite 入口", () => {
  const roots = [
    "D:\\workspace\\xsProjects\\202606\\AIEfficiency202606",
    "D:\\workspace\\xsProjects\\202604\\AIEfficiency",
  ];
  assert.equal(isAIEfficiencyWebCommand(
    '"node" "D:\\workspace\\xsProjects\\202604\\AIEfficiency\\web-dashboard\\node_modules\\.bin\\..\\vite\\bin\\vite.js"',
    roots,
  ), true);
  assert.equal(isAIEfficiencyWebCommand(
    "node D:/workspace/xsProjects/202606/AIEfficiency202606/web-dashboard/node_modules/vite/bin/vite.js --port 3000",
    roots,
  ), true);
  assert.equal(isAIEfficiencyWebCommand(
    "node D:/workspace/unrelated/web-dashboard/node_modules/vite/bin/vite.js --port 3000",
    roots,
  ), false);
  assert.equal(isAIEfficiencyWebCommand(
    "node D:/workspace/xsProjects/202604/AIEfficiency/gateway/server.js",
    roots,
  ), false);
});

test("AIEfficiency Gateway 指纹要求 discovery 节点结构完整", () => {
  assert.equal(isAIEfficiencyGatewayFingerprint({
    ok: true,
    data: {
      id: "87a2e5a37958",
      role: "standalone",
      host: "http://192.168.10.110:3001",
      capacity: { maxConcurrent: 3 },
      syncScope: "production",
      sharedVersion: 1785376243808,
      ts: 1785376279427,
    },
  }), true);
  assert.equal(isAIEfficiencyGatewayFingerprint({
    ok: true,
    data: {
      id: "87a2e5a37958",
      role: "standalone",
      host: "http://192.168.10.110:3001",
    },
  }), false);
  assert.equal(isAIEfficiencyGatewayFingerprint({
    status: "ok",
    version: "2.5.7",
  }), false);
  assert.equal(isAIEfficiencyGatewayFingerprint({
    ok: true,
    data: {
      id: "87a2e5a37958",
      role: "standalone",
      host: "http://192.168.10.110:3001",
      capacity: { maxConcurrent: "3" },
      syncScope: "production",
      sharedVersion: "1785376243808",
      ts: "1785376279427",
    },
  }), false);
});

test("Service Control 接入运行态策略并向 Gateway 注入隔离同步域", () => {
  const main = fs.readFileSync(path.join(repoRoot, "service-control-electron", "main.js"), "utf8");
  const serviceControlPackage = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "service-control-electron", "package.json"),
    "utf8",
  ));

  assert.match(main, /evaluateRuntimeHealth\(/);
  assert.match(main, /decideStartAction\(/);
  assert.match(main, /invalidateRuntimeHealthObservations\(id\)/);
  assert.match(main, /const observationIsCurrent = \(\) => canApplyRuntimeHealthObservation/);
  assert.match(main, /shouldApplyObservation: observationIsCurrent/);
  assert.match(main, /runtimeHealthChecks\.has\(id\)/);
  assert.match(main, /recordedPidsAlive[\s\S]*inspectProfileRuntime\(profile, gatewayPort, webPort, current\)/);
  assert.match(main, /DEVBENCH_SYNC_SCOPE:\s*resolveProfileSyncScope\(profile\)/);
  assert.match(main, /if \(startAction === "adopt_degraded"\)/);
  assert.match(main, /await cleanupProfilePorts\(id, profile, profileState\(id\)\)/);
  assert.match(main, /"control:restart"[\s\S]*await stopServices\(profileId\); await startServices\(profileId\)/);
  assert.match(main, /HEALTH_CHECK_ACTIVE_MS = 30_000/);
  assert.match(main, /HEALTH_CHECK_DEGRADED_MS = 5_000/);
  assert.match(main, /HEALTH_CHECK_IDLE_MS = 60_000/);
  assert.match(main, /degradedConfirmations: DEFAULT_DEGRADED_CONFIRMATIONS/);
  assert.match(main, /runtimeHealthObservations\.size > 0/);
  assert.match(main, /if \(!visible\) return false/);
  assert.match(main, /runtimeHealthTimer = setTimeout/);
  assert.match(main, /inspectPortFallbacks\(profile, gatewayPort, webPort\)/);
  assert.match(main, /async function refreshInactivePortFallbacks\(/);
  assert.match(main, /const desiredProfile = getRuntimeProfile\(profileId\);[\s\S]*patch\.gatewayPort = desiredProfile\.gatewayPort/);
  assert.match(main, /const fallbackCandidates = previousPortFallbacks\.length[\s\S]*gatewayPortDrift[\s\S]*webPortDrift/);
  assert.match(main, /await canListen\(fallback\.preferredPort\)/);
  assert.match(main, /portFallbacks: refreshedPortFallbacks/);
  assert.match(main, /snapshot\.pids\.length === 1[\s\S]*isAIEfficiencyGatewayFingerprint/);
  assert.match(main, /expectedService === "web"[\s\S]*snapshot\.pids\.length === 1[\s\S]*isAIEfficiencyWebCommand\(info\.command, configuredAIEfficiencyRepoRoots\(\)\)/);
  assert.match(main, /await waitForStablePortRelease\(preferredPort\)/);
  assert.match(main, /if \(!afterStop\.stable && afterStop\.pids\.length\)[\s\S]*if \(!afterStop\.stable\)/);
  assert.match(main, /const preferredProfile = getRuntimeProfile\(id\);[\s\S]*preferredWebPort: preferredProfile\.webPort/);
  assert.match(main, /Fully exiting and restarting this panel will not release external or untracked occupying processes/);
  assert.match(main, /"control:forceReleasePort"/);
  assert.match(main, /evaluateForceReleaseProfileState\(\{[\s\S]*?hasFallback: !!fallback && !!preferredPort/);
  assert.match(main, /if \(profileEligibility\.stopBeforeStart\) \{\s*await stopServices\(id\);\s*\}[\s\S]*const afterStop = await waitForStablePortRelease\(preferredPort\);[\s\S]*await startServices\(id\)/);
  assert.match(main, /确认期间端口占用者发生变化/);
  assert.match(
    main,
    /Start-Process -FilePath 'taskkill\.exe' -ArgumentList @\(\$\{escapedArgs\}\) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit \$p\.ExitCode/,
  );
  assert.match(main, /端口 \$\{preferredPort\} 在旧进程结束后被 \$\{description\} 重新占用/);
  assert.match(main, /message: error\.message,[\s\S]*lastError: error\.message/);
  assert.match(main, /await stopServices\(id\);\s*await startServices\(id\)/);
  assert.ok(serviceControlPackage.build.files.includes("runtime-health-policy.cjs"));
});

test("Service Control 将端口回退、数据库过大和退出重启边界醒目展示给用户", () => {
  const main = fs.readFileSync(path.join(repoRoot, "service-control-electron", "main.js"), "utf8");
  const renderer = fs.readFileSync(
    path.join(repoRoot, "service-control-electron", "renderer", "renderer.js"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(repoRoot, "service-control-electron", "renderer", "index.html"),
    "utf8",
  );

  assert.match(main, /DATABASE_WARNING_BYTES = 512 \* 1024 \* 1024/);
  assert.match(main, /database: getProfileDatabaseDiagnostics\(profile\)/);
  assert.match(main, /portFallbacks/);
  assert.match(html, /id="attentionPanel"[\s\S]*需要用户关注/);
  assert.match(renderer, /首选端口 \$\{fallback\.preferredPort\} 被占用/);
  assert.match(renderer, /仅关闭窗口会隐藏到托盘，不会退出/);
  assert.match(renderer, /完全退出并重启控制面板不会释放外部或未跟踪进程/);
  assert.match(renderer, /可使用下方强制恢复按钮；系统会再次核对进程身份并要求确认/);
  assert.match(renderer, /数据库体积已达/);
  assert.match(renderer, /强制结束 PID \$\{candidates\.map/);
  assert.match(renderer, /window\.serviceControl\.forceReleasePort/);
  assert.match(renderer, /setInterval\([\s\S]*60_000/);
});
