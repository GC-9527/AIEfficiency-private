import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { getApiUrl } from "../services/gateway.js";
import { setFeedbackDraft } from "../pages/help/feedbackDraft.js";
import { useDockSlot } from "./FloatingDock.jsx";

// 全局「反馈BUG」按钮：点击→截当前页→收当天操作日志→跳转到独立的「新建反馈」详情页（附件可编辑/补充）。
// 按钮渲染到常驻悬浮坞 FloatingDock 内（收起时随坞一起隐藏），不再各自 fixed 定位压住页面。
export default function FeedbackButton() {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const slot = useDockSlot();

  async function start() {
    if (busy) return;
    setBusy(true);
    let screenshot = null;
    const attachments = [];
    try {
      // 1) 截当前页面（动态引入，避免拖慢首屏）
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(document.body, { logging: false, useCORS: true, scale: Math.min(1.5, window.devicePixelRatio || 1) });
      screenshot = canvas.toDataURL("image/png");
      const pngB64 = screenshot.split(",")[1];
      attachments.push({ name: "screenshot.png", dataBase64: pngB64, kind: "image", size: Math.round(pngB64.length * 0.75) });
    } catch { /* 截图失败不阻塞 */ }
    try {
      // 2) 当天操作日志：① 附可读的 logs-<当天>.txt（供 Claude 还原现场直接读）② 打成诊断包.zip（含日志+截图，供人下载）
      const JSZip = (await import("jszip")).default;
      const dt = new Date(); // 本地日期，匹配后端 date(created_at)(localtime)
      const today = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const r = await fetch(getApiUrl(`/api/logs?date=${today}`)).then((x) => x.json()).catch(() => null);
      const logs = (r && (r.data || r.logs)) || [];
      const text = logs.map((l) => `[${new Date(l.created_at || l.ts || Date.now()).toLocaleString()}] ${l.level || ""} ${l.module || ""} ${l.message || ""}`).join("\n") || "(当天无日志)";
      const txtB64 = btoa(unescape(encodeURIComponent(text)));
      attachments.push({ name: `logs-${today}.txt`, dataBase64: txtB64, kind: "log", size: text.length });
      const zip = new JSZip();
      zip.file(`logs-${today}.txt`, text);
      if (screenshot) zip.file("screenshot.png", screenshot.split(",")[1], { base64: true });
      const blob = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
      attachments.push({ name: `诊断包-${today}.zip`, dataBase64: blob, kind: "zip", size: Math.round(blob.length * 0.75) });
    } catch { /* 打包失败不阻塞 */ }
    // 暂存草稿 → 跳转到独立新建页
    setFeedbackDraft({ screenshot, attachments, fromPage: location.hash || location.pathname });
    setBusy(false);
    navigate("/feedback/new");
  }

  if (!slot) return null; // 坞收起或未就绪 → 不渲染（按钮被收进把手里）
  return createPortal(
    <button onClick={start} disabled={busy} title="反馈问题 / BUG"
      className="flex items-center justify-center gap-1.5 px-3 h-9 rounded-lg shadow bg-rose-600 hover:bg-rose-500 disabled:bg-zinc-600 text-white text-xs font-medium transition">
      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v3m0 3h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" /></svg>
      {busy ? "采集中…" : "反馈BUG"}
    </button>,
    slot
  );
}
