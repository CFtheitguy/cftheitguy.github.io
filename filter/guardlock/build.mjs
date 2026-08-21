/* GuardLock build: assembles one loadable folder per browser, then zips each.
 * Usage: node build.mjs [--no-zip] */
import { cpSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

const TARGETS = [
  { name: 'firefox', manifest: 'manifest.firefox.json' },
  { name: 'edge', manifest: 'manifest.chromium.json' }   // also loads in Chrome, Brave, Opera
];

const version = JSON.parse(readFileSync(join(ROOT, 'manifest.chromium.json'), 'utf8')).version;

// Keep both manifests on the same version — a mismatch ships a confusing pair of builds.
for (const t of TARGETS) {
  const m = JSON.parse(readFileSync(join(ROOT, t.manifest), 'utf8'));
  if (m.version !== version) {
    console.error(`Version mismatch: ${t.manifest} is ${m.version}, expected ${version}`);
    process.exit(1);
  }
}

if (!existsSync(join(ROOT, 'src/icons/icon128.png'))) {
  console.log('Icons missing — generating them first.');
  execFileSync(process.execPath, [join(ROOT, 'tools/make-icons.mjs')], { stdio: 'inherit' });
}

const noZip = process.argv.includes('--no-zip');

for (const t of TARGETS) {
  const out = join(DIST, t.name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  cpSync(join(ROOT, 'src'), join(out, 'src'), { recursive: true });
  copyFileSync(join(ROOT, t.manifest), join(out, 'manifest.json'));
  copyFileSync(join(ROOT, 'LICENSE.txt'), join(out, 'LICENSE.txt'));

  if (!noZip) {
    const zipPath = join(DIST, `guardlock-${t.name}-${version}.zip`);
    rmSync(zipPath, { force: true });
    try {
      execFileSync('zip', ['-qr9', zipPath, '.'], { cwd: out });
      console.log('built', zipPath);
    } catch (e) {
      console.warn(`zip unavailable — the unpacked folder at dist/${t.name} still works.`);
    }
  }
  console.log('built', out);
}
