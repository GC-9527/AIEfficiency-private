import fs from 'node:fs';
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(input) {
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Invalid PNG signature.');
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let transparency = null;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset); offset += 4;
    const type = buffer.subarray(offset, offset + 4).toString('ascii'); offset += 4;
    const data = buffer.subarray(offset, offset + length); offset += length;
    offset += 4; // CRC, trusted for local test artifacts
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8],
        colorType: data[9], compression: data[10], filter: data[11], interlace: data[12]
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG missing IHDR.');
  if (ihdr.bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${ihdr.bitDepth}; expected 8.`);
  if (ihdr.interlace !== 0) throw new Error('Interlaced PNG is not supported by the built-in visual diff.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[ihdr.colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${ihdr.colorType}.`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = ihdr.width * channels;
  const expected = (rowBytes + 1) * ihdr.height;
  if (raw.length < expected) throw new Error(`PNG data is truncated: ${raw.length} < ${expected}.`);
  const decoded = Buffer.alloc(rowBytes * ihdr.height);
  let srcOffset = 0;
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[srcOffset++];
    const rowStart = y * rowBytes;
    const prevStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[srcOffset++];
      const a = x >= channels ? decoded[rowStart + x - channels] : 0;
      const b = y > 0 ? decoded[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? decoded[prevStart + x - channels] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = (value + a) & 255;
      else if (filter === 2) out = (value + b) & 255;
      else if (filter === 3) out = (value + Math.floor((a + b) / 2)) & 255;
      else if (filter === 4) out = (value + paeth(a, b, c)) & 255;
      else throw new Error(`Unsupported PNG filter ${filter}.`);
      decoded[rowStart + x] = out;
    }
  }
  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0, p = 0; i < decoded.length; i += channels, p += 4) {
    if (ihdr.colorType === 6) {
      rgba[p] = decoded[i]; rgba[p + 1] = decoded[i + 1]; rgba[p + 2] = decoded[i + 2]; rgba[p + 3] = decoded[i + 3];
    } else if (ihdr.colorType === 2) {
      rgba[p] = decoded[i]; rgba[p + 1] = decoded[i + 1]; rgba[p + 2] = decoded[i + 2]; rgba[p + 3] = 255;
    } else if (ihdr.colorType === 0) {
      rgba[p] = decoded[i]; rgba[p + 1] = decoded[i]; rgba[p + 2] = decoded[i]; rgba[p + 3] = 255;
    } else if (ihdr.colorType === 4) {
      rgba[p] = decoded[i]; rgba[p + 1] = decoded[i]; rgba[p + 2] = decoded[i]; rgba[p + 3] = decoded[i + 1];
    } else if (ihdr.colorType === 3) {
      const idx = decoded[i];
      rgba[p] = palette?.[idx * 3] ?? 0;
      rgba[p + 1] = palette?.[idx * 3 + 1] ?? 0;
      rgba[p + 2] = palette?.[idx * 3 + 2] ?? 0;
      rgba[p + 3] = transparency?.[idx] ?? 255;
    }
  }
  return { width: ihdr.width, height: ihdr.height, data: rgba };
}

export function encodePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid PNG dimensions.');
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (data.length !== width * height * 4) throw new Error('RGBA data length does not match PNG dimensions.');
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    data.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export function comparePngFiles(baselineFile, currentFile, options = {}) {
  const baseline = decodePng(baselineFile);
  const current = decodePng(currentFile);
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      comparable: false,
      dimensionsMatch: false,
      baseline: { width: baseline.width, height: baseline.height },
      current: { width: current.width, height: current.height },
      differentPixels: baseline.width * baseline.height,
      differentPixelRatio: 1,
      diff: null
    };
  }
  const tolerance = Number(options.channelTolerance ?? 24);
  const diffData = Buffer.alloc(baseline.data.length);
  let different = 0;
  let maxDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < baseline.data.length; i += 4) {
    const deltas = [0, 1, 2, 3].map((c) => Math.abs(baseline.data[i + c] - current.data[i + c]));
    const pixelDelta = Math.max(...deltas);
    maxDelta = Math.max(maxDelta, pixelDelta);
    totalDelta += deltas[0] + deltas[1] + deltas[2] + deltas[3];
    if (pixelDelta > tolerance) {
      different += 1;
      diffData[i] = 255; diffData[i + 1] = 0; diffData[i + 2] = 64; diffData[i + 3] = 255;
    } else {
      const gray = Math.round((baseline.data[i] + baseline.data[i + 1] + baseline.data[i + 2]) / 3);
      diffData[i] = gray; diffData[i + 1] = gray; diffData[i + 2] = gray; diffData[i + 3] = 90;
    }
  }
  const pixels = baseline.width * baseline.height;
  return {
    comparable: true,
    dimensionsMatch: true,
    baseline: { width: baseline.width, height: baseline.height },
    current: { width: current.width, height: current.height },
    differentPixels: different,
    differentPixelRatio: pixels ? different / pixels : 0,
    maxChannelDelta: maxDelta,
    meanChannelDelta: pixels ? totalDelta / (pixels * 4) : 0,
    diff: { width: baseline.width, height: baseline.height, data: diffData }
  };
}

export function writePng(file, png) {
  fs.writeFileSync(file, encodePng(png));
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
