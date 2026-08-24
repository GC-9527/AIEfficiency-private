import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { isMailtoHref } from "./markdownLinkModel.mjs";

function fallbackFileName(url) {
  const source = String(url || "").split(/[?#]/, 1)[0];
  const name = source.slice(source.lastIndexOf("/") + 1);
  if (!name) return "打开文件";
  try { return decodeURIComponent(name); } catch { return name; }
}

export default function Markdown({
  children,
  className = "",
  breaks = false,
  resolveUrl,
  onOpenLink,
  richMedia = false,
  classifyUrl,
  fileName,
  resolveDownloadUrl,
}) {
  // breaks=true 时单个换行也渲染为 <br>（修复 Claude 分段回答单换行被折叠的问题）
  const plugins = breaks ? [remarkGfm, remarkBreaks] : [remarkGfm];
  const anchorProps = (href, props = {}) => ({
    ...props,
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event) => {
      if (!href) {
        event.preventDefault();
        return;
      }
      try {
        if (onOpenLink?.(href, event) === true) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    },
  });
  const openLabel = (href, content) => {
    const visible = React.Children.toArray(content).some((item) => String(item || "").trim());
    return visible ? content : (fileName?.(href) || fallbackFileName(href));
  };
  const downloadUrl = (href) => {
    try { return String(resolveDownloadUrl?.(href) || href || ""); }
    catch { return String(href || ""); }
  };
  const mediaActions = (href, label, { canPreview = true } = {}) => (
    <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
      {canPreview && (
        <a {...anchorProps(href)} className="rounded bg-blue-500/15 px-2 py-1 text-blue-200 no-underline transition hover:bg-blue-500/25">
          新窗口预览 ↗
        </a>
      )}
      <a
        href={downloadUrl(href)}
        target="_blank"
        rel="noopener noreferrer"
        download={fileName?.(href) || fallbackFileName(href)}
        className="rounded bg-zinc-700/80 px-2 py-1 text-zinc-100 no-underline transition hover:bg-zinc-600"
      >
        下载 {label ? `· ${label}` : ""}
      </a>
    </span>
  );
  const richImage = (href, label, props = {}) => {
    // mailto 图片链接同样降级为纯文本：堵住“新窗口预览 / 下载”等可点击路径唤起邮箱的可能
    if (isMailtoHref(href)) {
      return (
        <span className="story-rich-media my-2 block max-w-full text-[11px] text-zinc-500">
          邮箱地址（已禁用打开）：{String(label || fileName?.(href) || "邮件")}
        </span>
      );
    }
    return (
      <span className="story-rich-media my-2 block max-w-full">
        {href ? (
          <details className="group max-w-full overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950/60" data-story-media="image">
            <summary className="flex cursor-pointer list-none items-center gap-2 p-2 text-[11px] text-zinc-200 marker:content-none">
              <img
                {...props}
                src={href}
                alt={String(label || fileName?.(href) || "图片")}
                loading={props.loading || "lazy"}
                className="h-20 w-28 shrink-0 rounded-lg border border-zinc-700 bg-black/30 object-cover"
              />
              <span className="min-w-0 flex-1 break-all">{label || fileName?.(href) || "图片"}</span>
              <span className="shrink-0 text-blue-300 group-open:hidden">展开预览</span>
              <span className="hidden shrink-0 text-blue-300 group-open:inline">收起</span>
            </summary>
            <span className="block border-t border-zinc-700/70 p-2">
              <img
                {...props}
                src={href}
                alt={String(label || fileName?.(href) || "图片")}
                loading={props.loading || "lazy"}
                className="max-h-[520px] w-full rounded-lg bg-black/30 object-contain"
              />
              {mediaActions(href, String(label || fileName?.(href) || "图片"))}
            </span>
          </details>
        ) : (
          <span className="text-xs text-red-300">图片地址不可用</span>
        )}
      </span>
    );
  };
  const components = {
    table: ({ node, ...props }) => (
      <div className="my-2 max-w-full overflow-x-auto rounded border border-zinc-700/70">
        <table {...props} className="!m-0 min-w-full" />
      </div>
    ),
    a: ({ node, href = "", children: linkChildren, ...props }) => {
      // 内部工具不唤起系统邮箱客户端：remark-gfm 会自动把文本中的邮箱 autolink 成
      // mailto 链接（如 git 作者邮箱、AI 回复里的 xxx@yyy），点击会打开本机邮件应用——
      // 用户反馈的“一直打开邮箱”即由此产生。mailto 一律降级为纯文本，不再可点击。
      if (isMailtoHref(href)) {
        const address = String(href || "").replace(/^mailto:/i, "").split(/[?#]/, 1)[0].trim();
        const visibleText = React.Children.toArray(linkChildren).map((c) => String(c || "")).join("").trim();
        // 显式 [文本](mailto:addr) 时收件人不可见，补上地址便于阅读/复制；autolink（文本即地址）不重复
        const showAddress = Boolean(address) && visibleText !== address;
        return (
          <span className="break-all text-zinc-300" title="邮箱地址（已禁用点击唤起邮件客户端）">
            {linkChildren}
            {showAddress && <span className="text-zinc-500">（{address}）</span>}
          </span>
        );
      }
      const kind = richMedia && href ? (classifyUrl?.(href) || "file") : "";
      if (kind === "image") {
        return richImage(href, openLabel(href, linkChildren), props);
      }
      if (kind === "video") {
        return (
          <details className="story-rich-media group my-2 block max-w-full rounded-xl border border-zinc-700 bg-zinc-950/70 p-2">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-200">🎬 {openLabel(href, linkChildren)} · <span className="text-blue-300 group-open:hidden">展开预览</span><span className="hidden text-blue-300 group-open:inline">收起</span></summary>
            <video src={href} controls preload="metadata" className="mt-2 max-h-[520px] w-full rounded bg-black">
              当前浏览器不支持视频播放。
            </video>
            {mediaActions(href, fileName?.(href) || "视频")}
          </details>
        );
      }
      if (kind === "audio") {
        return (
          <details className="story-rich-media group my-2 block max-w-full rounded-xl border border-zinc-700 bg-zinc-950/70 p-2">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-200">🎧 {openLabel(href, linkChildren)} · <span className="text-blue-300 group-open:hidden">展开预览</span><span className="hidden text-blue-300 group-open:inline">收起</span></summary>
            <audio src={href} controls preload="metadata" className="mt-2 w-full">
              当前浏览器不支持音频播放。
            </audio>
            {mediaActions(href, fileName?.(href) || "音频")}
          </details>
        );
      }
      if (kind === "pdf" || kind === "text") {
        return (
          <details className="story-rich-media group my-2 block max-w-full rounded-xl border border-zinc-700 bg-zinc-950/70 p-2" data-story-media={kind}>
            <summary className="cursor-pointer select-none text-[11px] text-zinc-200">{kind === "pdf" ? "📕" : "📄"} {openLabel(href, linkChildren)} · <span className="text-blue-300 group-open:hidden">展开预览</span><span className="hidden text-blue-300 group-open:inline">收起</span></summary>
            <iframe
              src={href}
              title={String(fileName?.(href) || "附件预览")}
              className={`mt-2 w-full rounded-lg border border-zinc-700 bg-white ${kind === "pdf" ? "h-[520px]" : "h-72"}`}
            />
            {mediaActions(href, fileName?.(href) || "附件")}
          </details>
        );
      }
      if (kind === "file") {
        return (
          <span className="story-rich-media my-1 flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-[12px] text-zinc-200" data-story-media="file">
            <span className="shrink-0 text-base" aria-hidden="true">📎</span>
            <span className="min-w-0 flex-1 break-all">{openLabel(href, linkChildren)}</span>
            {mediaActions(href, fileName?.(href) || "附件")}
          </span>
        );
      }
      return (
        <a
          {...anchorProps(href, props)}
          className="break-all text-blue-400 underline decoration-blue-400/60 underline-offset-2 hover:text-blue-300"
        >
          {linkChildren}
        </a>
      );
    },
    img: ({ node, src = "", alt = "", ...props }) => richImage(src, alt || fileName?.(src) || "图片", props),
  };
  return (
    <div className={`report-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        {...(resolveUrl ? { urlTransform: resolveUrl } : {})}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
