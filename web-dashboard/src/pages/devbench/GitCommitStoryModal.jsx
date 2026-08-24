import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildGitCommitStoryConfirmation,
  buildGitCommitStoryRequest,
  filterGitRepositories,
  gitCommitLocalSourceValue,
  gitRepositoryDisplayUrl,
  gitRepositoryLabel,
  resolveGitRepositoryInput,
  validateGitCommitRevision,
} from "./gitCommitStoryModel.mjs";

const TYPE_LABEL = {
  application: "应用",
  sdk: "SDK",
  tooling: "工具",
  service: "服务",
  repository: "仓库",
};

export default function GitCommitStoryModal({
  projectDefs = [],
  localProjects = [],
  projectId = "",
  onClose,
  onPreview,
  onSubmit,
  embedded = false,
  onBusyChange,
}) {
  const [revision, setRevision] = useState("");
  const [repositoryValue, setRepositoryValue] = useState("");
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [sourceMode, setSourceMode] = useState("");
  const [localSourceValue, setLocalSourceValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revisionRef = useRef(null);
  const repositoryBoxRef = useRef(null);
  const parsedRevision = validateGitCommitRevision(revision);
  const filteredRepositories = useMemo(
    () => filterGitRepositories(projectDefs, repositoryValue).slice(0, 20),
    [projectDefs, repositoryValue],
  );
  const selectedRepository = projectDefs.find((repository) => repository.id === selectedRepositoryId) || null;
  const repositorySelection = resolveGitRepositoryInput(
    projectDefs,
    repositoryValue,
    selectedRepositoryId,
  );
  const localSources = useMemo(() => (Array.isArray(localProjects) ? localProjects : [])
    .filter((project) => project?.exists !== false && project?.id)
    .flatMap((project) => [
      {
        projectId: project.id,
        name: project.name || project.id,
        role: "primary",
        currentBranch: project.branch || "",
        hasWebApp: !!project.webAppPath,
      },
      ...(project.webAppPath ? [{
        projectId: project.id,
        name: `${project.name || project.id}/WebApp`,
        role: "webapp",
        currentBranch: project.webAppBranch || "",
        hasWebApp: true,
      }] : []),
    ]), [localProjects]);
  const selectedLocalSource = localSources.find(
    (source) => gitCommitLocalSourceValue(source) === localSourceValue,
  ) || null;

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    revisionRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        // 该面板承载两项不可恢复的输入。Escape 只收起仓库候选，
        // 面板本身必须由右上角关闭图标或创建成功后关闭。
        setRepositoryOpen(false);
      }
    };
    const onPointerDown = (event) => {
      if (repositoryBoxRef.current && !repositoryBoxRef.current.contains(event.target)) {
        setRepositoryOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  function selectRepository(repository) {
    setSelectedRepositoryId(repository.id);
    setRepositoryValue(gitRepositoryDisplayUrl(repository) || gitRepositoryLabel(repository));
    setRepositoryOpen(false);
    setPreview(null);
    setSourceMode("");
    setLocalSourceValue("");
    setError("");
  }

  async function submit(event) {
    event?.preventDefault?.();
    const request = buildGitCommitStoryRequest({
      revision,
      repositoryValue,
      selectedRepositoryId,
      projectDefs,
      projectId,
    });
    if (!request.ok) {
      setError(request.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const confirmation = buildGitCommitStoryConfirmation({
        requestBody: request.body,
        sourceMode,
        localSource: selectedLocalSource,
      });
      if (!confirmation.ok) {
        setError(confirmation.error);
        return;
      }
      if (!preview) {
        const result = await onPreview?.(confirmation.body);
        if (!result?.ok) {
          setError(result?.error || "commit 解析失败，请检查仓库、revision 和访问权限");
          return;
        }
        if (result.inferenceStarted) {
          onClose?.();
          return;
        }
        if (result.existing && result.data?.id) {
          onClose?.();
          return;
        }
        const nextPreview = result.data || null;
        if (!nextPreview?.commit || !Array.isArray(nextPreview?.localSources)) {
          setError("commit 已解析，但预设置数据不完整，请刷新后重试");
          return;
        }
        setPreview(nextPreview);
        return;
      }

      const result = await onSubmit?.(confirmation.body);
      if (!result?.ok) {
        setError(result?.error || "评审故事点创建失败，请检查预设置工程和访问权限");
        return;
      }
      onClose?.();
    } catch (submitError) {
      setError(submitError?.message || (preview ? "创建失败，请稍后重试" : "解析失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  const form = (
      <form
        onSubmit={submit}
        className={embedded
          ? "relative overflow-visible"
          : "relative z-10 w-[620px] max-w-[96vw] overflow-visible rounded-2xl border border-violet-400/25 bg-zinc-950 shadow-[0_36px_120px_rgba(0,0,0,0.78)]"}
        onClick={(event) => event.stopPropagation()}
        data-testid={embedded ? "git-commit-story-embedded" : undefined}
      >
        {!embedded && (
          <>
            <div className="pointer-events-none absolute -left-24 -top-28 h-64 w-64 rounded-full bg-violet-500/15 blur-[80px]" />
            <div className="pointer-events-none absolute -right-20 top-16 h-52 w-52 rounded-full bg-cyan-500/10 blur-[70px]" />
          </>
        )}

        <div className={`relative overflow-hidden border-b border-zinc-800 px-6 pb-5 pt-6 ${embedded ? "" : "rounded-t-2xl"}`}>
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-300/30 bg-gradient-to-br from-violet-500/25 to-fuchsia-500/10 font-mono text-sm font-semibold text-violet-100 shadow-inner">
              &lt;/&gt;
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <h2 id="git-commit-story-title" className="text-base font-semibold text-zinc-50">
                  从 Git commit 创建评审故事点
                </h2>
                <span className="rounded-full border border-violet-400/25 bg-violet-500/10 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.14em] text-violet-200">
                  Read-only review
                </span>
              </div>
              <p className="max-w-[480px] text-[12px] leading-relaxed text-zinc-400">
                解析 commit 所在分支与改动路径，结合车型源码映射自动配置主工程、Flavor 和依赖工程。
              </p>
            </div>
            {!embedded && (
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
                aria-label="关闭"
                data-testid="git-commit-story-close"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="relative space-y-5 px-6 py-5">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="git-commit-revision" className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">
                Commit revision number
              </label>
              {revision && parsedRevision.ok && (
                <span className="text-[10px] text-emerald-400">✓ {parsedRevision.preview}</span>
              )}
            </div>
            <div className={`flex items-center gap-3 rounded-xl border bg-zinc-900/80 px-3 transition ${
              revision && !parsedRevision.ok
                ? "border-red-500/55 ring-2 ring-red-500/10"
                : "border-zinc-700 focus-within:border-violet-400/70 focus-within:ring-2 focus-within:ring-violet-500/10"
            }`}>
              <span className="font-mono text-xs text-violet-300">#</span>
              <input
                id="git-commit-revision"
                ref={revisionRef}
                value={revision}
                onChange={(event) => {
                  setRevision(event.target.value.replace(/\s+/g, ""));
                  setPreview(null);
                  setSourceMode("");
                  setLocalSourceValue("");
                  setError("");
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck="false"
                placeholder="例如 a1b2c3d4e5f6，支持短 SHA / 完整 SHA"
                className="min-w-0 flex-1 bg-transparent py-3 font-mono text-sm text-zinc-100 outline-none placeholder:font-sans placeholder:text-zinc-600 disabled:opacity-60"
                data-testid="git-commit-revision"
              />
              {revision && (
                <button
                  type="button"
                  onClick={() => {
                    setRevision("");
                    setPreview(null);
                    setSourceMode("");
                    setLocalSourceValue("");
                  }}
                  disabled={busy}
                  className="rounded px-1.5 py-0.5 text-[10px] text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
                >
                  清空
                </button>
              )}
            </div>
          </div>

          <div ref={repositoryBoxRef} className="relative">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="git-commit-repository" className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">
                Git 仓库地址
              </label>
              {selectedRepository && (
                <span className="max-w-[320px] truncate text-[10px] text-cyan-300">
                  {gitRepositoryLabel(selectedRepository)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 transition focus-within:border-cyan-400/65 focus-within:ring-2 focus-within:ring-cyan-500/10">
              <span className="text-xs text-cyan-300">⌘</span>
              <input
                id="git-commit-repository"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={repositoryOpen}
                value={repositoryValue}
                onFocus={() => setRepositoryOpen(true)}
                onChange={(event) => {
                  setRepositoryValue(event.target.value);
                  setSelectedRepositoryId("");
                  setRepositoryOpen(true);
                  setPreview(null);
                  setSourceMode("");
                  setLocalSourceValue("");
                  setError("");
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck="false"
                placeholder="输入仓库名、ID、HTTPS 或 SSH 地址进行选择"
                className="min-w-0 flex-1 bg-transparent py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-60"
                data-testid="git-commit-repository"
              />
              <button
                type="button"
                onClick={() => setRepositoryOpen((open) => !open)}
                disabled={busy}
                className="rounded px-1.5 py-0.5 text-xs text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                aria-label="展开仓库列表"
              >
                {repositoryOpen ? "⌃" : "⌄"}
              </button>
            </div>
            {repositoryOpen && (
              <div
                role="listbox"
                className="absolute left-0 right-0 z-[155] mt-2 max-h-64 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900/98 p-1.5 shadow-[0_24px_60px_rgba(0,0,0,0.72)] backdrop-blur"
                data-testid="git-repository-options"
              >
                {filteredRepositories.length ? filteredRepositories.map((repository) => (
                  <button
                    key={repository.id}
                    type="button"
                    role="option"
                    aria-selected={repository.id === selectedRepositoryId}
                    onClick={() => selectRepository(repository)}
                    className={`group flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                      repository.id === selectedRepositoryId
                        ? "bg-violet-500/15 text-violet-100"
                        : "text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-950 text-[11px] text-zinc-400 group-hover:border-cyan-500/30 group-hover:text-cyan-200">
                      Git
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium">{gitRepositoryLabel(repository)}</span>
                        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-500">
                          {TYPE_LABEL[repository.projectType] || repository.projectType || "工程"}
                        </span>
                      </span>
                      <span className="mt-1 block truncate font-mono text-[10px] text-zinc-600 group-hover:text-zinc-500">
                        {gitRepositoryDisplayUrl(repository) || "未配置 Git 地址"}
                      </span>
                    </span>
                  </button>
                )) : (
                  <div className="px-3 py-5 text-center text-[11px] text-zinc-500">
                    没有匹配的已配置仓库
                  </div>
                )}
              </div>
            )}
          </div>

          <section
            className="rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.06] via-zinc-900/65 to-violet-500/[0.06] p-4"
            data-testid="git-commit-story-preset"
          >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-zinc-100">创建前预设置</div>
                  <div className="mt-1 truncate font-mono text-[10px] text-zinc-500">
                    {preview
                      ? `${preview.commit?.shortRevision || preview.commit?.revision?.slice(0, 12)} · ${preview.commit?.subject || "未命名提交"}`
                      : "先指定本地工程或远程拉取；解析后直接进入初始化配置，AI 在面板中并发推理"}
                  </div>
                </div>
                <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-300">
                  尚未创建故事点
                </span>
              </div>

              {preview ? <div className="mt-3 grid gap-2 text-[10px] sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/45 px-2.5 py-2">
                  <div className="text-zinc-600">车型 / 应用</div>
                  <div className="mt-1 truncate text-zinc-300">{preview.inference?.vehicle || "未唯一推断"} · {preview.inference?.appName || "未指定"}</div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/45 px-2.5 py-2">
                  <div className="text-zinc-600">目标分支</div>
                  <div className="mt-1 truncate font-mono text-zinc-300">{preview.inference?.branch || "未唯一推断"}</div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/45 px-2.5 py-2">
                  <div className="text-zinc-600">Flavor</div>
                  <div className="mt-1 truncate text-zinc-300">{preview.inference?.flavor || "未指定"}</div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/45 px-2.5 py-2">
                  <div className="text-zinc-600">依赖工程</div>
                  <div className="mt-1 truncate text-zinc-300">
                    {preview.inference?.dependencies?.length
                      ? preview.inference.dependencies.map((item) => item.repositoryName || item.repositoryId).join("、")
                      : "无"}
                  </div>
                </div>
              </div> : (
                <div className="mt-3 rounded-lg border border-dashed border-zinc-700 bg-zinc-950/35 px-3 py-2 text-[9px] leading-relaxed text-zinc-600">
                  本页只确认 Git 来源。解析完成后直接进入初始化配置；AI 开启时在面板中并发推理，完成后可点击查看并应用。最终仍由你确认后创建故事点。
                </div>
              )}

              <div className="mt-4 text-[10px] font-medium text-zinc-300">请选择本次故事点的工程来源</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  aria-pressed={sourceMode === "local"}
                  disabled={busy}
                  onClick={() => {
                    if (sourceMode !== "local") setPreview(null);
                    setSourceMode("local");
                    setError("");
                  }}
                  className={`rounded-lg border px-3 py-2.5 text-left transition disabled:opacity-50 ${
                    sourceMode === "local"
                      ? "border-cyan-500/60 bg-cyan-500/10"
                      : "border-zinc-700 bg-zinc-950/45 hover:border-zinc-600"
                  }`}
                  data-testid="git-commit-source-local"
                >
                  <span className="block text-[10px] font-medium text-cyan-200">使用本地工程配置</span>
                  <span className="mt-1 block text-[9px] leading-relaxed text-zinc-600">从本机已登记工程中明确选择；创建时校验该目录确实包含 commit。</span>
                </button>
                <button
                  type="button"
                  aria-pressed={sourceMode === "remote"}
                  disabled={busy}
                  onClick={() => {
                    if (sourceMode !== "remote") setPreview(null);
                    setSourceMode("remote");
                    setError("");
                  }}
                  className={`rounded-lg border px-3 py-2.5 text-left transition disabled:opacity-50 ${
                    sourceMode === "remote"
                      ? "border-violet-500/60 bg-violet-500/10"
                      : "border-zinc-700 bg-zinc-950/45 hover:border-zinc-600"
                  }`}
                  data-testid="git-commit-source-remote"
                >
                  <span className="block text-[10px] font-medium text-violet-200">远程拉取</span>
                  <span className="mt-1 block text-[9px] leading-relaxed text-zinc-600">使用逻辑仓库和精确 revision 生成远程拉取配置，不采用本机目录。</span>
                </button>
              </div>

              {sourceMode === "local" && (
                <div className="mt-3">
                  <label htmlFor="git-commit-local-source" className="mb-1.5 block text-[10px] text-zinc-400">
                    本机工程
                  </label>
                  <select
                    id="git-commit-local-source"
                    value={localSourceValue}
                    disabled={busy}
                    onChange={(event) => {
                      setLocalSourceValue(event.target.value);
                      setPreview(null);
                      setError("");
                    }}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-[10px] text-zinc-200 outline-none transition focus:border-cyan-500 disabled:opacity-50"
                    data-testid="git-commit-local-source"
                  >
                    <option value="">请选择本机工程…</option>
                    {localSources.map((source) => (
                      <option key={gitCommitLocalSourceValue(source)} value={gitCommitLocalSourceValue(source)}>
                        {source.name || source.projectId}
                        {source.role === "webapp" ? "（WebApp）" : ""}
                        {source.currentBranch ? ` · ${source.currentBranch}` : ""}
                        {source.hasWebApp && source.role !== "webapp" ? " · 含 WebApp" : ""}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1.5 text-[9px] text-zinc-600">
                    {selectedLocalSource
                      ? `将使用「${selectedLocalSource.name || selectedLocalSource.projectId}」；后端不会在失败时静默改成远程拉取。`
                      : "AI 推理结果只用于填充上方预览，必须选择本机工程后才能创建。"}
                  </div>
                </div>
              )}
          </section>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-violet-500/15 bg-violet-500/[0.055] px-3.5 py-3">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-violet-300">自动推导</div>
              <div className="text-[11px] leading-5 text-zinc-500">包含分支 · 车型 / Flavor · 主工程 · 依赖工程</div>
            </div>
            <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/[0.045] px-3.5 py-3">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-cyan-300">默认评审</div>
              <div className="text-[11px] leading-5 text-zinc-500">Diff Review · 静态检查 · 跨 Flavor · 合并风险</div>
            </div>
          </div>

          <div className="min-h-5 text-[11px]">
            {error ? <span role="alert" className="text-red-300">⚠ {error}</span> : (
              <span className="text-zinc-600">
                {preview
                  ? "当前仅为预设置；下一步还会进入统一初始化配置，最终确认后才创建故事点。"
                  : "第一步只读取 Git 元数据并生成预设置，不会创建故事点或修改现有本地分支。"}
              </span>
            )}
          </div>
        </div>

        <div className={`relative flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900/45 px-6 py-4 ${embedded ? "" : "rounded-b-2xl"}`}>
          <span className="hidden text-[10px] text-zinc-600 sm:block">
            {preview ? "预设置不会自动落入正式故事点" : "重复 revision 会直接打开已有评审故事点"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="submit"
              disabled={
                busy
                || !parsedRevision.ok
                || !repositorySelection.ok
                || !sourceMode
                || (sourceMode === "local" && !selectedLocalSource)
              }
              className="min-w-40 rounded-lg border border-violet-300/25 bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-xs font-medium text-white shadow-lg shadow-violet-950/40 transition hover:from-violet-500 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
              data-testid="git-commit-story-submit"
            >
              {busy
                  ? (preview ? "正在进入初始化配置…" : "正在解析 Git 来源…")
                : (preview ? "进入初始化配置" : "解析 Git 来源")}
            </button>
          </div>
        </div>
      </form>
  );

  if (embedded) return form;

  return createPortal((
    <div
      className="fixed inset-0 z-[145] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-commit-story-title"
      data-testid="git-commit-story-modal"
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="absolute inset-0"
        aria-hidden="true"
        data-testid="git-commit-story-backdrop"
        onClick={(event) => event.stopPropagation()}
      />
      {form}
    </div>
  ), document.body);
}
