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
  const MAX_PDF_BYTES = 8 * 1024 * 1024; // sanity cap; larger-than-1MB PDFs are chunked across docs (_writePdfDoc)

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

  // Wrap a JPG/PNG image data URL into a single-page PDF sized to the
  // image's own dimensions. Used when a sender attached a photo of a
  // pre-op form as an image — we still want it to open as a PDF so the
  // rest of the tracker's PDF flow (view / merge / save) works uniformly.
  async function _imageToPdf(imageDataUrl) {
    await _ensurePdfLib();
    const { PDFDocument } = window.PDFLib;
    const bytes = _dataUrlToBytes(imageDataUrl);
    const doc = await PDFDocument.create();
    const isPng = /^data:image\/png/i.test(imageDataUrl) ||
      (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47);
    let img;
    if(isPng) img = await doc.embedPng(bytes);
    else      img = await doc.embedJpg(bytes);
    // Page sized to image, with a small margin so it doesn't touch the edge.
    const margin = 24;
    const page = doc.addPage([img.width + margin * 2, img.height + margin * 2]);
    page.drawImage(img, { x: margin, y: margin, width: img.width, height: img.height });
    const out = await doc.save();
    let bin = '';
    const chunk = 0x8000;
    for(let i = 0; i < out.length; i += chunk) {
      bin += String.fromCharCode.apply(null, out.subarray(i, i + chunk));
    }
    return 'data:application/pdf;base64,' + btoa(bin);
  }

  // Auto-detect: if the data URL is an image, wrap it in a single-page PDF.
  // If it's already a PDF (or content looks like PDF bytes), return as-is.
  async function _ensurePdfDataUrl(dataUrl) {
    if(!dataUrl) return dataUrl;
    const isImage = /^data:image\//i.test(dataUrl);
    if(!isImage) return dataUrl;
    try { return await _imageToPdf(dataUrl); }
    catch(e) { console.warn('image → pdf conversion failed, using original:', e); return dataUrl; }
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
    const _canceledNow = !!e.canceledAt;
    const nameText = _esc([e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '—');
    const canceledBadge = _canceledNow
      ? `<span title="${_esc(e.canceledReason || 'Canceled')}" style="display:inline-block;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;font-size:9px;font-weight:700;padding:2px 7px;border-radius:9px;margin-left:8px;letter-spacing:.4px;text-transform:uppercase">✕ Canceled</span>`
      : '';
    const nameHtml = phiHidden
      ? hiddenSpan
      : (_canceledNow
          ? `<span style="text-decoration:line-through;color:var(--text-muted)">${nameText}</span>${canceledBadge}`
          : nameText);
    let contactParts = [];
    if(!phiHidden) {
      if(e.patientPhone) contactParts.push('📞 ' + _esc(e.patientPhone));
      if(e.patientEmail) contactParts.push('<span style="font-family:monospace">' + _esc(e.patientEmail) + '</span>');
      if(e.pcp)          contactParts.push('🩺 ' + _esc(e.pcp));
    }
    const contactLine = contactParts.length
      ? `<div style="font-size:11px;color:var(--text-faint);margin-top:5px;line-height:1.5">${contactParts.join('<span style="color:#cbd5e1;margin:0 6px">·</span>')}</div>`
      : '';
    const _centerDisplay = e.surgeryCenterName
      ? _esc(e.surgeryCenterName) + (e.surgeryCenterLocation ? ' (' + _esc(e.surgeryCenterLocation) + ')' : '')
      : '';
    const surgeryLine = e.surgeryDate
      ? `<div style="font-size:11px;color:#9a3412;font-weight:600;margin-top:6px;line-height:1.4">🔴 ${_esc(_fmtDate(e.surgeryDate))}${e.surgeryTime ? ' · ' + _esc(_fmtTime(e.surgeryTime)) : ''}${_centerDisplay ? ' · ' + _centerDisplay : ''}${e.surgeon ? ' · ' + _esc(e.surgeon) : ''}${e.estimatedDuration ? ' · ⏱ ' + _esc(e.estimatedDuration) : ''}</div>`
      : '';
    let pdfLine = '';
    if(!phiHidden) {
      pdfLine = e.pdfFilename
        ? `<div style="font-size:11px;margin-top:6px"><a href="javascript:void(0)" onclick="window._strViewPDF('${e.id}')" style="color:#1d4ed8;text-decoration:none">📎 ${_esc(e.pdfFilename)}</a> <a href="javascript:void(0)" onclick="window._strRemovePDF('${e.id}')" title="Remove PDF" style="color:var(--warn);text-decoration:none;margin-left:6px">✕</a></div>`
        : `<div style="font-size:11px;margin-top:6px"><a href="javascript:void(0)" onclick="window._strAttachPDF('${e.id}')" style="color:var(--text-faint);text-decoration:none">📎 Attach pre-op PDF</a></div>`;
    } else if(e.pdfFilename) {
      pdfLine = `<div style="font-size:11px;margin-top:6px;color:var(--text-faint)">📎 ${hiddenSpan}</div>`;
    }

    // Pre-Op Visit column. Three possible states:
    //   1) Patient has picked a time in the portal → show date + time.
    //   2) Nicole hit "Book & Send Confirmation" (callStatus=called) but the
    //      patient hasn't picked a time yet → show "📧 Email sent" so Nicole
    //      knows the portal link is out and she doesn't need to hit
    //      Schedule again.
    //   3) Not touched yet → show the Schedule button (Nicole) or a
    //      "Not scheduled yet" placeholder (everyone else).
    const _emailSent = e.callStatus === 'called' || !!e.callStatusAt;
    const _sentDate = e.callStatusAt ? new Date(e.callStatusAt).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
    const scheduledCell = e.scheduledAt
      ? `<div style="font-size:12px;color:var(--text)">${_esc(_fmtDate(e.date))}${e.time ? '<br><span style="color:var(--text-faint)">' + _esc(_fmtTime(e.time)) + '</span>' : ''}</div>`
      : (_emailSent
          ? `<div style="font-size:12px;color:#166534;font-weight:600" title="Portal link emailed${_sentDate ? ' on ' + _sentDate : ''} — waiting for the patient to pick a time.">📧 Email sent${_sentDate ? '<br><span style=\"font-size:10px;color:var(--text-faint);font-weight:400\">' + _esc(_sentDate) + '</span>' : ''}</div>`
          : (isScheduler
              ? `<button onclick="window._strOpenSchedule('${e.id}')" class="btn btn-primary btn-sm" style="background:#1d3557;border-color:#1d3557;font-size:11px;padding:5px 10px;white-space:nowrap">📅 Schedule</button>`
              : `<div style="font-size:12px;color:var(--text-faint);font-style:italic">Not scheduled yet</div>`));

    const cs = _callStateByKey[e.callStatus || 'none'] || _callStateByKey.none;
    // The call-status pill belongs to Nicole — Jordan sees the current state
    // but can't change it. Render as a non-clickable span when he's viewing.
    const callPill = isAssistant
      ? `<span title="Only Shannon can update this" style="background:${cs.bg};color:${cs.fg};border:1px ${cs.dashed?'dashed':'solid'} ${cs.border};font-size:11px;font-weight:${cs.key==='none'?'600':'700'};padding:4px 10px;border-radius:11px;font-family:inherit;white-space:nowrap;cursor:not-allowed;display:inline-block">${cs.label}</span>`
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
        : (assistantOnly ? "Only Jordan can update this" : "Only Shannon can update this");
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
    // 4-state clearance pill — pending → faxed → waiting → cleared → pending.
    // Backward compat: a legacy entry with clearedAt but no clearedStatus
    // shows as "cleared". Auto-flips to "cleared" when Jordan submits the
    // final clearance report via _strToggleCleared.
    const clearedKey = e.clearedStatus || (e.clearedAt ? 'cleared' : '');
    const clearedStates = {
      '':        { label: '○ Pending',               bg: '#fff',    fg: '#64748b', border: '#cbd5e1', dashed: true,  weight: 600 },
      'faxed':   { label: '📠 Faxed',                bg: '#ffedd5', fg: '#9a3412', border: '#fed7aa', dashed: false, weight: 700 },
      'waiting': { label: '⏳ Waiting for records',  bg: '#fef3c7', fg: '#92400e', border: '#fde68a', dashed: false, weight: 700 },
      'cleared': { label: '✓ Cleared',               bg: '#e0e7ff', fg: '#3730a3', border: '#a5b4fc', dashed: false, weight: 700 }
    };
    const cks = clearedStates[clearedKey] || clearedStates[''];
    const clearedTip = isAssistant ? 'Tap to cycle: Pending → Faxed → Waiting → Cleared' : 'Jordan updates this';
    const clearedPill = isAssistant
      ? `<button onclick="window._strCycleClearedStatus('${e.id}')" title="${clearedTip}" style="background:${cks.bg};color:${cks.fg};border:1px ${cks.dashed?'dashed':'solid'} ${cks.border};font-size:11px;font-weight:${cks.weight};padding:4px 10px;border-radius:11px;cursor:pointer;font-family:inherit;white-space:nowrap">${cks.label}</button>`
      : `<span title="${clearedTip}" style="background:${cks.bg};color:${cks.fg};border:1px ${cks.dashed?'dashed':'solid'} ${cks.border};font-size:11px;font-weight:${cks.weight};padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block;white-space:nowrap">${cks.label}</span>`;

    const stripe = _stripeStatus[(e.patientEmail||'').toLowerCase()] || {};
    const stripePaid = !!stripe.preopVisitPaid;
    const manualPaid = !!e.manualPaidAt;
    // Pill is DISPLAY-ONLY. Stripe is the source of truth; everything here is
    // a read of state, not a button. The manual override lives in a hidden
    // panel that opens when staff triple-click the "Pre-Op Visit Tracker"
    // heading at the top of the tab — see _strOpenOverridePanel below.
    let paidPill;
    if(stripePaid) {
      paidPill = `<span title="Confirmed via Stripe" style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block">✓ Paid · Stripe</span>`;
    } else if(manualPaid) {
      const by = e.manualPaidBy ? ' by ' + _esc(e.manualPaidBy) : '';
      paidPill = `<span title="Marked paid manually${by}. Use the override panel to undo." style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block">✓ Paid · Manual</span>`;
    } else {
      paidPill = `<span title="Awaiting Stripe confirmation — patient pays via the portal link" style="background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;font-size:11px;font-weight:600;padding:4px 10px;border-radius:11px;font-family:inherit;cursor:default;display:inline-block">⏳ Pending</span>`;
    }
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
    // Show patient details button — only on history rows (where PHI is masked).
    const revealCaseId = e.preopCaseId || e.id;
    const revealBtn = (phiHidden && typeof window.phiRevealButtonHTML === 'function')
      ? window.phiRevealButtonHTML(revealCaseId, 'renderSchedulerTracker')
      : '';
    // ── Row actions: one primary button + a "⋯" menu with everything else ──
    // Previously each row had 5–8 stacked buttons which read as clutter. Now
    // the row shows only the primary action for the current role, and the
    // rest live inside a single popup menu that opens next to a "⋯" button.
    const isCanceled = !!e.canceledAt;
    const remindersOff = !!e.remindersDisabledAt;
    const recordsFaxSent = !!e.pcpRecordsFaxSentAt;
    // Primary action per role.
    let primaryBtn = '';
    if(!phiHidden) {
      if(isAssistant) {
        // Jordan's primary action is ALWAYS 📋 Pre-Op — regardless of
        // whether the portal email went out, deposit was paid, or the
        // patient scheduled a time. If a linked Pre-Op record already
        // exists, jump straight to it; otherwise auto-create one on the
        // fly and then open it. Emergency quick-turn workflow.
        primaryBtn = linkedPreopId
          ? `<button onclick="window._strOpenPreop('${linkedPreopId}')" class="btn btn-ghost btn-sm" title="Open the linked pre-op assessment" style="font-size:11px;padding:4px 9px;color:#1d4ed8;border-color:#bfdbfe">📋 Pre-Op</button>`
          : `<button onclick="window._strOpenOrCreatePreop('${e.id}')" class="btn btn-ghost btn-sm" title="Create + open pre-op for this patient" style="font-size:11px;padding:4px 9px;color:#1d4ed8;border-color:#bfdbfe">📋 Pre-Op</button>`;
      } else if(isScheduler) {
        primaryBtn = `<button onclick="window._strOpenAddPatient('${e.id}')" class="btn btn-ghost btn-sm" title="Edit patient info" style="font-size:11px;padding:4px 9px">✏ Edit</button>`;
      }
    }
    // Secondary items — one array of {label, onclick, color, hide?}.
    const menuItems = [];
    if(!phiHidden && isAssistant) {
      menuItems.push({ label: '👁 Open Patient Portal',
        onclick: `window.open('schedule.html?t=' + encodeURIComponent('${e.id}'), '_blank')`,
        color: '#7c3aed' });
    }
    if(!phiHidden && isScheduler && e.pcpFax) {
      menuItems.push({
        label: recordsFaxSent
          ? '📠 Records — sent ' + new Date(e.pcpRecordsFaxSentAt).toLocaleDateString() + ' (resend)'
          : '📠 Fax Records Request to PCP',
        onclick: `window._strOpenRecordsFax('${e.id}')`,
        color: recordsFaxSent ? '#166534' : '#0369a1' });
    }
    if(!phiHidden && (isScheduler || isAssistant) && !isCanceled) {
      menuItems.push({
        label: remindersOff ? '🔔 Resume reminder emails' : '🔕 Called Directly — stop reminders',
        onclick: `window._strToggleRemindersDisabled('${e.id}')`,
        color: remindersOff ? '#166534' : '#a16207' });
    }
    // Undo Email Sent — reverts the "📧 Email sent" state back to the
    // Schedule button if Shannon hit Book & Send by accident. Only offered
    // when the flag IS set AND the patient hasn't scheduled yet. Doesn't
    // recall the email that already went out (impossible), just resets
    // the UI state on the row.
    const _emailSentInRow = e.callStatus === 'called' || !!e.callStatusAt;
    if(!phiHidden && isScheduler && !isCanceled && _emailSentInRow && !e.scheduledAt) {
      menuItems.push({
        label: '↶ Undo "Email sent"',
        onclick: `window._strUndoEmailSent('${e.id}')`,
        color: '#0369a1' });
    }
    if(!phiHidden && (isScheduler || isAssistant) && !isCanceled) {
      menuItems.push({
        label: '✕ Mark Canceled',
        onclick: `window._strMarkCanceled('${e.id}')`,
        color: '#dc2626' });
    }
    if(!phiHidden && (isScheduler || isAssistant) && isCanceled) {
      menuItems.push({
        label: '↶ Uncancel',
        onclick: `window._strUncancel('${e.id}')`,
        color: '#475569' });
    }
    if(!phiHidden && isScheduler) {
      menuItems.push({
        label: '🗑 Delete patient',
        onclick: `window._strDelete('${e.id}')`,
        color: '#b91c1c', divider: true });
    }
    const menuHtml = menuItems.length ? `
      <div style="position:relative;display:inline-block">
        <button onclick="event.stopPropagation();window._strToggleRowMenu('${e.id}')" class="btn btn-ghost btn-sm" title="More actions" style="font-size:14px;padding:4px 8px;line-height:1;font-weight:700">⋯</button>
        <div id="strRowMenu-${e.id}" style="display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:100;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:5px 0;text-align:left">
          ${menuItems.map(it => (it.divider ? '<div style="border-top:1px solid var(--border);margin:4px 0"></div>' : '') +
            `<button onclick="document.getElementById('strRowMenu-${e.id}').style.display='none';${it.onclick}" style="display:block;width:100%;text-align:left;padding:8px 14px;font-size:12px;background:transparent;border:none;cursor:pointer;color:${it.color};font-family:inherit" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">${it.label}</button>`
          ).join('')}
        </div>
      </div>` : '';

    const centerCell = 'display:flex;justify-content:center;align-items:center';
    return `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);align-items:center${phiHidden ? ';opacity:.85' : ''}">
      <div><div style="font-size:14px;font-weight:600;color:var(--text)">${nameHtml}</div>${contactLine}${surgeryLine}${pdfLine}${revealBtn ? '<div style=\"margin-top:8px\">' + revealBtn + '</div>' : ''}</div>
      <div style="display:flex;justify-content:center;align-items:center;text-align:center">${scheduledCell}</div>
      <div style="${centerCell}">${callPill}</div>
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center">${paidPill}${nudgePill}</div>
      <div style="${centerCell}">${pill(nurseCalled, '✓ Call Made', '○ Not yet', green,  'window._strToggleNurseCalled', false, false, true)}</div>
      <div style="${centerCell}">${clearedPill}</div>
      <div style="display:flex;gap:6px;justify-content:center;align-items:center">
        ${primaryBtn}${menuHtml}
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
    // Any part that arrived as an image (JPG/PNG) gets wrapped into a
    // single-page PDF on the fly so downstream flow doesn't care whether
    // the sender attached a scan or a photo.
    parts = await Promise.all(parts.map(async p => ({
      dataUrl:  await _ensurePdfDataUrl(p.dataUrl),
      filename: (p.filename || 'attachment').replace(/\.(jpg|jpeg|png|heic)$/i, '.pdf')
    })));
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
            <div><label style="margin-top:0">Date of birth <span style="color:var(--warn)">*</span></label><input type="date" id="strap-dob"></div>
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
    if(!dob)   { setError('Date of birth is required.'); return; }
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
        await _writePdfDoc(PDF_DOC_PATH + '.' + newEntryId, {
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

    const COLS = '1.6fr 150px 130px 110px 110px 160px 70px';
    // The rightmost column holds Jordan's 📋 Pre-Op button (assistant view)
    // or the scheduler's ✏ edit / 🗑 delete buttons. Only label it "Pre-Op"
    // for Jordan; for Nicole it stays unlabeled so the icons speak for
    // themselves.
    const isAssistantView = (window._userRole === 'assistant');
    const headerRow = `<div style="display:grid;grid-template-columns:${COLS};gap:8px;padding:12px 14px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
      <span>Patient</span><span style="text-align:center">Pre-Op Visit</span><span style="text-align:center">Shannon's Call</span><span style="text-align:center">${isAssistantView ? 'Deposit Paid' : '$100 Paid'}</span><span style="text-align:center">Jordan Called</span><span style="text-align:center">Cleared</span><span style="text-align:center">${isAssistantView ? 'Pre-Op' : ''}</span>
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

    // For edit mode with a PDF attached, load the PDF and turn it into a
    // blob: URL so the iframe can render it without choking on a huge
    // data: URL. Falls back to single-column if no PDF.
    let pdfBlobUrl = '';
    if(isEdit && existing.pdfFilename) {
      try {
        // Use the chunk-aware reader. The old path read just the head doc's
        // dataUrl and decoded that — fine for tiny PDFs but for anything
        // chunked (>700KB) it produced a truncated blob and the iframe
        // failed with "Failed to load PDF".
        const data = await _readPdfDoc(PDF_DOC_PATH + '.' + existing.id);
        const url = data?.dataUrl || '';
        if(url) {
          const i = url.indexOf(',');
          const b64 = i >= 0 ? url.slice(i + 1) : url;
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for(let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
          const blob = new Blob([arr], { type: data.contentType || 'application/pdf' });
          pdfBlobUrl = URL.createObjectURL(blob);
        }
      } catch(_){}
    }
    const splitScreen = !!pdfBlobUrl;

    const wrap = document.createElement('div');
    wrap.id = 'strAddPatientModal';
    wrap.dataset.editId = editId || '';
    wrap.style.cssText = splitScreen
      ? 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:stretch;justify-content:center;padding:20px'
      : 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };

    // Build the surgery-center dropdown from window.surgeryCenters; fall back
    // to a free-text input if the list isn't loaded yet.
    const centers = window.surgeryCenters || [];
    const centerOptions = centers.map(c => `<option value="${_esc(c.id)}"${existing && existing.surgeryCenterId === c.id ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');
    // Surgeon autocomplete — dedupe from previously-entered entries so Shannon
    // can pick a returning surgeon instead of retyping.
    const surgeonHistory = Array.from(new Set(
      (_entries || []).map(e => (e.surgeon || '').trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
    const surgeonDatalist = surgeonHistory.map(s => `<option value="${_esc(s)}"></option>`).join('');
    // Sub-locations for centers that operate multiple physical offices under
    // one name. Matched by case-insensitive substring on the center name.
    const CENTER_SUBLOCATIONS = { 'bay oral': ['West', 'East'] };
    const _initialCenterId = existing?.surgeryCenterId || '';
    const _initialCenterName = (_initialCenterId && centers.find(c => c.id === _initialCenterId)?.name) || existing?.surgeryCenterName || '';
    const _initialSubs = (() => {
      const n = (_initialCenterName || '').toLowerCase();
      for(const key in CENTER_SUBLOCATIONS) if(n.includes(key)) return CENTER_SUBLOCATIONS[key];
      return null;
    })();
    const subLocValue = existing?.surgeryCenterLocation || '';
    // Estimated case time options
    const DURATION_OPTS = ['30 min','45 min','1 hr','1.5 hr','2 hr','2.5 hr','3 hr','3.5 hr','4 hr'];
    const durValue = existing?.estimatedDuration || '';

    const formInner = `
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e3a8a;line-height:1.5">${isEdit ? 'Edit the patient\'s details. Anything you change here flows into the auto-created Pre-Op record on the next save.' : 'Load the patient from the surgery center\'s pre-op sheet. You\'ll schedule their pre-op visit with Jordan, APRN, FNP from this entry once you reach them by phone.'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">First name <span style="color:var(--warn)">*</span></label><input type="text" id="strap-first" placeholder="e.g. John" value="${_esc(existing?.patientFirst || '')}"></div>
          <div><label style="margin-top:0">Last name</label><input type="text" id="strap-last" placeholder="e.g. Smith" value="${_esc(existing?.patientLast || '')}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">Phone <span style="color:var(--warn)">*</span></label><input type="tel" id="strap-phone" placeholder="(555) 123-4567" value="${_esc(existing?.patientPhone || '')}"></div>
          <div><label style="margin-top:0">Date of birth <span style="color:var(--warn)">*</span></label><input type="date" id="strap-dob" value="${_esc(existing?.patientDOB || '')}"></div>
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
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9a3412;margin-bottom:4px">Schedule surgery</div>
          <div style="font-size:11px;color:#9a3412;margin-bottom:10px">These fields feed the Pre-Op record and every other place surgery info is used.</div>
          <div style="margin-bottom:12px"><label style="margin-top:0">Surgeon <span style="font-weight:400;color:var(--text-faint);font-size:11px">(performing the procedure)</span></label><input type="text" id="strap-surgeon" list="strap-surgeon-history" placeholder="Dr. Patel" value="${_esc(existing?.surgeon || '')}" autocomplete="off"><datalist id="strap-surgeon-history">${surgeonDatalist}</datalist></div>
          <div style="display:grid;grid-template-columns:1fr 140px;gap:14px;margin-bottom:12px">
            <div><label style="margin-top:0">Surgery date <span style="color:var(--warn)">*</span></label><input type="date" id="strap-surg-date" value="${_esc(existing?.surgeryDate || '')}"></div>
            <div><label style="margin-top:0">Start time</label><input type="time" id="strap-surg-time" value="${_esc(existing?.surgeryTime || '')}"></div>
          </div>
          <div style="margin-bottom:12px"><label style="margin-top:0">Estimated case time <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label>
            <select id="strap-duration">
              <option value="">— Not set —</option>
              ${DURATION_OPTS.map(opt => `<option value="${_esc(opt)}"${durValue === opt ? ' selected' : ''}>${_esc(opt)}</option>`).join('')}
              ${durValue && !DURATION_OPTS.includes(durValue) ? `<option value="${_esc(durValue)}" selected>${_esc(durValue)}</option>` : ''}
            </select>
          </div>
          <div style="margin-bottom:12px"><label style="margin-top:0">Surgery center</label>${centers.length
            ? `<select id="strap-center" onchange="window._strApplyCenterSubloc && window._strApplyCenterSubloc()"><option value="">— Pick a center —</option>${centerOptions}</select>`
            : `<input type="text" id="strap-center" placeholder="e.g. Bellin Surgery Center" value="${_esc(existing?.surgeryCenterName || '')}">`}</div>
          <div id="strap-subloc-wrap" style="display:${_initialSubs ? 'block' : 'none'}">
            <label style="margin-top:0">Location <span style="font-weight:400;color:var(--text-faint);font-size:11px">(which office)</span></label>
            <select id="strap-subloc">
              <option value="">— Pick a location —</option>
              ${(_initialSubs || []).map(l => `<option value="${_esc(l)}"${subLocValue === l ? ' selected' : ''}>${_esc(l)}</option>`).join('')}
            </select>
          </div>
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
        </div>`;

    if(splitScreen) {
      wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:1400px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)">
        <div style="background:#1d3557;color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div style="min-width:0">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0">Edit Patient (with attached pre-op PDF)</div>
            <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📎 ${_esc(existing.pdfFilename || 'attachment.pdf')}</div>
          </div>
          <button onclick="document.getElementById('strAddPatientModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;flex-shrink:0">✕</button>
        </div>
        <div class="str-edit-split" style="display:flex;flex:1;min-height:0;flex-wrap:wrap">
          <div style="flex:1 1 48%;min-width:0;min-height:60vh;background:#525659">
            <iframe src="${pdfBlobUrl}" style="width:100%;height:100%;border:none;display:block" title="Pre-op PDF"></iframe>
          </div>
          <div style="flex:1 1 52%;min-width:300px;overflow-y:auto;padding:20px 22px;background:var(--surface);max-height:90vh">
            ${formInner}
          </div>
        </div>
      </div>`;
      // Revoke the blob URL when the modal closes (any path → wrap.remove()).
      const _origRemove = wrap.remove.bind(wrap);
      wrap.remove = function() {
        try { URL.revokeObjectURL(pdfBlobUrl); } catch(_){}
        _origRemove();
      };
    } else {
      wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:560px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
        <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
          <div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">${isEdit ? 'Edit' : 'Add'}</div><div style="font-size:16px;font-weight:600">${isEdit ? 'Patient details' : 'New patient'}</div></div>
          <button onclick="document.getElementById('strAddPatientModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button>
        </div>
        <div style="padding:20px 22px">
          ${formInner}
        </div>
      </div>`;
    }
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

  // Firestore caps a single string field at ~1 MB (1,048,487 bytes). A merged
  // multi-page pre-op PDF (base64) routinely blows past that, which is what was
  // throwing "the value of property 'dataUrl' is longer than 1048487 bytes" when
  // Nicole added a patient. So we split the data URL across a head doc plus
  // numbered chunk docs (docId, docId_c1, docId_c2, …); the head records
  // chunkCount and readers stitch the pieces back together. This matches the
  // chunk shape the inbox reader (_strOpenInboxItem) already understands.
  const PDF_CHUNK_CHARS = 700000; // comfortably under the 1 MB per-field limit

  async function _writePdfDoc(docId, { filename, dataUrl, contentType, sizeBytes }) {
    const url = dataUrl || '';
    const chunks = [];
    for(let i = 0; i < url.length; i += PDF_CHUNK_CHARS) chunks.push(url.slice(i, i + PDF_CHUNK_CHARS));
    if(!chunks.length) chunks.push('');
    await window.setDoc(window.doc(window.db, 'atlas', docId), {
      filename: filename || 'preop.pdf',
      contentType: contentType || 'application/pdf',
      sizeBytes: sizeBytes || 0,
      chunkCount: chunks.length,
      dataUrl: chunks[0]
    });
    for(let i = 1; i < chunks.length; i++) {
      await window.setDoc(window.doc(window.db, 'atlas', docId + '_c' + i), { dataUrl: chunks[i] });
    }
    return chunks.length;
  }

  async function _readPdfDoc(docId) {
    const head = await window.getDoc(window.doc(window.db, 'atlas', docId));
    if(!head.exists()) return null;
    const d = head.data();
    const chunkCount = d.chunkCount || 1;
    let full = d.dataUrl || '';
    if(chunkCount > 1) {
      const extra = await Promise.all(
        Array.from({ length: chunkCount - 1 }, (_, i) =>
          window.getDoc(window.doc(window.db, 'atlas', docId + '_c' + (i + 1))))
      );
      for(const cs of extra) full += (cs.exists() ? (cs.data().dataUrl || '') : '');
    }
    return { filename: d.filename, dataUrl: full, contentType: d.contentType, sizeBytes: d.sizeBytes, chunkCount };
  }

  // Delete a chunked PDF doc and any extra chunk docs it spilled into.
  async function _deletePdfDoc(docId) {
    let chunkCount = 1;
    try {
      const head = await window.getDoc(window.doc(window.db, 'atlas', docId));
      if(head.exists()) chunkCount = head.data().chunkCount || 1;
    } catch(_){}
    try { await window.deleteDoc(window.doc(window.db, 'atlas', docId)); } catch(_){}
    for(let i = 1; i < chunkCount; i++) {
      try { await window.deleteDoc(window.doc(window.db, 'atlas', docId + '_c' + i)); } catch(_){}
    }
  }

  // Sub-locations for centers that operate multiple physical offices under
  // one name. Kept in sync with the map in _strOpenAddPatient's form builder.
  const _STR_CENTER_SUBLOCATIONS = { 'bay oral': ['West', 'East'] };
  function _strSubLocsForCenterName(name) {
    const n = (name || '').toLowerCase();
    for(const key in _STR_CENTER_SUBLOCATIONS) if(n.includes(key)) return _STR_CENTER_SUBLOCATIONS[key];
    return null;
  }
  // Called when Shannon picks a different center — show/hide the sub-location
  // dropdown and swap in the right options.
  window._strApplyCenterSubloc = function() {
    const centerEl = document.getElementById('strap-center');
    const wrap     = document.getElementById('strap-subloc-wrap');
    const sel      = document.getElementById('strap-subloc');
    if(!centerEl || !wrap || !sel) return;
    let name = '';
    if(centerEl.tagName === 'SELECT') {
      const c = (window.surgeryCenters || []).find(x => x.id === centerEl.value);
      name = c ? c.name : '';
    } else { name = centerEl.value || ''; }
    const subs = _strSubLocsForCenterName(name);
    if(subs && subs.length) {
      sel.innerHTML = '<option value="">— Pick a location —</option>' +
        subs.map(l => `<option value="${l}">${l}</option>`).join('');
      wrap.style.display = 'block';
    } else {
      sel.innerHTML = '<option value=""></option>';
      wrap.style.display = 'none';
    }
  };

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
    const estimatedDuration = (_$('strap-duration')?.value || '').trim();
    const surgeryCenterLocation = (_$('strap-subloc')?.value || '').trim();
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
    if(!dob)   { setError('Date of birth is required.'); return; }
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
      let priorEntry = null;
      if(editId) {
        const idx = _entries.findIndex(e => e.id === editId);
        if(idx === -1) throw new Error('Entry not found');
        priorEntry = { ..._entries[idx] };  // snapshot before mutation
        entry = _entries[idx];
        Object.assign(entry, {
          patientFirst: first, patientLast: last, patientPhone: phone, patientDOB: dob, pcp, pcpPhone, pcpFax, surgeon,
          surgeryDate: surgD, surgeryTime: surgT,
          surgeryCenterId, surgeryCenterName, surgeryCenterLocation,
          estimatedDuration
        });
      } else {
        entry = {
          id: _uid(),
          patientFirst: first, patientLast: last, patientPhone: phone, patientDOB: dob, pcp, pcpPhone, pcpFax, surgeon,
          surgeryDate: surgD, surgeryTime: surgT,
          surgeryCenterId, surgeryCenterName, surgeryCenterLocation,
          estimatedDuration,
          callStatus: 'none',
          addedAt: new Date().toISOString(),
          addedBy: (window.currentUser?.email) || ''
        };
        _entries.unshift(entry);
      }
      // Upload PDF first so its filename can be stamped on the entry.
      if(file) {
        const dataUrl = await _readFileAsDataUrl(file);
        await _writePdfDoc(PDF_DOC_PATH + '.' + entry.id, {
          filename: file.name, dataUrl, contentType: file.type, sizeBytes: file.size
        });
        entry.pdfFilename = file.name;
      }
      await _saveEntries();
      // Auto-generate a Pre-Op record so Jordan can see and start on the
      // patient right away. Previously this only happened when Nicole hit
      // "Book & Send Confirmation" from the Schedule modal — meaning
      // patients who hadn't hit that step yet were invisible to Jordan.
      // Only fire on NEW entries (not edits) so we don't create duplicates.
      if(!editId && typeof window._ensurePreopForEntry === 'function') {
        try { await window._ensurePreopForEntry(entry); }
        catch(err) { console.warn('Pre-Op auto-create at Add Patient failed:', err); }
      }
      // If this entry has a linked pre-op record (created when Nicole sent
      // the portal email), patch the Nicole-owned fields on it too so
      // Jordan / Josh / Dev see the freshest patient / PCP / surgery info
      // without having to retype. Jordan's clinical fields aren't touched.
      if(editId) {
        try {
          const preopSnap = await window.getDoc(window.doc(window.db, 'atlas', 'preop'));
          if(preopSnap.exists()) {
            const records = preopSnap.data().records || [];
            // Find the linked pre-op record. Three fallbacks (most → least
            // specific) so the patch works even if entry.preopRecordId was
            // never stamped (older entries) or got dropped somehow:
            //   1) record.id === entry.preopRecordId   (direct pointer)
            //   2) record['po-preopVisitId'] === entry.id  (back-pointer)
            //   3) record['po-caseId'] === entry.preopCaseId  (case id)
            let idx = entry.preopRecordId
              ? records.findIndex(r => r && r.id === entry.preopRecordId)
              : -1;
            if(idx === -1) {
              idx = records.findIndex(r => r && r['po-preopVisitId'] === entry.id);
            }
            if(idx === -1 && entry.preopCaseId) {
              idx = records.findIndex(r => r && r['po-caseId'] === entry.preopCaseId);
            }
            if(idx !== -1) {
              const rec = records[idx];
              rec['po-patientFirstName'] = first;
              rec['po-patientLastName']  = last;
              rec['po-patientPhone']     = phone;
              rec['po-patientDOB']       = dob;
              rec['po-pcp-name']         = pcp;
              rec['po-pcp-phone']        = pcpPhone;
              rec['po-pcp-fax']          = pcpFax;
              rec['po-provider']         = surgeon;
              rec['po-surgeryDate']      = surgD;
              rec['po-startTime']        = surgT;
              if(surgeryCenterId) rec['po-surgery-center'] = surgeryCenterId;
              if(surgeryCenterLocation) rec['po-surgery-center-location'] = surgeryCenterLocation;
              if(estimatedDuration) rec['po-estimatedDuration'] = estimatedDuration;
              // Refresh office address from the linked surgery center so
              // changing the center updates the address too.
              const sc = (window.surgeryCenters || []).find(c => c.id === surgeryCenterId);
              if(sc && sc.address) rec['po-officeAddress'] = sc.address;
              records[idx] = rec;
              await window.setDoc(window.doc(window.db, 'atlas', 'preop'), { records });
              if(Array.isArray(window._rawPreopRecords)) window._rawPreopRecords = records;
              if(Array.isArray(window._cachedPreopRecords)) window._cachedPreopRecords = [...records];
              // Self-heal: stamp the pointer on the entry so subsequent
              // edits use the fast path.
              if(!entry.preopRecordId) {
                entry.preopRecordId = rec.id;
                if(!entry.preopCaseId && rec['po-caseId']) entry.preopCaseId = rec['po-caseId'];
                await _saveEntries();
              }
              const caseLabel = rec['po-caseId'] || rec.id;
              console.log('Propagated Nicole edits to pre-op record', caseLabel, '— Jordan/Josh/Dev should see the update on next open.');
              if(typeof window.toastSuccess === 'function') {
                window.toastSuccess('✓ Synced to Pre-Op ' + caseLabel);
              }
            } else {
              const reason = 'No linked Pre-Op record found for ' + (first + ' ' + last).trim() +
                '. Entry id=' + entry.id +
                ' preopRecordId=' + (entry.preopRecordId || '(none)') +
                ' preopCaseId=' + (entry.preopCaseId || '(none)') +
                '. The Pre-Op gets created when you hit "Book & Send Confirmation" on the Schedule Pre-Op Visit modal.';
              console.warn(reason);
              if(typeof window.toastWarn === 'function') {
                window.toastWarn('Tracker entry not linked to a Pre-Op yet — no propagation.');
              }
            }
          }
        } catch(propErr) { console.warn('Could not propagate edit to linked pre-op record:', propErr); }
      }
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
        await _writePdfDoc(PDF_DOC_PATH + '.' + id, {
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
      const data = await _readPdfDoc(PDF_DOC_PATH + '.' + id);
      if(!data || !data.dataUrl) { alert('PDF not found.'); return; }
      // Browsers cap the length of data: URLs, so big (chunked) PDFs won't open
      // that way. Convert to a Blob + blob: URL, which has no such limit.
      let url;
      try {
        const blob = new Blob([_dataUrlToBytes(data.dataUrl)], { type: data.contentType || 'application/pdf' });
        url = URL.createObjectURL(blob);
      } catch(_) { url = data.dataUrl; }
      const w = window.open(url, '_blank');
      if(!w) {
        const a = document.createElement('a');
        a.href = url;
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
      await _deletePdfDoc(PDF_DOC_PATH + '.' + id);
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

  // ── PCP Records-Request Fax (Nicole's flow) ─────────────────────────────────
  // Self-contained modal that lives on the Tracker row 📠 Records button.
  // Auto-fills PCP info from the entry; lets Nicole pick which records to
  // request (H&P / labs / EKG default-checked; Echo + Stress optional);
  // sends through the same /fax worker the CRNA flow uses.
  const _NIC_FAX_WORKER = 'https://atlas-reminder.blue-disk-9b10.workers.dev/fax';
  const _NIC_RETURN_FAX = '317-608-3539'; // Atlas's return fax line (matches fax.js)
  const _NIC_FAX_DOCS = [
    { key:'hp',       label:'Complete History & Physical', def:true  },
    { key:'labs',     label:'Most Recent Labs (CBC, BMP, HbA1c)', def:true  },
    { key:'ekg',      label:'Most Recent EKG', def:true  },
    { key:'echo',     label:'Echocardiogram (if applicable)', def:false },
    { key:'stress',   label:'Stress Test (if applicable)', def:false }
  ];

  window._strOpenRecordsFax = function(entryId) {
    const e = _entries.find(x => x.id === entryId);
    if(!e) return;
    if(!e.pcpFax) { alert('No PCP fax number on file. Add it via ✏ Edit first.'); return; }
    const prior = document.getElementById('strRecordsFaxModal');
    if(prior) prior.remove();
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '(patient)';
    const dob  = e.patientDOB ? _fmtDate(e.patientDOB) : '—';
    const surg = e.surgeryDate ? _fmtDate(e.surgeryDate) : '—';
    const docChecks = _NIC_FAX_DOCS.map(d =>
      `<label style="display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:13px;background:#fff">
         <input type="checkbox" id="nrf-doc-${d.key}" ${d.def?'checked':''} style="width:16px;height:16px">
         <span>${d.label}</span>
       </label>`
    ).join('');
    const wrap = document.createElement('div');
    wrap.id = 'strRecordsFaxModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (ev) => { if(ev.target === wrap) wrap.remove(); };
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:100%;max-width:640px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.3)">
        <div style="background:#1d3557;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#90b8e0">Atlas Anesthesia · PCP Records Request</div>
            <div style="font-size:15px;font-weight:700">📠 Send Records Request — ${_esc(name)}</div>
          </div>
          <button onclick="document.getElementById('strRecordsFaxModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button>
        </div>
        <div style="padding:18px 20px;font-size:13px;color:#1e293b">
          <div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px">
            <div><strong>Patient:</strong> ${_esc(name)} &nbsp;·&nbsp; <strong>DOB:</strong> ${_esc(dob)}</div>
            <div style="margin-top:4px"><strong>Surgery:</strong> ${_esc(surg)}</div>
            <div style="margin-top:4px"><strong>PCP:</strong> ${_esc(e.pcp || '—')}</div>
          </div>
          <label style="margin-top:0">PCP fax number</label>
          <input type="tel" id="nrf-fax" value="${_esc(e.pcpFax)}" style="margin-bottom:14px">
          <label style="margin-top:0">Urgency</label>
          <select id="nrf-urgency" style="margin-bottom:14px">
            <option value="Routine">Routine</option>
            <option value="Expedited">Expedited</option>
            <option value="Urgent">Urgent</option>
            <option value="STAT">STAT</option>
          </select>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">Records to request</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${docChecks}</div>
          <label style="margin-top:0">Additional notes <span style="font-weight:400;color:var(--text-faint);font-size:11px">(optional)</span></label>
          <textarea id="nrf-note" rows="2" placeholder="e.g. patient has diabetes, please include recent A1C"></textarea>
          <div id="nrf-status" style="font-size:13px;margin-top:10px;min-height:18px"></div>
          <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:12px;border-top:1px solid var(--border);margin-top:12px">
            <button class="btn btn-ghost" onclick="document.getElementById('strRecordsFaxModal').remove()">Cancel</button>
            <button class="btn btn-primary" id="nrf-send-btn" onclick="window._strSendRecordsFax('${entryId}')" style="background:#0369a1;border-color:#0369a1">📠 Send Fax</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
  };

  window._strSendRecordsFax = async function(entryId) {
    const idx = _entries.findIndex(x => x.id === entryId);
    if(idx === -1) return;
    const e = _entries[idx];
    const status = document.getElementById('nrf-status');
    const btn = document.getElementById('nrf-send-btn');
    const setErr = msg => { if(status) { status.textContent = '✗ ' + msg; status.style.color = '#b91c1c'; } };
    const setOk  = msg => { if(status) { status.textContent = '✓ ' + msg; status.style.color = '#166534'; } };
    let to = (document.getElementById('nrf-fax')?.value || '').replace(/\D/g, '');
    if(to.length === 10) to = '1' + to;
    if(to.length !== 11) { setErr('Fax number must be 10 digits.'); return; }
    const urgency = document.getElementById('nrf-urgency')?.value || 'Routine';
    const note    = (document.getElementById('nrf-note')?.value || '').trim();
    const picked  = _NIC_FAX_DOCS.filter(d => document.getElementById('nrf-doc-'+d.key)?.checked);
    if(!picked.length) { setErr('Pick at least one record to request.'); return; }
    if(btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const html = _strBuildRecordsFaxHtml(e, picked, urgency, note);
      const res = await fetch(_NIC_FAX_WORKER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+' + to,
          caseId: e.preopCaseId || ('TRACKER-' + e.id.slice(0, 8)),
          worker: 'nicole',
          html
        })
      });
      const out = await res.json().catch(() => ({}));
      if(!res.ok || !out.success) throw new Error(out.error || ('Worker ' + res.status));
      e.pcpRecordsFaxSentAt = new Date().toISOString();
      e.pcpRecordsFaxSentBy = (window.currentUser?.email) || '';
      e.pcpRecordsFaxJobId  = out.sid || '';
      await _saveEntries();
      try { window.logAudit && window.logAudit('pcp-records-fax-sent', e.id, [e.patientFirst, e.patientLast].filter(Boolean).join(' ')); } catch(_){}
      setOk('Fax sent — Job ' + (out.sid || '?'));
      setTimeout(() => { document.getElementById('strRecordsFaxModal')?.remove(); window.renderSchedulerTracker(); }, 900);
    } catch(err) {
      setErr(err.message || String(err));
      if(btn) { btn.disabled = false; btn.textContent = '📠 Send Fax'; }
    }
  };

  function _strBuildRecordsFaxHtml(e, picked, urgency, note) {
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '(patient)';
    const dob  = e.patientDOB || '';
    const surg = e.surgeryDate || '';
    const surgeon = e.surgeon || '';
    const pcp  = e.pcp || '';
    const today = new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const docRows = picked.map(d => `<tr><td style="padding:5px 0;font-size:13px">☑ ${d.label}</td></tr>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
      <body style="font-family:Arial,sans-serif;color:#111;padding:24px;max-width:760px;margin:0 auto">
        <div style="border-bottom:2px solid #1d3557;padding-bottom:10px;margin-bottom:18px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;color:#1d3557;text-transform:uppercase">Atlas Anesthesia, LLC</div>
          <div style="font-size:22px;font-weight:700;color:#1d3557">PCP Records Request</div>
          <div style="font-size:11px;color:#555;margin-top:2px">Pre-op clearance documentation — Confidential / HIPAA</div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
          <tr><td style="padding:5px 10px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;width:90px;font-size:12px">DATE</td><td style="padding:5px 10px;border:1px solid #bbb;font-size:12px">${today}</td><td style="padding:5px 10px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;width:90px;font-size:12px">URGENCY</td><td style="padding:5px 10px;border:1px solid #bbb;font-size:12px;font-weight:bold">${urgency}</td></tr>
          <tr><td style="padding:5px 10px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;font-size:12px">TO</td><td colspan="3" style="padding:5px 10px;border:1px solid #bbb;font-size:12px">${_esc(pcp || 'Primary Care Physician')}</td></tr>
          <tr><td style="padding:5px 10px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;font-size:12px">FROM</td><td colspan="3" style="padding:5px 10px;border:1px solid #bbb;font-size:12px">Shannon · Atlas Anesthesia · Return fax ${_NIC_RETURN_FAX}</td></tr>
        </table>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px;line-height:1.55">
          <div><strong>Patient:</strong> ${_esc(name)}</div>
          <div><strong>DOB:</strong> ${_esc(dob)} &nbsp;·&nbsp; <strong>Scheduled procedure:</strong> ${_esc(surg)}</div>
          ${surgeon ? `<div><strong>Surgeon:</strong> ${_esc(surgeon)}</div>` : ''}
        </div>
        <div style="font-size:13px;margin-bottom:10px">
          Please send the following records to Atlas Anesthesia at <strong>${_NIC_RETURN_FAX}</strong> so we can complete pre-op clearance for the patient above:
        </div>
        <table style="margin-bottom:14px"><tbody>${docRows}</tbody></table>
        ${note ? `<div style="border:1px solid #fde68a;background:#fef3c7;border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px"><strong>Additional notes:</strong> ${_esc(note)}</div>` : ''}
        <div style="font-size:12px;color:#555;line-height:1.55;margin-top:24px">
          Thank you for your assistance. If you have any questions, please call Atlas Anesthesia.
        </div>
        <div style="margin-top:34px;font-size:12px">
          <div style="border-top:1px solid #000;width:280px;padding-top:4px">Shannon · Atlas Anesthesia, LLC</div>
        </div>
      </body></html>`;
  }

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
    if(window._userRole === 'assistant') { alert('Only Shannon can update call status.'); return; }
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
    // Auto-log a Phone Tracker entry for this patient the moment Jordan
    // marks the call made. Idempotent — toggling off and on later won't
    // create duplicates because _jptLogTrackerCall dedupes by trackerEntryId.
    if(done && typeof window._jptLogTrackerCall === 'function') {
      try { await window._jptLogTrackerCall(e); } catch(_){}
    }
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

  // Patient cleared for anesthesia services by Jordan.  Called by the
  // clearance-report submit flow (jordan-clearance.js) — that path bypasses
  // the cycle and goes straight to the final "cleared" state. Kept binary
  // (done true/false) for backward compatibility with that caller.
  window._strToggleCleared = async function(id, done) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    if(done) {
      _entries[idx].clearedStatus = 'cleared';
      _entries[idx].clearedAt = new Date().toISOString();
      _entries[idx].clearedBy = (window.currentUser?.email) || '';
    } else {
      _entries[idx].clearedStatus = '';
      _entries[idx].clearedAt = null;
      _entries[idx].clearedBy = null;
    }
    await _saveEntries();
    try { window.logAudit && window.logAudit(done ? 'preop-visit-cleared' : 'preop-visit-uncleared', id, _entries[idx].patientFirst + ' ' + _entries[idx].patientLast); } catch(e){}
    window.renderSchedulerTracker();
  };

  // Manually mark the $100 pre-op fee as paid. Used when the patient paid in
  // Stripe but under a different email than we have on file, so the automatic
  // email match can't find it. Stamps manualPaidAt on the entry — the patient
  // portal (patient-schedule.js) honors this and unlocks scheduling. Reversible
  // via _strUndoManualPaid.
  window._strMarkPaidManually = async function(id) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || 'this patient';
    if(!confirm('Mark ' + name + ' as PAID for the $100 pre-op fee?\n\nUse this ONLY after you have confirmed the $100 actually landed in Stripe (e.g. they paid under a different email, so it didn\'t auto-match).\n\nThis unlocks scheduling for the patient.')) return;
    e.manualPaidAt = new Date().toISOString();
    e.manualPaidBy = (window.currentUser?.email) || '';
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-manual-paid', id, name); } catch(_){}
    window.renderSchedulerTracker();
  };

  // Undo a manual paid stamp (e.g. it was clicked by mistake). Re-locks the
  // patient's scheduling step unless Stripe shows them paid.
  window._strUndoManualPaid = async function(id) {
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || 'this patient';
    if(!confirm('Undo the manual "paid" mark for ' + name + '?\n\nIf they haven\'t actually paid, this will re-lock their scheduling step.')) return;
    e.manualPaidAt = null;
    e.manualPaidBy = null;
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-manual-unpaid', id, name); } catch(_){}
    window.renderSchedulerTracker();
    if(document.getElementById('strOverridePanel')) window._strOpenOverridePanel();
  };

  // ── $100 Pre-Op Fee Override Panel ──────────────────────────────────────────
  // Hidden surface — opens when staff triple-click the "Pre-Op Visit Tracker"
  // heading. Lists every patient awaiting their $100 Stripe payment plus the
  // ones already marked paid manually, with one click to toggle. The Tracker
  // pill itself is display-only so people see Stripe state at a glance and
  // can't accidentally flip the override.
  window._strOpenOverridePanel = function() {
    const prior = document.getElementById('strOverridePanel');
    if(prior) prior.remove();
    const rows = _entries.slice().sort((a,b) => (a.surgeryDate||'').localeCompare(b.surgeryDate||''));
    const list = rows.map(e => {
      const stripe = _stripeStatus[(e.patientEmail||'').toLowerCase()] || {};
      const stripePaid = !!stripe.preopVisitPaid;
      const manualPaid = !!e.manualPaidAt;
      const name = [e.patientLast, e.patientFirst].filter(Boolean).join(', ') || '(no name)';
      const dob  = e.patientDOB ? _fmtDate(e.patientDOB) : '—';
      const surg = e.surgeryDate ? _fmtDate(e.surgeryDate) : '—';
      const email = e.patientEmail || '(no email)';
      let statusPill, actionBtn;
      if(stripePaid) {
        statusPill = `<span style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:3px 9px;border-radius:10px">✓ Stripe</span>`;
        actionBtn  = `<span style="font-size:11px;color:var(--text-faint)">Stripe handled this — no override needed.</span>`;
      } else if(manualPaid) {
        const by = e.manualPaidBy ? ' by ' + _esc(e.manualPaidBy) : '';
        statusPill = `<span title="Manually marked${by}" style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:11px;font-weight:700;padding:3px 9px;border-radius:10px">✓ Manual</span>`;
        actionBtn  = `<button onclick="window._strUndoManualPaid('${e.id}')" class="btn btn-ghost btn-sm" style="color:#b91c1c;border-color:#fecaca;font-size:11px;padding:3px 9px">Undo override</button>`;
      } else {
        statusPill = `<span style="background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;font-size:11px;font-weight:600;padding:3px 9px;border-radius:10px">⏳ Pending</span>`;
        actionBtn  = `<button onclick="window._strMarkPaidManually('${e.id}')" class="btn btn-primary btn-sm" style="background:#166534;border-color:#166534;font-size:11px;padding:3px 9px">Mark paid</button>`;
      }
      return `<div style="display:grid;grid-template-columns:1.5fr 1fr 110px 110px 130px 170px;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px">
        <div style="font-weight:600">${_esc(name)}</div>
        <div style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(email)}">${_esc(email)}</div>
        <div style="color:var(--text-muted)">DOB ${_esc(dob)}</div>
        <div style="color:var(--text-muted)">Surg ${_esc(surg)}</div>
        <div>${statusPill}</div>
        <div style="text-align:right">${actionBtn}</div>
      </div>`;
    }).join('') || `<div style="padding:30px;text-align:center;color:var(--text-faint);font-size:13px">No patients on the Tracker yet.</div>`;

    const wrap = document.createElement('div');
    wrap.id = 'strOverridePanel';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto';
    wrap.onclick = (ev) => { if(ev.target === wrap) wrap.remove(); };
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:100%;max-width:1100px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.3)">
        <div style="background:#1d3557;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#90b8e0">Override panel</div>
            <div style="font-size:15px;font-weight:700">$100 Pre-Op Fee — Manual Paid Override</div>
          </div>
          <button onclick="document.getElementById('strOverridePanel').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕ Close</button>
        </div>
        <div style="background:#fef3c7;border-bottom:1px solid #fde68a;padding:10px 18px;font-size:12px;color:#92400e">
          ⚠ Use only after you've confirmed the patient actually paid through Stripe under a different email. Tracker pills stay display-only — overrides happen here.
        </div>
        <div style="overflow-y:auto;flex:1">${list}</div>
      </div>`;
    document.body.appendChild(wrap);
  };

  // Triple-click on the tracker heading reveals the override panel. Installed
  // once per session — re-renders of the tracker body don't touch the h2.
  function _installOverrideTripleClick() {
    const section = document.getElementById('tab-scheduler-tracker');
    if(!section) return;
    const h2 = section.querySelector('h2');
    if(!h2 || h2.dataset.overrideWired) return;
    h2.dataset.overrideWired = '1';
    h2.style.userSelect = 'none';
    h2.title = 'Pre-Op Visit Tracker';
    let clicks = 0, lastClick = 0;
    h2.addEventListener('click', () => {
      const now = performance.now();
      clicks = (now - lastClick < 600) ? clicks + 1 : 1;
      lastClick = now;
      if(clicks >= 3) { clicks = 0; window._strOpenOverridePanel(); }
    });
  }
  // Run on every tracker render — first render wires up, subsequent renders
  // hit the early-return guard.
  const _origRender = window.renderSchedulerTracker;
  window.renderSchedulerTracker = async function(...args) {
    const r = await _origRender.apply(this, args);
    try { _installOverrideTripleClick(); } catch(_){}
    return r;
  };

  // Jordan cycles the Cleared pill: '' → 'faxed' → 'waiting' → 'cleared' → ''.
  const _CLEARED_CYCLE = ['', 'faxed', 'waiting', 'cleared'];
  window._strCycleClearedStatus = async function(id) {
    if(window._userRole !== 'assistant') { alert('Only Jordan can update this pill.'); return; }
    const idx = _entries.findIndex(e => e.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    const cur = e.clearedStatus || (e.clearedAt ? 'cleared' : '');
    const next = _CLEARED_CYCLE[(_CLEARED_CYCLE.indexOf(cur) + 1) % _CLEARED_CYCLE.length];
    e.clearedStatus = next;
    e.clearedStatusAt = new Date().toISOString();
    e.clearedStatusBy = (window.currentUser?.email) || '';
    // Mirror to legacy clearedAt so anything still reading that flag works.
    if(next === 'cleared') {
      e.clearedAt = new Date().toISOString();
      e.clearedBy = (window.currentUser?.email) || '';
    } else {
      e.clearedAt = null;
      e.clearedBy = null;
    }
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-cleared-status', id, (e.patientFirst + ' ' + e.patientLast).trim() + ' / ' + (next || 'pending')); } catch(_){}
    window.renderSchedulerTracker();
  };

  // Cascade delete — removes the patient from EVERY surface the case touches:
  //   - this Tracker entry (atlas/preop_visits)
  //   - the linked PDF on the entry (atlas/preop_visit_pdfs.<id>)
  //   - the linked pre-op record + draft/finalized case + payments / CS log /
  //     deposits / saved PDFs / payouts, via window._purgeCaseEverywhere
  // So one click in Nicole's view cleans Josh's, Dev's, and Jordan's surfaces
  // at the same time.

  // Mark Canceled — flags the entry as canceled, stops every worker cron
  // reminder for this case (each one checks `if(e.canceledAt) continue;`),
  // and emails jordan@atlasanesthesia.co with the case details so he's
  // looped in without having to spot it on the Tracker.
  window._strMarkCanceled = async function(id) {
    const idx = _entries.findIndex(x => x.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || '(patient)';
    const reason = prompt('Cancellation reason for ' + name + '? (optional — shown to Jordan)\n\nThis stops all automatic reminders and emails jordan@atlasanesthesia.co.', '');
    if(reason === null) return; // user clicked Cancel on the prompt
    e.canceledAt = new Date().toISOString();
    e.canceledBy = (window.currentUser?.email) || '';
    e.canceledReason = (reason || '').trim();
    // Remove the linked Pre-Op record so it disappears from Josh/Dev's
    // Pre-Op History (single shared atlas/preop doc). We stash the deleted
    // record on the entry so Uncancel can restore it verbatim instead of
    // rebuilding from scratch.
    try {
      const preopId = e.preopRecordId || '';
      const preopCaseId = e.preopCaseId || '';
      if(preopId || preopCaseId) {
        const psnap = await window.getDoc(window.doc(window.db, 'atlas', 'preop'));
        if(psnap.exists()) {
          const records = psnap.data().records || [];
          const kept = [];
          let removed = null;
          for(const rec of records) {
            if(!rec) continue;
            const match = (preopId && rec.id === preopId) ||
                          (preopCaseId && rec['po-caseId'] === preopCaseId);
            if(match && !removed) { removed = rec; continue; }
            kept.push(rec);
          }
          if(removed) {
            await window.setDoc(window.doc(window.db, 'atlas', 'preop'), { records: kept });
            e._canceledPreopSnapshot = removed;
            if(Array.isArray(window._rawPreopRecords))    window._rawPreopRecords    = kept;
            if(Array.isArray(window._cachedPreopRecords)) window._cachedPreopRecords = [...kept];
          }
        }
      }
    } catch(preopErr) { console.warn('cancel: preop delete failed:', preopErr); }
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-canceled', id, name + (reason ? ' — ' + reason : '')); } catch(_){}
    // Notify Jordan via the existing outreach-email worker endpoint.
    try {
      const surg = e.surgeryDate ? _fmtDate(e.surgeryDate) : '—';
      const dob  = e.patientDOB ? _fmtDate(e.patientDOB) : '—';
      const phone = e.patientPhone || '—';
      const email = e.patientEmail || '—';
      const surgeon = e.surgeon || '—';
      const center = e.surgeryCenterName || '—';
      const reasonRow = e.canceledReason
        ? `<tr style="background:#f8fafc"><td style="padding:8px 14px;font-weight:700">Reason</td><td style="padding:8px 14px">${_esc(e.canceledReason)}</td></tr>`
        : '';
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px"><tr><td align="center">
        <table width="560" style="max-width:560px;width:100%;background:#fff;border-radius:12px;overflow:hidden">
          <tr><td style="background:#991b1b;color:#fff;padding:18px 22px"><div style="font-size:11px;letter-spacing:.8px;text-transform:uppercase">Atlas Anesthesia · Case Canceled</div><div style="font-size:18px;font-weight:700;margin-top:2px">${_esc(name)}</div></td></tr>
          <tr><td style="padding:20px 22px;font-size:14px;color:#1e293b;line-height:1.6">
            <p style="margin:0 0 12px">Heads up — this case has been marked <strong>canceled</strong>. No more automatic reminders will go out for it.</p>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:13px">
              <tr><td style="padding:8px 14px;font-weight:700;width:120px">Patient</td><td style="padding:8px 14px">${_esc(name)}</td></tr>
              <tr style="background:#f8fafc"><td style="padding:8px 14px;font-weight:700">DOB</td><td style="padding:8px 14px">${_esc(dob)}</td></tr>
              <tr><td style="padding:8px 14px;font-weight:700">Phone</td><td style="padding:8px 14px">${_esc(phone)}</td></tr>
              <tr style="background:#f8fafc"><td style="padding:8px 14px;font-weight:700">Email</td><td style="padding:8px 14px">${_esc(email)}</td></tr>
              <tr><td style="padding:8px 14px;font-weight:700">Surgery</td><td style="padding:8px 14px">${_esc(surg)}</td></tr>
              <tr style="background:#f8fafc"><td style="padding:8px 14px;font-weight:700">Surgeon</td><td style="padding:8px 14px">${_esc(surgeon)}</td></tr>
              <tr><td style="padding:8px 14px;font-weight:700">Center</td><td style="padding:8px 14px">${_esc(center)}</td></tr>
              ${reasonRow}
              <tr style="background:#f8fafc"><td style="padding:8px 14px;font-weight:700">Canceled by</td><td style="padding:8px 14px">${_esc(e.canceledBy || 'staff')}</td></tr>
            </table>
            <p style="margin:16px 0 0;font-size:12px;color:#64748b">Reopen the case anytime from Shannon's Tracker via the ↶ Uncancel button.</p>
          </td></tr>
        </table></td></tr></table></body></html>`;
      await fetch('https://atlas-reminder.blue-disk-9b10.workers.dev/outreach-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'jordan@atlasanesthesia.co', subject: 'Case Canceled — ' + name, html })
      });
    } catch(emailErr) { console.warn('cancel email send failed:', emailErr); }
    if(typeof window.toastSuccess === 'function') window.toastSuccess('Canceled — Jordan notified');
    window.renderSchedulerTracker();
  };

  window._strUncancel = async function(id) {
    const idx = _entries.findIndex(x => x.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    if(!confirm('Reopen this case? Reminders will resume on the normal schedule.')) return;
    e.canceledAt = null;
    e.canceledBy = null;
    e.canceledReason = null;
    // Clear the once-per-entry flags so reminders can fire again.
    e.threeDayNoScheduleAlertAt = null;
    e.recordsFaxFollowupAt = null;
    // Put the Pre-Op record back so Josh/Dev see the case again. Prefer the
    // exact snapshot we stashed on Cancel; fall back to rebuilding it via the
    // idempotent auto-creator so older canceled entries still recover.
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', 'preop'));
      const records = snap.exists() ? (snap.data().records || []) : [];
      const alreadyBack = records.some(r => r &&
        ((e.preopRecordId && r.id === e.preopRecordId) ||
         (e.preopCaseId   && r['po-caseId'] === e.preopCaseId)));
      if(!alreadyBack) {
        if(e._canceledPreopSnapshot) {
          records.unshift(e._canceledPreopSnapshot);
          await window.setDoc(window.doc(window.db, 'atlas', 'preop'), { records });
          if(Array.isArray(window._rawPreopRecords))    window._rawPreopRecords    = records;
          if(Array.isArray(window._cachedPreopRecords)) window._cachedPreopRecords = [...records];
        } else if(typeof window._ensurePreopForEntry === 'function') {
          try { await window._ensurePreopForEntry(e); } catch(_){}
        }
      }
    } catch(preopErr) { console.warn('uncancel: preop restore failed:', preopErr); }
    e._canceledPreopSnapshot = null;
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-uncanceled', id); } catch(_){}
    if(typeof window.toastSuccess === 'function') window.toastSuccess('Case reopened');
    window.renderSchedulerTracker();
  };

  // Toggle a Tracker row's "⋯" action menu. Closes any OTHER open row menu
  // first (only one at a time). Clicking anywhere outside closes it.
  window._strToggleRowMenu = function(rowId) {
    const target = document.getElementById('strRowMenu-' + rowId);
    if(!target) return;
    document.querySelectorAll('[id^="strRowMenu-"]').forEach(el => {
      if(el !== target) el.style.display = 'none';
    });
    target.style.display = target.style.display === 'block' ? 'none' : 'block';
  };
  // Global click dismisser — clicks outside a menu close it. Installed once.
  if(!window._strRowMenuDismisserInstalled) {
    window._strRowMenuDismisserInstalled = true;
    document.addEventListener('click', (ev) => {
      if(ev.target && (ev.target.closest && ev.target.closest('[id^="strRowMenu-"]'))) return;
      document.querySelectorAll('[id^="strRowMenu-"]').forEach(el => { el.style.display = 'none'; });
    });
  }

  // For Jordan: open the linked Pre-Op if one exists, otherwise auto-
  // create one from whatever data the Tracker entry has right now and
  // then open it. This is what the row's 📋 Pre-Op button calls when
  // linkedPreopId is empty (unusual — most entries now auto-create at
  // Add Patient time — but this handles pre-migration entries and any
  // gap where the auto-create didn't fire).
  window._strOpenOrCreatePreop = async function(entryId) {
    const e = _entries.find(x => x.id === entryId);
    if(!e) return;
    if(typeof window._ensurePreopForEntry !== 'function') {
      alert('Pre-Op helper not ready — refresh the page and try again.');
      return;
    }
    try {
      const rec = await window._ensurePreopForEntry(e);
      const recId = rec && rec.id;
      if(!recId) {
        alert('Could not create a Pre-Op for this patient. Make sure a surgery date is set.');
        return;
      }
      // Stamp the link back onto the tracker entry so the next click hits
      // the fast path.
      e.preopRecordId = recId;
      e.preopCaseId   = rec['po-caseId'] || '';
      await _saveEntries();
      window._strOpenPreop(recId);
    } catch(err) {
      console.warn('open-or-create Pre-Op failed:', err);
      alert('Could not open the Pre-Op: ' + (err.message || err));
    }
  };

  // Undo the "📧 Email sent" state on a row. Resets callStatus/callStatusAt
  // and any of the follow-up state that only makes sense after the portal
  // link went out. The already-sent email can't be recalled — this is
  // purely a UI/data undo so Shannon can hit "📅 Schedule" again.
  window._strUndoEmailSent = async function(id) {
    const idx = _entries.findIndex(x => x.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || 'this patient';
    if(!confirm('Undo "Email sent" for ' + name + '?\n\nThis resets the row so you can hit 📅 Schedule again. It does NOT recall the email that already went out.')) return;
    e.callStatus = 'none';
    e.callStatusAt = null;
    e.callStatusBy = null;
    // Also reset the once-per-entry alert flag so if the portal link goes
    // out again, the "no schedule after 3 days" clock restarts cleanly.
    e.threeDayNoScheduleAlertAt = null;
    await _saveEntries();
    try { window.logAudit && window.logAudit('preop-visit-email-sent-undone', id, name); } catch(_){}
    if(typeof window.toastSuccess === 'function') window.toastSuccess('Email-sent state reset');
    window.renderSchedulerTracker();
  };

  // Toggle "reminders disabled" — patient was reached directly (e.g. Jordan
  // called them), so the automated cron nudges shouldn't fire anymore. The
  // three worker crons (sendPaymentReminders, sendPaidNotScheduledReminders,
  // sendThreeDayNoScheduleAlerts) all skip when remindersDisabledAt is set.
  window._strToggleRemindersDisabled = async function(id) {
    const idx = _entries.findIndex(x => x.id === id);
    if(idx === -1) return;
    const e = _entries[idx];
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || 'this patient';
    if(e.remindersDisabledAt) {
      if(!confirm('Resume reminder emails for ' + name + '?')) return;
      e.remindersDisabledAt = null;
      e.remindersDisabledBy = null;
      // Also clear the once-per-entry alert flags so the crons can fire again.
      e.threeDayNoScheduleAlertAt = null;
      e.recordsFaxFollowupAt = null;
      await _saveEntries();
      try { window.logAudit && window.logAudit('preop-visit-reminders-resumed', id, name); } catch(_){}
      if(typeof window.toastSuccess === 'function') window.toastSuccess('Reminders resumed');
    } else {
      if(!confirm('Stop reminder emails for ' + name + '?\n\nUse this when Jordan reached them directly. The patient will no longer get automated reminder emails. You can turn reminders back on any time.')) return;
      e.remindersDisabledAt = new Date().toISOString();
      e.remindersDisabledBy = (window.currentUser?.email) || '';
      await _saveEntries();
      try { window.logAudit && window.logAudit('preop-visit-reminders-disabled', id, name); } catch(_){}
      if(typeof window.toastSuccess === 'function') window.toastSuccess('Reminders stopped for ' + name);
    }
    window.renderSchedulerTracker();
  };

  // Called from savePreop in app.js when a CRNA creates a Pre-Op from scratch
  // (no Tracker entry existed first). Ensures Jordan can see that patient on
  // her Tracker instead of the case being invisible until someone edits it.
  // Idempotent — silently returns if an entry already links to this Pre-Op.
  window._strEnsureEntryForPreop = async function(record) {
    if(!record || !record['po-caseId']) return null;
    try {
      if(!_entries.length) await _loadEntries();
      const caseId = record['po-caseId'];
      const preopId = record.id;
      // Already linked? (either direct pointer, back-pointer, or shared caseId)
      const existing = _entries.find(e =>
        (preopId && e.preopRecordId === preopId) ||
        (caseId  && e.preopCaseId    === caseId)  ||
        (preopId && e['po-preopVisitId'] === preopId)
      );
      if(existing) return existing;
      const now = new Date().toISOString();
      const centers = window.surgeryCenters || [];
      const centerId = record['po-surgery-center'] || '';
      const centerName = (centerId && centers.find(c => c.id === centerId)?.name) || '';
      const entry = {
        id: _uid(),
        patientFirst: record['po-patientFirstName'] || '',
        patientLast:  record['po-patientLastName']  || '',
        patientPhone: record['po-patientPhone']     || '',
        patientDOB:   record['po-patientDOB']       || '',
        patientEmail: record['po-patientEmail']     || '',
        pcp:          record['po-pcp-name']         || '',
        pcpPhone:     record['po-pcp-phone']        || '',
        pcpFax:       record['po-pcp-fax']          || '',
        surgeon:      record['po-provider']         || '',
        surgeryDate:  record['po-surgeryDate']      || '',
        surgeryTime:  record['po-startTime']        || '',
        surgeryCenterId: centerId,
        surgeryCenterName: centerName,
        callStatus: 'none',
        // Mark that this row came from a CRNA-created Pre-Op so it's obvious
        // where it originated when Shannon reviews it.
        addedAt: now,
        addedBy: (window.currentUser?.email) || '',
        source: 'preop-crna',
        preopRecordId: preopId,
        preopCaseId: caseId
      };
      _entries.unshift(entry);
      await _saveEntries();
      if(typeof window.renderSchedulerTracker === 'function') {
        try { window.renderSchedulerTracker(); } catch(_){}
      }
      return entry;
    } catch(err) {
      console.warn('_strEnsureEntryForPreop failed:', err);
      return null;
    }
  };

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
