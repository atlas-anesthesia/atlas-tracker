// jordan-clearance.js — Jordan's clearance workflow.
//
// Bottom-of-Pre-Op section (Jordan/assistant only). Lets Jordan:
//   1. Attach additional supporting PDFs (labs, EKGs, notes, etc.)
//   2. Click "✓ Mark Cleared & Send Report to CRNA" → preview modal
//   3. Confirm → merged PDF (airway photos + pre-op assessment summary +
//      patient pre-op clearance PDF + Jordan's attached PDFs) is emailed
//      from jordan@atlasanesthesia.co to the assigned CRNA with subject
//      "Complete Report — <Patient Name>"
//   4. Cleared pill on the Tracker row flips to ✓ Cleared.

(() => {
  const WORKER = 'https://atlas-reminder.blue-disk-9b10.workers.dev';
  const CHUNK_BYTES = 800 * 1024;
  const EXTRA_DOCS_DOC_PREFIX = 'preop_extra_docs_';      // metadata: { docs: [...] }
  const EXTRA_DOC_BASE_PREFIX = 'preop_extra_doc_';       // per-doc head + _c1, _c2, ...
  const PHOTO_ANGLES = [
    { key: 'neckExt',  label: 'Neck extended' },
    { key: 'profile',  label: 'Profile (side)' },
    { key: 'straight', label: 'Straight on' },
    { key: 'right',    label: 'Head turned right' },
    { key: 'left',     label: 'Head turned left' },
    { key: 'throat',   label: 'Back of the throat' }
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const uid = () => Math.random().toString(36).slice(2, 11);

  // ── pdf-lib lazy load (shared CDN URL with scheduler-tracker) ──────────────
  let _pdfLibLoading = null;
  function ensurePdfLib() {
    if(typeof window.PDFLib === 'object') return Promise.resolve();
    if(_pdfLibLoading) return _pdfLibLoading;
    _pdfLibLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load PDF library.'));
      document.head.appendChild(s);
    });
    return _pdfLibLoading;
  }
  function dataUrlToBytes(dataUrl) {
    const i = dataUrl.indexOf(',');
    const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for(let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return arr;
  }
  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for(let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // ── UI injection ──────────────────────────────────────────────────────────
  let _lastRecordId = '';
  function ensureUI() {
    const isAssistant = window._userRole === 'assistant';
    const existing = $('jordan-clearance-block');
    if(!isAssistant) { existing?.remove(); _lastRecordId = ''; return; }
    if(existing) {
      // Block already in DOM — but if the open pre-op record changed (Jordan
      // navigated to another patient, came back to the tab, etc.) the doc
      // list is stale. Re-pull from Firestore for the current record.
      const cur = getPreopRecordId();
      if(cur !== _lastRecordId) {
        _lastRecordId = cur;
        refreshDocList();
      }
      return;
    }
    const host = $('tab-preop');
    if(!host) return;
    const block = document.createElement('div');
    block.id = 'jordan-clearance-block';
    block.className = 'card';
    block.style.cssText = 'margin-top:18px;border-left:4px solid #166534;padding:18px 22px';
    block.innerHTML = `
      <div class="card-title" style="color:#166534;margin-bottom:6px">Additional Documents &amp; Clearance</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Attach extra PDFs (lab results, EKGs, supporting notes), then mark this case Cleared. You'll preview the combined report before it's sent to the CRNA.</div>
      <input type="file" id="jclr-file-input" accept="application/pdf" multiple style="display:none">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('jclr-file-input').click()" style="color:#7c3aed;border-color:#7c3aed">+ Additional Documents</button>
        <div id="jclr-upload-status" style="font-size:12px;color:var(--text-faint)"></div>
      </div>
      <div id="jclr-doc-list" style="margin-bottom:16px"></div>
      <button id="jclr-cleared-btn" style="background:#166534;color:#fff;border:none;border-radius:10px;width:100%;padding:14px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">✓ Mark Cleared &amp; Send Report to CRNA</button>
    `;
    host.appendChild(block);
    $('jclr-file-input').addEventListener('change', onFilesPicked);
    $('jclr-cleared-btn').addEventListener('click', onClearedClicked);
    _lastRecordId = getPreopRecordId();
    refreshDocList();
  }
  setInterval(ensureUI, 1000);
  document.addEventListener('DOMContentLoaded', ensureUI);

  // ── Currently-loaded pre-op record identity helpers ───────────────────────
  function getPreopRecordId() {
    return window._editingPreopId || $('po-caseId')?.value || '';
  }
  function getPreopVisitId() {
    const explicit = $('po-preopVisitId')?.value;
    if(explicit) return explicit;
    const recId = getPreopRecordId();
    const entries = window._preopVisitEntries || [];
    const match = entries.find(e => e && e.preopRecordId === recId);
    return match ? match.id : '';
  }
  function getPatientName() {
    const f = $('po-patientFirstName')?.value?.trim() || '';
    const l = $('po-patientLastName')?.value?.trim() || '';
    return (f + ' ' + l).trim() || 'Patient';
  }
  function getAssignedCrnaEmail() {
    // Read from the active worker toggle on the form (po-assign-josh / po-assign-dev).
    const joshActive = $('po-assign-josh')?.classList.contains('active-josh');
    const devActive  = $('po-assign-dev')?.classList.contains('active-dev');
    if(joshActive) return 'josh@atlasanesthesia.co';
    if(devActive)  return 'dev@atlasanesthesia.co';
    // Fallback: read the cached pre-op record's `worker` field.
    const rec = (window._rawPreopRecords || []).find(r => r && r.id === getPreopRecordId());
    if(rec?.worker === 'josh') return 'josh@atlasanesthesia.co';
    return 'dev@atlasanesthesia.co';
  }

  // ── Extra-docs storage (chunked, per pre-op record) ───────────────────────
  async function loadDocsMeta() {
    const recId = getPreopRecordId();
    if(!recId) return [];
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', EXTRA_DOCS_DOC_PREFIX + recId));
      return snap.exists() ? (snap.data().docs || []) : [];
    } catch(_) { return []; }
  }
  async function saveDocsMeta(docs) {
    const recId = getPreopRecordId();
    if(!recId) throw new Error('No pre-op record id — save the pre-op first.');
    await window.setDoc(window.doc(window.db, 'atlas', EXTRA_DOCS_DOC_PREFIX + recId), { docs });
  }
  async function writeChunkedDoc(docId, filename, dataUrl) {
    const chunks = [];
    for(let i = 0; i < dataUrl.length; i += CHUNK_BYTES) {
      chunks.push(dataUrl.slice(i, i + CHUNK_BYTES));
    }
    await window.setDoc(window.doc(window.db, 'atlas', EXTRA_DOC_BASE_PREFIX + docId), {
      filename,
      contentType: 'application/pdf',
      chunkCount: chunks.length,
      dataUrl: chunks[0] || ''
    });
    for(let i = 1; i < chunks.length; i++) {
      await window.setDoc(window.doc(window.db, 'atlas', EXTRA_DOC_BASE_PREFIX + docId + '_c' + i), {
        dataUrl: chunks[i]
      });
    }
    return chunks.length;
  }
  async function readChunkedDoc(docId) {
    const head = await window.getDoc(window.doc(window.db, 'atlas', EXTRA_DOC_BASE_PREFIX + docId));
    if(!head.exists()) return null;
    const d = head.data();
    const chunkCount = d.chunkCount || 1;
    let full = d.dataUrl || '';
    for(let i = 1; i < chunkCount; i++) {
      const cs = await window.getDoc(window.doc(window.db, 'atlas', EXTRA_DOC_BASE_PREFIX + docId + '_c' + i));
      if(cs.exists()) full += (cs.data().dataUrl || '');
    }
    return { filename: d.filename, dataUrl: full };
  }
  async function deleteChunkedDoc(docId, chunkCount) {
    try { await window.deleteDoc(window.doc(window.db, 'atlas', EXTRA_DOC_BASE_PREFIX + docId)); } catch(_){}
    for(let i = 1; i < (chunkCount || 1); i++) {
      try { await window.deleteDoc(window.doc(window.db, 'atlas', EXTRA_DOC_BASE_PREFIX + docId + '_c' + i)); } catch(_){}
    }
  }

  // ── File upload flow ──────────────────────────────────────────────────────
  async function onFilesPicked(ev) {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if(!files.length) return;
    if(!getPreopRecordId()) {
      alert('Please save the pre-op record first so we can attach the documents to it.');
      return;
    }
    const status = $('jclr-upload-status');
    const docs = await loadDocsMeta();
    for(const file of files) {
      if(file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        if(status) status.textContent = `Skipped "${file.name}" — only PDFs are supported.`;
        continue;
      }
      try {
        if(status) status.textContent = `Uploading ${file.name}…`;
        const dataUrl = await fileToDataUrl(file);
        const docId = uid();
        const chunkCount = await writeChunkedDoc(docId, file.name, dataUrl);
        docs.push({ id: docId, filename: file.name, sizeBytes: file.size, chunkCount, addedAt: new Date().toISOString() });
      } catch(err) {
        console.warn('Upload failed:', err);
        if(status) status.textContent = `Could not upload ${file.name} — ${err.message || err}`;
      }
    }
    await saveDocsMeta(docs);
    if(status) status.textContent = '';
    refreshDocList();
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result);
      r.onerror = () => reject(new Error('Could not read file.'));
      r.readAsDataURL(file);
    });
  }

  async function refreshDocList() {
    const list = $('jclr-doc-list');
    if(!list) return;
    const docs = await loadDocsMeta();
    if(!docs.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-faint);font-style:italic">No extra documents attached yet.</div>';
      return;
    }
    list.innerHTML = docs.map(d => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
        <div style="font-size:13px;font-weight:600;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">📎 ${esc(d.filename || 'document.pdf')}</div>
        <button onclick="window._jclrRemoveDoc('${d.id}')" title="Remove" style="background:none;border:none;color:var(--warn);font-size:14px;cursor:pointer;padding:4px 8px">🗑</button>
      </div>`).join('');
  }
  window._jclrRemoveDoc = async function(id) {
    if(!confirm('Remove this attached document?')) return;
    const docs = await loadDocsMeta();
    const target = docs.find(d => d.id === id);
    const next   = docs.filter(d => d.id !== id);
    await saveDocsMeta(next);
    if(target) await deleteChunkedDoc(id, target.chunkCount);
    refreshDocList();
  };

  // ── Pre-op assessment summary page (text-only) ────────────────────────────
  function collectPreopFields() {
    // Read every po-* input/select/textarea on the form, paired with the
    // label that ACTUALLY belongs to it (closest preceding label sibling, or
    // a <label for="id"> match). Earlier version used the first label in the
    // parent card, which made every field show up as "First Name".
    const out = [];
    const seen = new Set();
    const cleanText = node => (node.textContent || '').replace(/\s+/g, ' ').trim().replace(/[*:]\s*$/, '');
    const findLabel = (el) => {
      // 1. label[for="..."]
      if(el.id) {
        try {
          const direct = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
          if(direct) return cleanText(direct);
        } catch(_){}
      }
      // 2. Wrapping label ancestor.
      let p = el.parentElement;
      while(p && p !== document.body) {
        if(p.tagName === 'LABEL') return cleanText(p);
        p = p.parentElement;
      }
      // 3. Closest preceding label sibling, walking up the tree.
      let node = el;
      while(node && node !== document.body) {
        let sib = node.previousElementSibling;
        while(sib) {
          if(sib.tagName === 'LABEL') return cleanText(sib);
          // A wrapper div ending in a label also counts.
          const inner = sib.querySelector && sib.querySelector('label');
          if(inner) return cleanText(inner);
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return '';
    };
    document.querySelectorAll('#tab-preop input, #tab-preop select, #tab-preop textarea').forEach(el => {
      if(!el.id || !el.id.startsWith('po-')) return;
      if(el.type === 'hidden') return;          // skip backing-store inputs
      if(el.closest('#jordan-clearance-block')) return; // skip Jordan's own block
      if(seen.has(el.id)) return;
      seen.add(el.id);
      let val = '';
      if(el.type === 'checkbox') val = el.checked ? 'Yes' : '';
      else if(el.type === 'radio') { if(el.checked) val = el.value; }
      else if(el.tagName === 'SELECT') {
        // Read the visible option text, not the raw value — surgery centers
        // and similar dropdowns store internal ids as values but display
        // human-readable names.
        const opt = el.options[el.selectedIndex];
        val = opt ? (opt.textContent || opt.text || opt.value) : '';
        if(val && val.trim().startsWith('—')) val = ''; // placeholder "— Pick a center —"
      }
      else val = el.value;
      if(!val) return;
      const label = findLabel(el) || el.id.replace(/^po-/, '').replace(/-/g, ' ');
      out.push({ label, value: String(val).trim() });
    });
    return out;
  }
  // Snapshot the actual Pre-Op tab using html2canvas (loaded site-wide via
  // index.html) so the report's assessment section looks like the live form
  // — same section cards, same two-column grid, same labels. Slice the
  // resulting tall canvas across multiple letter pages.
  async function addAssessmentPages(out) {
    const { StandardFonts, rgb } = window.PDFLib;
    if(typeof window.html2canvas !== 'function') {
      // Fallback — should never happen since html2canvas is loaded on every page.
      const page = out.addPage([612, 792]);
      const font = await out.embedFont(StandardFonts.Helvetica);
      page.drawText('Pre-Op Assessment Summary unavailable (renderer not loaded).',
        { x: 50, y: 720, size: 11, font, color: rgb(0.45, 0.45, 0.45) });
      return;
    }
    const tab = document.getElementById('tab-preop');
    if(!tab) return;
    // Hide affordances we don't want in the snapshot: action bar, Jordan's
    // clearance block, any preview-only floating buttons.
    const hideList = [
      document.getElementById('jordan-clearance-block'),
      tab.querySelector('.action-bar')
    ].filter(Boolean);
    const prior = hideList.map(el => el.style.visibility);
    hideList.forEach(el => el.style.visibility = 'hidden');
    // Inject a one-shot "print-style" CSS that darkens labels, solidifies
    // input backgrounds, and tightens borders — only applies during the
    // html2canvas capture, then is removed. Makes the snapshot look crisp
    // on paper without affecting how Jordan sees the live form.
    const snapStyle = document.createElement('style');
    snapStyle.id = 'jclr-snapshot-style';
    snapStyle.textContent = `
      #tab-preop label,
      #tab-preop .card-title,
      #tab-preop .card > div[style*="text-faint"] {
        color: #0f172a !important;
      }
      #tab-preop input:not([type="checkbox"]):not([type="radio"]),
      #tab-preop select,
      #tab-preop textarea {
        background: #ffffff !important;
        color: #0f172a !important;
        border-color: #94a3b8 !important;
      }
      #tab-preop .card {
        background: #ffffff !important;
        border-color: #94a3b8 !important;
        box-shadow: none !important;
      }
      #tab-preop input[type="checkbox"]:checked + span,
      #tab-preop label {
        font-weight: 500 !important;
      }
    `;
    document.head.appendChild(snapStyle);
    let canvas;
    try {
      canvas = await window.html2canvas(tab, {
        backgroundColor: '#ffffff',
        scale: 1.5,
        useCORS: true,
        logging: false,
        windowWidth: tab.scrollWidth
      });
    } finally {
      hideList.forEach((el, i) => el.style.visibility = prior[i] || '');
      snapStyle.remove();
    }
    // Slice the canvas across letter pages. Source pixels → PDF points scaled
    // so the snapshot width fills the page minus 36 pt margins.
    const PAGE_W = 612, PAGE_H = 792, MARGIN = 36;
    const drawW = PAGE_W - 2 * MARGIN;
    const ptPerPx = drawW / canvas.width;
    const pageDrawH = PAGE_H - 2 * MARGIN;
    const pageSrcH = Math.max(1, Math.floor(pageDrawH / ptPerPx));
    let yOff = 0;
    while(yOff < canvas.height) {
      const sliceH = Math.min(pageSrcH, canvas.height - yOff);
      const tmp = document.createElement('canvas');
      tmp.width  = canvas.width;
      tmp.height = sliceH;
      const ctx = tmp.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(canvas, 0, -yOff);
      const dataUrl = tmp.toDataURL('image/jpeg', 0.85);
      const bytes = dataUrlToBytes(dataUrl);
      const img = await out.embedJpg(bytes);
      const page = out.addPage([PAGE_W, PAGE_H]);
      const drawH = sliceH * ptPerPx;
      page.drawImage(img, { x: MARGIN, y: PAGE_H - MARGIN - drawH, width: drawW, height: drawH });
      yOff += sliceH;
    }
  }

  // ── Image page (airway photo) ─────────────────────────────────────────────
  async function addImagePage(out, dataUrl, caption) {
    const { StandardFonts, rgb } = window.PDFLib;
    const isJpeg = /^data:image\/jpe?g/i.test(dataUrl);
    const bytes = dataUrlToBytes(dataUrl);
    const img = isJpeg ? await out.embedJpg(bytes) : await out.embedPng(bytes);
    const page = out.addPage([612, 792]);
    const font     = await out.embedFont(StandardFonts.Helvetica);
    const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
    page.drawText('Airway Photo', { x: 50, y: 750, size: 12, font: fontBold, color: rgb(0.11, 0.21, 0.34) });
    page.drawText(caption || '', { x: 50, y: 732, size: 11, font, color: rgb(0.3, 0.3, 0.3) });
    // Fit image into a 512x640 box (centered, bottom-anchored to leave room)
    const maxW = 512, maxH = 640;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale, h = img.height * scale;
    const x = (612 - w) / 2;
    const y = (792 - h) / 2 - 20;
    page.drawImage(img, { x, y, width: w, height: h });
  }

  // ── Merge a PDF (data URL) into the output ────────────────────────────────
  async function mergePdf(out, dataUrl) {
    try {
      const src = await window.PDFLib.PDFDocument.load(dataUrlToBytes(dataUrl), { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    } catch(e) { console.warn('Could not merge a PDF:', e); }
  }

  // ── Build the combined report ─────────────────────────────────────────────
  async function buildCombinedReport() {
    await ensurePdfLib();
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    // 1. Pre-op assessment summary first (html2canvas snapshot of the live form)
    await addAssessmentPages(out);
    // 2. Airway photos from the patient portal (if linked)
    const visitId = getPreopVisitId();
    if(visitId) {
      for(const a of PHOTO_ANGLES) {
        try {
          const snap = await window.getDoc(window.doc(window.db, 'atlas', 'preop_photos_' + visitId + '_' + a.key));
          if(snap.exists() && snap.data().dataUrl) {
            await addImagePage(out, snap.data().dataUrl, a.label);
          }
        } catch(e) { console.warn('photo fetch failed:', a.key, e); }
      }
      // 3. Patient's existing pre-op clearance PDF (from inbox / Nicole)
      try {
        const pdfSnap = await window.getDoc(window.doc(window.db, 'atlas', 'preop_visit_pdfs.' + visitId));
        if(pdfSnap.exists() && pdfSnap.data().dataUrl) {
          await mergePdf(out, pdfSnap.data().dataUrl);
        }
      } catch(_){}
    }
    // 4. Jordan's attached extras (in upload order)
    const docs = await loadDocsMeta();
    for(const d of docs) {
      const loaded = await readChunkedDoc(d.id);
      if(loaded?.dataUrl) await mergePdf(out, loaded.dataUrl);
    }
    return await out.save();
  }

  // ── "Mark Cleared" → preview modal → send ─────────────────────────────────
  async function onClearedClicked() {
    if(!getPreopRecordId()) { alert('Save the pre-op record first.'); return; }
    const btn = $('jclr-cleared-btn');
    btn.disabled = true; btn.textContent = 'Building report…';
    let bytes;
    try { bytes = await buildCombinedReport(); }
    catch(e) {
      console.error(e);
      alert('Could not build the report: ' + (e.message || e));
      btn.disabled = false; btn.textContent = '✓ Mark Cleared & Send Report to CRNA';
      return;
    }
    btn.disabled = false; btn.textContent = '✓ Mark Cleared & Send Report to CRNA';
    openConfirmModal(bytes);
  }

  function openConfirmModal(bytes) {
    const patient   = getPatientName();
    const crnaEmail = getAssignedCrnaEmail();
    const crnaLabel = crnaEmail.split('@')[0]; // 'josh' or 'dev'
    const crnaName  = crnaLabel === 'josh' ? 'Josh' : 'Devarsh';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);
    const prior = $('jclrConfirmModal');
    if(prior) prior.remove();
    const wrap = document.createElement('div');
    wrap.id = 'jclrConfirmModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.7);z-index:99999;display:flex;align-items:stretch;justify-content:center;padding:12px';
    wrap.onclick = e => { if(e.target === wrap) closeConfirmModal(blobUrl); };
    wrap.innerHTML = `<div style="background:#fff;border-radius:14px;width:100%;max-width:1600px;height:100%;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)">
      <div style="background:#166534;color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#bbf7d0">Clearance Confirmation</div>
          <div style="font-size:17px;font-weight:700;margin-top:2px">Are you sure you're done?</div>
        </div>
        <button id="jclr-modal-close" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:14px;font-family:inherit">✕ Close</button>
      </div>
      <div style="padding:14px 22px;background:#f0fdf4;border-bottom:1px solid #bbf7d0;font-size:13px;color:#166534">
        <strong>Patient:</strong> ${esc(patient)} &nbsp;·&nbsp; <strong>Sending to:</strong> ${esc(crnaName)} (${esc(crnaEmail)}) &nbsp;·&nbsp; <strong>From:</strong> jordan@atlasanesthesia.co
      </div>
      <div style="flex:1;min-height:0;background:#525659;display:flex">
        <iframe src="${blobUrl}" style="flex:1;width:100%;height:100%;border:none;display:block" title="Combined report preview"></iframe>
      </div>
      <div id="jclr-send-status" style="padding:8px 22px;background:#fff;border-top:1px solid var(--border);font-size:13px;color:var(--text-muted);min-height:24px"></div>
      <div style="padding:14px 22px;border-top:1px solid var(--border);background:#f8fafc;display:flex;justify-content:flex-end;gap:10px">
        <button id="jclr-cancel-btn" style="background:#fff;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Cancel</button>
        <button id="jclr-confirm-btn" style="background:#166534;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Yes, Send to ${esc(crnaName)} →</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    $('jclr-modal-close').addEventListener('click', () => closeConfirmModal(blobUrl));
    $('jclr-cancel-btn').addEventListener('click', () => closeConfirmModal(blobUrl));
    $('jclr-confirm-btn').addEventListener('click', () => onConfirmSend(bytes, blobUrl, crnaEmail, patient));
  }
  function closeConfirmModal(blobUrl) {
    try { URL.revokeObjectURL(blobUrl); } catch(_){}
    $('jclrConfirmModal')?.remove();
  }

  async function onConfirmSend(bytes, blobUrl, crnaEmail, patient) {
    const status  = $('jclr-send-status');
    const confirm = $('jclr-confirm-btn');
    const cancel  = $('jclr-cancel-btn');
    confirm.disabled = true; cancel.disabled = true;
    if(status) { status.textContent = 'Sending…'; status.style.color = 'var(--text-muted)'; }
    try {
      const base64 = bytesToBase64(bytes);
      const subject = 'Complete Report — ' + patient;
      const html = buildEmailBodyHtml(patient);
      const res = await fetch(WORKER + '/outreach-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Jordan Vallieres, APRN, FNP <jordan@atlasanesthesia.co>',
          to: crnaEmail,
          subject,
          html,
          attachments: [{
            filename: 'AtlasComplete-' + patient.replace(/[^A-Za-z0-9]+/g, '') + '.pdf',
            contentType: 'application/pdf',
            base64
          }]
        })
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok || !data.success) throw new Error(data.error || ('Send failed (' + res.status + ')'));
      // Flip the Cleared pill on the linked tracker entry.
      const visitId = getPreopVisitId();
      if(visitId && typeof window._strToggleCleared === 'function') {
        try { await window._strToggleCleared(visitId, true); } catch(_){}
      }
      if(status) { status.textContent = '✓ Sent to ' + crnaEmail; status.style.color = '#166534'; }
      setTimeout(() => closeConfirmModal(blobUrl), 900);
    } catch(err) {
      console.error(err);
      if(status) { status.textContent = 'Could not send: ' + (err.message || err); status.style.color = '#b91c1c'; }
      confirm.disabled = false; cancel.disabled = false;
    }
  }

  function buildEmailBodyHtml(patient) {
    return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.55">
      <p style="margin:0 0 12px 0">Hi,</p>
      <p style="margin:0 0 12px 0">Attached is the complete pre-op evaluation report for <strong>${esc(patient)}</strong>. It includes the patient's airway photos from the portal, the pre-op assessment summary, the pre-op clearance PDF, and any additional supporting documents.</p>
      <p style="margin:0 0 12px 0">Patient has been cleared on my end and is good to proceed. Let me know if you need anything else.</p>
      <p style="margin:0 0 4px 0">Thanks,</p>
      <p style="margin:0;font-weight:600">Jordan Vallieres, APRN, FNP</p>
      <p style="margin:0;color:#64748b;font-size:12px">Atlas Anesthesia · (317) 695-2561</p>
    </div>`;
  }
})();
