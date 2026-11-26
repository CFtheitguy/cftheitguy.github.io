// Step 2: render frames for each narration segment and write an ffmpeg concat list.
// usage: node render.js <out_dir>   (out_dir holds segments.json from tts.py)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const out = process.argv[2], FPS = 30, ANIM = 14;
const content = JSON.parse(fs.readFileSync(path.join(__dirname, 'content.json')));
const { total, segments } = JSON.parse(fs.readFileSync(path.join(out, 'segments.json')));
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, 'scene.html'));
  await page.evaluate(c => init(c), content);
  await page.evaluate(() => document.fonts.ready);
  const dir = path.join(out, 'frames'); fs.mkdirSync(dir, { recursive: true });
  let list = '', last = '';
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k];
    for (let f = 1; f <= ANIM; f++) {
      const x = f / ANIM, p = 1 - Math.pow(1 - x, 3);
      const frac = (s.start + (f === ANIM ? s.dur : f / FPS)) / total;
      await page.evaluate(([a, n, p, fr]) => draw(a, n, p, fr), [s.scene, s.n, p, frac]);
      last = path.join(dir, `s${String(k).padStart(3, '0')}_${String(f).padStart(2, '0')}.png`);
      await page.screenshot({ path: last });
      list += `file '${last}'\nduration ${f === ANIM ? (s.dur - (ANIM - 1) / FPS).toFixed(5) : (1 / FPS).toFixed(5)}\n`;
    }
  }
  fs.writeFileSync(path.join(out, 'frames.txt'), list + `file '${last}'\n`);
  await b.close();
})();
