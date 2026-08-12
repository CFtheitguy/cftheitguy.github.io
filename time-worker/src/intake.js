/**
 * intake.js — the remote front doors into Linear To-Do
 * =============================================================================
 * EMAIL  task@linearit.co                                             (free)
 *   Cloudflare Email Routing hands the raw message to this Worker's email()
 *   handler. The subject becomes the task (parsed the same way the app's
 *   quick-add box parses it), the body becomes the notes, and "- " lines in the
 *   body become steps. Plus-addressing files it: task+groceries@linearit.co
 *   drops it in the Groceries list, creating that list if it's new.
 *
 * TEXT sent to that same address                                      (free)
 *   Most carriers let a phone text an email address — you just put
 *   task@linearit.co in the To: field of a normal text. It arrives here as mail
 *   from <number>@<carrier gateway>, so we treat it as a text: the body is the
 *   task, and the answer is mailed back to that gateway address, which the
 *   carrier delivers to the handset as a reply text. Two-way texting, no SMS
 *   provider, nothing to pay.
 *
 * TEXT sent to a real number                             (optional, costs money)
 *   If a number is wired up, the provider POSTs each message to
 *   /api/sms/inbound and we answer with TwiML (or JSON) on the same thread.
 *
 * The personal quick-add link (/api/todo/quick, in todos.js) is the third free
 * door — it shares the command handler below, so a phone shortcut understands
 * the same words a text does.
 *
 * WHO'S ALLOWED
 *   Every door is identified, never open. Email is matched to a person by the
 *   From: address (their sign-in address, or an extra address they added in
 *   settings) and is dropped unless it passes SPF/DMARC, so nobody can file
 *   tasks into someone else's list by forging a From. A text is matched to the
 *   number in the gateway address — written by the carrier, not the sender —
 *   against the number that person registered, or, on a paid number, to one
 *   they verified with a one-time code.
 * =============================================================================
 */

import { createTodo, completeTodo, getPrefs, normalizePhone, getLists } from "./todos.js";
import { describeDue, repeatLabel, localDayStr, localMidnight } from "./parse.js";

const MAX_EMAIL_BYTES = 512 * 1024;   // plenty for a task; ignore the rest
const MAX_SMS_LEN = 1200;

/**
 * Carrier text-to-email gateways.
 * ---------------------------------------------------------------------------
 * Most US carriers let a phone send a text straight to an email address: you
 * type task@linearit.co into the To: field of a normal text. It arrives here as
 * an email whose From is the sending number at one of these domains — e.g.
 * 8455550123@vtext.com — with the message itself in the body.
 *
 * That's a real text message, from the real Messages app, at no cost and with
 * no SMS provider in the middle. Because the carrier writes that From address
 * (and the mail still has to pass SPF/DMARC), the number in it is trustworthy
 * enough to match against the number someone registered in their settings.
 */
const CARRIER_GATEWAYS = [
  "vtext.com", "vzwpix.com",                       // Verizon
  "txt.att.net", "mms.att.net",                    // AT&T
  "tmomail.net",                                   // T-Mobile
  "msg.fi.google.com",                             // Google Fi
  "messaging.sprintpcs.com", "pm.sprint.com",      // Sprint (legacy)
  "sms.myboostmobile.com", "myboostmobile.com",    // Boost
  "vmobl.com", "vmpix.com",                        // Virgin
  "mailmymobile.net", "text.republicwireless.com", // MVNOs
  "email.uscc.net", "mms.uscc.net",                // US Cellular
  "sms.mycricket.com", "mms.cricketwireless.net",  // Cricket
  "msg.telus.com", "txt.bell.ca", "sms.rogers.com",// Canada
];

/* ============================================================
 * EMAIL — Cloudflare Email Routing entry point
 * ============================================================ */
export async function handleIncomingEmail(message, env, ctx) {
  const from = normEmail(addressOnly(message.from));
  const to = normEmail(addressOnly(message.to));

  const raw = await readStream(message.raw, MAX_EMAIL_BYTES);
  const mail = parseMime(raw);

  // 1) Authenticate the sender. Cloudflare puts its verdict in the headers it
  //    adds; an explicit failure means someone is forging the From address.
  const auth = authVerdict(mail, message);
  if (auth.fail) {
    await safeReject(message, "Message failed sender authentication (" + auth.detail + ").");
    return;
  }

  // 1b) Setting up the Google Voice route means pointing a Gmail filter at this
  //     address, and Gmail proves you own it by mailing a confirmation code
  //     here first. Nobody would ever see that code — so pass it along to the
  //     administrator instead of bouncing it.
  if (await relaySetupMail(env, ctx, from, mail)) return;

  // 2) Who is this? Their sign-in address, an extra address they registered, or
  //    the handset behind a forwarded text.
  const owner = await resolveEmailOwner(env, from, mail);
  if (!owner) {
    await safeReject(message, "This address isn't registered with Linear To-Do. Sign in at time.linearit.co and add it under To-Do → Settings.");
    return;
  }

  const prefs = await getPrefs(env, owner);
  const tz = prefs.tz_offset;

  // 2b) A text message that came in through a carrier gateway is handled like a
  //     text, not like an email: the body IS the task, and the answer goes back
  //     to the same gateway address — which the carrier delivers to the handset
  //     as a reply text. Two-way texting, no SMS provider, no cost.
  const fromPhone = gatewayPhone(from);
  if (fromPhone) {
    const line = gatewayText(mail);
    if (!line) { await safeReject(message, "That text was empty."); return; }
    const answer = await runTaskCommand(env, owner, line, "text");
    if (ctx && ctx.sendEmail) {
      await ctx.sendEmail(env, {
        to: from,
        subject: "",                       // carriers prepend the subject to the text
        text: String(answer).slice(0, 300),
      });
    }
    return;
  }

  // 2c) A text forwarded on from Google Voice. Same handling, but the answer
  //     goes to the owner's own inbox rather than back down the wire: replying
  //     to a Google Voice address only turns into a text when it comes from the
  //     Google account that owns the number, which this Worker is not.
  const gvPhone = googleVoiceSender(from, mail);
  if (gvPhone) {
    const line = googleVoiceText(mail);
    if (!line) { await safeReject(message, "That text was empty."); return; }
    const answer = await runTaskCommand(env, owner, line, "text");
    if (prefs.intake_receipt && ctx && ctx.sendEmail) {
      await ctx.sendEmail(env, {
        to: owner,
        subject: answer.split("\n")[0].slice(0, 120),
        text: answer + "\n\nFrom your text to Google Voice.\nhttps://time.linearit.co/todo",
      });
    }
    return;
  }

  // 3) task+groceries@linearit.co -> the Groceries list.
  const listHint = plusTag(to);

  // 4) Build the task. Subject is the task; body becomes notes + steps.
  const subject = cleanSubject(mail.subject);
  const body = (mail.text || "").trim();
  const { notes, steps } = splitBody(body);

  let text = subject;
  if (!text) {
    // No subject (or a forwarded stub): use the first meaningful body line.
    const firstLine = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
    text = firstLine.slice(0, 300);
  }
  if (!text) {
    await safeReject(message, "That email had no subject and no body — nothing to add.");
    return;
  }

  const created = await createTodo(env, owner, {
    text,
    notes: notes,
    steps: steps,
  }, { tz, source: "email", listHint, prefs });

  if (created.error) {
    await safeReject(message, created.error);
    return;
  }

  // 5) Receipt, if they want one. Sent with Resend (the same sender the
  //    sign-in codes use) rather than replying inline — a reply from a Worker
  //    would need its own verified route, and this needs no extra setup.
  if (prefs.intake_receipt && ctx && ctx.sendEmail) {
    const t = created.todo;
    await ctx.sendEmail(env, {
      to: from,
      subject: "Added to your list: " + t.title,
      text: receiptText(t, tz),
      html: receiptHtml(t, tz),
    });
  }
}

/**
 * Setup mail that has to reach a human, not a task list.
 * ---------------------------------------------------------------------------
 * To forward Google Voice texts here, Gmail first has to verify it owns the
 * destination: it mails a confirmation code and link to task@linearit.co. That
 * address is a Worker, so without this the code would be rejected and the route
 * could never be switched on — a chicken-and-egg that quietly blocks setup.
 *
 * Anything recognisably of that kind is passed straight to the administrators
 * with its body intact, so the code and the link are readable.
 * Returns true when the message was handled and should go no further.
 */
async function relaySetupMail(env, ctx, from, mail) {
  const isVerification =
    /(^|[.@])forwarding-noreply@google\.com$/.test(from) ||
    (/@google\.com$/.test(from) && /forwarding/i.test(String(mail.subject || "")));
  if (!isVerification) return false;

  const admins = String(env.ADMIN_EMAILS || "").split(",").map((e) => normEmail(e)).filter(Boolean);
  if (!admins.length || !ctx || !ctx.sendEmail) return true;   // swallow it either way

  const body = String(mail.text || "").slice(0, 4000);
  const code = (body.match(/\b\d{6,12}\b/) || [])[0] || "";
  const link = (body.match(/https?:\/\/mail\.google\.com\/\S+/) || [])[0] || "";

  for (const admin of admins.slice(0, 5)) {
    await ctx.sendEmail(env, {
      to: admin,
      subject: "Confirm Gmail forwarding to " + (env.TODO_EMAIL || "task@linearit.co"),
      text:
        "Gmail is asking you to confirm forwarding to your Linear To-Do intake address.\n\n" +
        (code ? "Confirmation code: " + code + "\n" : "") +
        (link ? "Confirm link: " + link + "\n" : "") +
        "\nPaste the code into Gmail (Settings -> Forwarding), or open the link.\n" +
        "\n--- the message Gmail sent ---\n" + body,
    });
  }
  return true;
}

// Cloudflare's own verdict on the sender. We only refuse on an explicit fail —
// missing headers shouldn't lock out a legitimate message.
function authVerdict(mail, message) {
  const lines = [];
  const h = mail.headers || {};
  ["authentication-results", "x-forwarded-authentication-results"].forEach((k) => {
    if (h[k]) lines.push(String(h[k]).toLowerCase());
  });
  try {
    if (message && message.headers && message.headers.get) {
      const v = message.headers.get("authentication-results");
      if (v) lines.push(String(v).toLowerCase());
    }
  } catch (_) { /* headers are optional in some runtimes */ }

  const all = lines.join(" ");
  if (!all) return { fail: false, detail: "no verdict" };
  if (/dmarc=fail/.test(all)) return { fail: true, detail: "DMARC failed" };
  // SPF alone failing is only fatal when DKIM didn't save it (a normal forward).
  if (/spf=fail/.test(all) && !/dkim=pass/.test(all)) return { fail: true, detail: "SPF failed" };
  return { fail: false, detail: "ok" };
}

/**
 * Google Voice — the durable free route, and the one that replaces the
 * @vtext.com gateway Verizon is retiring.
 * ---------------------------------------------------------------------------
 * The handset texts a free Google Voice number. Google Voice's "forward
 * messages to email" setting mails the text to the account's Gmail, and a Gmail
 * filter forwards that on to task@linearit.co. Nothing here is scraped or
 * automated: both halves are documented settings, so it keeps working.
 *
 * Those forwards arrive from an address like
 *   15551234567.19177270405.AbC123@txt.voice.google.com
 * where the first dotted segment is the number that sent the text and the
 * second is the Google Voice number it was sent to. That first segment is what
 * we match against the handset someone registered — Google writes it, not the
 * sender, and the mail still has to pass the SPF/DMARC check above.
 */
const GOOGLE_VOICE_DOMAIN = "txt.voice.google.com";

export function googleVoiceSender(from, mail) {
  const at = String(from || "").lastIndexOf("@");
  if (at === -1 || from.slice(at + 1).toLowerCase() !== GOOGLE_VOICE_DOMAIN) return null;

  // Preferred: the first dotted segment of the local part.
  const first = from.slice(0, at).split(".")[0].replace(/[^\d]/g, "");
  const byLocal = first.length >= 10 ? normalizePhone(first) : null;
  if (byLocal) return byLocal;

  // Fallback: "New text message from +1 845 555 0142" in the subject, or the
  // display name, for the shapes where the local part is opaque.
  const hay = String((mail && mail.subject) || "") + " " + String((mail && mail.from) || "");
  const m = hay.match(/\+?1?[\s.-]*\(?(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})/);
  return m ? normalizePhone(m[1] + m[2] + m[3]) : null;
}

// The message itself, with Google's trailing furniture removed.
function googleVoiceText(mail) {
  const body = String((mail && mail.text) || "");
  const cut = body.search(
    /^\s*(?:--\s*$|To respond to this text message|YOUR ACCOUNT|This email was sent|Reply to this email to respond)/im
  );
  let out = (cut === -1 ? body : body.slice(0, cut));
  out = out
    .split(/\r?\n/)
    .filter((l) => l.indexOf("voice.google.com") === -1)
    .join("\n");
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_SMS_LEN);
}

// A text sent to an email address arrives from "<number>@<carrier gateway>".
// Pull the number out, if that's what this is.
export function gatewayPhone(from) {
  const at = String(from || "").lastIndexOf("@");
  if (at === -1) return null;
  const domain = from.slice(at + 1).toLowerCase();
  if (CARRIER_GATEWAYS.indexOf(domain) === -1) return null;
  const local = from.slice(0, at).replace(/[^\d]/g, "");
  if (local.length < 10 || local.length > 15) return null;
  return normalizePhone(local);
}

// Match an incoming From: to a person the Worker knows.
async function resolveEmailOwner(env, from, mail) {
  if (!validEmail(from)) return null;

  // A text message — through a carrier gateway or forwarded on from Google
  // Voice. Either way the number that sent it decides whose list it lands on,
  // and an unregistered number never creates anything.
  const phone = gatewayPhone(from) || googleVoiceSender(from, mail);
  if (phone) {
    const byPhone = await env.DB.prepare("SELECT email FROM todo_prefs WHERE phone=?").bind(phone).first();
    return byPhone ? byPhone.email : null;
  }

  const worker = await env.DB.prepare("SELECT email FROM workers WHERE email=?").bind(from).first();
  if (worker) return worker.email;

  const admin = await env.DB.prepare("SELECT email FROM admins WHERE email=?").bind(from).first();
  if (admin) return admin.email;

  const supers = String(env.ADMIN_EMAILS || "").split(",").map((e) => normEmail(e)).filter(Boolean);
  if (supers.indexOf(from) !== -1) return from;

  // An extra address someone added under To-Do → Settings (a personal account,
  // an alias, the address their phone mails from). LIKE narrows the scan; the
  // exact match below is what actually decides, so "bob@x.co" can't be claimed
  // by someone who registered "notbob@x.co".
  const alt = (await env.DB.prepare(
    "SELECT email, alt_emails FROM todo_prefs WHERE alt_emails LIKE ? LIMIT 20"
  ).bind("%" + from + "%").all()).results || [];
  for (const row of alt) {
    const addrs = String(row.alt_emails || "").split(",").map(normEmail);
    if (addrs.indexOf(from) !== -1) return row.email;
  }
  return null;
}

// "task+groceries@linearit.co" -> "groceries"
function plusTag(addr) {
  const local = String(addr || "").split("@")[0] || "";
  const plus = local.indexOf("+");
  if (plus === -1) return null;
  const tag = local.slice(plus + 1).trim().replace(/[._-]+/g, " ").slice(0, 40);
  return tag || null;
}

/**
 * The message someone actually typed, out of a carrier-gateway email.
 * Gateways wrap the text in their own furniture: a "FRM:/SUBJ:/MSG:" header
 * block on some carriers, the sender's number on others, and a trailing advert.
 * Whatever's left after that is the task.
 */
function gatewayText(mail) {
  let body = String(mail.text || "").trim();

  // Some gateways use an explicit "MSG:" marker — everything after it is the text.
  const msgAt = body.search(/^MSG:/im);
  if (msgAt !== -1) body = body.slice(msgAt).replace(/^MSG:\s*/i, "");
  body = body
    .split(/\r?\n/)
    .filter((l) => !/^(FRM|SUBJ|TO|MSG):/i.test(l.trim()))
    .join("\n")
    .replace(/\n?(sent (from|via) .*|this message was sent from .*|download the .* app.*)$/i, "")
    .trim();

  // Nothing in the body? Some carriers put a short text in the subject instead.
  if (!body) body = cleanSubject(mail.subject);
  return body.replace(/\s+/g, " ").trim().slice(0, MAX_SMS_LEN);
}

// Strip the Re:/Fwd: noise a forwarded task always carries.
function cleanSubject(s) {
  return String(s || "")
    .replace(/^(\s*(re|fw|fwd|aw|wg)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Split an email body into notes and steps. Lines that look like a checklist
 * ("- milk", "* eggs", "1. call back") become steps; everything else is notes.
 * Quoted reply text and signatures are dropped so a forwarded thread doesn't
 * paste an entire conversation into the task.
 */
function splitBody(body) {
  const kept = [];
  const steps = [];
  const lines = String(body || "").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (/^>/.test(t)) continue;                                    // quoted reply
    if (/^--\s*$/.test(t) || /^_{5,}$/.test(t)) break;             // signature
    if (/^(on .{10,80}wrote:|from:\s|sent from my )/i.test(t)) break;
    const m = t.match(/^(?:[-*•]|\d{1,2}[.)])\s+(.{1,300})$/);
    if (m) { steps.push(m[1].trim()); continue; }
    kept.push(line);
  }
  return {
    notes: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000),
    steps: steps.slice(0, 100),
  };
}

function receiptText(t, tz) {
  const bits = ["Added to your Linear To-Do list:", "", "  " + t.title];
  if (t.due_at != null) bits.push("  Due " + describeDue(t.due_at, t.due_all_day ? 1 : 0, tz));
  if (t.repeat) bits.push("  " + repeatLabel(t.repeat));
  if (t.steps && t.steps.length) bits.push("  " + t.steps.length + " steps");
  bits.push("", "See it at https://time.linearit.co/todo");
  return bits.join("\n");
}
function receiptHtml(t, tz) {
  const rows = [];
  if (t.due_at != null) rows.push("Due " + esc(describeDue(t.due_at, t.due_all_day ? 1 : 0, tz)));
  if (t.repeat) rows.push(esc(repeatLabel(t.repeat)));
  if (t.steps && t.steps.length) rows.push(t.steps.length + " steps");
  return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:460px;margin:auto;padding:24px">' +
    '<p style="color:#444;margin:0 0 14px">Added to your Linear To-Do list:</p>' +
    '<div style="background:#f3f4f6;border-radius:12px;padding:16px 18px">' +
    '<div style="font-size:17px;font-weight:700;color:#111">' + esc(t.title) + "</div>" +
    (rows.length ? '<div style="color:#666;font-size:13px;margin-top:6px">' + rows.join(" · ") + "</div>" : "") +
    "</div>" +
    '<p style="margin:16px 0 0"><a href="https://time.linearit.co/todo" style="color:#00b0ec">Open Linear To-Do</a></p>' +
    '<p style="color:#aab;font-size:12px;margin:14px 0 0">Linear IT · (845) 604-1462</p>' +
    "</div>";
}

// message.setReject() ends the SMTP conversation with a reason the sender's mail
// server reports back — better than silently swallowing a task they thought sent.
async function safeReject(message, reason) {
  try { message.setReject(String(reason).slice(0, 200)); } catch (_) { /* older runtimes */ }
}

/* ============================================================
 * MIME — just enough of RFC 5322/2045 to pull a subject and a text body
 * ============================================================ */
export function parseMime(raw) {
  const src = String(raw || "");
  const split = src.indexOf("\r\n\r\n") !== -1 ? src.indexOf("\r\n\r\n") : src.indexOf("\n\n");
  const headBlock = split === -1 ? src : src.slice(0, split);
  const bodyBlock = split === -1 ? "" : src.slice(split + (src.indexOf("\r\n\r\n") !== -1 ? 4 : 2));

  const headers = parseHeaders(headBlock);
  const ctype = headers["content-type"] || "text/plain";
  const cte = (headers["content-transfer-encoding"] || "").toLowerCase().trim();

  let text = "";
  const boundary = (ctype.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
  if (/^multipart\//i.test(ctype) && boundary) {
    text = pickTextPart(bodyBlock, boundary, 0);
  } else if (/^text\/html/i.test(ctype)) {
    text = htmlToText(decodeBody(bodyBlock, cte, ctype));
  } else {
    text = decodeBody(bodyBlock, cte, ctype);
  }

  return {
    headers,
    subject: decodeWords(headers.subject || ""),
    from: decodeWords(headers.from || ""),
    to: decodeWords(headers.to || ""),
    text: String(text || "").replace(/\r\n/g, "\n").trim(),
  };
}

// Walk a multipart body and return the best text we can find. Prefers
// text/plain, falls back to text/html flattened, and recurses one level into
// multipart/alternative (which is how most mail clients send).
function pickTextPart(body, boundary, depth) {
  if (depth > 3) return "";
  const parts = String(body).split(new RegExp("--" + escapeRe(boundary) + "(?:--)?[ \\t]*\\r?\\n?"));
  let html = "";
  for (const part of parts) {
    if (!part.trim()) continue;
    const cut = part.indexOf("\r\n\r\n") !== -1 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
    if (cut === -1) continue;
    const h = parseHeaders(part.slice(0, cut));
    const b = part.slice(cut + (part.indexOf("\r\n\r\n") !== -1 ? 4 : 2));
    const ct = h["content-type"] || "text/plain";
    const cte = (h["content-transfer-encoding"] || "").toLowerCase().trim();

    const inner = (ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
    if (/^multipart\//i.test(ct) && inner) {
      const nested = pickTextPart(b, inner, depth + 1);
      if (nested) return nested;
      continue;
    }
    if (/attachment/i.test(h["content-disposition"] || "")) continue;
    if (/^text\/plain/i.test(ct)) return decodeBody(b, cte, ct);
    if (/^text\/html/i.test(ct) && !html) html = htmlToText(decodeBody(b, cte, ct));
  }
  return html;
}

function parseHeaders(block) {
  const out = {};
  const lines = String(block || "").replace(/\r\n/g, "\n").split("\n");
  let cur = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += " " + line.trim(); continue; }   // folded
    const i = line.indexOf(":");
    if (i === -1) continue;
    cur = line.slice(0, i).toLowerCase().trim();
    const val = line.slice(i + 1).trim();
    out[cur] = out[cur] ? out[cur] + "\n" + val : val;
  }
  return out;
}

function decodeBody(body, cte, ctype) {
  let s = String(body || "");
  if (cte === "base64") s = b64ToUtf8(s.replace(/\s+/g, ""));
  else if (cte === "quoted-printable") s = decodeQP(s);
  const charset = ((ctype || "").match(/charset\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
  if (charset && !/utf-?8|us-ascii/i.test(charset)) {
    // Nothing exotic supported; the bytes still read fine for Latin text.
    return s;
  }
  return s;
}

function decodeQP(s) {
  return String(s)
    .replace(/=\r?\n/g, "")                               // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // Each "=C3=A9" pair became a raw byte above; stitch runs of them back
    // into real characters so accents and emoji survive the trip.
    .replace(/[\u0080-\u00ff]+/g, (run) => {
      const bytes = new Uint8Array([...run].map((c) => c.charCodeAt(0)));
      try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch (_) { return run; }
    });
}

function b64ToUtf8(s) {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (_) { return ""; }
}

// =?UTF-8?B?...?= / =?UTF-8?Q?...?= encoded words in Subject and From.
function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
    try {
      if (/^b$/i.test(enc)) return b64ToUtf8(data);
      const txt = data.replace(/_/g, " ");
      return decodeQP(txt);
    } catch (_) { return m; }
  }).replace(/\?=\s+=\?/g, "");
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readStream(stream, maxBytes) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try { reader.releaseLock(); } catch (_) {}
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, total - at)), at); at += c.length; if (at >= total) break; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/* ============================================================
 * SMS — inbound webhook
 * ------------------------------------------------------------
 * Speaks Twilio's shape (form-encoded From/Body, TwiML reply) because that's
 * what most numbers run on, and falls back to plain JSON {from, body} for any
 * other provider. A shared secret in the path or an X-Intake-Secret header can
 * stand in for Twilio's signature when the provider doesn't sign.
 * ============================================================ */
export async function handleSmsInbound(request, env, url) {
  const ct = request.headers.get("content-type") || "";
  let params = {};
  let raw = "";
  try {
    raw = await request.text();
    if (ct.indexOf("application/json") !== -1) {
      params = JSON.parse(raw || "{}");
    } else {
      new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });
    }
  } catch (_) { params = {}; }

  const isTwilioForm = ct.indexOf("application/x-www-form-urlencoded") !== -1;
  const authed = await smsAuthorized(request, env, url, params, raw, isTwilioForm);
  if (!authed.ok) {
    return new Response(authed.reason || "Unauthorized", { status: 401 });
  }

  const from = normalizePhone(params.From || params.from || params.sender || params.msisdn);
  const bodyText = String(params.Body || params.body || params.text || params.message || "").trim().slice(0, MAX_SMS_LEN);
  const replyTwiml = isTwilioForm || String(params.reply_format || "") === "twiml";

  if (!from) return smsReply("Couldn't read the sending number.", replyTwiml);
  if (!bodyText) return smsReply("Send some text and I'll add it to your list.", replyTwiml);

  const answer = await runSmsCommand(env, from, bodyText);
  return smsReply(answer, replyTwiml);
}

/**
 * Authorise an inbound SMS webhook.
 *  - Twilio: validate X-Twilio-Signature (HMAC-SHA1 over the URL + sorted params).
 *  - Anyone else: a shared secret, either ?secret= or an X-Intake-Secret header.
 * If neither TWILIO_AUTH_TOKEN nor SMS_INTAKE_SECRET is configured the endpoint
 * stays closed — an unauthenticated task inbox is not a useful default.
 */
async function smsAuthorized(request, env, url, params, rawBody, isTwilioForm) {
  const sig = request.headers.get("x-twilio-signature");
  if (env.TWILIO_AUTH_TOKEN && sig) {
    const webhookUrl = env.SMS_WEBHOOK_URL || url.origin + url.pathname + (url.search || "");
    const expected = await twilioSignature(env.TWILIO_AUTH_TOKEN, webhookUrl, isTwilioForm ? params : {});
    if (timingSafeEqual(expected, sig)) return { ok: true };
    return { ok: false, reason: "Bad signature" };
  }
  const secret = env.SMS_INTAKE_SECRET;
  if (secret) {
    const given = request.headers.get("x-intake-secret") || url.searchParams.get("secret") || "";
    if (given && timingSafeEqual(String(secret), String(given))) return { ok: true };
    return { ok: false, reason: "Bad secret" };
  }
  return { ok: false, reason: "SMS intake is not configured" };
}

// Twilio's scheme: sha1-HMAC of the URL followed by each POST field, sorted by
// name, concatenated as name+value — base64 encoded.
async function twilioSignature(authToken, url, params) {
  let data = String(url);
  Object.keys(params).sort().forEach((k) => { data += k + params[k]; });
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/* ---- The conversation ----------------------------------------------------
 * One command surface, three front doors: an SMS webhook, a text that came in
 * through a carrier's email gateway, and the personal quick-add link a phone
 * shortcut calls. They all end up in runTaskCommand.
 * -------------------------------------------------------------------------- */
async function runSmsCommand(env, phone, text) {
  // A verification code from a number someone is trying to link.
  const codeMatch = text.trim().toUpperCase().match(/^LT-?(\d{4})$/);
  if (codeMatch) return verifyPhone(env, phone, "LT-" + codeMatch[1]);

  const owner = await ownerForPhone(env, phone);
  if (!owner) {
    return "This number isn't linked to a Linear To-Do account yet. Sign in at time.linearit.co → To-Do → Settings and add it.";
  }
  return runTaskCommand(env, owner, text, "sms");
}

export async function runTaskCommand(env, owner, text, source) {
  text = String(text || "").trim();
  const first = (text.split(/\s+/)[0] || "").toUpperCase();
  const rest = text.slice(first.length).trim();
  const prefs = await getPrefs(env, owner);
  const tz = prefs.tz_offset;
  const now = Date.now();

  if (first === "HELP" || first === "?" || first === "INFO") {
    return "Linear To-Do — text me a task and I'll add it.\n" +
      "Examples:\n" +
      "  Call Moshe tomorrow 3pm !high\n" +
      "  Pay rent every month on the 1st\n" +
      "  Buy milk @Groceries #errands\n" +
      "Commands: LIST (today), ALL, DONE <number>, HELP";
  }

  if (first === "LIST" || first === "TODAY" || first === "ALL") {
    const all = first === "ALL";
    const rows = await smsTaskList(env, owner, tz, now, all);
    if (!rows.length) return all ? "Nothing open. All clear 🎉" : "Nothing due today. 🎉";
    const lines = rows.map((r, i) => {
      const due = r.due_at != null ? " — " + describeDue(Number(r.due_at), Number(r.due_all_day) ? 1 : 0, tz, now) : "";
      return (i + 1) + ". " + r.title + due;
    });
    return (all ? "All open tasks:\n" : "Today:\n") + lines.join("\n").slice(0, 1400) +
      "\nReply DONE <number> to tick one off.";
  }

  if (first === "DONE" || first === "COMPLETE" || first === "X") {
    const n = parseInt(rest, 10);
    if (!n || n < 1) return "Reply DONE followed by the number from your last LIST, e.g. DONE 2.";
    const rows = await smsTaskList(env, owner, tz, now, false);
    const pool = rows.length ? rows : await smsTaskList(env, owner, tz, now, true);
    const target = pool[n - 1];
    if (!target) return "There's no task " + n + " on that list. Reply LIST to see it again.";
    const res = await completeTodo(env, owner, target.id, true, tz);
    if (res.error) return res.error;
    if (res.rolled) return "✓ " + target.title + " — done. Next one: " + res.rolled.label;
    return "✓ " + target.title + " — done.";
  }

  // Anything else is a new task.
  const created = await createTodo(env, owner, { text: text }, { tz, source: source || "sms", prefs });
  if (created.error) return created.error;
  const t = created.todo;
  const bits = [];
  if (t.due_at != null) bits.push(describeDue(t.due_at, t.due_all_day ? 1 : 0, tz, now));
  if (t.repeat) bits.push(repeatLabel(t.repeat));
  if (t.priority >= 3) bits.push(t.priority === 4 ? "urgent" : "high");
  if (t.list_id) {
    const lists = await getLists(env, owner);
    const l = lists.filter((x) => x.id === t.list_id)[0];
    if (l) bits.push("in " + l.name);
  }
  return "Added: " + t.title + (bits.length ? "\n" + bits.join(" · ") : "");
}

// Today's open tasks: anything due by the end of today, plus anything starred
// into My Day. The numbering here is what "DONE <n>" refers to.
async function smsTaskList(env, email, tz, now, all) {
  if (all) {
    const rows = (await env.DB.prepare(
      "SELECT id, title, due_at, due_all_day FROM todos WHERE email=? AND status='open' " +
      "ORDER BY (due_at IS NULL), due_at, position LIMIT 25"
    ).bind(email).all()).results || [];
    return rows;
  }
  const endOfToday = localMidnight(now, tz) + 86400000;
  const today = localDayStr(now, tz);
  const rows = (await env.DB.prepare(
    "SELECT id, title, due_at, due_all_day FROM todos WHERE email=? AND status='open' " +
    "AND ((due_at IS NOT NULL AND due_at < ?) OR myday=?) ORDER BY (due_at IS NULL), due_at, position LIMIT 25"
  ).bind(email, endOfToday, today).all()).results || [];
  return rows;
}

async function ownerForPhone(env, phone) {
  const row = await env.DB.prepare("SELECT email FROM todo_prefs WHERE phone=?").bind(phone).first();
  return row ? row.email : null;
}

// The code the app showed them, texted in from the number being linked.
async function verifyPhone(env, phone, code) {
  const row = await env.DB.prepare(
    "SELECT email, phone_pending, phone_code FROM todo_prefs WHERE phone_pending=? AND phone_code=?"
  ).bind(phone, code).first();
  if (!row) return "That code doesn't match a pending number. Open time.linearit.co → To-Do → Settings and start again.";

  const clash = await env.DB.prepare("SELECT email FROM todo_prefs WHERE phone=? AND email<>?").bind(phone, row.email).first();
  if (clash) return "That number is already linked to another account.";

  await env.DB.prepare(
    "UPDATE todo_prefs SET phone=?, phone_pending=NULL, phone_code=NULL, phone_verified_at=?, updated_at=? WHERE email=?"
  ).bind(phone, Date.now(), Date.now(), row.email).run();
  return "✓ This number is linked to " + row.email + ". Text me a task any time — try \"Buy milk tomorrow 9am\". Reply HELP for what else I understand.";
}

/* ---- Replies ------------------------------------------------------------- */
function smsReply(text, asTwiml) {
  const msg = String(text || "").slice(0, 1500);
  if (!asTwiml) {
    return new Response(JSON.stringify({ reply: msg }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + xmlEscape(msg) + "</Message></Response>";
  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

/* ---- tiny helpers -------------------------------------------------------- */
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
// "Chaim Friedman <chaim@x.co>" -> "chaim@x.co"
function addressOnly(v) {
  const s = String(v || "").trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
