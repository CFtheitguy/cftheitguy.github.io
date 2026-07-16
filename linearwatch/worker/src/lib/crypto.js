// Crypto primitives — all via the Workers-native WebCrypto (no npm deps).
//
//  * Dashboard passwords:  PBKDF2-HMAC-SHA256 (versioned format, upgradeable).
//  * Device tokens:        random secret, stored only as sha256(token).
//  * Signed view URLs:     HMAC-SHA256 over "id|variant|exp".
//  * Session/enroll ids:   high-entropy random, URL-safe.

const enc = new TextEncoder();

// ---- base64url helpers ----
function b64urlFromBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function bytesFromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Constant-time string compare (avoids timing side-channels on tokens/sigs).
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// URL-safe random token (default 32 bytes = 256 bits).
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlFromBytes(buf);
}

export const newId = () => crypto.randomUUID();

// A short, human-typable enrollment code (no ambiguous chars).
export function enrollmentCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    if (i > 0 && i % 4 === 0) s += "-";
    s += alphabet[buf[i] % alphabet.length];
  }
  return "LW-" + s; // e.g. LW-K7QP-2M9R-XT4H
}

// ---- sha256 (device token lookup key) ----
export async function sha256Hex(input) {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- HMAC-SHA256 (signed URLs) ----
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
export async function hmacSign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}
export async function hmacVerify(secret, data, signature) {
  const expected = await hmacSign(secret, data);
  return timingSafeEqual(expected, signature);
}

// ---- PBKDF2 password hashing ----
// Format: pbkdf2$sha256$<iterations>$<salt_b64url>$<hash_b64url>
const PBKDF2_ITERATIONS = 210000; // OWASP 2023 baseline for PBKDF2-HMAC-SHA256
const PBKDF2_HASH_BYTES = 32;

async function pbkdf2(password, saltBytes, iterations) {
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    baseKey,
    PBKDF2_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters");
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64urlFromBytes(salt)}$${b64urlFromBytes(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = bytesFromB64url(parts[3]);
  const expected = parts[4];
  const actual = b64urlFromBytes(await pbkdf2(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}
