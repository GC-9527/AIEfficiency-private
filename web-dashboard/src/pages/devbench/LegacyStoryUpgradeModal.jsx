import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { devbenchApi } from "./api.js";
import {
  formatMigrationBytes,
  legacyUpgradeActionState,
  legacyUpgradeBlockerGuidance,
  legacyUpgradeSummary,
} from "./legacyStoryUpgradeModel.mjs";

const STEPS = [
  { title: "检查旧工作区", note: "确认分支、改动、冲突与 stash" },
  { title: "准备受管独立仓", note: "新建或核对 Controller 登记路径" },
  { title: "保留当前代码", note: "迁移旧快照；已有独立仓不复制" },
  { title: "核验 Worker ACL", note: "完成身份与权限指纹证明" },
];

function shortPath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-3).join("/") || "—";
}

function projectKind(project) {
  if (project.kind === "legacy-snapshot") {
    const count = Number(project.dirtyTrackedCount || 0) + Number(project.untrackedCount || 0);
    return count ? `迁移快照 · ${count} 项本地改动` : "迁移旧分支快照";
  }
  if (project.kind === "independent-attestation-refresh") {
    return "复用现有独立仓 · 刷新 ACL 证明";
  }
  if (project.kind === "legacy-worktree") {
    return "等待 Controller 检查旧工作区";
  }
  return "从受管基线新建";
}

export default function LegacyStoryUpgradeModal({
  tab,
  open,
  onClose,
  onUpgraded,
  onToast,
}) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [blockerGuideOpen, setBlockerGuideOpen] = useState(false);

  async function loadPreview() {
    if (!tab?.id) return;
    setLoading(true);
    setError("");
    setDone(false);
    setProgressStep(0);
    setBlockerGuideOpen(false);
    try {
      const result = await devbenchApi.previewLegacyStoryUpgrade(tab.id);
      const data = result?.data || null;
      setPreview(data);
      if (!data) setError(result?.error || "无法读取旧工作区检查结果");
    } catch (requestError) {
      setError(requestError?.message || "旧工作区检查失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadPreview();
  }, [open, tab?.id]);

  useEffect(() => {
    if (!upgrading) return undefined;
    const timer = setInterval(() => {
      setProgressStep((current) => Math.min(2, current + 1));
    }, 1100);
    return () => clearInterval(timer);
  }, [upgrading]);

  const summary = useMemo(() => legacyUpgradeSummary(preview), [preview]);
  const refreshOnlyCount = useMemo(
    () => (preview?.projects || []).filter(
      (project) => project.kind === "independent-attestation-refresh",
    ).length,
    [preview],
  );
  const hasLegacySnapshot = summary.snapshotCount > 0;
  const blockerGuidance = useMemo(
    () => legacyUpgradeBlockerGuidance(preview),
    [preview],
  );
  const action = legacyUpgradeActionState(preview, { loading, upgrading });

  async function upgrade() {
    if (action.mode === "explain") {
      setBlockerGuideOpen(true);
      return;
    }
    if (!action.ready || !tab?.id) return;
    setUpgrading(true);
    setError("");
    setProgressStep(1);
    try {
      const result = await devbenchApi.upgradeLegacyStory(tab.id, preview.previewToken);
      if (!result?.ok) {
        if (result?.data) setPreview(result.data);
        setError(result?.error || "旧版故事点升级失败");
        return;
      }
      setProgressStep(4);
      setDone(true);
      await onUpgraded?.(result.data?.tab);
      onToast?.("旧版故事点已升级，输入内容仍保留，可以继续发送");
    } catch (requestError) {
      setError(requestError?.message || "旧版故事点升级失败");
    } finally {
      setUpgrading(false);
    }
  }

  if (!open) return null;
  const modal = (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 py-6"
      data-testid="legacy-story-upgrade-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !upgrading) onClose?.();
      }}
    >
      <div className="flex w-[760px] max-w-[96vw] max-h-[92vh] flex-col overflow-hidden rounded-2xl border border-indigo-400/25 bg-zinc-950 shadow-[0_28px_100px_rgba(0,0,0,0.65)]">
        <div className="relative shrink-0 overflow-hidden border-b border-zinc-800 px-6 py-5">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.22),transparent_48%),radial-gradient(circle_at_bottom_left,rgba(14,165,233,0.12),transparent_42%)]" />
          <div className="relative flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-indigo-400/30 bg-indigo-500/15 text-xl shadow-inner">
              ↗
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-50">升级旧版故事点工作区</h2>
                <span className="rounded-full border border-sky-400/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-200">
                  一次升级，后续自动兼容
                </span>
              </div>
              <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-zinc-400">
                这个故事点创建于新规则上线之前。旧 linked worktree 会无损迁入 Controller
                管理的独立仓；已有独立仓只原位刷新 Worker ACL 证明。聊天、材料和输入草稿都不会丢失。
              </p>
              <p className="mt-2 truncate text-[11px] text-zinc-500" title={tab?.title || ""}>
                {tab?.title || "当前故事点"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => !upgrading && onClose?.()}
              disabled={upgrading}
              className="rounded-lg px-2 py-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-wait disabled:opacity-40"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-4 gap-2">
            {STEPS.map((step, index) => {
              const stepNumber = index + 1;
              const active = done
                || (!upgrading && !!preview && stepNumber === 1)
                || progressStep > stepNumber;
              const current = upgrading && progressStep === stepNumber;
              return (
                <div
                  key={step.title}
                  className={`rounded-xl border px-3 py-3 transition ${
                    active
                      ? "border-emerald-400/30 bg-emerald-500/10"
                      : current
                        ? "border-indigo-400/40 bg-indigo-500/10"
                        : "border-zinc-800 bg-zinc-900/60"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                      active ? "bg-emerald-400 text-emerald-950" : "bg-zinc-800 text-zinc-400"
                    }`}>
                      {active ? "✓" : stepNumber}
                    </span>
                    <span className="text-[11px] font-medium text-zinc-200">{step.title}</span>
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">{step.note}</p>
                </div>
              );
            })}
          </div>

          {loading ? (
            <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-5 py-8 text-center">
              <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
              <p className="mt-3 text-[12px] text-zinc-300">正在由 Controller 检查旧工作区…</p>
              <p className="mt-1 text-[10px] text-zinc-500">只读检查，不会修改现有代码</p>
            </div>
          ) : preview ? (
            <>
              <div className="mt-5 grid grid-cols-4 gap-2">
                {[
                  ["工程", summary.projectCount, "个"],
                  ["旧快照", summary.snapshotCount, "份"],
                  ["已改文件", summary.changedFileCount, "项"],
                  ["未跟踪", summary.untrackedCount, "项"],
                ].map(([label, value, unit]) => (
                  <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3">
                    <div className="text-[10px] text-zinc-500">{label}</div>
                    <div className="mt-1 text-lg font-semibold text-zinc-100">
                      {value}<span className="ml-1 text-[10px] font-normal text-zinc-500">{unit}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 space-y-2">
                {(preview.projects || []).map((project, index) => {
                  const inspectionPending = project.inspectionPending === true;
                  const projectReady = project.canMigrate === true;
                  return (
                    <div
                      key={`${project.repositoryId || project.basePath}-${index}`}
                      className={`rounded-xl border px-4 py-3 ${
                        inspectionPending
                          ? "border-amber-400/25 bg-amber-950/10"
                          : projectReady
                            ? "border-zinc-800 bg-zinc-900/55"
                            : "border-red-500/30 bg-red-950/15"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] ${
                          inspectionPending
                            ? "bg-amber-500/15 text-amber-200"
                            : projectReady
                              ? "bg-indigo-500/15 text-indigo-200"
                              : "bg-red-500/15 text-red-200"
                        }`}>
                          {inspectionPending ? "…" : projectReady ? "✓" : "!"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[12px] font-medium text-zinc-200">{project.name}</span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] uppercase text-zinc-500">
                              {project.role}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
                            <span>{projectKind(project)}</span>
                            {project.sourceBranch && <span>旧分支 {project.sourceBranch}</span>}
                            {!!project.changedBytes && <span>{formatMigrationBytes(project.changedBytes)}</span>}
                          </div>
                        </div>
                        <div className="max-w-[220px] truncate text-right font-mono text-[9px] text-zinc-600" title={project.sourcePath || project.basePath}>
                          {shortPath(project.sourcePath || project.basePath)}
                        </div>
                      </div>
                      {!!project.changedFiles?.length && (
                        <div className="mt-2 truncate rounded-lg bg-black/20 px-2.5 py-1.5 font-mono text-[9px] text-zinc-500">
                          {project.changedFiles.slice(0, 6).join(" · ")}
                          {project.changedFiles.length > 6 ? ` · +${project.changedFiles.length - 6}` : ""}
                        </div>
                      )}
                      {!!project.blockers?.length && (
                        <div className="mt-2 space-y-1">
                          {project.blockers.map((blocker) => (
                            <div key={`${blocker.code}-${blocker.message}`} className="text-[10px] leading-relaxed text-red-300">
                              {blocker.message}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {!!blockerGuidance.length && (
                <div
                  className="mt-4 rounded-xl border border-amber-400/25 bg-amber-950/15 px-4 py-3"
                  data-testid="legacy-story-upgrade-blockers"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-[12px] text-amber-200">!</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-amber-100">
                        升级前还需完成 {blockerGuidance.length} 项准备
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-amber-100/60">
                        旧工作区尚未被修改。点击下方主按钮可查看处理顺序，安全校验不会被绕过。
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {blockerGuidance.map((guide, index) => (
                      <div key={guide.key} className="rounded-lg border border-amber-400/10 bg-black/15 px-3 py-2">
                        <div className="flex items-center gap-2 text-[11px] text-amber-100">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400/15 text-[9px]">{index + 1}</span>
                          <span className="font-medium">{guide.title}</span>
                        </div>
                        {blockerGuideOpen && (
                          <p className="mt-1.5 pl-6 text-[10px] leading-relaxed text-zinc-400">
                            {guide.detail}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  {blockerGuideOpen && (
                    <p className="mt-3 rounded-lg bg-black/20 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
                      完成部署或运行条件后点击“重新检查”。只有预览变为可升级状态时，主按钮才会执行仓库迁移。
                    </p>
                  )}
                </div>
              )}

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/5 px-4 py-3">
                  <div className="text-[11px] font-medium text-emerald-200">会保留</div>
                  <p className="mt-1 text-[10px] leading-relaxed text-emerald-100/60">
                    聊天与材料、旧目录、当前代码文件、未提交与未跟踪内容。
                  </p>
                </div>
                <div className="rounded-xl border border-sky-400/20 bg-sky-500/5 px-4 py-3">
                  <div className="text-[11px] font-medium text-sky-200">会升级</div>
                  <p className="mt-1 text-[10px] leading-relaxed text-sky-100/60">
                    {hasLegacySnapshot
                      ? "旧 linked worktree 的最终代码以待提交快照进入新仓，并补齐 ACL 证明。"
                      : refreshOnlyCount
                        ? "开发目录保持不变，只刷新 Controller 登记与 Worker ACL 证明，不复制或覆盖代码。"
                        : "按 Controller 受管基线创建独立仓，并补齐 Worker ACL 证明。"}
                  </p>
                </div>
              </div>
            </>
          ) : null}

          {error && (
            <div className="mt-4 rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3">
              <div className="text-[11px] font-medium text-red-200">暂时无法完成升级</div>
              <p className="mt-1 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-red-300/80">{error}</p>
            </div>
          )}

          {done && (
            <div className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-100">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-emerald-950">✓</span>
                升级完成，可以继续发送
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-emerald-100/65">
                {hasLegacySnapshot
                  ? "输入框中的消息与附件仍在原位。旧工作区没有删除，新独立仓已通过 Worker ACL 校验。"
                  : "输入框中的消息与附件仍在原位。开发目录未复制、未覆盖，现有独立仓已刷新 Worker ACL 证明。"}
              </p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-zinc-800 bg-zinc-950/95 px-6 py-4">
          <div className="min-w-0 flex-1 text-[10px] text-zinc-500">
            {upgrading
              ? "正在升级，请勿关闭窗口或修改旧工作区…"
              : done
                ? "升级只需执行一次"
                : action.ready
                  ? "确认后由 Controller 原子执行；失败不会删除旧目录"
                  : blockerGuideOpen
                    ? "前置条件处理完成后点击重新检查"
                    : "主按钮可点击查看升级前置条件，不会绕过安全校验"}
          </div>
          {!done && (
            <button
              type="button"
              onClick={loadPreview}
              disabled={loading || upgrading}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-300 transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-40"
            >
              {loading ? "检查中…" : "重新检查"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={upgrading}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-300 transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-40"
          >
            {done ? "稍后发送" : "取消"}
          </button>
          {done ? (
            <button
              type="button"
              autoFocus
              onClick={() => onClose?.()}
              data-testid="legacy-story-upgrade-done"
              className="rounded-lg border border-emerald-400/30 bg-emerald-500 px-4 py-2 text-[11px] font-medium text-emerald-950 shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-400"
            >
              回到输入框继续发送
            </button>
          ) : (
            <button
              type="button"
              onClick={upgrade}
              disabled={action.disabled}
              aria-expanded={action.mode === "explain" ? blockerGuideOpen : undefined}
              data-testid="legacy-story-upgrade-confirm"
              className="rounded-lg border border-indigo-400/30 bg-indigo-500 px-4 py-2 text-[11px] font-medium text-white shadow-lg shadow-indigo-950/30 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
