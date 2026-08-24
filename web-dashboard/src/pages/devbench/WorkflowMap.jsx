import React, { useMemo, useState } from "react";
import {
  WORKFLOW_LANES,
  getWorkflowPhase,
  workflowPhaseItems,
} from "./workflowMapModel.js";

function PhaseButton({ phase, isRunning, busyPhase, onPick }) {
  const disabledReason = isRunning
    ? "AI 正在运行，不能切换工作流步骤；请等待运行结束或先停止当前任务"
    : busyPhase
      ? "正在切换工作流步骤，请稍候"
      : phase.current
        ? "当前工作流状态"
        : "";
  const disabled = !!disabledReason;
  return (
    <button
      type="button"
      data-workflow-phase={phase.id}
      aria-current={phase.current ? "step" : undefined}
      disabled={disabled}
      onClick={() => onPick(phase)}
      title={disabledReason || `切换到「${phase.label}」：${phase.description}`}
      className={`relative w-full rounded-lg border px-2 py-1.5 text-left transition ${
        phase.current
          ? "border-blue-400 bg-blue-600 text-white shadow-lg shadow-blue-950/60 ring-2 ring-blue-400/40"
          : disabled
            ? "border-zinc-800 bg-zinc-900/70 text-zinc-600 cursor-not-allowed"
            : "border-zinc-700 bg-zinc-900/90 text-zinc-300 hover:border-blue-500/70 hover:bg-blue-950/70 hover:text-white"
      }`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${phase.current ? "bg-white animate-pulse" : "bg-zinc-600"}`} />
        <span className="text-[11px] font-medium">{phase.label}</span>
        <span className="ml-auto font-mono text-[9px] opacity-60">{phase.id}</span>
      </span>
      <span className={`mt-0.5 block pl-3.5 text-[9px] leading-4 ${phase.current ? "text-[var(--color-accent-ink)]" : "text-zinc-500"}`}>
        {phase.description}
      </span>
    </button>
  );
}

function PhaseLane({ lane, phases, isRunning, busyPhase, onPick }) {
  const phaseIds = lane.phaseIds.filter((phaseId) => phases.has(phaseId));
  if (!phaseIds.length) return null;
  return (
    <section aria-label={lane.label}>
      <div className="mb-1 flex items-center gap-1.5 text-[9px] font-medium text-zinc-500">
        <span className={`h-px flex-1 ${lane.id === "reject" ? "bg-amber-800/60" : "bg-zinc-700"}`} />
        <span>{lane.label}</span>
        <span className={`h-px flex-1 ${lane.id === "reject" ? "bg-amber-800/60" : "bg-zinc-700"}`} />
      </div>
      <div className="space-y-1">
        {phaseIds.map((phaseId, index) => {
          const phase = phases.get(phaseId);
          return (
            <React.Fragment key={phaseId}>
              {index > 0 && <div className="mx-auto h-2 w-px bg-zinc-700" aria-hidden="true" />}
              <PhaseButton phase={phase} isRunning={isRunning} busyPhase={busyPhase} onPick={onPick} />
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );
}

export default function WorkflowMap({ currentPhase, skipTestAcceptance = false, isRunning = false, onSetPhase, onToast }) {
  const [collapsed, setCollapsed] = useState(false);
  const [busyPhase, setBusyPhase] = useState("");
  const items = workflowPhaseItems(currentPhase, { skipTestAcceptance });
  const phases = useMemo(() => new Map(items.map((phase) => [phase.id, phase])), [items]);
  const current = getWorkflowPhase(currentPhase);

  async function pickPhase(target) {
    if (isRunning || busyPhase || target.current || !onSetPhase) return;
    const confirmed = window.confirm(
      `将工作流从「${current.label}」切换到「${target.label}」？\n\n切换只调整当前故事点的工作流状态；请在切换后从对应步骤继续操作。`,
    );
    if (!confirmed) return;
    setBusyPhase(target.id);
    try {
      const result = await onSetPhase(target.id);
      if (result?.ok === false) onToast?.(result.error || "切换工作流步骤失败");
    } catch (error) {
      onToast?.(error?.message || "切换工作流步骤失败");
    } finally {
      setBusyPhase("");
    }
  }

  return (
    <aside
      data-testid="devbench-workflow-map"
      data-collapsed={collapsed ? "true" : "false"}
      className={`absolute left-3 top-3 z-30 flex flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950/95 shadow-2xl backdrop-blur transition-all ${collapsed ? "w-11" : "w-56 max-h-[calc(100%-1.5rem)]"}`}
      aria-label="完整工作流图"
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11px] text-zinc-200 hover:bg-zinc-800/80 ${collapsed ? "justify-center" : "border-b border-zinc-800"}`}
        title={collapsed ? `展开完整工作流图；当前：${current.label}` : "折叠完整工作流图"}
        aria-expanded={!collapsed}
      >
        <span className="shrink-0" aria-hidden="true">🔀</span>
        {!collapsed && <span className="font-medium">完整工作流图</span>}
        {!collapsed && <span className="ml-auto text-zinc-500">◀</span>}
      </button>
      {!collapsed && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2.5 py-2.5">
          <div className={`rounded-md border px-2 py-1 text-[9px] leading-4 ${
            isRunning
              ? "border-amber-700/50 bg-amber-950/40 text-amber-200"
              : "border-zinc-800 bg-zinc-900/70 text-zinc-500"
          }`}>
            {isRunning
              ? "AI 正在运行，步骤切换已锁定。等待结束或停止当前任务后再切换。"
              : "点击任意非当前步骤可切换；提交前会再次确认。"}
          </div>
          {WORKFLOW_LANES.map((lane) => (
            <PhaseLane
              key={lane.id}
              lane={lane}
              phases={phases}
              isRunning={isRunning}
              busyPhase={busyPhase}
              onPick={pickPhase}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
