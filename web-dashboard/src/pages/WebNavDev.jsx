import React, { useMemo, useState } from "react";

const STORAGE_KEY = "web_nav_dev_items_v1";
const ENGINE_KEY = "web_nav_dev_engine";

const SEARCH_ENGINES = [
  { id: "bing", label: "Bing", url: "https://www.bing.com/search?q=" },
  { id: "google", label: "Google", url: "https://www.google.com/search?q=" },
  { id: "github", label: "GitHub", url: "https://github.com/search?q=" },
  { id: "npm", label: "npm", url: "https://www.npmjs.com/search?q=" },
];

const GROUPS = [
  { id: "all", label: "全部", short: "All" },
  { id: "project", label: "工程", short: "Prj" },
  { id: "code", label: "代码", short: "Git" },
  { id: "quality", label: "质量", short: "QA" },
  { id: "design", label: "设计", short: "Des" },
  { id: "docs", label: "文档", short: "Doc" },
];

const DEFAULT_LINKS = [
  { id: "devbench", title: "工程开发", url: "/devbench", group: "project", abbr: "Dev", accent: "#22c55e", pinned: true, note: "故事点开发台" },
  { id: "project-dev", title: "项目开发", url: "/project-dev", group: "project", abbr: "PD", accent: "#38bdf8", pinned: true, note: "项目编排控制台" },
  { id: "feishu-sync", title: "飞书项目同步", url: "/feishu-project-sync", group: "project", abbr: "FS", accent: "#14b8a6", pinned: true, note: "项目字段同步" },
  { id: "tb-tasks", title: "TB 任务", url: "/tb-tasks", group: "project", abbr: "TB", accent: "#f59e0b", pinned: true, note: "任务池" },
  { id: "bug-agent", title: "Bug 分析", url: "/bug-agent", group: "quality", abbr: "Bug", accent: "#ef4444", pinned: true, note: "缺陷分析" },
  { id: "perfetto", title: "Perfetto UI", url: "https://ui.perfetto.dev", group: "quality", abbr: "Pf", accent: "#8b5cf6", pinned: true, note: "性能 trace" },
  { id: "gitlab", title: "GitLab", url: "https://gitlab.com", group: "code", abbr: "Git", accent: "#fc6d26", pinned: true, note: "代码仓库" },
  { id: "github", title: "GitHub", url: "https://github.com", group: "code", abbr: "GH", accent: "#e5e7eb", pinned: false, note: "开源仓库" },
  { id: "chrome-store", title: "Chrome Web Store", url: "https://chromewebstore.google.com", group: "docs", abbr: "CW", accent: "#60a5fa", pinned: false, note: "扩展市场" },
  { id: "figma", title: "Figma", url: "https://www.figma.com", group: "design", abbr: "Fi", accent: "#a78bfa", pinned: false, note: "设计稿" },
  { id: "mdn", title: "MDN Web Docs", url: "https://developer.mozilla.org", group: "docs", abbr: "MDN", accent: "#f8fafc", pinned: false, note: "Web API" },
  { id: "react", title: "React Docs", url: "https://react.dev", group: "docs", abbr: "Re", accent: "#06b6d4", pinned: false, note: "React" },
  { id: "vite", title: "Vite", url: "https://vite.dev", group: "docs", abbr: "V", accent: "#facc15", pinned: false, note: "前端构建" },
  { id: "tailwind", title: "Tailwind CSS", url: "https://tailwindcss.com", group: "docs", abbr: "Tw", accent: "#38bdf8", pinned: false, note: "样式体系" },
  { id: "npm", title: "npm", url: "https://www.npmjs.com", group: "code", abbr: "npm", accent: "#dc2626", pinned: false, note: "包检索" },
];

const EMPTY_DRAFT = {
  title: "",
  url: "",
  group: "project",
  abbr: "",
  accent: "#38bdf8",
  note: "",
  pinned: false,
};

function readLinks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return DEFAULT_LINKS;
}

function writeLinks(items) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:|tel:)/i.test(raw) || raw.startsWith("/")) return raw;
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(raw)) return `http://${raw}`;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(raw)) return `https://${raw}`;
  return "";
}

function openTarget(url) {
  const target = normalizeUrl(url);
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

function titleAbbr(title) {
  const clean = String(title || "").trim();
  if (!clean) return "URL";
  const ascii = clean.match(/[A-Za-z0-9]+/g);
  if (ascii?.length) return ascii.slice(0, 2).map((x) => x[0]).join("").toUpperCase();
  return clean.slice(0, 2);
}

function itemMatches(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return [item.title, item.url, item.note, item.group].some((x) => String(x || "").toLowerCase().includes(q));
}

export default function WebNavDev() {
  const [items, setItems] = useState(readLinks);
  const [activeGroup, setActiveGroup] = useState("all");
  const [query, setQuery] = useState("");
  const [engineId, setEngineId] = useState(() => localStorage.getItem(ENGINE_KEY) || "bing");
  const [draft, setDraft] = useState(null);
  const [editingId, setEditingId] = useState("");
  const [toast, setToast] = useState("");

  const engine = SEARCH_ENGINES.find((x) => x.id === engineId) || SEARCH_ENGINES[0];
  const visibleItems = useMemo(() => {
    return items
      .filter((item) => activeGroup === "all" || item.group === activeGroup)
      .filter((item) => itemMatches(item, query))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(a.title).localeCompare(String(b.title), "zh-CN"));
  }, [items, activeGroup, query]);
  const pinned = useMemo(() => items.filter((x) => x.pinned).slice(0, 14), [items]);

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(""), 2200);
  }

  function updateItems(next) {
    setItems(next);
    writeLinks(next);
  }

  function startAdd() {
    setEditingId("");
    setDraft({ ...EMPTY_DRAFT });
  }

  function startEdit(item) {
    setEditingId(item.id);
    setDraft({ ...EMPTY_DRAFT, ...item });
  }

  function saveDraft() {
    const title = String(draft?.title || "").trim();
    const url = normalizeUrl(draft?.url);
    if (!title || !url) {
      showToast("名称和网址不能为空");
      return;
    }
    const payload = {
      ...draft,
      id: editingId || `link-${Date.now()}`,
      title,
      url,
      abbr: String(draft.abbr || titleAbbr(title)).slice(0, 4),
      note: String(draft.note || "").trim(),
      group: draft.group || "project",
      accent: draft.accent || "#38bdf8",
      pinned: !!draft.pinned,
    };
    const next = editingId ? items.map((x) => (x.id === editingId ? payload : x)) : [payload, ...items];
    updateItems(next);
    setDraft(null);
    showToast(editingId ? "已更新" : "已添加");
  }

  function removeItem(id) {
    const target = items.find((x) => x.id === id);
    if (!target || !window.confirm(`删除「${target.title}」？`)) return;
    updateItems(items.filter((x) => x.id !== id));
    showToast("已删除");
  }

  function togglePinned(id) {
    updateItems(items.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x)));
  }

  function resetDefaults() {
    if (!window.confirm("恢复默认导航并清除自定义项？")) return;
    updateItems(DEFAULT_LINKS);
    showToast("已恢复默认");
  }

  function submitSearch(e) {
    e.preventDefault();
    const value = query.trim();
    if (!value) return;
    openTarget(normalizeUrl(value) || `${engine.url}${encodeURIComponent(value)}`);
  }

  function changeEngine(id) {
    setEngineId(id);
    try { localStorage.setItem(ENGINE_KEY, id); } catch {}
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="absolute inset-0" style={pageBackground} />
      <div className="absolute inset-0 bg-black/35" />

      <div className="relative z-10 flex h-full min-h-0">
        <aside className="hidden w-14 shrink-0 border-r border-white/10 bg-black/35 backdrop-blur sm:flex sm:flex-col sm:items-center sm:py-4">
          <button
            type="button"
            onClick={() => setActiveGroup("all")}
            className={`mb-5 flex h-9 w-9 items-center justify-center rounded-lg border text-xs font-semibold transition ${activeGroup === "all" ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100" : "border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-100"}`}
            title="全部"
          >
            AI
          </button>
          <div className="flex flex-col gap-2">
            {GROUPS.filter((x) => x.id !== "all").map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => setActiveGroup(group.id)}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border text-[10px] font-medium transition ${activeGroup === group.id ? "border-fuchsia-300/60 bg-fuchsia-400/20 text-fuchsia-100" : "border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-100"}`}
                title={group.label}
              >
                {group.short}
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 overflow-auto px-4 py-5 sm:px-8 lg:px-10">
          <header className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="mb-1 text-xs uppercase tracking-[0.28em] text-cyan-200/70">Web Index Studio</div>
              <h1 className="text-2xl font-semibold tracking-normal text-white">网址导航</h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={startAdd} className="inline-flex h-9 items-center gap-2 rounded-lg bg-cyan-500 px-3 text-sm font-medium text-zinc-950 transition hover:bg-cyan-300">
                <PlusIcon />新增网址
              </button>
              <button type="button" onClick={resetDefaults} className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-zinc-300 transition hover:bg-white/10 hover:text-white">
                <ResetIcon />恢复默认
              </button>
            </div>
          </header>

          <section className="mb-16">
            <div className="mb-8 grid grid-cols-3 gap-4 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10">
              {pinned.map((item) => (
                <QuickLaunch key={item.id} item={item} onOpen={() => openTarget(item.url)} />
              ))}
            </div>

            <form onSubmit={submitSearch} className="mx-auto mb-8 max-w-4xl">
              <div className="flex min-h-[76px] items-center gap-3 rounded-lg border border-white/10 bg-zinc-950/70 px-4 shadow-2xl shadow-black/30 backdrop-blur">
                <SearchIcon />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-lg text-zinc-100 outline-none placeholder:text-zinc-500 sm:text-2xl"
                  placeholder="Search the Web"
                />
                <select
                  value={engineId}
                  onChange={(e) => changeEngine(e.target.value)}
                  className="hidden h-9 rounded-lg border border-white/10 bg-black/30 px-2 text-xs text-zinc-300 outline-none sm:block"
                >
                  {SEARCH_ENGINES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
                <button type="submit" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500/90 text-white transition hover:bg-fuchsia-400" title="打开">
                  <ArrowIcon />
                </button>
              </div>
            </form>

            <div className="mx-auto mb-6 flex max-w-5xl flex-wrap justify-center gap-2 sm:hidden">
              {GROUPS.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setActiveGroup(group.id)}
                  className={`h-8 rounded-lg px-3 text-xs transition ${activeGroup === group.id ? "bg-white text-zinc-950" : "bg-white/10 text-zinc-300"}`}
                >
                  {group.label}
                </button>
              ))}
            </div>

            <div className="mx-auto grid max-w-5xl grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7">
              {visibleItems.map((item) => (
                <ShortcutTile
                  key={item.id}
                  item={item}
                  onOpen={() => openTarget(item.url)}
                  onEdit={() => startEdit(item)}
                  onDelete={() => removeItem(item.id)}
                  onPin={() => togglePinned(item.id)}
                />
              ))}
            </div>
          </section>
        </main>
      </div>

      {draft && (
        <EditorModal
          draft={draft}
          setDraft={setDraft}
          editing={!!editingId}
          onClose={() => setDraft(null)}
          onSave={saveDraft}
        />
      )}

      {toast && (
        <div className="pointer-events-none absolute bottom-5 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-white/10 bg-zinc-950/90 px-4 py-2 text-sm text-zinc-200 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function QuickLaunch({ item, onOpen }) {
  return (
    <button type="button" onClick={onOpen} className="group min-w-0 text-center">
      <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-lg bg-white text-lg font-semibold text-zinc-950 shadow-lg shadow-black/25 transition group-hover:-translate-y-0.5 group-hover:shadow-cyan-500/20" style={{ backgroundColor: item.accent, color: contrastColor(item.accent) }}>
        {item.abbr || titleAbbr(item.title)}
      </div>
      <div className="truncate text-xs text-white drop-shadow">{item.title}</div>
    </button>
  );
}

function ShortcutTile({ item, onOpen, onEdit, onDelete, onPin }) {
  return (
    <div className="group relative min-w-0 text-center">
      <button type="button" onClick={onOpen} className="block w-full min-w-0">
        <div className="mx-auto mb-2 flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg bg-white text-xl font-semibold text-zinc-950 shadow-lg shadow-black/30 transition group-hover:-translate-y-0.5 group-hover:shadow-fuchsia-500/20" style={{ backgroundColor: item.accent, color: contrastColor(item.accent) }}>
          {item.abbr || titleAbbr(item.title)}
        </div>
        <div className="truncate text-sm text-white drop-shadow">{item.title}</div>
        {item.note && <div className="mt-0.5 truncate text-[11px] text-zinc-300/80">{item.note}</div>}
      </button>
      <div className="absolute left-1/2 top-1 flex -translate-x-1/2 gap-1 opacity-0 transition group-hover:opacity-100">
        <IconButton title={item.pinned ? "取消置顶" : "置顶"} onClick={onPin}><PinIcon active={item.pinned} /></IconButton>
        <IconButton title="编辑" onClick={onEdit}><EditIcon /></IconButton>
        <IconButton title="删除" onClick={onDelete}><TrashIcon /></IconButton>
      </div>
    </div>
  );
}

function EditorModal({ draft, setDraft, editing, onClose, onSave }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur">
      <div className="w-full max-w-lg rounded-lg border border-white/10 bg-zinc-950 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">{editing ? "编辑网址" : "新增网址"}</h2>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/10 hover:text-white" title="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs text-zinc-400">
            名称
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/60" />
          </label>
          <label className="grid gap-1 text-xs text-zinc-400">
            网址
            <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} className="h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/60" />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="grid gap-1 text-xs text-zinc-400">
              分组
              <select value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} className="h-10 rounded-lg border border-white/10 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/60">
                {GROUPS.filter((x) => x.id !== "all").map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-zinc-400">
              缩写
              <input value={draft.abbr} onChange={(e) => setDraft({ ...draft, abbr: e.target.value })} maxLength={4} className="h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/60" />
            </label>
            <label className="grid gap-1 text-xs text-zinc-400">
              色标
              <input type="color" value={draft.accent} onChange={(e) => setDraft({ ...draft, accent: e.target.value })} className="h-10 rounded-lg border border-white/10 bg-white/5 px-2" />
            </label>
          </div>
          <label className="grid gap-1 text-xs text-zinc-400">
            备注
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className="h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/60" />
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={!!draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} className="h-4 w-4 accent-cyan-400" />
            置顶到顶部常用区
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-white/10 px-4 text-sm text-zinc-300 hover:bg-white/10">取消</button>
          <button type="button" onClick={onSave} className="h-9 rounded-lg bg-cyan-500 px-4 text-sm font-medium text-zinc-950 hover:bg-cyan-300">保存</button>
        </div>
      </div>
    </div>
  );
}

function IconButton({ title, onClick, children }) {
  return (
    <button type="button" title={title} onClick={(e) => { e.stopPropagation(); onClick(); }} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/70 text-zinc-300 backdrop-blur transition hover:bg-white hover:text-zinc-950">
      {children}
    </button>
  );
}

function contrastColor(hex) {
  const value = String(hex || "").replace("#", "");
  if (value.length !== 6) return "#0f172a";
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 165 ? "#111827" : "#ffffff";
}

const pageBackground = {
  backgroundColor: "#09090b",
  backgroundImage: [
    "linear-gradient(to bottom, rgba(20,20,24,0.12), rgba(0,0,0,0.78))",
    "radial-gradient(circle at 12% 16%, rgba(255,255,255,0.82) 0 1px, transparent 1.6px)",
    "radial-gradient(circle at 48% 9%, rgba(255,255,255,0.65) 0 1px, transparent 1.4px)",
    "radial-gradient(circle at 78% 22%, rgba(255,255,255,0.72) 0 1px, transparent 1.5px)",
    "linear-gradient(165deg, rgba(24,24,27,0.92), rgba(63,63,70,0.6) 44%, rgba(9,9,11,0.98) 82%)",
  ].join(", "),
  backgroundSize: "auto, 130px 130px, 180px 180px, 230px 230px, auto",
};

function PlusIcon() {
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>;
}

function ResetIcon() {
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4v6h6M20 20v-6h-6" strokeLinecap="round" strokeLinejoin="round" /><path d="M5.5 15a7 7 0 0 0 11.9 2M18.5 9A7 7 0 0 0 6.6 7" strokeLinecap="round" /></svg>;
}

function SearchIcon() {
  return <svg className="h-9 w-9 shrink-0 text-fuchsia-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" strokeLinecap="round" /></svg>;
}

function ArrowIcon() {
  return <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function PinIcon({ active }) {
  return <svg className={`h-3.5 w-3.5 ${active ? "text-cyan-300" : ""}`} viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="m14 4 6 6-4 1-5 8-2-2 8-5 1-4-6-6 2-2Z" strokeLinejoin="round" /></svg>;
}

function EditIcon() {
  return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" strokeLinejoin="round" /><path d="m14 7 3 3" /></svg>;
}

function TrashIcon() {
  return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CloseIcon() {
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>;
}
