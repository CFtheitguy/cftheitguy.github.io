/* Linear Design — mockups: the design shown on a phone, laptop, tablet, framed
 * poster, T-shirt, mug, business cards, billboard or social post. Everything is
 * drawn here in code (no product photos), so there's nothing to license. */
'use strict';
(() => {
const KINDS = [['phone', 'Phone'], ['laptop', 'Laptop'], ['tablet', 'Tablet'], ['poster', 'Framed poster'], ['tshirt', 'T-shirt'], ['mug', 'Mug'],
  ['cards', 'Business cards'], ['billboard', 'Billboard'], ['post', 'Social post']];
const OUT_W = 1600, OUT_H = 1200;

function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function cover(c, img, x, y, w, h) {   // draw img to fill the box, cropping the overflow
  const k = Math.max(w / img.width, h / img.height), dw = img.width * k, dh = img.height * k;
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); c.restore();
}
function fitBox(aspect, maxW, maxH) { let w = maxW, h = w / aspect; if (h > maxH) { h = maxH; w = h * aspect; } return [w, h]; }
function shadow(c, blur, y, a) { c.shadowColor = `rgba(0,0,0,${a == null ? .35 : a})`; c.shadowBlur = blur; c.shadowOffsetY = y; c.shadowOffsetX = 0; }
function noShadow(c) { c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0; }
function backdrop(c, col) {
  const g = c.createRadialGradient(OUT_W / 2, OUT_H * .42, 100, OUT_W / 2, OUT_H / 2, OUT_W * .75);
  g.addColorStop(0, shade(col, .08)); g.addColorStop(1, shade(col, -.12));
  c.fillStyle = g; c.fillRect(0, 0, OUT_W, OUT_H);
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16), f = v => Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt))));
  return '#' + [n >> 16 & 255, n >> 8 & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join('');
}

const draw = {
  phone(c, img, o) {
    backdrop(c, o.bg);
    const portrait = img.height >= img.width;
    const [bw, bh] = portrait ? fitBox(9 / 19.5, 999, 1020) : fitBox(19.5 / 9, 1400, 999);
    const x = (OUT_W - bw) / 2, y = (OUT_H - bh) / 2, R = Math.min(bw, bh) * .14, b = Math.min(bw, bh) * .035;
    shadow(c, 80, 40, .4); c.fillStyle = '#16181d'; rr(c, x, y, bw, bh, R); c.fill(); noShadow(c);
    c.strokeStyle = '#3a3f4a'; c.lineWidth = 3; c.stroke();
    c.save(); rr(c, x + b, y + b, bw - 2 * b, bh - 2 * b, R - b); c.clip();
    c.fillStyle = '#000'; c.fillRect(x, y, bw, bh);
    cover(c, img, x + b, y + b, bw - 2 * b, bh - 2 * b);
    const g = c.createLinearGradient(x, y, x + bw, y + bh); g.addColorStop(0, 'rgba(255,255,255,.10)'); g.addColorStop(.45, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(x, y, bw, bh);
    c.restore();
    c.fillStyle = '#0b0c10';
    if (portrait) rr(c, x + bw / 2 - bw * .14, y + b + bh * .012, bw * .28, bh * .03, bh * .015); else rr(c, x + b + bw * .012, y + bh / 2 - bh * .14, bw * .03, bh * .28, bw * .015);
    c.fill();
  },
  tablet(c, img, o) {
    backdrop(c, o.bg);
    const a = img.width / img.height, landscape = a >= 1;
    const [bw, bh] = landscape ? fitBox(4 / 3, 1300, 950) : fitBox(3 / 4, 1100, 1020);
    const x = (OUT_W - bw) / 2, y = (OUT_H - bh) / 2, R = Math.min(bw, bh) * .06, b = Math.min(bw, bh) * .045;
    shadow(c, 80, 40, .38); c.fillStyle = '#1b1d22'; rr(c, x, y, bw, bh, R); c.fill(); noShadow(c);
    c.save(); rr(c, x + b, y + b, bw - 2 * b, bh - 2 * b, R * .5); c.clip(); c.fillStyle = '#fff'; c.fillRect(x, y, bw, bh);
    const [iw, ih] = fitBox(a, bw - 2 * b, bh - 2 * b); c.drawImage(img, x + (bw - iw) / 2, y + (bh - ih) / 2, iw, ih); c.restore();
  },
  laptop(c, img, o) {
    backdrop(c, o.bg);
    const sw = 1080, sh = sw * 10 / 16, x = (OUT_W - sw) / 2, y = 170, bz = 26;
    shadow(c, 60, 30, .35); c.fillStyle = '#1a1c21'; rr(c, x - bz, y - bz, sw + 2 * bz, sh + 2 * bz + 14, 26); c.fill(); noShadow(c);
    c.fillStyle = '#0d0e11'; c.fillRect(x, y, sw, sh);
    const a = img.width / img.height, [iw, ih] = fitBox(a, sw, sh);
    c.fillStyle = '#fff'; if (a >= 1.4) cover(c, img, x, y, sw, sh); else { c.fillStyle = '#e9ebef'; c.fillRect(x, y, sw, sh); c.drawImage(img, x + (sw - iw) / 2, y + (sh - ih) / 2, iw, ih); }
    const by = y + sh + bz + 14, bw = sw + 2 * bz + 180;
    const g = c.createLinearGradient(0, by, 0, by + 46); g.addColorStop(0, '#d9dce2'); g.addColorStop(1, '#9ea3ad');
    shadow(c, 40, 22, .35); c.fillStyle = g; c.beginPath(); c.moveTo(OUT_W / 2 - bw / 2 + 40, by); c.lineTo(OUT_W / 2 + bw / 2 - 40, by); c.lineTo(OUT_W / 2 + bw / 2, by + 40); c.quadraticCurveTo(OUT_W / 2 + bw / 2, by + 46, OUT_W / 2 + bw / 2 - 12, by + 46); c.lineTo(OUT_W / 2 - bw / 2 + 12, by + 46); c.quadraticCurveTo(OUT_W / 2 - bw / 2, by + 46, OUT_W / 2 - bw / 2, by + 40); c.closePath(); c.fill(); noShadow(c);
    c.fillStyle = '#8a8f99'; rr(c, OUT_W / 2 - 90, by, 180, 10, 5); c.fill();
  },
  poster(c, img, o) {
    c.fillStyle = o.bg; c.fillRect(0, 0, OUT_W, OUT_H);
    const g = c.createLinearGradient(0, 0, OUT_W, 0); g.addColorStop(0, 'rgba(0,0,0,.10)'); g.addColorStop(.5, 'rgba(255,255,255,.06)'); g.addColorStop(1, 'rgba(0,0,0,.14)'); c.fillStyle = g; c.fillRect(0, 0, OUT_W, OUT_H);
    c.fillStyle = shade('#b08a63', -.1); c.fillRect(0, OUT_H * .86, OUT_W, OUT_H * .14);
    c.fillStyle = 'rgba(0,0,0,.12)'; c.fillRect(0, OUT_H * .86, OUT_W, 6);
    const a = img.width / img.height, [iw, ih] = fitBox(a, 760, 760), fr = 34, mat = 46;
    const W = iw + 2 * (fr + mat), H = ih + 2 * (fr + mat), x = (OUT_W - W) / 2, y = OUT_H * .44 - H / 2;
    shadow(c, 50, 30, .38); c.fillStyle = o.frame || '#1c1c1c'; c.fillRect(x, y, W, H); noShadow(c);
    c.fillStyle = '#f7f5f0'; c.fillRect(x + fr, y + fr, W - 2 * fr, H - 2 * fr);
    c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(x + fr, y + fr, W - 2 * fr, 6);
    c.drawImage(img, x + fr + mat, y + fr + mat, iw, ih);
    const gl = c.createLinearGradient(x, y, x + W, y + H); gl.addColorStop(0, 'rgba(255,255,255,.14)'); gl.addColorStop(.35, 'rgba(255,255,255,0)'); c.fillStyle = gl; c.fillRect(x + fr, y + fr, W - 2 * fr, H - 2 * fr);
    // a plant, for scale
    const px = x + W + 120, py = OUT_H * .86;
    if (px + 120 < OUT_W) {
      c.fillStyle = '#c9784a'; c.beginPath(); c.moveTo(px - 60, py - 130); c.lineTo(px + 60, py - 130); c.lineTo(px + 45, py); c.lineTo(px - 45, py); c.closePath(); c.fill();
      c.fillStyle = '#3f7d4f'; for (const [dx, dy, r] of [[-40, -200, 55], [20, -250, 62], [55, -180, 48], [-10, -170, 50]]) { c.beginPath(); c.ellipse(px + dx, py + dy, r * .6, r, dx / 90, 0, 7); c.fill(); }
    }
  },
  tshirt(c, img, o) {
    backdrop(c, o.bg);
    const col = o.item || '#ffffff', cx = OUT_W / 2, top = 170, W = 760;
    const p = new Path2D();
    p.moveTo(cx - 95, top); p.quadraticCurveTo(cx, top + 70, cx + 95, top);
    p.lineTo(cx + W * .33, top + 30); p.lineTo(cx + W * .5, top + 250); p.lineTo(cx + W * .36, top + 320); p.lineTo(cx + W * .29, top + 270);
    p.lineTo(cx + W * .29, top + 900); p.quadraticCurveTo(cx, top + 925, cx - W * .29, top + 900);
    p.lineTo(cx - W * .29, top + 270); p.lineTo(cx - W * .36, top + 320); p.lineTo(cx - W * .5, top + 250); p.lineTo(cx - W * .33, top + 30); p.closePath();
    shadow(c, 60, 30, .3); c.fillStyle = col; c.fill(p); noShadow(c);
    c.save(); c.clip(p);
    // print on the chest; "multiply" on light shirts so the fabric shows through
    const [iw, ih] = fitBox(img.width / img.height, W * .42, 440);
    c.globalCompositeOperation = parseInt(col.slice(1), 16) > 0xbbbbbb ? 'multiply' : 'source-over';
    c.drawImage(img, cx - iw / 2, top + 190, iw, ih);
    c.globalCompositeOperation = 'source-over';
    const g = c.createLinearGradient(cx - W / 2, 0, cx + W / 2, 0); g.addColorStop(0, 'rgba(0,0,0,.16)'); g.addColorStop(.25, 'rgba(0,0,0,0)'); g.addColorStop(.75, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.18)');
    c.fillStyle = g; c.fillRect(cx - W / 2, top, W, 950);
    c.strokeStyle = 'rgba(0,0,0,.12)'; c.lineWidth = 3; c.beginPath(); c.moveTo(cx - 95, top); c.quadraticCurveTo(cx, top + 70, cx + 95, top); c.stroke();
    c.beginPath(); c.moveTo(cx - W * .29, top + 270); c.lineTo(cx - W * .29, top + 330); c.moveTo(cx + W * .29, top + 270); c.lineTo(cx + W * .29, top + 330); c.stroke();
    c.restore();
  },
  mug(c, img, o) {
    backdrop(c, o.bg);
    const col = o.item || '#ffffff', w = 620, h = 720, x = (OUT_W - w) / 2 - 60, y = (OUT_H - h) / 2 + 20;
    shadow(c, 50, 30, .3);
    c.strokeStyle = col; c.lineWidth = 58; c.beginPath(); c.ellipse(x + w + 20, y + h * .45, 120, 190, 0, -Math.PI / 2, Math.PI / 2); c.stroke();
    c.fillStyle = col; c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y); c.lineTo(x + w, y + h - 30); c.quadraticCurveTo(x + w, y + h, x + w - 30, y + h); c.lineTo(x + 30, y + h); c.quadraticCurveTo(x, y + h, x, y + h - 30); c.closePath(); c.fill();
    noShadow(c);
    // wrap the design around the front of the cylinder, column by column
    const [iw0, ih0] = fitBox(img.width / img.height, w * 1.25, h * .62), dh = ih0, dy = y + (h - dh) / 2;
    const cols = 180;
    for (let i = 0; i < cols; i++) {
      const x0 = -1 + 2 * i / cols, x1 = -1 + 2 * (i + 1) / cols;
      const u0 = (Math.asin(x0 * .92) / (Math.PI / 2) + 1) / 2, u1 = (Math.asin(x1 * .92) / (Math.PI / 2) + 1) / 2;
      const su0 = img.width * (.5 + (u0 - .5) * (w * 1.25 / iw0) * .8), su1 = img.width * (.5 + (u1 - .5) * (w * 1.25 / iw0) * .8);
      if (su1 <= 0 || su0 >= img.width) continue;
      const a0 = Math.max(0, su0), a1 = Math.min(img.width, su1);
      c.drawImage(img, a0, 0, Math.max(1, a1 - a0), img.height, x + (x0 + 1) / 2 * w, dy, w / cols + .8, dh);
    }
    const g = c.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(0,0,0,.28)'); g.addColorStop(.18, 'rgba(0,0,0,.05)'); g.addColorStop(.32, 'rgba(255,255,255,.28)'); g.addColorStop(.42, 'rgba(255,255,255,0)'); g.addColorStop(.8, 'rgba(0,0,0,.08)'); g.addColorStop(1, 'rgba(0,0,0,.34)');
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.fillStyle = shade(col, -.25); c.beginPath(); c.ellipse(x + w / 2, y, w / 2, 26, 0, 0, 7); c.fill();
    c.fillStyle = shade(col, -.5); c.beginPath(); c.ellipse(x + w / 2, y + 4, w / 2 - 22, 18, 0, 0, 7); c.fill();
  },
  cards(c, img, o) {
    backdrop(c, o.bg);
    const a = img.width / img.height, [w, h] = a > 1 ? fitBox(a, 820, 520) : fitBox(a, 420, 640);
    const one = (x, y, rot, face) => {
      c.save(); c.translate(x, y); c.rotate(rot);
      shadow(c, 40, 24, .3); c.fillStyle = '#ffffff'; c.fillRect(-w / 2, -h / 2, w, h); noShadow(c);
      if (face) c.drawImage(img, -w / 2, -h / 2, w, h);
      else { c.fillStyle = o.item || '#1f2937'; c.fillRect(-w / 2, -h / 2, w, h); }
      c.restore();
    };
    one(OUT_W / 2 + 130, OUT_H / 2 + 60, .16, false);
    one(OUT_W / 2 - 60, OUT_H / 2 - 20, -.08, true);
  },
  billboard(c, img, o) {
    const sky = c.createLinearGradient(0, 0, 0, OUT_H); sky.addColorStop(0, '#6fb1f2'); sky.addColorStop(.7, '#cfe6fb'); sky.addColorStop(1, '#e9f3fb');
    c.fillStyle = sky; c.fillRect(0, 0, OUT_W, OUT_H);
    c.fillStyle = 'rgba(255,255,255,.8)'; for (const [x, y, r] of [[240, 180, 60], [300, 170, 80], [380, 190, 55], [1250, 250, 50], [1310, 235, 70], [1380, 255, 48]]) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
    c.fillStyle = '#7a8a6a'; c.fillRect(0, OUT_H * .9, OUT_W, OUT_H * .1);
    const a = img.width / img.height, [w, h] = fitBox(a, 1240, 620), x = (OUT_W - w) / 2, y = 150;
    c.fillStyle = '#5b5f66'; c.fillRect(OUT_W / 2 - 200, y + h, 36, OUT_H * .9 - y - h); c.fillRect(OUT_W / 2 + 164, y + h, 36, OUT_H * .9 - y - h);
    shadow(c, 30, 14, .3); c.fillStyle = '#2b2e34'; c.fillRect(x - 22, y - 22, w + 44, h + 44); noShadow(c);
    c.drawImage(img, x, y, w, h);
    c.fillStyle = '#44484f'; c.fillRect(x - 40, y + h + 22, w + 80, 16);
  },
  post(c, img, o) {
    c.fillStyle = o.bg; c.fillRect(0, 0, OUT_W, OUT_H);
    const a = img.width / img.height, iw = 700, ih = Math.min(875, iw / a), cw = iw, head = 86, foot = 150;
    const x = (OUT_W - cw) / 2, y = (OUT_H - (head + ih + foot)) / 2;
    shadow(c, 60, 24, .22); c.fillStyle = '#ffffff'; rr(c, x, y, cw, head + ih + foot, 18); c.fill(); noShadow(c);
    c.fillStyle = '#e1306c33'; c.beginPath(); c.arc(x + 44, y + head / 2, 24, 0, 7); c.fill();
    c.fillStyle = '#111'; c.font = '600 22px system-ui, sans-serif'; c.textBaseline = 'middle'; c.fillText(o.handle || 'yourbusiness', x + 82, y + head / 2 - 10);
    c.fillStyle = '#777'; c.font = '17px system-ui, sans-serif'; c.fillText('Just now', x + 82, y + head / 2 + 14);
    cover(c, img, x, y + head, cw, ih);
    const iy = y + head + ih + 38;
    c.strokeStyle = '#111'; c.lineWidth = 3; c.lineJoin = 'round';
    const heart = new Path2D('M12 20s-7-4.4-9.2-8.6C1.4 8.6 3 5 6.5 5c2 0 3.5 1.2 5.5 3.2C14 6.2 15.5 5 17.5 5 21 5 22.6 8.6 21.2 11.4 19 15.6 12 20 12 20z');
    const bubble = new Path2D('M4 5h16v11H9l-5 4z'), send = new Path2D('M21 3L3 10.5l7 3 3 7.5zM10 13.5L21 3');
    [heart, bubble, send].forEach((ic, i) => { c.save(); c.translate(x + 24 + i * 56, iy - 18); c.scale(1.6, 1.6); c.lineWidth = 1.8; c.stroke(ic); c.restore(); });
    c.fillStyle = '#111'; c.font = '600 20px system-ui, sans-serif'; c.fillText('1,284 likes', x + 26, iy + 44);
    c.fillStyle = '#444'; c.font = '19px system-ui, sans-serif'; c.fillText((o.handle || 'yourbusiness') + '  Something new is here ✨', x + 26, iy + 80);
  },
};
function render(kind, img, o) {
  const c = document.createElement('canvas'); c.width = OUT_W; c.height = OUT_H;
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  (draw[kind] || draw.phone)(x, img, Object.assign({ bg: '#e9edf3' }, o));
  return c;
}
window.LDMock = { KINDS, render, OUT_W, OUT_H };
})();
