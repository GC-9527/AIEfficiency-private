/**
 * 管理后台（RBAC）：本机 TOTP 超级管理员 / 被授权的组织普通管理员。
 * 进入后：超级管理员可从 Teambition 组织成员中授予普通管理员权限。
 */
import React, { useEffect, useRef, useState } from "react";
import {
  adminRequest,
  loginAdmin,
  logoutAdmin,
  publishAdminSession,
  refreshAdminSession,
  useAdminSession,
  usePermission,
} from "../services/adminAuth.js";
import { getApiUrl, startTbTasksLogin } from "../services/gateway.js";

const DING_SDK = "https://g.alicdn.com/dingding/h5-dingtalk-login/0.21.0/ddlogin.js";

let _dingSdkP = null;
function loadDingSdk() {
  if (window.DTFrameLogin) return Promise.resolve();
  if (_dingSdkP) return _dingSdkP;
  _dingSdkP = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = DING_SDK;
    s.onload = () => resolve();
    s.onerror = () => { _dingSdkP = null; reject(new Error("钉钉登录 SDK 加载失败（需联网）")); };
    document.head.appendChild(s);
  });
  return _dingSdkP;
}

async function api(method, path, body, options = {}) {
  const publicAuthPaths = new Set([
    "/auth/login",
    "/auth/ding/config",
    "/auth/ding/callback",
    "/auth/tb-login",
    "/auth/totp/setup",
  ]);
  return adminRequest(`/api/admin${path}`, {
    method,
    body,
    signal: options.signal,
    auth: options.auth ?? !publicAuthPaths.has(path),
  });
}

export default function AdminPlatform() {
  const session = useAdminSession();

  if (session.principal) {
    return <AdminConsole me={session.principal} session={session} onLogout={logoutAdmin} />;
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold text-zinc-100 mb-4">管理后台</h1>
      {session.status === "checking" && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-sm text-zinc-400">
          正在校验管理员身份…
        </div>
      )}
      {session.status === "degraded" && (
        <div className="bg-zinc-900 border border-amber-800/50 rounded-xl p-6 text-sm text-amber-300">
          <div>{session.error?.message || "管理员身份服务暂不可用"}</div>
          <button onClick={() => refreshAdminSession({ force: true })} className="mt-3 px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200">
            重新校验
          </button>
        </div>
      )}
      {session.status === "anonymous" && <LoginGate />}
    </div>
  );
}

function LoginGate() {
  const [tab, setTab] = useState("totp"); // totp | tb | ding
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [dingCfg, setDingCfg] = useState(null); // { enabled, clientId, redirectUri }

  useEffect(() => { api("GET", "/auth/ding/config").then((r) => r.ok && setDingCfg(r.data)); }, []);

  async function login() {
    setBusy(true); setErr("");
    const r = await loginAdmin({ code: code.replace(/\s+/g, "") });
    setBusy(false);
    if (!r.ok) setErr(r.error || "登录失败");
  }
  return (
    <div className="flex items-center justify-center min-h-[70vh]">
      <div className="w-[360px] bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-zinc-100 mb-1">🔐 管理后台登录</h2>
        <p className="text-[11px] text-zinc-500 mb-4">超级管理员使用本机验证器；被授权用户通过 Teambition 登录为普通管理员。</p>

        <div className="flex gap-1 mb-4 bg-zinc-800/60 rounded-lg p-1">
          <button onClick={() => setTab("totp")} className={`flex-1 py-1.5 text-[12px] rounded-md transition ${tab === "totp" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>超管验证码</button>
          <button onClick={() => setTab("tb")} className={`flex-1 py-1.5 text-[12px] rounded-md transition ${tab === "tb" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>TB 管理员</button>
          {dingCfg?.enabled && (
            <button onClick={() => setTab("ding")} className={`flex-1 py-1.5 text-[12px] rounded-md transition ${tab === "ding" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>📱 钉钉扫码</button>
          )}
        </div>

        {tab === "totp" && (
          <>
            <label className="block text-xs text-zinc-500 mb-1">Google Authenticator 6 位验证码</label>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))} onKeyDown={(e) => e.key === "Enter" && login()}
              inputMode="numeric" autoFocus placeholder="000000"
              className="w-full mb-3 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-lg tracking-[0.4em] text-center text-zinc-100 outline-none focus:border-zinc-500" />
            {err && <div className="text-[12px] text-red-400 mb-2">{err}</div>}
            <button onClick={login} disabled={busy || code.length !== 6} className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white text-sm transition">{busy ? "登录中…" : "登录"}</button>
            <button onClick={() => setShowSetup((v) => !v)} className="w-full mt-3 text-[11px] text-zinc-500 hover:text-zinc-300">{showSetup ? "收起验证器绑定信息" : "查看验证器绑定信息"}</button>
            {showSetup && <TotpSetup />}
          </>
        )}
        {tab === "tb" && <TbAdminLogin />}
        {tab === "ding" && <DingQrLogin cfg={dingCfg} />}
      </div>
    </div>
  );
}

function TotpSetup({ allowReset = false }) {
  const qrRef = useRef(null);
  const [info, setInfo] = useState(null); // { enrolled, secret?, otpauth?, secretFile, account, issuer }
  const [qrErr, setQrErr] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!info?.otpauth || !qrRef.current) return;
    setQrErr("");
    // 二维码库已打进前端包（离线可用），动态 import 做按需加载/代码分割
    import("qrcode").then(({ default: QRCode }) => {
      if (qrRef.current) QRCode.toCanvas(qrRef.current, info.otpauth, { width: 168, margin: 1 }, (e) => { if (e) setQrErr("二维码渲染失败，请用下方密钥手动添加"); });
    }).catch(() => setQrErr("二维码渲染失败，请用下方密钥手动添加"));
  }, [info?.otpauth]);

  useEffect(() => { api("GET", "/auth/totp/setup").then((r) => { if (r.ok) setInfo(r.data); }); }, []);

  async function reset() {
    if (!confirm("重新生成密钥后，旧验证器立即失效，需重新扫码绑定。继续？")) return;
    const r = await api("POST", "/auth/totp/reset", {});
    if (r.ok) { setInfo((p) => ({ ...p, ...r.data, enrolled: false })); setQrErr(""); setMsg("已生成新密钥，请重新扫码"); }
    else setMsg(r.error || "重置失败");
  }

  if (!info) return <div className="text-[12px] text-zinc-500 text-center mt-3">读取中…</div>;
  return (
    <div className="mt-3 pt-3 border-t border-zinc-800 text-left">
      <p className="text-[11px] text-zinc-400 mb-2 leading-relaxed">用 <b>Google Authenticator</b>（或微软 Authenticator）扫码，或手动输入密钥添加账户，之后用 App 里的 6 位码登录。</p>
      {info.secret ? (
        <>
          {info.enrolled && <div className="text-[11px] text-emerald-300 bg-emerald-900/15 border border-emerald-800/40 rounded px-2 py-1.5 mb-2">验证器已绑定。继续绑定使用现有密钥；只有点击“重新生成密钥”才会更换 key，并使旧验证码失效。</div>}
          <div className="flex justify-center mb-2"><canvas ref={qrRef} className="bg-white rounded p-1" /></div>
          {qrErr && <div className="text-[11px] text-amber-400 mb-1 text-center">{qrErr}</div>}
          <div className="text-[11px] text-zinc-500">密钥（手动输入用）：</div>
          <div className="text-[12px] font-mono text-zinc-200 break-all bg-zinc-800/60 rounded px-2 py-1 mb-2 select-all">{info.secret.replace(/(.{4})/g, "$1 ").trim()}</div>
        </>
      ) : (
        <div className="text-[11px] text-amber-300 bg-amber-900/15 border border-amber-800/40 rounded px-2 py-1.5 mb-2">验证器密钥只在<strong>网关本机</strong>显示。请从 127.0.0.1 打开本页查看现有绑定信息。</div>
      )}
      <p className="text-[10px] text-zinc-600">密钥文件（不进 git）：<span className="font-mono text-zinc-500">{info.secretFile}</span></p>
      <div className="flex items-center gap-2 mt-2">
        {allowReset && <button onClick={reset} className="text-[11px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-red-300">重新生成密钥</button>}
        {msg && <span className="text-[11px] text-zinc-400">{msg}</span>}
      </div>
    </div>
  );
}

function TbAdminLogin() {
  const [loginChallenge, setLoginChallenge] = useState("");
  const [state, setState] = useState(null);
  const [err, setErr] = useState("");
  const [hint, setHint] = useState("");
  const claimingRef = useRef(false);

  async function claimAdmin(challenge) {
    if (!challenge || claimingRef.current) return;
    claimingRef.current = true;
    setState({ status: "verifying", message: "已确认 TB 用户，正在校验普通管理员权限…" });
    const result = await loginAdmin(
      { loginChallenge: challenge },
      { path: "/api/admin/auth/tb-login", timeoutMs: 10000 },
    );
    claimingRef.current = false;
    if (result.ok) return;
    setLoginChallenge("");
    if (result.code === "ADMIN_MEMBERSHIP_REQUIRED") {
      setHint(result.error || "该 TB 用户尚未被超级管理员加入普通管理员名单");
      setErr("");
    } else {
      setErr(result.error || "TB 管理员登录失败");
    }
    setState(null);
  }

  useEffect(() => {
    if (!loginChallenge) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(getApiUrl("/api/tb-tasks/login/status"), { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (stopped || !response.ok || body.success === false || !body.data) return;
        const next = body.data;
        setState(next);
        if (next.status === "success") await claimAdmin(loginChallenge);
        else if (["failed", "timeout", "cancelled"].includes(next.status)) {
          setLoginChallenge("");
          if (next.status !== "cancelled") setErr(next.message || "TB 扫码登录未完成");
        }
      } catch {}
    };
    void poll();
    const timer = window.setInterval(poll, 1200);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [loginChallenge]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startLogin() {
    setErr(""); setHint("");
    setState({ status: "launching", message: "正在启动 Teambition 登录窗口…" });
    const result = await startTbTasksLogin();
    if (!result.success || !result.loginChallenge) {
      setState(null);
      setErr(result.error || "启动 TB 扫码登录失败");
      return;
    }
    setLoginChallenge(result.loginChallenge);
    setState({ status: "waiting", message: result.message || "请完成 Teambition 扫码登录" });
  }

  async function cancelLogin() {
    const challenge = loginChallenge;
    setLoginChallenge("");
    setState({ status: "cancelled", message: "已取消本次登录" });
    if (!challenge) return;
    try {
      await fetch(getApiUrl("/api/tb-tasks/login/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginChallenge: challenge }),
      });
    } catch {}
  }

  const active = Boolean(loginChallenge) && ["launching", "waiting", "verifying"].includes(state?.status);
  return (
    <div className="text-center py-2">
      <p className="text-[12px] text-zinc-400 mb-4 leading-relaxed">扫码只确认当前 TB 用户身份。只有已被超级管理员加入名单的用户，才会获得普通管理员权限。</p>
      <button onClick={startLogin} disabled={active} className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white text-sm transition">{active ? "等待扫码完成…" : "用 Teambition 登录"}</button>
      {active && <button onClick={cancelLogin} className="mt-2 text-[11px] text-zinc-500 hover:text-red-300">取消本次登录</button>}
      {state?.message && <div className="text-[12px] text-blue-300 mt-3">{state.message}</div>}
      {hint && <div className="text-[12px] text-amber-300 mt-3">{hint}</div>}
      {err && <div className="text-[12px] text-red-400 mt-3">{err}</div>}
    </div>
  );
}

function DingQrLogin({ cfg }) {
  const boxRef = useRef(null);
  const [err, setErr] = useState("");
  const [exchanging, setExchanging] = useState(false);

  useEffect(() => {
    if (!cfg) return; // 配置未到
    if (!cfg.enabled) { setErr("未配置钉钉应用（请在「设置」填写 AppKey/AppSecret，并在钉钉后台配置扫码登录回调地址）"); return; }
    let cancelled = false;
    loadDingSdk().then(() => {
      if (cancelled || !boxRef.current) return;
      const redirectUri = cfg.redirectUri || window.location.origin + window.location.pathname;
      try {
        window.DTFrameLogin(
          { id: boxRef.current.id, width: 280, height: 300 },
          {
            redirect_uri: encodeURIComponent(redirectUri),
            client_id: cfg.clientId,
            scope: "openid",
            response_type: "code",
            state: "admin_" + Math.random().toString(36).slice(2),
            prompt: "consent",
          },
          async (result) => {
            const authCode = result?.authCode || result?.code;
            if (!authCode) { setErr("未取得扫码授权码"); return; }
            setExchanging(true); setErr("");
            const r = await api("POST", "/auth/ding/callback", { authCode });
            setExchanging(false);
            if (r.ok && r.token) {
              publishAdminSession({ token: r.token, principal: { role: r.role, name: r.name } }, { reason: "ding_login" });
            }
            else setErr(r.error || "扫码登录失败");
          },
          (msg) => setErr(typeof msg === "string" ? msg : "钉钉登录失败")
        );
      } catch (e) { setErr(e.message || "初始化二维码失败"); }
    }).catch((e) => setErr(e.message));
    return () => { cancelled = true; };
  }, [cfg]); // eslint-disable-line

  if (!cfg) return <div className="text-center text-[12px] text-zinc-500 py-8">加载配置中…</div>;
  return (
    <div className="text-center">
      <div id="ding_qr_box" ref={boxRef} className="min-h-[300px] flex items-center justify-center bg-white rounded-lg overflow-hidden">
        {!cfg.enabled && <span className="text-[12px] text-zinc-500 px-4">钉钉扫码未启用</span>}
      </div>
      {exchanging && <div className="text-[12px] text-blue-300 mt-2">登录中…</div>}
      {err && <div className="text-[12px] text-red-400 mt-2">{err}</div>}
      <p className="text-[10px] text-zinc-600 mt-3">用钉钉 App 扫码，需先被超级管理员加入管理员名单。</p>
    </div>
  );
}

function AdminConsole({ me, session, onLogout }) {
  const [admins, setAdmins] = useState([]);
  const [adding, setAdding] = useState(false);
  const [members, setMembers] = useState([]);
  const [q, setQ] = useState("");
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [memberErr, setMemberErr] = useState("");
  const [bootstrap, setBootstrap] = useState(null);

  const [audit, setAudit] = useState(null); // 操作日志
  const overviewInFlight = useRef(null);
  const explicitAdminPermissions = session.permissions.length > 0;
  const permissionCanManageAdmins = usePermission("admin:manage");
  const isSuper = me.role === "super";
  const canManageAdmins = explicitAdminPermissions && permissionCanManageAdmins;

  const loadAdmins = async (signal) => {
    const r = await api("GET", "/users", undefined, { signal });
    if (r.ok) setAdmins(r.data || []);
    return r;
  };
  async function loadAudit(signal) {
    const r = await adminRequest("/api/devbench/audit", { signal });
    if (r.ok) setAudit(r.data || []);
    return r;
  }
  async function loadOverview(signal) {
    if (overviewInFlight.current && !overviewInFlight.current.signal?.aborted) {
      return overviewInFlight.current.promise;
    }
    const task = (async () => {
      const overview = await api("GET", "/overview", undefined, { signal });
      if (overview.ok) {
        const data = overview.data || overview;
        setAdmins(data.admins || data.users || []);
        setBootstrap(data.bootstrap || {
          adminCount: data.adminCount ?? (data.admins || data.users || []).length,
        });
        setAudit(data.audit || []);
        return overview;
      }

      // 兼容尚未提供聚合接口的旧网关；只在一次加载中并行请求，不再轮询。
      const [usersResult, bootstrapResult, auditResult] = await Promise.all([
        loadAdmins(signal),
        api("GET", "/bootstrap", undefined, { signal }),
        loadAudit(signal),
      ]);
      if (bootstrapResult.ok) setBootstrap(bootstrapResult.data);
      if (!auditResult.ok && auditResult._status === 401) return auditResult;
      return usersResult;
    })();
    const entry = { promise: task, signal };
    overviewInFlight.current = entry;
    try { return await task; }
    finally { if (overviewInFlight.current === entry) overviewInFlight.current = null; }
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadOverview(controller.signal);
    return () => {
      controller.abort();
    };
  }, []); // eslint-disable-line

  // The global session runtime owns the authorization WebSocket. A server
  // invalidation refreshes /me there; the verified revision then refreshes the
  // console data without creating another identity socket in this page.
  useEffect(() => {
    if (!session.verifiedAt) return;
    const controller = new AbortController();
    void loadOverview(controller.signal);
    return () => controller.abort();
  }, [session.verifiedAt]); // eslint-disable-line

  async function loadMembers(refresh) {
    setLoadingMembers(true); setMemberErr("");
    const r = await api("GET", `/members?q=${encodeURIComponent(q)}${refresh ? "&refresh=1" : ""}`);
    setLoadingMembers(false);
    if (r.ok) { setMembers(r.data || []); }
    else { setMembers([]); setMemberErr(r.error || "获取 Teambition 组织成员失败"); }
  }
  async function addAdmin(m) {
    const userId = String(m.subject?.id || m.userId || "").trim();
    if (!userId) return;
    const r = await api("POST", "/users", {
      subject: { issuer: "teambition", id: userId },
      name: m.name,
    });
    if (r.ok) { await loadAdmins(); }
  }
  async function removeAdmin(u) {
    if (!confirm(`移除管理员「${u.name}」？`)) return;
    await api("DELETE", `/users/${encodeURIComponent(u.dingUserid)}`);
    await loadAdmins();
  }
  const adminSubjectIds = new Set(admins.map((a) => a.subjectId));

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">管理后台</h1>
        <span className="text-[11px] px-2 py-0.5 rounded bg-blue-600/20 text-blue-300 border border-blue-700/40">{isSuper ? "超级管理员" : "管理员"} · {me.name}</span>
        <button onClick={onLogout} title="仅退出管理后台，不影响你的 Teambition / 钉钉登录态" className="ml-auto text-[12px] text-zinc-400 hover:text-zinc-200">退出登录</button>
      </div>

      {session.status === "degraded" && (
        <div className="mb-4 text-[12px] text-amber-300 bg-amber-900/15 border border-amber-800/40 rounded-lg px-3 py-2">
          {session.error?.message || "身份服务暂不可用"}；当前保留最近一次已验证身份。
          <button onClick={() => refreshAdminSession({ force: true })} className="ml-2 underline">重试</button>
        </div>
      )}

      {canManageAdmins && bootstrap && bootstrap.adminCount === 0 && (
        <div className="mb-4 text-[12px] text-amber-300 bg-amber-900/15 border border-amber-800/40 rounded-lg px-3 py-2">管理员名单为空，请从下方组织成员里设置管理员。</div>
      )}

      {isSuper && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-4">
          <h2 className="text-sm font-medium text-zinc-200">本机超级管理员验证器</h2>
          <TotpSetup allowReset />
        </div>
      )}

      {/* 管理员名单 */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-medium text-zinc-200">管理员名单（{admins.length}）</h2>
          {canManageAdmins && (
            <button onClick={() => { setAdding((v) => !v); if (!members.length) loadMembers(); }}
              className="ml-auto text-[12px] px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white">＋ 从组织成员添加</button>
          )}
        </div>
        {!canManageAdmins && <div className="text-[11px] text-zinc-500 mb-2">当前身份仅可查看名单；新增/移除管理员需要管理员管理权限。</div>}
        {admins.length === 0 && <div className="text-[12px] text-zinc-600 py-2">暂无管理员</div>}
        {admins.map((u) => (
          <div key={u.subjectId || u.dingUserid} className="flex items-center gap-2 py-1.5 border-b border-zinc-800/60 text-sm">
            <span className="text-zinc-200">{u.name}</span>
            <span className="text-[10px] px-1 rounded bg-zinc-800 text-zinc-500">{u.subject?.issuer === "teambition" ? "TB" : "钉钉"}</span>
            <span className="text-[11px] text-zinc-600 font-mono">{u.userId || u.dingUserid}</span>
            <span className="text-[10px] text-zinc-600">{u.addedBy ? `由 ${u.addedBy} 添加` : ""}</span>
            {canManageAdmins && <button onClick={() => removeAdmin(u)} className="ml-auto text-[12px] text-zinc-500 hover:text-red-400">移除</button>}
          </div>
        ))}
      </div>

      {/* 组织成员选择（仅超管） */}
      {canManageAdmins && adding && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadMembers()}
              placeholder="搜索成员姓名（回车）" className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none" />
            <button onClick={() => loadMembers()} disabled={loadingMembers} className="px-2.5 py-1.5 text-[12px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100">{loadingMembers ? "搜索中…" : "搜索"}</button>
            <button onClick={() => loadMembers(true)} disabled={loadingMembers} title="重新从 Teambition 拉取" className="px-2 py-1.5 text-[12px] rounded bg-zinc-800 border border-zinc-700 text-zinc-400">↻</button>
          </div>
          {memberErr && <div className="text-[12px] text-red-400 py-2">{memberErr}</div>}
          <div className="max-h-72 overflow-auto">
            {members.map((m) => {
              const memberId = String(m.subject?.id || m.userId || "");
              const memberSubjectId = m.subjectId || `teambition:${memberId}`;
              return (
                <div key={memberId} className="flex items-center gap-2 py-1.5 border-b border-zinc-800/60 text-sm">
                  {m.avatarUrl && <img src={m.avatarUrl} alt="" className="w-5 h-5 rounded-full" />}
                  <span className="text-zinc-200">{m.name}</span>
                  <span className="text-[10px] text-zinc-600 font-mono">{memberId}</span>
                  {adminSubjectIds.has(memberSubjectId)
                    ? <span className="ml-auto text-[11px] text-emerald-400">✓ 已是管理员</span>
                    : <button onClick={() => addAdmin(m)} className="ml-auto text-[12px] px-2 py-0.5 rounded bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 border border-blue-700/40">设为管理员</button>}
                </div>
              );
            })}
            {!loadingMembers && !memberErr && !members.length && <div className="text-[12px] text-zinc-600 py-3">无成员（点搜索/刷新拉取）</div>}
          </div>
        </div>
      )}

      {/* 操作日志（审计）：时间/账号/IP/动作/前后值，已跨服务端同步 */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mt-4">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-medium text-zinc-200">操作日志（{audit?.length || 0}）</h2>
          <span className="text-[10px] text-zinc-600">管理员配置改动审计，已跨服务端同步</span>
          <button onClick={loadAudit} className="ml-auto text-[12px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200">↻ 刷新</button>
        </div>
        {!audit?.length && <div className="text-[12px] text-zinc-600 py-2">暂无操作记录</div>}
        <div className="max-h-80 overflow-auto">
          {(audit || []).map((e) => {
            const when = new Date(e.ts).toLocaleString("zh-CN", { hour12: false });
            const bef = safeName(e.before), aft = safeName(e.after);
            return (
              <div key={e.id} className="py-1.5 border-b border-zinc-800/60 text-[12px]">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-zinc-500 font-mono text-[10px]">{when}</span>
                  <span className="text-zinc-200">{e.actor}</span>
                  <span className="text-[10px] px-1 rounded bg-blue-600/20 text-blue-300">{e.role}</span>
                  <span className="text-[10px] text-zinc-600 font-mono">{e.ip}</span>
                  <span className="text-fuchsia-300">{e.action}</span>
                  <span className="text-zinc-400 font-mono truncate max-w-[200px]">{e.target}</span>
                </div>
                <div className="text-[10px] text-zinc-600 font-mono truncate">{bef ? `${bef} → ` : ""}{aft || (e.after === "null" ? "(删除)" : "")}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// 审计 before/after(JSON字符串) → 简短可读
function safeName(s) {
  if (!s || s === "null") return "";
  try { const o = JSON.parse(s); return o?.name || o?.branch || o?.value || (Array.isArray(o?.apps) ? `${o.apps.length}应用` : JSON.stringify(o).slice(0, 60)); }
  catch { return String(s).slice(0, 60); }
}
