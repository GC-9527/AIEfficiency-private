/**
 * SpecEditor —— 项目 spec 可视化编辑器（右栏）。
 * 提供「可视化」与「JSON 源码」两种编辑模式；保存由父组件负责（onSave）。
 * 为降复杂度：JSON 源码模式始终可用，可视化不完善时也能直接编辑整份 spec。
 */
import React, { useState, useEffect } from "react";
import { blankAcceptance } from "./api.js";

const ACC_TYPES = [
  { v: "file_exists", label: "文件存在" },
  { v: "cmd", label: "命令执行" },
  { v: "grep_count", label: "Grep 计数" },
  { v: "json_schema", label: "JSON Schema" },
];

const inputCls =
  "w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500";
const labelCls = "block text-[11px] text-zinc-500 mb-1";

export default function SpecEditor({ spec, onSave, saving, readOnly }) {
  const [mode, setMode] = useState("visual"); // visual | json
  const [draft, setDraft] = useState(spec || {});
  const [jsonText, setJsonText] = useState("");
  const [jsonErr, setJsonErr] = useState("");

  // spec 外部变化（切换项目）时同步内部草稿
  useEffect(() => {
    setDraft(spec || {});
    setJsonText(JSON.stringify(spec || {}, null, 2));
    setJsonErr("");
  }, [spec]);

  function patch(p) { setDraft((d) => ({ ...d, ...p })); }

  function patchMilestone(idx, p) {
    setDraft((d) => {
      const ms = [...(d.milestones || [])];
      ms[idx] = { ...ms[idx], ...p };
      return { ...d, milestones: ms };
    });
  }
  function addMilestone() {
    setDraft((d) => {
      const ms = [...(d.milestones || [])];
      const n = ms.length + 1;
      ms.push({ id: `m${n}`, title: `里程碑 ${n}`, prompt: "", kind: "claude", script: "", maxTurns: 30, maxCostUsd: 5, acceptance: [] });
      return { ...d, milestones: ms };
    });
  }
  function delMilestone(idx) {
    setDraft((d) => ({ ...d, milestones: (d.milestones || []).filter((_, i) => i !== idx) }));
  }
  function patchAcc(mIdx, aIdx, p) {
    setDraft((d) => {
      const ms = [...(d.milestones || [])];
      const acc = [...(ms[mIdx].acceptance || [])];
      acc[aIdx] = { ...acc[aIdx], ...p };
      ms[mIdx] = { ...ms[mIdx], acceptance: acc };
      return { ...d, milestones: ms };
    });
  }
  function addAcc(mIdx, type) {
    setDraft((d) => {
      const ms = [...(d.milestones || [])];
      ms[mIdx] = { ...ms[mIdx], acceptance: [...(ms[mIdx].acceptance || []), blankAcceptance(type)] };
      return { ...d, milestones: ms };
    });
  }
  function delAcc(mIdx, aIdx) {
    setDraft((d) => {
      const ms = [...(d.milestones || [])];
      ms[mIdx] = { ...ms[mIdx], acceptance: (ms[mIdx].acceptance || []).filter((_, i) => i !== aIdx) };
      return { ...d, milestones: ms };
    });
  }

  function handleSave() {
    if (mode === "json") {
      let parsed;
      try { parsed = JSON.parse(jsonText); } catch (e) { setJsonErr(`JSON 解析失败：${e.message}`); return; }
      setJsonErr("");
      onSave(parsed);
    } else {
      onSave(draft);
    }
  }

  // 切到 JSON 模式：把当前可视化草稿序列化
  function toJsonMode() {
    setJsonText(JSON.stringify(draft, null, 2));
    setJsonErr("");
    setMode("json");
  }
  // 切回可视化：尝试解析 JSON 文本回填草稿
  function toVisualMode() {
    try { setDraft(JSON.parse(jsonText)); setJsonErr(""); } catch (e) { setJsonErr(`JSON 无效，无法切回可视化：${e.message}`); return; }
    setMode("visual");
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">
        <div className="text-sm font-medium text-zinc-300">Spec 编辑器</div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => (mode === "visual" ? toJsonMode() : toVisualMode())}
            className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
          >
            {mode === "visual" ? "JSON 源码" : "可视化"}
          </button>
          {!readOnly && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-2.5 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          )}
        </div>
      </div>

      {jsonErr && <div className="px-3 py-1.5 text-[11px] text-red-400 bg-red-500/10 border-b border-red-500/20">{jsonErr}</div>}
      {readOnly && <div className="px-3 py-1.5 text-[11px] text-amber-400 bg-amber-500/10 border-b border-amber-500/20">运行中只读，暂停或停止后可编辑</div>}

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {mode === "json" ? (
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            className="w-full h-full min-h-[60vh] bg-zinc-950 border border-zinc-800 rounded p-2 text-[11px] font-mono text-zinc-200 outline-none focus:border-zinc-600 resize-none"
          />
        ) : (
          <>
            {/* 顶层字段 */}
            <div>
              <label className={labelCls}>愿景 / Vision</label>
              <textarea value={draft.vision || ""} onChange={(e) => patch({ vision: e.target.value })}
                rows={3} placeholder="这个项目要做成什么样……" className={inputCls + " resize-y"} />
            </div>
            <div>
              <label className={labelCls}>项目目录 projectDir</label>
              <input value={draft.projectDir || ""} onChange={(e) => patch({ projectDir: e.target.value })}
                placeholder="D:\\workspace\\my-new-project" className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>引擎 engine</label>
                <input value={draft.engine || "claude"} onChange={(e) => patch({ engine: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>会话成本上限 $ </label>
                <input type="number" value={draft.sessionCostCapUsd ?? ""} onChange={(e) => patch({ sessionCostCapUsd: numOrU(e.target.value) })} className={inputCls} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>审批闸门 gating</label>
                <select value={draft.gating || "none"} onChange={(e) => patch({ gating: e.target.value })} className={inputCls}>
                  <option value="none">none（不审批）</option>
                  <option value="per_milestone">per_milestone（逐里程碑审批）</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>冷却秒 cooldownSeconds</label>
                <input type="number" value={draft.cooldownSeconds ?? ""} onChange={(e) => patch({ cooldownSeconds: numOrU(e.target.value) })} className={inputCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>允许写入路径 allowedWrites（每行一条，可空=不限制）</label>
              <textarea value={(draft.allowedWrites || []).join("\n")}
                onChange={(e) => patch({ allowedWrites: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
                rows={2} placeholder="src/**\ndocs/**" className={inputCls + " font-mono resize-y"} />
            </div>

            {/* 里程碑 */}
            <div className="border-t border-zinc-800 pt-2">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium text-zinc-400">里程碑（{(draft.milestones || []).length}）</div>
                <button onClick={addMilestone} className="px-2 py-0.5 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">＋ 里程碑</button>
              </div>
              <div className="space-y-2">
                {(draft.milestones || []).map((m, mi) => (
                  <div key={mi} className="border border-zinc-800 rounded-lg p-2 bg-zinc-900/40">
                    <div className="flex items-center gap-2 mb-2">
                      <input value={m.id || ""} onChange={(e) => patchMilestone(mi, { id: e.target.value })}
                        placeholder="id" className={inputCls + " w-16 shrink-0"} />
                      <input value={m.title || ""} onChange={(e) => patchMilestone(mi, { title: e.target.value })}
                        placeholder="标题" className={inputCls} />
                      <button onClick={() => delMilestone(mi)} className="shrink-0 px-1.5 py-1 text-[11px] text-red-400 hover:text-red-300">✕</button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div>
                        <label className={labelCls}>kind</label>
                        <select value={m.kind || "claude"} onChange={(e) => patchMilestone(mi, { kind: e.target.value })} className={inputCls}>
                          <option value="claude">claude</option>
                          <option value="script">script</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelCls}>maxTurns</label>
                        <input type="number" value={m.maxTurns ?? ""} onChange={(e) => patchMilestone(mi, { maxTurns: numOrU(e.target.value) })} className={inputCls} />
                      </div>
                      <div>
                        <label className={labelCls}>maxCostUsd</label>
                        <input type="number" value={m.maxCostUsd ?? ""} onChange={(e) => patchMilestone(mi, { maxCostUsd: numOrU(e.target.value) })} className={inputCls} />
                      </div>
                    </div>
                    {m.kind === "script" ? (
                      <div className="mb-2">
                        <label className={labelCls}>script（执行命令）</label>
                        <textarea value={m.script || ""} onChange={(e) => patchMilestone(mi, { script: e.target.value })}
                          rows={2} className={inputCls + " font-mono resize-y"} />
                      </div>
                    ) : (
                      <div className="mb-2">
                        <label className={labelCls}>prompt（给 AI 的指令）</label>
                        <textarea value={m.prompt || ""} onChange={(e) => patchMilestone(mi, { prompt: e.target.value })}
                          rows={3} className={inputCls + " resize-y"} />
                      </div>
                    )}

                    {/* 验收检查 */}
                    <div className="border-t border-zinc-800/70 pt-1.5">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[11px] text-zinc-500">验收检查（{(m.acceptance || []).length}）</div>
                        <select value="" onChange={(e) => { if (e.target.value) addAcc(mi, e.target.value); }}
                          className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none">
                          <option value="">＋ 添加…</option>
                          {ACC_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        {(m.acceptance || []).map((a, ai) => (
                          <div key={ai} className="bg-zinc-950/60 border border-zinc-800 rounded p-1.5">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{a.type}</span>
                              <button onClick={() => delAcc(mi, ai)} className="text-[11px] text-red-400 hover:text-red-300">✕</button>
                            </div>
                            <AccFields a={a} onChange={(p) => patchAcc(mi, ai, p)} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function numOrU(v) { return v === "" ? undefined : Number(v); }

// 验收项按 type 显示对应字段
function AccFields({ a, onChange }) {
  const cls = inputCls;
  if (a.type === "file_exists") {
    return <input value={a.path || ""} onChange={(e) => onChange({ path: e.target.value })} placeholder="path（需存在的文件）" className={cls} />;
  }
  if (a.type === "cmd") {
    return (
      <div className="space-y-1">
        <input value={a.cmd || ""} onChange={(e) => onChange({ cmd: e.target.value })} placeholder="cmd（执行命令）" className={cls + " font-mono"} />
        <div className="grid grid-cols-2 gap-1">
          <input type="number" value={a.timeoutSec ?? ""} onChange={(e) => onChange({ timeoutSec: numOrU(e.target.value) })} placeholder="timeoutSec" className={cls} />
          <input type="number" value={a.expectRc ?? ""} onChange={(e) => onChange({ expectRc: numOrU(e.target.value) })} placeholder="expectRc" className={cls} />
        </div>
      </div>
    );
  }
  if (a.type === "grep_count") {
    return (
      <div className="space-y-1">
        <input value={a.pattern || ""} onChange={(e) => onChange({ pattern: e.target.value })} placeholder="pattern（正则）" className={cls + " font-mono"} />
        <input value={a.path || ""} onChange={(e) => onChange({ path: e.target.value })} placeholder="path" className={cls} />
        <div className="grid grid-cols-2 gap-1">
          <input type="number" value={a.min ?? ""} onChange={(e) => onChange({ min: numOrU(e.target.value) })} placeholder="min" className={cls} />
          <input type="number" value={a.max ?? ""} onChange={(e) => onChange({ max: numOrU(e.target.value) })} placeholder="max" className={cls} />
        </div>
      </div>
    );
  }
  if (a.type === "json_schema") {
    return (
      <div className="space-y-1">
        <input value={a.path || ""} onChange={(e) => onChange({ path: e.target.value })} placeholder="path（待校验 JSON 文件）" className={cls} />
        <textarea
          value={typeof a.schema === "string" ? a.schema : JSON.stringify(a.schema || {}, null, 2)}
          onChange={(e) => {
            try { onChange({ schema: JSON.parse(e.target.value) }); } catch { onChange({ schema: e.target.value }); }
          }}
          rows={3} placeholder="schema（JSON）" className={cls + " font-mono resize-y"} />
      </div>
    );
  }
  return null;
}
