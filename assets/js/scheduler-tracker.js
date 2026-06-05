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
  const INBOX_DOC_PATH = 'scheduling_inbox';      // single doc { items: [] }
  const INBOX_PDF_PREFIX = 'scheduling_inbox_pdf_';
  const WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev';
  const MAX_PDF_BYTES = 700 * 1024; // soft cap so the PDF doc stays under 1 MB

  let _entries = [];
  let _stripeStatus = {}; // { email-lower: { preopVisitPaid, preopVisitPaidAt } }
  let _inboxItems = [];   // [{id, from, subject, receivedAt, pdfs[]|pdfFilename, status}, ...]
  // Cache the merged PDF (data URL + filename + sizeBytes) for the currently
  // open inbox modal so we can save it without re-merging on submit.
  let _currentMergedInboxPdf = null;

  // Lazy-load pdf-lib the first time we need to merge a multi-PDF inbox item.
  // Adds ~250 KB of JS but only when actually needed.
  let _pdfLibLoading = null;
  function _ensurePdfLib() {
    if(typeof window.PDFLib === 'object') return Promise.resolve();
    if(_pdfLibLoading) return _pdfLibLoading;
    _pdfLibLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load PDF merger.'));
      document.head.appendChild(s);
    });
    return _pdfLibLoading;
  }

  // Strip data: prefix, decode base64 into a Uint8Array PDF byte buffer.
  function _dataUrlToBytes(dataUrl) {
    const i = dataUrl.indexOf(',');
    const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for(let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return arr;
  }

  // Concatenate every PDF in `pdfDataUrls` (in order) into a single PDF.
  // Returns a base64 data URL like the inputs.
  async function _mergePdfs(pdfDataUrls) {
    await _ensurePdfLib();
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    for(const url of pdfDataUrls) {
      try {
        const src = await PDFDocument.load(_dataUrlToBytes(url), { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
      } catch(e) {
        console.warn('Skipped a PDF that failed to parse:', e);
      }
    }
    const bytes = await out.save();
    // Convert to base64 in chunks to avoid blowing the call-stack on big PDFs.
    let bin = '';
    const chunk = 0x8000;
    for(let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return 'data:application/pdf;base64,' + btoa(bin);
  }

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

  // Build the inner HTML for a single tracker row. When `phiHidden` is true
  // (entry sits in the History section, > 3 days post-surgery), patient name +
  // contact info + PDF link are masked behind the HIPAA "[hidden]" placeholder
  // and a Show details button. Status pills + surgery metadata remain so
  // pipeline stats stay legible without exposing PHI.
  function _buildTrackerRow(e, COLS, phiHidden) {
    const isScheduler = (window._userRole === 'scheduler');
    const isAssistant = (window._userRole === 'assistant');
    const hiddenSpan = '<span style="color:#94a3b8;font-style:italic;font-size:12px;background:#f1f5f9;padding:1px 8px;border-radius:8px">[hidden]</span>';

    // Patient block — masked when phiHidden. Layout:
    //   Row 1: patient name (bold)
    //   Row 2: contact line — phone · email · PCP (only the ones that exist)
    //   Row 3: surgery line — date · time · center
    //   Row 4: PDF attach link
    // Each row has its own top margin so the column reads as 3-4 calm
    // chunks instead of 5 tightly stacked one-liners.
    const nameHtml = phiHidden ? hiddenSpan : _esc([e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '—');
    let contactParts = [];
    if(!phiHidden) {
      if(e.patientPhone) contactParts.push('📞 ' + _esc(e.patientPhone));
      if(e.patientEmail) contactParts.push('<span style="font-family:monospace">' + _esc(e.patientEmail) + '</span>');
      if(e.pcp)          contactParts.push('🩺 ' + _esc(e.pcp));
    }
    const contactLine = contactParts.length
      ? `<div style="font-size:11px;color:var(--text-faint);margin-top:5px;line-height:1.5">${contactParts.join('<span style="color:#cbd5e1;margin:0 6px">·</span>')}</div>`
      : '';
    const surgeryLine = e.surgeryDate
      ? `<div style="font-size:11px;color:#9a3412;font-weight:600;margin-top:6px;line-height:1.4">🔴 ${_esc(_fmtDate(e.surgeryDate))}${e.surgeryTime ? ' · ' + _esc(_fmtTime(e.surgeryTime)) : ''}${e.surgeryCenterName ? ' · ' + _esc(e.surgeryCenterName) : ''}${e.surgeon ? ' · ' + _esc(e.surgeon) : ''}</div>`
      : '';
    let pdfLine = '';
    if(!phiHidden) {
      pdfLine = e.pdfFilename
        ? `<div style="font-size:11px;margin-top:6px"><a href="javascript:void(0)" onclick="window._strViewPDF('${e.id}')" style="color:#1d4ed8;text-decoration:none">📎 ${_esc(e.pdfFilename)}</a> <a href="javascript:void(0)" onclick="window._strRemovePDF('${e.id}')" title="Remove PDF" style="color:var(--warn);text-decoration:none;margin-left:6px">✕</a></div>`
        : `<div style="font-size:11px;margin-top:6px"><a href="javascript:void(0)" onclick="window._strAttachPDF('${e.id}')" style="color:var(--text-faint);text-decoration:none">📎 Attach pre-op PDF</a></div>`;
    } else if(e.pdfFilename) {
      pdfLine = `<div style="font-size:11px;margin-top:6px;color:var(--text-faint)">📎 ${hiddenSpan}</div>`;
    }

    // Pre-Op Visit column — scheduled date stays visible (no PHI), Schedule
    // button is scheduler-only.
    const scheduledCell = e.scheduledAt
      ? `<div style="font-size:12px;color:var(--text)">${_esc(_fmtDate(e.date))}${e.time ? '<br><span style="color:var(--text-faint)">' + _esc(_fmtTime(e.time)) + '</span>' : ''}</div>`
      : (isScheduler
          ? `<button onclick="window._strOpenSchedule('${e.id}')" class="btn btn-primary btn-sm" style="background:#1d3557;border-color:#1d3557;font-size:11px;padding:5px 10px;white-space:nowrap">📅 Schedule</button>`
          : `<div style="font-size:12px;color:var(--text-faint);font-style:italic">Not scheduled yet</div>`);

    const cs = _callStateByKey[e.callStatus || 'none'] || _callStateByKey.none;
    // The call-status pill belongs to Nicole — Jordan sees the current state
    // but can't change it. Render as a non-clickable span when he's viewing.
    const callPill = isAssistant
      ? `<span title="Only Nicole can update this" style="background:${cs.bg};color:${cs.fg};border:1px ${cs.dashed?'dashed':'solid'} ${cs.border};font-size:11px;font-weight:${cs.key==='none'?'600':'700'};padding:4px 10px;border-radius:11px;font-family:inherit;white-space:nowrap;cursor:not-allowed;display:inline-block">${cs.label}</span>`
      : `<button onclick="window._strCycleCallStatus('${e.id}')" style="background:${cs.bg};color:${cs.fg};border:1px ${cs.dashed?'dashed':'solid'} ${cs.border};font-size:11px;font-weight:${cs.key==='none'?'600':'700'};padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit;white-space:nowrap">${cs.label}</button>`;

    // pill helper:
    //   `nicoleOnly`    → read-only for Jordan (his view shows the state but
    //                     can't flip it).
    //   `assistantOnly` → read-only for Nicole (her view shows the state but
    //                     can't flip it). The "Jordan Called" pill uses this.
    //   `readOnlyAll`   → fully display-only for every role. The "Cleared"
    //                     pill uses this — it only flips when Jordan sends
    //                     the final clearance report from his Pre-Op view.
    const pill = (done, onLabel, offLabel, color, toggleFn, nicoleOnly, readOnlyAll, assistantOnly) => {
      const showAsReadOnly = readOnlyAll
        || (nicoleOnly && isAssistant)
        || (assistantOnly && isScheduler);
      const tip = readOnlyAll
        ? "Auto-flips when Jordan submits the final clearance report"
        : (assistantOnly ? "Only Jordan can update this" : "Only Nicole can update this");
      if(showAsReadOnly) {
        return done
          ? `<span title="${tip}" style="background:${color.bg};color:${color.fg};border:1px solid ${color.border};font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block">${onLabel}</span>`
          : `<span title="${tip}" style="background:#fff;color:#64748b;border:1px dashed #cbd5e1;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block">${offLabel}</span>`;
      }
      return done
        ? `<button onclick="${toggleFn}('${e.id}', false)" style="background:${color.bg};color:${color.fg};border:1px solid ${color.border};font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">${onLabel}</button>`
        : `<button onclick="${toggleFn}('${e.id}', true)"  style="background:#fff;color:#64748b;border:1px dashed #cbd5e1;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit">${offLabel}</button>`;
    };
    const green  = { bg:'#dcfce7', fg:'#166534', border:'#86efac' };
    const indigo = { bg:'#e0e7ff', fg:'#3730a3', border:'#a5b4fc' };
    const nurseCalled = !!e.nurseCalledAt;
    const cleared     = !!e.clearedAt;

    const stripe = _stripeStatus[(e.patientEmail||'').toLowerCase()] || {};
    const stripePaid = !!stripe.preopVisitPaid;
    // Phone payments are no longer accepted — the only path to "paid" is the
    // patient completing Stripe checkout from their portal link. Pill is
    // display-only: tapping does nothing because the state can't be changed
    // manually.
    const paidPill = stripePaid
      ? `<span title="Confirmed via Stripe" style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block">✓ Paid · Stripe</span>`
      : `<span title="Awaiting Stripe confirmation — patient pays via the portal link" style="background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block">⏳ Pending</span>`;
    // Manual Nudge button removed — the worker's nightly cron now sends a
    // daily payment-link reminder to every patient who's been emailed the
    // portal link but hasn't paid yet. Stops on its own when Stripe shows
    // paid.
    const nudgePill = '';

    let linkedPreopId = e.preopRecordId || '';
    if(!linkedPreopId) {
      const recs = window._rawPreopRecords || [];
      const match = recs.find(r => r && r['po-preopVisitId'] === e.id);
      if(match) linkedPreopId = match.id;
    }
    const openPreopBtn = (isAssistant && linkedPreopId)
      ? `<button onclick="window._strOpenPreop('${linkedPreopId}')" class="btn btn-ghost btn-sm" title="Open the linked pre-op assessment" style="font-size:11px;padding:3px 7px;color:#1d4ed8;border-color:#bfdbfe">📋 Pre-Op</button>`
      : '';
    // Show patient details button — only on history rows (where PHI is masked).
    const revealCaseId = e.preopCaseId || e.id;
    const revealBtn = (phiHidden && typeof window.phiRevealButtonHTML === 'function')
      ? window.phiRevealButtonHTML(revealCaseId, 'renderSchedulerTracker')
      : '';
    const editBtn = (!phiHidden && isScheduler)
      ? `<button onclick="window._strOpenAddPatient('${e.id}')" class="btn btn-ghost btn-sm" title="Edit patient info" style="font-size:11px;padding:3px 7px">✏</button>`
      : '';
    const delBtn = (!phiHidden && isScheduler)
      ? `<button onclick="window._strDelete('${e.id}')" class="btn btn-ghost btn-sm" title="Delete" style="font-size:11px;color:var(--warn);padding:3px 7px">🗑</button>`
      : '';

    const centerCell = 'display:flex;justify-content:center;align-items:center';
    return `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);align-items:center${phiHidden ? ';opacity:.85' : ''}">
      <div><div style="font-size:14px;font-weight:600;color:var(--text)">${nameHtml}</div>${contactLine}${surgeryLine}${pdfLine}${revealBtn ? '<div style=\"margin-top:8px\">' + revealBtn + '</div>' : ''}</div>
      <div style="display:flex;justify-content:center;align-items:center;text-align:center">${scheduledCell}</div>
      <div style="${centerCell}">${callPill}</div>
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center">${paidPill}${nudgePill}</div>
      <div style="${centerCell}">${pill(nurseCalled, '✓ Call Made', '○ Not yet', green,  'window._strToggleNurseCalled', false, false, true)}</div>
      <div style="${centerCell}">${pill(cleared,     '✓ Cleared',   '○ Pending', indigo, 'window._strToggleCleared', false, true, false)}</div>
      <div style="display:flex;gap:4px;justify-content:center;align-items:center">
        ${openPreopBtn}${editBtn}${delBtn}
      </div>
    </div>`;
  }

  // ── Scheduling Inbox ───────────────────────────────────────────────────────
  // Pre-op clearance PDFs Josh/Dev forward to scheduling@atlasanesthesia.co
  // land in atlas/scheduling_inbox as { items: [{ id, from, subject,
  // receivedAt, pdfFilename, status }] }. The matching PDF is stored as its
  // own doc at atlas/scheduling_inbox_pdf_<id> (keeps each PDF under the
  // Firestore 1 MB per-doc limit).
  //
  // Nicole sees a panel above the Tracker rows showing every pending item.
  // Clicking one opens a split-screen modal — PDF on the left, Add Patient
  // form on the right. Submitting creates a tracker entry, copies the PDF
  // over to preop_visit_pdfs_<entryId>, and marks the inbox item processed.

  function renderInbox() {
    const host = _$('str-inbox');
    if(!host) return;
    const isScheduler = (window._userRole === 'scheduler');
    if(!isScheduler) { host.innerHTML = ''; return; }
    const pending = (_inboxItems || []).filter(i => (i.status || 'pending') === 'pending');
    const rows = pending.map(i => {
      const recv = i.receivedAt ? new Date(i.receivedAt).toLocaleString('en-US', { dateStyle:'short', timeStyle:'short' }) : '';
      const pdfCount = Array.isArray(i.pdfs) ? i.pdfs.length : 0;
      const titleText = pdfCount > 1
        ? (pdfCount + ' PDFs (will combine on open)')
        : (i.pdfFilename || 'attachment.pdf');
      return `<div class="str-inbox-row" onclick="window._strOpenInboxItem('${i.id}')" style="display:grid;grid-template-columns:1fr 200px 90px;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--text)">📎 ${_esc(titleText)}</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:2px">${_esc(i.subject || '')}</div>
        </div>
        <div style="font-size:11px;color:var(--text-faint)"><div>${_esc(i.from || '')}</div><div style="margin-top:2px">${_esc(recv)}</div></div>
        <div style="text-align:right"><button onclick="event.stopPropagation();window._strDeleteInboxItem('${i.id}')" title="Delete this email" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn);padding:3px 8px">🗑</button></div>
      </div>`;
    }).join('');
    // Always render the card for Nicole — even with zero items — so the
    // "+ Test PDF" affordance is reachable and she knows the inbox exists.
    const emptyState = pending.length
      ? ''
      : '<div style="padding:14px 16px;font-size:12px;color:var(--text-faint);font-style:italic;text-align:center">No forms waiting. Forwards from <strong>scheduling@atlasanesthesia.co</strong> show up here.</div>';
    const countLabel = pending.length
      ? `📥 Pending Pre-Op Forms · ${pending.length}`
      : '📥 Pending Pre-Op Forms';
    host.innerHTML = `<div class="card" style="padding:0;overflow:hidden;border-left:4px solid #0369a1">
      <div style="padding:12px 16px;background:#eff6ff;border-bottom:1px solid #bfdbfe;font-size:13px;font-weight:700;color:#0369a1">${countLabel}</div>
      ${rows}${emptyState}
    </div>`;
  }

  // Live subscription to inbox doc — onSnapshot from app.js's Firestore.
  // Wait until window.db / window.onSnapshot are populated (app.js sets these
  // late in its boot) before subscribing.
  function subscribeInbox() {
    if(typeof window.onSnapshot !== 'function' || !window.db) {
      setTimeout(subscribeInbox, 200);
      return;
    }
    try {
      window.onSnapshot(window.doc(window.db, 'atlas', INBOX_DOC_PATH), snap => {
        _inboxItems = snap.exists() ? (snap.data().items || []) : [];
        renderInbox();
      });
    } catch(e) { console.warn('inbox subscribe failed:', e); }
  }
  subscribeInbox();

  window._strDeleteInboxItem = async function(id) {
    if(!confirm('Delete this inbox item?')) return;
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', INBOX_DOC_PATH));
      const data = snap.exists() ? snap.data() : { items: [] };
      data.items = (data.items || []).filter(i => i.id !== id);
      await window.setDoc(window.doc(window.db, 'atlas', INBOX_DOC_PATH), data);
      try { await window.deleteDoc(window.doc(window.db, 'atlas', INBOX_PDF_PREFIX + id)); } catch(_){}
    } catch(e) { alert('Could not delete: ' + e.message); }
  };

  // Click an inbox row → split-screen modal: PDF left, Add Patient form right.
  window._strOpenInboxItem = async function(id) {
    const item = (_inboxItems || []).find(i => i.id === id);
    if(!item) return;
    _currentMergedInboxPdf = null;
    // Figure out which PDF docs to load.
    //   New shape: item.pdfs = [{idx, filename, sizeBytes, chunkCount?}, ...]  →  one head doc + extra chunks per idx.
    //   Legacy:    item.pdfFilename only                                       →  single doc at INBOX_PDF_PREFIX + id.
    const refs = Array.isArray(item.pdfs) && item.pdfs.length
      ? item.pdfs.map(p => ({ basePath: INBOX_PDF_PREFIX + id + '_' + p.idx, filename: p.filename }))
      : [{ basePath: INBOX_PDF_PREFIX + id, filename: item.pdfFilename || 'attachment.pdf' }];
    let parts = [];
    try {
      parts = await Promise.all(refs.map(async r => {
        const head = await window.getDoc(window.doc(window.db, 'atlas', r.basePath));
        if(!head.exists()) return { dataUrl: '', filename: r.filename };
        const d = head.data();
        const chunkCount = d.chunkCount || 1;
        if(chunkCount === 1) return { dataUrl: d.dataUrl || '', filename: d.filename || r.filename };
        // Multi-chunk PDF — fetch the rest and stitch them back together.
        const extra = await Promise.all(
          Array.from({length: chunkCount - 1}, (_, i) =>
            window.getDoc(window.doc(window.db, 'atlas', r.basePath + '_c' + (i + 1)))
          )
        );
        let full = d.dataUrl || '';
        for(const cs of extra) full += (cs.exists() ? (cs.data().dataUrl || '') : '');
        return { dataUrl: full, filename: d.filename || r.filename };
      }));
      parts = parts.filter(p => p.dataUrl);
    } catch(_){}
    if(!parts.length) { alert('Could not load the PDF for this inbox item.'); return; }
    // One PDF — show as-is. Multiple PDFs — merge into a single combined PDF
    // so Jordan sees one document with all pages in order.
    let pdfDataUrl, mergedFilename, mergedSize;
    if(parts.length === 1) {
      pdfDataUrl = parts[0].dataUrl;
      mergedFilename = parts[0].filename;
      mergedSize = Math.round(pdfDataUrl.length * 0.75); // rough base64→bytes
    } else {
      try {
        pdfDataUrl = await _mergePdfs(parts.map(p => p.dataUrl));
      } catch(e) {
        alert('Could not merge the PDFs: ' + e.message);
        return;
      }
      const base = (parts[0].filename || 'preop').replace(/\.pdf$/i, '');
      mergedFilename = base + ' (combined ' + parts.length + ').pdf';
      mergedSize = Math.round(pdfDataUrl.length * 0.75);
    }
    _currentMergedInboxPdf = { dataUrl: pdfDataUrl, filename: mergedFilename, sizeBytes: mergedSize, count: parts.length };

    // Iframes can't render very long data: URLs (browsers cap src length).
    // Convert to a Blob + blob: URL so big merged PDFs still display.
    const _pdfBlobUrl = (function() {
      try {
        const bytes = _dataUrlToBytes(pdfDataUrl);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        return URL.createObjectURL(blob);
      } catch(_) { return pdfDataUrl; }
    })();

    const prior = document.getElementById('strInboxModal');
    if(prior) prior.remove();
    const centers = window.surgeryCenters || [];
    const centerOptions = centers.map(c => `<option value="${_esc(c.id)}">${_esc(c.name)}</option>`).join('');

    const wrap = document.createElement('div');
    wrap.id = 'strInboxModal';
    wrap.dataset.inboxId = id;
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:stretch;justify-content:center;padding:20px';
    wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };

    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:1400px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <div style="background:#1d3557;color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div style="min-width:0">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0">New Patient from Pre-Op Form</div>
          <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📎 ${_esc(mergedFilename)}${parts.length > 1 ? ` <span style="font-weight:400;color:#bcd4ec;font-size:12px">(${parts.length} PDFs merged)</span>` : ''} · ${_esc(item.from || '')}</div>
        </div>
        <button onclick="document.getElementById('strInboxModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;flex-shrink:0">✕</button>
      </div>
      <div class="str-inbox-split" style="display:flex;flex:1;min-height:0;flex-wrap:wrap">
        <div style="flex:1 1 48%;min-width:0;min-height:60vh;background:#525659">
          <iframe src="${_pdfBlobUrl}" style="width:100%;height:100%;border:none;display:block" title="Pre-op PDF"></iframe>
        </div>
        <div style="flex:1 1 52%;min-width:300px;overflow-y:auto;padding:20px 22px;background:var(--surface);max-height:80vh">
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Fill in what you can pull from the form on the left. Required fields are marked <span style="color:var(--warn)">*</span>.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label style="margin-top:0">First name <span style="color:var(--warn)">*</span></label><input type="text" id="strap-first" placeholder="e.g. John"></div>
            <div><label style="margin-top:0">Last name</label><input type="text" id="strap-last" placeholder="e.g. Smith"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label style="margin-top:0">Phone <span style="color:var(--warn)">*</span></label><input type="tel" id="strap-phone" placeholder="(555) 123-4567"></div>
            <div><label style="margin-top:0">Date of birth <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label><input type="date" id="strap-dob"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label style="margin-top:0">PCP <span style="font-weight:400;color:var(--text-faint);font-size:11px">(if any)</span></label><input type="text" id="strap-pcp" placeholder="Dr. Smith"></div>
            <div></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label style="margin-top:0">PCP phone <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label><input type="tel" id="strap-pcp-phone" placeholder="(555) 123-4567"></div>
            <div><label style="margin-top:0">PCP fax <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label><input type="tel" id="strap-pcp-fax" placeholder="(555) 123-4567"></div>
          </div>
          <div style="border:1px solid #fed7aa;background:#fff7ed;border-radius:8px;padding:12px 14px;margin-bottom:14px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9a3412;margin-bottom:8px">Surgery details</div>
            <div style="margin-bottom:10px"><label style="margin-top:0">Surgeon</label><input type="text" id="strap-surgeon" placeholder="Dr. Patel"></div>
            <div style="display:grid;grid-template-columns:1fr 140px;gap:12px;margin-bottom:10px">
              <div><label style="margin-top:0">Surgery date <span style="color:var(--warn)">*</span></label><input type="date" id="strap-surg-date"></div>
              <div><label style="margin-top:0">Start time</label><input type="time" id="strap-surg-time"></div>
            </div>
            <div><label style="margin-top:0">Surgery center</label>${centers.length
              ? `<select id="strap-center"><option value="">— Pick a center —</option>${centerOptions}</select>`
              : `<input type="text" id="strap-center" placeholder="e.g. Bellin Surgery Center">`}</div>
          </div>
          <div id="strap-status" style="font-size:12px;padding:4px 0;min-height:16px"></div>
          <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--border)">
            <button class="btn btn-ghost" onclick="document.getElementById('strInboxModal').remove()">Cancel</button>
            <button class="btn btn-primary" id="strap-save-btn" onclick="window._strSaveInboxPatient()" style="background:#1d3557;border-color:#1d3557">+ Add to Tracker</button>
          </div>
        </div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    // Revoke the blob URL when the modal closes (all close paths land here
    // because they call wrap.remove() — including the X/Cancel buttons via
    // document.getElementById('strInboxModal').remove()).
    const _origRemove = wrap.remove.bind(wrap);
    wrap.remove = function() {
      try { URL.revokeObjectURL(_pdfBlobUrl); } catch(_){}
      _origRemove();
    };
    setTimeout(() => document.getElementById('strap-first')?.focus(), 60);
  };

  // Submit handler for the inbox split-screen modal.
  window._strSaveInboxPatient = async function() {
    const wrap = document.getElementById('strInboxModal');
    if(!wrap) return;
    const inboxId = wrap.dataset.inboxId;
    const first = (_$('strap-first')?.value || '').trim();
    const last  = (_$('strap-last')?.value || '').trim();
    const phone = (_$('strap-phone')?.value || '').trim();
    const dob   = (_$('strap-dob')?.value || '').trim();
    const pcp   = (_$('strap-pcp')?.value || '').trim();
    const pcpPhone = (_$('strap-pcp-phone')?.value || '').trim();
    const pcpFax   = (_$('strap-pcp-fax')?.value   || '').trim();
    const surgeon = (_$('strap-surgeon')?.value || '').trim();
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
      } else { surgeryCenterName = (centerEl.value || '').trim(); }
    }
    const status = _$('strap-status');
    const setError = msg => { if(status) { status.textContent = '✗ ' + msg; status.style.color = '#b91c1c'; } };
    if(!first) { setError('First name is required.'); return; }
    if(!phone) { setError('Phone is required.'); return; }
    if(!surgD) { setError('Surgery date is required.'); return; }

    const btn = _$('strap-save-btn');
    if(btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      if(!_entries.length) await _loadEntries();
      const inboxItem = _inboxItems.find(i => i.id === inboxId);
      // Save the (possibly merged) PDF to the patient's per-entry PDF doc.
      // We use the in-memory merged copy that was created when the modal
      // opened so we don't re-do the merge work here.
      const newEntryId = _uid();
      const merged = _currentMergedInboxPdf;
      const filename = merged?.filename || inboxItem?.pdfFilename || 'preop.pdf';
      if(merged?.dataUrl) {
        await window.setDoc(window.doc(window.db, 'atlas', PDF_DOC_PATH + '.' + newEntryId), {
          filename: merged.filename,
          dataUrl: merged.dataUrl,
          contentType: 'application/pdf',
          sizeBytes: merged.sizeBytes || 0
        });
      }
      const entry = {
        id: newEntryId,
        patientFirst: first, patientLast: last, patientPhone: phone, patientDOB: dob, pcp, pcpPhone, pcpFax, surgeon,
        surgeryDate: surgD, surgeryTime: surgT,
        surgeryCenterId, surgeryCenterName,
        pdfFilename: filename,
        callStatus: 'none',
        addedAt: new Date().toISOString(),
        addedBy: (window.currentUser?.email) || '',
        fromInboxId: inboxId
      };
      _entries.unshift(entry);
      await _saveEntries();
      // Mark inbox item processed and clean up ALL inbox-side PDF docs
      // (legacy single + per-idx for multi-PDF emails).
      try {
        const isnap = await window.getDoc(window.doc(window.db, 'atlas', INBOX_DOC_PATH));
        const idata = isnap.exists() ? isnap.data() : { items: [] };
        idata.items = (idata.items || []).map(i => i.id === inboxId
          ? { ...i, status: 'processed', processedAt: new Date().toISOString(), processedBy: (window.currentUser?.email) || '', linkedEntryId: newEntryId }
          : i);
        await window.setDoc(window.doc(window.db, 'atlas', INBOX_DOC_PATH), idata);
        const paths = [];
        if(Array.isArray(inboxItem?.pdfs) && inboxItem.pdfs.length) {
          for(const p of inboxItem.pdfs) {
            const base = INBOX_PDF_PREFIX + inboxId + '_' + p.idx;
            paths.push(base);
            const cc = p.chunkCount || 1;
            for(let ci = 1; ci < cc; ci++) paths.push(base + '_c' + ci);
          }
        } else {
          paths.push(INBOX_PDF_PREFIX + inboxId);
        }
        for(const p of paths) {
          try { await window.deleteDoc(window.doc(window.db, 'atlas', p)); } catch(_){}
        }
      } catch(e) { console.warn('inbox cleanup failed:', e); }
      _currentMergedInboxPdf = null;
      try { window.logAudit && window.logAudit('preop-visit-from-inbox', newEntryId, first + ' ' + last); } catch(_){}
      wrap.remove();
      window.renderSchedulerTracker();
    } catch(err) {
      setError(err.message || String(err));
      if(btn) { btn.disabled = false; btn.textContent = '+ Add to Tracker'; }
    }
  };

  window.renderSchedulerTracker = async function() {
    renderInbox();
    const body = _$('str-body');
    if(!body) return;
    if(!_entries.length) await _loadEntries();
    if(!_entries.length) {
      body.innerHTML = '<div class="empty-state" style="margin:0;padding:30px"><span class="empty-state-icon">📋</span><div class="empty-state-title">No patients yet</div><div class="empty-state-sub">Click <strong>+ Add Patient</strong> to load one in from the surgery center pre-op sheet.</div></div>';
      return;
    }
    // Once the operation is done (surgery date has passed), the patient
    // drops off Nicole's and Jordan's Tracker entirely. Josh and Dev keep
    // the case in their own Case History tab (atlas/cases), so nothing is
    // lost — just hidden from views that no longer need it.
    const todayIso = new Date().toISOString().split('T')[0];
    const isFinished = e => e.surgeryDate && e.surgeryDate < todayIso;
    const active = _entries.filter(e => !isFinished(e));
    active.sort((a, b) => (a.surgeryDate || '9999-12-31').localeCompare(b.surgeryDate || '9999-12-31'));

    const COLS = '1.6fr 150px 130px 110px 110px 110px 70px';
    // The rightmost column holds Jordan's 📋 Pre-Op button (assistant view)
    // or the scheduler's ✏ edit / 🗑 delete buttons. Only label it "Pre-Op"
    // for Jordan; for Nicole it stays unlabeled so the icons speak for
    // themselves.
    const isAssistantView = (window._userRole === 'assistant');
    const headerRow = `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
      <span>Patient</span><span style="text-align:center">Pre-Op Visit</span><span style="text-align:center">Nicole's Call</span><span style="text-align:center">${isAssistantView ? 'Deposit Paid' : '$100 Paid'}</span><span style="text-align:center">Jordan Called</span><span style="text-align:center">Cleared</span><span style="text-align:center">${isAssistantView ? 'Pre-Op' : ''}</span>
    </div>`;

    let html = '';
    if(active.length) {
      html += headerRow;
      active.forEach(e => { html += _buildTrackerRow(e, COLS, false); });
    } else {
      html += '<div class="empty-state" style="margin:0;padding:30px"><span class="empty-state-icon">📋</span><div class="empty-state-title">No active patients</div><div class="empty-state-sub">Patients drop off this Tracker once their surgery date has passed.</div></div>';
    }
    body.innerHTML = html;
  };

  // History section removed — finished patients drop off the Tracker once
  // their surgery date has passed. Kept as a no-op so any stale onclick
  // from a cached page doesn't throw.
  window._strToggleHistory = function() {};

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
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e3a8a;line-height:1.5">Load the patient from the surgery center's pre-op sheet. You'll schedule their pre-op visit with Jordan, APRN, FNP from this entry once you reach them by phone.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">First name <span style="color:var(--warn)">*</span></label><input type="text" id="strap-first" placeholder="e.g. John" value="${_esc(existing?.patientFirst || '')}"></div>
          <div><label style="margin-top:0">Last name</label><input type="text" id="strap-last" placeholder="e.g. Smith" value="${_esc(existing?.patientLast || '')}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">Phone <span style="color:var(--warn)">*</span></label><input type="tel" id="strap-phone" placeholder="(555) 123-4567" value="${_esc(existing?.patientPhone || '')}"></div>
          <div><label style="margin-top:0">Date of birth <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label><input type="date" id="strap-dob" value="${_esc(existing?.patientDOB || '')}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">PCP <span style="font-weight:400;color:var(--text-faint);font-size:11px">(if any)</span></label><input type="text" id="strap-pcp" placeholder="Dr. Smith" value="${_esc(existing?.pcp || '')}"></div>
          <div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">PCP phone <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label><input type="tel" id="strap-pcp-phone" placeholder="(555) 123-4567" value="${_esc(existing?.pcpPhone || '')}"></div>
          <div><label style="margin-top:0">PCP fax <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label><input type="tel" id="strap-pcp-fax" placeholder="(555) 123-4567" value="${_esc(existing?.pcpFax || '')}"></div>
        </div>
        <div style="border:1px solid #fed7aa;background:#fff7ed;border-radius:8px;padding:12px 14px;margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9a3412;margin-bottom:8px">Surgery details</div>
          <div style="margin-bottom:12px"><label style="margin-top:0">Surgeon <span style="font-weight:400;color:var(--text-faint);font-size:11px">(performing the procedure)</span></label><input type="text" id="strap-surgeon" placeholder="Dr. Patel" value="${_esc(existing?.surgeon || '')}"></div>
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
    const dob   = (_$('strap-dob')?.value || '').trim();
    const pcp   = (_$('strap-pcp')?.value || '').trim();
    const pcpPhone = (_$('strap-pcp-phone')?.value || '').trim();
    const pcpFax   = (_$('strap-pcp-fax')?.value   || '').trim();
    const surgeon = (_$('strap-surgeon')?.value || '').trim();
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
          patientFirst: first, patientLast: last, patientPhone: phone, patientDOB: dob, pcp, pcpPhone, pcpFax, surgeon,
          surgeryDate: surgD, surgeryTime: surgT,
          surgeryCenterId, surgeryCenterName
        });
      } else {
        entry = {
          id: _uid(),
          patientFirst: first, patientLast: last, patientPhone: phone, patientDOB: dob, pcp, pcpPhone, pcpFax, surgeon,
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

  // Manual nudge is removed — the worker's nightly cron now emails every
  // patient who's been sent the portal link but hasn't paid the $100 yet,
  // stopping automatically once Stripe shows paid. Kept as a no-op so any
  // stale onclick handler from a cached page does nothing instead of
  // throwing.
  window._strSendNudge = function() {};

  // Manual paid toggle — for the case when the $100 was collected outside
  // Stripe (e.g. card taken over the phone via a different processor). Stripe-
  // confirmed paid status is read-only from here; this flag is independent.
  // Manual paid toggle is permanently disabled — phone payments are no longer
  // accepted, and Stripe is the only source of truth for the paid pill.
  // Kept as a no-op so any stale onclick handlers (e.g. cached browser
  // pages) silently do nothing instead of throwing.
  window._strToggleManualPaid = function() {};

  // (Earlier "send a scheduling email post-payment" helper removed —
  // Nicole's first email now contains the all-in-one portal link, so the
  // patient doesn't need a separate prompt after payment.)

  // ── Multi-state call pill: none → called → voicemail → failed → none ───────
  window._strCycleCallStatus = async function(id) {
    if(window._userRole === 'assistant') { alert('Only Nicole can update call status.'); return; }
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    const cur = e.callStatus || 'none';
    const keys = CALL_STATES.map(s => s.key);
    const next = keys[(keys.indexOf(cur) + 1) % keys.length];
    e.callStatus = next;
    e.callStatusAt = new Date().toISOString();
    e.callStatusBy = (window.currentUser?.email) || '';
    await _saveEntries();
    // Mirror the new state onto the linked pre-op record so Josh/Dev's
    // Follow-up Tracker shows the same status. Mapping:
    //   none      → 'not-called'
    //   called    → 'spoken'
    //   voicemail → 'voicemail'
    //   failed    → 'no-answer'
    try {
      let preopId = e.preopRecordId || '';
      if(!preopId) {
        const recs = window._rawPreopRecords || [];
        const match = recs.find(r => r && r['po-preopVisitId'] === e.id);
        if(match) preopId = match.id;
      }
      if(preopId && typeof window._updatePreopStatusField === 'function') {
        const mapped = next === 'called'    ? 'spoken'
                     : next === 'voicemail' ? 'voicemail'
                     : next === 'failed'    ? 'no-answer'
                     : 'not-called';
        await window._updatePreopStatusField(preopId, 'po-callStatus', mapped);
      }
    } catch(err) { console.warn('Could not sync call-status to pre-op:', err); }
    try { window.logAudit && window.logAudit('preop-visit-call-status-' + next, id, e.patientFirst + ' ' + e.patientLast); } catch(_){}
    window.renderSchedulerTracker();
  };

  // Jordan made the pre-op clearance call to the patient. Nicole can't
  // flip this pill since it tracks Jordan's outreach, not hers.
  window._strToggleNurseCalled = async function(id, done) {
    if(window._userRole === 'scheduler') { alert('Only Jordan can update this pill.'); return; }
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    if(done) {
      e.nurseCalledAt = new Date().toISOString();
      e.nurseCalledBy = (window.currentUser?.email) || '';
    } else {
      e.nurseCalledAt = null;
      e.nurseCalledBy = null;
    }
    await _saveEntries();
    // Mirror the call status onto the linked pre-op record so Josh/Dev's
    // Follow-up Tracker reflects what Jordan just did. Falls back to a
    // po-preopVisitId lookup for entries that pre-date the preopRecordId
    // stamping.
    try {
      let preopId = e.preopRecordId || '';
      if(!preopId) {
        const recs = window._rawPreopRecords || [];
        const match = recs.find(r => r && r['po-preopVisitId'] === e.id);
        if(match) preopId = match.id;
      }
      if(preopId && typeof window._updatePreopStatusField === 'function') {
        await window._updatePreopStatusField(preopId, 'po-callStatus', done ? 'spoken' : 'not-called');
      }
    } catch(err) { console.warn('Could not sync call-status to pre-op:', err); }
    try { window.logAudit && window.logAudit(done ? 'preop-visit-nurse-called' : 'preop-visit-nurse-uncalled', id, e.patientFirst + ' ' + e.patientLast); } catch(_){}
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

  // Cascade delete — removes the patient from EVERY surface the case touches:
  //   - this Tracker entry (atlas/preop_visits)
  //   - the linked PDF on the entry (atlas/preop_visit_pdfs.<id>)
  //   - the linked pre-op record + draft/finalized case + payments / CS log /
  //     deposits / saved PDFs / payouts, via window._purgeCaseEverywhere
  // So one click in Nicole's view cleans Josh's, Dev's, and Jordan's surfaces
  // at the same time.
  window._strDelete = async function(id) {
    const e = _entries.find(x => x.id === id);
    if(!e) return;
    const label = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '(patient)';
    const linkedCaseId = e.preopCaseId || '';
    const msg = linkedCaseId
      ? `Remove ${label} EVERYWHERE?\n\nThis deletes the Tracker entry plus the linked Pre-Op record, draft / finalized case, payments row, CS log, deposits, saved PDFs, and payouts for ${linkedCaseId}.\n\nThis cannot be undone.`
      : `Remove ${label} from the Tracker?`;
    if(!confirm(msg)) return;
    // Cascade first so a partial failure leaves the Tracker entry behind as
    // a visible breadcrumb rather than orphaning downstream records.
    if(linkedCaseId && typeof window._purgeCaseEverywhere === 'function') {
      try { await window._purgeCaseEverywhere(linkedCaseId); }
      catch(err) { console.warn('cascade purge failed:', err); }
    }
    _entries = _entries.filter(x => x.id !== id);
    try { await window.deleteDoc(window.doc(window.db, 'atlas', PDF_DOC_PATH + '.' + id)); } catch(_){}
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-deleted-cascade', id, label + (linkedCaseId ? ' / ' + linkedCaseId : '')); } catch(e){}
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
          const prevPaid = _stripeStatus[email]?.preopVisitPaid;
          _stripeStatus[email] = {
            preopVisitPaid:   !!data.preopVisitPaid,
            preopVisitPaidAt: data.preopVisitPaidAt || null
          };
          // (Auto "schedule your call" email removed — the patient portal
          // link in Nicole's first email walks them through photos → payment
          // → scheduling, so no separate post-payment trigger is needed.)
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
