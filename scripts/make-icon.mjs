/**
 * 生成 build/ctxfold.ico（多尺寸 PNG 内嵌 ICO）。
 *
 * 不引第三方库：PNG 自己拼 chunk + zlib.deflateSync，ICO 自己拼索引表。
 * 图形用逐像素函数画：深底圆角方块 + 薄荷色断口圆环 + 右侧箭头（fold 的意象）。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(ROOT, "build");
const OUT = path.join(OUT_DIR, "ctxfold.ico");

const BG = [0x15, 0x17, 0x1b];
const RING = [0x3d, 0xd6, 0x9b];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 圆角矩形覆盖判定（0..1 抗锯齿）。 */
function roundedCoverage(x, y, size, radius) {
  const inset = size * 0.045;
  const min = inset;
  const max = size - inset - 1;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const edge = radius - d;
  return Math.max(0, Math.min(1, edge + 0.5));
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.22;
  const ringR = size * 0.29;
  const ringW = Math.max(1.2, size * 0.085);
  const gapHalf = Math.PI * 0.22; // 右侧开口
  const triX = c + size * 0.3;
  const triY0 = c - size * 0.11;
  const triY1 = c + size * 0.11;
  const triTip = c + size * 0.02;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cov = roundedCoverage(x, y, size, radius);
      if (cov <= 0) {
        buf[i + 3] = 0;
        continue;
      }
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];

      const dx = x - c;
      const dy = y - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const inGap = Math.abs(ang) < gapHalf;

      // 断口圆环
      const ringEdge = Math.abs(dist - ringR);
      if (ringEdge <= ringW / 2 + 0.5 && !inGap) {
        const a = Math.max(0, Math.min(1, (ringW / 2 + 0.5 - ringEdge) / 1.2));
        r = Math.round(r + (RING[0] - r) * a);
        g = Math.round(g + (RING[1] - g) * a);
        b = Math.round(b + (RING[2] - b) * a);
      }

      // 右侧箭头（指向右，压在开口上）
      if (x >= triTip && x <= triX) {
        const t = (x - triTip) / (triX - triTip);
        const half = (size * 0.115) * t;
        if (y >= c - half && y <= c + half) {
          r = RING[0];
          g = RING[1];
          b = RING[2];
        }
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = Math.round(255 * cov);
    }
  }
  return png(size, size, buf);
}

function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, idx) => {
    const p = idx * 16;
    dir[p] = e.size >= 256 ? 0 : e.size;
    dir[p + 1] = e.size >= 256 ? 0 : e.size;
    dir[p + 2] = 0;
    dir[p + 3] = 0;
    dir.writeUInt16LE(1, p + 4); // planes
    dir.writeUInt16LE(32, p + 6); // bpp
    dir.writeUInt32LE(e.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const entries = sizes.map((s) => ({ size: s, data: draw(s) }));
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, ico(entries));
console.log(`icon → ${OUT}  (${sizes.join("/")} px, ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
