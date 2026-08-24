import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getApiUrl } from "../services/gateway.js";
import { getAdminToken, useIsAdmin } from "../services/adminAuth.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { useDockSlot } from "./FloatingDock.jsx";

const STATE_KEY = "devtool_recording_state";
const CONTROL_KEY = "devtool_recording_control";
const ACTIVE_TAB_KEY = "devbench_active_tab";
const DEVMODE_KEY = "devmode_session";
const RECORDING_CONTEXT_KEY = "devtool_recording_context";
const CHANNEL_NAME = "devtool-recording";
const SHOW_EVENT = "devtool-recording:show";
const DOCK_COLLAPSE_EVENT = "floating-dock:collapse";

const hiddenState = { visible: false, phase: "hidden" };

function makeId(prefix = "rec") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function readState() {
  const state = readJson(STATE_KEY);
  return state?.visible ? state : hiddenState;
}

function inDevbenchPage() {
  const url = `${window.location.pathname}${window.location.hash}`;
  return /(^|[#/])devbench([/?#]|$)/.test(url);
}

function currentRecordingContext(detail = {}) {
  const devmode = readJson(DEVMODE_KEY) || {};
  const cached = readJson(RECORDING_CONTEXT_KEY) || {};
  const cachedTabId = String(cached.tabId || "").trim();
  const cachedRoot = String(cached.root || "").trim();
  const activeTabId = inDevbenchPage() ? String(localStorage.getItem(ACTIVE_TAB_KEY) || "").trim() : "";
  const tabId = String(detail.tabId || cachedTabId || activeTabId || "").trim();
  return {
    tabId,
    root: String(detail.root || (tabId === cachedTabId ? cachedRoot : "") || devmode.localPath || "").trim(),
  };
}

function authHeaders(extra = {}) {
  const token = getAdminToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

function pickMimeType() {
  const types = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return types.find((type) => window.MediaRecorder.isTypeSupported(type)) || "";
}

function extFromMime(type) {
  const text = String(type || "").toLowerCase();
  if (text.includes("mp4")) return "mp4";
  if (text.includes("ogg")) return "ogv";
  return "webm";
}

function recordingFileName(type) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `devtool-recording-${stamp}.${extFromMime(type)}`;
}

function ControlButton({ tone = "zinc", disabled, onClick, title, children }) {
  const toneCls = tone === "red"
    ? "bg-red-600 border-red-500 text-white hover:bg-red-500"
    : tone === "blue"
      ? "bg-blue-600 border-blue-500 text-white hover:bg-blue-500"
      : tone === "green"
        ? "bg-emerald-600 border-emerald-500 text-white hover:bg-emerald-500"
        : "bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`h-9 px-3 rounded-lg border text-xs font-medium transition inline-flex items-center justify-center gap-1.5 disabled:opacity-55 disabled:cursor-not-allowed ${toneCls}`}
    >
      {children}
    </button>
  );
}

function Icon({ type }) {
  if (type === "record") return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
  if (type === "stop") return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
  if (type === "open") return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6.5h6l2 2h8v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M13 13h5m0 0-2-2m2 2-2 2" />
    </svg>
  );
  if (type === "copy") return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="8" y="8" width="10" height="12" rx="2" />
      <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  );
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function DevRecordingButton() {
  const slot = useDockSlot();
  const { isAdmin } = useIsAdmin();
  if (!slot || !isAdmin) return null;
  const showRecorder = () => {
    window.dispatchEvent(new CustomEvent(SHOW_EVENT, { detail: currentRecordingContext() }));
    window.dispatchEvent(new CustomEvent(DOCK_COLLAPSE_EVENT));
  };
  return createPortal(
    <button
      type="button"
      onClick={showRecorder}
      title="录制网页视频"
      className="flex items-center justify-center gap-1.5 px-3 h-9 rounded-lg shadow text-white text-xs font-medium transition bg-red-600 hover:bg-red-500"
    >
      <Icon type="record" />
      <span>录制视频</span>
    </button>,
    slot
  );
}

export default function DevRecordingOverlay() {
  const { isAdmin } = useIsAdmin();
  const [state, setState] = useState(readState);
  const [copied, setCopied] = useState(false);
  const clientIdRef = useRef(makeId("page"));
  const channelRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const stateRef = useRef(state);
  const isAdminRef = useRef(isAdmin);
  const savingRef = useRef(false);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { isAdminRef.current = isAdmin; }, [isAdmin]);

  function publishState(next) {
    const normalized = next?.visible ? { ...next, updatedAt: Date.now() } : hiddenState;
    setState(normalized);
    try {
      if (normalized.visible) localStorage.setItem(STATE_KEY, JSON.stringify(normalized));
      else localStorage.removeItem(STATE_KEY);
    } catch {}
    try { channelRef.current?.postMessage({ type: "state", state: normalized }); } catch {}
  }

  function sendControl(message) {
    const payload = { ...message, ts: Date.now() };
    try { channelRef.current?.postMessage({ type: "control", control: payload }); } catch {}
    try { localStorage.setItem(CONTROL_KEY, JSON.stringify(payload)); } catch {}
  }

  async function uploadRecording(blob, context) {
    const params = new URLSearchParams();
    if (context.tabId) params.set("tabId", context.tabId);
    if (context.root) params.set("root", context.root);
    params.set("filename", recordingFileName(blob.type));
    const response = await fetch(getApiUrl(`/api/devbench/devmode/recording?${params.toString()}`), {
      method: "POST",
      headers: authHeaders({ "Content-Type": blob.type || "application/octet-stream" }),
      body: blob,
    });
    const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data.data;
  }

  function stopTracks() {
    try { streamRef.current?.getTracks?.().forEach((track) => track.stop()); } catch {}
    streamRef.current = null;
  }

  async function finishRecording() {
    if (savingRef.current) return;
    savingRef.current = true;
    const context = stateRef.current;
    stopTracks();
    const mime = recorderRef.current?.mimeType || pickMimeType() || "video/webm";
    recorderRef.current = null;
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    if (!blob.size) {
      publishState({ ...context, phase: "error", ownerId: "", error: "录制内容为空，未生成视频文件" });
      savingRef.current = false;
      return;
    }
    publishState({ ...context, phase: "saving", ownerId: clientIdRef.current, error: "" });
    try {
      const saved = await uploadRecording(blob, context);
      publishState({
        ...context,
        phase: "done",
        ownerId: "",
        path: saved.path || "",
        relPath: saved.relPath || "",
        size: saved.size || blob.size,
        error: "",
      });
    } catch (e) {
      publishState({ ...context, phase: "error", ownerId: "", error: e.message || "保存录制文件失败" });
    } finally {
      savingRef.current = false;
    }
  }

  function stopLocalRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "inactive") {
      finishRecording();
      return;
    }
    try { recorder.stop(); } catch { finishRecording(); }
  }

  async function startRecording() {
    const context = stateRef.current;
    if (context.phase === "starting" || context.phase === "recording" || context.phase === "saving") return;
    if (!isAdminRef.current) {
      publishState({ ...context, phase: "ready", error: "仅管理员可使用网页录屏，请先登录管理后台" });
      return;
    }
    if (!context.tabId && !context.root) {
      publishState({ ...context, phase: "ready", error: "未找到当前工程，请先在 devbench 故事点或在此开发里配置工程路径" });
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
      publishState({ ...context, phase: "ready", error: "当前浏览器不支持网页录屏，请使用桌面版、localhost 或 HTTPS 页面" });
      return;
    }
    try {
      publishState({ ...context, phase: "starting", ownerId: clientIdRef.current, error: "" });
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      if (!isAdminRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        publishState({ ...context, phase: "ready", ownerId: "", error: "管理员身份已失效，录屏未启动" });
        return;
      }
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => { finishRecording(); };
      recorder.onerror = () => {
        publishState({ ...stateRef.current, phase: "error", ownerId: "", error: "录制过程中发生错误" });
        stopTracks();
      };
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", () => stopLocalRecording(), { once: true });
      });
      recorder.start(1000);
      publishState({
        ...context,
        phase: "recording",
        ownerId: clientIdRef.current,
        startedAt: Date.now(),
        error: "",
      });
    } catch (e) {
      publishState({ ...context, phase: "ready", error: e?.name === "NotAllowedError" ? "已取消屏幕选择" : (e.message || "启动录制失败") });
    }
  }

  function requestStop() {
    const current = stateRef.current;
    if (current.ownerId === clientIdRef.current) stopLocalRecording();
    else sendControl({ action: "stop", sessionId: current.sessionId });
  }

  async function openRecording() {
    if (!state.path) return;
    const response = await fetch(getApiUrl("/api/devbench/devmode/recording/open"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: state.path }),
    });
    const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || !data.ok) publishState({ ...stateRef.current, error: data.error || "打开文件失败" });
  }

  async function copyPath() {
    if (!state.path) return;
    await copyToClipboard(state.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function closeOverlay() {
    if (stateRef.current.phase === "recording") return;
    publishState(hiddenState);
  }

  useEffect(() => {
    if ("BroadcastChannel" in window) {
      channelRef.current = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current.onmessage = (event) => {
        const message = event.data || {};
        if (message.type === "state") setState(message.state?.visible ? message.state : hiddenState);
        if (message.type === "control") handleControl(message.control);
      };
    }
    const handleControl = (control) => {
      if (!control || control.action !== "stop") return;
      const current = stateRef.current;
      if (control.sessionId && control.sessionId !== current.sessionId) return;
      if (current.ownerId === clientIdRef.current) stopLocalRecording();
    };
    const onStorage = (event) => {
      if (event.key === STATE_KEY) setState(readState());
      if (event.key === CONTROL_KEY) handleControl(readJson(CONTROL_KEY));
    };
    const onShow = (event) => {
      if (!isAdmin) return;
      const current = stateRef.current;
      if (current.phase === "starting" || current.phase === "recording" || current.phase === "saving") return;
      const context = currentRecordingContext(event.detail || {});
      publishState({
        visible: true,
        phase: "ready",
        sessionId: makeId("recording"),
        ownerId: "",
        tabId: context.tabId,
        root: context.root,
        path: "",
        relPath: "",
        error: "",
      });
      try { window.dispatchEvent(new CustomEvent(DOCK_COLLAPSE_EVENT)); } catch {}
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(SHOW_EVENT, onShow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SHOW_EVENT, onShow);
      try { channelRef.current?.close(); } catch {}
      channelRef.current = null;
    };
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state.visible) return null;
  const phase = state.phase || "ready";
  const busy = phase === "starting" || phase === "recording" || phase === "saving";

  return createPortal(
    <div className="fixed z-[70] right-3 bottom-6 max-w-[calc(100vw-1.5rem)] rounded-xl border border-zinc-700 bg-zinc-950/95 shadow-2xl backdrop-blur px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {(phase === "ready" || phase === "error") && (
          <>
            <ControlButton tone="red" disabled={!isAdmin} onClick={startRecording} title={isAdmin ? "开始录制网页视频" : "仅管理员可使用网页录屏"}>
              <Icon type="record" />
              开始录制
            </ControlButton>
            {phase === "error" && (
              <ControlButton onClick={closeOverlay} title="关闭录制悬浮窗">
                <Icon type="close" />
                关闭
              </ControlButton>
            )}
          </>
        )}
        {phase === "recording" && (
          <ControlButton tone="red" onClick={requestStop} title="结束录制并保存">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            <Icon type="stop" />
            结束录制
          </ControlButton>
        )}
        {phase === "starting" && (
          <ControlButton tone="blue" disabled title="正在等待选择录制窗口">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            准备中
          </ControlButton>
        )}
        {phase === "saving" && (
          <ControlButton tone="blue" disabled title="正在保存录制文件">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            保存中
          </ControlButton>
        )}
        {phase === "done" && (
          <>
            <ControlButton tone="green" onClick={openRecording} title="在资源管理器中打开录制文件">
              <Icon type="open" />
              打开
            </ControlButton>
            <ControlButton tone="blue" onClick={copyPath} title="复制录制文件绝对路径">
              <Icon type="copy" />
              {copied ? "已复制" : "复制路径"}
            </ControlButton>
            <ControlButton onClick={closeOverlay} title="关闭录制悬浮窗">
              <Icon type="close" />
              关闭
            </ControlButton>
          </>
        )}
      </div>
      {(state.error || (phase === "done" && state.path)) && (
        <div className={`mt-2 max-w-[34rem] truncate text-[10px] ${state.error ? "text-red-300" : "text-zinc-500"}`} title={state.error || state.path}>
          {state.error || state.path}
        </div>
      )}
      {busy && state.ownerId !== clientIdRef.current && (
        <div className="mt-1 text-[10px] text-zinc-500">录制由另一个页面控制</div>
      )}
    </div>,
    document.body
  );
}
