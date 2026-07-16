// Synthesizes a "screenshot"-like PNG for the mock device. No real screen is
// captured — every frame is clearly a simulation (diagonal banner + a live
// 7-segment clock so successive frames are visibly different and timestamped).

import { encodePNG } from "./png.js";

function px(rgba, W, H, x, y, [r, g, b, a = 255]) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const ia = a / 255;
  rgba[i] = rgba[i] * (1 - ia) + r * ia;
  rgba[i + 1] = rgba[i + 1] * (1 - ia) + g * ia;
  rgba[i + 2] = rgba[i + 2] * (1 - ia) + b * ia;
  rgba[i + 3] = 255;
}

function rect(rgba, W, H, x, y, w, h, color) {
  x = Math.floor(x); y = Math.floor(y); w = Math.floor(w); h = Math.floor(h);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(rgba, W, H, xx, yy, color);
}

// --- 7-segment digit renderer ---------------------------------------------
// segments: a b c d e f g  (standard layout)
const SEGMENTS = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgecd", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};

function drawDigit(rgba, W, H, x, y, s, ch, color) {
  const t = Math.max(2, Math.round(s * 0.16)); // segment thickness
  const w = s; // digit width
  const h = s * 2; // digit height
  const on = SEGMENTS[ch] || "";
  const seg = (name, rx, ry, rw, rh) => on.includes(name) && rect(rgba, W, H, x + rx, y + ry, rw, rh, color);
  seg("a", t, 0, w - 2 * t, t);
  seg("b", w - t, t, t, h / 2 - t);
  seg("c", w - t, h / 2, t, h / 2 - t);
  seg("d", t, h - t, w - 2 * t, t);
  seg("e", 0, h / 2, t, h / 2 - t);
  seg("f", 0, t, t, h / 2 - t);
  seg("g", t, h / 2 - t / 2, w - 2 * t, t);
}

function drawText7(rgba, W, H, x, y, s, text, color) {
  let cx = Math.round(x);
  for (const ch of text) {
    cx = Math.round(cx);
    if (ch === ":") {
      const r = Math.max(2, Math.round(s * 0.16));
      rect(rgba, W, H, cx + r, y + Math.round(s * 0.55), r, r, color);
      rect(rgba, W, H, cx + r, y + Math.round(s * 1.25), r, r, color);
      cx += s * 0.6;
    } else if (ch === " ") {
      cx += s * 0.7;
    } else {
      drawDigit(rgba, W, H, cx, y, s, ch, color);
      cx += s * 1.4;
    }
  }
  return cx;
}

// Render a frame. Returns a PNG Buffer.
export function renderFrame({ width = 1280, height = 800, frame = 0, capturedAt = new Date() } = {}) {
  const W = width, H = height;
  const rgba = Buffer.alloc(W * H * 4);
  const d = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);

  // Desktop-ish gradient background, hue drifting with the minute+second.
  const shift = (d.getSeconds() + d.getMinutes() * 2) % 120;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = 24 + (x / W) * 40 + shift * 0.3;
      rgba[i + 1] = 30 + (y / H) * 50;
      rgba[i + 2] = 60 + (x / W) * 60 + shift * 0.4;
      rgba[i + 3] = 255;
    }

  // Title bar + taskbar to look screenshot-ish.
  rect(rgba, W, H, 0, 0, W, 40, [15, 23, 42, 235]);
  rect(rgba, W, H, 0, H - 44, W, 44, [15, 23, 42, 235]);
  rect(rgba, W, H, 12, 12, 16, 16, [239, 68, 68, 255]);
  rect(rgba, W, H, 36, 12, 16, 16, [234, 179, 8, 255]);
  rect(rgba, W, H, 60, 12, 16, 16, [34, 197, 94, 255]);

  // Center panel.
  const pw = Math.round(W * 0.6), ph = Math.round(H * 0.42);
  const pxp = (W - pw) >> 1, pyp = (H - ph) >> 1;
  rect(rgba, W, H, pxp, pyp, pw, ph, [2, 6, 23, 180]);
  rect(rgba, W, H, pxp, pyp, pw, 6, [99, 102, 241, 255]);

  // Live clock (HH:MM:SS) + frame counter, both 7-segment.
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const clockScale = Math.round(H * 0.06);
  const clockW = 8 * clockScale * 1.4 + 2 * clockScale * 0.6;
  drawText7(rgba, W, H, Math.round((W - clockW) / 2), pyp + Math.round(ph * 0.22), clockScale, `${hh}:${mm}:${ss}`, [125, 211, 252, 255]);
  const fs = Math.round(H * 0.035);
  const frameStr = String(frame).padStart(5, "0");
  drawText7(rgba, W, H, pxp + Math.round(pw * 0.30), pyp + Math.round(ph * 0.66), fs, frameStr, [148, 163, 184, 255]);

  // A block that marches across the panel each frame (motion between shots).
  const bx = pxp + 20 + ((frame * 24) % Math.max(1, pw - 60));
  rect(rgba, W, H, bx, pyp + ph - 40, 28, 20, [244, 114, 182, 255]);

  // Diagonal "simulated" banner so these are never mistaken for real captures.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if ((x + y) % 46 < 6 && ((x - y + H) % 180) < 90) px(rgba, W, H, x, y, [250, 204, 21, 70]);
    }

  return encodePNG(W, H, rgba);
}
