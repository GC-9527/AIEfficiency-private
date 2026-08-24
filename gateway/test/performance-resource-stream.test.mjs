import assert from "node:assert/strict";
import test from "node:test";

import {
  RESOURCE_VIDEO_PACKET_TYPES,
  ScrcpyVideoPacketParser,
  buildScrcpyServerArgs,
  encodeResourceVideoPacket,
  isAllowedLoopbackOrigin,
  isLoopbackAddress,
  parseScrcpyVersionOutput,
  resourceVideoClientAddress,
} from "../services/performance-resource-stream.js";

function codecMeta(width = 1280, height = 720) {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(0x68323634, 0);
  value.writeUInt32BE(width, 4);
  value.writeUInt32BE(height, 8);
  return value;
}

function framedPacket({ config = false, key = false, pts = 0n, payload }) {
  const header = Buffer.alloc(12);
  let flags = pts;
  if (config) flags |= 0x8000000000000000n;
  if (key) flags |= 0x4000000000000000n;
  header.writeBigUInt64BE(flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

test("parses scrcpy codec metadata and complete packets across arbitrary TCP chunks", () => {
  const metadata = [];
  const packets = [];
  const parser = new ScrcpyVideoPacketParser({
    onMeta: (value) => metadata.push(value),
    onPacket: (value) => packets.push(value),
  });
  const config = Buffer.from("0000000167640020", "hex");
  const key = Buffer.from("00000001658880", "hex");
  const source = Buffer.concat([
    codecMeta(1024, 576),
    framedPacket({ config: true, payload: config }),
    framedPacket({ key: true, pts: 28_832_141_189n, payload: key }),
  ]);
  for (const byte of source) parser.push(Buffer.from([byte]));
  assert.deepEqual(metadata, [{ codec: "h264", width: 1024, height: 576 }]);
  assert.equal(packets.length, 2);
  assert.equal(packets[0].type, RESOURCE_VIDEO_PACKET_TYPES.CONFIG);
  assert.equal(packets[1].type, RESOURCE_VIDEO_PACKET_TYPES.KEY);
  assert.equal(packets[1].ptsUs, 28_832_141_189n);
  assert.deepEqual(packets[1].payload, key);
});

test("rejects non-H264 codec metadata and unsafe packet size", () => {
  const badCodec = codecMeta();
  badCodec.write("h265", 0, "ascii");
  assert.throws(() => new ScrcpyVideoPacketParser().push(badCodec), { code: "SCRCPY_CODEC_UNSUPPORTED" });

  const header = Buffer.alloc(12);
  header.writeUInt32BE(17 * 1024 * 1024, 8);
  assert.throws(() => new ScrcpyVideoPacketParser().push(Buffer.concat([codecMeta(), header])), { code: "SCRCPY_STREAM_INVALID" });
});

test("encodes browser envelope with version, packet type and big-endian PTS", () => {
  const packet = encodeResourceVideoPacket(RESOURCE_VIDEO_PACKET_TYPES.DELTA, 123456789n, Buffer.from([1, 2, 3]));
  assert.equal(packet[0], 1);
  assert.equal(packet[1], RESOURCE_VIDEO_PACKET_TYPES.DELTA);
  assert.equal(packet.readBigUInt64BE(2), 123456789n);
  assert.deepEqual([...packet.subarray(10)], [1, 2, 3]);
});

test("builds framed video-only scrcpy 2.x server command without screenshot fallback", () => {
  const args = buildScrcpyServerArgs({ serial: "SERIAL_1", version: "2.7", scid: "1234abcd" });
  assert.deepEqual(args.slice(0, 3), ["-s", "SERIAL_1", "shell"]);
  assert.ok(args.includes("com.genymobile.scrcpy.Server"));
  assert.ok(args.includes("2.7"));
  assert.ok(args.includes("audio=false"));
  assert.ok(args.includes("control=false"));
  assert.ok(args.includes("send_frame_meta=true"));
  assert.ok(args.includes("video_codec=h264"));
  assert.ok(args.includes("video_codec_options=i-frame-interval=1"));
  assert.ok(!args.some((arg) => /screencap|screenshot/i.test(arg)));
});

test("accepts only loopback peers and loopback browser origins", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isAllowedLoopbackOrigin("http://127.0.0.1:3000"), true);
  assert.equal(isAllowedLoopbackOrigin("http://localhost:3000"), true);
  assert.equal(isAllowedLoopbackOrigin("http://[::1]:3000"), true);
  assert.equal(isAllowedLoopbackOrigin("https://example.com"), false);
  assert.equal(isAllowedLoopbackOrigin("file:///tmp/test.html"), false);
  assert.equal(resourceVideoClientAddress({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), "127.0.0.1");
  assert.equal(resourceVideoClientAddress({
    socket: { remoteAddress: "::1" },
    headers: { "x-forwarded-for": "127.0.0.1, 192.168.10.88" },
  }), "192.168.10.88");
  assert.equal(resourceVideoClientAddress({
    socket: { remoteAddress: "192.168.10.99" },
    headers: { "x-forwarded-for": "127.0.0.1" },
  }), "192.168.10.99");
});

test("parses the matching local scrcpy version", () => {
  assert.equal(parseScrcpyVersionOutput("scrcpy 2.7 <https://github.com/Genymobile/scrcpy>"), "2.7");
  assert.equal(parseScrcpyVersionOutput("unknown"), "");
});
