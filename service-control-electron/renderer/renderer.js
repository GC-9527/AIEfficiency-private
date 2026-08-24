const $ = (id) => document.getElementById(id);

let currentState = {};
const ACTIVE_PROFILE_STORAGE_KEY = "aiefficiency.activeProfile.v2";
let activeProfileId = localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || "";
const syncCheckboxSelector = "[data-sync-key]";
const buildCheckboxSelector = "[data-build-target]";
let buildModalProfileId = "";

function profileIds() {
  return currentState.profileOrder || ["production", "development"];
}

function isDevelopmentProfileId(id) {
  return currentState.profiles?.[id]?.kind === "development" || /^development(?:-\d+)?$/.test(String(id || ""));
}

function normalizeProfileId(id) {
  const ids = profileIds();
  const fallback = currentState.defaultProfile || ids[0] || "production";
  return profileIds().includes(id) ? id : fallback;
}

function activeProfile() {
  activeProfileId = normalizeProfileId(activeProfileId);
  return currentState.profiles?.[activeProfileId] || {};
}

function syncOptions() {
  const out = {};
  for (const input of document.querySelectorAll(syncCheckboxSelector)) {
    out[input.dataset.syncKey] = input.checked === true;
  }
  out.replaceVehicleMap = $("replaceVehicleMap")?.checked === true;
  return out;
}

function selectedSyncCount() {
  return Object.entries(syncOptions()).filter(([key, value]) => key !== "replaceVehicleMap" && value).length;
}

function selectedBuildTargets() {
  return [...document.querySelectorAll(buildCheckboxSelector)]
    .filter((input) => input.checked)
    .map((input) => input.dataset.buildTarget);
}

function resetBuildSelection() {
  for (const input of document.querySelectorAll(buildCheckboxSelector)) {
    input.checked = input.dataset.defaultSelected === "true";
  }
}

function buildState(profileId = buildModalProfileId || activeProfileId) {
  return currentState.builds?.[profileId] || { status: "idle", logs: [] };
}

function renderBuildModal() {
  const modal = $("buildModal");
  if (modal.hidden) return;
  const selected = selectedBuildTargets();
  const current = buildState();
  const running = current.status === "running";
  const hasResult = running || current.status === "success" || current.status === "failed";
  const progress = Math.max(0, Math.min(100, Number(current.progress || 0)));

  // Service operations temporarily disable every button through setBusy().
  // Restore the modal controls explicitly when the refreshed state renders.
  $("buildCloseIcon").disabled = false;
  $("buildCloseBtn").disabled = false;
  for (const input of document.querySelectorAll(buildCheckboxSelector)) input.disabled = running;
  $("buildProgressPanel").hidden = !hasResult;
  $("buildProgressPanel").classList.toggle("failed", current.status === "failed");
  $("buildProgressBar").style.width = `${progress}%`;
  $("buildProgressTitle").textContent = running
    ? `正在编译 ${current.currentLabel || current.currentTarget || ""}`
    : current.status === "success" ? "编译完成" : "编译失败";
  $("buildProgressDetail").textContent = current.message || (
    running ? `第 ${Number(current.currentIndex || 0) + 1} / ${current.total || selected.length} 项` : ""
  );
  $("buildStatusBadge").className = `buildStatusBadge ${current.status || ""}`;
  $("buildStatusBadge").textContent = running ? `${progress}%` : current.status === "success" ? "成功" : current.status === "failed" ? "失败" : "等待";
  $("buildLog").textContent = (current.logs || []).join("\n") || "等待编译输出…";
  $("buildLog").scrollTop = $("buildLog").scrollHeight;

  const hint = $("buildSelectionHint");
  hint.classList.remove("error");
  if (current.status === "failed" && current.error) {
    hint.textContent = current.error;
    hint.classList.add("error");
  } else if (current.status === "success") {
    hint.textContent = `已完成 ${current.completedTargets?.length || selected.length} 项 · 发布文件位于 dist/`;
  } else if (running) {
    hint.textContent = "可关闭此窗口，编译会继续在后台运行。";
  } else {
    hint.textContent = `已选择 ${selected.length} 项 · 输出到 dist/，日志保存到 docs/tempFiles/build-logs/`;
    hint.classList.toggle("error", selected.length === 0);
  }

  $("buildStartBtn").disabled = running || selected.length === 0;
  $("buildStartBtn").querySelector("span").textContent = current.status === "failed" ? "重新编译" : "开始编译";
  $("buildCloseBtn").textContent = running ? "后台运行" : "取消";
}

function openBuildModal() {
  buildModalProfileId = activeProfileId;
  if (buildState().status !== "running") resetBuildSelection();
  $("buildModal").hidden = false;
  renderBuildModal();
}

function closeBuildModal() {
  $("buildModal").hidden = true;
}

function setSyncResult(message, level) {
  const el = $("syncResult");
  el.dataset.manual = "1";
  el.className = "syncResult";
  if (level) el.classList.add(level);
  el.textContent = message;
}

function syncSelectionError(target, paths) {
  if (!paths.devRoot) return "Current development repository path is not configured.";
  if (target === "production" && !paths.prodRoot) return "Production repository path is not configured. Click Production Path first.";
  if (target === "desktop" && !paths.desktopRoot) return "Desktop runtime path is not configured. Click Desktop Path first.";
  if (!selectedSyncCount()) return "Select at least one data group before syncing.";
  if ($("replaceVehicleMap")?.checked && !syncOptions().vehicleMap) return "Select Vehicle source mappings before enabling replacement.";
  if ($("syncConfirmInput").value !== "SYNC") return "Type SYNC in the confirmation field before syncing.";
  return "";
}

function setBusy(isBusy) {
  for (const button of document.querySelectorAll("button")) {
    if (button.closest(".envSwitch")) continue;
    button.disabled = isBusy;
  }
}

function statusLabel(status, warning = false) {
  if (status === "starting" || status === "stopping") return "Working";
  if (status === "running") return warning ? "Running with warnings" : "Running in background";
  if (status === "failed" || status === "repo_missing") return "Needs attention";
  return "Stopped";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}

function profileWarnings(profile) {
  const warnings = [];
  if (profile.phase === "degraded") {
    warnings.push(`运行健康检查异常：${profile.message || "服务响应暂时不可用"}。控制面板会在 5 秒后复查，不会立即误判服务已停止。`);
  }
  for (const fallback of profile.portFallbacks || []) {
    const service = fallback.service === "web" ? "网页" : "Gateway";
    const occupants = fallback.occupants?.length
      ? fallback.occupants.map((item) => {
        const owner = item.managedProfileLabel ? `，由本面板 ${item.managedProfileLabel} 管理` : "，不由本面板管理";
        return `${item.name || "未知进程"} PID ${item.pid}${owner}`;
      }).join("；")
      : "占用进程暂时无法识别";
    const restartHint = fallback.restartMayResolve
      ? "使用 Exit 完全退出控制面板后重启，可能释放该端口；仅关闭窗口会隐藏到托盘，不会退出。"
      : fallback.occupants?.some((item) => item.forceReleaseEligible)
        ? "可使用下方强制恢复按钮；系统会再次核对进程身份并要求确认。"
        : "完全退出并重启控制面板不会释放外部或未跟踪进程，需先停止占用进程或继续使用新端口。";
    warnings.push(`${service} 首选端口 ${fallback.preferredPort} 被占用（${occupants}），已改用 ${fallback.actualPort}。${restartHint}`);
  }
  const database = profile.database || {};
  if (database.warning) {
    const wal = database.walBytes ? `，WAL ${formatBytes(database.walBytes)}` : "";
    warnings.push(`数据库体积已达 ${formatBytes(database.totalBytes)}（主库 ${formatBytes(database.bytes)}${wal}），可能拖慢启动和备份。请在 DevBench“同步备份”中执行清理；系统会保留最近的自动备份。`);
  }
  return warnings;
}

function forceReleaseableFallbacks(profile) {
  return (profile.portFallbacks || []).filter(
    (fallback) => (fallback.occupants || []).some((item) => item.forceReleaseEligible),
  );
}

function renderAttentionActions(profile, busy) {
  const actions = $("attentionActions");
  actions.innerHTML = "";
  for (const fallback of forceReleaseableFallbacks(profile)) {
    const candidates = fallback.occupants.filter((item) => item.forceReleaseEligible);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "forceReleaseBtn";
    button.disabled = busy;
    button.textContent = `强制结束 PID ${candidates.map((item) => item.pid).join("、")} 并恢复端口 ${fallback.preferredPort}`;
    button.title = "将再次核对端口和进程身份，并弹出确认窗口；成功后自动重启当前环境";
    button.addEventListener("click", async () => {
      try {
        const result = await invoke(
          () => window.serviceControl.forceReleasePort(activeProfileId, fallback.preferredPort),
        );
        if (result?.cancelled) return;
        if (result?.ok && !result.restored) {
          alert(`旧进程已结束，但服务重启后使用了端口 ${result.actualPort}，请查看新的告警信息。`);
        } else if (result?.ok && result.restored && result.remainingFallbacks?.length) {
          const remaining = result.remainingFallbacks.map((item) => {
            const service = item.service === "web" ? "网页" : "Gateway";
            const pids = item.occupantPids?.length ? `（PID ${item.occupantPids.join("、")}）` : "";
            return `${service} 首选端口 ${item.preferredPort}${pids}`;
          }).join("；");
          alert(`端口 ${result.preferredPort} 已恢复；仍有其他端口被占用：${remaining}。请继续点击对应的强制恢复按钮。`);
        }
      } catch (error) {
        alert(`强制结束占用进程失败：${error.message || error}`);
      }
    });
    actions.appendChild(button);
  }
  actions.classList.toggle("visible", actions.childElementCount > 0);
}

function renderEnvironmentSwitch() {
  const switcher = $("envSwitch");
  switcher.innerHTML = "";
  for (const id of profileIds()) {
    const profile = currentState.profiles?.[id] || {};
    const tab = document.createElement("div");
    tab.className = "envTab";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.profile = id;
    button.disabled = false;
    button.classList.toggle("active", id === activeProfileId);
    const warning = profileWarnings(profile).length > 0;
    button.textContent = `${warning ? "⚠ " : ""}${profile.label || (isDevelopmentProfileId(id) ? "Development" : "Production")}`;
    button.title = profile.root || profile.label || id;
    button.addEventListener("click", () => {
      activeProfileId = normalizeProfileId(id);
      localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, activeProfileId);
      render(currentState);
    });
    tab.appendChild(button);
    if (isDevelopmentProfileId(id)) {
      const status = profile.status || "stopped";
      const removable = status !== "running" && status !== "starting" && status !== "stopping";
      const removeButton = document.createElement("button");
      tab.classList.add("hasRemove");
      removeButton.type = "button";
      removeButton.className = "envTabRemove";
      removeButton.dataset.removeProfile = id;
      removeButton.disabled = !removable;
      removeButton.textContent = "×";
      removeButton.title = removable
        ? `Remove ${profile.label || id}`
        : `Stop ${profile.label || id} before removing it`;
      removeButton.setAttribute("aria-label", `Remove ${profile.label || id}`);
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!removeButton.disabled) removeDevelopmentTab(id);
      });
      tab.appendChild(removeButton);
    }
    switcher.appendChild(tab);
  }
}

function render(state) {
  currentState = state || {};
  activeProfileId = normalizeProfileId(activeProfileId);
  const current = activeProfile();
  const status = current.status || "stopped";
  const busy = status === "starting" || status === "stopping";
  const running = status === "running";
  const failed = status === "failed" || status === "repo_missing";
  const warnings = profileWarnings(current);
  const warning = warnings.length > 0;

  renderEnvironmentSwitch();
  $("subtitle").textContent = `${current.label || activeProfileId} gateway + web-dashboard`;

  const dot = $("dot");
  dot.className = "dot";
  if (busy) dot.classList.add("busy");
  else if (warning) dot.classList.add(current.phase === "degraded" ? "failed" : "warning");
  else if (running) dot.classList.add("running");
  else if (failed) dot.classList.add("failed");

  $("statusText").textContent = statusLabel(status, warning);
  const ports = [current.gatewayPort ? `gateway:${current.gatewayPort}` : "", current.webPort ? `web:${current.webPort}` : ""].filter(Boolean).join("  ");
  $("detailText").textContent = current.lastError || [current.message || "Ready", ports].filter(Boolean).join("  ");
  const attentionPanel = $("attentionPanel");
  attentionPanel.classList.toggle("visible", warning);
  attentionPanel.classList.toggle("critical", current.phase === "degraded");
  $("attentionText").textContent = warnings.join("\n");
  renderAttentionActions(current, busy);
  $("urlText").textContent = current.panelUrl || "";
  $("repoText").textContent = current.root || (current.mode === "bundled" ? "Bundled production runtime" : "Not configured");

  const prod = currentState.profiles?.production || {};
  const dev = current;
  const desktopRuntime = currentState.desktopRuntime || {};
  const syncPanel = $("syncPanel");
  const showSync = isDevelopmentProfileId(activeProfileId);
  syncPanel.classList.toggle("visible", showSync);
  if (showSync) {
    const missing = [
      !prod.root ? "Production repository path is not configured" : "",
      !dev.root ? "Current development repository path is not configured" : "",
      !desktopRuntime.root ? "Desktop runtime path is not configured" : "",
    ].filter(Boolean);
    const manual = dev.manualSyncToProduction || {};
    const desktopManual = dev.manualSyncToDesktopRuntime || {};
    $("syncHint").textContent = missing.length
      ? missing.join(". ")
      : `Development: ${dev.root}\nProduction: ${prod.root}\nDesktop: ${desktopRuntime.root}`;
    if ($("syncResult").dataset.manual !== "1") {
      const last = [
        manual.syncedAt ? `Production: ${manual.syncedAt}` : "",
        desktopManual.syncedAt ? `Desktop: ${desktopManual.syncedAt}` : "",
      ].filter(Boolean);
      $("syncResult").textContent = last.length ? `Last manual sync - ${last.join(" / ")}` : "";
    }
  } else {
    $("syncResult").dataset.manual = "";
    $("syncResult").textContent = "";
  }

  const modeText = current.mode === "bundled" ? "Bundled installer mode" : "Source repository mode";
  const sync = current.sync || {};
  const manualSync = current.manualSyncToProduction || {};
  const desktopManualSync = current.manualSyncToDesktopRuntime || {};
  const syncText = showSync
    ? `\nProduction -> development sync:\n${sync.lastSyncAt ? `last: ${sync.lastSyncAt}` : "waiting for sync"}${sync.lastError ? `\nerror: ${sync.lastError}` : ""}`
    : "";
  $("logText").textContent = [
    modeText,
    `Environment: ${current.label || activeProfileId}`,
    current.logDir ? `Log directory:\n${current.logDir}` : "Logs will be written under docs/tempFiles/service-control.",
    syncText.trim(),
  ].filter(Boolean).join("\n");

  $("startBtn").disabled = busy || running || status === "repo_missing";
  $("stopBtn").disabled = busy || !running;
  $("restartBtn").disabled = busy || status === "repo_missing";
  $("openWebBtn").disabled = !running || !current.panelUrl;
  $("openDesktopBtn").disabled = !running || !current.panelUrl;
  const profileBuild = buildState(activeProfileId);
  const anyBuildRunning = Object.values(currentState.builds || {}).some((build) => build.status === "running");
  $("buildBtn").disabled = !current.root || current.mode === "bundled";
  $("buildBtn").textContent = profileBuild.status === "running" ? `编译中 ${profileBuild.progress || 0}%` : "编译";
  $("copyBtn").disabled = !current.panelUrl;
  $("logsBtn").disabled = false;
  $("repoBtn").disabled = !current.root;
  $("exitBtn").disabled = busy || anyBuildRunning;
  $("exitBtn").title = anyBuildRunning ? "请等待编译完成后再退出 Service Control" : "";
  $("chooseRepo").disabled = busy || current.mode === "bundled";
  $("addDevBtn").disabled = busy;
  $("removeDevBtn").disabled = !showSync || busy || running;
  $("chooseProdRepoBtn").disabled = !showSync || busy;
  $("chooseDesktopRuntimeBtn").disabled = !showSync || busy;
  $("syncToProdBtn").disabled = !showSync || busy;
  if (showSync && manualSync.status === "running") $("syncToProdBtn").disabled = true;
  $("syncToDesktopBtn").disabled = !showSync || busy;
  if (showSync && desktopManualSync.status === "running") $("syncToDesktopBtn").disabled = true;
  $("syncSelectAllBtn").disabled = !showSync || busy;
  $("syncClearBtn").disabled = !showSync || busy;

  const countEl = $("syncCount");
  if (countEl) {
    const selectedCount = selectedSyncCount();
    countEl.textContent = `${selectedCount} selected`;
    countEl.classList.toggle("zero", selectedCount === 0);
  }
}

async function invoke(fn) {
  setBusy(true);
  try {
    return await fn();
  } finally {
    await refreshState();
  }
}

async function refreshState() {
  try {
    const state = await window.serviceControl.getState();
    render(state);
  } catch (err) {
    console.error("Failed to refresh service state", err);
  }
}

async function removeDevelopmentTab(id) {
  const profile = currentState.profiles?.[id] || {};
  const status = profile.status || "stopped";
  if (!isDevelopmentProfileId(id)) return;
  if (status === "running" || status === "starting" || status === "stopping") return;
  const label = profile.label || id;
  if (!confirm(`Remove ${label} from Service Control?`)) return;
  const previousActiveProfileId = activeProfileId;
  try {
    const result = await invoke(() => window.serviceControl.removeDevelopment(id));
    activeProfileId = previousActiveProfileId === id
      ? normalizeProfileId(result?.defaultProfile)
      : normalizeProfileId(previousActiveProfileId);
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, activeProfileId);
    render(currentState);
  } catch (err) {
    alert(`Remove development environment failed: ${err.message || err}`);
  }
}

$("startBtn").addEventListener("click", () => invoke(() => window.serviceControl.start(activeProfileId)));
$("stopBtn").addEventListener("click", () => invoke(() => window.serviceControl.stop(activeProfileId)));
$("restartBtn").addEventListener("click", () => invoke(() => window.serviceControl.restart(activeProfileId)));
$("openWebBtn").addEventListener("click", () => window.serviceControl.openWebTerminal(activeProfileId));
$("openDesktopBtn").addEventListener("click", () => window.serviceControl.openDesktopTerminal(activeProfileId));
$("buildBtn").addEventListener("click", openBuildModal);
$("logsBtn").addEventListener("click", () => window.serviceControl.openLogs(activeProfileId));
$("repoBtn").addEventListener("click", () => window.serviceControl.openRepo(activeProfileId));
$("chooseRepo").addEventListener("click", () => invoke(() => window.serviceControl.chooseRepo(activeProfileId)));
$("chooseProdRepoBtn").addEventListener("click", () => invoke(() => window.serviceControl.chooseRepo("production")));
$("chooseDesktopRuntimeBtn").addEventListener("click", () => invoke(() => window.serviceControl.chooseDesktopRuntime(activeProfileId)));
$("addDevBtn").addEventListener("click", async () => {
  try {
    const result = await invoke(() => window.serviceControl.addDevelopment());
    if (result?.profileId) {
      activeProfileId = result.profileId;
      localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, activeProfileId);
      render(currentState);
    }
  } catch (err) {
    alert(`Add development environment failed: ${err.message || err}`);
  }
});
$("removeDevBtn").addEventListener("click", () => removeDevelopmentTab(activeProfileId));
$("copyBtn").addEventListener("click", async () => {
  const current = activeProfile();
  if (current.panelUrl) await navigator.clipboard.writeText(current.panelUrl);
});
for (const input of document.querySelectorAll(buildCheckboxSelector)) {
  input.addEventListener("change", renderBuildModal);
}
$("buildCloseBtn").addEventListener("click", closeBuildModal);
$("buildCloseIcon").addEventListener("click", closeBuildModal);
$("buildModal").addEventListener("click", (event) => {
  if (event.target === $("buildModal")) closeBuildModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("buildModal").hidden) closeBuildModal();
});
$("buildStartBtn").addEventListener("click", async () => {
  const targets = selectedBuildTargets();
  if (!targets.length) {
    renderBuildModal();
    return;
  }
  try {
    const result = await window.serviceControl.startBuild(buildModalProfileId, targets);
    currentState.builds = { ...(currentState.builds || {}), [buildModalProfileId]: result };
    renderBuildModal();
    render(currentState);
  } catch (error) {
    const failed = {
      status: "failed",
      progress: 0,
      logs: [],
      error: error.message || String(error),
    };
    currentState.builds = { ...(currentState.builds || {}), [buildModalProfileId]: failed };
    renderBuildModal();
  }
});
$("syncSelectAllBtn").addEventListener("click", () => {
  for (const input of document.querySelectorAll(syncCheckboxSelector)) input.checked = true;
  $("syncResult").dataset.manual = "";
  render(currentState);
});
$("syncClearBtn").addEventListener("click", () => {
  for (const input of document.querySelectorAll(syncCheckboxSelector)) input.checked = false;
  $("replaceVehicleMap").checked = false;
  $("syncConfirmInput").value = "";
  $("syncResult").dataset.manual = "";
  render(currentState);
});
for (const input of document.querySelectorAll(syncCheckboxSelector)) {
  input.addEventListener("change", () => {
    $("syncResult").dataset.manual = "";
    render(currentState);
  });
}
$("replaceVehicleMap").addEventListener("change", () => {
  $("syncResult").dataset.manual = "";
  render(currentState);
});
$("syncConfirmInput").addEventListener("input", () => {
  $("syncResult").dataset.manual = "";
  render(currentState);
});

async function runSelectedSync(target) {
  if (!isDevelopmentProfileId(activeProfileId)) return;
  const prod = currentState.profiles?.production || {};
  const dev = activeProfile();
  const desktopRuntime = currentState.desktopRuntime || {};
  const options = syncOptions();
  const error = syncSelectionError(target, {
    devRoot: dev.root,
    prodRoot: prod.root,
    desktopRoot: desktopRuntime.root,
  });
  if (error) {
    setSyncResult(error, "error");
    return;
  }
  const names = Object.entries(options).filter(([, value]) => value).map(([key]) => key).join(", ");
  const label = target === "desktop" ? "desktop runtime" : "production repository";
  // 不再弹二次 confirm：Type SYNC 已是强确认。此前 confirm() 在部分环境下不弹窗/被关，
  // 会让同步静默中止（后端无任何记录），表现为“点击同步没有效果”。
  setSyncResult(`Syncing selected data to ${label} (${names})...`, "running");
  const result = target === "desktop"
    ? await window.serviceControl.syncToDesktopRuntime(activeProfileId, options)
    : await window.serviceControl.syncToProduction(activeProfileId, options);
  if (result?.ok === false) {
    setSyncResult(`Sync failed: ${result.error || "unknown error"}`, "error");
    return;
  }
  const parts = [`Sync completed: ${result?.syncedAt || new Date().toISOString()}`];
  const ae = result?.apiEngines;
  if (ae && ae.ok === false) {
    parts.push(`API engines failed: ${ae.error || "unknown"}`);
  } else if (ae && ae.ok && ae.skipped) {
    parts.push(`API engines skipped (${ae.reason || "no change"})`);
  } else if (ae && ae.ok && !ae.skipped) {
    parts.push(`API engines: +${ae.added || 0} ~${ae.updated || 0} -${ae.removed || 0}`);
    const push = ae.push;
    if (push && push.ok && push.pushed) parts.push(`applied to running gateway :${push.port}`);
    else if (push && push.ok === false) parts.push(`gateway push failed: ${push.error}`);
  }
  setSyncResult(parts.join("  "), "success");
}

$("syncToProdBtn").addEventListener("click", () => invoke(() => runSelectedSync("production")));
$("syncToDesktopBtn").addEventListener("click", () => invoke(() => runSelectedSync("desktop")));
$("exitBtn").addEventListener("click", async () => {
  if (confirm("Stop all managed services, then exit the controller?")) {
    await window.serviceControl.exitAll();
  }
});

window.serviceControl.onState(render);
window.serviceControl.onBuildProgress(({ profileId, build }) => {
  currentState.builds = { ...(currentState.builds || {}), [profileId]: build };
  if (profileId === activeProfileId) {
    $("buildBtn").textContent = build.status === "running" ? `编译中 ${build.progress || 0}%` : "编译";
  }
  if (profileId === buildModalProfileId) renderBuildModal();
});
refreshState();
// 主进程在状态变化时主动推送；这里仅保留低频兜底，用于刷新数据库体积等文件级诊断。
setInterval(() => {
  if (!document.hidden) refreshState();
}, 60_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshState();
});
