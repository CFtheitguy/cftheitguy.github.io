/* Renders GuardLock's shield-and-padlock icon to PNG at every size the
 * manifests ask for. Pure Node — no image libraries in the toolchain. */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor for smooth edges

/* ------------------------------------------------------------ png encoding */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------- the drawing */

/** Shield outline in a unit square: a rounded top that tapers to a point. */
function inShield(x, y) {
  if (y < 0.05 || y > 0.965) return false;
  const cx = Math.abs(x - 0.5);
  let half;
  if (y < 0.56) {
    half = 0.425;
    // round the two top corners
    const r = 0.12;
    if (y < 0.05 + r) {
      const dy = 0.05 + r - y;
      const dx = half - r;
      if (cx > dx) {
        const d = Math.hypot(cx - dx, dy);
        return d <= r;
      }
    }
  } else {
    const t = (y - 0.56) / 0.405;
    half = 0.425 * Math.sqrt(Math.max(0, 1 - t * t));
  }
  return cx <= half;
}

function inRoundRect(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  if (dx <= 0 && dy <= 0) return true;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) <= r;
}

/** The padlock drawn on top of the shield, in white. */
function inLock(x, y) {
  if (inRoundRect(x, y, 0.5, 0.625, 0.34, 0.26, 0.055)) return true;
  const d = Math.hypot(x - 0.5, y - 0.47);
  if (y <= 0.50 && d <= 0.155 && d >= 0.092) return true;
  return false;
}

/** Keyhole punched back out of the padlock. */
function inKeyhole(x, y) {
  if (Math.hypot(x - 0.5, y - 0.585) <= 0.042) return true;
  return Math.abs(x - 0.5) <= 0.022 && y > 0.585 && y < 0.70;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

const TOP = [0x3d, 0x8d, 0xff];
const BOTTOM = [0x11, 0x4c, 0xa8];
const WHITE = [0xff, 0xff, 0xff];

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          if (!inShield(x, y)) continue;
          const base = mix(TOP, BOTTOM, Math.min(1, Math.max(0, (y - 0.05) / 0.9)));
          const px3 = inLock(x, y) && !inKeyhole(x, y) ? WHITE : base;
          r += px3[0]; g += px3[1]; b += px3[2]; a += 255;
        }
      }
      const n = SS * SS;
      const cover = a / (255 * n);
      const i = (py * size + px) * 4;
      if (cover > 0) {
        // un-premultiply so partially covered edge pixels keep their colour
        buf[i] = Math.round(r / (n * cover));
        buf[i + 1] = Math.round(g / (n * cover));
        buf[i + 2] = Math.round(b / (n * cover));
        buf[i + 3] = Math.round(cover * 255);
      }
    }
  }
  return encodePng(size, size, buf);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, render(size));
  console.log('wrote', file);
}
