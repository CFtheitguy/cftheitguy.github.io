// Evict Point – "Start Your Eviction" multi-step form.
// Requests are posted to Formspree, which emails them to the address set on the
// Formspree form. While SUBMIT_URL is empty (or if Formspree can't be reached)
// the visitor's email app opens instead, addressed to SUBMIT_EMAIL.
var SUBMIT_URL = 'https://formspree.io/f/myekwnze';
var SUBMIT_EMAIL = 'devoriy@evictpoint.com';
// File uploads need a paid Formspree plan (enabled). If set to false, document names are
// listed in the email and the visitor is asked to email the files.
var SEND_FILES = true;
var DRAFT_KEY = 'evictpoint-draft';

(function () {
  var form = document.getElementById('ev');
  var steps = [].slice.call(form.querySelectorAll('.step'));
  var stepper = document.getElementById('stepper');
  var back = document.getElementById('back'), next = document.getElementById('next');
  var cur = 0, maxReached = 0, files = { lease: [], ledger: [], notices: [], other: [] };
  var LABELS = { lease: 'Lease / Rental Agreement', ledger: 'Rent Ledger', notices: 'Notices', other: 'Other Documents' };

  // ---- stepper ----
  steps.forEach(function (s, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<b>' + (i + 1) + '</b><span>' + s.dataset.title + '</span>';
    b.onclick = function () { if (i <= maxReached) go(i); };
    stepper.appendChild(b);
  });

  function go(i) {
    cur = i; maxReached = Math.max(maxReached, i);
    steps.forEach(function (s, j) { s.classList.toggle('hide', j !== i); });
    [].forEach.call(stepper.children, function (b, j) {
      b.className = j === i ? 'cur' : (j <= maxReached ? 'done' : '');
      b.querySelector('b').textContent = j < i || (j <= maxReached && j !== i) ? '✓' : j + 1;
    });
    back.style.visibility = i === 0 ? 'hidden' : 'visible';
    next.innerHTML = i === steps.length - 1 ? 'Submit Eviction Request &rarr;' : 'Continue &rarr;';
    if (i === steps.length - 1) buildReview();
    window.scrollTo({ top: document.querySelector('.flow').offsetTop - 90, behavior: 'smooth' });
  }

  // ---- validation ----
  function visible(el) { return !el.closest('.hide'); }
  function validate(step) {
    var ok = true, first = null;
    step.querySelectorAll('input,select,textarea').forEach(function (el) {
      if (!visible(el) || el.type === 'file' || el.type === 'radio' || el.type === 'checkbox') return;
      var v = el.value.trim(), bad = false;
      if (el.required && !v) bad = true;
      else if (v && el.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) bad = true;
      else if (v && el.type === 'tel' && v.replace(/\D/g, '').length < 10) bad = true;
      else if (v && el.pattern && !new RegExp('^' + el.pattern + '$').test(v)) bad = true;
      el.classList.toggle('invalid', bad);
      var msg = el.parentNode.querySelector('.errmsg');
      if (msg) msg.textContent = !v ? 'This field is required.' : 'Please enter a valid value.';
      if (bad) { ok = false; first = first || el; }
    });
    if (first) first.focus();
    return ok;
  }
  form.addEventListener('input', function (e) { e.target.classList.remove('invalid'); saveDraft(); });
  form.addEventListener('change', saveDraft);

  // ---- reason toggle (nonpayment fields required only when shown) ----
  function syncReason() {
    var r = form.querySelector('[name=e_reason]:checked').value;
    form.querySelectorAll('.sect[data-for]').forEach(function (s) {
      var show = s.dataset.for === r;
      s.classList.toggle('hide', !show);
    });
  }
  form.querySelectorAll('[name=e_reason]').forEach(function (r) { r.addEventListener('change', syncReason); });

  // ---- tenants (one card per tenant, name only) ----
  var tenantBox = document.getElementById('tenants');
  function renumber() {
    [].forEach.call(tenantBox.children, function (d, i) { d.querySelector('h3').textContent = 'Tenant ' + (i + 1); });
  }
  function addTenant(name) {
    var d = document.createElement('div');
    d.className = 'tcard';
    d.innerHTML = '<div class="hd"><h3></h3><button type="button" class="trash" title="Remove tenant" aria-label="Remove tenant"><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg></button></div>' +
      '<label>Tenant Name</label><input type="text" name="tenant_name" placeholder="Enter tenant name">';
    d.querySelector('input').value = name || '';
    d.querySelector('.trash').onclick = function () {
      if (tenantBox.children.length > 1) d.remove(); else d.querySelector('input').value = '';
      renumber(); saveDraft();
    };
    tenantBox.appendChild(d);
    renumber();
    return d;
  }
  document.getElementById('addTenant').onclick = function () { addTenant().querySelector('input').focus(); };

  // ---- uploads ----
  var MAX = 10 * 1024 * 1024;
  function renderFiles(key) {
    var ul = form.querySelector('[data-list=' + key + ']');
    ul.innerHTML = '';
    files[key].forEach(function (f, i) {
      var li = document.createElement('li');
      li.innerHTML = '<span><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg><b></b></span><button type="button" title="Remove">&times;</button>';
      li.querySelector('b').textContent = f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)';
      li.lastChild.onclick = function () { files[key].splice(i, 1); renderFiles(key); };
      ul.appendChild(li);
    });
  }
  function addFiles(key, list) {
    [].forEach.call(list, function (f) {
      if (!/\.(pdf|jpe?g|png)$/i.test(f.name)) return alert(f.name + ': only PDF, JPG or PNG files are allowed.');
      if (f.size > MAX) return alert(f.name + ' is larger than 10 MB.');
      files[key].push(f);
    });
    renderFiles(key);
  }
  form.querySelectorAll('.drop').forEach(function (d) {
    var key = d.dataset.key, input = d.querySelector('input');
    input.addEventListener('change', function () { addFiles(key, input.files); input.value = ''; });
    d.addEventListener('dragover', function (e) { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', function () { d.classList.remove('over'); });
    d.addEventListener('drop', function (e) { e.preventDefault(); d.classList.remove('over'); addFiles(key, e.dataTransfer.files); });
  });

  // ---- review ----
  function val(n) { var el = form.querySelector('[name=' + n + ']'); return el ? el.value.trim() : ''; }
  function money(n) { var v = val(n); return v ? '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 }) : ''; }
  function date(n) { var v = val(n); return v ? new Date(v + 'T00:00').toLocaleDateString('en-US') : ''; }
  function tenantNames(all) {
    var names = [].map.call(tenantBox.querySelectorAll('[name=tenant_name]'), function (el) { return el.value.trim(); });
    return all ? names : names.filter(Boolean);
  }
  function joined(parts, sep) { return parts.filter(Boolean).join(sep || ', '); }
  function sections() {
    var reason = form.querySelector('[name=e_reason]:checked').value;
    var ev = [['Reason', reason]];
    if (reason === 'Nonpayment of Rent') ev.push(['Monthly Rent', money('e_rent')], ['Amount Owed', money('e_owed')], ['Rent Became Due', date('e_due')], ['Last Paid', date('e_lastpaid')], ['Last Payment', money('e_lastamt')]);
    if (reason.indexOf('Holdover') === 0) ev.push(['Written Lease', val('h_lease')], ['Lease End / Termination', date('h_end')], ['Notice Served', val('h_notice')], ['Tenancy Length', val('h_length')]);
    ev.push(['What Happened', val('e_details')]);
    var ten = tenantNames().map(function (n, i) { return ['Tenant ' + (i + 1), n]; });
    var docs = Object.keys(files).map(function (k) { return [LABELS[k], files[k].map(function (f) { return f.name; }).join(', ') || 'None']; });
    return [
      ['Property Information', 0, [['Address', [val('p_street'), val('p_unit')].filter(Boolean).join(', ')], ['City / State / ZIP', (val('p_city') || val('p_zip')) ? joined([val('p_city'), joined([val('p_state'), val('p_zip')], ' ')]) : ''], ['County', val('p_county')], ['Property Type', val('p_type')]]],
      ['Landlord Information', 1, [['Name', val('l_name')], ['Company', val('l_company')], ['Phone', val('l_phone')], ['Email', val('l_email')], ['Mailing Address', (val('l_street') || val('l_city') || val('l_zip')) ? joined([val('l_street'), val('l_city'), joined([val('l_state'), val('l_zip')], ' ')]) : '']]],
      ['Tenant Information', 2, ten],
      ['Eviction Information', 3, ev],
      ['Documents', 4, docs]
    ];
  }
  function buildReview() {
    var box = document.getElementById('review');
    box.innerHTML = '';
    sections().forEach(function (s) {
      var div = document.createElement('div');
      div.className = 'rev';
      div.innerHTML = '<div class="rh"><span></span><button type="button" class="link"><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg> Edit</button></div><dl></dl>';
      div.querySelector('span').textContent = s[0];
      div.querySelector('.link').onclick = function () { go(s[1]); };
      var dl = div.querySelector('dl');
      s[2].forEach(function (r) {
        if (!r[1]) return;
        var dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = r[0]; dd.textContent = r[1];
        dl.appendChild(dt); dl.appendChild(dd);
      });
      box.appendChild(div);
    });
  }

  // ---- draft persistence (files can't be saved) ----
  function saveDraft() {
    try {
      var d = {};
      form.querySelectorAll('input[name],select[name],textarea[name]').forEach(function (el) {
        if (el.name === 'tenant_name' || el.name === '_gotcha' || el.type === 'file' || el.type === 'checkbox') return;
        if (el.type === 'radio') { if (el.checked) d[el.name] = el.value; } else d[el.name] = el.value;
      });
      d._tenants = tenantNames(true);
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) {}
  }
  function loadDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d) return;
      Object.keys(d).forEach(function (k) {
        if (k === '_tenants') return;
        if (k === 'e_reason' && String(d[k]).indexOf('Holdover') === 0) d[k] = 'Holdover';
        form.querySelectorAll('[name=' + k + ']').forEach(function (el) {
          if (el.type === 'radio') el.checked = el.value === d[k]; else el.value = d[k];
        });
      });
      // older drafts kept the first tenant in t_name and extra tenants as objects
      var names = (d.t_name ? [d.t_name] : []).concat((d._tenants || []).map(function (t) { return typeof t === 'string' ? t : (t && t.name) || ''; }));
      names.forEach(function (n) { addTenant(n); });
    } catch (e) {}
  }

  // ---- submit ----
  function plainText(ref) {
    var out = 'EVICTION REQUEST ' + ref + '\n\n';
    sections().forEach(function (s) {
      out += '== ' + s[0] + ' ==\n';
      s[2].forEach(function (r) { if (r[1]) out += r[0] + ': ' + r[1] + '\n'; });
      out += '\n';
    });
    return out;
  }
  function mailtoUrl(ref) {
    return 'mailto:' + SUBMIT_EMAIL + '?subject=' + encodeURIComponent('Eviction Request ' + ref + (val('p_street') ? ' - ' + val('p_street') : '')) +
      '&body=' + encodeURIComponent(plainText(ref));
  }
  function hasFiles() { return Object.keys(files).some(function (k) { return files[k].length; }); }
  // Formspree emails each field as "label: value", so send readable labels.
  function payload(ref) {
    var fd = new FormData();
    fd.append('_subject', 'New eviction request ' + ref + (val('p_street') ? ' – ' + val('p_street') : ''));
    if (val('l_email')) fd.append('email', val('l_email'));   // Formspree uses this as Reply-To
    fd.append('Reference', ref);
    sections().forEach(function (s) {
      if (s[0] === 'Documents') return;
      s[2].forEach(function (r) { if (r[1]) fd.append(s[0].replace(' Information', '') + ' – ' + r[0], r[1]); });
    });
    Object.keys(files).forEach(function (k) {
      if (!files[k].length) return;
      if (SEND_FILES) files[k].forEach(function (f) { fd.append(LABELS[k], f, f.name); });
      else fd.append('Documents – ' + LABELS[k], files[k].map(function (f) { return f.name; }).join(', ') + ' (not attached)');
    });
    fd.append('_gotcha', form.querySelector('[name=_gotcha]').value);   // spam trap
    return fd;
  }
  function finish(ref, viaMail) {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    form.classList.add('hide'); stepper.classList.add('hide');
    document.getElementById('doneName').textContent = val('l_name') ? ', ' + val('l_name') : '';
    document.getElementById('doneRef').textContent = ref;
    if (viaMail) {
      document.getElementById('doneMail').classList.remove('hide');
      document.getElementById('mailAgain').onclick = function (e) { e.preventDefault(); location.href = mailtoUrl(ref); };
    } else if (hasFiles() && !SEND_FILES) {
      var docs = document.getElementById('doneDocs');
      docs.querySelector('a').href = 'mailto:' + SUBMIT_EMAIL + '?subject=' + encodeURIComponent('Documents for eviction request ' + ref);
      docs.querySelector('a').textContent = SUBMIT_EMAIL;
      docs.classList.remove('hide');
    }
    document.getElementById('done').classList.remove('hide');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function submit() {
    var ref = 'EP-' + Date.now().toString(36).toUpperCase().slice(-6);
    if (!SUBMIT_URL) { location.href = mailtoUrl(ref); return finish(ref, true); }
    next.disabled = true; next.textContent = 'Submitting…';
    fetch(SUBMIT_URL, { method: 'POST', body: payload(ref), headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      finish(ref, false);
    }).catch(function () {
      alert('Sorry, we could not submit your request online. Your email app will open so you can send it to us instead.');
      location.href = mailtoUrl(ref); finish(ref, true);
    }).finally(function () { next.disabled = false; });
  }

  back.onclick = function () { if (cur > 0) go(cur - 1); };
  next.onclick = function () {
    if (!validate(steps[cur])) return;
    if (cur < steps.length - 1) go(cur + 1); else submit();
  };

  loadDraft();
  if (!tenantBox.children.length) addTenant();
  if (!form.querySelector('[name=e_reason]:checked')) form.querySelector('[name=e_reason]').checked = true;
  syncReason();
  go(0);
})();
