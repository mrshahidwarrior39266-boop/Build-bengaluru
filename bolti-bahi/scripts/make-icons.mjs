import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the PWA icon set with zero dependencies (PNG encoded by hand).
 * Design: forest-green tile, gold speech bubble, white voice bars.
 */

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SS = 4; // supersampling factor for smooth edges

const COLORS = {
  green: [0x2d, 0x50, 0x16],
  gold: [0xd4, 0xa0, 0x17],
  white: [0xff, 0xff, 0xff],
};

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function canvas(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };
  const roundRect = (x0, y0, x1, y1, radius, color) => {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
        const cx = Math.min(Math.max(x + 0.5, x0 + radius), x1 - radius);
        const cy = Math.min(Math.max(y + 0.5, y0 + radius), y1 - radius);
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= radius * radius) put(x, y, color);
      }
    }
  };
  const triangle = (ax, ay, bx, by, cx, cy, color) => {
    const minX = Math.floor(Math.min(ax, bx, cx));
    const maxX = Math.ceil(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy));
    const maxY = Math.ceil(Math.max(ay, by, cy));
    const sign = (px1, py1, px2, py2, px3, py3) => (px1 - px3) * (py2 - py3) - (px2 - px3) * (py1 - py3);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const p1 = sign(x + 0.5, y + 0.5, ax, ay, bx, by);
        const p2 = sign(x + 0.5, y + 0.5, bx, by, cx, cy);
        const p3 = sign(x + 0.5, y + 0.5, cx, cy, ax, ay);
        const hasNeg = p1 < 0 || p2 < 0 || p3 < 0;
        const hasPos = p1 > 0 || p2 > 0 || p3 > 0;
        if (!(hasNeg && hasPos)) put(x, y, color);
      }
    }
  };
  return { px, put, roundRect, triangle, size };
}

function drawIcon(size, { maskable = false } = {}) {
  const c = canvas(size * SS);
  const W = size * SS;
  const scale = maskable ? 0.8 : 1;
  const U = (unit) => (0.5 + (unit - 0.5) * scale) * W;

  if (maskable) {
    c.roundRect(0, 0, W, W, 0, COLORS.green);
  } else {
    c.roundRect(0, 0, W, W, 0.22 * W, COLORS.green);
  }

  // Speech bubble + tail
  c.roundRect(U(0.17), U(0.19), U(0.83), U(0.64), 0.15 * W * scale, COLORS.gold);
  c.triangle(U(0.35), U(0.63), U(0.53), U(0.63), U(0.40), U(0.78), COLORS.gold);

  // Voice bars inside the bubble
  const bars = [
    [0.355, 0.36, 0.09],
    [0.4625, 0.27, 0.19],
    [0.57, 0.33, 0.13],
  ];
  for (const [left, top, height] of bars) {
    c.roundRect(U(left), U(top), U(left + 0.0625), U(top + height), 0.032 * W * scale, COLORS.white);
  }

  // Downsample with box filter.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          r += c.px[i];
          g += c.px[i + 1];
          b += c.px[i + 2];
        }
      }
      const total = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / total);
      out[o + 1] = Math.round(g / total);
      out[o + 2] = Math.round(b / total);
      out[o + 3] = 255;
    }
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon-180.png', 180, {}],
  ['favicon-32.png', 32, {}],
];

for (const [name, size, options] of outputs) {
  const png = drawIcon(size, options);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`wrote public/icons/${name} (${size}×${size}, ${png.length} bytes)`);
}
