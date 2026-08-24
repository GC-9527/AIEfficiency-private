import React, { useEffect, useRef, useState } from "react";

import {
  createGatewayWebSocket,
  getPerformanceResourceVideoWsUrl,
} from "../../services/gateway.js";
import {
  RESOURCE_VIDEO_PACKET_TYPE,
  ResourceVideoDecodeState,
  parseResourceVideoPacket,
} from "./resourceVideoModel.mjs";

const EMPTY_STATS = {
  receivedFrames: 0,
  decodedFrames: 0,
  serverDroppedFrames: 0,
  decoderDroppedFrames: 0,
  receivedFps: 0,
  lastFrameAt: "",
};

function streamStatusText(status) {
  const labels = {
    idle: "等待分析开始",
    connecting: "连接视频通道",
    waiting_serial: "等待确认设备",
    starting: "启动 scrcpy 编码",
    streaming: "连续视频直播中",
    reconnecting: "视频流重连中",
    ended: "视频流已结束",
    error: "视频流异常",
  };
  return labels[status] || status || labels.idle;
}

function safeCloseDecoder(decoder) {
  try {
    if (decoder && decoder.state !== "closed") decoder.close();
  } catch {}
}

export default function ResourceVideoScreen({ runId, enabled, deviceLabel }) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState(enabled ? "connecting" : "idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState({ codec: "H.264", width: 0, height: 0 });
  const [stats, setStats] = useState(EMPTY_STATS);

  useEffect(() => {
    let stopped = false;
    let socket = null;
    let retryTimer = null;
    let uiTimer = null;
    let decoder = null;
    let decoderConfig = null;
    let configuredRevision = -1;
    let decoderRecovering = false;
    let retryDelay = 500;
    let terminal = false;
    const decodeState = new ResourceVideoDecodeState();
    const counters = { ...EMPTY_STATS };
    const streamMeta = { codec: "H.264", width: 0, height: 0 };

    const publishStats = () => {
      if (!stopped) setStats({ ...counters });
    };
    const setCanvasEvidence = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.dataset.transport = "scrcpy";
      canvas.dataset.decodedFrames = String(counters.decodedFrames);
      canvas.dataset.lastFrameAt = counters.lastFrameAt || "";
      canvas.dataset.runId = runId || "";
    };
    const createDecoder = (codec, revision) => {
      safeCloseDecoder(decoder);
      decoderConfig = {
        codec: codec || "avc1.42E01E",
        ...(streamMeta.width ? { codedWidth: streamMeta.width } : {}),
        ...(streamMeta.height ? { codedHeight: streamMeta.height } : {}),
        hardwareAcceleration: "no-preference",
        optimizeForLatency: true,
      };
      decoder = new window.VideoDecoder({
        output: (frame) => {
          try {
            const canvas = canvasRef.current;
            if (!canvas || stopped) return;
            const width = frame.displayWidth || frame.codedWidth || streamMeta.width;
            const height = frame.displayHeight || frame.codedHeight || streamMeta.height;
            if (width && height && (canvas.width !== width || canvas.height !== height)) {
              canvas.width = width;
              canvas.height = height;
              streamMeta.width = width;
              streamMeta.height = height;
              setMeta({ ...streamMeta });
            }
            const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
            context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
            counters.decodedFrames += 1;
            counters.lastFrameAt = new Date().toLocaleTimeString("zh-CN", { hour12: false });
            setCanvasEvidence();
            if (decoderRecovering) {
              decoderRecovering = false;
              setStatus("streaming");
              setError("");
            }
          } finally {
            frame.close();
          }
        },
        error: (decodeError) => {
          if (stopped) return;
          decoderRecovering = true;
          counters.decoderDroppedFrames += 1;
          decodeState.requireKeyFrame();
          setError(`H.264 解码暂时中断：${decodeError?.message || "未知错误"}`);
          setStatus("reconnecting");
        },
      });
      decoder.configure(decoderConfig);
      configuredRevision = revision;
    };
    const resetForBackpressure = () => {
      counters.decoderDroppedFrames += Math.max(1, decoder?.decodeQueueSize || 0);
      decodeState.requireKeyFrame();
      if (decoder && decoderConfig) {
        try {
          decoder.reset();
          decoder.configure(decoderConfig);
        } catch {
          createDecoder(decodeState.codec, decodeState.configRevision);
        }
      }
    };
    const handleBinary = (value) => {
      let packet;
      try {
        packet = parseResourceVideoPacket(value);
      } catch (parseError) {
        setError(parseError.message || "实时视频包解析失败");
        return;
      }
      counters.receivedFrames += packet.type === RESOURCE_VIDEO_PACKET_TYPE.CONFIG ? 0 : 1;
      if (decoder?.decodeQueueSize > 8) {
        resetForBackpressure();
        if (packet.type === RESOURCE_VIDEO_PACKET_TYPE.DELTA) return;
      }
      const action = decodeState.consume(packet);
      if (!action) {
        counters.decoderDroppedFrames = Math.max(counters.decoderDroppedFrames, decodeState.droppedPackets);
        return;
      }
      if (action.kind === "config") {
        try {
          createDecoder(action.codec, action.configRevision);
          streamMeta.codec = action.codec;
          setMeta({ ...streamMeta });
          setError("");
        } catch (configureError) {
          terminal = true;
          setStatus("error");
          setError(`浏览器不支持设备 H.264 编码：${configureError.message}`);
        }
        return;
      }
      if (!decoder || decoder.state === "closed" || configuredRevision !== action.configRevision) {
        try {
          createDecoder(action.codec, action.configRevision);
        } catch (configureError) {
          setStatus("error");
          setError(`浏览器视频解码器初始化失败：${configureError.message}`);
          return;
        }
      }
      try {
        decoder.decode(new window.EncodedVideoChunk({
          type: action.chunkType,
          timestamp: action.timestamp,
          data: action.data,
        }));
      } catch (decodeError) {
        decoderRecovering = true;
        counters.decoderDroppedFrames += 1;
        decodeState.requireKeyFrame();
        setError(`实时帧解码失败，正在等待下一关键帧：${decodeError.message}`);
      }
    };
    const handleControlMessage = (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw)?.data || {};
      } catch {
        return;
      }
      if (payload.kind === "state") {
        setStatus(payload.status || "connecting");
        setMessage(payload.message || "");
        if (payload.status === "streaming") {
          retryDelay = 500;
          setError("");
        }
      } else if (payload.kind === "meta") {
        streamMeta.codec = payload.codec || "h264";
        streamMeta.width = Number(payload.width) || 0;
        streamMeta.height = Number(payload.height) || 0;
        setMeta({ ...streamMeta });
      } else if (payload.kind === "stats") {
        counters.receivedFrames = Math.max(counters.receivedFrames, Number(payload.receivedFrames) || 0);
        counters.serverDroppedFrames = Number(payload.droppedFrames) || 0;
        counters.receivedFps = Number(payload.receivedFps) || 0;
      } else if (payload.kind === "error") {
        terminal = payload.retryable === false;
        setStatus("error");
        setError(payload.message || "scrcpy 实时投屏不可用");
      } else if (payload.kind === "end") {
        terminal = payload.reason === "run_finished";
        setStatus("ended");
        setMessage(payload.reason === "run_finished" ? "性能采集已结束" : "视频流已结束");
      }
    };
    const connect = () => {
      if (stopped || terminal) return;
      setStatus(retryDelay > 500 ? "reconnecting" : "connecting");
      try {
        socket = createGatewayWebSocket(getPerformanceResourceVideoWsUrl(runId));
      } catch (connectError) {
        setError(connectError.message || "无法连接实时视频通道");
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(8_000, retryDelay * 2);
        return;
      }
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => {
        if (stopped) return;
        if (typeof event.data === "string") handleControlMessage(event.data);
        else handleBinary(event.data);
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        if (stopped || terminal) return;
        setStatus("reconnecting");
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(8_000, retryDelay * 2);
      };
    };

    setStats({ ...EMPTY_STATS });
    setError("");
    setMessage("");
    setMeta({ codec: "H.264", width: 0, height: 0 });
    const validRunId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(runId || ""));
    if (!enabled || !validRunId) {
      setStatus("idle");
      setCanvasEvidence();
      return () => {};
    }
    if (!("VideoDecoder" in window) || !("EncodedVideoChunk" in window)) {
      setStatus("error");
      setError("当前浏览器不支持 WebCodecs，请使用本机最新版 Chrome 或 Edge；系统不会降级为截图轮询。 ");
      return () => {};
    }

    uiTimer = setInterval(publishStats, 250);
    // 延后一拍可避开 React StrictMode 的 setup→cleanup 探测周期，避免开发态建立一次无效视频连接。
    retryTimer = setTimeout(connect, 0);
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (uiTimer) clearInterval(uiTimer);
      try { socket?.close(1000, "component unmounted"); } catch {}
      safeCloseDecoder(decoder);
    };
  }, [enabled, runId]);

  const resolution = meta.width && meta.height ? `${meta.width}×${meta.height}` : "等待分辨率";
  const activeDot = status === "streaming" ? "bg-green-400 animate-pulse" : enabled ? "bg-amber-400 animate-pulse" : "bg-zinc-600";

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden min-h-72 flex flex-col" data-testid="scrcpy-live-screen">
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 rounded-full ${activeDot}`} />
        <span className="text-zinc-300">当前连接设备实时投屏</span>
        <span className="text-zinc-600 truncate">{deviceLabel || "等待设备确认"}</span>
        <span className="ml-auto text-green-500/80">scrcpy · 连续 H.264 视频</span>
      </div>
      <div className="relative flex-1 min-h-64 bg-black flex items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          width="16"
          height="9"
          aria-label={`设备 ${deviceLabel || runId || "未知"} scrcpy 实时视频`}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity ${stats.decodedFrames ? "opacity-100" : "opacity-0"}`}
        />
        {!stats.decodedFrames && (
          <div className={`relative z-10 text-xs px-6 text-center ${error ? "text-amber-400" : "text-zinc-500"}`}>
            {error || message || streamStatusText(status)}
          </div>
        )}
      </div>
      <div className="px-3 py-2 border-t border-zinc-900 space-y-1">
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-zinc-500">
          <span className={status === "streaming" ? "text-green-400" : "text-amber-400"}>{streamStatusText(status)}</span>
          <span>{resolution}</span>
          <span>已解码 {stats.decodedFrames} 帧</span>
          <span>接收 {stats.receivedFrames} 帧</span>
          <span>{stats.receivedFps || 0} fps</span>
          <span>丢弃 {stats.serverDroppedFrames + stats.decoderDroppedFrames} 帧</span>
          {stats.lastFrameAt && <span className="ml-auto">最后画面 {stats.lastFrameAt}</span>}
        </div>
        <div className="text-[10px] text-zinc-700">画面来自 scrcpy 持久视频流并由浏览器实时解码，不使用截图轮询；该视频编码会带来额外系统负载，各轮对比应保持配置一致。</div>
      </div>
    </div>
  );
}
