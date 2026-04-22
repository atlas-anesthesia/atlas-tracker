// -- fax.js — Fax modal and cover sheet functions --------------------------
// Depends on: app.js (db, window.currentWorker, surgeryCenters)

// -- FAX FUNCTIONS --
let _faxRecord = null;

// Called from the Send Fax button on the pre-op form itself (reads current form values)

window.previewFax = function() {
  const preview = document.getElementById('faxPreviewContent');
  const record = window._faxRecord || {};
  if(preview) preview.innerHTML = buildFaxHTML(record);
};
window.openFaxModalFromForm = function() {
  window._populateFaxCenterDropdown();
  // Read all form fields directly — no save, no clear, nothing changes
  const r = {};
  document.querySelectorAll('#tab-preop input, #tab-preop select, #tab-preop textarea').forEach(el => {
    if(!el.id) return;
    if(el.type === 'checkbox') r[el.id] = el.checked;
    else if(el.type === 'radio') { if(el.checked) r[el.name] = el.value; }
    else r[el.id] = el.value;
  });
  // Case ID from display or hidden input
  r['po-caseId'] = document.getElementById('po-caseId')?.value ||
                   document.getElementById('po-caseId-display')?.textContent?.trim() || '(unsaved)';
  // Worker
  const devActive = document.getElementById('wbtn-dev')?.classList.contains('active-dev');
  r.worker = (typeof window.currentWorker !== 'undefined' ? window.currentWorker : null) || (devActive ? 'dev' : 'josh');

  _faxRecord = r;

  // Auto-fill fax number from surgery center if one is saved
  const centerId = document.getElementById('po-surgery-center')?.value;
  const center = surgeryCenters.find(c => c.id === centerId);
  const faxInput = document.getElementById('fax-destination');
  if(faxInput) faxInput.value = center?.faxNumber || '+1';

  // Build preview and show modal
  document.getElementById('faxPreviewContent').innerHTML = buildFaxHTML(r);
  document.getElementById('faxModal').style.display = 'flex';
};

// Called from the 📠 Fax button on a saved pre-op record in the history list
window.openFaxModal = async function(id) {
  window._populateFaxCenterDropdown();
  try {
    // Try cached records first, fall back to Firestore
    let records = window._rawPreopRecords || [];
    let r = records.find(x => x.id === id);
    if(!r) {
      // Not in cache — fetch fresh
      const snap = await window.getDoc(window.doc(window.db,'atlas','preop'));
      records = snap.exists() ? (snap.data().records||[]) : [];
      window._rawPreopRecords = records;
      r = records.find(x => x.id === id);
    }
    if(!r) { alert('Record not found. ID: ' + id + '\nCache size: ' + records.length); return; }
    _faxRecord = r;

    const center = (window.surgeryCenters||window.surgeryCenters||[]).find(c => c.id === r['po-surgery-center']);
    const faxInput = document.getElementById('fax-destination');
    if(faxInput) faxInput.value = center?.faxNumber || '+1';

    const modal = document.getElementById('faxModal');
    if(!modal) { alert('Fax modal not found in DOM.'); return; }
    const preview = document.getElementById('faxPreviewContent');
    if(!preview) { alert('faxPreviewContent not found.'); return; }
    preview.innerHTML = buildFaxHTML(r);
    modal.style.display = 'flex';
  } catch(e) {
    console.error('openFaxModal error:', e);
    alert('Error: ' + e.message + '\nStack: ' + e.stack);
  }
};

window.closeFaxModal = function() {
  document.getElementById('faxModal').style.display = 'none';
  _faxRecord = null;
};

window.confirmAndSendFax = async function() {
  const faxNumber = document.getElementById('fax-destination').value.trim();
  if(!faxNumber) { alert('Please enter a destination fax number.'); return; }
  if(!faxNumber.startsWith('+')) { alert('Please include the country code, e.g. +12345678901'); return; }
  if(!_faxRecord) { alert('No record loaded.'); return; }

  const btn = document.getElementById('fax-send-btn');
  btn.textContent = 'Sending...';
  btn.disabled = true;

  try {
    const faxHtml = buildFaxHTML(_faxRecord);
    const res = await fetch('https://atlas-reminder.blue-disk-9b10.workers.dev/fax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: faxNumber,
        caseId: document.getElementById('fax-to')?.value?.trim() || 'Atlas Anesthesia',
        worker: _faxRecord.worker || window.currentWorker || 'dev',
        html: faxHtml
      })
    });
    const data = await res.json();
    if(res.ok && data.success) {
      // Save the pre-op record silently if we're on the assessment form
      if(document.getElementById('tab-preop')?.classList.contains('active')) {
        try { await savePreop(); } catch(e) {}
      }
      alert('✅ Fax sent to ' + faxNumber + '! SID: ' + (data.sid || 'N/A'));
      closeFaxModal();
    } else {
      alert('❌ Fax failed: ' + (data.error || 'Unknown error'));
    }
  } catch(e) {
    alert('❌ Error: ' + e.message);
  } finally {
    btn.textContent = '✉ Confirm & Send Fax';
    btn.disabled = false;
  }
};

window.clearFaxFields = function() {
  document.getElementById('fax-destination').value = '+1';
  document.getElementById('fax-to').value = '';
  document.getElementById('fax-attn').value = '';
  document.getElementById('fax-patient-name').value = '';
  document.getElementById('fax-dob').value = '';
  document.getElementById('fax-pages').value = '';
  previewFax();
};

function buildFaxHTML(r) {
  const now = new Date();
  const today = now.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const timeStr = now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  const worker = (typeof window.currentWorker !== 'undefined' ? window.currentWorker : null) || r.worker || 'dev';
  const providerName = worker === 'josh' ? 'Josh Condado, CRNA' : 'Dev Murthy, CRNA';
  const providerCreds = 'CRNA, Anesthesiology';
  const phone = worker === 'josh' ? '7154996858' : '2625739095';
  const patientName = document.getElementById('fax-patient-name')?.value.trim()
    || [r['po-firstName']||'', r['po-lastName']||''].filter(Boolean).join(' ')
    || r['po-patient']||'';
  const dob = document.getElementById('fax-dob')?.value.trim()
    || (r['po-dob'] ? new Date(r['po-dob']+'T12:00:00Z').toLocaleDateString('en-US') : '');
  const surgDate = r['po-surgeryDate'] ? new Date(r['po-surgeryDate']+'T12:00:00Z').toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : '';
  const centerName = document.getElementById('fax-to')?.value.trim()
    || (window.surgeryCenters||window.surgeryCenters||[]).find(c=>c.id===r['po-surgery-center'])?.name
    || r['po-surgery-center']||'';
  const attn = document.getElementById('fax-attn')?.value.trim() || '';
  const pages = document.getElementById('fax-pages')?.value.trim() || '';

  return `<div style="font-family:Arial,sans-serif;font-size:12px;color:#000;line-height:1.4">
  <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
    <tr>
      <td style="width:50%;vertical-align:top;padding:8px 0">
        <div style="font-size:18px;font-weight:bold;color:#1d3557">Atlas Anesthesia</div>
        <div style="font-size:11px;color:#444;margin-top:2px">${providerName} | ${providerCreds}</div>
      </td>
      <td style="width:50%;vertical-align:middle;text-align:right;padding:8px 0">
        <div style="font-size:14px;font-weight:bold;color:#1d3557">Facsimile Transmission Cover Sheet</div>
      </td>
    </tr>
  </table>
  <hr style="border:none;border-top:2px solid #1d3557;margin:0 0 10px 0">
  <div style="background:#f8f8f8;border:1px solid #ccc;padding:8px 12px;font-size:10px;color:#555;margin-bottom:12px;line-height:1.5">
    <strong>Confidentiality Notice:</strong> This facsimile transmission contains confidential information, which may be legally privileged and is intended only for the use of the individual(s) named below. If you are not the intended recipient, you are hereby notified that any disclosure, copying, distribution, or action taken in reliance upon the contents of this transmission is strictly prohibited. If you have received this fax in error, please notify the sender immediately and destroy all copies.
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;width:130px">DATE:</td><td style="padding:5px 8px;border:1px solid #bbb">${today}</td><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;width:80px">TIME:</td><td style="padding:5px 8px;border:1px solid #bbb">${timeStr}</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">TO:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${centerName}</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">FAX TO:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${document.getElementById('fax-destination')?.value||''}</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">ATTN:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${attn}</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">FROM:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${providerName} — Atlas Anesthesia</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">FAX FROM:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">Atlas Anesthesia</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">PHONE:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${phone}</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">PAGES:</td><td style="padding:5px 8px;border:1px solid #bbb">${pages}</td><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">RE:</td><td style="padding:5px 8px;border:1px solid #bbb">Patient Medical Records Request</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">PATIENT NAME:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${patientName}</td></tr>
    <tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">DATE OF BIRTH:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${dob}</td></tr>
    ${surgDate ? `<tr><td style="padding:5px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">SURGERY DATE:</td><td style="padding:5px 8px;border:1px solid #bbb" colspan="3">${surgDate}</td></tr>` : ''}
  </table>
  <p style="color:#b91c1c;font-weight:bold;font-size:13px;margin:0 0 10px 0">⚠ Urgent — Please Respond ASAP</p>
  <p style="margin:0 0 8px 0">Dear,</p>
  <p style="margin:0 0 8px 0">We are writing on behalf of <strong>${providerName}</strong> at <strong>Atlas Anesthesia</strong> regarding the above-named patient who is scheduled for an upcoming anesthesia procedure at our facility. In order to ensure the safest and most comprehensive anesthesia care plan, we are respectfully requesting the following records be transmitted to our office at your earliest convenience — <strong>preferably as soon as possible</strong>.</p>
  <p style="margin:0 0 6px 0">Please fax the following documents for the patient listed above:</p>
  <ul style="margin:0 0 10px 20px;padding:0">
    <li style="margin-bottom:4px">Most recent <strong>History &amp; Physical (H&amp;P)</strong></li>
    <li style="margin-bottom:4px">Any and all applicable <strong>Laboratory Work / Lab Results</strong> (e.g., CBC, CMP, BMP, coagulation studies, or other relevant panels)</li>
    <li style="margin-bottom:4px">Any additional pertinent medical records relevant to anesthesia clearance</li>
  </ul>
  <p style="margin:0 0 8px 0">Timely receipt of these records is critical to our pre-operative assessment and scheduling process. If you have any questions or require a signed release of information form, please do not hesitate to contact our office directly.</p>
  <p style="margin:0 0 8px 0">We sincerely appreciate your prompt attention to this matter. Thank you for your cooperation.</p>
  <p style="margin:0 0 24px 0">Warm regards,</p>
  <div style="border-top:1px solid #000;width:220px;padding-top:4px;font-size:11px">
    ${providerName}<br>Atlas Anesthesia<br>Phone: ${phone}
  </div>
  <p style="font-size:9px;color:#666;margin-top:16px;border-top:1px solid #ccc;padding-top:6px">This fax is intended solely for the use of the individual or entity to which it is addressed and may contain information that is privileged, confidential, and/or exempt from disclosure under applicable law.</p>
</div>`;
}

window.checkHistoryDeposits = function checkHistoryDeposits(cases) {
  // stub — Stripe auto-check disabled
}
