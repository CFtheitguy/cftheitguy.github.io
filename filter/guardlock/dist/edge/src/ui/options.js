/* GuardLock — settings page. */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const { CATEGORIES } = globalThis.GL;
  const $ = (id) => document.getElementById(id);

  let state = null;
  let unlockPad = null;
  let setupPad = null;
  let pendingPin = null;

  const send = globalThis.GL.sendMessage;

  const isFirefox = navigator.userAgent.includes('Firefox');

  /* ------------------------------------------------------------- rendering */

  function renderCategories(settings) {
    const box = $('cats');
    box.innerHTML = '';
    for (const cat of CATEGORIES) {
      const id = 'cat-' + cat.id;
      const label = document.createElement('label');
      label.className = 'check';
      label.innerHTML =
        `<input type="checkbox" id="${id}" ${settings.categories[cat.id] ? 'checked' : ''}>` +
        `<span><span class="t">${cat.label}</span></span>`;
      box.appendChild(label);
      label.querySelector('input').addEventListener('change', async (e) => {
        const res = await send({ type: 'setSettings', patch: { categories: { [cat.id]: e.target.checked } } });
        if (!res.ok) { e.target.checked = !e.target.checked; alert(res.error); }
        else refresh();
      });
    }
  }

  function renderTags(containerId, values, removeType) {
    const box = $(containerId);
    box.innerHTML = '';
    if (!values.length) {
      box.innerHTML = '<span class="muted">Nothing added yet.</span>';
      return;
    }
    for (const v of values) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.innerHTML = `<span></span><button title="Remove" aria-label="Remove ${v}">✕</button>`;
      tag.firstChild.textContent = v;
      tag.querySelector('button').addEventListener('click', async () => {
        const res = await send({ type: removeType, domain: v });
        if (!res.ok) alert(res.error); else refresh();
      });
      box.appendChild(tag);
    }
  }

  function renderLists(settings) {
    const box = $('lists');
    box.innerHTML = '';
    if (!(settings.remoteLists || []).length) {
      box.innerHTML = '<span class="muted">No subscriptions. The built-in lists are still active.</span>';
      return;
    }
    for (const l of settings.remoteLists) {
      const row = document.createElement('div');
      row.className = 'listrow';
      const info = l.error
        ? `<span style="color:var(--bad)">${l.error}</span>`
        : `${(l.count || 0).toLocaleString()} domains · updated ${l.updated ? new Date(l.updated).toLocaleString() : 'never'}`;
      row.innerHTML = `<div class="grow"><div class="u"></div><div class="muted">${info}</div></div>
                       <button class="danger">Remove</button>`;
      row.querySelector('.u').textContent = l.url;
      row.querySelector('button').addEventListener('click', async () => {
        const res = await send({ type: 'removeRemoteList', url: l.url });
        if (!res.ok) alert(res.error); else refresh();
      });
      box.appendChild(row);
    }
  }

  function renderPrivate(privateAllowed) {
    const status = $('privStatus');
    if (privateAllowed) {
      status.innerHTML = '<div class="notice good"><b>Active in private windows.</b> Nothing else to do here.</div>';
      $('privSteps').innerHTML = '';
      return;
    }
    status.innerHTML = '<div class="notice bad"><b>Not active in private windows.</b> ' +
      'Browsers keep extensions out of private windows until you allow it by hand — ' +
      'this one switch is the difference between a filter and a filter with an open back door.</div>';

    $('privSteps').innerHTML = isFirefox
      ? `<ol class="steps">
           <li>Open <b>about:addons</b> and pick <b>Extensions</b>.</li>
           <li>Click <b>GuardLock</b>, then the <b>Details</b> tab.</li>
           <li>Set <b>Run in Private Windows</b> to <b>Allow</b>.</li>
           <li>Come back to this page and reload it.</li>
         </ol>
         <p class="muted">Turn off "Block the browser's extensions page while locked" first, or unlock, or
            about:addons will bounce you back here.</p>`
      : `<ol class="steps">
           <li>Open <b>edge://extensions</b> (Chrome: chrome://extensions).</li>
           <li>Click <b>Details</b> under GuardLock.</li>
           <li>Turn on <b>Allow in InPrivate</b> (Chrome: "Allow in Incognito").</li>
           <li>Come back to this page and reload it.</li>
         </ol>
         <p class="muted">Stricter option: leave InPrivate switched off entirely with the policy in the
            <code>enterprise</code> folder, and this stops being a concern.</p>`;
  }

  function applyState() {
    const { settings, hasPin, unlocked, privateAllowed } = state;

    const pill = $('statePill');
    if (!settings.enabled) { pill.textContent = 'Off'; pill.className = 'pill off'; }
    else if (!privateAllowed) { pill.textContent = 'Private windows open'; pill.className = 'pill warn'; }
    else { pill.textContent = 'Protecting'; pill.className = 'pill on'; }

    $('setup').hidden = hasPin;
    $('unlockCard').hidden = !hasPin || unlocked;
    $('main').hidden = !hasPin;
    $('main').classList.toggle('locked-veil', !unlocked);

    renderPrivate(privateAllowed);
    if (!hasPin) {
      mountSetupPad();
      return;
    }
    if (!unlocked) mountUnlockPad();

    $('enabled').checked = settings.enabled;
    $('safeSearch').checked = settings.safeSearch;
    $('keywordsEnabled').checked = settings.keywordsEnabled;
    $('urlKeywordsEnabled').checked = settings.urlKeywordsEnabled;
    $('guardSettingsPage').checked = settings.guardSettingsPage !== false;
    $('keywordThreshold').value = settings.keywordThreshold;
    $('unlockMinutes').value = settings.unlockMinutes;

    renderCategories(settings);
    renderTags('allowTags', settings.allowlist || [], 'removeAllow');
    renderTags('blockTags', settings.blocklist || [], 'removeBlock');
    renderLists(settings);
  }

  async function refresh() {
    state = await send({ type: 'getState' });
    if (!state.ok) {
      document.body.innerHTML = '<p style="padding:40px;text-align:center">GuardLock is not responding. Reload the extension.</p>';
      return;
    }
    applyState();
  }

  /* ---------------------------------------------------------------- keypads */

  function mountUnlockPad() {
    if (unlockPad) return;
    unlockPad = GLKeypad.mount($('unlockPad'), {
      submitLabel: 'Unlock',
      onSubmit: async (pin) => {
        const res = await send({ type: 'unlock', pin });
        if (res.ok) {
          unlockPad.destroy(); unlockPad = null;
          $('unlockPad').innerHTML = '';
          await refresh();
          return { ok: true, message: 'Unlocked' };
        }
        return { ok: false, message: res.error || 'Wrong PIN.' };
      }
    });
  }

  function mountSetupPad() {
    if (setupPad) return;
    setupPad = GLKeypad.mount($('setupPad'), {
      submitLabel: pendingPin ? 'Confirm' : 'Next',
      onSubmit: async (pin) => {
        if (!pendingPin) {
          pendingPin = pin;
          setupPad.destroy(); setupPad = null;
          $('setupPad').innerHTML = '';
          mountSetupPad();
          $('setup').querySelector('h2').textContent = 'Step 2 — type the same PIN again';
          return { ok: true, message: 'Now confirm it.' };
        }
        if (pin !== pendingPin) {
          pendingPin = null;
          $('setup').querySelector('h2').textContent = 'Step 1 — choose your PIN';
          return { ok: false, message: 'Those did not match. Start again.' };
        }
        const res = await send({ type: 'setPin', newPin: pin });
        if (!res.ok) { pendingPin = null; return { ok: false, message: res.error }; }
        $('recoveryCode').textContent = res.recovery;
        $('recoveryBox').hidden = false;
        $('setupPad').hidden = true;
        $('setup').querySelector('h2').textContent = 'Step 3 — save your recovery code';
        return { ok: true, message: '' };
      }
    });
  }

  /* ----------------------------------------------------------------- wiring */

  function bindToggle(id, key) {
    $(id).addEventListener('change', async (e) => {
      const res = await send({ type: 'setSettings', patch: { [key]: e.target.checked } });
      if (!res.ok) { e.target.checked = !e.target.checked; alert(res.error); }
      else refresh();
    });
  }
  bindToggle('enabled', 'enabled');
  bindToggle('safeSearch', 'safeSearch');
  bindToggle('keywordsEnabled', 'keywordsEnabled');
  bindToggle('urlKeywordsEnabled', 'urlKeywordsEnabled');
  bindToggle('guardSettingsPage', 'guardSettingsPage');

  function bindNumber(id, key, min, max) {
    $(id).addEventListener('change', async (e) => {
      const v = Math.min(max, Math.max(min, Number(e.target.value) || min));
      e.target.value = v;
      const res = await send({ type: 'setSettings', patch: { [key]: v } });
      if (!res.ok) alert(res.error);
    });
  }
  bindNumber('keywordThreshold', 'keywordThreshold', 4, 60);
  bindNumber('unlockMinutes', 'unlockMinutes', 1, 120);

  async function addDomain(inputId, type) {
    const input = $(inputId);
    const res = await send({ type, domain: input.value });
    if (!res.ok) return alert(res.error);
    input.value = '';
    refresh();
  }
  $('allowAdd').addEventListener('click', () => addDomain('allowInput', 'addAllow'));
  $('blockAdd').addEventListener('click', () => addDomain('blockInput', 'addBlock'));
  $('allowInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain('allowInput', 'addAllow'); });
  $('blockInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain('blockInput', 'addBlock'); });

  async function addList(url) {
    $('refreshMsg').textContent = 'Downloading…';
    const res = await send({ type: 'addRemoteList', url });
    $('refreshMsg').textContent = '';
    if (!res.ok) return alert(res.error);
    $('listInput').value = '';
    refresh();
  }
  $('listAdd').addEventListener('click', () => addList($('listInput').value));
  document.querySelectorAll('[data-suggest]').forEach((b) => {
    b.addEventListener('click', () => addList(b.dataset.suggest));
  });
  $('refreshLists').addEventListener('click', async () => {
    $('refreshMsg').textContent = 'Refreshing…';
    const res = await send({ type: 'refreshLists' });
    $('refreshMsg').textContent = res.ok ? `Updated ${res.updated || 0} list(s).` : res.error;
    refresh();
  });

  $('savedRecovery').addEventListener('change', (e) => { $('finishSetup').disabled = !e.target.checked; });
  $('finishSetup').addEventListener('click', () => { location.href = location.pathname; });

  $('forgot').addEventListener('click', () => {
    $('recoverBox').hidden = !$('recoverBox').hidden;
  });
  $('doRecover').addEventListener('click', async () => {
    const res = await send({
      type: 'useRecovery',
      code: $('recoverCode').value,
      newPin: $('recoverPin').value
    });
    $('recoverMsg').textContent = res.ok ? 'PIN reset. Save the new recovery code below.' : res.error;
    if (res.ok) {
      $('recoverCode').value = '';
      $('recoverPin').value = '';
      await refresh();
      $('newRecovery').hidden = false;
      $('newRecovery').textContent = res.recovery;
      $('newRecovery').scrollIntoView({ behavior: 'smooth' });
    }
  });

  $('changePin').addEventListener('click', async () => {
    const res = await send({ type: 'setPin', newPin: $('newPin').value });
    $('changeMsg').textContent = res.ok ? 'PIN changed. Save the new recovery code.' : res.error;
    if (res.ok) {
      $('newPin').value = '';
      $('newRecovery').hidden = false;
      $('newRecovery').textContent = res.recovery;
    }
  });

  if (location.hash === '#private') {
    setTimeout(() => $('privateCard').scrollIntoView({ behavior: 'smooth' }), 250);
  }

  refresh();
})();
