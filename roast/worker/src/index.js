/**
 * Linear Roast — Worker
 *
 * POST /roast  (multipart/form-data, field "image") -> { roast: string }
 *
 * Uses Cloudflare Workers AI (binding: AI) for image-to-text roasting.
 * No external API keys required — Workers AI is billed to the Cloudflare
 * account directly and included in the Workers Free plan's daily allowance.
 *
 * Env bindings expected:
 *   AI            — Workers AI binding (Settings → Bindings → Workers AI)
 *   ALLOW_ORIGIN  — (optional) CORS origin, e.g. https://cftheitguy.github.io
 */

const MAX_BYTES = 6 * 1024 * 1024; // 6MB — client resizes before upload, this is a backstop
const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const PROMPT = `You are a stand-up comedian doing a friendly, celebrity-roast-style bit. You'll be shown a photo of someone's desk, room, car, pet, plate of food, or other everyday scene.

Write a short, funny, PG-13 roast (3-5 sentences) of what's IN THE PHOTO — the mess, the decor, the choices, the vibe. Be witty and exaggerated, like a comedy roast, never genuinely cruel.

Rules:
- Roast objects, spaces, and vibes — NOT people's bodies, faces, appearance, race, gender, disability, age, or any protected characteristic.
- If a person is visible, you may gently riff on their outfit or the scene around them, never their physical appearance.
- No slurs, no hate speech, no sexual content, no insults meant to actually hurt.
- Keep it light and shareable — friendly ribbing, not bullying.
- If the photo doesn't show much, riff on that fact itself.
- Output ONLY the roast text. No preamble, no "Here's your roast:", no quotation marks.`;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Linear Roast Online", { headers: cors });
    }

    // TEMPORARY — one-time license acceptance for the gated Llama vision
    // model. Hit this once, then delete this route.
    if (url.pathname === "/agree" && request.method === "GET") {
      try {
        const result = await env.AI.run(MODEL, { prompt: "agree", max_tokens: 10 });
        return json({ result }, 200, cors);
      } catch (err) {
        return json({ error: String(err && err.message || err) }, 500, cors);
      }
    }

    if (url.pathname === "/roast" && request.method === "POST") {
      let form;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "Expected multipart/form-data." }, 400, cors);
      }

      const file = form.get("image");
      if (!file || typeof file === "string") {
        return json({ error: "No image uploaded." }, 400, cors);
      }
      if (file.size > MAX_BYTES) {
        return json({ error: "Image too large (max 6MB)." }, 400, cors);
      }
      if (!file.type || !file.type.startsWith("image/")) {
        return json({ error: "File must be an image." }, 400, cors);
      }

      try {
        const bytes = [...new Uint8Array(await file.arrayBuffer())];

        const result = await env.AI.run(MODEL, {
          image: bytes,
          prompt: PROMPT,
          max_tokens: 300,
        });

        const roast = (result && (result.response || result.description)) || "";
        if (!roast.trim()) {
          return json(
            { error: "Couldn't come up with a roast for that one. Try another photo." },
            502,
            cors
          );
        }

        return json({ roast: roast.trim() }, 200, cors);
      } catch (err) {
        return json({ error: "Something broke while roasting that.", detail: String(err && err.message || err) }, 500, cors);
      }
    }

    return json({ error: "Not found" }, 404, cors);
  },
};
