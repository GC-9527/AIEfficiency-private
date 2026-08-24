import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createGatewayWebSocket, getApiUrl } from "../../services/gateway.js";
import { useAdminSession } from "../../services/adminAuth.js";
import { FeedbackDetail, SolvePanel } from "./Feedback.jsx";

// 独立反馈详情页（悬浮按钮提交后跳转至此；也可直接深链接 /feedback/:id）
export default function FeedbackDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const adminSession = useAdminSession();
  const me = adminSession.principal;
  const isAdmin = adminSession.isAdmin && adminSession.canMutate;
  const [fb, setFb] = useState(null);
  const [err, setErr] = useState("");
  const [solving, setSolving] = useState(false);

  const load = useCallback(() => {
    fetch(getApiUrl(`/api/feedback/${encodeURIComponent(id)}`)).then((r) => r.json())
      .then((d) => { if (d.ok) setFb(d.data); else setErr(d.error || "反馈单不存在"); })
      .catch((e) => setErr(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let ws; try { ws = createGatewayWebSocket(); } catch { return; }
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === "feedback_update" && m.data?.id === id) load(); } catch {} };
    return () => { try { ws.close(); } catch {} };
  }, [id, load]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center gap-2 px-5 py-2.5 border-b border-zinc-800">
        <button onClick={() => navigate("/help?tab=feedback")} className="text-[12px] text-zinc-500 hover:text-zinc-300">← 返回反馈列表</button>
        {isAdmin && <span className="ml-auto text-[11px] text-emerald-400">🔓 管理员：{me.name}</span>}
      </div>
      {err && <div className="p-6 text-sm text-amber-400">{err}</div>}
      {fb && <FeedbackDetail fb={fb} isAdmin={isAdmin} me={me} onChanged={load} onSolve={() => setSolving(true)} />}
      {solving && fb && <SolvePanel fb={fb} onClose={() => { setSolving(false); load(); }} />}
    </div>
  );
}
