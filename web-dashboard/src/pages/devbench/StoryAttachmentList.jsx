import React, { useMemo, useState } from "react";
import { devbenchApi } from "./api.js";
import useStoryArtifactUrls from "./useStoryArtifactUrls.js";
import {
  classifyStoryMessageUrl,
  isStoryArtifactRef,
  storyMessageFileName,
} from "./storyMessageModel.mjs";
import {
  formatAttachmentSize,
  normalizeStoryAttachment,
} from "./storyAttachmentModel.mjs";

const PREVIEWABLE = new Set(["image", "video", "audio", "pdf", "text"]);

function kindIcon(kind, folder) {
  if (folder) return "📁";
  if (kind === "image") return "🖼️";
  if (kind === "video") return "🎬";
  if (kind === "audio") return "🎧";
  if (kind === "pdf") return "📕";
  if (kind === "text") return "📄";
  return "📎";
}

function PreviewBody({ kind, href, name }) {
  if (!href) return <div className="p-3 text-[11px] text-amber-300">附件预览地址不可用</div>;
  if (kind === "image") {
    return <img src={href} alt={name} className="max-h-[520px] w-full rounded-lg bg-black/30 object-contain" />;
  }
  if (kind === "video") {
    return <video src={href} controls preload="metadata" className="max-h-[520px] w-full rounded-lg bg-black" />;
  }
  if (kind === "audio") {
    return <audio src={href} controls preload="metadata" className="w-full" />;
  }
  if (kind === "pdf" || kind === "text") {
    return (
      <iframe
        src={href}
        title={`预览 ${name}`}
        className={`w-full rounded-lg border border-zinc-700 bg-white ${kind === "pdf" ? "h-[520px]" : "h-72"}`}
      />
    );
  }
  return null;
}

export default function StoryAttachmentList({
  tabId,
  attachments,
  label = "",
  variant = "message",
  onRemove,
  onToast,
  allowReveal = true,
}) {
  const items = useMemo(
    () => Array.from(attachments || []).map(normalizeStoryAttachment).filter((item) => item.relPath || item.preview),
    [attachments],
  );
  const [expanded, setExpanded] = useState("");
  const [revealing, setRevealing] = useState("");
  const artifactRefs = useMemo(
    () => items.map((item) => item.relPath).filter(isStoryArtifactRef),
    [items],
  );
  const authorizedArtifactUrl = useStoryArtifactUrls(tabId, artifactRefs, onToast);
  if (!items.length) return null;

  const reveal = async (attachment) => {
    if (!tabId || !isStoryArtifactRef(attachment.relPath) || revealing) return;
    setRevealing(attachment.id);
    try {
      const result = await devbenchApi.revealStoryArtifact(tabId, attachment.relPath);
      if (!result?.ok) {
        onToast?.(result?.error || "无法打开附件所在位置");
        return;
      }
      onToast?.(`已在资源管理器中定位：${result.data?.name || attachment.name}`);
    } catch (error) {
      onToast?.(`无法打开附件所在位置：${error?.message || error}`);
    } finally {
      setRevealing("");
    }
  };

  return (
    <div
      className={`${variant === "composer" ? "px-2 pt-2" : (["message", "assistant"].includes(variant) ? "mb-2" : "mt-2")}`}
      data-testid={`devbench-attachment-list-${variant}`}
    >
      {label && <div className="mb-1.5 text-[10px] font-medium text-zinc-400">{label}</div>}
      <div
        className={`grid min-w-0 grid-cols-1 gap-2 ${
          variant === "composer" ? "lg:grid-cols-2" : ""
        }`}
      >
        {items.map((attachment, index) => {
          const isArtifact = isStoryArtifactRef(attachment.relPath);
          const artifactHref = isArtifact
            ? authorizedArtifactUrl(attachment.relPath)
            : "";
          const localBlobPreview = /^blob:/i.test(String(attachment.preview || ""))
            ? attachment.preview
            : "";
          const href = isArtifact
            ? (localBlobPreview || artifactHref)
            : (attachment.preview || artifactHref);
          const downloadHref = isArtifact
            ? authorizedArtifactUrl(attachment.relPath, { download: true })
            : href;
          const kind = attachment.kind === "folder" ? "folder" : classifyStoryMessageUrl(attachment.relPath || attachment.name);
          const previewable = attachment.kind !== "folder" && PREVIEWABLE.has(kind) && !!href;
          const isExpanded = expanded === attachment.id;
          const size = formatAttachmentSize(attachment.size);
          return (
            <div
              key={attachment.id}
              className={`min-w-0 overflow-hidden rounded-xl border ${variant === "composer" ? "border-zinc-600 bg-zinc-900/80" : "border-zinc-600/70 bg-zinc-950/35"}`}
              data-testid="devbench-attachment-card"
              data-attachment-name={attachment.name}
            >
              <div className="flex min-w-0 items-center gap-2 p-2">
                {kind === "image" && href ? (
                  <button
                    type="button"
                    onClick={() => setExpanded(isExpanded ? "" : attachment.id)}
                    className="group h-[72px] w-[88px] shrink-0 overflow-hidden rounded-lg border border-zinc-600 bg-black/30"
                    title={isExpanded ? "收起预览" : "展开预览"}
                  >
                    <img src={href} alt={attachment.name} className="h-full w-full object-cover transition group-hover:scale-105" />
                  </button>
                ) : (
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-xl" aria-hidden="true">
                    {kindIcon(kind, attachment.kind === "folder")}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-medium text-zinc-100" title={attachment.name}>{attachment.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-[10px] text-zinc-500">
                    <span>{attachment.kind === "folder" ? `${attachment.fileCount} 个文件` : (size || "附件")}</span>
                    {variant === "message" && <span className="text-emerald-400/80">已随本消息发送</span>}
                    {variant === "assistant" && <span className="text-violet-300/80">AI 交付物</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {previewable && (
                      <button
                        type="button"
                        onClick={() => setExpanded(isExpanded ? "" : attachment.id)}
                        className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-200 transition hover:bg-blue-500/25"
                      >
                        {isExpanded ? "收起" : "预览"}
                      </button>
                    )}
                    {!previewable && attachment.kind !== "folder" && artifactHref && (
                      <a href={artifactHref} target="_blank" rel="noopener noreferrer" className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-200 hover:bg-blue-500/25">打开</a>
                    )}
                    {attachment.kind !== "folder" && downloadHref && (
                      <a
                        href={downloadHref}
                        download={storyMessageFileName(attachment.relPath || attachment.name)}
                        onClick={(event) => event.stopPropagation()}
                        className="rounded bg-zinc-700/70 px-1.5 py-0.5 text-[10px] text-zinc-200 transition hover:bg-zinc-600"
                      >
                        下载
                      </a>
                    )}
                    {allowReveal && isStoryArtifactRef(attachment.relPath) && (
                      <button
                        type="button"
                        onClick={() => reveal(attachment)}
                        disabled={!!revealing}
                        className="rounded bg-zinc-700/70 px-1.5 py-0.5 text-[10px] text-zinc-200 transition hover:bg-zinc-600 disabled:opacity-50"
                      >
                        {revealing === attachment.id ? "定位中…" : "打开位置"}
                      </button>
                    )}
                    {onRemove && (
                      <button
                        type="button"
                        onClick={() => onRemove(attachment, index)}
                        className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300 transition hover:bg-red-500/20"
                      >
                        移除
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {isExpanded && previewable && (
                <div className="border-t border-zinc-700/70 bg-zinc-950/60 p-2" data-testid="devbench-attachment-preview">
                  <PreviewBody kind={kind} href={href} name={attachment.name} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
