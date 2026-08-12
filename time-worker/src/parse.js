/**
 * parse.js — natural-language quick-add for Linear To-Do
 * =============================================================================
 * One parser, three front doors. Typing into the app, emailing task@linearit.co
 * and texting the Linear number all end up here, so a task written any of those
 * ways lands with the same due date, reminder, priority, tags and repeat.
 *
 *   "Call Moshe tomorrow 3pm !high #calls @Work"
 *   "Pay the con-ed bill every month on the 5th"
 *   "Renew the SSL cert Aug 15 remind 2 days before"
 *
 * Everything it recognises is REMOVED from the title, so what's left reads like
 * a task and not like a command. Nothing here throws: if a phrase doesn't parse,
 * it simply stays part of the title.
 *
 * As each phrase is understood it is blanked out of a working copy of the text,
 * so a later rule can never re-read something an earlier one already claimed
 * ("remind me at 8am tomorrow 3pm" -> reminder 8am, due tomorrow 3pm).
 *
 * Times are local to the person. The caller passes `tz` — the same
 * `new Date().getTimezoneOffset()` minutes the rest of this app stores (UTC minus
 * local, so New York in summer is 240). local = utc - tz*60000.
 * ============================================================================= */

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};
const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// Named times of day, and the default reminder hour for an all-day task.
const DAYPARTS = { morning: 9, noon: 12, midday: 12, afternoon: 14, evening: 18, night: 20, tonight: 20, midnight: 0 };
export const DEFAULT_REMIND_HOUR = 9;

export const PRIORITY = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };
const PRIORITY_WORDS = {
  none: 0, p0: 0, low: 1, p3: 1, med: 2, medium: 2, normal: 2, p2: 2,
  high: 3, p1: 3, urgent: 4, asap: 4, critical: 4,
};

/* ============================================================
 * Local-time helpers (all timestamps stored/returned as UTC ms)
 * ============================================================ */
export function localParts(ms, tz) {
  const d = new Date(ms - (tz || 0) * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
export function fromLocal(y, mo, d, h, mi, tz) {
  return Date.UTC(y, mo, d, h || 0, mi || 0, 0, 0) + (tz || 0) * 60000;
}
export function localDayStr(ms, tz) {
  const p = localParts(ms, tz);
  return p.y + "-" + String(p.mo + 1).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}
// Local midnight of the day `ms` falls on, as a UTC timestamp.
export function localMidnight(ms, tz) {
  const p = localParts(ms, tz);
  return fromLocal(p.y, p.mo, p.d, 0, 0, tz);
}
function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); }

/* ============================================================
 * The working text: `text` is what the user wrote, `mask` is the same string
 * with every understood phrase blanked to spaces (indices stay aligned, so the
 * spans collected here still line up with `text` when we build the title).
 * ============================================================ */
function newCtx(s) { return { text: s, mask: s, cuts: [] }; }
function cutSpan(ctx, start, end) {
  if (!(end > start)) return;
  ctx.cuts.push([start, end]);
  ctx.mask = ctx.mask.slice(0, start) + " ".repeat(end - start) + ctx.mask.slice(end);
}
// Blank a whole match. `lead` skips a leading "(^|\s)" capture so the space stays.
function cutMatch(ctx, m, lead) {
  if (!m || m.index == null) return;
  const skip = lead ? (m[1] || "").length : 0;
  cutSpan(ctx, m.index + skip, m.index + m[0].length);
}

/* ============================================================
 * parseTask — the whole grammar
 * ------------------------------------------------------------
 * parseTask(text, { tz, now }) -> {
 *   title, notes, tags[], list_hint, priority, important,
 *   due_at, due_all_day, remind_at, repeat, matched[]
 * }
 * `matched` names the phrases that were understood, so the UI (and the SMS
 * reply) can echo back "Tomorrow 3:00 PM · high priority · #calls".
 * ============================================================ */
export function parseTask(text, opts) {
  const tz = Number((opts && opts.tz) || 0);
  const now = Number((opts && opts.now) || Date.now());
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();

  const out = {
    title: s, notes: "", tags: [], list_hint: null,
    priority: PRIORITY.NONE, important: 0,
    due_at: null, due_all_day: 0, remind_at: null, repeat: null, matched: [],
  };
  if (!s) return out;
  const ctx = newCtx(s);

  /* ---- @list (must start with a letter, so "@3pm" stays a time) ---- */
  let m = ctx.mask.match(/(^|\s)@(?:"([^"]{1,40})"|([\p{L}][\p{L}\p{N}_-]{0,39}))/u);
  if (m) {
    out.list_hint = (m[2] || m[3] || "").trim();
    cutMatch(ctx, m, true);
    out.matched.push("list " + out.list_hint);
  }

  /* ---- #tags ---- */
  const tagRe = /(^|\s)#([\p{L}\p{N}_-]{1,30})/gu;
  const tagHits = [];
  while ((m = tagRe.exec(ctx.mask)) !== null) tagHits.push(m);
  tagHits.forEach((hit) => {
    const tag = hit[2].toLowerCase();
    if (out.tags.indexOf(tag) === -1) out.tags.push(tag);
    cutMatch(ctx, hit, true);
  });
  if (out.tags.length) out.matched.push("#" + out.tags.join(" #"));

  /* ---- !priority, then the bare ! / * star ---- */
  m = ctx.mask.match(/(^|\s)!(none|p0|low|p3|med|medium|normal|p2|high|p1|urgent|asap|critical)\b/i);
  if (m) {
    out.priority = PRIORITY_WORDS[m[2].toLowerCase()];
    cutMatch(ctx, m, true);
    out.matched.push(priorityLabel(out.priority).toLowerCase() + " priority");
  }
  m = ctx.mask.match(/(^|\s)(\*|!!|!)(?=\s|$)/);
  if (m) {
    out.important = 1;
    cutMatch(ctx, m, true);
    out.matched.push("important");
  }

  /* ---- repeat ---- */
  parseRepeat(ctx, out);

  /* ---- reminder ("remind 30 min before", "remind me at 8am") ---- */
  let remindOffsetMs = null, remindClock = null;
  m = ctx.mask.match(/\b(?:remind(?:\s+me)?\s+)?(\d{1,3})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s+(?:before|prior|ahead)\b/i);
  if (m) {
    remindOffsetMs = Number(m[1]) * unitMs(m[2]);
    cutMatch(ctx, m);
    out.matched.push("remind " + m[1] + " " + m[2] + " before");
  }
  m = ctx.mask.match(/\b(?:remind(?:\s+me)?|alert|alarm)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (m && (m[3] || m[2])) {
    remindClock = clock24(m[1], m[2], m[3]);
    if (remindClock) cutMatch(ctx, m);
  }

  /* ---- when: date and/or time ---- */
  const when = parseWhen(ctx, tz, now);

  /* ---- what's left is the title ---- */
  out.title = stripCuts(ctx);

  /* ---- due ---- */
  if (when.hasDate || when.hasTime) {
    const base = localParts(now, tz);
    const y = when.y != null ? when.y : base.y;
    const mo = when.mo != null ? when.mo : base.mo;
    const d = when.d != null ? when.d : base.d;

    if (when.hasTime) {
      let due = fromLocal(y, mo, d, when.h, when.mi, tz);
      // A bare time that has already gone by today means they mean tomorrow.
      if (!when.hasDate && due <= now) due += 86400000;
      out.due_at = due;
      out.due_all_day = 0;
    } else {
      out.due_at = fromLocal(y, mo, d, 0, 0, tz);
      out.due_all_day = 1;
    }
  }
  if (when.exactMs != null) { out.due_at = when.exactMs; out.due_all_day = 0; }

  /* ---- a repeat with no date of its own starts at its next matching slot ----
   * "gym every mon and thu at 6am" on a Wednesday means Thursday, not tomorrow;
   * "water plants every 3 days" starts today. */
  if (out.repeat) {
    const days = repeatDays(out.repeat);
    if (out.due_at == null) {
      const p = localParts(now, tz);
      out.due_at = fromLocal(p.y, p.mo, p.d, 0, 0, tz);
      out.due_all_day = 1;
    }
    if (!when.hasDate && days) out.due_at = snapToDays(out.due_at, days, tz);
  }

  /* ---- reminder ---- */
  if (out.due_at != null) {
    if (remindClock != null) {
      const p = localParts(out.due_at, tz);
      out.remind_at = fromLocal(p.y, p.mo, p.d, remindClock.h, remindClock.mi, tz);
    } else if (remindOffsetMs != null) {
      // An all-day task is treated as due at 9am for "…before" maths.
      const anchor = out.due_all_day ? out.due_at + DEFAULT_REMIND_HOUR * 3600000 : out.due_at;
      out.remind_at = anchor - remindOffsetMs;
    } else if (out.due_all_day) {
      const p = localParts(out.due_at, tz);
      out.remind_at = fromLocal(p.y, p.mo, p.d, DEFAULT_REMIND_HOUR, 0, tz);
    } else {
      out.remind_at = out.due_at;                     // timed task: remind when it's due
    }
    out.matched.push(describeDue(out.due_at, out.due_all_day, tz, now));
  }

  if (!out.title) out.title = s;                      // all command, no words — keep the original
  return out;
}

/* ---- repeat phrases ---------------------------------------- */
function parseRepeat(ctx, out) {
  let m = ctx.mask.match(/\bevery\s+(?:(\d{1,3})\s+)?(day|days|week|weeks|month|months|year|years|weekday|weekdays|weekend|weekends)\b/i);
  if (m) {
    const n = m[1] ? Math.max(1, Math.min(365, Number(m[1]))) : 1;
    const unit = m[2].toLowerCase();
    if (unit.indexOf("weekday") === 0) out.repeat = { kind: "weekday", n: 1 };
    else if (unit.indexOf("weekend") === 0) out.repeat = { kind: "week", n: 1, days: [0, 6] };
    else out.repeat = { kind: unit.replace(/s$/, ""), n: n };
    cutMatch(ctx, m);
    out.matched.push("repeats " + repeatLabel(out.repeat).toLowerCase());
    return;
  }
  // "every monday", "every mon and thu"
  const DAY_ALT = "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat";
  m = ctx.mask.match(new RegExp("\\bevery\\s+((?:" + DAY_ALT + ")(?:\\s*(?:,|and|&)\\s*(?:" + DAY_ALT + "))*)\\b", "i"));
  if (m) {
    const days = [];
    m[1].toLowerCase().split(/\s*(?:,|and|&)\s*/).forEach((w) => {
      const n = WEEKDAYS[w.trim()];
      if (n != null && days.indexOf(n) === -1) days.push(n);
    });
    if (days.length) {
      out.repeat = { kind: "week", n: 1, days: days.sort() };
      cutMatch(ctx, m);
      out.matched.push("repeats " + repeatLabel(out.repeat).toLowerCase());
    }
    return;
  }
  m = ctx.mask.match(/\b(daily|weekly|biweekly|fortnightly|monthly|quarterly|yearly|annually)\b/i);
  if (m) {
    const w = m[1].toLowerCase();
    out.repeat =
      w === "daily" ? { kind: "day", n: 1 } :
      w === "weekly" ? { kind: "week", n: 1 } :
      (w === "biweekly" || w === "fortnightly") ? { kind: "week", n: 2 } :
      w === "monthly" ? { kind: "month", n: 1 } :
      w === "quarterly" ? { kind: "month", n: 3 } : { kind: "year", n: 1 };
    cutMatch(ctx, m);
    out.matched.push("repeats " + repeatLabel(out.repeat).toLowerCase());
  }
}

/* ---- date + time phrases ------------------------------------ */
function parseWhen(ctx, tz, now) {
  const w = { hasDate: false, hasTime: false, y: null, mo: null, d: null, h: 9, mi: 0, exactMs: null };
  const base = localParts(now, tz);
  const setDate = (y, mo, d) => { w.hasDate = true; w.y = y; w.mo = mo; w.d = d; };
  // `k` days from today, local. Anchored at noon so DST can't slide the date.
  const setOffsetDays = (k) => {
    const p = localParts(fromLocal(base.y, base.mo, base.d, 12, 0, tz) + k * 86400000, tz);
    setDate(p.y, p.mo, p.d);
  };
  let m;

  /* "in 20 minutes" / "in 3 days" */
  m = ctx.mask.match(/\bin\s+(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|month|months)\b/i);
  if (m) {
    const n = Number(m[1]), u = m[2].toLowerCase();
    cutMatch(ctx, m);
    if (/^(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.test(u)) {
      w.exactMs = now + n * unitMs(u);           // an exact moment — no calendar day needed
      return w;
    }
    if (/^(month|months)$/.test(u)) {
      const mo = base.mo + n, y = base.y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
      setDate(y, mm, Math.min(base.d, daysInMonth(y, mm)));
    } else {
      setOffsetDays(n * (/^(w|week|weeks)$/.test(u) ? 7 : 1));
    }
  }

  /* today / tomorrow / tonight */
  if (!w.hasDate) {
    m = ctx.mask.match(/\b(today|tonite|tonight|tomorrow|tommorow|tmrw|tmr|the day after tomorrow)\b/i);
    if (m) {
      const word = m[1].toLowerCase();
      if (word === "the day after tomorrow") setOffsetDays(2);
      else if (word.indexOf("tom") === 0 || word.indexOf("tm") === 0) setOffsetDays(1);
      else setOffsetDays(0);
      if (word === "tonight" || word === "tonite") { w.hasTime = true; w.h = DAYPARTS.tonight; w.mi = 0; }
      cutMatch(ctx, m);
    }
  }

  /* next week / next month / next year */
  if (!w.hasDate) {
    m = ctx.mask.match(/\bnext\s+(week|month|year)\b/i);
    if (m) {
      const u = m[1].toLowerCase();
      if (u === "week") setOffsetDays(7);
      else if (u === "month") {
        const mo = base.mo + 1, y = base.y + Math.floor(mo / 12), mm = mo % 12;
        setDate(y, mm, Math.min(base.d, daysInMonth(y, mm)));
      } else setDate(base.y + 1, base.mo, base.d);
      cutMatch(ctx, m);
    }
  }

  /* this/next <weekday>, or a bare weekday = the next one coming up */
  if (!w.hasDate) {
    m = ctx.mask.match(/\b(?:(this|next|coming)\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i);
    if (m) {
      const target = WEEKDAYS[m[2].toLowerCase()];
      let delta = (target - base.dow + 7) % 7;
      if (delta === 0) delta = 7;                                    // "monday" on a Monday = next Monday
      if ((m[1] || "").toLowerCase() === "next" && delta < 7) delta += 7;
      setOffsetDays(delta);
      cutMatch(ctx, m);
    }
  }

  /* "aug 15", "August 15th 2026" */
  const MON_ALT = "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december";
  if (!w.hasDate) {
    m = ctx.mask.match(new RegExp("\\b(" + MON_ALT + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b", "i"));
    if (m) {
      const mo = MONTHS[m[1].toLowerCase()], d = Number(m[2]);
      if (d >= 1 && d <= daysInMonth(m[3] ? Number(m[3]) : base.y, mo)) {
        setDate(m[3] ? Number(m[3]) : yearFor(base, mo, d), mo, d);
        cutMatch(ctx, m);
      }
    }
  }
  /* "15 August", "15th of Aug" */
  if (!w.hasDate) {
    m = ctx.mask.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(" + MON_ALT + ")\\.?(?:,?\\s*(\\d{4}))?\\b", "i"));
    if (m) {
      const mo = MONTHS[m[2].toLowerCase()], d = Number(m[1]);
      if (d >= 1 && d <= daysInMonth(m[3] ? Number(m[3]) : base.y, mo)) {
        setDate(m[3] ? Number(m[3]) : yearFor(base, mo, d), mo, d);
        cutMatch(ctx, m);
      }
    }
  }

  /* "8/15", "8/15/26" — US month/day. Skipped when it's really a fraction or a
   * reference rather than a deadline; see looksLikeDate(). */
  if (!w.hasDate) {
    const re = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
    let hit;
    while ((hit = re.exec(ctx.mask)) !== null) {
      const mo = Number(hit[1]) - 1, d = Number(hit[2]);
      if (!(mo >= 0 && mo <= 11 && d >= 1 && d <= 31)) continue;
      let y = hit[3] ? Number(hit[3]) : yearFor(base, mo, d);
      if (y < 100) y += 2000;
      if (d > daysInMonth(y, mo)) continue;
      if (!hit[3] && !looksLikeDate(ctx.mask, hit)) continue;
      setDate(y, mo, d);
      cutMatch(ctx, hit);
      break;
    }
  }

  /* "on the 5th" — this month, or next month if it's already gone */
  if (!w.hasDate) {
    m = ctx.mask.match(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/i);
    if (m) {
      const d = Number(m[1]);
      if (d >= 1 && d <= 31) {
        let y = base.y, mo = base.mo;
        if (d < base.d) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
        setDate(y, mo, Math.min(d, daysInMonth(y, mo)));
        cutMatch(ctx, m);
      }
    }
  }

  /* clock time: "3pm", "at 3:30 pm", "15:00", "noon" */
  if (!w.hasTime) {
    m = ctx.mask.match(/\b(?:at\s+|@)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (m) {
      const c = clock24(m[1], m[2], m[3]);
      if (c) { w.hasTime = true; w.h = c.h; w.mi = c.mi; cutMatch(ctx, m); }
    }
  }
  if (!w.hasTime) {
    m = ctx.mask.match(/\b(?:at\s+|@)(\d{1,2}):(\d{2})\b/);
    if (m) {
      const h = Number(m[1]), mi = Number(m[2]);
      if (h <= 23 && mi <= 59) { w.hasTime = true; w.h = h; w.mi = mi; cutMatch(ctx, m); }
    }
  }
  if (!w.hasTime) {
    m = ctx.mask.match(/\b(noon|midday|midnight|morning|afternoon|evening|tonight)\b/i);
    if (m) { w.hasTime = true; w.h = DAYPARTS[m[1].toLowerCase()]; w.mi = 0; cutMatch(ctx, m); }
  }

  return w;
}

// The weekdays a repeat is pinned to, or null if it repeats on any day.
function repeatDays(r) {
  if (!r) return null;
  if (r.kind === "weekday") return [1, 2, 3, 4, 5];
  if (r.kind === "week" && Array.isArray(r.days) && r.days.length) return r.days;
  return null;
}
// Move `ms` forward to the first day whose weekday is in `days` (today counts),
// keeping the local time of day intact across a DST change.
function snapToDays(ms, days, tz) {
  for (let k = 0; k <= 7; k++) {
    const p = localParts(ms + k * 86400000, tz);
    if (days.indexOf(p.dow) !== -1) {
      const t = localParts(ms, tz);
      return fromLocal(p.y, p.mo, p.d, t.h, t.mi, tz);
    }
  }
  return ms;
}

/**
 * Is this "5/8" a date, or a fraction someone typed?
 * ---------------------------------------------------------------------------
 * Without a year, "N/M" is ambiguous, and guessing wrong is expensive: it both
 * invents a deadline and deletes a word from a task someone may have typed on a
 * numeric keypad. Two giveaways that it isn't a date:
 *
 *   "order 5/8 inch bolts"      a unit of measure follows it -> a fraction
 *   "call sam re the 4/9 invoice"  "the" before, a noun after -> a reference
 *
 * Anything else keeps the benefit of the doubt, so "pay rent 9/1" still works.
 */
function looksLikeDate(text, hit) {
  const after = text.slice(hit.index + hit[0].length);
  const before = text.slice(0, hit.index);
  const UNITS = /^\s*(inch|inches|in|foot|feet|ft|yard|yd|mile|miles|lb|lbs|pound|pounds|oz|ounce|ounces|g|kg|gram|grams|cup|cups|tsp|tbsp|qt|quart|quarts|pt|pint|pints|gal|gallon|gallons|ml|l|liter|liters|litre|mm|cm|m|meter|meters|metre|hp|amp|amps|volt|volts|watt|watts|percent|%)\b/i;
  if (UNITS.test(after)) return false;
  if (/\bthe\s*$/i.test(before) && /^\s*\S/.test(after)) return false;
  return true;
}

// A month/day with no year: this year if it hasn't passed, otherwise next year.
function yearFor(base, mo, d) {
  if (mo > base.mo || (mo === base.mo && d >= base.d)) return base.y;
  return base.y + 1;
}
function clock24(hStr, miStr, ampm) {
  let h = Number(hStr);
  const mi = miStr ? Number(miStr) : 0;
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
  if (ampm) {
    const pm = /^p/i.test(String(ampm).replace(/\./g, ""));
    if (h > 12) return null;
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return { h: h, mi: mi };
}
function unitMs(u) {
  u = u.toLowerCase();
  if (/^(m|min|mins|minute|minutes)$/.test(u)) return 60000;
  if (/^(h|hr|hrs|hour|hours)$/.test(u)) return 3600000;
  if (/^(w|week|weeks)$/.test(u)) return 7 * 86400000;
  return 86400000;
}

// Remove the understood spans, then tidy the leftovers ("Call Bob on" -> "Call Bob").
function stripCuts(ctx) {
  const s = ctx.text;
  if (!ctx.cuts.length) return s.trim();
  const merged = ctx.cuts.slice().sort((a, b) => a[0] - b[0]);
  let out = "", at = 0;
  merged.forEach((c) => {
    if (c[0] < at) { at = Math.max(at, c[1]); return; }
    out += s.slice(at, c[0]) + " ";
    at = c[1];
  });
  out += s.slice(at);
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, "")
    .replace(/\s+\b(on|at|by|due|from|this|next|every|of|in|remind|remind me)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ============================================================
 * Recurrence — the next due date after `fromMs`
 * ============================================================ */
export function nextOccurrence(repeat, fromMs, tz) {
  if (!repeat || !repeat.kind) return null;
  const n = Math.max(1, Number(repeat.n) || 1);
  const p = localParts(fromMs, tz);

  if (repeat.kind === "day") return fromMs + n * 86400000;

  if (repeat.kind === "weekday") {
    let t = fromMs;
    do { t += 86400000; } while ([0, 6].indexOf(localParts(t, tz).dow) !== -1);
    return t;
  }

  if (repeat.kind === "week") {
    const days = Array.isArray(repeat.days) && repeat.days.length ? repeat.days.slice().sort() : [p.dow];
    // The next listed weekday; if that lands a full week out, honour "every n weeks".
    for (let k = 1; k <= 7; k++) {
      const t = fromMs + k * 86400000;
      if (days.indexOf(localParts(t, tz).dow) !== -1) {
        return (k === 7 && n > 1) ? fromMs + n * 7 * 86400000 : t;
      }
    }
    return fromMs + n * 7 * 86400000;
  }

  if (repeat.kind === "month") {
    const mo = p.mo + n, y = p.y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
    return fromLocal(y, mm, Math.min(p.d, daysInMonth(y, mm)), p.h, p.mi, tz);
  }

  if (repeat.kind === "year") {
    const y = p.y + n;
    return fromLocal(y, p.mo, Math.min(p.d, daysInMonth(y, p.mo)), p.h, p.mi, tz);
  }
  return null;
}

/* ============================================================
 * Labels — used by the app, the SMS reply and the email receipt
 * ============================================================ */
export function priorityLabel(p) {
  return ["None", "Low", "Medium", "High", "Urgent"][Number(p) || 0] || "None";
}

export function repeatLabel(r) {
  if (!r || !r.kind) return "";
  const n = Math.max(1, Number(r.n) || 1);
  if (r.kind === "weekday") return "Every weekday";
  if (r.kind === "week" && Array.isArray(r.days) && r.days.length) {
    return "Every " + r.days.map((d) => WEEKDAY_NAMES[d]).join(", ");
  }
  const unit = { day: "day", week: "week", month: "month", year: "year" }[r.kind] || r.kind;
  return n === 1 ? "Every " + unit : "Every " + n + " " + unit + "s";
}

// "Tomorrow 3:00 PM", "Fri, Aug 15", "Today" — short and human.
export function describeDue(dueAt, allDay, tz, nowMs) {
  if (dueAt == null) return "";
  const now = nowMs || Date.now();
  const p = localParts(dueAt, tz), t = localParts(now, tz);
  const dayDiff = Math.round(
    (fromLocal(p.y, p.mo, p.d, 12, 0, tz) - fromLocal(t.y, t.mo, t.d, 12, 0, tz)) / 86400000
  );
  let day;
  if (dayDiff === 0) day = "Today";
  else if (dayDiff === 1) day = "Tomorrow";
  else if (dayDiff === -1) day = "Yesterday";
  else if (dayDiff > 1 && dayDiff < 7) day = WEEKDAY_NAMES[p.dow];
  else {
    day = WEEKDAY_NAMES[p.dow].slice(0, 3) + ", " + MONTH_NAMES[p.mo].slice(0, 3) + " " + p.d;
    if (p.y !== t.y) day += ", " + p.y;
  }
  return allDay ? day : day + " " + fmtClockLabel(p.h, p.mi);
}

export function fmtClockLabel(h, mi) {
  const ampm = h >= 12 ? "PM" : "AM";
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return hh + ":" + String(mi).padStart(2, "0") + " " + ampm;
}
