/* GuardLock — the page shown in place of a blocked site. */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const { hostOf } = globalThis.GL;
  const $ = (id) => document.getElementById(id);

  const send = globalThis.GL.sendMessage;

  const REASONS = {
    domain:   (c) => `This site is on the ${c || 'blocked'} list.`,
    keyword:  (c, m) => `The ${c === 'page text' ? 'page text' : 'web address'} matched blocked wording${m ? ` (${m})` : ''}.`,
    settings: () => 'The browser\'s extensions page is sealed while GuardLock is locked. Unlock GuardLock first.'
  };

  let target = null;

  async function load() {
    const p = new URLSearchParams(location.search);
    let url = p.get('u') || '';
    let reason = p.get('r') || '';
    let category = p.get('c') || '';
    let matched = p.get('m') || '';

    if (!url) {
      // Arrived via the network-level rule, which cannot carry the address.
      const res = await send({ type: 'getAttempt' });
      if (res.ok && res.attempt) {
        url = res.attempt.url || '';
        reason = res.attempt.reason || reason;
        category = res.attempt.category || category;
        matched = res.attempt.matched || matched;
      }
    }

    target = url;
    if (url) {
      $('site').hidden = false;
      $('site').textContent = url.length > 300 ? url.slice(0, 300) + '…' : url;
    }
    const fn = REASONS[reason] || REASONS.domain;
    $('reason').textContent = fn(category, matched);

    if (reason === 'settings') $('allowBtn').textContent = 'Unlock GuardLock';
    if (!url && reason !== 'settings') $('allowBtn').hidden = true;
  }

  $('back').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.href = 'about:blank';
  });

  $('allowBtn').addEventListener('click', () => {
    $('allowCard').hidden = false;
    $('allowBtn').disabled = true;
    GLKeypad.mount($('allowPad'), {
      submitLabel: 'Unlock',
      onSubmit: async (pin) => {
        const unlocked = await send({ type: 'unlock', pin });
        if (!unlocked.ok) return { ok: false, message: unlocked.error || 'Wrong PIN.' };

        const host = hostOf(target);
        if (host) {
          const added = await send({ type: 'addAllow', domain: host });
          if (!added.ok) return { ok: false, message: added.error };
          setTimeout(() => { location.href = target; }, 400);
          return { ok: true, message: `${host} allowed. Opening…` };
        }
        setTimeout(() => history.back(), 400);
        return { ok: true, message: 'Unlocked.' };
      }
    });
  });

  load();
})();
