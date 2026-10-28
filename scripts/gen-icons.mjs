// 生成应用图标（无外部依赖）：深色底 + 金色城垛纹章
// 输出: src-tauri/icons/{16,32,48,64,128,256}.png、icon.ico、32x32.png、128x128.png、128x128@2x.png
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const na = a / 255;
    buf[i] = Math.round(buf[i] * (1 - na) + r * na);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - na) + g * na);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - na) + b * na);
    buf[i + 3] = Math.max(buf[i + 3], Math.round(a));
  };
  const S = (v) => Math.round((v / 256) * size);

  // 圆角背景（深棕）
  const radius = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let inside = true;
      if (dx < radius && dy < radius) {
        inside = Math.hypot(radius - dx, radius - dy) <= radius;
      }
      if (!inside) continue;
      const t = y / size;
      set(x, y, 26 + t * 10, 18 + t * 7, 12 + t * 5, 255);
    }
  }

  // 金色边框
  const bw = Math.max(1, Math.round(size * 0.035));
  for (let i = 0; i < bw; i++) {
    const inset = Math.round(size * 0.06) + i;
    for (let x = inset; x < size - inset; x++) {
      set(x, inset, 200, 162, 74, 255);
      set(x, size - 1 - inset, 200, 162, 74, 255);
    }
    for (let y = inset; y < size - inset; y++) {
      set(inset, y, 200, 162, 74, 255);
      set(size - 1 - inset, y, 200, 162, 74, 255);
    }
  }

  // 城垛城墙
  const wallTop = S(150);
  const wallBottom = S(196);
  const wallLeft = S(62);
  const wallRight = S(194);
  for (let y = wallTop; y <= wallBottom; y++) {
    for (let x = wallLeft; x <= wallRight; x++) set(x, y, 200, 162, 74, 255);
  }
  const merlonW = Math.round((wallRight - wallLeft) / 7);
  const merlonH = S(26);
  for (let m = 0; m < 4; m++) {
    const mx = wallLeft + m * merlonW * 2;
    for (let y = wallTop - merlonH; y < wallTop; y++) {
      for (let x = mx; x < mx + merlonW; x++) set(x, y, 200, 162, 74, 255);
    }
  }
  // 中央塔楼
  const tw = Math.round((wallRight - wallLeft) * 0.3);
  const tx = Math.round((size - tw) / 2);
  for (let y = S(96); y <= wallBottom; y++) {
    for (let x = tx; x <= tx + tw; x++) set(x, y, 200, 162, 74, 255);
  }
  // 塔楼尖顶
  const roofH = S(34);
  for (let i = 0; i < roofH; i++) {
    const half = Math.round((tw / 2) * (i / roofH));
    const cx = Math.round(size / 2);
    for (let x = cx - half; x <= cx + half; x++) set(x, S(96) - roofH + i, 200, 162, 74, 255);
  }
  // 城门（挖空）
  const doorW = Math.max(2, Math.round(tw * 0.34));
  const doorH = Math.round(size * 0.16);
  const doorX = Math.round((size - doorW) / 2);
  const doorY = wallBottom - doorH;
  for (let y = doorY; y < wallBottom; y++) {
    for (let x = doorX; x < doorX + doorW; x++) {
      const i2 = (y * size + x) * 4;
      buf[i2] = 20;
      buf[i2 + 1] = 14;
      buf[i2 + 2] = 9;
      buf[i2 + 3] = 255;
    }
  }
  return buf;
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = new Map();
for (const s of sizes) {
  const png = encodePng(s, drawIcon(s));
  pngs.set(s, png);
  writeFileSync(join(outDir, `${s}x${s}.png`), png);
}
writeFileSync(join(outDir, "32x32.png"), pngs.get(32));
writeFileSync(join(outDir, "128x128.png"), pngs.get(128));
writeFileSync(join(outDir, "128x128@2x.png"), pngs.get(256));

// ICO 容器（PNG 压缩条目）
const icoSizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
const entries = [];
let offset = 6 + icoSizes.length * 16;
const body = [];
for (const s of icoSizes) {
  const data = pngs.get(s);
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e[2] = 0;
  e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  body.push(data);
  offset += data.length;
}
writeFileSync(join(outDir, "icon.ico"), Buffer.concat([header, ...entries, ...body]));
console.log("icons written to", outDir);
