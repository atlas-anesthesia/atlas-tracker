// scheduler-tracker.js — Nicole's Pre-Op Visit Tracker.
//
// Lists every booking Nicole has made (atlas/preop_visits). For each row:
//   • Patient name + visit date/time
//   • "Called" pill she can click to toggle (persists)
//   • "$100 Paid" pill that auto-refreshes from Stripe
//
// Stripe sync: when Nicole clicks ↻ Refresh Stripe (or opens the tab),
// the module calls /stripe-check for each unique patient email and uses the
// `preopVisitPaid` flag the worker returns.

(() => {
  const DOC_PATH = 'preop_visits';
  const WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev';

  let _entries = [];
  let _stripeStatus = {}; // { email-lower: { preopVisitPaid, preopVisitPaidAt } }

  function _$(id) { return document.getElementById(id); }
  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  async function _loadEntries() {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', DOC_PATH));
      _entries = snap.exists() ? (snap.data().entries || []) : [];
    } catch(e) { console.warn('tracker load:', e); _entries = []; }
  }

  async function _saveEntries() {
    await window.setDoc(window.doc(window.db, 'atlas', DOC_PATH), { entries: _entries });
  }

  function _fmtDate(iso) {
    if(!iso) return '—';
    try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
    catch(e) { return iso; }
  }
  function _fmtTime(t) {
    if(!t) return '';
    try { return new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }); }
    catch(e) { return t; }
  }

  window.renderSchedulerTracker = async function() {
    const body = _$('str-body');
    if(!body) return;
    if(!_entries.length) await _loadEntries();
    if(!_entries.length) {
      body.innerHTML = '<div class="empty-state" style="margin:0;padding:30px"><span class="empty-state-icon">📋</span><div class="empty-state-title">No bookings yet</div><div class="empty-state-sub">Use the Calendar to schedule a pre-op visit.</div></div>';
      return;
    }
    // Sort newest visit first
    const rows = _entries.slice().sort((a, b) => {
      const ad = (a.date || '') + 'T' + (a.time || '00:00');
      const bd = (b.date || '') + 'T' + (b.time || '00:00');
      return bd.localeCompare(ad);
    });
    // Columns: patient | visit | scheduling-called | $100 paid | jordan-called | cleared | trash
    const COLS = '1.4fr 130px 110px 110px 110px 110px 50px';
    let html = `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
      <span>Patient</span><span>Visit</span><span>Nicole Called</span><span>$100 Paid</span><span>Jordan Called</span><span>Cleared</span><span></span>
    </div>`;
    rows.forEach(e => {
      const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '—';
      const dateTxt = e.date ? _fmtDate(e.date) + (e.time ? ' · ' + _fmtTime(e.time) : '') : '—';
      const called   = !!e.calledAt;
      const nurseCalled = !!e.nurseCalledAt;
      const cleared = !!e.clearedAt;
      const stripe = _stripeStatus[(e.patientEmail||'').toLowerCase()] || {};
      const paid = !!stripe.preopVisitPaid;
      const pill = (done, onLabel, offLabel, color, toggleFn) =>
        done
          ? `<button onclick="${toggleFn}('${e.id}', false)" style="background:${color.bg};color:${color.fg};border:1px solid ${color.border};font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">${onLabel}</button>`
          : `<button onclick="${toggleFn}('${e.id}', true)"  style="background:#fff;color:#64748b;border:1px dashed #cbd5e1;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">${offLabel}</button>`;
      const green = { bg:'#dcfce7', fg:'#166534', border:'#86efac' };
      const indigo = { bg:'#e0e7ff', fg:'#3730a3', border:'#a5b4fc' };
      const paidPill = paid
        ? `<span title="Confirmed via Stripe" style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px">✓ Paid</span>`
        : `<span title="No $100 charge yet" style="background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px">⏳ Pending</span>`;
      const emailLine = e.patientEmail ? `<div style="font-size:11px;color:var(--text-faint);font-family:monospace">${_esc(e.patientEmail)}</div>` : '';
      html += `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);align-items:center">
        <div><div style="font-size:14px;font-weight:600;color:var(--text)">${_esc(name)}</div>${emailLine}</div>
        <div style="font-size:12px;color:var(--text-muted)">${_esc(dateTxt)}</div>
        <div>${pill(called,     '✓ Called',    '○ Not yet', green,  'window._strToggleCalled')}</div>
        <div>${paidPill}</div>
        <div>${pill(nurseCalled,'✓ Call Made', '○ Not yet', green,  'window._strToggleNurseCalled')}</div>
        <div>${pill(cleared,    '✓ Cleared',   '○ Pending', indigo, 'window._strToggleCleared')}</div>
        <div style="text-align:right"><button onclick="window._strDelete('${e.id}')" class="btn btn-ghost btn-sm" title="Delete" style="font-size:11px;color:var(--warn);padding:3px 8px">🗑</button></div>
      </div>`;
    });
    body.innerHTML = html;
  };

  window._strToggleCalled = async function(id, called) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    if(called) {
      _entries[idx].calledAt = new Date().toISOString();
      _entries[idx].calledBy = (window.currentUser?.email) || '';
    } else {
      _entries[idx].calledAt = null;
      _entries[idx].calledBy = null;
    }
    await _saveEntries();
    try { window.logAudit && window.logAudit(called ? 'preop-visit-called' : 'preop-visit-uncalled', id, _entries[idx].patientFirst + ' ' + _entries[idx].patientLast); } catch(e){}
    window.renderSchedulerTracker();
  };

  // Jordan made the pre-op clearance call to the patient.
  window._strToggleNurseCalled = async function(id, done) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    if(done) {
      _entries[idx].nurseCalledAt = new Date().toISOString();
      _entries[idx].nurseCalledBy = (window.currentUser?.email) || '';
    } else {
      _entries[idx].nurseCalledAt = null;
      _entries[idx].nurseCalledBy = null;
    }
    await _saveEntries();
    try { window.logAudit && window.logAudit(done ? 'preop-visit-nurse-called' : 'preop-visit-nurse-uncalled', id, _entries[idx].patientFirst + ' ' + _entries[idx].patientLast); } catch(e){}
    window.renderSchedulerTracker();
  };

  // Patient cleared for anesthesia services by Jordan.
  window._strToggleCleared = async function(id, done) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    if(done) {
      _entries[idx].clearedAt = new Date().toISOString();
      _entries[idx].clearedBy = (window.currentUser?.email) || '';
    } else {
      _entries[idx].clearedAt = null;
      _entries[idx].clearedBy = null;
    }
    await _saveEntries();
    try { window.logAudit && window.logAudit(done ? 'preop-visit-cleared' : 'preop-visit-uncleared', id, _entries[idx].patientFirst + ' ' + _entries[idx].patientLast); } catch(e){}
    window.renderSchedulerTracker();
  };

  window._strDelete = async function(id) {
    const e = _entries.find(x => x.id === id);
    if(!e) return;
    const label = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '(patient)';
    if(!confirm(`Delete this booking for ${label}?`)) return;
    _entries = _entries.filter(x => x.id !== id);
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-deleted', id, label); } catch(e){}
    window.renderSchedulerTracker();
  };

  // Pull each unique patient email through the worker's /stripe-check so we
  // know which $100 charges have actually landed.
  window._strRefreshStripe = async function() {
    const btn = _$('str-stripe-refresh');
    const orig = btn?.textContent;
    if(btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      await _loadEntries();
      const emails = [...new Set(_entries.map(e => (e.patientEmail||'').toLowerCase()).filter(Boolean))];
      for(const email of emails) {
        try {
          const res = await fetch(WORKER_URL + '/stripe-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerEmail: email })
          });
          if(!res.ok) continue;
          const data = await res.json();
          _stripeStatus[email] = {
            preopVisitPaid:   !!data.preopVisitPaid,
            preopVisitPaidAt: data.preopVisitPaidAt || null
          };
        } catch(e) { /* keep prior status on transient failure */ }
      }
      window.renderSchedulerTracker();
    } finally {
      if(btn) { btn.disabled = false; btn.textContent = orig || '↻ Refresh Stripe'; }
    }
  };

  // Auto-run when Nicole opens the Tracker tab.
  const origShowTab = window.showTab;
  if(typeof origShowTab === 'function') {
    window.showTab = function(name) {
      const ret = origShowTab.apply(this, arguments);
      if(name === 'scheduler-tracker') {
        (async () => {
          await _loadEntries();
          window.renderSchedulerTracker();
          window._strRefreshStripe(); // fire and forget
        })();
      }
      return ret;
    };
  }
})();
