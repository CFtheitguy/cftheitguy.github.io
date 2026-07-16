#!/usr/bin/env node
// LinearWatch — mock device
// ==========================
// Exercises the full agent ingest path WITHOUT a real screen: enrolls with a
// code, reports consent, then uploads synthetic "screenshots" on an interval,
// with a local retry queue so transient/offline failures don't drop frames.
//
// Usage:
//   node mock-device.mjs --api http://127.0.0.1:8787 --code LW-XXXX-XXXX-XXXX \
//        --host MOCK-PC-01 --user jdoe [--interval 10] [--count 5] [--reset]
//
// After the first run the device token is cached in ./.state/<host>.json, so
// later runs reuse it (pass --reset to force a fresh enrollment).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFrame } from "./lib/screenshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const key = k.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else { a[key] = next; i++; }
    }
  }
  return a;
}

const args = parseArgs(process.argv);
const API = (args.api || process.env.LW_API || "http://127.0.0.1:8787").replace(/\/$/, "");
const HOST = args.host || process.env.LW_HOST || "MOCK-PC-01";
const USER = args.user || process.env.LW_USER || "jdoe";
const CODE = args.code || process.env.LW_CODE || "";
const COUNT = args.once ? 1 : args.count ? parseInt(args.count, 10) : Infinity;
const INTERVAL_OVERRIDE = args.interval ? parseInt(args.interval, 10) : null;
const WIDTH = parseInt(args.width, 10) || 1280;
const HEIGHT = parseInt(args.height, 10) || 800;

const stateDir = path.join(__dirname, ".state");
const stateFile = path.join(stateDir, `${HOST.replace(/[^\w.-]/g, "_")}.json`);
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; }
}
function saveState(s) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

async function enroll() {
  if (!CODE) {
    console.error("No cached device token and no --code provided. Create an enrollment code in the dashboard Settings and pass it with --code.");
    process.exit(1);
  }
  log(`Enrolling ${HOST} (${USER}) at ${API} …`);
  const res = await fetch(`${API}/v1/agent/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: CODE, hostname: HOST, monitored_username: USER }),
  });
  const data = await res.json();
  if (!res.ok) { console.error("Enrollment failed:", data.error || res.status); process.exit(1); }

  // Simulate the agent's first-run consent dialog + acknowledgment.
  console.log("\n──────── CONSENT NOTICE (simulated tray dialog) ────────");
  console.log(`Organization: ${data.consent?.org_name}`);
  console.log(data.consent?.what_is_captured);
  console.log(`Retention: ${data.consent?.retention_days} days`);
  console.log(data.consent?.notice);
  console.log("Continuing constitutes acknowledgment.");
  console.log("────────────────────────────────────────────────────────\n");

  await fetch(`${API}/v1/agent/consent`, { method: "POST", headers: { "X-Device-Token": data.device_token } });
  log("Consent acknowledged, reported to server.");

  const state = { device_token: data.device_token, device_id: data.device_id, org: data.org, host: HOST, user: USER };
  saveState(state);
  return state;
}

async function getInterval(token) {
  if (INTERVAL_OVERRIDE) return INTERVAL_OVERRIDE;
  try {
    const res = await fetch(`${API}/v1/agent/config`, { headers: { "X-Device-Token": token } });
    if (res.ok) return (await res.json()).capture_interval_seconds || 120;
  } catch { /* ignore */ }
  return 120;
}

async function upload(token, frame) {
  const png = renderFrame({ width: WIDTH, height: HEIGHT, frame: frame.n, capturedAt: frame.at });
  const fd = new FormData();
  fd.set("captured_at", frame.at.toISOString());
  fd.set("width", String(WIDTH));
  fd.set("height", String(HEIGHT));
  fd.set("image", new Blob([png], { type: "image/png" }), "frame.png");
  const res = await fetch(`${API}/v1/agent/screenshots`, {
    method: "POST",
    headers: { "X-Device-Token": token },
    body: fd,
  });
  return res;
}

async function main() {
  let state = loadState();
  if (args.reset) state = null;
  if (!state?.device_token) state = await enroll();
  else log(`Reusing cached token for ${HOST} (org ${state.org?.name || state.org?.id}).`);

  const token = state.device_token;
  const intervalSec = await getInterval(token);
  log(`Capture interval: ${intervalSec}s. Sending ${COUNT === Infinity ? "until stopped" : COUNT} frame(s). Ctrl+C to quit.`);

  const queue = []; // frames awaiting (re)upload — the "offline" local queue
  const MAX_QUEUE = 240; // bounded local buffer, like a real agent's disk cache
  let sent = 0;
  let n = (state.frame_counter || 0);

  while (sent < COUNT) {
    // Enqueue this tick's frame, dropping the oldest if the buffer is full.
    n += 1;
    queue.push({ n, at: new Date() });
    while (queue.length > MAX_QUEUE) {
      const dropped = queue.shift();
      log(`⚠ local buffer full — dropped oldest queued frame #${dropped.n}`);
    }

    // Drain the queue oldest-first; stop on the first transient failure.
    while (queue.length) {
      const frame = queue[0];
      try {
        const res = await upload(token, frame);
        if (res.status === 201) {
          queue.shift();
          sent += 1;
          log(`✔ uploaded frame #${frame.n} (${sent}/${COUNT === Infinity ? "∞" : COUNT})`);
        } else if (res.status === 429) {
          log(`… rate-limited, will retry frame #${frame.n} next tick`);
          break; // keep it queued
        } else if (res.status === 401) {
          console.error("Device token rejected (revoked or invalid). Stopping. Re-run with --reset to re-enroll.");
          state.frame_counter = n;
          saveState(state);
          process.exit(1);
        } else {
          const body = await res.text().catch(() => "");
          log(`✖ frame #${frame.n} rejected (${res.status}): ${body.slice(0, 120)} — dropping`);
          queue.shift(); // permanent error: drop
        }
      } catch (err) {
        log(`⚠ network error (${err.message}); ${queue.length} frame(s) queued, retrying next tick`);
        break; // keep queued, retry later
      }
      if (sent >= COUNT) break;
    }

    state.frame_counter = n;
    saveState(state);
    if (sent >= COUNT) break;
    await sleep(intervalSec * 1000);
  }
  log(`Done. Sent ${sent} frame(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
