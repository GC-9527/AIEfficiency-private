import React, { useEffect, useMemo, useState } from "react";
import { getApiUrl } from "../../services/gateway.js";
import Markdown from "../../components/Markdown.jsx";

// 教程 Wiki：左侧文档树（按分组）+ 右侧 markdown 渲染（参考开源 wiki：可搜索、TOC 锚点）
export default function TutorialWiki() {
  const [docs, setDocs] = useState([]);
  const [active, setActive] = useState(null); // slug
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch(getApiUrl("/api/help/docs")).then((r) => r.json()).then((d) => {
      if (d.ok && d.data?.length) { setDocs(d.data); setActive(d.data[0].slug); }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    fetch(getApiUrl(`/api/help/docs/${active}`)).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.data.content : `# 加载失败\n\n${d.error || ""}`);
    }).catch((e) => setContent(`# 加载失败\n\n${e.message}`)).finally(() => setLoading(false));
  }, [active]);

  const groups = useMemo(() => {
    const filtered = docs.filter((d) => !q.trim() || d.title.toLowerCase().includes(q.toLowerCase()));
    const m = {};
    for (const d of filtered) (m[d.group] = m[d.group] || []).push(d);
    return m;
  }, [docs, q]);

  // 抽取标题作为右侧 TOC
  const toc = useMemo(() => {
    return (content.match(/^#{1,3}\s+.+$/gm) || []).map((h) => {
      const level = h.match(/^#+/)[0].length;
      return { level, text: h.replace(/^#+\s+/, "").trim() };
    }).filter((t) => t.level >= 2);
  }, [content]);

  return (
    <div className="flex h-full">
      {/* 左：文档树 */}
      <div className="w-60 shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="p-3 border-b border-zinc-800">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文档…"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none" />
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {Object.entries(groups).map(([g, items]) => (
            <div key={g}>
              <div className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider px-2 mb-1">{g}</div>
              {items.map((d) => (
                <button key={d.slug} onClick={() => setActive(d.slug)}
                  className={`block w-full text-left px-2 py-1.5 rounded text-[12px] truncate transition ${active === d.slug ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"}`}
                  title={d.title}>{d.title}</button>
              ))}
            </div>
          ))}
          {!docs.length && <div className="text-[11px] text-zinc-600 px-2">暂无文档</div>}
        </div>
      </div>

      {/* 中：内容 */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? <div className="text-zinc-500 text-sm">加载中…</div> : <Markdown breaks>{content}</Markdown>}
      </div>

      {/* 右：本页大纲 */}
      {toc.length > 0 && (
        <div className="w-52 shrink-0 border-l border-zinc-800 p-4 overflow-y-auto hidden xl:block">
          <div className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-2">本页大纲</div>
          <div className="space-y-1">
            {toc.map((t, i) => (
              <div key={i} className={`text-[11px] text-zinc-500 truncate ${t.level === 3 ? "pl-3" : ""}`} title={t.text}>{t.text}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
