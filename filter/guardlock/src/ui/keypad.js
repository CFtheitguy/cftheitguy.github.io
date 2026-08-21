/* GuardLock — reusable numeric keypad.
 * GLKeypad.mount(container, {length, onSubmit, submitLabel}) */
(function () {
  'use strict';

  function mount(container, opts) {
    const min = opts.min || 4;
    const max = opts.max || 12;
    let value = '';

    container.classList.add('keypad');
    container.innerHTML = `
      <div class="pin-dots" role="status" aria-live="polite" aria-label="PIN entry"></div>
      <div class="keys">
        ${[1,2,3,4,5,6,7,8,9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('')}
        <button type="button" class="wide" data-k="del">Delete</button>
        <button type="button" data-k="0">0</button>
        <button type="button" class="wide primary" data-k="go">${opts.submitLabel || 'Enter'}</button>
      </div>
      <div class="pin-msg" role="alert"></div>`;

    const dots = container.querySelector('.pin-dots');
    const msg = container.querySelector('.pin-msg');

    function paint() {
      dots.innerHTML = '';
      const shown = Math.max(value.length, min);
      for (let i = 0; i < shown; i++) {
        const d = document.createElement('i');
        if (i < value.length) d.className = 'filled';
        dots.appendChild(d);
      }
    }

    function say(text, ok) {
      msg.textContent = text || '';
      msg.className = 'pin-msg' + (ok ? ' ok' : '');
      if (text && !ok) {
        container.classList.remove('shake');
        void container.offsetWidth;
        container.classList.add('shake');
      }
    }

    async function submit() {
      if (value.length < min) return say(`Enter at least ${min} digits.`);
      const entered = value;
      value = '';
      paint();
      const result = await opts.onSubmit(entered);
      if (result && result.message) say(result.message, result.ok);
      else say('');
    }

    function press(k) {
      if (k === 'del') value = value.slice(0, -1);
      else if (k === 'go') return submit();
      else if (value.length < max) value += k;
      say('');
      paint();
    }

    container.querySelector('.keys').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (b) press(b.dataset.k);
    });

    // Physical keyboard, so the popup is usable without a mouse.
    function onKey(e) {
      if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('del'); e.preventDefault(); }
      else if (e.key === 'Enter') { press('go'); e.preventDefault(); }
    }
    document.addEventListener('keydown', onKey);

    paint();
    return {
      say,
      reset() { value = ''; paint(); say(''); },
      destroy() { document.removeEventListener('keydown', onKey); }
    };
  }

  globalThis.GLKeypad = { mount };
})();
