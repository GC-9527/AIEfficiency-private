/**
 * BuildPanel —— 编译产物（gradle assemble）面板。入口在故事点头部「📦 APK产物」旁。
 *
 * 上半区：本故事点【所有 Android 工程】各自一张卡片 —— 勾选要打的 flavor（多选）+ 选 Debug/Release/全部，
 *   复制了「版本号控制」的三个按钮（加10 / 交付 / 测试，交互同版本号悬浮窗；独立悬浮窗仍保留），
 *   并且【每张卡片各自一个「打包」按钮】，只打该工程（不同工程可分别打包、互不影响）。
 *   App-Mock 工程若在本故事点里，就是其中一张卡片。
 * 下半区：点某工程「打包」后，类似 Android Studio 点 assemble 的【实时 gradle 任务日志】（按工程切换、自动滚动、可分别停止）。
 *
 * 实时日志来自上层 index.jsx 的 buildMap（WS devbench_build），按工程名分组，通过 `build.byProject` 注入。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";

const STATUS_BADGE = {
  starting: { t: "启动中", c: "text-blue-300" },
  running: { t: "打包中", c: "text-blue-300" },
  ok: { t: "成功", c: "text-emerald-300" },
  failed: { t: "失败", c: "text-red-300" },
  canceled: { t: "已取消", c: "text-amber-300" },
};

export default function BuildPanel({
  projects = [], build = null, onBuild, onStop, onClose, onToast,
  onBumpVersion, bumping = false, previewVersion,
  selection = null, onSelectionChange,
}) {
  const androidProjects = useMemo(() => projects.filter((p) => p.isAndroid), [projects]);
  const byProject = build?.byProject || {};
  const projNames = Object.keys(byProject);

  // 选择态：{ [path]: { flavors:Set<string>, debug:bool, release:bool, clean:bool } }
  // clean=true → 打包时先 gradle clean 再 assemble（「清理后打包」勾选）。
  const defaultSelectionFor = (p) => ({ flavors: new Set(p.selected ? [p.selected] : []), debug: true, release: false, clean: false });
  const normalizeSelection = (current = {}) => {
    const init = {};
    for (const p of androidProjects) {
      const v = current[p.path];
      if (!v) { init[p.path] = defaultSelectionFor(p); continue; }
      init[p.path] = {
        flavors: v.flavors instanceof Set ? new Set(v.flavors) : new Set(Array.isArray(v.flavors) ? v.flavors : []),
        debug: v.debug ?? true,
        release: v.release ?? false,
        clean: v.clean ?? false,
      };
    }
    return init;
  };
  const [internalSel, setInternalSel] = useState(() => normalizeSelection(selection || {}));
  const sel = selection || internalSel;
  const updateSel = (updater) => {
    const apply = (prev) => {
      const base = normalizeSelection(prev || {});
      const next = typeof updater === "function" ? updater(base) : updater;
      return normalizeSelection(next || {});
    };
    if (onSelectionChange) onSelectionChange(apply);
    else setInternalSel(apply);
  };
  useEffect(() => {
    updateSel((m) => m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [androidProjects.map((p) => `${p.path}|${p.selected || ""}`).join("|")]);
  const ofPath = (path) => sel[path] || defaultSelectionFor(androidProjects.find((p) => p.path === path) || {});
  const setOf = (path, patch) => updateSel((m) => ({ ...m, [path]: { ...(m[path] || ofPath(path)), ...patch } }));
  const toggleFlavor = (path, fl) => updateSel((m) => {
    const cur = m[path] || ofPath(path); const fs = new Set(cur.flavors);
    fs.has(fl) ? fs.delete(fl) : fs.add(fl);
    return { ...m, [path]: { ...cur, flavors: fs } };
  });

  // 某工程：当前选择能否构成一个打包任务（带 clean 标记 → 先清理后打包）
  function jobOf(p) {
    const s = ofPath(p.path);
    const buildTypes = [];
    if (s.release) buildTypes.push("release");
    if (s.debug) buildTypes.push("debug");
    if (!buildTypes.length) return null;
    const selectedFlavors = [...s.flavors];
    if (p.flavors.length && !selectedFlavors.length) return null; // 有 flavor 维度的工程必须至少选 1 个
    // UI 只选 car 维度；多维工程在请求前展开为真实 Gradle 变体（如 geelyss21Prod / geelyss21Stg）。
    const variants = Array.isArray(p.buildVariants) ? p.buildVariants : [];
    const flavors = variants.length ? selectedFlavors.flatMap((flavor) => {
      const matched = variants.filter((variant) => variant === flavor ||
        (variant.startsWith(flavor) && /^[A-Z]/.test(variant.slice(flavor.length, flavor.length + 1))));
      return matched.length ? matched : [flavor];
    }) : selectedFlavors;
    return { path: p.path, name: p.name, flavors: [...new Set(flavors)], buildTypes, clean: !!s.clean };
  }
  // 纯清理任务（独立「清理」按钮）：只跑 gradle clean，不 assemble
  function cleanJobOf(p) { return { path: p.path, name: p.name, flavors: [], buildTypes: [], clean: true }; }
  function doCleanProject(p) {
    if (isBuilding(p.name)) return;
    if (!confirm(`对「${p.name}」执行 gradlew clean？\n会删除该工程 build/outputs 下所有产物（含已打出的 APK），下次打包将全量重编。`)) return;
    onBuild?.([cleanJobOf(p)]);
  }
  const variantCountOf = (p) => { const j = jobOf(p); return j ? Math.max(1, j.flavors.length) * j.buildTypes.length : 0; };
  const isBuilding = (name) => { const s = byProject[name]; return !!s && (s.status === "running" || s.status === "starting"); };

  function doBuildProject(p) {
    if (isBuilding(p.name)) return;
    const job = jobOf(p);
    if (!job) { onToast?.(`「${p.name}」请先选择 flavor 和构建类型`); return; }
    onBuild?.([job]);
  }
  // 一键并发：对每个【选择有效且未在打包】的工程【各自独立】触发一次打包 ——
  // 每次独立 onBuild → 后端各自 buildId/各自 gradle 进程 → 真并发（区别于把多工程塞进一个 buildId 的串行）。
  function doBuildAllConcurrent() {
    const targets = androidProjects.filter((p) => !isBuilding(p.name) && jobOf(p));
    if (!targets.length) { onToast?.("没有可并发打包的工程（请先选 flavor + 构建类型，或都在打包中）"); return; }
    for (const p of targets) onBuild?.([jobOf(p)]);
  }
  function stopAll() { for (const n of projNames) if (isBuilding(n)) onStop?.(n); }
  const eligibleCount = androidProjects.filter((p) => !isBuilding(p.name) && jobOf(p)).length;
  const anyBuilding = projNames.some((n) => isBuilding(n));

  // ---- 实时日志：按工程分组，选中一个工程看其日志 ----
  const [activeLog, setActiveLog] = useState(null);
  useEffect(() => {
    const running = projNames.find((n) => byProject[n]?.status === "running" || byProject[n]?.status === "starting");
    if (running) setActiveLog(running);
    else if (projNames.length && (!activeLog || !byProject[activeLog])) setActiveLog(projNames[projNames.length - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projNames.join("|"), projNames.map((n) => byProject[n]?.status).join("|")]);

  const logRef = useRef(null);
  const cur = activeLog ? byProject[activeLog] : null;
  const scrollLogTo = (pos) => {
    const el = logRef.current; if (!el) return;
    el.scrollTop = pos === "top" ? 0 : el.scrollHeight;
  };
  useEffect(() => {
    const el = logRef.current; if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [cur?.lines?.length, activeLog]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[880px] max-w-[95vw] max-h-[90vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* 头 */}
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">🔨 编译产物</span>
          <span className="text-[11px] text-zinc-500">每个工程各自打包 · gradle assemble</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {/* 选择区：每个 Android 工程一张卡片，各自一个「打包」按钮 */}
          {androidProjects.length === 0 ? (
            <div className="text-center text-zinc-600 text-xs py-8">本故事点没有可打包的 Android 工程（缺 Gradle 工程配置）</div>
          ) : androidProjects.map((p) => {
            const s = ofPath(p.path);
            const ver = p.version;
            const st = byProject[p.name];
            const building = isBuilding(p.name);
            const badge = st ? STATUS_BADGE[st.status] : null;
            const vc = variantCountOf(p);
            return (
              <div key={p.path} className="border border-zinc-800 rounded-lg px-3 py-2.5 bg-zinc-950/40">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-zinc-200 truncate">{p.name}</span>
                  {p.role === "primary" && <span className="text-[9px] px-1 rounded bg-fuchsia-900/40 text-fuchsia-300 border border-fuchsia-800/50">应用市场</span>}
                  {p.role !== "primary" && <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">关联</span>}
                  {p.selected && <span className="text-[10px] text-fuchsia-300 shrink-0">🎯 {p.selected}</span>}
                  {ver?.versionName && <span className="text-[10px] font-mono text-emerald-300/80 shrink-0">{ver.versionName} #{ver.versionCode}</span>}
                  {badge && <span className={`text-[10px] shrink-0 ml-1 ${badge.c}`}>● {badge.t}{st.status === "failed" && st.code != null ? `(${st.code})` : ""}</span>}
                  {/* 该工程的「清理 / 打包 / 停止」按钮 */}
                  <div className="ml-auto shrink-0 flex items-center gap-1.5">
                    {building ? (
                      <button onClick={() => onStop?.(p.name)} className="text-[11px] px-2.5 py-1 rounded bg-red-700/50 hover:bg-red-600/60 text-red-100 border border-red-600/60">■ 停止</button>
                    ) : (
                      <>
                        <button onClick={() => doCleanProject(p)}
                          title="gradlew clean：仅清理该工程 build/outputs 产物（会删掉已打出的 APK）"
                          className="text-[11px] px-2.5 py-1 rounded border font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700">
                          🧹 清理
                        </button>
                        <button onClick={() => doBuildProject(p)} disabled={!vc}
                          title={vc ? `gradle ${ofPath(p.path).clean ? "clean + " : ""}assemble（${vc} 个变体）` : "请先选 flavor 和构建类型"}
                          className="text-[11px] px-2.5 py-1 rounded border font-medium disabled:opacity-50 bg-amber-700/40 hover:bg-amber-600/50 text-amber-100 border-amber-600/50">
                          🔨 {ofPath(p.path).clean ? "清理后打包" : "打包"}{vc ? `（${vc}）` : ""}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* flavor 多选 */}
                {p.flavors.length > 0 ? (
                  <div className="mb-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] text-zinc-500">Flavor（多选）</span>
                      <button onClick={() => setOf(p.path, { flavors: new Set(p.flavors) })} className="text-[10px] px-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border border-zinc-700">全选</button>
                      <button onClick={() => setOf(p.path, { flavors: new Set() })} className="text-[10px] px-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border border-zinc-700">清空</button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {p.flavors.map((fl) => {
                        const on = s.flavors.has(fl);
                        return (
                          <button key={fl} onClick={() => toggleFlavor(p.path, fl)}
                            className={`text-[11px] px-2 py-0.5 rounded border transition ${on ? "bg-fuchsia-600/30 border-fuchsia-600/60 text-fuchsia-100" : "bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>
                            {on ? "✓ " : ""}{fl}
                          </button>
                        );
                      })}
                    </div>
                    {Array.isArray(p.buildVariants) && p.buildVariants.length > p.flavors.length && (
                      <div className="mt-1 text-[10px] text-zinc-600">仅选择 car 维度；打包时自动展开该车型的全部环境变体。</div>
                    )}
                  </div>
                ) : (
                  <div className="mb-2 text-[10px] text-zinc-500">未从 flavorConfig.json / project_flavor.gradle 解析到 flavor，将直接 assemble。</div>
                )}

                {/* 构建类型 + 版本号按钮 */}
                <div className="flex items-center flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-500">类型</span>
                    <button onClick={() => setOf(p.path, { debug: true, release: false })}
                      className={`text-[11px] px-2 py-0.5 rounded border ${s.debug && !s.release ? "bg-sky-600/30 border-sky-600/60 text-sky-100" : "bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>Debug</button>
                    <button onClick={() => setOf(p.path, { debug: false, release: true })}
                      className={`text-[11px] px-2 py-0.5 rounded border ${s.release && !s.debug ? "bg-emerald-600/30 border-emerald-600/60 text-emerald-100" : "bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>Release</button>
                    <button onClick={() => setOf(p.path, { debug: true, release: true })}
                      className={`text-[11px] px-2 py-0.5 rounded border ${s.debug && s.release ? "bg-violet-600/30 border-violet-600/60 text-violet-100" : "bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>全部</button>
                    {/* 清理后打包：勾上则「打包」按钮会先 gradle clean 再 assemble（一次进程跑完，仍出新产物） */}
                    <button onClick={() => setOf(p.path, { clean: !s.clean })}
                      title="勾选后点「打包」会先执行 gradle clean 再 assemble（全量重编、较慢，但产物干净）"
                      className={`text-[11px] px-2 py-0.5 rounded border ml-1 ${s.clean ? "bg-orange-600/30 border-orange-600/60 text-orange-100" : "bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>
                      {s.clean ? "✓ " : ""}🧹 清理后打包
                    </button>
                  </div>
                  {/* 版本号控制（复制自版本号悬浮窗；独立悬浮窗仍保留） */}
                  {p.selected && ver?.versionName && previewVersion && (
                    <div className="flex items-center gap-1.5 ml-auto">
                      <span className="text-[10px] text-zinc-600">版本</span>
                      {[
                        ["bump10", "加10", "bg-fuchsia-700/25 border-fuchsia-700/40 text-fuchsia-200 hover:bg-fuchsia-600/40"],
                        ["deliver", "交付", "bg-emerald-700/25 border-emerald-700/40 text-emerald-200 hover:bg-emerald-600/40"],
                        ["test", "测试", "bg-sky-700/25 border-sky-700/40 text-sky-200 hover:bg-sky-600/40"],
                      ].map(([op, label, cls]) => {
                        const nx = previewVersion(ver.versionName, op, ver.versionCode);
                        return (
                          <button key={op} onClick={() => onBumpVersion?.(p.path, op)} disabled={bumping}
                            title={`${label} → ${nx.name} #${nx.code}`}
                            className={`text-[10px] px-1.5 py-0.5 rounded border disabled:opacity-50 ${cls}`}>
                            {label}<span className="font-mono ml-1 opacity-70">{nx.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 该工程的产物 APK（成功后） */}
                {st && st.status === "ok" && st.apks?.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-zinc-800 text-[10px] text-emerald-300/90 font-mono">
                    <div className="text-zinc-500">产物 APK（{st.apks.length}）：</div>
                    {st.apks.map((a) => <div key={a} className="break-all">• {a}</div>)}
                  </div>
                )}
              </div>
            );
          })}

          {/* 实时日志区（按工程切换） */}
          {projNames.length > 0 && (
            <div className="border border-zinc-800 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-zinc-950/60 border-b border-zinc-800 flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] text-zinc-400 mr-1">gradle 日志</span>
                {projNames.map((n) => {
                  const st = byProject[n]?.status || "running";
                  const b = STATUS_BADGE[st] || STATUS_BADGE.running;
                  return (
                    <button key={n} onClick={() => setActiveLog(n)}
                      className={`text-[10px] px-2 py-0.5 rounded border flex items-center gap-1 ${activeLog === n ? "bg-zinc-700 border-zinc-600 text-zinc-100" : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                      <span className={(st === "running" || st === "starting") ? "inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" : ""} />
                      {n}<span className={b.c}>· {b.t}</span>
                    </button>
                  );
                })}
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => scrollLogTo("top")}
                    className="text-[10px] px-2 py-0.5 rounded border bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200">
                    顶部
                  </button>
                  <button onClick={() => scrollLogTo("bottom")}
                    className="text-[10px] px-2 py-0.5 rounded border bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200">
                    底部
                  </button>
                </div>
              </div>
              <div ref={logRef} className="h-[260px] overflow-y-auto bg-black/60 px-3 py-2 font-mono text-[10.5px] leading-relaxed">
                {cur ? (
                  <>
                    {(cur.lines || []).map((l, i) => (
                      <div key={i} className={l.stream === "err" ? "text-red-300/90 whitespace-pre-wrap break-all" : "text-zinc-300 whitespace-pre-wrap break-all"}>{l.line}</div>
                    ))}
                    {cur.status === "failed" && <div className="mt-2 text-red-400">✗ 退出码 {cur.code}</div>}
                    {cur.status === "canceled" && <div className="mt-2 text-amber-400">■ 已取消</div>}
                  </>
                ) : <div className="text-zinc-600">点上方某工程的「打包」开始</div>}
              </div>
            </div>
          )}
        </div>

        {/* 底部：一键并发打包 / 全部停止 / 关闭（单工程打包按钮在各卡片上） */}
        <div className="shrink-0 px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          <span className="text-[11px] text-zinc-500">各工程可分别「打包」/「停止」；「全部打包」让有效工程<strong className="text-zinc-300">并发</strong>各自打包。</span>
          <div className="ml-auto flex items-center gap-2">
            {anyBuilding && (
              <button onClick={stopAll} className="text-[12px] px-3 py-1.5 rounded bg-red-700/50 hover:bg-red-600/60 text-red-100 border border-red-600/60">■ 全部停止</button>
            )}
            <button onClick={doBuildAllConcurrent} disabled={!eligibleCount}
              title={eligibleCount ? `并发打包 ${eligibleCount} 个工程（各自独立 gradle 进程）` : "没有可打包的工程"}
              className="text-[12px] px-4 py-1.5 rounded border font-medium disabled:opacity-50 bg-amber-700/40 hover:bg-amber-600/50 text-amber-100 border-amber-600/50">
              ▶ 全部打包（并发{eligibleCount ? ` ${eligibleCount}` : ""}）
            </button>
            <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700">关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}
