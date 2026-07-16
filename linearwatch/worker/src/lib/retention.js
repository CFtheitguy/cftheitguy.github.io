// Retention sweep — deletes screenshots (R2 bytes + D1 rows) older than each
// org's retention_days, and purges expired sessions. Driven by the scheduled
// (cron) handler; also callable on demand via POST /v1/admin/run-retention.

export async function runRetention(env) {
  const orgs = await env.DB.prepare("SELECT id, retention_days FROM organizations").all();
  let deletedShots = 0;

  for (const org of orgs.results || []) {
    const days = org.retention_days || 30;
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

    // Page through the overflow so we never build an unbounded statement/list.
    for (;;) {
      const rows = await env.DB.prepare(
        "SELECT id, r2_key, thumb_r2_key FROM screenshots WHERE org_id = ? AND captured_at < ? LIMIT 200",
      )
        .bind(org.id, cutoff)
        .all();
      const list = rows.results || [];
      if (!list.length) break;

      const keys = new Set();
      for (const s of list) {
        keys.add(s.r2_key);
        if (s.thumb_r2_key && s.thumb_r2_key !== s.r2_key) keys.add(s.thumb_r2_key);
      }
      try {
        await env.SHOTS.delete([...keys]); // R2 accepts an array of keys
      } catch (e) {
        console.error("R2 delete failed during retention:", e && e.message);
      }
      const ph = list.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM screenshots WHERE id IN (${ph})`).bind(...list.map((s) => s.id)).run();
      deletedShots += list.length;
      if (list.length < 200) break;
    }
  }

  const sess = await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  const summary = { deleted_screenshots: deletedShots, purged_sessions: sess.meta?.changes ?? 0, ran_at: new Date().toISOString() };
  console.log("retention sweep:", JSON.stringify(summary));
  return summary;
}
