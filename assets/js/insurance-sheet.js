// -- insurance-sheet.js — Insurance Claim email modal --------------------------
// Three modes (Josh Receipt / Flat Fee / CDT Codes) share the same recipient +
// send pipeline (/invoice → AWS SES via the Cloudflare Worker). Patient info is
// read off the selected pre-op record. Depends on: app.js for currentWorker,
// window.db/getDoc/setDoc/doc.

const FAX_WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev/fax';
const RETURN_FAX = {
  josh: '833-485-5191',
  dev:  '262-228-1623'
};

let _modalBuilt = false;
let _mode = 'cdt';            // 'cdt' (itemized D9222) | 'flat' (single Anesthesia Services line)

// Provider details printed on the Receipt sheet. Tax ID is shared (Atlas
// Anesthesia, LLC) — NPI and phone are individual to each CRNA.
const PROVIDER_INFO = {
  josh: {
    name:    'Joshua Condado, CRNA',
    phone:   '(715) 499-6858',
    npi:     '1861900201',
    taxId:   '41-4070944',
    sigPath: 'assets/signatures/josh.png'
  },
  dev: {
    name:    'Devarsh Murthy, CRNA',
    phone:   '(262) 573-9095',
    npi:     '1356864276',
    taxId:   '41-4070944',
    sigPath: 'assets/signatures/dev.png'
  }
};
function providerInfo() { return PROVIDER_INFO[workerNow()] || PROVIDER_INFO.dev; }

// ── Signature inlining (same treatment as preop-fax.js) ─────────────────────
// FaxAge / SES render this HTML in a sandbox that can't fetch relative asset
// URLs and doesn't honor mix-blend-mode + CSS filters. Pre-process the PNG
// once via canvas (near-white → transparent, ink → solid black) and cache
// the resulting base64 data URL so the receipt embeds the actual signature.
const _sigCache = {};
const _sigLoading = {};
function _ensureSignatureLoaded(worker) {
  const key = worker === 'dev' ? 'dev' : 'josh';
  if(_sigCache[key])   return Promise.resolve(_sigCache[key]);
  if(_sigLoading[key]) return _sigLoading[key];
  _sigLoading[key] = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height);
        const d = px.data;
        for(let i = 0; i < d.length; i += 4) {
          const bright = (d[i] + d[i+1] + d[i+2]) / 3;
          if(bright > 220) { d[i+3] = 0; }
          else { d[i] = 0; d[i+1] = 0; d[i+2] = 0; d[i+3] = Math.min(255, 255 - Math.round(bright)); }
        }
        ctx.putImageData(px, 0, 0);
        _sigCache[key] = c.toDataURL('image/png');
        resolve(_sigCache[key]);
      } catch(e) { reject(e); }
    };
    img.onerror = () => reject(new Error('sig load failed: ' + PROVIDER_INFO[key].sigPath));
    img.src = PROVIDER_INFO[key].sigPath;
  });
  return _sigLoading[key];
}
try {
  _ensureSignatureLoaded('josh').then(() => { if(typeof refreshPreview === 'function') refreshPreview(); }).catch(() => {});
  _ensureSignatureLoaded('dev').then(() => { if(typeof refreshPreview === 'function') refreshPreview(); }).catch(() => {});
} catch(_){}
function _sigSrcFor(worker) {
  const key = worker === 'dev' ? 'dev' : 'josh';
  return _sigCache[key] || PROVIDER_INFO[key].sigPath;
}
function _fmtInsTimestamp() {
  try {
    return new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Chicago'
    }).replace(',', ' ·') + ' CT';
  } catch(e) { return new Date().toISOString(); }
}

// Procedure codes from Josh's PDF form (Receipt/Insurance Claim Information)
const JOSH_PROCEDURES = [
  { code: '',       label: 'Dental Restoration' },
  { code: '',       label: 'Exam, Cleaning, X-Rays' },
  { code: 'D1510',  label: 'Space Maintainer Fixed Unilateral' },
  { code: 'D2332',  label: 'Resin Based Composite 3 Surfaces' },
  { code: 'D4266',  label: 'Guided Tissue Regeneration' },
  { code: 'D6010',  label: 'Surgical Placement Implant Body' },
  { code: 'D6104',  label: 'Bone Graft at Time of Implant Placement' },
  { code: 'D7140',  label: 'Dental Extractions' },
  { code: 'D7210',  label: 'Dental/Surgical Extractions' },
  { code: 'D7220',  label: 'Removal of Impacted Tooth Soft Tissue' },
  { code: 'D7230',  label: 'Removal of Impacted Tooth Partial Impacted' },
  { code: 'D7250',  label: 'Removal of Impacted Tooth Full Impacted' },
  { code: 'D7952',  label: 'Bone Replacement Graft For Ridge Preservation' }
];

// Anxiety/fear-related diagnosis codes (left column on PDF)
const JOSH_DIAGNOSES_BEHAVIORAL = [
  { code: 'F41.1',   label: 'Generalized Anxiety' },
  { code: 'F40.2',   label: 'Fear of Dental Care' },
  { code: 'F40.232', label: 'Fear of Medical Care' },
  { code: 'F40.231', label: 'Fear of Needle Sick' },
  { code: 'F40.240', label: 'Claustrophobia' },
  { code: 'R29.2',   label: 'Severe Abnormal Gag Reflex' }
];

// Medical diagnosis codes (right column on PDF)
const JOSH_DIAGNOSES_MEDICAL = [
  { code: 'K02.9',   label: 'Dental Caries' },
  { code: 'K04.0',   label: 'Acute Pulpitis' },
  { code: 'K026.2',  label: 'Dental Caries Extending Into Dentine' },
  { code: 'K04.8',   label: 'Periapical Abscess' },
  { code: 'F84.0',   label: 'Autistic Disorders' },
  { code: 'M26.3',   label: 'Anomaly of Erupted Tooth Position' },
  { code: 'F79',     label: 'Intellectual Disabilities Unspecified' },
  { code: 'F93.8',   label: 'Childhood Emotional Disorders' },
  { code: 'F41.9',   label: 'Anxiety' },
  { code: 'R56.9',   label: 'Seizure Disorder' },
  { code: 'J45',     label: 'Asthma' },
  { code: 'K01.0',   label: 'Embedded Teeth' },
  { code: 'K01.1',   label: 'Impacted Teeth' },
  { code: 'K03.81',  label: 'Cracked Teeth' }
];
// The pre-op record the modal is currently scoped to (chosen via dropdown).
// Until a case is selected, the form's patient fields render blank.
let _selectedPreop = null;

function $(id) { return document.getElementById(id); }

function workerNow() {
  return (typeof window.currentWorker !== 'undefined' ? window.currentWorker : null) || 'dev';
}
function providerName(w) {
  return w === 'josh' ? 'Joshua Condado, CRNA' : 'Devarsh Murthy, CRNA';
}
function todayIso() {
  return (typeof window.todayStr === 'function') ? window.todayStr() : new Date().toISOString().split('T')[0];
}
function fmtDate(iso) {
  if(!iso) return '';
  const parts = iso.split('-');
  if(parts.length !== 3) return iso;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

// Patient/case context — driven by the pre-op record the user picks in the
// dropdown. Note: Case ID is intentionally NOT exposed on the fax sheet, only
// used as the dropdown's internal handle for matching records.
function readCaseContext() {
  const r = _selectedPreop || {};
  // Pre-op stores the patient as po-patientFirstName / po-patientLastName /
  // po-patientDOB. Older records may also have legacy po-firstName etc., so we
  // fall back to those when the modern fields are blank.
  const first = r['po-patientFirstName'] || r['po-firstName'] || '';
  const last  = r['po-patientLastName']  || r['po-lastName']  || '';
  return {
    provider:  r['po-provider'] || '',
    procedure: r['po-procedureType'] || '',
    patientName: [first, last].filter(Boolean).join(' ').trim() || r['po-patient'] || '',
    patientDob:  r['po-patientDOB'] || r['po-dob'] || '',
    patientPhone: r['po-patientPhone'] || r['po-contact-phone'] || '',
    surgeryDate: r['po-surgeryDate'] || ''
  };
}

function preopChoices() {
  // Cases for the current logged-in worker with a saved Case ID. Most recent
  // surgery dates first.
  const records = window._rawPreopRecords || [];
  const cw = workerNow();
  return records
    .filter(r => (r.worker || 'dev') === cw)
    .filter(r => r['po-caseId'])
    .sort((a, b) => (b['po-surgeryDate']||'').localeCompare(a['po-surgeryDate']||''));
}

function populateCaseDropdown() {
  const sel = $('ins-case-select');
  if(!sel) return;
  const choices = preopChoices();
  sel.innerHTML = '<option value="">— Pick a case —</option>'
    + choices.map(r => {
        const name = [r['po-patientFirstName']||r['po-firstName']||'', r['po-patientLastName']||r['po-lastName']||'']
                    .filter(Boolean).join(' ').trim()
                  || r['po-patient'] || '';
        const date = r['po-surgeryDate'] ? fmtDate(r['po-surgeryDate']) : '';
        const bits = [r['po-caseId']];
        if(name) bits.push(name);
        if(date) bits.push(date);
        return `<option value="${r.id}">${bits.join(' · ')}</option>`;
      }).join('');
}

window._insOnCaseChange = function() {
  const sel = $('ins-case-select');
  if(!sel) return;
  const id = sel.value;
  const records = window._rawPreopRecords || [];
  _selectedPreop = records.find(r => r.id === id) || null;
  // Pre-fill recipient email from the selected patient's Pre-Op record.
  const emailInput = $('ins-recipient-email');
  if(emailInput) emailInput.value = (_selectedPreop?.['po-patientEmail'] || '').trim();
  // Re-render the form so Patient Name / DOB / Sex / Office Address auto-fill
  // from the newly-selected pre-op record.
  if(typeof window._insSetMode === 'function') window._insSetMode(_mode);
  refreshPreview();
};

function buildModal() {
  if(_modalBuilt) return;
  const wrap = document.createElement('div');
  wrap.id = 'insSheetModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px';
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:880px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 24px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:600">📋 Insurance Sheet</div>
          <div style="font-size:12px;opacity:.75;margin-top:2px">Anesthesia Receipt — pick CDT itemized or Flat Fee billing</div>
        </div>
        <button onclick="closeInsuranceSheetModal()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
      </div>

      <div style="padding:14px 24px;border-bottom:1px solid var(--border);background:#f8fafc">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Case <span style="color:var(--warn)">*</span></label>
        <select id="ins-case-select" onchange="window._insOnCaseChange()" style="width:100%;padding:9px 11px;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;font-weight:500">
          <option value="">— Pick a case —</option>
        </select>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;font-style:italic">Patient info will be pulled from whichever case is selected. (Case ID is hidden on the printed sheet.)</div>
      </div>

      <div style="padding:14px 24px;border-bottom:1px solid var(--border)">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Send Receipt To <span style="color:var(--warn)">*</span></label>
        <input type="email" id="ins-recipient-email" placeholder="patient@email.com" style="width:100%;padding:9px 11px;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;font-style:italic">Pre-fills from the patient's Pre-Op Deposit Email. You can edit before sending.</div>
      </div>

      <div style="padding:14px 24px;border-bottom:1px solid var(--border);background:#f8fafc;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">Billing Style</span>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
          <input type="radio" name="ins-mode" value="cdt" checked onchange="window._insSetMode('cdt')" style="margin:0"> CDT Codes (D9222 itemized)
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
          <input type="radio" name="ins-mode" value="flat" onchange="window._insSetMode('flat')" style="margin:0"> Flat Fee
        </label>
        <span style="font-size:11px;color:var(--text-faint);font-style:italic;margin-left:auto">Anesthesia Receipt template — only the billing line differs</span>
      </div>

      <div id="ins-form-area" style="padding:14px 24px;border-bottom:1px solid var(--border)">
        <!-- Filled in by setMode() based on Flat Fee vs CDT Codes -->
      </div>

      <div style="padding:10px 24px;border-bottom:1px solid var(--border)">${(typeof window.scheduleToggleHTML==='function')?window.scheduleToggleHTML('ins'):''}</div>

      <div style="padding:14px 24px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-faint)">Receipt will be emailed to the patient's Deposit Email on the Pre-Op record.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="closeInsuranceSheetModal()">Cancel</button>
          <button id="ins-download-btn" class="btn btn-ghost" onclick="window._insDownloadPDF()" style="color:#1d3557;border-color:#1d3557">⬇ Download PDF</button>
          <button id="ins-send-btn" class="btn btn-primary" onclick="window._insSend()" style="background:#1d3557;border-color:#1d3557">📧 Email Receipt to Patient</button>
        </div>
      </div>

      <div style="padding:20px 24px;background:#f4f4f4">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#666;margin-bottom:10px">EMAIL PREVIEW</div>
        <div id="ins-preview" style="background:#fff;border:1px solid #ccc;border-radius:4px;padding:24px;font-family:Arial,sans-serif;font-size:11px;color:#000;max-width:760px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.08)"></div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  _modalBuilt = true;
}

// ── Placeholder forms for each mode — replace with real fields once the PDFs
// are shared. Both modes need at least: patient info, case info, fee total.

function renderReceiptForm() {
  // Defaults for patient/office fields come from the selected pre-op record.
  // The user can override before sending if the chart is out of date.
  const ctx = readCaseContext();
  // Look the surgery center up so we can:
  //   1) Fall back its saved `address` when po-officeAddress is empty on the
  //      pre-op (older records that never had it stamped).
  //   2) Show the center name as a Location label on the form, since that's
  //      what Oliver reads as "location" on the paper sheet.
  const _centerId = _selectedPreop?.['po-surgery-center'] || '';
  const _center   = (window.surgeryCenters || []).find(c => c.id === _centerId) || null;
  const defaultOffice = _selectedPreop?.['po-officeAddress']
    || _selectedPreop?.['po-dentistAddress']
    || _center?.address
    || '';
  const _subLoc = _selectedPreop?.['po-surgery-center-location'] || '';
  const defaultLocationName = _center
    ? _center.name + (_subLoc ? ' (' + _subLoc + ')' : '')
    : (_selectedPreop?.['po-surgeryCenterName'] || '');
  const defaultSex = _selectedPreop?.['po-sex'] || '';
  const defaultName = (ctx.patientName || '').replace(/"/g,'&quot;');
  const defaultDob  = ctx.patientDob || '';
  const defaultProvider = (ctx.provider || '').replace(/"/g,'&quot;');
  const defaultSurgeryDate = ctx.surgeryDate || '';
  const procRows = JOSH_PROCEDURES.map(p =>
    `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0">
      <input type="checkbox" class="ins-jr-proc" data-code="${p.code}" data-label="${p.label.replace(/"/g,'&quot;')}" oninput="window._insPreview()" style="margin:0;flex-shrink:0">
      <span><strong style="font-family:'DM Mono',monospace">${p.code||''}</strong>${p.code?' ':''}${p.label}</span>
    </label>`
  ).join('');
  const behavioralRows = JOSH_DIAGNOSES_BEHAVIORAL.map(d =>
    `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0">
      <input type="checkbox" class="ins-jr-dx" data-code="${d.code}" data-label="${d.label.replace(/"/g,'&quot;')}" data-group="behavioral" oninput="window._insPreview()" style="margin:0;flex-shrink:0">
      <span><strong style="font-family:'DM Mono',monospace">${d.code}</strong> ${d.label}</span>
    </label>`
  ).join('');
  const medicalRows = JOSH_DIAGNOSES_MEDICAL.map(d =>
    `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0">
      <input type="checkbox" class="ins-jr-dx" data-code="${d.code}" data-label="${d.label.replace(/"/g,'&quot;')}" data-group="medical" oninput="window._insPreview()" style="margin:0;flex-shrink:0">
      <span><strong style="font-family:'DM Mono',monospace">${d.code}</strong> ${d.label}</span>
    </label>`
  ).join('');
  return `
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">Anesthesia Receipt / Insurance Claim Form</div>

    <div style="display:grid;grid-template-columns:1fr 140px 130px;gap:10px;margin-bottom:10px;padding:10px;background:#f8fafc;border:1px solid var(--border);border-radius:6px;align-items:end">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Patient Name <span style="font-size:10px;color:var(--text-faint);font-style:italic">(pre-fills from case)</span></label>
        <input type="text" id="ins-jr-patient-name" value="${defaultName}" oninput="window._insPreview()" placeholder="e.g. John Smith" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);box-sizing:border-box;height:30px">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">DOB</label>
        <input type="date" id="ins-jr-patient-dob" value="${defaultDob}" oninput="window._insPreview()" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);box-sizing:border-box;height:30px">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Sex</label>
        <div id="ins-jr-sex-group" style="display:inline-flex;align-items:stretch;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:#fff;font-size:13px;font-weight:500;height:30px;line-height:1;width:100%">
          <label style="flex:1;display:flex;align-items:center;justify-content:center;min-width:44px;padding:0;cursor:pointer;border-right:1px solid var(--border);user-select:none;margin:0;background:${defaultSex==='M'?'#1d3557':'#fff'};color:${defaultSex==='M'?'#fff':'var(--text)'}" onclick="this.parentNode.querySelectorAll('label').forEach(l=>{l.style.background='#fff';l.style.color='var(--text)'});this.style.background='#1d3557';this.style.color='#fff';this.querySelector('input').checked=true;window._insPreview()">
            <input type="radio" name="ins-jr-sex" value="M" ${defaultSex==='M'?'checked':''} style="display:none"><span>M</span>
          </label>
          <label style="flex:1;display:flex;align-items:center;justify-content:center;min-width:44px;padding:0;cursor:pointer;user-select:none;margin:0;background:${defaultSex==='F'?'#1d3557':'#fff'};color:${defaultSex==='F'?'#fff':'var(--text)'}" onclick="this.parentNode.querySelectorAll('label').forEach(l=>{l.style.background='#fff';l.style.color='var(--text)'});this.style.background='#1d3557';this.style.color='#fff';this.querySelector('input').checked=true;window._insPreview()">
            <input type="radio" name="ins-jr-sex" value="F" ${defaultSex==='F'?'checked':''} style="display:none"><span>F</span>
          </label>
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:140px 1fr;gap:10px;margin-bottom:10px;padding:10px;background:#f8fafc;border:1px solid var(--border);border-radius:6px">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Date of Service</label>
        <input type="date" id="ins-jr-surgery-date" value="${defaultSurgeryDate}" oninput="window._insPreview()" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);box-sizing:border-box;height:30px">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Dentist</label>
        <input type="text" id="ins-jr-provider" value="${defaultProvider}" oninput="window._insPreview()" placeholder="e.g. Dr. Smith" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);box-sizing:border-box;height:30px">
      </div>
    </div>
    <div style="margin-bottom:14px;padding:10px;background:#f8fafc;border:1px solid var(--border);border-radius:6px">
      <div style="display:grid;grid-template-columns:1fr;gap:8px">
        ${defaultLocationName ? `<div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Surgery Location <span style="font-size:10px;color:var(--text-faint);font-style:italic">(pre-fills from case)</span></label>
          <input type="text" id="ins-jr-location-name" value="${defaultLocationName.replace(/"/g,'&quot;')}" oninput="window._insPreview()" placeholder="e.g. Bay Oral Surgery Center (West)" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);box-sizing:border-box;height:30px">
        </div>` : ''}
        <div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Dentist Office Address ${_center?.address ? '<span style="font-size:10px;color:var(--text-faint);font-style:italic">(pulled from surgery center)</span>' : ''}</label>
          <input type="text" id="ins-jr-office-address" value="${defaultOffice.replace(/"/g,'&quot;')}" oninput="window._insPreview()" placeholder="e.g. 123 Main St, Green Bay, WI 54301" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);box-sizing:border-box;height:30px">
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;margin-bottom:14px">
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px;border-bottom:1px solid var(--border);padding-bottom:3px">Procedure Performed</div>
        ${procRows}
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;margin-top:4px">
          <input type="checkbox" id="ins-jr-other-cb" oninput="window._insPreview()" style="margin:0">
          <span>Other:</span>
          <input type="text" id="ins-jr-other-text" oninput="document.getElementById('ins-jr-other-cb').checked=!!this.value;window._insPreview()" placeholder="e.g. Gum Graft (00170)" style="flex:1;padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
        </label>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px;border-bottom:1px solid var(--border);padding-bottom:3px">Diagnosis Codes (Behavioral)</div>
        ${behavioralRows}
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px;border-bottom:1px solid var(--border);padding-bottom:3px">Diagnosis Codes (Medical)</div>
        ${medicalRows}
      </div>
    </div>
    ${_mode === 'flat' ? `
    <div style="display:grid;grid-template-columns:1fr 130px;gap:12px;padding:12px;background:#f8fafc;border:1px solid var(--border);border-radius:6px">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Anesthesia Services Description</label>
        <input type="text" id="ins-jr-flat-desc" value="General Anesthesia for Dental Procedure" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Flat Fee Amount ($)</label>
        <input type="number" id="ins-jr-flat-amount" min="0" step="0.01" value="1200" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);font-family:'DM Mono',monospace">
      </div>
    </div>
    ` : `
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;padding:12px;background:#f8fafc;border:1px solid var(--border);border-radius:6px">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">D9222 15-min Units</label>
        <input type="number" id="ins-jr-units" min="1" max="20" value="4" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Charge per 15-min Unit</label>
        <input type="number" id="ins-jr-per-unit" min="0" step="0.01" value="240" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Medical 00170 (Min)</label>
        <input type="number" id="ins-jr-medical-min" min="0" step="1" value="0" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)" placeholder="Optional">
      </div>
    </div>
    `}

  `;
}

// (Removed renderFlatFeeForm, renderCdtForm, renderCdtLineRow, recalcCdt
//  and their _insAddCdtLine / _insRemoveCdtLine / _insCdtRecalc helpers —
//  the modal now uses a single Anesthesia Receipt template with a billing
//  sub-toggle (CDT itemized vs Flat Fee single line).)

window._insSetMode = function(mode) {
  // Only two modes now: 'cdt' (itemized D9222) and 'flat' (single Anesthesia
  // Services line). Both render the same Anesthesia Receipt template —
  // renderReceiptForm branches its billing-input block on _mode.
  _mode = (mode === 'flat') ? 'flat' : 'cdt';
  const area = $('ins-form-area');
  if(!area) return;
  area.innerHTML = renderReceiptForm();
  refreshPreview();
};

function buildJoshReceiptHTML() {
  const ctx = readCaseContext();
  const today = todayIso();

  // Collect checked procedures
  const procChecks = Array.from(document.querySelectorAll('.ins-jr-proc'));
  const checkedProc = new Set(procChecks.filter(c => c.checked).map(c => c.dataset.code + '|' + c.dataset.label));
  const otherCb = $('ins-jr-other-cb');
  const otherText = $('ins-jr-other-text')?.value.trim() || '';
  const otherChecked = otherCb?.checked && otherText;

  // Collect checked diagnoses
  const dxChecks = Array.from(document.querySelectorAll('.ins-jr-dx'));
  const checkedDx = new Set(dxChecks.filter(c => c.checked).map(c => c.dataset.code));

  // Patient Name / DOB are now editable in the form — fall back to ctx if the
  // form fields don't exist yet (e.g. on first render before the form mounts).
  const formName = $('ins-jr-patient-name')?.value.trim();
  const formDob  = $('ins-jr-patient-dob')?.value.trim();
  const patientName = formName || ctx.patientName || '';
  const patientDob  = formDob  || ctx.patientDob  || '';

  let subtotalCharges = 0;
  let units = 0, perUnit = 0, medMin = 0, medUnits = 0;
  let flatDesc = '', flatAmount = 0;
  if(_mode === 'flat') {
    flatDesc   = $('ins-jr-flat-desc')?.value.trim() || 'Anesthesia Services';
    flatAmount = parseFloat($('ins-jr-flat-amount')?.value) || 0;
    subtotalCharges = flatAmount;
  } else {
    units    = parseInt($('ins-jr-units')?.value, 10) || 0;
    perUnit  = parseFloat($('ins-jr-per-unit')?.value) || 0;
    medMin   = parseInt($('ins-jr-medical-min')?.value, 10) || 0;
    medUnits = medMin ? (medMin / 12) : 0;
    subtotalCharges = units * perUnit;
  }
  const total = subtotalCharges;

  const sexFromDob = document.querySelector('input[name="ins-jr-sex"]:checked')?.value || '';
  const dentistOffice = $('ins-jr-office-address')?.value.trim() || '';
  const locationName  = $('ins-jr-location-name')?.value.trim()  || '';
  const dentistName = $('ins-jr-provider')?.value.trim() || ctx.provider || '';
  const serviceDate = $('ins-jr-surgery-date')?.value.trim() || ctx.surgeryDate || '';

  // Procedure rows: render every item with a ☐ or ☒
  const renderProcRow = (p) => {
    const key = p.code + '|' + p.label;
    const isChecked = checkedProc.has(key);
    const box = isChecked ? '☒' : '☐';
    return `<div style="font-size:10.5px;padding:1px 0;line-height:1.35"><span style="font-family:Arial,sans-serif;font-size:13px;display:inline-block;width:14px">${box}</span>${p.code ? `<strong style="font-family:'DM Mono',monospace">${p.code}</strong> ` : ''}${p.label}</div>`;
  };
  const renderDxRow = (d) => {
    const isChecked = checkedDx.has(d.code);
    const box = isChecked ? '☒' : '☐';
    return `<div style="font-size:10.5px;padding:1px 0;line-height:1.35"><span style="font-family:Arial,sans-serif;font-size:13px;display:inline-block;width:14px">${box}</span><strong style="font-family:'DM Mono',monospace">${d.code}</strong> ${d.label}</div>`;
  };

  const procHtml = JOSH_PROCEDURES.map(renderProcRow).join('') +
    `<div style="font-size:10.5px;padding:1px 0;line-height:1.35"><span style="font-family:Arial,sans-serif;font-size:13px;display:inline-block;width:14px">${otherChecked ? '☒' : '☐'}</span>Other: <span style="border-bottom:1px solid #555;display:inline-block;min-width:120px;padding:0 3px">${otherText || '&nbsp;'}</span></div>`;
  const dxBehavioralHtml = JOSH_DIAGNOSES_BEHAVIORAL.map(renderDxRow).join('');
  const dxMedicalHtml = JOSH_DIAGNOSES_MEDICAL.map(renderDxRow).join('');

  // Billing rows — branch on mode.
  //  CDT  → itemized D9222 rows (one per 15-min unit), PDF-style table.
  //  Flat → single "Anesthesia Services" row, no CDT code referenced.
  const billingRows = [];
  if(_mode === 'flat') {
    billingRows.push(`
      <tr>
        <td style="padding:6px 6px;border-bottom:1px solid #999;font-size:10.5px">&nbsp;</td>
        <td style="padding:6px 6px;border-bottom:1px solid #999;font-size:10.5px">${flatDesc || 'Anesthesia Services'}</td>
        <td style="padding:6px 6px;border-bottom:1px solid #999;text-align:center;font-size:10.5px">—</td>
        <td style="padding:6px 6px;border-bottom:1px solid #999;text-align:right;font-family:'DM Mono',monospace;font-size:10.5px">$${flatAmount.toFixed(2)}</td>
      </tr>
    `);
  } else {
    for(let i = 0; i < Math.max(units, 14); i++) {
      if(i < units) {
        billingRows.push(`
          <tr>
            <td style="padding:3px 6px;border-bottom:1px solid #999;font-family:'DM Mono',monospace;font-size:10.5px">D9222</td>
            <td style="padding:3px 6px;border-bottom:1px solid #999;font-size:10.5px">General Anesthesia First 15 Minutes</td>
            <td style="padding:3px 6px;border-bottom:1px solid #999;text-align:center;font-size:10.5px">1 unit</td>
            <td style="padding:3px 6px;border-bottom:1px solid #999;text-align:right;font-family:'DM Mono',monospace;font-size:10.5px">$${perUnit.toFixed(2)}</td>
          </tr>
        `);
      } else {
        billingRows.push(`
          <tr>
            <td style="padding:3px 6px;border-bottom:1px solid #999;font-family:'DM Mono',monospace;color:#bbb;font-size:10.5px">D9222</td>
            <td style="padding:3px 6px;border-bottom:1px solid #999;color:#bbb;font-size:10.5px">General Anesthesia First 15 Minutes</td>
            <td style="padding:3px 6px;border-bottom:1px solid #999;text-align:center;color:#bbb;font-size:10.5px">1 unit</td>
            <td style="padding:3px 6px;border-bottom:1px solid #999;text-align:right;color:#bbb;font-size:10.5px">Charges $______</td>
          </tr>
        `);
      }
    }
  }

  const field = (lbl, val, width) => `<div style="display:inline-block;margin-right:14px;margin-bottom:5px;font-size:11px"><span style="font-weight:700">${lbl}:</span> <span style="border-bottom:1px solid #555;display:inline-block;min-width:${width||120}px;padding:0 4px">${val||'&nbsp;'}</span></div>`;

  const pInfo = providerInfo();
  return `
    <div style="text-align:center;border-bottom:2px solid #1d3557;padding-bottom:10px;margin-bottom:14px">
      <div style="font-size:22px;font-weight:bold;letter-spacing:1px;color:#1d3557">Atlas Anesthesia, LLC</div>
      <div style="font-size:10.5px;margin-top:4px;color:#333">Federal Tax ID #${pInfo.taxId} &nbsp;·&nbsp; NPI #${pInfo.npi}</div>
      <div style="font-size:10.5px;margin-top:2px;color:#333">${pInfo.name} &nbsp;·&nbsp; ${pInfo.phone}</div>
    </div>

    <div style="text-align:center;font-size:14px;font-weight:bold;letter-spacing:.8px;margin-bottom:12px;color:#1d3557">RECEIPT / INSURANCE CLAIM INFORMATION</div>

    <div style="margin-bottom:10px">
      ${field('Date of Service', serviceDate ? fmtDate(serviceDate) : '', 110)}
      ${field('Patient Name', patientName, 200)}
    </div>
    <div style="margin-bottom:10px">
      ${field('DOB', patientDob ? fmtDate(patientDob) : '', 110)}
      ${field('Sex', sexFromDob, 60)}
      ${field('Dentist', dentistName, 200)}
    </div>
    ${locationName ? `<div style="margin-bottom:6px">
      ${field('Surgery Location', locationName, 400)}
    </div>` : ''}
    <div style="margin-bottom:14px">
      ${field('Dentist Office Address', dentistOffice, 400)}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;border:1px solid #aaa;padding:10px;margin-bottom:14px;background:#fafafa">
      <div>
        <div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;color:#1d3557;border-bottom:1px solid #1d3557;padding-bottom:3px;margin-bottom:5px">Procedure Performed</div>
        ${procHtml}
      </div>
      <div>
        <div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;color:#1d3557;border-bottom:1px solid #1d3557;padding-bottom:3px;margin-bottom:5px">Diagnosis Codes (Behavioral)</div>
        ${dxBehavioralHtml}
      </div>
      <div>
        <div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;color:#1d3557;border-bottom:1px solid #1d3557;padding-bottom:3px;margin-bottom:5px">Diagnosis Code (Medical)</div>
        ${dxMedicalHtml}
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
      <thead>
        <tr style="background:#1d3557;color:#fff">
          <th style="padding:5px 6px;text-align:left;font-size:10.5px;width:70px">Code</th>
          <th style="padding:5px 6px;text-align:left;font-size:10.5px">Description</th>
          <th style="padding:5px 6px;text-align:center;font-size:10.5px;width:80px">Units</th>
          <th style="padding:5px 6px;text-align:right;font-size:10.5px;width:90px">Charges</th>
        </tr>
      </thead>
      <tbody>
        ${billingRows.join('')}
      </tbody>
    </table>

    ${_mode === 'flat' ? '' : `<div style="border:1px solid #999;padding:6px 10px;font-size:10.5px;margin-bottom:10px">
      Medical Anesthesia Billing Code <strong>00170</strong> Intra-oral Procedure &nbsp;5 units&nbsp;+&nbsp;
      <span style="border-bottom:1px solid #555;display:inline-block;min-width:40px;padding:0 4px;text-align:center">${medMin || '&nbsp;'}</span>
      &nbsp;minutes / 12 =&nbsp;
      <span style="border-bottom:1px solid #555;display:inline-block;min-width:40px;padding:0 4px;text-align:center">${medUnits ? medUnits.toFixed(2) : '&nbsp;'}</span>
      &nbsp;Time Units
    </div>`}

    <div style="background:#1d3557;color:#fff;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:bold;margin-bottom:14px">
      <span>TOTAL CHARGES</span>
      <span style="font-family:'DM Mono',monospace;font-size:15px">$${total.toFixed(2)}</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 200px;gap:18px;align-items:end;margin-top:18px">
      <div>
        <div style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase;margin-bottom:2px">Signed</div>
        <img src="${_sigSrcFor(workerNow())}" style="height:78px;display:block" alt="Signature" onerror="this.style.display='none'">
        <div style="border-top:1px solid #000;width:240px;font-size:10px;padding-top:2px;margin-top:2px">${pInfo.name} · Atlas Anesthesia, LLC</div>
      </div>
      <div style="text-align:right;font-size:10px;color:#555">
        <div>DATE: <span style="border-bottom:1px solid #888;padding:0 6px">${fmtDate(today)}</span></div>
        <div style="margin-top:4px;font-size:9px;color:#666;font-style:italic">Sent: ${_fmtInsTimestamp()}</div>
      </div>
    </div>

    <div style="margin-top:14px;background:#fdecec;border:1px solid #f5b5b5;border-radius:3px;padding:6px 10px;font-size:9px;color:#444;line-height:1.4">
      <strong style="color:#a13030">CONFIDENTIALITY &amp; AUTHORIZATION NOTICE</strong><br>
      This receipt contains protected health information privileged and confidential under HIPAA and applicable state law. It is intended only for the addressee. If you received this email in error, please notify Atlas Anesthesia immediately and destroy all copies.
    </div>

    <div style="margin-top:8px;font-size:9px;color:#888;text-align:center">Atlas Anesthesia, LLC · Receipt / Insurance Claim</div>
  `;
}

function buildPreviewHTML() {
  // Single Anesthesia Receipt template now drives both CDT and Flat modes —
  // only the billing block inside differs. The old standalone fallback
  // template has been removed.
  return buildJoshReceiptHTML();
}

function refreshPreview() {
  const el = $('ins-preview');
  if(el) el.innerHTML = buildPreviewHTML();
}
window._insPreview = refreshPreview;

// Render the current preview as a PDF (Letter, portrait). Returns a jsPDF doc.
async function _insBuildPDF() {
  if(typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
    throw new Error('PDF libraries (jsPDF / html2canvas) are not loaded.');
  }
  const src = $('ins-preview');
  if(!src) throw new Error('No preview to export.');
  // Snapshot at 2x for a crisper PDF
  const canvas = await window.html2canvas(src, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
  const imgData = canvas.toDataURL('image/jpeg', 0.92);
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation:'portrait', unit:'pt', format:'letter' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const availW = pageW - margin * 2;
  const imgRatio = canvas.height / canvas.width;
  const imgW = availW;
  const imgH = availW * imgRatio;
  // If the rendered receipt is taller than one page, split across pages.
  if(imgH <= pageH - margin * 2) {
    pdf.addImage(imgData, 'JPEG', margin, margin, imgW, imgH);
  } else {
    const pageContentH = pageH - margin * 2;
    let yOffset = 0;
    while(yOffset < imgH) {
      pdf.addImage(imgData, 'JPEG', margin, margin - yOffset, imgW, imgH);
      yOffset += pageContentH;
      if(yOffset < imgH) pdf.addPage();
    }
  }
  return pdf;
}

function _insPDFFilename() {
  const ctx = readCaseContext();
  const safe = (s) => (s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const name = safe(ctx.patientName) || 'patient';
  const date = ctx.surgeryDate || todayIso();
  return `Atlas-Anesthesia-Receipt_${name}_${date}.pdf`;
}

window._insDownloadPDF = async function() {
  if(!_selectedPreop) {
    alert('Pick a case from the dropdown at the top before downloading.');
    return;
  }
  const btn = $('ins-download-btn');
  const origLabel = btn?.textContent;
  if(btn) { btn.textContent = 'Generating...'; btn.disabled = true; }
  try {
    try { await _ensureSignatureLoaded(workerNow()); refreshPreview(); } catch(_){}
    const pdf = await _insBuildPDF();
    pdf.save(_insPDFFilename());
  } catch(e) {
    if(typeof window.toastError === 'function') window.toastError('PDF generation failed: ' + e.message, { persist: true });
    else alert('PDF generation failed: ' + e.message);
  } finally {
    if(btn) { btn.textContent = origLabel || '⬇ Download PDF'; btn.disabled = false; }
  }
};

window.openInsuranceSheetModal = function() {
  buildModal();
  // Reset transient fields each open
  // Always default back to Josh's Receipt Form on open
  document.querySelectorAll('input[name="ins-mode"]').forEach(r => r.checked = (r.value === 'cdt'));
  _mode = 'cdt';
  window._insSetMode('cdt');
  // Refresh + pre-select the case the user is currently finalizing.
  populateCaseDropdown();
  const formCaseId = $('caseId')?.value || $('caseId-display')?.textContent?.trim() || '';
  const records = window._rawPreopRecords || [];
  const cw = workerNow();
  const match = formCaseId
    ? records.find(r => r['po-caseId'] === formCaseId && (r.worker || 'dev') === cw)
    : null;
  const sel = $('ins-case-select');
  if(match && sel) {
    sel.value = match.id;
    _selectedPreop = match;
  } else {
    if(sel) sel.value = '';
    _selectedPreop = null;
  }
  const emailInput = $('ins-recipient-email');
  if(emailInput) emailInput.value = (_selectedPreop?.['po-patientEmail'] || '').trim();
  $('insSheetModal').style.display = 'flex';
  refreshPreview();
};

window.closeInsuranceSheetModal = function() {
  const m = $('insSheetModal');
  if(m) m.style.display = 'none';
};

// Append a record of the just-sent insurance fax to the global history log
// (atlas/insurance_log). Best-effort — a logging failure shouldn't fail the
// already-completed fax send.
async function logSentInsurance(entry) {
  if(typeof window.getDoc !== 'function') return;
  try {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'insurance_log'));
    const entries = snap.exists() ? (snap.data().entries || []) : [];
    entries.unshift(entry);
    await window.setDoc(window.doc(window.db, 'atlas', 'insurance_log'), { entries });
  } catch(e) {
    console.warn('logSentInsurance:', e);
  }
}

window._insSend = async function() {
  if(!_selectedPreop) {
    alert('Pick a case from the dropdown at the top before sending the email.');
    const sel = $('ins-case-select');
    if(sel) sel.focus();
    return;
  }
  const emailInput = $('ins-recipient-email');
  const email = (emailInput?.value || '').trim();
  if(!email) { alert('Please enter the email address to send this receipt to.'); emailInput?.focus(); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('That email address looks invalid: ' + email); emailInput?.focus(); return; }

  const btn = $('ins-send-btn');
  const origLabel = btn?.textContent;
  if(btn) { btn.textContent = 'Sending...'; btn.disabled = true; }

  try {
    // Bake the current worker's signature into the cache before we
    // build the HTML so the recipient's copy has the inlined image.
    // Then re-render the preview so the DOM snapshot picked up by
    // _insBuildPDF() (via html2canvas) also has the processed image.
    try { await _ensureSignatureLoaded(workerNow()); refreshPreview(); } catch(_){}
    const html = buildPreviewHTML();
    const w = workerNow();
    const caseId = _selectedPreop['po-caseId'] || '';
    const ctx = readCaseContext();
    const recipientLabel = ctx.patientName || 'patient';
    // Generate the receipt as a PDF and attach it to the email.
    let pdfBase64 = '', pdfFilename = '';
    try {
      const pdf = await _insBuildPDF();
      pdfFilename = _insPDFFilename();
      // jsPDF datauristring format: "data:application/pdf;filename=...;base64,XXXX"
      const dataUri = pdf.output('datauristring');
      pdfBase64 = dataUri.split('base64,')[1] || '';
    } catch(pdfErr) {
      console.warn('PDF attachment generation failed:', pdfErr);
      // Fall through — worker will send HTML-only if pdfBase64 is empty.
    }
    // Use the existing /invoice email endpoint on the worker. It now also
    // accepts { pdfBase64, pdfFilename } to attach a PDF receipt via SES.
    const INVOICE_URL = FAX_WORKER_URL.replace('/fax', '/invoice');
    const rsp = await fetch(INVOICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: email,
        invoiceNum: 'Anesthesia Receipt — ' + (caseId || recipientLabel),
        html,
        pdfBase64,
        pdfFilename
      })
    });
    const data = await rsp.json();
    if(rsp.ok && data.success) {
      // Build a compact log entry of what was sent. Total is best-effort.
      let total = 0;
      if(_mode === 'flat') {
        total = parseFloat($('ins-jr-flat-amount')?.value) || 0;
      } else {
        const units   = parseInt($('ins-jr-units')?.value, 10) || 0;
        const perUnit = parseFloat($('ins-jr-per-unit')?.value) || 0;
        total = units * perUnit;
      }
      await logSentInsurance({
        id: Math.random().toString(36).slice(2, 11),
        sentAt: new Date().toISOString(),
        worker: w,
        mode: _mode,
        caseId,
        patientName: ctx.patientName,
        surgeryDate: ctx.surgeryDate,
        recipient: recipientLabel,
        recipientEmail: email,
        total,
        html
      });
      try { window.logAudit && window.logAudit('insurance-email-sent', caseId, `to ${recipientLabel} <${email}>`); } catch(e){}
      if(typeof window.toastSuccess === 'function') window.toastSuccess('Receipt emailed to ' + email);
      else alert('✅ Receipt emailed to ' + email);
      window.closeInsuranceSheetModal();
    } else {
      const errMsg = data.error || 'Unknown error';
      if(typeof window.toastError === 'function') window.toastError('Insurance email failed: ' + errMsg, { persist: true });
      else alert('❌ Insurance email failed: ' + errMsg);
    }
  } catch(e) {
    if(typeof window.toastError === 'function') window.toastError('Error sending email: ' + e.message, { persist: true });
    else alert('❌ Error sending email: ' + e.message);
  } finally {
    if(btn) { btn.textContent = origLabel || '📧 Email Receipt to Patient'; btn.disabled = false; }
  }
};

// ── Insurance Sheet History modal ──────────────────────────────────────────
// Loads atlas/insurance_log on open and lists every fax this worker has sent,
// most recent first. Click "View" on a row to re-display the original HTML
// in a read-only viewer.
let _historyModalBuilt = false;

function buildHistoryModal() {
  if(_historyModalBuilt) return;
  const wrap = document.createElement('div');
  wrap.id = 'insHistoryModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px';
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:920px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#7c3aed;color:#fff;padding:18px 24px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:600">📜 Insurance Sheet History</div>
          <div style="font-size:12px;opacity:.85;margin-top:2px">All insurance faxes you've sent, most recent first</div>
        </div>
        <button onclick="closeInsuranceHistoryModal()" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
      </div>
      <div id="ins-history-list" style="padding:14px 24px;max-height:60vh;overflow-y:auto"></div>
    </div>
    <div id="insHistoryViewer" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px">
      <div style="background:#fff;border-radius:var(--radius);width:100%;max-width:780px;box-shadow:0 20px 60px rgba(0,0,0,.4);margin:auto;padding:24px;position:relative">
        <button onclick="document.getElementById('insHistoryViewer').style.display='none'" style="position:absolute;top:14px;right:14px;background:#1d3557;border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
        <div id="ins-history-viewer-body" style="font-family:Arial,sans-serif;font-size:11px;color:#000"></div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  _historyModalBuilt = true;
}

async function loadHistoryRows() {
  const list = $('ins-history-list');
  if(!list) return;
  list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint)">Loading…</div>';
  let entries = [];
  try {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'insurance_log'));
    entries = snap.exists() ? (snap.data().entries || []) : [];
  } catch(e) {
    list.innerHTML = `<div style="padding:20px;color:var(--warn)">Could not load history: ${e.message}</div>`;
    return;
  }
  const w = workerNow();
  entries = entries.filter(e => (e.worker || 'dev') === w);
  if(!entries.length) {
    list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint)">No insurance sheets sent yet.</div>';
    return;
  }
  // Stash entries on the list element so the View buttons can pull them by id
  list._entries = entries;
  list.innerHTML = `
    <div style="display:grid;grid-template-columns:120px 110px 1fr 1fr 90px 90px 60px;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
      <span>Sent</span><span>Case ID</span><span>Patient</span><span>Recipient</span><span>Type</span><span>Total</span><span></span>
    </div>
    ${entries.map(e => {
      const date = new Date(e.sentAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
      const mode = e.mode === 'flat' ? 'Flat Fee' : 'CDT';
      const total = e.total ? '$'+Number(e.total).toFixed(2) : '—';
      const insPhiHidden = typeof window.isPHIHidden === 'function' && window.isPHIHidden(e.surgeryDate, e.caseId);
      const insPatient = insPhiHidden ? '<span style="color:#94a3b8;font-style:italic">[hidden]</span>' : (e.patientName || '—');
      const insLock = insPhiHidden ? '<span style="background:#f1f5f9;color:#64748b;font-size:9px;font-weight:600;padding:1px 6px;border-radius:8px;margin-left:6px" title="Patient details hidden — case is 3+ days old">🔒</span>' : '';
      return `
        <div style="display:grid;grid-template-columns:120px 110px 1fr 1fr 90px 90px 60px;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:center">
          <span style="color:var(--text-muted)">${date}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px">${e.caseId || '—'}${insLock}</span>
          <span style="font-weight:500">${insPatient}</span>
          <span>${e.recipient || '—'}<div style="font-size:10px;color:var(--text-faint);font-family:'DM Mono',monospace">${e.faxNumber || ''}</div></span>
          <span><span style="background:${e.mode==='cdt'?'#ddd6fe':'#fef3c7'};color:${e.mode==='cdt'?'#5b21b6':'#92400e'};font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px">${mode}</span></span>
          <span style="font-family:'DM Mono',monospace;font-weight:500">${total}</span>
          <span><button onclick="window._insViewHistory('${e.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">View</button></span>
        </div>
      `;
    }).join('')}
  `;
}

window._insViewHistory = function(id) {
  const list = $('ins-history-list');
  const entries = list?._entries || [];
  const e = entries.find(x => x.id === id);
  if(!e) { alert('Entry not found.'); return; }
  const body = $('ins-history-viewer-body');
  if(body) body.innerHTML = e.html || '<div style="padding:20px;text-align:center;color:#888">No content stored for this entry.</div>';
  $('insHistoryViewer').style.display = 'flex';
};

window.openInsuranceHistoryModal = function() {
  buildHistoryModal();
  $('insHistoryModal').style.display = 'flex';
  loadHistoryRows();
};
window.closeInsuranceHistoryModal = function() {
  const m = $('insHistoryModal');
  if(m) m.style.display = 'none';
};
