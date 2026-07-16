// Image handling for ingest: type sniffing, dimension parsing, and server-side
// thumbnail generation via Photon (Rust/WASM — one of the few image libs that
// runs inside the Workers runtime). Thumbnailing is defensive: if it ever fails
// the caller falls back to using the original as its own thumbnail, so ingest
// never breaks on a bad frame.

import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";

// Magic-byte sniff. We accept JPEG/PNG/WebP; anything else is rejected at ingest.
export function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  )
    return "image/webp";
  return null;
}

export const extForType = (type) =>
  ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type] || "bin");

// Read intrinsic dimensions straight from the file header (cheap; no decode).
// Covers PNG + baseline/progressive JPEG. Returns {width,height} or null.
export function imageDimensions(bytes, type) {
  try {
    if (type === "image/png" && bytes.length >= 24) {
      const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      return { width: w >>> 0, height: h >>> 0 };
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        const isSOF =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          return { width: w, height: h };
        }
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Downscale to a JPEG thumbnail whose longest edge is <= maxEdge.
// Returns { bytes: Uint8Array, width, height } or null on failure.
export async function makeThumbnail(bytes, maxEdge = 360, quality = 70) {
  let img = null;
  let out = null;
  try {
    img = PhotonImage.new_from_byteslice(bytes);
    const w = img.get_width();
    const h = img.get_height();
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const filter = SamplingFilter.Lanczos3 ?? SamplingFilter.Nearest;
    out = resize(img, tw, th, filter);
    const jpeg = out.get_bytes_jpeg(quality);
    return { bytes: new Uint8Array(jpeg), width: tw, height: th };
  } catch (e) {
    console.error("thumbnail generation failed:", e && e.message);
    return null;
  } finally {
    try { img?.free(); } catch { /* noop */ }
    try { out?.free(); } catch { /* noop */ }
  }
}
