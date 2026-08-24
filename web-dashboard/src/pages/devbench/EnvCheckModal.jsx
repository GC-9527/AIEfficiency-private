/**
 * 环境诊断弹窗 —— 新建故事点前置：
 * 1) 诊断本机编译运行环境（git/java 必需，adb/node 可选），缺则一键安装/引导；
 * 2) 检查对所选仓库的远程拉取权限，无权限弹"联系管理员"（显示管理员钉钉名单）；
 * 3) AI 模型诊断：本机 CLI 是否最新、可见模型清单、一键升级。
 */
import React, { useEffect, useState } from "react";
import { devbenchApi } from "./api.js";
import {
  aiCliNeedsUpgrade,
  aiCliStatusLabel,
  aiCliUpgradeableEngines,
  aiCliUpgradeButtonLabel,
  aiModelDiagHeadline,
  toolAction,
} from "./diaglogic.js";

const MANUAL = {
  git: "https://git-scm.com/download/win",
  java: "https://learn.microsoft.com/java/openjdk/download",
  adb: "https://developer.android.com/tools/releases/platform-tools",
  node: "https://nodejs.org/zh-cn/download",
};

const ACCESS_TRANSPORT_LABELS = {
  https: "HTTPS 凭证",
  ssh: "SSH Key",
  git: "Git",
};

const STATUS_TONE = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-700/40",
  warn: "bg-amber-500/15 text-amber-300 border-amber-700/40",
  muted: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

function ModelChips({ models = [], latestModels = [], currentModel = "" }) {
  if (!models.length) return <div className="text-[11px] text-zinc-600">暂无可选模型清单</div>;
  const latestSet = new Set(latestModels);
  return (
    <div className="flex flex-wrap gap-1.5">
      {models.map((model) => {
        const isLatest = latestSet.has(model);
        const isCurrent = currentModel && model === currentModel;
        return (
          <span
            key={model}
            title={isLatest ? "推荐 / 最新可见" : (isCurrent ? "当前配置" : model)}
            className={`inline-flex items-center gap-1 max-w-full truncate rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition ${
              isCurrent
                ? "border-sky-500/50 bg-sky-500/15 text-sky-200"
                : isLatest
                  ? "border-violet-500/40 bg-violet-500/10 text-violet-200"
                  : "border-zinc-700/80 bg-zinc-950/50 text-zinc-400"
            }`}
          >
            {isLatest && <span className="shrink-0 text-[9px] text-violet-300">新</span>}
            <span className="truncate">{model}</span>
          </span>
        );
      })}
    </div>
  );
}

function AiEngineCard({ engine, upgrading, upgradeProgress, batchMode, expanded, onToggle, onUpgrade }) {
  const label = aiCliStatusLabel(engine.status);
  const tone = STATUS_TONE[label.tone] || STATUS_TONE.muted;
  const needsUpgrade = aiCliNeedsUpgrade(engine);
  const thisBusy = upgrading === engine.id;
  const queued = batchMode && needsUpgrade && !thisBusy && !!upgrading;
  const borderTone = needsUpgrade
    ? "border-amber-700/50 shadow-[0_0_0_1px_rgba(245,158,11,0.08)]"
    : engine.status === "up_to_date"
      ? "border-emerald-800/40"
      : "border-zinc-800/90";

  return (
    <div
      className={`rounded-xl border bg-gradient-to-br from-zinc-900/80 to-zinc-950/90 overflow-hidden transition ${borderTone}`}
      data-testid={`ai-engine-card-${engine.id}`}
      data-status={engine.status}
    >
      <div className="px-3.5 py-3 flex items-start gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 flex items-start gap-3 text-left hover:opacity-95 transition"
        >
          <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold ${
            engine.installed ? "border-emerald-700/40 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 bg-zinc-800 text-zinc-500"
          }`}>
            {engine.id === "claude" ? "Cl" : engine.id === "codex" ? "Cx" : engine.id === "hermes" ? "Hm" : engine.id === "opencode" ? "Oc" : "Gm"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-medium text-zinc-100">{engine.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tone}`}>{label.text}</span>
              {queued && <span className="text-[10px] text-zinc-500">排队中</span>}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500 font-mono flex-wrap">
              <span>本机 {engine.localVersion || "—"}</span>
              <span className="text-zinc-700">→</span>
              <span className={engine.status === "outdated" ? "text-amber-300" : "text-zinc-400"}>
                latest {engine.latestVersion || "—"}
              </span>
            </div>
            {(engine.currentModel || engine.currentTier) && (
              <div className="mt-1 text-[10px] text-zinc-500 truncate">
                当前配置：
                <span className="text-zinc-300 font-mono">{engine.currentModel || "默认"}</span>
                {engine.currentTier ? <span className="text-amber-300/80 font-mono"> · {engine.currentTier}</span> : null}
              </div>
            )}
          </div>
          <span className={`mt-1 text-zinc-600 text-[11px] transition ${expanded ? "rotate-180" : ""}`}>▾</span>
        </button>

        {needsUpgrade && (
          <button
            type="button"
            data-testid={`ai-engine-upgrade-${engine.id}`}
            onClick={(e) => { e.stopPropagation(); onUpgrade(engine.id); }}
            disabled={!!upgrading}
            className={`shrink-0 mt-0.5 inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg font-medium shadow-md disabled:opacity-50 transition ${
              engine.status === "outdated"
                ? "bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-zinc-950 shadow-amber-900/30"
                : "bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-violet-900/30"
            }`}
          >
            {thisBusy ? (
              <>
                <span className="inline-block h-3 w-3 rounded-full border-2 border-zinc-900/30 border-t-zinc-900 animate-spin" />
                升级中…
              </>
            ) : (
              <>↑ {aiCliUpgradeButtonLabel(engine)}</>
            )}
          </button>
        )}
      </div>

      {thisBusy && (
        <div className="px-3.5 pb-3" data-testid={`ai-engine-upgrade-progress-${engine.id}`}>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-violet-500 animate-pulse"
              style={{ width: `${Math.max(12, Math.min(96, upgradeProgress || 35))}%` }}
            />
          </div>
          <div className="mt-1.5 text-[10px] text-amber-200/90">
            正在执行 <code className="text-amber-100/80">{engine.upgradeCmd || `npm i -g ${engine.pkg}@latest`}</code>
            ，通常需要 30 秒～数分钟，请勿关闭面板…
          </div>
        </div>
      )}

      {expanded && (
        <div className="px-3.5 pb-3.5 space-y-3 border-t border-zinc-800/80 bg-black/20">
          <div className="pt-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400">可见模型</span>
              <span className="text-[10px] text-zinc-600">紫色「新」= 推荐最新</span>
            </div>
            <ModelChips
              models={engine.models}
              latestModels={engine.latestModels}
              currentModel={engine.currentModel}
            />
          </div>
          {!!engine.tiers?.length && (
            <div>
              <div className="mb-1.5 text-[11px] text-zinc-400">档位</div>
              <div className="flex flex-wrap gap-1">
                {engine.tiers.map((tier) => (
                  <span
                    key={tier}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                      engine.currentTier === tier
                        ? "border-amber-600/50 bg-amber-500/10 text-amber-200"
                        : "border-zinc-800 text-zinc-500"
                    }`}
                  >
                    {tier}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            {engine.docsUrl && (
              <a
                href={engine.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] px-2 py-1 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
              >
                文档
              </a>
            )}
            {engine.latestError && (
              <span className="text-[10px] text-amber-500/90">{engine.latestError}</span>
            )}
          </div>
          {engine.upgradeCmd && needsUpgrade && (
            <code className="block text-[10px] text-zinc-600 font-mono break-all">手动命令：{engine.upgradeCmd}</code>
          )}
        </div>
      )}
    </div>
  );
}

export default function EnvCheckModal({ repos = [], onClose, onToast }) {
  const [env, setEnv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState("");
  const [installLog, setInstallLog] = useState("");
  // 仓库权限
  const [repoId, setRepoId] = useState(repos[0]?.id || "");
  const [access, setAccess] = useState(null);   // { hasAccess, error }
  const [checkingAcc, setCheckingAcc] = useState(false);
  const [contacts, setContacts] = useState(null);
  // AI 模型诊断
  const [aiDiag, setAiDiag] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiUpgrading, setAiUpgrading] = useState("");
  const [aiUpgradeProgress, setAiUpgradeProgress] = useState(0);
  const [aiUpgradeLog, setAiUpgradeLog] = useState("");
  const [aiBatchNote, setAiBatchNote] = useState("");
  const [aiBatchMode, setAiBatchMode] = useState(false);
  const [expandedEngines, setExpandedEngines] = useState({});

  const runEnv = async () => {
    setLoading(true);
    const r = await devbenchApi.envCheck();
    setLoading(false);
    if (r.ok) setEnv(r.data);
  };
  useEffect(() => { runEnv(); }, []);

  async function install(tool) {
    setInstalling(tool); setInstallLog("");
    const r = await devbenchApi.envInstall(tool);
    setInstalling("");
    setInstallLog((r.output || r.error || "") + (r.hint ? `\n${r.hint}` : ""));
    if (r.ok) { onToast?.(`${tool} 安装完成，重检中…`); await runEnv(); }
    else onToast?.(r.error || "安装失败，请按引导手动安装");
  }

  async function checkAccess() {
    if (!repoId) return;
    setCheckingAcc(true); setAccess(null); setContacts(null);
    const r = await devbenchApi.repoAccess(repoId);
    setCheckingAcc(false);
    if (r.ok) {
      setAccess(r.data);
      if (r.data.hasAccess === false) { const c = await devbenchApi.adminContacts(); if (c.ok) setContacts(c.data || []); }
    } else onToast?.(r.error || "检查失败");
  }

  async function runAiDiag() {
    setAiLoading(true);
    setAiUpgradeLog("");
    setAiBatchNote("");
    const r = await devbenchApi.envAiModels();
    setAiLoading(false);
    if (!r.ok) {
      onToast?.(r.error || "AI 模型诊断失败");
      return;
    }
    setAiDiag(r.data);
    const next = {};
    for (const eng of r.data?.engines || []) {
      if (eng.status === "outdated" || eng.installed) next[eng.id] = true;
    }
    setExpandedEngines(next);
    onToast?.(aiModelDiagHeadline(r.data?.summary) || "AI 模型诊断完成");
  }

  async function upgradeAi(engineId) {
    const engine = (aiDiag?.engines || []).find((e) => e.id === engineId);
    setAiBatchMode(false);
    setAiUpgrading(engineId);
    setAiUpgradeProgress(18);
    setAiUpgradeLog("");
    setAiBatchNote(`正在升级 ${engine?.name || engineId}…`);
    const tick = setInterval(() => {
      setAiUpgradeProgress((p) => (p >= 88 ? 88 : p + 6));
    }, 1200);
    const r = await devbenchApi.envAiUpgrade(engineId);
    clearInterval(tick);
    setAiUpgradeProgress(100);
    setAiUpgrading("");
    setAiBatchNote("");
    setAiUpgradeLog((r.output || r.error || "") + (r.hint ? `\n${r.hint}` : ""));
    if (r.ok) {
      onToast?.(`${engine?.name || engineId} 已升级到最新，重新诊断中…`);
      await runAiDiag();
    } else {
      onToast?.(r.error || "升级失败，可复制命令手动执行");
    }
    setAiUpgradeProgress(0);
  }

  async function upgradeAllAi() {
    const list = aiCliUpgradeableEngines(aiDiag?.engines);
    if (!list.length || aiUpgrading) return;
    setAiBatchMode(true);
    setAiUpgradeLog("");
    const lines = [];
    let okCount = 0;
    for (let i = 0; i < list.length; i += 1) {
      const eng = list[i];
      setAiUpgrading(eng.id);
      setAiUpgradeProgress(12);
      setAiBatchNote(`批量升级 ${i + 1}/${list.length}：${eng.name}`);
      const tick = setInterval(() => {
        setAiUpgradeProgress((p) => (p >= 88 ? 88 : p + 5));
      }, 1200);
      const r = await devbenchApi.envAiUpgrade(eng.id);
      clearInterval(tick);
      setAiUpgradeProgress(100);
      lines.push(`## ${eng.name}\n${r.ok ? "✓ 成功" : "✗ 失败"}\n${r.output || r.error || ""}`);
      if (r.ok) okCount += 1;
      else onToast?.(`${eng.name} 升级失败`);
    }
    setAiUpgrading("");
    setAiUpgradeProgress(0);
    setAiBatchMode(false);
    setAiBatchNote("");
    setAiUpgradeLog(lines.join("\n\n"));
    onToast?.(okCount === list.length
      ? `已全部升级（${okCount}/${list.length}），重新诊断中…`
      : `完成 ${okCount}/${list.length} 项升级，重新诊断中…`);
    await runAiDiag();
  }

  const summary = aiDiag?.summary;
  const headline = aiModelDiagHeadline(summary);
  const upgradeable = aiCliUpgradeableEngines(aiDiag?.engines);
  const outdatedOnly = upgradeable.filter((e) => e.status === "outdated");

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70" onClick={onClose} data-testid="env-check-modal">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[720px] max-h-[90vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">🩺 环境诊断</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">检查本机编译环境、仓库权限与 AI 模型版本，缺啥补啥。</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 1. 环境诊断 */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] font-medium text-zinc-200">① 本机环境</span>
              {env && (env.okToCompile
                ? <span className="text-[11px] text-emerald-400">✓ 可正常编译运行</span>
                : <span className="text-[11px] text-red-400">✗ 缺少必需环境</span>)}
              <button onClick={runEnv} disabled={loading} className="ml-auto text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200">{loading ? "检测中…" : "↻ 重新检测"}</button>
            </div>
            {env?.results?.map((t) => (
              <div key={t.key} className="flex items-center gap-2 py-1 border-b border-zinc-800/60">
                <span className={`text-[11px] w-4 ${t.installed ? "text-emerald-400" : "text-red-400"}`}>{t.installed ? "✓" : "✗"}</span>
                <span className="text-[12px] text-zinc-200">{t.name}</span>
                {t.required && <span className="text-[9px] text-amber-400 border border-amber-700/40 rounded px-1">必需</span>}
                <span className="flex-1 text-[10px] text-zinc-600 font-mono truncate">{t.version}</span>
                {toolAction(t, env?.hasWinget) === "install" &&
                  <button onClick={() => install(t.key)} disabled={!!installing} className="text-[11px] px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">{installing === t.key ? "安装中…" : "一键安装"}</button>}
                {toolAction(t, env?.hasWinget) === "manual" &&
                  <a href={MANUAL[t.key]} target="_blank" rel="noreferrer" className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-blue-300 hover:text-blue-200">手动下载</a>}
              </div>
            ))}
            {env && !env.hasWinget && env.results.some((t) => !t.installed) && (
              <p className="text-[10px] text-amber-500/80 mt-1.5">本机无 winget，无法自动安装。请点「手动下载」安装后，把可执行目录加入 PATH（Java 还需设 JAVA_HOME），并<strong>重启网关</strong>，再「重新检测」。</p>
            )}
            {installLog && <pre className="mt-2 text-[10px] text-zinc-400 bg-zinc-950/60 border border-zinc-800 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">{installLog}</pre>}
          </div>

          {/* 2. 仓库拉取权限 */}
          <div className="pt-3 border-t border-zinc-800">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] font-medium text-zinc-200">② 仓库拉取权限</span>
            </div>
            <div className="flex items-center gap-2">
              <select value={repoId} onChange={(e) => { setRepoId(e.target.value); setAccess(null); setContacts(null); }}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[12px] text-zinc-200 outline-none"
                data-testid="repo-access-repository">
                {!repos.length && <option value="">无仓库</option>}
                {repos.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button onClick={checkAccess} disabled={checkingAcc || !repoId} className="px-2.5 py-1 text-[12px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 disabled:opacity-50" data-testid="repo-access-check">{checkingAcc ? "检查中…" : "检查权限"}</button>
            </div>
            {access && (access.needsLocalGateway
              ? (
                <div className="mt-2 rounded-lg border border-amber-700/40 bg-amber-900/15 px-3 py-2.5" data-testid="repo-access-local-gateway-required">
                  <div className="text-[12px] font-medium text-amber-300">暂时无法判断这台电脑的仓库权限</div>
                  <div className="mt-1 text-[11px] leading-5 text-zinc-400">
                    {access.error || "当前页面无法连接这台电脑的本机 Gateway，因而不能读取本机 Git 凭证。"}
                    {" "}远端服务端的 SSH 结果不能代表你的电脑。
                    请先启动本机 Gateway，并在
                    <a href="/settings" className="mx-1 text-blue-300 underline hover:text-blue-200">设置</a>
                    中将本地网关填为 <code className="text-zinc-300">{access.localGatewayUrl || "http://127.0.0.1:3001"}</code>，然后重新检查。
                  </div>
                </div>
              )
              : access.hasAccess
              ? (
                <div className="mt-2 text-[12px] text-emerald-400" data-testid="repo-access-success">
                  ✓ 有拉取权限
                  {access.transport && <span className="ml-1 text-emerald-500/80">（已通过 {ACCESS_TRANSPORT_LABELS[access.transport] || access.transport} 验证）</span>}
                </div>
              )
              : (
                <div className="mt-2 px-3 py-2.5 rounded-lg bg-red-900/15 border border-red-800/40" data-testid="repo-access-denied">
                  <div className="text-[12px] text-red-300 mb-1.5">✗ 已在这台电脑上检查可用的 Git 协议，均无法拉取该仓库。请联系管理员开通 Codeup/Git 仓库权限，或检查 HTTPS 凭证与 SSH Key。</div>
                  {access.error && <div className="text-[10px] leading-4 text-zinc-500 font-mono mb-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all">{access.error}</div>}
                  {contacts && (
                    <div>
                      <div className="text-[11px] text-zinc-400 mb-1">管理员（钉钉联系）：</div>
                      {contacts.length ? contacts.map((c) => (
                        <div key={c.dingUserid} className="text-[12px] text-zinc-200 flex items-center gap-2 py-0.5">
                          <span>👤 {c.name}</span>
                          <span className="text-[10px] text-zinc-600 font-mono">{c.dingUserid}</span>
                        </div>
                      )) : <div className="text-[11px] text-zinc-600">暂无管理员（请联系超级管理员在管理后台添加）</div>}
                    </div>
                  )}
                </div>
              ))}
          </div>

          {/* 3. AI 模型诊断 */}
          <div className="pt-3 border-t border-zinc-800" data-testid="ai-model-diag-section">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[12px] font-medium text-zinc-200">③ AI 模型</span>
              {summary && (
                <span className={`text-[11px] ${summary.anyOutdated ? "text-amber-300" : summary.allLatest ? "text-emerald-400" : "text-zinc-400"}`}>
                  {headline}
                </span>
              )}
              <button
                type="button"
                onClick={runAiDiag}
                disabled={aiLoading || !!aiUpgrading}
                data-testid="ai-model-diag-btn"
                className="ml-auto inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-900/30 disabled:opacity-50 transition"
              >
                {aiLoading ? (
                  <>
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    诊断中…
                  </>
                ) : (
                  <>✦ 诊断 AI 模型</>
                )}
              </button>
            </div>

            {!aiDiag && !aiLoading && (
              <div className="rounded-xl border border-dashed border-zinc-700/80 bg-zinc-950/40 px-4 py-5 text-center">
                <div className="text-[12px] text-zinc-300">检查 Claude / Codex / Gemini / Hermes 的本机状态</div>
                <div className="mt-1 text-[11px] text-zinc-500 leading-5">
                  同时展示各引擎可见的最新模型与档位，方便在故事点里选用。
                </div>
              </div>
            )}

            {aiLoading && !aiDiag && (
              <div className="rounded-xl border border-violet-800/40 bg-violet-950/20 px-4 py-6 text-center">
                <div className="mx-auto mb-2 h-5 w-5 rounded-full border-2 border-violet-400/30 border-t-violet-300 animate-spin" />
                <div className="text-[12px] text-violet-200">正在探测本机 CLI 并查询 npm latest…</div>
                <div className="mt-1 text-[10px] text-zinc-500">通常需要几秒，请稍候</div>
              </div>
            )}

            {aiDiag && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { k: "已装", v: summary?.installed ?? 0, c: "text-zinc-200" },
                    { k: "最新", v: summary?.upToDate ?? 0, c: "text-emerald-300" },
                    { k: "可升级", v: summary?.outdated ?? 0, c: "text-amber-300" },
                    { k: "未装", v: summary?.missing ?? 0, c: "text-zinc-500" },
                  ].map((item) => (
                    <div key={item.k} className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-2 py-2 text-center">
                      <div className={`text-sm font-semibold tabular-nums ${item.c}`}>{item.v}</div>
                      <div className="text-[10px] text-zinc-600">{item.k}</div>
                    </div>
                  ))}
                </div>

                {!!upgradeable.length && (
                  <div
                    className="rounded-xl border devbench-status-surface devbench-status-surface--warning px-3.5 py-3 flex items-center gap-3 flex-wrap"
                    data-testid="ai-upgrade-banner"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-amber-100">
                        {outdatedOnly.length
                          ? `${outdatedOnly.length} 个 CLI 不是最新版`
                          : `${upgradeable.length} 个 CLI 可安装最新版`}
                      </div>
                      <div className="mt-0.5 text-[11px] text-amber-200/70 leading-5">
                        {aiBatchNote || "点击右侧一键升级，或在各引擎卡片上单独升级。完成后会自动重新诊断。"}
                      </div>
                    </div>
                    <button
                      type="button"
                      data-testid="ai-upgrade-all-btn"
                      onClick={upgradeAllAi}
                      disabled={!!aiUpgrading || aiLoading}
                      className="shrink-0 inline-flex items-center gap-1.5 text-[11px] px-3.5 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-zinc-950 font-semibold shadow-lg shadow-amber-900/25 disabled:opacity-50 transition"
                    >
                      {aiUpgrading ? (
                        <>
                          <span className="inline-block h-3 w-3 rounded-full border-2 border-zinc-900/30 border-t-zinc-900 animate-spin" />
                          升级中…
                        </>
                      ) : (
                        <>↑ 一键升级全部（{upgradeable.length}）</>
                      )}
                    </button>
                  </div>
                )}

                {(aiDiag.engines || []).map((engine) => (
                  <AiEngineCard
                    key={engine.id}
                    engine={engine}
                    upgrading={aiUpgrading}
                    upgradeProgress={aiUpgradeProgress}
                    batchMode={aiBatchMode}
                    expanded={!!expandedEngines[engine.id]}
                    onToggle={() => setExpandedEngines((prev) => ({ ...prev, [engine.id]: !prev[engine.id] }))}
                    onUpgrade={upgradeAi}
                  />
                ))}

                {!!aiDiag.apiEngines?.length && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3.5 py-3">
                    <div className="mb-2 text-[11px] text-zinc-400">API 引擎可见模型</div>
                    <div className="space-y-2.5">
                      {aiDiag.apiEngines.map((api) => (
                        <div key={api.id}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[12px] text-zinc-200">{api.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                              api.status === "configured"
                                ? "border-emerald-700/40 text-emerald-300 bg-emerald-500/10"
                                : "border-zinc-700 text-zinc-500"
                            }`}>
                              {api.status === "configured" ? "已配置" : api.status === "disabled" ? "未启用" : "缺 Key"}
                            </span>
                            {api.model && <span className="text-[10px] font-mono text-zinc-500 truncate">当前 {api.model}</span>}
                          </div>
                          <ModelChips models={api.availableModels} latestModels={api.latestModels} currentModel={api.model} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {aiUpgradeLog && (
                  <pre className="text-[10px] text-zinc-400 bg-zinc-950/60 border border-zinc-800 rounded-lg p-2 max-h-32 overflow-auto whitespace-pre-wrap">{aiUpgradeLog}</pre>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">完成</button>
        </div>
      </div>
    </div>
  );
}
