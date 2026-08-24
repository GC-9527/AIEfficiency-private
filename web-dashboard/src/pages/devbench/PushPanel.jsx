/**
 * Git Push（类 Android Studio「Push」对话框）。入口在故事点头部「标记版本」按钮旁。
 * 推送范围 = 主工程 + 其关联 WebApp（与「标记版本」打 tag 的范围一致）。
 *
 * 体验对齐 Android Studio，并针对几类风险做交互：
 *  - 防误点：打开即先做预检（fetch + 算 ahead/behind），列出每个工程将要推什么，确认后才真正 push；
 *            强制推送额外二次确认。
 *  - 远程冲突：直接推送被远程拒绝(non-fast-forward) → 顶部醒目提示，给「先拉取远程最新」与「强制推送」两条出路。
 *  - 冲突后交互：「先拉取远程最新」内部调 Git Update（保留本地改动）拉完自动重新预检，再让用户推一次。
 *  - 勾选项 Tags：默认勾选，连同刚「标记版本」打的轻量 tag 一起推（轻量 tag 必须显式 --tags）。
 */
import React, { useEffect, useState } from "react";
import { devbenchApi } from "./api.js";

// 单个工程预检状态 → 一句话 + 颜色（领先/落后/首次推送/已最新）
function syncLine(r) {
  if (!r.isRepo || r.error) return { text: r.error || "不可推送", color: "text-red-300" };
  if (!r.hasUpstream) return { text: "尚未推送过，将建立 " + (r.remote || "origin") + "/" + r.branch + " 跟踪", color: "text-sky-300" };
  if (r.behind > 0 && r.ahead > 0) return { text: `⚠ 领先 ${r.ahead}、落后 ${r.behind} 个提交：直接推送会被拒绝，建议先拉取`, color: "text-amber-300" };
  if (r.behind > 0) return { text: `⚠ 落后远程 ${r.behind} 个提交：直接推送会被拒绝，建议先拉取`, color: "text-amber-300" };
  if (r.ahead > 0) return { text: `↑ ${r.ahead} 个待推提交`, color: "text-emerald-300" };
  return { text: "分支已与远程一致", color: "text-zinc-400" };
}

// 单个工程 push 结果 → 一句话 + 颜色
function resultLine(r) {
  if (r.rejected) return { text: "✗ 被远程拒绝（non-fast-forward）", color: "text-red-300" };
  if (!r.ok) return { text: "✗ " + (r.error || "推送失败"), color: "text-red-300" };
  const parts = [r.upToDate ? "已是最新" : "✓ 已推送分支"];
  if (r.tagsPushed) parts.push("已推 tags");
  else if (r.tagsError) parts.push("tags 失败：" + r.tagsError);
  return { text: parts.join(" · "), color: r.upToDate ? "text-zinc-400" : "text-emerald-300" };
}

export default function PushPanel({ tabId, refreshKey = 0, onClose, onToast }) {
  const [loading, setLoading] = useState(true);   // 预检加载中
  const [data, setData] = useState([]);           // 预检结果
  const [pushTags, setPushTags] = useState(true); // 勾选项 Tags（默认勾，紧跟「标记版本」）
  const [force, setForce] = useState(false);      // 强制推送
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);  // 「先拉取远程最新」进行中
  const [results, setResults] = useState(null);   // push 结果（null=还没推）

  async function loadPreview(fetch = true) {
    setLoading(true); setResults(null);
    const r = await devbenchApi.gitPushPreview(tabId, fetch);
    if (r.ok) setData(r.data || []);
    else onToast?.(r.error || "预检失败");
    setLoading(false);
  }
  useEffect(() => { loadPreview(true); /* eslint-disable-next-line */ }, [tabId, refreshKey]);

  const repos = (data || []).filter((r) => r.isRepo && !r.error);
  const pushable = repos.length > 0;
  const anyBehind = repos.some((r) => r.behind > 0);
  const totalTags = repos.reduce((n, r) => n + (r.pendingTags?.length || 0), 0);

  async function doPush(useForce) {
    if (pushing || pulling) return;
    if (useForce && !window.confirm(
      "强制推送（--force-with-lease）会用本地分支覆盖远程对应分支。\n" +
      "--force-with-lease 已比 --force 安全（远程若有你未见过的新提交会中止），但仍可能丢弃他人提交。\n\n确定要强制推送吗？"
    )) return;
    setPushing(true);
    const r = await devbenchApi.gitPush(tabId, { pushTags, force: useForce });
    setPushing(false);
    setResults(r.data || []);
    if (r.ok) {
      onToast?.(`Git Push 完成${pushTags ? "（含 tags）" : ""}`);
    } else if (r.rejected) {
      // 不弹 toast，靠面板顶部的冲突横幅引导
    } else {
      onToast?.(r.error || "推送失败");
    }
  }

  // 冲突后「先拉取远程最新」：调 Git Update（保留本地改动），拉完重新预检，让用户再推一次
  async function pullThenRetry() {
    if (pulling || pushing) return;
    setPulling(true);
    const r = await devbenchApi.gitUpdate(tabId);
    setPulling(false);
    if (r?.hasConflict) {
      onToast?.("拉取后存在合并冲突，请在「本地改动」/IDE 处理或让 AI 解决后再推送");
    } else if (r?.ok === false) {
      onToast?.(r?.error || "拉取失败");
    } else {
      onToast?.("已拉取远程最新，请复核后再推送");
    }
    await loadPreview(true); // 重新预检（回到确认态）
  }

  const rejected = results && results.some((r) => r.rejected);
  const pushedOk = results && results.length > 0 && results.every((r) => r.ok);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[620px] max-w-[94vw] max-h-[86vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">⬆ Git Push</span>
          <span className="text-[11px] text-zinc-500">主工程 + 关联 WebApp</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => loadPreview(true)}
              disabled={loading || pushing || pulling}
              className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 disabled:opacity-50"
              title="重新 fetch 并预检"
            >↻ 刷新</button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
          </div>
        </div>

        {/* 冲突横幅（push 被拒后） */}
        {rejected && (
          <div className="shrink-0 mx-3 mt-3 px-3 py-2 rounded-lg bg-red-950/50 border border-red-800/60 text-[12px] text-red-200">
            <div className="font-medium mb-1">⚠ 推送被远程拒绝（远程有你本地没有的新提交，non-fast-forward）</div>
            <div className="text-red-300/80 mb-2">请先拉取并合并远程最新再推；若确认要用本地覆盖远程，可强制推送。</div>
            <div className="flex items-center gap-2">
              <button
                onClick={pullThenRetry}
                disabled={pulling || pushing}
                className="text-[11px] px-2.5 py-1 rounded bg-teal-700/40 hover:bg-teal-600/50 text-teal-100 border border-teal-700/50 disabled:opacity-60"
              >{pulling ? "拉取中…" : "↓ 先拉取远程最新（推荐）"}</button>
              <button
                onClick={() => doPush(true)}
                disabled={pulling || pushing}
                className="text-[11px] px-2.5 py-1 rounded bg-red-800/50 hover:bg-red-700/60 text-red-100 border border-red-700/60 disabled:opacity-60"
              >{pushing ? "推送中…" : "⚡ 强制推送（--force-with-lease）"}</button>
            </div>
          </div>
        )}

        {/* 全部成功提示 */}
        {pushedOk && !rejected && (
          <div className="shrink-0 mx-3 mt-3 px-3 py-2 rounded-lg bg-emerald-950/40 border border-emerald-800/50 text-[12px] text-emerald-200">
            ✓ 推送完成。可关闭本窗口。
          </div>
        )}

        {/* 工程列表（预检 / 结果） */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {loading ? (
            <div className="text-center text-zinc-600 text-xs py-10">预检中（fetch + 比对远程）…</div>
          ) : !pushable ? (
            <div className="text-center text-zinc-600 text-xs py-10">
              没有可推送的工程{data?.[0]?.error ? `（${data[0].error}）` : ""}
            </div>
          ) : (
            data.map((r) => {
              const res = results && results.find((x) => x.path === r.path);
              const ln = res ? resultLine(res) : syncLine(r);
              return (
                <div key={r.path} className="border border-zinc-800 rounded-lg px-3 py-2 bg-zinc-950/40">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-200 truncate">{r.name}</span>
                    {r.role === "webapp" && <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">WebApp</span>}
                    {r.branch && (
                      <span className="text-[10px] font-mono text-amber-300 shrink-0">
                        ⎇ {r.branch}{r.upstream ? ` → ${r.upstream}` : ` → ${r.remote || "origin"}/${r.branch}（新）`}
                      </span>
                    )}
                  </div>
                  <div className={`mt-1 text-[11px] ${ln.color}`}>{ln.text}</div>
                  {/* 待推 tag */}
                  {!res && r.isRepo && !r.error && (
                    <div className="mt-1 text-[10px] text-zinc-500">
                      {r.tagsDryRunFailed
                        ? "待推 tag：检查失败（可能远程不可达）"
                        : (r.pendingTags?.length
                          ? <span>待推 tag（{r.pendingTags.length}）：<span className="font-mono text-violet-300">{r.pendingTags.slice(0, 8).join("、")}{r.pendingTags.length > 8 ? " …" : ""}</span></span>
                          : "无待推 tag")}
                    </div>
                  )}
                  {r.fetchFailed && !res && (
                    <div className="mt-1 text-[10px] text-amber-400/70">fetch 失败，落后数可能不准：{r.fetchError}</div>
                  )}
                  {res?.tagsError && (
                    <div className="mt-1 text-[10px] text-amber-400/80">tags 推送失败：{res.tagsError}</div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* 底部选项 + 操作 */}
        <div className="shrink-0 px-4 py-3 border-t border-zinc-800 space-y-2.5">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[12px] text-zinc-300 cursor-pointer select-none" title="连同标签一起推送（含刚「标记版本」打的 tag）。轻量 tag 必须显式推送">
              <input type="checkbox" checked={pushTags} onChange={(e) => setPushTags(e.target.checked)} className="accent-purple-500" />
              同时推送标签 Tags{totalTags ? `（${totalTags}）` : ""}
            </label>
            <label className="flex items-center gap-1.5 text-[12px] cursor-pointer select-none text-zinc-300" title="--force-with-lease：用本地覆盖远程（远程若有未见过的新提交会中止）。仅在确知需要时使用">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="accent-red-500" />
              <span className={force ? "text-red-300" : ""}>强制推送（--force-with-lease）</span>
            </label>
          </div>
          {anyBehind && !force && !results && (
            <div className="text-[11px] text-amber-300/90">提示：有工程落后远程，直接推送大概率被拒。建议先点下方「先拉取远程最新」。</div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={pullThenRetry}
              disabled={loading || pushing || pulling || !pushable}
              className="text-[12px] px-3 py-1.5 rounded bg-teal-700/30 hover:bg-teal-600/40 text-teal-200 border border-teal-700/40 disabled:opacity-50"
              title="Git Update：拉取所有配置工程的远程最新（保留本地改动）后重新预检"
            >{pulling ? "拉取中…" : "↓ 先拉取远程最新"}</button>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700">取消</button>
              <button
                onClick={() => doPush(force)}
                disabled={loading || pushing || pulling || !pushable}
                className={`text-[12px] px-4 py-1.5 rounded border font-medium disabled:opacity-50 ${
                  force
                    ? "bg-red-700/50 hover:bg-red-600/60 text-red-100 border-red-600/60"
                    : "bg-purple-700/40 hover:bg-purple-600/50 text-purple-100 border-purple-600/50"
                }`}
                title={force ? "强制推送（会二次确认）" : "推送当前分支" + (pushTags ? " + tags" : "")}
              >
                {pushing ? "推送中…" : `${force ? "⚡ 强制 Push" : "⬆ Push"}${pushable ? `（${repos.length} 个工程${pushTags ? " · 含 tags" : ""}）` : ""}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
