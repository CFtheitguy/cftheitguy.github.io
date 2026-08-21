/* GuardLock — toolbar popup. */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;

  const $ = (id) => document.getElementById(id);
  let pad = null;

  const send = globalThis.GL.sendMessage;

  async function render() {
    const s = await send({ type: 'getState' });
    if (!s.ok) {
      $('sub').textContent = s.error || 'Unavailable';
      return;
    }
    const { settings, hasPin, unlocked, privateAllowed, blockedCount, stats } = s;

    const pill = $('statePill');
    if (!settings.enabled) { pill.textContent = 'Off'; pill.className = 'pill off'; }
    else { pill.textContent = 'Protecting'; pill.className = 'pill on'; }

    const on = Object.entries(settings.categories).filter(([, v]) => v).length;
    $('sub').textContent = `${on} categor${on === 1 ? 'y' : 'ies'} filtered`;
    $('domCount').textContent = blockedCount.toLocaleString();
    $('hitCount').textContent = (stats.blocked || 0).toLocaleString();
    $('lockState').textContent = !hasPin ? 'No PIN set' : unlocked ? 'Unlocked' : 'Locked';

    $('privWarn').hidden = !!privateAllowed;
    $('lockBtn').hidden = !unlocked;

    if (!hasPin) {
      $('lockTitle').textContent = 'Set a PIN to protect these settings';
      $('lockCard').querySelector('#keypadWrap').innerHTML =
        '<button class="primary" id="goSetup" style="width:100%">Choose a PIN</button>';
      $('goSetup').addEventListener('click', openOptions);
    } else if (unlocked) {
      $('lockCard').hidden = true;
    } else {
      $('lockCard').hidden = false;
      if (!pad) {
        pad = GLKeypad.mount($('keypadWrap'), {
          submitLabel: 'Unlock',
          onSubmit: async (pin) => {
            const res = await send({ type: 'unlock', pin });
            if (res.ok) { pad.destroy(); pad = null; location.reload(); return { ok: true, message: 'Unlocked' }; }
            return { ok: false, message: res.error || 'Wrong PIN.' };
          }
        });
      }
    }
  }

  function openOptions() {
    api.runtime.openOptionsPage ? api.runtime.openOptionsPage()
      : api.tabs.create({ url: api.runtime.getURL('src/ui/options.html') });
    window.close();
  }

  $('openOptions').addEventListener('click', openOptions);
  $('lockBtn').addEventListener('click', async () => { await send({ type: 'lock' }); location.reload(); });
  $('fixPriv').addEventListener('click', () => {
    api.tabs.create({ url: api.runtime.getURL('src/ui/options.html#private') });
    window.close();
  });

  render();
})();
