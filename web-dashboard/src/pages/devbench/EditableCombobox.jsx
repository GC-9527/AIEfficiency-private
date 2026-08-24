import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const OPEN_EVENT = "aiefficiency:editable-combobox-open";

function text(value) {
  return String(value ?? "").trim();
}

function normalizeOptions(options) {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(options) ? options : []) {
    const row = item && typeof item === "object"
      ? {
        value: text(item.value ?? item.id ?? item.name),
        label: text(item.label ?? item.name ?? item.value ?? item.id),
        description: text(item.description ?? item.detail ?? item.gitUrl),
      }
      : { value: text(item), label: text(item), description: "" };
    if (!row.value) continue;
    const key = row.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, label: row.label || row.value });
  }
  return rows;
}

export default function EditableCombobox({
  testId,
  value,
  options,
  onChange,
  onSelect,
  onBlur,
  onKeyDown,
  disabled = false,
  className = "",
  placeholder = "",
  ariaLabel = "",
  inputMode,
  popupClassName = "z-[120]",
  footerText = "可直接输入新值；点击候选即可选择",
}) {
  const anchorRef = useRef(null);
  const inputRef = useRef(null);
  const popupRef = useRef(null);
  const instanceIdRef = useRef(Symbol(testId));
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState(null);
  const normalizedOptions = useMemo(() => normalizeOptions(options), [options]);
  const query = text(value).toLowerCase();
  const visibleOptions = useMemo(() => {
    if (showAll || !query) return normalizedOptions;
    return normalizedOptions.filter((row) => (
      row.value.toLowerCase().includes(query)
      || row.label.toLowerCase().includes(query)
      || row.description.toLowerCase().includes(query)
    ));
  }, [normalizedOptions, query, showAll]);
  const listboxId = `${testId}-listbox`;

  function updatePosition() {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === "undefined") return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 180), Math.max(180, viewportWidth - 16));
    const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
    const below = Math.max(0, viewportHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const placement = below >= 180 || below >= above ? "bottom" : "top";
    const available = placement === "bottom" ? below : above;
    setPosition({
      left,
      width,
      placement,
      top: rect.bottom + 4,
      bottom: viewportHeight - rect.top + 4,
      maxHeight: Math.max(80, Math.min(240, available - 66)),
    });
  }

  useEffect(() => {
    const handleAnotherComboboxOpen = (event) => {
      if (event.detail !== instanceIdRef.current) setOpen(false);
    };
    document.addEventListener(OPEN_EVENT, handleAnotherComboboxOpen);
    return () => document.removeEventListener(OPEN_EVENT, handleAnotherComboboxOpen);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    const handleOutside = (event) => {
      if (anchorRef.current?.contains(event.target) || popupRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const selected = visibleOptions.findIndex((row) => row.value === text(value));
    setActiveIndex(selected >= 0 ? selected : 0);
  }, [open, showAll, value, visibleOptions]);

  function openMenu(all = true) {
    if (disabled) return;
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: instanceIdRef.current }));
    setShowAll(all);
    setOpen(true);
  }

  function choose(row) {
    if (!row) return;
    onChange?.(row.value);
    onSelect?.(row.value, row);
    setOpen(false);
    setShowAll(true);
    inputRef.current?.focus();
  }

  function handleInputKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu(true);
        setActiveIndex(0);
      } else if (visibleOptions.length) {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + direction + visibleOptions.length) % visibleOptions.length);
      }
      return;
    }
    if (event.key === "Enter" && open && visibleOptions[activeIndex]) {
      event.preventDefault();
      choose(visibleOptions[activeIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    onKeyDown?.(event);
  }

  const popup = open && position && typeof document !== "undefined" ? createPortal(
    <div
      ref={popupRef}
      id={listboxId}
      role="listbox"
      data-testid={`${testId}-options`}
      className={`fixed ${popupClassName} overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/70`}
      style={{
        left: position.left,
        width: position.width,
        ...(position.placement === "top" ? { bottom: position.bottom } : { top: position.top }),
      }}
    >
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/90 px-2.5 py-1.5 text-[9px] text-zinc-500">
        <span>已配置选项</span>
        <span>{normalizedOptions.length} 项</span>
      </div>
      <div className="overflow-y-auto p-1" style={{ maxHeight: position.maxHeight }}>
        {visibleOptions.length ? visibleOptions.map((row, index) => {
          const selected = row.value === text(value);
          const active = index === activeIndex;
          return (
            <button
              key={row.value}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={selected}
              data-combobox-value={row.value}
              data-testid={`${testId}-option-${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(row)}
              className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition ${active ? "bg-cyan-950/70 text-cyan-100" : "text-zinc-300 hover:bg-zinc-900"}`}
              title={[row.label, row.description].filter(Boolean).join(" · ")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10px]">{row.label}</span>
                {row.description ? <span className="mt-0.5 block truncate font-mono text-[8px] text-zinc-600">{row.description}</span> : null}
              </span>
              {selected ? <span className="shrink-0 text-[10px] text-cyan-400">✓</span> : null}
            </button>
          );
        }) : (
          <div className="px-2 py-3 text-center text-[9px] text-zinc-600">没有匹配的已配置选项，可继续直接输入</div>
        )}
      </div>
      <div className="border-t border-zinc-800 bg-zinc-900/65 px-2.5 py-1.5 text-[8px] text-zinc-600">{footerText}</div>
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={anchorRef} className="relative min-w-0">
      <input
        ref={inputRef}
        id={testId}
        data-testid={testId}
        value={value ?? ""}
        onChange={(event) => {
          onChange?.(event.target.value);
          openMenu(false);
        }}
        onFocus={() => openMenu(true)}
        onClick={() => { if (!open) openMenu(true); }}
        onBlur={(event) => {
          setOpen(false);
          onBlur?.(event);
        }}
        onKeyDown={handleInputKeyDown}
        disabled={disabled}
        className={`${className} pr-8`}
        placeholder={placeholder}
        role="combobox"
        aria-label={ariaLabel || placeholder}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && visibleOptions[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        inputMode={inputMode}
      />
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        disabled={disabled}
        aria-label={`显示${ariaLabel || placeholder || "已配置"}的全部选项`}
        aria-expanded={open}
        aria-controls={listboxId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else openMenu(true);
        }}
        className="absolute inset-y-px right-px flex w-7 items-center justify-center rounded-r text-zinc-500 transition hover:bg-zinc-800 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
        title="显示全部已配置选项"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M5.5 7.5 10 12l4.5-4.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
        </svg>
      </button>
      {popup}
    </div>
  );
}
