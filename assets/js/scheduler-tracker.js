// scheduler-tracker.js — Nicole's Pre-Op Visit Tracker.
//
// Flow:
//   1) Nicole adds a patient from the surgery center pre-op sheet — name,
//      phone, PCP, surgery date/time/center, optional PDF attachment.
//   2) She calls them to schedule the pre-op visit; she can mark the call as
//      called / voicemail / failed via the status pill.
//   3) Once a time is agreed on, she opens the Schedule modal from the row —
//      it pre-fills the locked patient/surgery info and asks only for the
//      patient's email + the pre-op visit date/time.
//
// Data:
//   atlas/preop_visits          → { entries: [{ id, patientFirst, patientLast,
//                                   patientPhone, patientEmail, pcp,
//                                   surgeryDate, surgeryTime, surgeryCenterId,
//                                   surgeryCenterName, callStatus,
//                                   callStatusAt, scheduledAt, date, time,
//                                   note, crna, nurseCalledAt, clearedAt,
//                                   pdfFilename, addedAt, addedBy }] }
//   atlas/preop_visit_pdfs.{id} → { filename, dataUrl, contentType, sizeBytes }
//   Storing PDFs in their own docs keeps the per-entry Firestore size well
//   under the 1 MB document cap.

(() => {
  const DOC_PATH = 'preop_visits';
  const PDF_DOC_PATH = 'preop_visit_pdfs';
  const WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev';
  const MAX_PDF_BYTES = 700 * 1024; // soft cap so the PDF doc stays under 1 MB

  let _entries = [];
  let _stripeStatus = {}; // { email-lower: { preopVisitPaid, preopVisitPaidAt } }

  function _$(id) { return document.getElementById(id); }
  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _uid() { return Math.random().toString(36).slice(2, 11); }

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

  // ── Call-status pill states ─────────────────────────────────────────────────
  // 'none' (default) | 'called' | 'voicemail' | 'failed'
  const CALL_STATES = [
    { key: 'none',      label: '○ Not yet',       bg:'#fff',    fg:'#64748b', border:'#cbd5e1', dashed:true  },
    { key: 'called',    label: '✓ Called',        bg:'#dcfce7', fg:'#166534', border:'#86efac' },
    { key: 'voicemail', label: '📞 Voicemail',    bg:'#fef9c3', fg:'#854d0e', border:'#fde047' },
    { key: 'failed',    label: '✗ Call failed',   bg:'#fee2e2', fg:'#991b1b', border:'#fca5a5' }
  ];
  const _callStateByKey = Object.fromEntries(CALL_STATES.map(s => [s.key, s]));

  window.renderSchedulerTracker = async function() {
    const body = _$('str-body');
    if(!body) return;
    if(!_entries.length) await _loadEntries();
    if(!_entries.length) {
      body.innerHTML = '<div class="empty-state" style="margin:0;padding:30px"><span class="empty-state-icon">📋</span><div class="empty-state-title">No patients yet</div><div class="empty-state-sub">Click <strong>+ Add Patient</strong> to load one in from the surgery center pre-op sheet.</div></div>';
      return;
    }
    // Sort by surgery date (soonest first), patients with no surgery date last.
    const rows = _entries.slice().sort((a, b) => {
      const ad = a.surgeryDate || '9999-12-31';
      const bd = b.surgeryDate || '9999-12-31';
      return ad.localeCompare(bd);
    });
    // Columns: patient | scheduled / schedule btn | call status | $100 paid | jordan called | cleared | actions
    const COLS = '1.6fr 150px 130px 110px 110px 110px 70px';
    let html = `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
      <span>Patient</span><span>Pre-Op Visit</span><span>Nicole's Call</span><span>$100 Paid</span><span>Jordan Called</span><span>Cleared</span><span></span>
    </div>`;
    rows.forEach(e => {
      const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '—';
      const phoneLine = e.patientPhone ? `<div style="font-size:11px;color:var(--text-faint)">📞 ${_esc(e.patientPhone)}</div>` : '';
      const emailLine = e.patientEmail ? `<div style="font-size:11px;color:var(--text-faint);font-family:monospace">${_esc(e.patientEmail)}</div>` : '';
      const pcpLine   = e.pcp ? `<div style="font-size:11px;color:var(--text-faint)">🩺 PCP: ${_esc(e.pcp)}</div>` : '';
      const surgeryLine = e.surgeryDate
        ? `<div style="font-size:11px;color:#9a3412;font-weight:600">🔴 Surgery: ${_esc(_fmtDate(e.surgeryDate))}${e.surgeryTime ? ' · ' + _esc(_fmtTime(e.surgeryTime)) : ''}${e.surgeryCenterName ? ' · ' + _esc(e.surgeryCenterName) : ''}</div>`
        : '';
      const pdfLine = e.pdfFilename
        ? `<div style="font-size:11px;margin-top:3px"><a href="javascript:void(0)" onclick="window._strViewPDF('${e.id}')" style="color:#1d4ed8;text-decoration:none">📎 ${_esc(e.pdfFilename)}</a> <a href="javascript:void(0)" onclick="window._strRemovePDF('${e.id}')" title="Remove PDF" style="color:var(--warn);text-decoration:none;margin-left:6px">✕</a></div>`
        : `<div style="font-size:11px;margin-top:3px"><a href="javascript:void(0)" onclick="window._strAttachPDF('${e.id}')" style="color:var(--text-faint);text-decoration:none">📎 Attach pre-op PDF</a></div>`;

      // Pre-Op Visit column. Scheduler sees the Schedule button on pending rows;
      // anyone else (Jordan) just sees "Not scheduled yet" so they don't try to
      // book without the patient's email/visit time agreed.
      const isScheduler = (window._userRole === 'scheduler');
      const scheduledCell = e.scheduledAt
        ? `<div style="font-size:12px;color:var(--text)">${_esc(_fmtDate(e.date))}${e.time ? '<br><span style="color:var(--text-faint)">' + _esc(_fmtTime(e.time)) + '</span>' : ''}</div>`
        : (isScheduler
            ? `<button onclick="window._strOpenSchedule('${e.id}')" class="btn btn-primary btn-sm" style="background:#1d3557;border-color:#1d3557;font-size:11px;padding:5px 10px;white-space:nowrap">📅 Schedule</button>`
            : `<div style="font-size:12px;color:var(--text-faint);font-style:italic">Not scheduled yet</div>`);

      // Call-status pill (multi-state, cycles through none → called → voicemail → failed)
      const cs = _callStateByKey[e.callStatus || 'none'] || _callStateByKey.none;
      const callPill = `<button onclick="window._strCycleCallStatus('${e.id}')" style="background:${cs.bg};color:${cs.fg};border:1px ${cs.dashed?'dashed':'solid'} ${cs.border};font-size:11px;font-weight:${cs.key==='none'?'600':'700'};padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit;white-space:nowrap">${cs.label}</button>`;

      // Status pills (jordan called, cleared) — kept as simple toggles
      const pill = (done, onLabel, offLabel, color, toggleFn) =>
        done
          ? `<button onclick="${toggleFn}('${e.id}', false)" style="background:${color.bg};color:${color.fg};border:1px solid ${color.border};font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">${onLabel}</button>`
          : `<button onclick="${toggleFn}('${e.id}', true)"  style="background:#fff;color:#64748b;border:1px dashed #cbd5e1;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">${offLabel}</button>`;
      const green  = { bg:'#dcfce7', fg:'#166534', border:'#86efac' };
      const indigo = { bg:'#e0e7ff', fg:'#3730a3', border:'#a5b4fc' };
      const nurseCalled = !!e.nurseCalledAt;
      const cleared     = !!e.clearedAt;

      // $100 paid: either Stripe saw a successful $100 charge, OR Nicole
      // manually marked it paid (typical when the card was taken over the
      // phone and run through a non-Stripe processor). Stripe-confirmed
      // status overrides manual state for the label so it's obvious which
      // source flagged it.
      const stripe = _stripeStatus[(e.patientEmail||'').toLowerCase()] || {};
      const stripePaid = !!stripe.preopVisitPaid;
      const manualPaid = !!e.manualPaidAt;
      const paidPill = stripePaid
        ? `<button onclick="window._strToggleManualPaid('${e.id}')" title="Confirmed via Stripe — tap to override" style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">✓ Paid · Stripe</button>`
        : manualPaid
          ? `<button onclick="window._strToggleManualPaid('${e.id}')" title="Marked paid manually — tap to unmark" style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">✓ Paid · Phone</button>`
          : `<button onclick="window._strToggleManualPaid('${e.id}')" title="Tap to mark paid (e.g. card taken over phone)" style="background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">⏳ Pending</button>`;

      // Jordan sees an "Open Pre-Op" button whenever a pre-op record has been
      // auto-created for this entry — taps it to open the assessment directly.
      const isAssistant = (window._userRole === 'assistant');
      const openPreopBtn = (isAssistant && e.preopRecordId)
        ? `<button onclick="window._strOpenPreop('${e.preopRecordId}')" class="btn btn-ghost btn-sm" title="Open the linked pre-op assessment" style="font-size:11px;padding:3px 7px;color:#1d4ed8;border-color:#bfdbfe">📋 Pre-Op</button>`
        : '';
      // Only the scheduler edits patient info or deletes rows; Jordan is
      // read-only on those (she still toggles her own pills + opens pre-op).
      const editBtn = isScheduler
        ? `<button onclick="window._strOpenAddPatient('${e.id}')" class="btn btn-ghost btn-sm" title="Edit patient info" style="font-size:11px;padding:3px 7px">✏</button>`
        : '';
      const delBtn = isScheduler
        ? `<button onclick="window._strDelete('${e.id}')" class="btn btn-ghost btn-sm" title="Delete" style="font-size:11px;color:var(--warn);padding:3px 7px">🗑</button>`
        : '';
      html += `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);align-items:center">
        <div><div style="font-size:14px;font-weight:600;color:var(--text)">${_esc(name)}</div>${phoneLine}${emailLine}${pcpLine}${surgeryLine}${pdfLine}</div>
        <div>${scheduledCell}</div>
        <div>${callPill}</div>
        <div>${paidPill}</div>
        <div>${pill(nurseCalled, '✓ Call Made', '○ Not yet', green,  'window._strToggleNurseCalled')}</div>
        <div>${pill(cleared,     '✓ Cleared',   '○ Pending', indigo, 'window._strToggleCleared')}</div>
        <div style="text-align:right;display:flex;gap:4px;justify-content:flex-end">
          ${openPreopBtn}${editBtn}${delBtn}
        </div>
      </div>`;
    });
    body.innerHTML = html;
  };

  // ── Add / Edit Patient modal ────────────────────────────────────────────────
  window._strOpenAddPatient = async function(editId) {
    if(!_entries.length) await _loadEntries();
    const existing = editId ? _entries.find(e => e.id === editId) : null;
    const isEdit = !!existing;
    const prior = document.getElementById('strAddPatientModal');
    if(prior) prior.remove();
    const wrap = document.createElement('div');
    wrap.id = 'strAddPatientModal';
    wrap.dataset.editId = editId || '';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };

    // Build the surgery-center dropdown from window.surgeryCenters; fall back
    // to a free-text input if the list isn't loaded yet.
    const centers = window.surgeryCenters || [];
    const centerOptions = centers.map(c => `<option value="${_esc(c.id)}"${existing && existing.surgeryCenterId === c.id ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');

    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:560px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">${isEdit ? 'Edit' : 'Add'}</div><div style="font-size:16px;font-weight:600">${isEdit ? 'Patient details' : 'New patient'}</div></div>
        <button onclick="document.getElementById('strAddPatientModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button>
      </div>
      <div style="padding:20px 22px">
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e3a8a;line-height:1.5">Load the patient from the surgery center's pre-op sheet. You'll schedule their pre-op visit with Jordan from this entry once you reach them by phone.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">First name <span style="color:var(--warn)">*</span></label><input type="text" id="strap-first" placeholder="e.g. John" value="${_esc(existing?.patientFirst || '')}"></div>
          <div><label style="margin-top:0">Last name</label><input type="text" id="strap-last" placeholder="e.g. Smith" value="${_esc(existing?.patientLast || '')}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">Phone <span style="color:var(--warn)">*</span></label><input type="tel" id="strap-phone" placeholder="(555) 123-4567" value="${_esc(existing?.patientPhone || '')}"></div>
          <div><label style="margin-top:0">PCP <span style="font-weight:400;color:var(--text-faint);font-size:11px">(if any)</span></label><input type="text" id="strap-pcp" placeholder="Dr. Smith" value="${_esc(existing?.pcp || '')}"></div>
        </div>
        <div style="border:1px solid #fed7aa;background:#fff7ed;border-radius:8px;padding:12px 14px;margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9a3412;margin-bottom:8px">Surgery details</div>
          <div style="display:grid;grid-template-columns:1fr 140px;gap:14px;margin-bottom:12px">
            <div><label style="margin-top:0">Surgery date <span style="color:var(--warn)">*</span></label><input type="date" id="strap-surg-date" value="${_esc(existing?.surgeryDate || '')}"></div>
            <div><label style="margin-top:0">Start time</label><input type="time" id="strap-surg-time" value="${_esc(existing?.surgeryTime || '')}"></div>
          </div>
          <div><label style="margin-top:0">Surgery center</label>${centers.length
            ? `<select id="strap-center"><option value="">— Pick a center —</option>${centerOptions}</select>`
            : `<input type="text" id="strap-center" placeholder="e.g. Bellin Surgery Center" value="${_esc(existing?.surgeryCenterName || '')}">`}</div>
        </div>
        <div style="margin-bottom:14px">
          <label style="margin-top:0">Pre-op PDF <span style="font-weight:400;color:var(--text-faint);font-size:11px">(from the surgery center, optional)</span></label>
          <input type="file" id="strap-pdf" accept="application/pdf" style="font-size:13px">
          ${existing?.pdfFilename ? `<div style="font-size:11px;color:var(--text-faint);margin-top:4px">Currently attached: <strong>${_esc(existing.pdfFilename)}</strong>. Pick a new file to replace it, or leave blank to keep.</div>` : ''}
        </div>
        <div id="strap-status" style="font-size:13px;padding:6px 0;min-height:18px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--border)">
          <button class="btn btn-ghost" onclick="document.getElementById('strAddPatientModal').remove()">Cancel</button>
          <button class="btn btn-primary" id="strap-save-btn" onclick="window._strSavePatient()" style="background:#1d3557;border-color:#1d3557">${isEdit ? '✓ Save' : '+ Add to Tracker'}</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    setTimeout(() => { document.getElementById('strap-first')?.focus(); }, 60);
  };

  // Read a File as a data URL (base64) for inline Firestore storage.
  function _readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  window._strSavePatient = async function() {
    const editId = document.getElementById('strAddPatientModal')?.dataset.editId || '';
    const first = (_$('strap-first')?.value || '').trim();
    const last  = (_$('strap-last')?.value || '').trim();
    const phone = (_$('strap-phone')?.value || '').trim();
    const pcp   = (_$('strap-pcp')?.value || '').trim();
    const surgD = _$('strap-surg-date')?.value || '';
    const surgT = _$('strap-surg-time')?.value || '';
    const centerEl = _$('strap-center');
    const centers = window.surgeryCenters || [];
    let surgeryCenterId = '', surgeryCenterName = '';
    if(centerEl) {
      if(centerEl.tagName === 'SELECT') {
        surgeryCenterId = centerEl.value || '';
        const c = centers.find(x => x.id === surgeryCenterId);
        surgeryCenterName = c ? c.name : '';
      } else {
        surgeryCenterName = (centerEl.value || '').trim();
      }
    }
    const status = _$('strap-status');
    const setError = msg => { if(status) { status.textContent = '✗ ' + msg; status.style.color = '#b91c1c'; } };
    if(!first) { setError('First name is required.'); return; }
    if(!phone) { setError('Phone number is required.'); return; }
    if(!surgD) { setError('Surgery date is required.'); return; }

    const file = _$('strap-pdf')?.files?.[0];
    if(file) {
      if(file.type !== 'application/pdf') { setError('Pre-op file must be a PDF.'); return; }
      if(file.size > MAX_PDF_BYTES) { setError(`PDF is too large (${Math.round(file.size/1024)} KB). Keep it under ${Math.round(MAX_PDF_BYTES/1024)} KB.`); return; }
    }

    const btn = _$('strap-save-btn');
    if(btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      if(!_entries.length) await _loadEntries();
      let entry;
      if(editId) {
        const idx = _entries.findIndex(e => e.id === editId);
        if(idx === -1) throw new Error('Entry not found');
        entry = _entries[idx];
        Object.assign(entry, {
          patientFirst: first, patientLast: last, patientPhone: phone, pcp,
          surgeryDate: surgD, surgeryTime: surgT,
          surgeryCenterId, surgeryCenterName
        });
      } else {
        entry = {
          id: _uid(),
          patientFirst: first, patientLast: last, patientPhone: phone, pcp,
          surgeryDate: surgD, surgeryTime: surgT,
          surgeryCenterId, surgeryCenterName,
          callStatus: 'none',
          addedAt: new Date().toISOString(),
          addedBy: (window.currentUser?.email) || ''
        };
        _entries.unshift(entry);
      }
      // Upload PDF first so its filename can be stamped on the entry.
      if(file) {
        const dataUrl = await _readFileAsDataUrl(file);
        await window.setDoc(window.doc(window.db, 'atlas', PDF_DOC_PATH + '.' + entry.id), {
          filename: file.name, dataUrl, contentType: file.type, sizeBytes: file.size
        });
        entry.pdfFilename = file.name;
      }
      await _saveEntries();
      try { window.logAudit && window.logAudit(editId ? 'preop-visit-patient-edited' : 'preop-visit-patient-added', entry.id, first + ' ' + last); } catch(e){}
      document.getElementById('strAddPatientModal')?.remove();
      window.renderSchedulerTracker();
    } catch(err) {
      setError(err.message || String(err));
      if(btn) { btn.disabled = false; btn.textContent = editId ? '✓ Save' : '+ Add to Tracker'; }
    }
  };

  // ── PDF attach / view / remove ──────────────────────────────────────────────
  window._strAttachPDF = async function(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if(!file) return;
      if(file.type !== 'application/pdf') { alert('Pick a PDF file.'); return; }
      if(file.size > MAX_PDF_BYTES) { alert(`PDF is too large (${Math.round(file.size/1024)} KB). Keep it under ${Math.round(MAX_PDF_BYTES/1024)} KB.`); return; }
      const idx = _entries.findIndex(e => e.id === id);
      if(idx === -1) return;
      try {
        const dataUrl = await _readFileAsDataUrl(file);
        await window.setDoc(window.doc(window.db, 'atlas', PDF_DOC_PATH + '.' + id), {
          filename: file.name, dataUrl, contentType: file.type, sizeBytes: file.size
        });
        _entries[idx].pdfFilename = file.name;
        await _saveEntries();
        try { window.logAudit && window.logAudit('preop-visit-pdf-attached', id, file.name); } catch(e){}
        window.renderSchedulerTracker();
      } catch(e) { alert('Could not attach PDF: ' + e.message); }
    };
    input.click();
  };

  window._strViewPDF = async function(id) {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', PDF_DOC_PATH + '.' + id));
      if(!snap.exists()) { alert('PDF not found.'); return; }
      const data = snap.data();
      // Open the PDF in a new tab via the data URL. Some browsers block large
      // data: URLs from new windows — fall back to a download link if so.
      const w = window.open();
      if(w) {
        w.document.write(`<title>${_esc(data.filename || 'Pre-op PDF')}</title><iframe src="${data.dataUrl}" style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe>`);
      } else {
        const a = document.createElement('a');
        a.href = data.dataUrl;
        a.download = data.filename || 'preop.pdf';
        document.body.appendChild(a); a.click(); a.remove();
      }
    } catch(e) { alert('Could not load PDF: ' + e.message); }
  };

  window._strRemovePDF = async function(id) {
    if(!confirm('Remove the attached PDF for this patient?')) return;
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    try {
      await window.deleteDoc(window.doc(window.db, 'atlas', PDF_DOC_PATH + '.' + id));
    } catch(e) { /* deletion is best-effort — even if it fails we still want to clear the pointer */ }
    _entries[idx].pdfFilename = null;
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-pdf-removed', id); } catch(e){}
    window.renderSchedulerTracker();
  };

  // ── Schedule modal entry point ──────────────────────────────────────────────
  window._strOpenSchedule = function(id) {
    if(typeof window.openSchedulePreopVisitModal !== 'function') {
      alert('Scheduling modal is not loaded yet — give the page a moment and try again.');
      return;
    }
    window.openSchedulePreopVisitModal(id);
  };

  // Open the pre-op record linked to this tracker entry — used by Jordan's
  // "📋 Pre-Op" button so she jumps straight into the assessment.
  window._strOpenPreop = function(recordId) {
    if(!recordId) { alert('No pre-op assessment is linked to this patient yet.'); return; }
    if(typeof window.editPreopRecord !== 'function') {
      alert('Pre-op editor not loaded yet — give the page a moment and try again.');
      return;
    }
    window.editPreopRecord(recordId);
  };

  // Manual paid toggle — for the case when the $100 was collected outside
  // Stripe (e.g. card taken over the phone via a different processor). Stripe-
  // confirmed paid status is read-only from here; this flag is independent.
  window._strToggleManualPaid = async function(id) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    const isPaid = !!_entries[idx].manualPaidAt;
    if(isPaid) {
      _entries[idx].manualPaidAt = null;
      _entries[idx].manualPaidBy = null;
    } else {
      _entries[idx].manualPaidAt = new Date().toISOString();
      _entries[idx].manualPaidBy = (window.currentUser?.email) || '';
    }
    await _saveEntries();
    try { window.logAudit && window.logAudit(isPaid ? 'preop-visit-manual-unpaid' : 'preop-visit-manual-paid', id); } catch(e){}
    window.renderSchedulerTracker();
  };

  // ── Multi-state call pill: none → called → voicemail → failed → none ───────
  window._strCycleCallStatus = async function(id) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    const cur = _entries[idx].callStatus || 'none';
    const keys = CALL_STATES.map(s => s.key);
    const next = keys[(keys.indexOf(cur) + 1) % keys.length];
    _entries[idx].callStatus = next;
    _entries[idx].callStatusAt = new Date().toISOString();
    _entries[idx].callStatusBy = (window.currentUser?.email) || '';
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-call-status-' + next, id, _entries[idx].patientFirst + ' ' + _entries[idx].patientLast); } catch(e){}
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
    if(!confirm(`Remove ${label} from the Tracker?`)) return;
    _entries = _entries.filter(x => x.id !== id);
    try { await window.deleteDoc(window.doc(window.db, 'atlas', PDF_DOC_PATH + '.' + id)); } catch(_){}
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

  // Look up a tracker entry by id — used by the Schedule modal in app.js so it
  // can pre-fill (and lock) the patient/surgery fields.
  window._strGetEntry = function(id) {
    return _entries.find(e => e.id === id) || null;
  };

  // Read the full entries list (used by Jordan's Calendar in app.js to plot
  // every scheduled pre-op visit call as an event).
  window._strGetAllEntries = function() {
    return _entries.slice();
  };

  // Update an entry from outside (e.g. the Schedule modal stamping it with
  // visit date/time + scheduledAt). Replaces the entry in the array, saves,
  // and re-renders.
  window._strUpdateEntry = async function(id, patch) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return false;
    Object.assign(_entries[idx], patch);
    await _saveEntries();
    window.renderSchedulerTracker();
    return true;
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
