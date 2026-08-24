/**
 * 钉钉消息配置弹窗（仅管理员）——配置各场景钉钉消息的细节，存为预置、局域网多端同步。
 * 当前仅「发布生产」场景：有签名 / 没签名 各自要 @ 的人（姓名 + 手机号，手机号用于真 @）。
 * 结构：{ publish: { signed:[{name,mobile}], unsigned:[{name,mobile}] } }（后续可加更多场景）。
 */
import React, { useEffect, useState } from "react";
import { devbenchApi } from "./api.js";
import { useIsAdmin } from "../../services/adminAuth.js";

// === 钉钉消息配置缓存：模块级内存 + localStorage，重开弹窗不闪"加载中…" ===
const DT_MSG_CFG_CACHE_KEY = "devbench_dingtalk_msg_config_cache_v1";
let dtMsgCfgMemory = null;
let dtMsgCfgMemoryLoaded = false;
function loadDtMsgCfgMemory() {
  if (dtMsgCfgMemoryLoaded) return;
  dtMsgCfgMemoryLoaded = true;
  try { const raw = localStorage.getItem(DT_MSG_CFG_CACHE_KEY); if (raw) dtMsgCfgMemory = JSON.parse(raw) || null; } catch { dtMsgCfgMemory = null; }
}
function saveDtMsgCfgMemory(cfg) {
  dtMsgCfgMemory = cfg || null;
  try { localStorage.setItem(DT_MSG_CFG_CACHE_KEY, JSON.stringify(cfg ?? {})); } catch { /* ignore */ }
}
function readDtMsgCfgMemory() {
  loadDtMsgCfgMemory();
  return dtMsgCfgMemory;
}

function AtList({ title, hint, list, onChange, isAdmin }) {
  const set = (i, patch) => onChange(list.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const add = () => onChange([...list, { name: "", mobile: "" }]);
  const del = (i) => onChange(list.filter((_, k) => k !== i));
  return (
    <div className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-800/20">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-zinc-200">{title}</span>
        <span className="text-[10px] text-zinc-500">{hint}</span>
        {isAdmin && <button onClick={add} className="ml-auto text-[11px] px-2 py-0.5 rounded bg-emerald-700/40 border border-emerald-700/50 text-emerald-200 hover:bg-emerald-700/60">＋ 添加人</button>}
      </div>
      {list.length === 0 && <div className="text-[11px] text-zinc-600">不 @ 任何人（消息不带 @ 行）。</div>}
      {list.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <input value={p.name} disabled={!isAdmin} onChange={(e) => set(i, { name: e.target.value })}
            placeholder="姓名（如 付浩）"
            className="w-32 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none disabled:opacity-60" />
          <input value={p.mobile} disabled={!isAdmin} onChange={(e) => set(i, { mobile: e.target.value.replace(/[^\d]/g, "") })}
            placeholder="手机号（11位，真 @ 用）"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono disabled:opacity-60" />
          {isAdmin && <button onClick={() => del(i)} className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300">×</button>}
        </div>
      ))}
    </div>
  );
}

export default function DingtalkMsgConfigModal({ onClose, onToast }) {
  const { isAdmin } = useIsAdmin();
  // 初始化优先用缓存：有缓存则即时渲染、不闪"加载中…"，后台再刷新
  const cachedOnMount = readDtMsgCfgMemory();
  const [cfg, setCfg] = useState(() => cachedOnMount ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    devbenchApi.getDingtalkMsgConfig().then((r) => {
      if (r.ok) { setCfg(r.data || {}); saveDtMsgCfgMemory(r.data || {}); }
      else { onToast?.(r.error || "读取失败"); setCfg({ publish: { signed: [], unsigned: [] } }); }
    });
  }, []); // eslint-disable-line

  const pub = cfg?.publish || { signed: [], unsigned: [] };
  const setPub = (patch) => setCfg((c) => ({ ...c, publish: { ...pub, ...patch } }));

  async function save() {
    setBusy(true);
    const r = await devbenchApi.setDingtalkMsgConfig(cfg);
    setBusy(false);
    if (r.ok) { onToast?.("已保存钉钉消息配置（已同步到局域网各端）"); const next = r.config || cfg; setCfg(next); saveDtMsgCfgMemory(next); }
    else onToast?.(r.error || "保存失败");
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[680px] max-h-[88vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">📨 钉钉消息配置</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">配置各场景钉钉消息细节，保存为预置、局域网多设备/客户端/服务端自动同步。{!isAdmin && " 🔒 仅管理员可编辑"}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="text-[12px] font-medium text-zinc-300">发布生产 · 出包钉钉消息要 @ 的人</div>
          {!cfg ? (
            <div className="text-[12px] text-zinc-500 py-6 text-center">加载中…</div>
          ) : (
            <>
              <AtList title="有签名（正常发布）" hint="needsResign=否时 @ 这些人"
                list={pub.signed || []} onChange={(l) => setPub({ signed: l })} isAdmin={isAdmin} />
              <AtList title="没签名（需重新签名 _未签名）" hint="needsResign=是时 @ 这些人；留空则不 @"
                list={pub.unsigned || []} onChange={(l) => setPub({ unsigned: l })} isAdmin={isAdmin} />
              <p className="text-[10px] text-zinc-600">手机号用于钉钉「真 @」（必须是本人在该出包群里的账号绑定号）；留空则只显示 @姓名 文本、不会真正提醒。也可改配钉钉应用凭证按姓名自动解析手机号。</p>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">关闭</button>
          {isAdmin && <button onClick={save} disabled={busy || !cfg} className="px-4 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white">{busy ? "保存中…" : "保存预置"}</button>}
        </div>
      </div>
    </div>
  );
}
