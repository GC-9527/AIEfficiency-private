import { spawn, execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import {
  isAllowedPerformanceResourceHost,
  isAllowedPerformanceResourceOrigin,
  isPerformanceResourceLoopbackAddress,
  performanceResourceClientAddress,
} from "./performance-resource-local-access.js";
import { getResourceRunStatus } from "./performance-resource-runner.js";

const execFileAsync = promisify(execFile);
const VIDEO_CHANNEL = "performance-resource-video";
const VIDEO_PROTOCOL_VERSION = 1;
const PACKET_CONFIG = 1;
const PACKET_KEY = 2;
const PACKET_DELTA = 3;
const H264_CODEC_ID = 0x68323634;
const CONFIG_FLAG = 0x8000000000000000n;
const KEY_FLAG = 0x4000000000000000n;
const PTS_MASK = 0x3fffffffffffffffn;
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_GOP_BYTES = 24 * 1024 * 1024;
const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;
const SERIAL_WAIT_MS = 30_000;
const STREAM_START_MS = 20_000;
const NO_CLIENT_GRACE_MS = 3_000;
const REMOTE_SERVER_PATH = "/data/local/tmp/scrcpy-server-performance.jar";

const sessions = new Map();
let scrcpyInstallPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicError(error) {
  const code = String(error?.code || "SCRCPY_STREAM_FAILED");
  const known = {
    SCRCPY_NOT_FOUND: "未找到本机 scrcpy，请安装 scrcpy 并加入 PATH",
    SCRCPY_SERVER_NOT_FOUND: "未找到与 scrcpy 同版本的 scrcpy-server",
    SCRCPY_VERSION_INVALID: "无法识别本机 scrcpy 版本",
    RESOURCE_RUN_MISMATCH: "投屏请求与当前性能采集轮次不匹配",
    RESOURCE_RUN_FINISHED: "当前性能采集已结束",
    RESOURCE_SERIAL_TIMEOUT: "性能采集未能确认唯一设备，无法启动实时投屏",
    SCRCPY_FORWARD_FAILED: "无法建立 scrcpy ADB 视频通道",
    SCRCPY_CONNECT_TIMEOUT: "scrcpy 视频通道连接超时",
    SCRCPY_CODEC_UNSUPPORTED: "设备未返回 H.264 视频流",
    SCRCPY_STREAM_INVALID: "scrcpy 视频流格式无效",
    SCRCPY_PROCESS_EXITED: "scrcpy 设备端视频服务已退出",
  };
  return { code, message: known[code] || "scrcpy 实时投屏不可用" };
}

function makeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const isLoopbackAddress = isPerformanceResourceLoopbackAddress;

export function isAllowedLoopbackOrigin(origin) {
  return isAllowedPerformanceResourceOrigin(origin);
}

export const resourceVideoClientAddress = performanceResourceClientAddress;

export function parseScrcpyVersionOutput(output) {
  const match = String(output || "").match(/\bscrcpy\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9._-]+)?)/i);
  return match?.[1] || "";
}

export function buildScrcpyServerArgs({ serial, version, scid }) {
  return [
    "-s", serial,
    "shell",
    `CLASSPATH=${REMOTE_SERVER_PATH}`,
    "app_process", "/", "com.genymobile.scrcpy.Server", version,
    `scid=${scid}`,
    "log_level=info",
    "tunnel_forward=true",
    "audio=false",
    "control=false",
    "cleanup=false",
    "send_dummy_byte=false",
    "send_device_meta=false",
    "send_codec_meta=true",
    "send_frame_meta=true",
    "video_codec=h264",
    "video_bit_rate=3000000",
    "max_size=1280",
    "max_fps=30",
    "video_codec_options=i-frame-interval=1",
  ];
}

export function encodeResourceVideoPacket(type, ptsUs, payload) {
  const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const packet = Buffer.allocUnsafe(10 + source.length);
  packet[0] = VIDEO_PROTOCOL_VERSION;
  packet[1] = type;
  packet.writeBigUInt64BE(BigInt(ptsUs || 0), 2);
  source.copy(packet, 10);
  return packet;
}

export class ScrcpyVideoPacketParser {
  constructor({ onMeta, onPacket } = {}) {
    this.buffer = Buffer.alloc(0);
    this.meta = null;
    this.onMeta = typeof onMeta === "function" ? onMeta : () => {};
    this.onPacket = typeof onPacket === "function" ? onPacket : () => {};
  }

  push(chunk) {
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    if (!source.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, source]) : source;
    for (;;) {
      if (!this.meta) {
        if (this.buffer.length < 12) return;
        const codecId = this.buffer.readUInt32BE(0);
        const width = this.buffer.readUInt32BE(4);
        const height = this.buffer.readUInt32BE(8);
        if (codecId !== H264_CODEC_ID) throw makeError("SCRCPY_CODEC_UNSUPPORTED");
        if (!width || !height || width > 16_384 || height > 16_384) {
          throw makeError("SCRCPY_STREAM_INVALID", "invalid video dimensions");
        }
        this.buffer = this.buffer.subarray(12);
        this.meta = { codec: "h264", width, height };
        this.onMeta({ ...this.meta });
      }
      if (this.buffer.length < 12) return;
      const flagsAndPts = this.buffer.readBigUInt64BE(0);
      const size = this.buffer.readUInt32BE(8);
      if (!size || size > MAX_PACKET_BYTES) {
        throw makeError("SCRCPY_STREAM_INVALID", `invalid packet size ${size}`);
      }
      if (this.buffer.length < 12 + size) return;
      const isConfig = (flagsAndPts & CONFIG_FLAG) !== 0n;
      const isKey = (flagsAndPts & KEY_FLAG) !== 0n;
      const ptsUs = flagsAndPts & PTS_MASK;
      const payload = Buffer.from(this.buffer.subarray(12, 12 + size));
      this.buffer = this.buffer.subarray(12 + size);
      this.onPacket({
        type: isConfig ? PACKET_CONFIG : (isKey ? PACKET_KEY : PACKET_DELTA),
        ptsUs,
        payload,
      });
    }
  }
}

async function command(executable, args, options = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      encoding: "utf8",
      shell: false,
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    error.commandArgs = args;
    throw error;
  }
}

async function findExecutable(name) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const { stdout } = await command(locator, [name], { timeout: 5_000 });
  return String(stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

async function resolveScrcpyInstall() {
  if (scrcpyInstallPromise) return scrcpyInstallPromise;
  scrcpyInstallPromise = (async () => {
    let executable = String(process.env.SCRCPY_EXECUTABLE || "").trim();
    try {
      if (!executable) executable = await findExecutable("scrcpy");
    } catch {
      throw makeError("SCRCPY_NOT_FOUND");
    }
    if (!executable || !fs.existsSync(executable)) throw makeError("SCRCPY_NOT_FOUND");

    let version = String(process.env.SCRCPY_SERVER_VERSION || "").trim();
    if (!version) {
      const result = await command(executable, ["--version"], { timeout: 5_000 });
      version = parseScrcpyVersionOutput(`${result.stdout}\n${result.stderr}`);
    }
    if (!version) throw makeError("SCRCPY_VERSION_INVALID");

    const configuredServer = String(process.env.SCRCPY_SERVER_PATH || "").trim();
    const candidates = configuredServer ? [configuredServer] : [
      path.join(path.dirname(executable), "scrcpy-server"),
      path.join(path.dirname(executable), "scrcpy-server.jar"),
    ];
    const serverPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!serverPath) throw makeError("SCRCPY_SERVER_NOT_FOUND");
    return { executable, serverPath, version };
  })().catch((error) => {
    scrcpyInstallPromise = null;
    throw error;
  });
  return scrcpyInstallPromise;
}

function sendJson(ws, kind, data = {}) {
  if (ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify({
      type: "performance_resource_video",
      data: { kind, transport: "scrcpy", ...data },
    }));
    return true;
  } catch {
    return false;
  }
}

function closeClient(ws, code = 1000, reason = "stream ended") {
  try {
    if (ws.readyState === 0 || ws.readyState === 1) ws.close(code, String(reason).slice(0, 120));
  } catch {}
}

async function waitForFrozenSerial(runId, session) {
  const deadline = Date.now() + SERIAL_WAIT_MS;
  while (!session.stopped && Date.now() < deadline) {
    const status = getResourceRunStatus();
    if (status.runId !== runId) throw makeError("RESOURCE_RUN_MISMATCH");
    if (!status.running || !["starting", "running", "stopping"].includes(status.status)) {
      throw makeError("RESOURCE_RUN_FINISHED");
    }
    const serial = String(status.live?.meta?.serial || "").trim();
    if (serial && /^[A-Za-z0-9._:-]+$/.test(serial)) return serial;
    session.broadcastState("waiting_serial", { message: "等待采集脚本确认当前设备" });
    await sleep(150);
  }
  throw makeError("RESOURCE_SERIAL_TIMEOUT");
}

function createSession(runId) {
  const session = {
    runId,
    serial: "",
    state: "waiting_serial",
    clients: new Map(),
    child: null,
    socket: null,
    parser: null,
    port: null,
    adb: String(process.env.ADB || process.env.ADB_PATH || "adb").trim() || "adb",
    stopped: false,
    startSettled: false,
    noClientTimer: null,
    startupTimer: null,
    monitorTimer: null,
    statsTimer: null,
    codecMeta: null,
    configPacket: null,
    gopPackets: [],
    gopBytes: 0,
    receivedFrames: 0,
    sentFrames: 0,
    droppedFrames: 0,
    startedAt: Date.now(),
    stderr: "",

    broadcastState(status, extra = {}) {
      this.state = status;
      for (const ws of this.clients.keys()) {
        sendJson(ws, "state", { runId: this.runId, status, ...extra });
      }
    },

    addClient(ws) {
      if (this.noClientTimer) clearTimeout(this.noClientTimer);
      this.noClientTimer = null;
      this.clients.set(ws, { needsKey: true, sent: 0, dropped: 0 });
      sendJson(ws, "state", { runId: this.runId, status: this.state, message: "正在建立 scrcpy 连续视频流" });
      if (this.codecMeta) {
        sendJson(ws, "meta", { runId: this.runId, ...this.codecMeta, protocolVersion: VIDEO_PROTOCOL_VERSION });
      }
      if (this.configPacket) this.sendPacketTo(ws, this.configPacket, true);
      if (this.gopPackets.length) {
        for (const packet of this.gopPackets) this.sendPacketTo(ws, packet, true);
      }
    },

    removeClient(ws) {
      this.clients.delete(ws);
      if (!this.clients.size && !this.stopped && !this.noClientTimer) {
        this.noClientTimer = setTimeout(() => this.stop("no_clients", false), NO_CLIENT_GRACE_MS);
        this.noClientTimer.unref?.();
      }
    },

    sendPacketTo(ws, packet, replay = false) {
      const client = this.clients.get(ws);
      if (!client || ws.readyState !== 1) return;
      if (packet.type === PACKET_CONFIG) {
        client.needsKey = true;
      } else if (packet.type === PACKET_KEY) {
        client.needsKey = false;
      } else if (client.needsKey) {
        client.dropped += 1;
        this.droppedFrames += 1;
        return;
      }
      if (!replay && ws.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) {
        client.needsKey = true;
        client.dropped += 1;
        this.droppedFrames += 1;
        return;
      }
      try {
        ws.send(packet.encoded, { binary: true, compress: false });
        if (packet.type !== PACKET_CONFIG) {
          client.sent += 1;
          this.sentFrames += 1;
        }
      } catch {
        this.removeClient(ws);
      }
    },

    handleMeta(meta) {
      this.codecMeta = { codec: meta.codec, width: meta.width, height: meta.height };
      this.broadcastState("streaming", { message: "scrcpy H.264 连续视频通道已连接" });
      for (const ws of this.clients.keys()) {
        sendJson(ws, "meta", { runId: this.runId, ...this.codecMeta, protocolVersion: VIDEO_PROTOCOL_VERSION });
      }
      this.startSettled = true;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
    },

    handlePacket(packet) {
      const encoded = encodeResourceVideoPacket(packet.type, packet.ptsUs, packet.payload);
      const item = { ...packet, encoded };
      if (packet.type === PACKET_CONFIG) {
        this.configPacket = item;
        this.gopPackets = [];
        this.gopBytes = 0;
      } else {
        this.receivedFrames += 1;
        if (packet.type === PACKET_KEY) {
          this.gopPackets = [item];
          this.gopBytes = encoded.length;
        } else if (this.gopPackets.length && this.gopBytes + encoded.length <= MAX_GOP_BYTES) {
          this.gopPackets.push(item);
          this.gopBytes += encoded.length;
        }
      }
      for (const ws of this.clients.keys()) this.sendPacketTo(ws, item);
    },

    async start() {
      try {
        this.serial = await waitForFrozenSerial(this.runId, this);
        if (this.stopped || !this.clients.size) return this.stop("no_clients", false);
        this.broadcastState("starting", { message: "正在启动 scrcpy 设备端 H.264 编码" });
        const install = await resolveScrcpyInstall();
        if (this.stopped) return;
        await command(this.adb, ["-s", this.serial, "push", install.serverPath, REMOTE_SERVER_PATH], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
        if (this.stopped) return;

        const scid = randomInt(0x80000000).toString(16).padStart(8, "0");
        let forward;
        try {
          forward = await command(this.adb, ["-s", this.serial, "forward", "tcp:0", `localabstract:scrcpy_${scid}`], { timeout: 10_000 });
        } catch (error) {
          throw makeError("SCRCPY_FORWARD_FAILED", error.message);
        }
        const port = Number.parseInt(String(forward.stdout).trim(), 10);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw makeError("SCRCPY_FORWARD_FAILED");
        this.port = port;

        this.parser = new ScrcpyVideoPacketParser({
          onMeta: (meta) => this.handleMeta(meta),
          onPacket: (packet) => this.handlePacket(packet),
        });
        this.child = spawn(this.adb, buildScrcpyServerArgs({ serial: this.serial, version: install.version, scid }), {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
        this.child.stdout.on("data", () => {});
        this.child.stderr.on("data", (chunk) => {
          this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
        });
        this.child.on("error", (error) => {
          if (!this.stopped) this.fail(makeError("SCRCPY_PROCESS_EXITED", error.message));
        });
        this.child.on("exit", (code) => {
          if (!this.stopped && !this.startSettled) {
            this.fail(makeError("SCRCPY_PROCESS_EXITED", `exit ${code}: ${this.stderr}`));
          } else if (!this.stopped && this.clients.size) {
            this.fail(makeError("SCRCPY_PROCESS_EXITED", `exit ${code}`));
          }
        });

        this.startupTimer = setTimeout(() => {
          if (!this.startSettled) this.fail(makeError("SCRCPY_CONNECT_TIMEOUT"));
        }, STREAM_START_MS);
        this.startupTimer.unref?.();
        this.connectUntilStreaming(Date.now() + STREAM_START_MS);
      } catch (error) {
        if (!this.stopped) this.fail(error);
      }
    },

    connectUntilStreaming(deadline) {
      if (this.stopped || this.startSettled || Date.now() >= deadline || !this.port) return;
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      let received = false;
      socket.on("data", (chunk) => {
        received = true;
        try {
          this.parser.push(chunk);
        } catch (error) {
          this.fail(error);
        }
      });
      socket.once("error", () => {});
      socket.once("close", () => {
        if (this.socket === socket) this.socket = null;
        if (this.stopped) return;
        if (!this.startSettled && !received && Date.now() < deadline) {
          setTimeout(() => this.connectUntilStreaming(deadline), 120).unref?.();
        } else if (this.startSettled) {
          this.fail(makeError("SCRCPY_PROCESS_EXITED", "video socket closed"));
        }
      });
    },

    fail(error) {
      if (this.stopped) return;
      const info = publicError(error);
      for (const ws of this.clients.keys()) sendJson(ws, "error", { runId: this.runId, ...info, retryable: true });
      this.stop(info.code, true);
    },

    async stop(reason = "stream_ended", notify = true) {
      if (this.stopped) return;
      this.stopped = true;
      this.state = "stopped";
      if (this.noClientTimer) clearTimeout(this.noClientTimer);
      if (this.startupTimer) clearTimeout(this.startupTimer);
      if (this.monitorTimer) clearInterval(this.monitorTimer);
      if (this.statsTimer) clearInterval(this.statsTimer);
      this.noClientTimer = null;
      this.startupTimer = null;
      this.monitorTimer = null;
      this.statsTimer = null;
      try { this.socket?.destroy(); } catch {}
      this.socket = null;
      if (notify) {
        for (const ws of this.clients.keys()) sendJson(ws, "end", { runId: this.runId, reason });
      }
      for (const ws of this.clients.keys()) closeClient(ws, 1000, reason);
      this.clients.clear();
      await sleep(200);
      try { if (this.child && this.child.exitCode == null) this.child.kill(); } catch {}
      this.child = null;
      if (this.port && this.serial) {
        try {
          await command(this.adb, ["-s", this.serial, "forward", "--remove", `tcp:${this.port}`], { timeout: 5_000 });
        } catch {}
      }
      // 故障后的浏览器可能立即重连并为同 runId 建立新 session；旧 session 收尾时不得误删新实例。
      if (sessions.get(this.runId) === this) sessions.delete(this.runId);
    },

    startMonitors() {
      this.monitorTimer = setInterval(() => {
        if (this.stopped) return;
        const status = getResourceRunStatus();
        const frozenSerial = String(status.live?.meta?.serial || "").trim();
        if (status.runId !== this.runId || !status.running) {
          this.stop("run_finished", true);
        } else if (this.serial && frozenSerial && frozenSerial !== this.serial) {
          this.fail(makeError("RESOURCE_RUN_MISMATCH", "frozen serial changed"));
        }
      }, 500);
      this.monitorTimer.unref?.();
      this.statsTimer = setInterval(() => {
        const elapsed = Math.max(0.001, (Date.now() - this.startedAt) / 1000);
        for (const [ws, client] of this.clients.entries()) {
          sendJson(ws, "stats", {
            runId: this.runId,
            receivedFrames: this.receivedFrames,
            sentFrames: client.sent,
            droppedFrames: client.dropped,
            receivedFps: Math.round((this.receivedFrames / elapsed) * 10) / 10,
            clients: this.clients.size,
          });
        }
      }, 1000);
      this.statsTimer.unref?.();
    },
  };
  session.startMonitors();
  return session;
}

function rejectVideoConnection(ws, code, message, closeCode = 1008) {
  sendJson(ws, "error", { code, message, retryable: false });
  closeClient(ws, closeCode, code);
}

export function handlePerformanceResourceVideoConnection(ws, req, requestUrl) {
  if (!isLoopbackAddress(resourceVideoClientAddress(req))) {
    rejectVideoConnection(ws, "LOCAL_ONLY", "scrcpy 实时投屏仅允许本机访问");
    return false;
  }
  if (!isAllowedPerformanceResourceHost(req.headers?.host) || !isAllowedLoopbackOrigin(req.headers?.origin)) {
    rejectVideoConnection(ws, "ORIGIN_DENIED", "实时投屏来源不受信任");
    return false;
  }
  if (requestUrl.searchParams.has("serial")) {
    rejectVideoConnection(ws, "SERIAL_NOT_ALLOWED", "投屏设备只能由当前采集脚本确认");
    return false;
  }
  const channel = String(requestUrl.searchParams.get("channel") || "");
  const runId = String(requestUrl.searchParams.get("runId") || "").trim();
  if (channel !== VIDEO_CHANNEL || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(runId)) {
    rejectVideoConnection(ws, "INVALID_SUBSCRIPTION", "实时投屏订阅参数无效");
    return false;
  }
  const status = getResourceRunStatus();
  if (status.runId !== runId || !status.running) {
    rejectVideoConnection(ws, "RESOURCE_RUN_MISMATCH", "投屏请求与当前性能采集轮次不匹配");
    return false;
  }

  let session = sessions.get(runId);
  if (!session || session.stopped) {
    session = createSession(runId);
    sessions.set(runId, session);
    session.start();
  }
  session.addClient(ws);
  ws.on("close", () => session.removeClient(ws));
  ws.on("error", () => session.removeClient(ws));
  ws.on("message", () => {});
  return true;
}

export function isPerformanceResourceVideoRequest(requestUrl) {
  return String(requestUrl?.searchParams?.get("channel") || "") === VIDEO_CHANNEL;
}

export function getPerformanceResourceVideoDebugState() {
  return [...sessions.values()].map((session) => ({
    runId: session.runId,
    serial: session.serial,
    state: session.state,
    clients: session.clients.size,
    receivedFrames: session.receivedFrames,
    sentFrames: session.sentFrames,
    droppedFrames: session.droppedFrames,
  }));
}

export async function stopAllPerformanceResourceVideoStreams(reason = "gateway_shutdown") {
  await Promise.all([...sessions.values()].map((session) => session.stop(reason, true)));
}

export const RESOURCE_VIDEO_PACKET_TYPES = Object.freeze({
  CONFIG: PACKET_CONFIG,
  KEY: PACKET_KEY,
  DELTA: PACKET_DELTA,
});
