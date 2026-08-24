export const RESOURCE_VIDEO_PROTOCOL_VERSION = 1;
export const RESOURCE_VIDEO_PACKET_TYPE = Object.freeze({
  CONFIG: 1,
  KEY: 2,
  DELTA: 3,
});

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("视频帧必须是 ArrayBuffer 或 Uint8Array");
}

export function parseResourceVideoPacket(value) {
  const bytes = bytesOf(value);
  if (bytes.byteLength <= 10) throw new Error("实时视频包长度无效");
  if (bytes[0] !== RESOURCE_VIDEO_PROTOCOL_VERSION) throw new Error("实时视频协议版本不兼容");
  const type = bytes[1];
  if (![1, 2, 3].includes(type)) throw new Error("实时视频包类型无效");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ptsBigInt = view.getBigUint64(2, false);
  if (ptsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("实时视频时间戳超出安全范围");
  return {
    type,
    ptsUs: Number(ptsBigInt),
    data: bytes.slice(10),
  };
}

export function annexBNalUnits(value) {
  const bytes = bytesOf(value);
  const starts = [];
  for (let index = 0; index + 3 <= bytes.length;) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      starts.push({ offset: index, payload: index + 3 });
      index += 3;
      continue;
    }
    if (index + 4 <= bytes.length
      && bytes[index] === 0 && bytes[index + 1] === 0
      && bytes[index + 2] === 0 && bytes[index + 3] === 1) {
      starts.push({ offset: index, payload: index + 4 });
      index += 4;
      continue;
    }
    index += 1;
  }
  return starts.map((start, index) => {
    const end = starts[index + 1]?.offset ?? bytes.length;
    return bytes.subarray(start.payload, end);
  }).filter((unit) => unit.length);
}

export function h264CodecString(value, fallback = "avc1.42E01E") {
  const sps = annexBNalUnits(value).find((unit) => (unit[0] & 0x1f) === 7 && unit.length >= 4);
  if (!sps) return fallback;
  const hex = [sps[1], sps[2], sps[3]]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `avc1.${hex}`;
}

export function concatVideoBytes(...values) {
  const parts = values.map(bytesOf);
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export class ResourceVideoDecodeState {
  constructor() {
    this.config = null;
    this.codec = "avc1.42E01E";
    this.configRevision = 0;
    this.awaitingKey = true;
    this.droppedPackets = 0;
  }

  consume(packet) {
    if (!packet || !packet.data?.byteLength) return null;
    if (packet.type === RESOURCE_VIDEO_PACKET_TYPE.CONFIG) {
      this.config = packet.data.slice();
      this.codec = h264CodecString(this.config, this.codec);
      this.configRevision += 1;
      this.awaitingKey = true;
      return { kind: "config", codec: this.codec, configRevision: this.configRevision };
    }
    if (packet.type === RESOURCE_VIDEO_PACKET_TYPE.KEY) {
      if (!this.config) {
        this.droppedPackets += 1;
        return null;
      }
      this.awaitingKey = false;
      return {
        kind: "chunk",
        chunkType: "key",
        timestamp: packet.ptsUs,
        data: concatVideoBytes(this.config, packet.data),
        codec: this.codec,
        configRevision: this.configRevision,
      };
    }
    if (packet.type === RESOURCE_VIDEO_PACKET_TYPE.DELTA) {
      if (this.awaitingKey) {
        this.droppedPackets += 1;
        return null;
      }
      return {
        kind: "chunk",
        chunkType: "delta",
        timestamp: packet.ptsUs,
        data: packet.data,
        codec: this.codec,
        configRevision: this.configRevision,
      };
    }
    return null;
  }

  requireKeyFrame() {
    this.awaitingKey = true;
  }
}
