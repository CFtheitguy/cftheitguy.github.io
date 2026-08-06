/**
 * Generate a VAPID key pair for Web Push (background reminders).
 * No dependencies — uses Node's built-in crypto. Run once:
 *
 *   node gen-vapid.mjs
 *
 * Then set the three printed values as Worker secrets:
 *   npx wrangler secret put VAPID_PUBLIC        (paste the VAPID_PUBLIC line's value)
 *   npx wrangler secret put VAPID_PRIVATE_JWK   (paste the VAPID_PRIVATE_JWK line's value)
 *   npx wrangler secret put VAPID_SUBJECT       (type  mailto:you@linearit.co )
 *
 * Keep the private key secret. If you ever rotate it, every worker's browser
 * re-subscribes automatically the next time they open the app.
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwkPriv = privateKey.export({ format: "jwk" });
const jwkPub = publicKey.export({ format: "jwk" });

// Application server key = the raw uncompressed point 0x04 || X || Y, base64url.
const x = Buffer.from(jwkPub.x, "base64url");
const y = Buffer.from(jwkPub.y, "base64url");
const rawPublic = Buffer.concat([Buffer.from([4]), x, y]).toString("base64url");

// Keep only the fields Web Crypto needs to import a signing key.
const privOut = { kty: "EC", crv: "P-256", x: jwkPub.x, y: jwkPub.y, d: jwkPriv.d };

console.log("\n# --- Set these as Worker secrets (npx wrangler secret put <NAME>) ---\n");
console.log("VAPID_PUBLIC=" + rawPublic);
console.log("VAPID_PRIVATE_JWK=" + JSON.stringify(privOut));
console.log("VAPID_SUBJECT=mailto:you@linearit.co   # <-- change to a real contact");
console.log("");
