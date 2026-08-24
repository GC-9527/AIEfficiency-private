import assert from "node:assert/strict";
import test from "node:test";

import {
  RESOURCE_VIDEO_PACKET_TYPE,
  ResourceVideoDecodeState,
  annexBNalUnits,
  h264CodecString,
  parseResourceVideoPacket,
} from "./resourceVideoModel.mjs";

function envelope(type, pts, payload) {
  const result = new Uint8Array(10 + payload.length);
  result[0] = 1;
  result[1] = type;
  new DataView(result.buffer).setBigUint64(2, BigInt(pts), false);
  result.set(payload, 10);
  return result;
}

const CONFIG = Uint8Array.from([
  0, 0, 0, 1, 0x67, 0x64, 0x00, 0x20, 0xac, 0x1a,
  0, 0, 1, 0x68, 0xee, 0x3c, 0x80,
]);
const KEY = Uint8Array.from([0, 0, 0, 1, 0x65, 0x88, 0x80]);
const DELTA = Uint8Array.from([0, 0, 1, 0x41, 0x9a, 0x01]);

test("parses versioned binary envelope and 64-bit microsecond timestamp", () => {
  const parsed = parseResourceVideoPacket(envelope(RESOURCE_VIDEO_PACKET_TYPE.KEY, 28_832_141_189, KEY));
  assert.equal(parsed.type, RESOURCE_VIDEO_PACKET_TYPE.KEY);
  assert.equal(parsed.ptsUs, 28_832_141_189);
  assert.deepEqual([...parsed.data], [...KEY]);
});

test("rejects invalid protocol envelopes", () => {
  assert.throws(() => parseResourceVideoPacket(new Uint8Array(10)), /长度无效/);
  const invalid = envelope(2, 0, KEY);
  invalid[0] = 9;
  assert.throws(() => parseResourceVideoPacket(invalid), /版本不兼容/);
});

test("parses three-byte and four-byte Annex-B NAL start codes", () => {
  const units = annexBNalUnits(CONFIG);
  assert.equal(units.length, 2);
  assert.equal(units[0][0] & 0x1f, 7);
  assert.equal(units[1][0] & 0x1f, 8);
});

test("derives AVC codec string from SPS profile compatibility and level", () => {
  assert.equal(h264CodecString(CONFIG), "avc1.640020");
});

test("caches config and prepends it to key frame without decoding config alone", () => {
  const state = new ResourceVideoDecodeState();
  const configResult = state.consume({ type: 1, ptsUs: 0, data: CONFIG });
  assert.equal(configResult.kind, "config");
  const keyResult = state.consume({ type: 2, ptsUs: 100, data: KEY });
  assert.equal(keyResult.kind, "chunk");
  assert.equal(keyResult.chunkType, "key");
  assert.equal(keyResult.data.length, CONFIG.length + KEY.length);
  assert.deepEqual([...keyResult.data.slice(0, CONFIG.length)], [...CONFIG]);
});

test("drops deltas before first key and resumes only on a key after backpressure", () => {
  const state = new ResourceVideoDecodeState();
  assert.equal(state.consume({ type: 3, ptsUs: 1, data: DELTA }), null);
  state.consume({ type: 1, ptsUs: 0, data: CONFIG });
  state.consume({ type: 2, ptsUs: 2, data: KEY });
  assert.equal(state.consume({ type: 3, ptsUs: 3, data: DELTA }).chunkType, "delta");
  state.requireKeyFrame();
  assert.equal(state.consume({ type: 3, ptsUs: 4, data: DELTA }), null);
  assert.equal(state.consume({ type: 2, ptsUs: 5, data: KEY }).chunkType, "key");
});
