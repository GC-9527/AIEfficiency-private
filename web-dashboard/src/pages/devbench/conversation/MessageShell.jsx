import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyToClipboard } from "../../../utils/clipboard.js";
import CollapsibleMessageBody from "./CollapsibleMessageBody.jsx";
import MessageActionMenu from "./MessageActionMenu.jsx";

const HOVER_OPEN_DELAY_MS = 900;
const HOVER_CLOSE_DELAY_MS = 180;

function interactiveTarget(target) {
  return target instanceof Element && !!target.closest("a,button,input,textarea,select,summary,[contenteditable='true'],[data-message-action-menu='true']");
}

const VIEWPORT_EDGE = 8;
const MENU_GAP = 8;

function positionedRect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function intersects(left, right, padding = 2) {
  return left.left < right.right + padding
    && left.right > right.left - padding
    && left.top < right.bottom + padding
    && left.bottom > right.top - padding;
}

function insideViewport(rect, viewport) {
  return rect.left >= viewport.left
    && rect.top >= viewport.top
    && rect.right <= viewport.right
    && rect.bottom <= viewport.bottom;
}

function safeMenuPosition({ anchor, menuWidth, menuHeight, contentRects, conversationRect, align, viewportWidth, viewportHeight }) {
  const viewport = { left: VIEWPORT_EDGE, top: VIEWPORT_EDGE, right: viewportWidth - VIEWPORT_EDGE, bottom: viewportHeight - VIEWPORT_EDGE };
  const clampX = (value) => Math.max(viewport.left, Math.min(value, viewport.right - menuWidth));
  const clampY = (value) => Math.max(viewport.top, Math.min(value, viewport.bottom - menuHeight));
  const alignedLeft = align === "right" ? anchor.right - menuWidth : anchor.left;
  const oppositeLeft = align === "right" ? anchor.left : anchor.right - menuWidth;
  const centeredLeft = anchor.left + (anchor.width - menuWidth) / 2;
  const centeredTop = anchor.top + (anchor.height - menuHeight) / 2;
  const candidates = [];
  const add = (left, top, placement) => candidates.push({ left: clampX(left), top: clampY(top), placement });

  const mobile = viewportWidth <= 640;
  if (mobile) {
    add((viewportWidth - menuWidth) / 2, viewport.bottom - menuHeight, "viewport-bottom");
    add((viewportWidth - menuWidth) / 2, viewport.top, "viewport-top");
  }
  add(alignedLeft, anchor.top - menuHeight - MENU_GAP, "above");
  add(oppositeLeft, anchor.top - menuHeight - MENU_GAP, "above-opposite");
  add(centeredLeft, anchor.top - menuHeight - MENU_GAP, "above-center");
  add(alignedLeft, anchor.bottom + MENU_GAP, "below");
  add(oppositeLeft, anchor.bottom + MENU_GAP, "below-opposite");
  add(centeredLeft, anchor.bottom + MENU_GAP, "below-center");
  add(anchor.left - menuWidth - MENU_GAP, centeredTop, "left");
  add(anchor.right + MENU_GAP, centeredTop, "right");

  if (conversationRect) {
    add(alignedLeft, conversationRect.top - menuHeight - MENU_GAP, "conversation-above");
    add(alignedLeft, conversationRect.bottom + MENU_GAP, "conversation-below");
    add(conversationRect.left + MENU_GAP, conversationRect.top + MENU_GAP, "conversation-top");
    add(conversationRect.right - menuWidth - MENU_GAP, conversationRect.bottom - menuHeight - MENU_GAP, "conversation-bottom");
  }
  if (!mobile) {
    add(alignedLeft, viewport.top, "viewport-top");
    add(alignedLeft, viewport.bottom - menuHeight, "viewport-bottom");
  }

  const seen = new Set();
  const safe = (candidate) => {
    const key = `${Math.round(candidate.left)}:${Math.round(candidate.top)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const rect = positionedRect(candidate.left, candidate.top, menuWidth, menuHeight);
    return insideViewport(rect, viewport) && !contentRects.some((contentRect) => intersects(rect, contentRect));
  };
  const preferred = candidates.find(safe);
  if (preferred) return { ...preferred, ready: true };

  // Dense layouts may have no anchor-adjacent gap. Search the viewport for a real collision-free slot,
  // preferring safe edges without changing any message layout or scroll position.
  const grid = [];
  for (let top = viewport.top; top <= viewport.bottom - menuHeight; top += 8) {
    for (let left = viewport.left; left <= viewport.right - menuWidth; left += 8) {
      const distance = Math.abs((left + menuWidth / 2) - (anchor.left + anchor.width / 2))
        + Math.abs((top + menuHeight / 2) - (anchor.top + anchor.height / 2));
      grid.push({ left, top, placement: mobile ? "mobile-safe" : "viewport-safe", distance });
    }
  }
  grid.sort((left, right) => left.distance - right.distance);
  const scanned = grid.find(safe);
  if (scanned) return { left: scanned.left, top: scanned.top, placement: scanned.placement, ready: true };

  // Never reveal a menu over message content. An unavailable safe slot remains hidden until scrolling,
  // resizing, collapsing, or streaming creates one and the observers recompute placement.
  return { left: viewport.left, top: viewport.top, placement: "no-safe-slot", ready: false };
}

export default function MessageShell({ messageId, role, content, align = "left", actionIds = ["copy", "quote", "collapse"], active = false, pinned = false, onOpen, onClose, onQuote, onEdit, editDisabled = false, editDisabledReason = "", bubbleClassName = "", children, footer = null }) {
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const openTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  const copyTimerRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, placement: "pending", ready: false });
  const menuId = `${useId().replace(/:/g, "")}-message-actions`;

  const clearOpenTimer = useCallback(() => { if (openTimerRef.current) clearTimeout(openTimerRef.current); openTimerRef.current = null; }, []);
  const clearCloseTimer = useCallback(() => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }, []);
  const closeSoon = useCallback(() => {
    clearCloseTimer();
    if (!pinned) closeTimerRef.current = setTimeout(() => onClose?.(messageId), HOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer, messageId, onClose, pinned]);

  const updatePosition = useCallback(() => {
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!root || !menu || typeof window === "undefined") return;
    const anchor = root.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    if (!menuWidth || !menuHeight) return;
    const contentRects = [...document.querySelectorAll('[data-message-content-region="true"]')]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const conversation = root.closest('[data-message-viewport="true"], [data-testid="devbench-conversation-scroll"]');
    const next = safeMenuPosition({
      anchor,
      menuWidth,
      menuHeight,
      contentRects,
      conversationRect: conversation?.getBoundingClientRect?.() || null,
      align,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPosition((current) => current.left === next.left && current.top === next.top && current.placement === next.placement && current.ready === next.ready ? current : next);
  }, [align]);

  useLayoutEffect(() => {
    if (active) updatePosition();
  }, [active, collapsed, copied, updatePosition]);

  useEffect(() => {
    if (!active) return undefined;
    updatePosition();
    const onViewportChange = () => updatePosition();
    const onPointerDown = (event) => {
      if (rootRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      onClose?.(messageId);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") onClose?.(messageId); };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(onViewportChange) : null;
    resizeObserver?.observe(rootRef.current);
    resizeObserver?.observe(menuRef.current);
    document.querySelectorAll('[data-message-content-region="true"]').forEach((element) => resizeObserver?.observe(element));
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      resizeObserver?.disconnect();
    };
  }, [active, messageId, onClose, updatePosition]);

  useEffect(() => () => {
    clearOpenTimer();
    clearCloseTimer();
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, [clearCloseTimer, clearOpenTimer]);

  useEffect(() => {
    if (!active) setPosition((current) => current.ready ? { ...current, ready: false } : current);
  }, [active]);

  function handlePointerEnter() {
    clearCloseTimer();
    if (active) return;
    clearOpenTimer();
    openTimerRef.current = setTimeout(() => onOpen?.(messageId, false), HOVER_OPEN_DELAY_MS);
  }
  function handlePointerLeave() { clearOpenTimer(); if (active) closeSoon(); }
  function handleClick(event) {
    if (interactiveTarget(event.target)) return;
    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (selection && !selection.isCollapsed && rootRef.current?.contains(selection.anchorNode)) return;
    onOpen?.(messageId, true);
  }
  function handleAction(actionId) {
    if (actionId === "copy") {
      if (!content) return;
      copyToClipboard(String(content));
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
      return;
    }
    if (actionId === "quote") { onQuote?.(); return; }
    if (actionId === "collapse") { setCollapsed((value) => !value); return; }
    if (actionId === "edit" && !editDisabled) { setCollapsed(false); onEdit?.(); }
  }

  const shellRole = role === "live" ? "assistant" : role;
  const menu = active && typeof document !== "undefined" ? createPortal(
    <MessageActionMenu ref={menuRef} id={menuId} role={role} actionIds={actionIds} context={{ collapsed, copied, editDisabled, editDisabledReason }} position={position} onAction={handleAction} onPointerEnter={clearCloseTimer} onPointerLeave={closeSoon} />,
    document.body,
  ) : null;

  return (
    <div className={`flex ${align === "right" ? "justify-end" : "justify-start"}`}>
      <div
        ref={rootRef}
        role="group"
        tabIndex={0}
        aria-label={shellRole === "user" ? "用户消息" : "AI 回答"}
        aria-expanded={!collapsed}
        aria-controls={active ? menuId : undefined}
        data-message-id={messageId}
        data-message-shell="true"
        data-message-menu-active={active ? "true" : "false"}
        data-message-selected={active && pinned ? "true" : "false"}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
        onFocus={(event) => { if (event.target === rootRef.current) onOpen?.(messageId, true); }}
        className={`group relative min-w-0 outline-none transition motion-reduce:transition-none ${active && pinned ? "ring-2 ring-blue-400/45 ring-offset-2 ring-offset-zinc-950" : ""} ${bubbleClassName}`}
      >
        <CollapsibleMessageBody collapsed={collapsed} content={content} role={shellRole}>{children}</CollapsibleMessageBody>
        {footer}
      </div>
      {menu}
    </div>
  );
}
