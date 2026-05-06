#!/usr/bin/env node
// Generate PWA PNG icons using only Node stdlib (no deps).
// Writes web/icon-192.png, web/icon-512.png, web/icon-maskable-512.png

"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const WEB = path.resolve(__dirname, "..", "web");

// 8x8 pixel font for ">" and "_"
const GLYPHS = {
  ">": [
    "........",
    ".##.....",
    "..##....",
    "...##...",
    "....##..",
    "...##...",
    "..##....",
    ".##.....",
  ],
  "_": [
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "########",
  ],
};

function hex(c) {
  return [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcIn = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcIn), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter type
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function makeIcon(size, opts = {}) {
  const { padding = 0.12, bg = "#0b1020", panel = "#131936", accent = "#4f8cff", fg = "#d7e3ff" } = opts;
  const buf = Buffer.alloc(size * size * 4);
  const [br, bgc, bb] = hex(bg);
  const [pr, pg, pb] = hex(panel);
  const [ar, ag, ab] = hex(accent);
  const [fr, fg2, fb] = hex(fg);

  // fill background
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = br; buf[i * 4 + 1] = bgc; buf[i * 4 + 2] = bb; buf[i * 4 + 3] = 255;
  }

  // panel = rounded rect
  const pad = Math.round(size * padding);
  const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad;
  const r = Math.round(size * 0.12);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let inside = true;
      if (x < x0 + r && y < y0 + r) inside = (x - (x0 + r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r;
      else if (x >= x1 - r && y < y0 + r) inside = (x - (x1 - r - 1)) ** 2 + (y - (y0 + r)) ** 2 <= r * r;
      else if (x < x0 + r && y >= y1 - r) inside = (x - (x0 + r)) ** 2 + (y - (y1 - r - 1)) ** 2 <= r * r;
      else if (x >= x1 - r && y >= y1 - r) inside = (x - (x1 - r - 1)) ** 2 + (y - (y1 - r - 1)) ** 2 <= r * r;
      if (!inside) continue;
      const i = (y * size + x) * 4;
      buf[i] = pr; buf[i + 1] = pg; buf[i + 2] = pb; buf[i + 3] = 255;
    }
  }

  // title bar stripe
  const barH = Math.round(size * 0.08);
  for (let y = y0; y < y0 + barH; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size + x) * 4;
      buf[i] = Math.round(pr * 0.6); buf[i + 1] = Math.round(pg * 0.6); buf[i + 2] = Math.round(pb * 0.9);
    }
  }
  // dots
  const dotR = Math.max(2, Math.round(size * 0.014));
  const dotY = y0 + Math.round(barH / 2);
  const dotsX = [x0 + Math.round(size * 0.05), x0 + Math.round(size * 0.09), x0 + Math.round(size * 0.13)];
  const dotColors = [[0xff, 0x6b, 0x7a], [0xf5, 0xc1, 0x6c], [0x38, 0xd3, 0x9f]];
  dotsX.forEach((dx, k) => {
    const [rr, gg, bb2] = dotColors[k];
    for (let y = dotY - dotR; y <= dotY + dotR; y++) {
      for (let x = dx - dotR; x <= dx + dotR; x++) {
        if ((x - dx) ** 2 + (y - dotY) ** 2 <= dotR * dotR) {
          const i = (y * size + x) * 4;
          buf[i] = rr; buf[i + 1] = gg; buf[i + 2] = bb2;
        }
      }
    }
  });

  // glyph ">" in accent color, "_" in fg
  const glyphSize = Math.round(size * 0.28);
  const px = Math.round(glyphSize / 8);
  const gy = y0 + barH + Math.round((y1 - y0 - barH) * 0.32);
  const gx = x0 + Math.round((x1 - x0) * 0.2);
  function drawGlyph(name, ox, oy, color) {
    const [cr, cg, cb] = hex(color);
    const lines = GLYPHS[name];
    for (let ry = 0; ry < 8; ry++) {
      for (let rx = 0; rx < 8; rx++) {
        if (lines[ry][rx] !== "#") continue;
        for (let dy = 0; dy < px; dy++) {
          for (let dx = 0; dx < px; dx++) {
            const xx = ox + rx * px + dx;
            const yy = oy + ry * px + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const i = (yy * size + xx) * 4;
            buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb; buf[i + 3] = 255;
          }
        }
      }
    }
  }
  drawGlyph(">", gx, gy, accent);
  drawGlyph("_", gx + glyphSize + px * 2, gy, fg);

  return encodePNG(size, size, buf);
}

function main() {
  const targets = [
    { name: "icon-192.png", size: 192, opts: { padding: 0.08 } },
    { name: "icon-512.png", size: 512, opts: { padding: 0.08 } },
    { name: "icon-1024.png", size: 1024, opts: { padding: 0.08 } },
    { name: "icon-maskable-512.png", size: 512, opts: { padding: 0.2 } },
  ];
  for (const t of targets) {
    const out = path.join(WEB, t.name);
    fs.writeFileSync(out, makeIcon(t.size, t.opts));
    console.log("wrote", out, "(" + fs.statSync(out).size + " bytes)");
  }
}

main();
