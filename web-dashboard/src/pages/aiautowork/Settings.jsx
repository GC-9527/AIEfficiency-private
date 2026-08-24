// AI 工作台 — 工作台设置。
// 11 组配置：并发 / 路由阈值 / 自动修复 / 批量 / Feature Flag / 权限 / 通知 / 审计。
// 风格：紧凑分组卡片 + 实时保存 + 审计回显。

import React, { useEffect, useState } from "react";
import api from "./api.js";

function GroupCard({ groupId, label, items, onChange }) {
  return (
    <section className="bg-[#18181b] border border-zinc-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-zinc-200 mb-3">{label}</h3>
      <div className="space-y-2">
        {items.map((it) => (
          <div key={it.key} className="flex items-center gap-3 text-xs">
            <div className="w-1/3 text-zinc-400 font-mono truncate" title={it.key}>{it.key}</div>
            <input
              type="text"
              value={JSON.stringify(it.value)}
              onChange={(e) => onChange(groupId, it.key, e.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 font-mono text-xs"
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Settings() {
  const [groups, setGroups] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const r = await api.getSettings();
        if (!cancel) setGroups(r.groups || {});
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    }
    load();
  }, []);

  const onChange = (groupId, key, textValue) => {
    let parsed;
    try { parsed = JSON.parse(textValue); } catch { parsed = textValue; }
    setGroups((prev) => {
      const next = { ...prev };
      next[groupId] = {
        ...next[groupId],
        keys: next[groupId].keys.map((it) => it.key === key ? { ...it, value: parsed } : it),
      };
      return next;
    });
  };

  const save = async () => {
    setSaving(true); setMsg(null); setError(null);
    try {
      const patch = {};
      for (const group of Object.values(groups)) {
        for (const it of group.keys || []) {
          patch[it.key] = it.value;
        }
      }
      await api.updateSettings(patch, { reason: "settings page save" });
      setMsg("已保存");
      setTimeout(() => setMsg(null), 2500);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">工作台设置</h1>
        <div className="flex items-center gap-3">
          {msg && <span className="text-xs text-green-300">{msg}</span>}
          {error && <span className="text-xs text-red-300">{error}</span>}
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white transition"
          >
            {saving ? "保存中..." : "保存所有变更"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Object.entries(groups).map(([groupId, group]) => (
          <GroupCard
            key={groupId}
            groupId={groupId}
            label={group.label}
            items={group.keys || []}
            onChange={onChange}
          />
        ))}
      </div>

      <div className="text-xs text-zinc-600">
        提示：服务端单一来源；前端仅提交。审计事件已记入 <code className="font-mono text-zinc-400">config_audit_events</code>。
      </div>
    </div>
  );
}
