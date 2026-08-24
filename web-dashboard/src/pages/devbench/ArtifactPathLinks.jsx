import React, { useMemo, useState } from "react";
import { devbenchApi } from "./api.js";
import {
  extractInstallPackagePaths,
  installPackageName,
} from "./artifactPathModel.mjs";

export default function ArtifactPathLinks({ tabId, content, onToast }) {
  const paths = useMemo(() => extractInstallPackagePaths(content), [content]);
  const [opening, setOpening] = useState("");
  if (!tabId || !paths.length) return null;

  const openArtifact = async (artifactPath) => {
    if (opening) return;
    setOpening(artifactPath);
    try {
      const result = await devbenchApi.openArtifact(tabId, artifactPath);
      if (!result?.ok) {
        onToast?.(result?.error || "安装包不存在或不属于当前故事点");
        return;
      }
      onToast?.(`已在资源管理器中定位：${result.data?.name || installPackageName(artifactPath)}`);
    } finally {
      setOpening("");
    }
  };

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-2"
      data-testid="devbench-install-package-links"
    >
      <div className="text-[10px] font-medium tracking-wide text-emerald-300/80">📦 安装包产物</div>
      {paths.map((artifactPath) => (
        <button
          type="button"
          key={artifactPath}
          onClick={() => openArtifact(artifactPath)}
          disabled={!!opening}
          className="flex w-full min-w-0 items-center gap-2 rounded border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-2 text-left transition hover:border-emerald-500/50 hover:bg-emerald-950/35 disabled:cursor-wait disabled:opacity-60"
          title={`在资源管理器中定位：${artifactPath}`}
          data-testid="devbench-install-package-link"
        >
          <span className="shrink-0 text-sm" aria-hidden="true">↗</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-medium text-zinc-200">{installPackageName(artifactPath)}</span>
            <span className="block truncate font-mono text-[10px] text-zinc-500">{artifactPath}</span>
          </span>
          <span className="shrink-0 text-[10px] text-emerald-300">
            {opening === artifactPath ? "打开中…" : "资源管理器"}
          </span>
        </button>
      ))}
    </div>
  );
}
