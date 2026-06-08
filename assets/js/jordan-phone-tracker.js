// jordan-phone-tracker.js — Excel-style log of patient phone calls.
// Jordan-only. Stored in atlas/jordan_phone_log as { entries: [...] }.
// Each entry: { id, date (YYYY-MM-DD), time (HH:MM), patientName,
//                patientDOB (YYYY-MM-DD), note?, addedAt, addedBy }

(() => {
  const DOC_PATH = 'jordan_phone_log';

  const $ = id => document.getElementById(id);
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const uid = () => Math.random().toString(36).slice(2, 11);
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const nowHM = () => {
    const d = new Date();
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  };
  const fmtDate = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
  const fmtTime = t => {
    if(!t) return '';
    const [h, m] = t.split(':');
    const hh = parseInt(h, 10);
    if(Number.isNaN(hh)) return t;
    const period = hh >= 12 ? 'PM' : 'AM';
    const hr12 = hh % 12 || 12;
    return hr12 + ':' + (m || '00') + ' ' + period;
  };

  let _entries = [];
  let _subscribed = false;

  function subscribe() {
    if(_subscribed) return;
    if(typeof window.onSnapshot !== 'function' || !window.db) {
      setTimeout(subscribe, 200); return;
    }
    _subscribed = true;
    try {
      window.onSnapshot(window.doc(window.db, 'atlas', DOC_PATH), snap => {
        _entries = snap.exists() ? (snap.data().entries || []) : [];
        render();
      });
    } catch(e) { console.warn('phone tracker subscribe:', e); _subscribed = false; }
  }
  subscribe();

  async function save() {
    await window.setDoc(window.doc(window.db, 'atlas', DOC_PATH), { entries: _entries });
  }

  function render() {
    const host = $('jpt-list');
    if(!host) return;
    if(window._userRole !== 'assistant') { host.innerHTML = ''; return; }
    // Sort newest call first (date desc, then time desc).
    const rows = [..._entries].sort((a, b) => {
      const d = (b.date || '').localeCompare(a.date || '');
      if(d !== 0) return d;
      return (b.time || '').localeCompare(a.time || '');
    });

    const COLS = '130px 110px 1.4fr 130px 1.6fr 50px';
    const header = `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:10px 14px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
      <span>Date</span><span>Time</span><span>Patient Name</span><span>DOB</span><span>Note</span><span style="text-align:right"></span>
    </div>`;

    if(!rows.length) {
      host.innerHTML = header + '<div style="padding:30px 14px;text-align:center;color:var(--text-faint);font-style:italic;font-size:13px">No calls logged yet — click <strong>+ Add Call</strong> to add the first one.</div>';
      return;
    }

    // Inline-editable spreadsheet-style cells. Every field is an input on
    // the page; onchange writes to Firestore via _jptCellChange.
    const cellStyle = 'width:100%;padding:6px 8px;font-size:13px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--text);outline:none;font-family:inherit';
    const focusStyle = "this.style.border='1px solid var(--accent)';this.style.background='#fff'";
    const blurStyle = "this.style.border='1px solid transparent';this.style.background='transparent'";
    const body = rows.map(r => `
      <div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);align-items:center">
        <input type="date" value="${esc(r.date || '')}" onchange="window._jptCellChange('${r.id}','date',this.value)"
          onfocus="${focusStyle}" onblur="${blurStyle}"
          style="${cellStyle};font-family:'DM Mono',monospace">
        <input type="time" value="${esc(r.time || '')}" onchange="window._jptCellChange('${r.id}','time',this.value)"
          onfocus="${focusStyle}" onblur="${blurStyle}"
          style="${cellStyle};font-family:'DM Mono',monospace">
        <input type="text" value="${esc(r.patientName || '')}" placeholder="First Last"
          onchange="window._jptCellChange('${r.id}','patientName',this.value)"
          onfocus="${focusStyle}" onblur="${blurStyle}"
          style="${cellStyle};font-weight:500">
        <input type="date" value="${esc(r.patientDOB || '')}" onchange="window._jptCellChange('${r.id}','patientDOB',this.value)"
          onfocus="${focusStyle}" onblur="${blurStyle}"
          style="${cellStyle};color:var(--text-muted);font-family:'DM Mono',monospace">
        <input type="text" value="${esc(r.note || '')}" placeholder="Note"
          onchange="window._jptCellChange('${r.id}','note',this.value)"
          onfocus="${focusStyle}" onblur="${blurStyle}"
          style="${cellStyle};color:var(--text-muted)">
        <span style="display:flex;gap:4px;justify-content:flex-end">
          <button onclick="window._jptDelete('${r.id}')" title="Delete" style="background:none;border:none;color:var(--warn);font-size:14px;cursor:pointer;padding:4px 6px">🗑</button>
        </span>
      </div>`).join('');

    host.innerHTML = header + body;
  }

  // Cell-edit save — one field at a time. Re-renders the list so sort order
  // updates if date/time changed.
  window._jptCellChange = async function(id, field, value) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    _entries[idx] = { ..._entries[idx], [field]: (value == null ? '' : String(value)) };
    try { await save(); } catch(err) { alert('Could not save edit: ' + (err.message || err)); return; }
    try { window.logAudit && window.logAudit('phone-call-cell-edited', '', _entries[idx].patientName || ''); } catch(_){}
    render();
  };
  // Re-render whenever the tab becomes active so it looks fresh.
  setInterval(() => {
    if(document.getElementById('tab-phone-tracker')?.classList.contains('active')) render();
  }, 2000);

  function openModal(existing) {
    const isEdit = !!existing;
    const prior = $('jptModal'); if(prior) prior.remove();
    const wrap = document.createElement('div');
    wrap.id = 'jptModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = e => { if(e.target === wrap) wrap.remove(); };
    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">${isEdit ? 'Edit' : 'Add'} Call</div>
          <div style="font-size:16px;font-weight:600">Phone Tracker</div>
        </div>
        <button onclick="document.getElementById('jptModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button>
      </div>
      <div style="padding:20px 22px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">Date <span style="color:var(--warn)">*</span></label><input type="date" id="jpt-date" value="${esc(existing?.date || todayIso())}"></div>
          <div><label style="margin-top:0">Time <span style="color:var(--warn)">*</span></label><input type="time" id="jpt-time" value="${esc(existing?.time || nowHM())}"></div>
        </div>
        <div style="margin-bottom:14px">
          <label style="margin-top:0">Patient Name <span style="color:var(--warn)">*</span></label>
          <input type="text" id="jpt-name" placeholder="First Last" value="${esc(existing?.patientName || '')}" autocomplete="off">
        </div>
        <div style="margin-bottom:14px">
          <label style="margin-top:0">Date of Birth</label>
          <input type="date" id="jpt-dob" value="${esc(existing?.patientDOB || '')}">
        </div>
        <div style="margin-bottom:14px">
          <label style="margin-top:0">Note <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label>
          <textarea id="jpt-note" rows="3" placeholder="What was discussed, follow-up needed, etc." style="width:100%;padding:8px 11px;font-family:'DM Sans',sans-serif;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;resize:vertical">${esc(existing?.note || '')}</textarea>
        </div>
        <div id="jpt-status" style="font-size:13px;padding:6px 0;min-height:18px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--border)">
          <button class="btn btn-ghost" onclick="document.getElementById('jptModal').remove()">Cancel</button>
          <button class="btn btn-primary" id="jpt-save-btn" onclick="window._jptSave('${esc(existing?.id || '')}')" style="background:#1d3557;border-color:#1d3557">${isEdit ? '✓ Save' : '+ Add'}</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    setTimeout(() => $('jpt-name')?.focus(), 60);
  }

  window._jptOpenAdd = function() {
    openModal(null);
    // Patient autocomplete from the tracker entries — small affordance so
    // Jordan doesn't retype the name if it's a current patient.
    setTimeout(() => {
      const list = (window._preopVisitEntries || []).filter(e => e.patientFirst || e.patientLast);
      const nameEl = $('jpt-name');
      const dobEl  = $('jpt-dob');
      if(!nameEl || !list.length) return;
      // Render a simple datalist suggestion.
      const dl = document.createElement('datalist');
      dl.id = 'jpt-name-list';
      dl.innerHTML = list.map(e => {
        const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ');
        return `<option value="${esc(name)}" data-dob="${esc(e.patientDOB || '')}"></option>`;
      }).join('');
      nameEl.parentElement.appendChild(dl);
      nameEl.setAttribute('list', 'jpt-name-list');
      nameEl.addEventListener('input', () => {
        if(dobEl && !dobEl.value) {
          const match = list.find(e => {
            const n = [e.patientFirst, e.patientLast].filter(Boolean).join(' ');
            return n.toLowerCase() === nameEl.value.trim().toLowerCase();
          });
          if(match && match.patientDOB) dobEl.value = match.patientDOB;
        }
      });
    }, 80);
  };

  window._jptOpenEdit = function(id) {
    const e = _entries.find(x => x.id === id);
    if(e) openModal(e);
  };

  window._jptSave = async function(id) {
    const date = $('jpt-date')?.value || '';
    const time = $('jpt-time')?.value || '';
    const name = ($('jpt-name')?.value || '').trim();
    const dob  = $('jpt-dob')?.value || '';
    const note = ($('jpt-note')?.value || '').trim();
    const status = $('jpt-status');
    const setError = m => { if(status) { status.textContent = '✗ ' + m; status.style.color = '#b91c1c'; } };
    if(!date) { setError('Date is required.'); return; }
    if(!time) { setError('Time is required.'); return; }
    if(!name) { setError('Patient name is required.'); return; }
    const btn = $('jpt-save-btn');
    if(btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      if(id) {
        const i = _entries.findIndex(x => x.id === id);
        if(i === -1) throw new Error('Entry not found');
        _entries[i] = { ..._entries[i], date, time, patientName: name, patientDOB: dob, note };
      } else {
        _entries.push({
          id: uid(), date, time, patientName: name, patientDOB: dob, note,
          addedAt: new Date().toISOString(),
          addedBy: (window.currentUser?.email) || ''
        });
      }
      await save();
      try { window.logAudit && window.logAudit(id ? 'phone-call-edited' : 'phone-call-added', '', name); } catch(_){}
      $('jptModal')?.remove();
      render();
    } catch(err) {
      setError(err.message || String(err));
      if(btn) { btn.disabled = false; btn.textContent = id ? '✓ Save' : '+ Add'; }
    }
  };

  // Called by scheduler-tracker._strToggleNurseCalled the moment Jordan flips
  // the "Call Made" pill on the Tracker. Adds a Phone Tracker row for that
  // patient if one doesn't already exist (idempotent by trackerEntryId — so
  // toggling the pill off then on doesn't create duplicates). The auto-row's
  // date/time are stamped to "now"; Jordan can edit afterwards if needed.
  window._jptLogTrackerCall = async function(trackerEntry) {
    const trackerEntryId = trackerEntry && trackerEntry.id;
    if(!trackerEntryId) return;
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', DOC_PATH));
      const list = snap.exists() ? (snap.data().entries || []) : [];
      if(list.some(e => e && e.trackerEntryId === trackerEntryId)) return; // already logged
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      list.push({
        id: uid(),
        date, time,
        patientName: [trackerEntry.patientFirst, trackerEntry.patientLast].filter(Boolean).join(' '),
        patientDOB: trackerEntry.patientDOB || '',
        note: 'Auto-logged from Call Made pill',
        trackerEntryId,
        addedAt: new Date().toISOString(),
        addedBy: (window.currentUser?.email) || ''
      });
      await window.setDoc(window.doc(window.db, 'atlas', DOC_PATH), { entries: list });
    } catch(e) { console.warn('phone tracker auto-log failed:', e); }
  };

  window._jptDelete = async function(id) {
    const e = _entries.find(x => x.id === id);
    if(!e) return;
    if(!confirm('Delete this phone call entry for ' + (e.patientName || 'patient') + '?')) return;
    _entries = _entries.filter(x => x.id !== id);
    try { await save(); } catch(err) { alert('Could not delete: ' + (err.message || err)); return; }
    try { window.logAudit && window.logAudit('phone-call-deleted', '', e.patientName || ''); } catch(_){}
    render();
  };
})();
