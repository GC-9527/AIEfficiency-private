import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * 常驻开发工具坞。子组件通过 Portal 进入展开态插槽；收起时只保留右侧把手。
 * 展开状态保存在 localStorage，也可由全局事件临时隐藏或强制收起。
 */
const DockContext = createContext(null);
export function useDockSlot() { return useContext(DockContext); }

const LS_KEY = "floating_dock_collapsed";

export default function FloatingDock({ children }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === "1"; } catch { return false; }
  });
  const [suppressed, setSuppressed] = useState(false);
  const [slot, setSlot] = useState(null);
  const slotRef = useCallback((element) => setSlot(element), []);
  const toggle = () => setCollapsed((current) => {
    const next = !current;
    try { localStorage.setItem(LS_KEY, next ? "1" : "0"); } catch {}
    return next;
  });

  useEffect(() => {
    const sync = () => {
      try { setCollapsed(localStorage.getItem(LS_KEY) === "1"); } catch {}
    };
    const collapse = () => {
      try { localStorage.setItem(LS_KEY, "1"); } catch {}
      setCollapsed(true);
    };
    const onStorage = (event) => { if (event.key === LS_KEY) sync(); };
    const hide = () => setSuppressed(true);
    const show = () => setSuppressed(false);
    window.addEventListener("storage", onStorage);
    window.addEventListener("floating-dock:collapse", collapse);
    window.addEventListener("floating-dock:hide", hide);
    window.addEventListener("floating-dock:show", show);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("floating-dock:collapse", collapse);
      window.removeEventListener("floating-dock:hide", hide);
      window.removeEventListener("floating-dock:show", show);
    };
  }, []);

  return (
    <DockContext.Provider value={collapsed || suppressed ? null : slot}>
      {children}
      {!suppressed && (collapsed ? (
        <button
          id="floating-dock"
          data-ui-layer="dock"
          type="button"
          onClick={toggle}
          title="展开开发工具"
          aria-label="展开开发工具"
          className="floating-dock floating-dock__toggle fixed right-0 bottom-24 hidden flex-col items-center gap-1 px-1.5 py-3 rounded-l-lg border-r-0 sm:flex"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="M14.7 6.3a4 4 0 01-5 5L4 17l3 3 5.7-5.7a4 4 0 005-5l-2.3 2.3-3-3L14.7 6.3z" />
          </svg>
          <span className="text-[10px] tracking-wide [writing-mode:vertical-rl]">工具</span>
          <span aria-hidden="true" className="text-xs leading-none">‹</span>
        </button>
      ) : (
        <aside
          id="floating-dock"
          data-ui-layer="dock"
          aria-label="开发工具"
          className="floating-dock fixed right-3 bottom-24 hidden w-[148px] flex-col items-stretch gap-2 p-2 rounded-xl sm:flex"
        >
          <div className="flex items-center gap-1">
            <span className="floating-dock__eyebrow px-0.5">开发工具</span>
            <button
              type="button"
              onClick={toggle}
              title="收起到右侧"
              className="floating-dock__toggle ml-auto text-[10px] px-1"
            >
              收起 ›
            </button>
          </div>
          <div ref={slotRef} className="flex flex-col items-stretch gap-2" />
        </aside>
      ))}
    </DockContext.Provider>
  );
}
