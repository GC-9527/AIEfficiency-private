import React from "react";
import {
  WORKSPACE_BUNDLE_EDITABLE,
  WORKSPACE_BUNDLE_READ_ONLY,
  emptyWorkspaceBundle,
  workspaceBundleDraftError,
} from "./workspaceBundleModel.mjs";

const fieldClass = "min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200 outline-none focus:border-sky-500 disabled:opacity-50";

export default function WorkspaceBundleEditor({ definition, definitions, disabled, onChange }) {
  const bundle = definition?.workspaceBundle;
  const enabled = bundle?.enabled === true;
  const definitionId = String(definition?.id || "").trim();
  const members = Array.isArray(bundle?.members) ? bundle.members : [];
  const error = workspaceBundleDraftError(bundle, definitions, definitionId);
  const updateBundle = (patch) => onChange?.({ ...bundle, ...patch, enabled: true });
  const updateMember = (index, patch) => updateBundle({
    members: members.map((member, memberIndex) => memberIndex === index ? { ...member, ...patch } : member),
  });
  const addMember = () => {
    const used = new Set(members.map((member) => member.repositoryId));
    const repositoryId = (definitions || []).find((candidate) => !used.has(candidate.id))?.id || "";
    updateBundle({
      members: [...members, {
        repositoryId,
        checkoutDirName: "",
        required: true,
        mode: WORKSPACE_BUNDLE_READ_ONLY,
      }],
    });
  };

  return (
    <section data-testid="workspace-bundle-editor" className="rounded-lg border border-sky-900/60 bg-sky-950/15 p-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className={`flex items-center gap-2 text-[10px] text-zinc-300 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            data-testid="workspace-bundle-enabled"
            disabled={disabled}
            checked={enabled}
            onChange={(event) => onChange?.(event.target.checked ? emptyWorkspaceBundle(definitionId) : null)}
          />
          固定兄弟目录 Bundle
        </label>
        <span className="text-[9px] text-zinc-600">同一故事点父目录 · 固定成员目录名 · 相同逻辑分支</span>
        {enabled && <span className="ml-auto rounded border border-sky-700/50 px-1.5 py-0.5 text-[9px] text-sky-300">Bundle V2</span>}
      </div>

      {enabled && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(180px,0.7fr)_minmax(220px,1fr)_minmax(220px,1fr)]">
            <label className="min-w-0">
              <span className="mb-1 block text-[9px] text-zinc-600">Bundle ID</span>
              <input data-testid="workspace-bundle-id" className={`${fieldClass} w-full font-mono`} disabled={disabled} value={bundle.id || ""} onChange={(event) => updateBundle({ id: event.target.value })} />
            </label>
            <div className="min-w-0">
              <span className="mb-1 block text-[9px] text-zinc-600">构建入口</span>
              <div className="truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300" title={definitionId}>{definition.name || definitionId}</div>
            </div>
            <div className="min-w-0">
              <span className="mb-1 block text-[9px] text-zinc-600">策略</span>
              <div className="truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-400">SAME_PARENT_SIBLINGS · SAME_LOGICAL_BRANCH</div>
            </div>
          </div>

          <div className="space-y-1.5">
            {members.map((member, index) => {
              const isBuildEntry = member.repositoryId === definitionId
                && index === members.findIndex((candidate) => candidate.repositoryId === definitionId);
              return (
                <div key={`${member.repositoryId || "member"}-${index}`} data-testid="workspace-bundle-member" className="grid grid-cols-1 gap-2 rounded border border-zinc-800 bg-zinc-950/60 p-2 sm:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_120px_90px_auto] sm:items-end">
                  <label className="min-w-0">
                    <span className="mb-1 block text-[9px] text-zinc-600">成员仓库</span>
                    <select data-testid={`workspace-bundle-member-repository-${index}`} className={`${fieldClass} w-full`} disabled={disabled || isBuildEntry} value={member.repositoryId || ""} onChange={(event) => updateMember(index, { repositoryId: event.target.value })}>
                      <option value="">请选择仓库</option>
                      {(definitions || []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.id}</option>)}
                    </select>
                  </label>
                  <label className="min-w-0">
                    <span className="mb-1 block text-[9px] text-zinc-600">固定目录名（区分大小写）</span>
                    <input data-testid={`workspace-bundle-member-directory-${index}`} className={`${fieldClass} w-full font-mono`} disabled={disabled} value={member.checkoutDirName || ""} onChange={(event) => updateMember(index, { checkoutDirName: event.target.value })} placeholder="AppMarketWeb" />
                  </label>
                  <label>
                    <span className="mb-1 block text-[9px] text-zinc-600">模式</span>
                    <select data-testid={`workspace-bundle-member-mode-${index}`} className={`${fieldClass} w-full`} disabled={disabled || isBuildEntry} value={member.mode || WORKSPACE_BUNDLE_EDITABLE} onChange={(event) => updateMember(index, { mode: event.target.value })}>
                      <option value={WORKSPACE_BUNDLE_EDITABLE}>可修改</option>
                      <option value={WORKSPACE_BUNDLE_READ_ONLY}>只读依赖</option>
                    </select>
                  </label>
                  <label className={`flex h-[26px] items-center gap-2 text-[10px] text-zinc-400 ${disabled || isBuildEntry ? "opacity-60" : "cursor-pointer"}`}>
                    <input type="checkbox" data-testid={`workspace-bundle-member-required-${index}`} disabled={disabled || isBuildEntry} checked={member.required !== false} onChange={(event) => updateMember(index, { required: event.target.checked })} />
                    必需
                  </label>
                  <button type="button" data-testid={`workspace-bundle-member-remove-${index}`} disabled={disabled || isBuildEntry} onClick={() => updateBundle({ members: members.filter((_, memberIndex) => memberIndex !== index) })} className="rounded px-2 py-1 text-[10px] text-zinc-600 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-30">移除</button>
                </div>
              );
            })}
          </div>
          {!disabled && <button type="button" data-testid="workspace-bundle-add-member" onClick={addMember} className="rounded border border-dashed border-sky-800/70 px-2.5 py-1 text-[10px] text-sky-300 hover:bg-sky-950/40">＋ 添加成员仓库</button>}
          {error && <p role="alert" className="text-[10px] text-amber-300">{error}</p>}
        </div>
      )}
    </section>
  );
}
