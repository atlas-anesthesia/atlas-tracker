// -- preop-fax.js — "SEND PRE-OP FAX" modal + sender ---------------------------
// Self-contained module that injects the modal on first open. Pulls patient
// info from the currently-loaded Pre-Op form, lets the user pick records/labs/
// tests to request, previews the cover sheet, and sends it via the same
// FaxAge-backed Cloudflare Worker the existing fax modal uses. On a successful
// send it auto-checks the "Schedule through Bellin" status box.

const FAX_WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev/fax';
const ATLAS_RETURN_FAX = '833-485-5191';

// Add more presets here as needed.
const FAX_PRESETS = [
  { id: 'bellin-prep', name: 'Bellin Prep Team', fax: '+19204368549' }
];

const RECORDS = [
  ['rec-preop-clearance',  'Pre-Op Clearance Notes'],
  ['rec-hp',               'History & Physical (H&P)'],
  ['rec-cardiac-clear',    'Cardiac Clearance Letter'],
  ['rec-meds-allergies',   'Medication List / Allergies'],
  ['rec-office-visit',     'Recent Office Visit Notes']
];
const LABS = [
  ['lab-cbc',     'CBC'],
  ['lab-bmp',     'BMP / CMP'],
  ['lab-coag',    'Coagulation (PT/PTT/INR)'],
  ['lab-lipid',   'Lipid Panel'],
  ['lab-hba1c',   'HbA1c'],
  ['lab-tsh',     'TSH / Thyroid']
];
const TESTS = [
  ['dx-ekg',     'EKG / 12-Lead'],
  ['dx-echo',    'Echocardiogram'],
  ['dx-cxr',     'Chest X-Ray'],
  ['dx-stress',  'Stress Test'],
  ['dx-pft',     'Pulmonary Function'],
  ['dx-sleep',   'Sleep Study']
];
const URGENCY = ['Routine','Expedited','Urgent','STAT'];

let _modalBuilt = false;

function $(id) { return document.getElementById(id); }

// ── "SEND PRE-OP FAX" button state ────────────────────────────────────────
// The hidden #po-bellin-fax-sent-flag input persists with the pre-op record
// (saved via getPreopTextFields). When its value is 'true', the button shows
// green with a SENT tag. Clicking still re-opens the modal so the user can
// re-send if needed.
function syncSendButtonState() {
  const btn = $('preop-fax-btn');
  const flag = $('po-bellin-fax-sent-flag');
  if(!btn) return;
  const sent = flag?.value === 'true';
  if(sent) {
    btn.style.background   = '#16a34a';
    btn.style.borderColor  = '#16a34a';
    btn.style.color        = '#fff';
    btn.innerHTML = '📠 PRE-OP FAX <span style="background:rgba(255,255,255,.22);padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;margin-left:8px;letter-spacing:.6px">SENT</span>';
  } else {
    btn.style.background   = '';
    btn.style.borderColor  = '#0369a1';
    btn.style.color        = '#0369a1';
    btn.innerHTML = '📠 SEND PRE-OP FAX';
  }
}
window._pofSyncBtn = syncSendButtonState;

// Wrap editPreopRecord / clearPreop so the button reflects the loaded record.
function wrapPreopFunctions() {
  const origEdit = window.editPreopRecord;
  if(typeof origEdit === 'function') {
    window.editPreopRecord = async function() {
      const ret = await origEdit.apply(this, arguments);
      syncSendButtonState();
      return ret;
    };
  }
  const origClear = window.clearPreop;
  if(typeof origClear === 'function') {
    window.clearPreop = function() {
      const ret = origClear.apply(this, arguments);
      syncSendButtonState();
      return ret;
    };
  }
}

if(document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    wrapPreopFunctions();
    syncSendButtonState();
  });
} else {
  wrapPreopFunctions();
  syncSendButtonState();
}

function workerFromForm() {
  const devActive = $('wbtn-dev')?.classList.contains('active-dev');
  return (typeof window.currentWorker !== 'undefined' ? window.currentWorker : null)
       || (devActive ? 'dev' : 'josh');
}
function providerName(w) {
  return w === 'josh' ? 'Joshua Condado, CRNA' : 'Devarsh Murthy, CRNA';
}
function workerPhone(w) {
  return w === 'josh' ? '715-499-6858' : '262-573-9095';
}

function todayIso() {
  // Local date in YYYY-MM-DD (uses helper from app.js if available).
  return (typeof window.todayStr === 'function')
    ? window.todayStr()
    : new Date().toISOString().split('T')[0];
}
function fmtDate(iso) {
  if(!iso) return '';
  const parts = iso.split('-');
  if(parts.length !== 3) return iso;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

// Read the patient details we can auto-fill from the live Pre-Op form.
function readPreopForm() {
  const r = {};
  document.querySelectorAll('#tab-preop input, #tab-preop select, #tab-preop textarea').forEach(el => {
    if(!el.id) return;
    if(el.type === 'checkbox') r[el.id] = el.checked;
    else if(el.type === 'radio') { if(el.checked) r[el.name] = el.value; }
    else r[el.id] = el.value;
  });
  // Patient name field on the pre-op form may not exist as a single input —
  // the existing fax module looks at po-patient or first/last name fields.
  r.patientName = $('po-patient')?.value
    || [$('po-firstName')?.value || '', $('po-lastName')?.value || ''].filter(Boolean).join(' ').trim()
    || '';
  r.patientDob  = $('po-dob')?.value || '';
  r.patientPhone = $('po-contact-phone')?.value || '';
  r.surgeryDate = $('po-surgeryDate')?.value || '';
  r.providerSig = $('po-providerSignature')?.value || '';
  return r;
}

function buildModal() {
  if(_modalBuilt) return;
  const wrap = document.createElement('div');
  wrap.id = 'preopFaxModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px';
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:880px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 24px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:600">📋 Send Pre-Op Records Request Fax</div>
          <div style="font-size:12px;opacity:.75;margin-top:2px">Request labs, H&amp;P, and clearance from the patient's PCP</div>
        </div>
        <button onclick="closePreopFaxModal()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
      </div>

      <div style="padding:14px 24px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Recipient Preset</label>
          <select id="pof-preset" onchange="window._pofApplyPreset()" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
            <option value="">— Custom recipient —</option>
            ${FAX_PRESETS.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">To (Recipient Name)</label>
          <input type="text" id="pof-to" oninput="window._pofPreview()" placeholder="e.g. Bellin Prep Team" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Practice / Clinic</label>
          <input type="text" id="pof-practice" oninput="window._pofPreview()" placeholder="(optional)" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Recipient Fax #</label>
          <input type="tel" id="pof-fax" oninput="window._pofPreview()" placeholder="+19205551234" style="width:100%;padding:7px 10px;font-size:13px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Recipient Phone</label>
          <input type="tel" id="pof-phone" oninput="window._pofPreview()" placeholder="(555) 555-5555" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Records Date Range — From</label>
          <input type="date" id="pof-range-from" oninput="window._pofPreview()" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Records Date Range — To</label>
          <input type="date" id="pof-range-to" oninput="window._pofPreview()" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
      </div>

      <div style="padding:14px 24px;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:6px">Records Requested</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 16px">
          ${RECORDS.map(([id, lbl]) => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
              <input type="checkbox" id="pof-${id}" onchange="window._pofPreview()" style="width:15px;height:15px"> ${lbl}
            </label>`).join('')}
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
            <input type="checkbox" id="pof-rec-other-cb" onchange="window._pofPreview()" style="width:15px;height:15px"> Other
          </label>
        </div>
        <input type="text" id="pof-rec-other-text" oninput="window._pofPreview()" placeholder="Other records — describe..." style="width:100%;padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;margin-top:5px">

        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin:10px 0 6px">Labs Requested</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 16px">
          ${LABS.map(([id, lbl]) => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
              <input type="checkbox" id="pof-${id}" onchange="window._pofPreview()" style="width:15px;height:15px"> ${lbl}
            </label>`).join('')}
        </div>
        <input type="text" id="pof-lab-other-text" oninput="window._pofPreview()" placeholder="Other labs — describe..." style="width:100%;padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;margin-top:5px">

        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin:10px 0 6px">Diagnostic Testing Requested</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 16px">
          ${TESTS.map(([id, lbl]) => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
              <input type="checkbox" id="pof-${id}" onchange="window._pofPreview()" style="width:15px;height:15px"> ${lbl}
            </label>`).join('')}
        </div>
        <input type="text" id="pof-test-other-text" oninput="window._pofPreview()" placeholder="Other testing — describe..." style="width:100%;padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;margin-top:5px">

        <div style="display:grid;grid-template-columns:90px repeat(4,140px);align-items:center;margin-top:12px">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">Urgency</span>
          ${URGENCY.map(u => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
              <input type="radio" name="pof-urgency" value="${u}" onchange="window._pofPreview()" style="margin:0"> ${u}
            </label>`).join('')}
        </div>
      </div>

      <div style="padding:14px 24px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-faint)">Patient info pulls from the active Pre-Op record automatically.</div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-ghost" onclick="window._pofClear()">Clear Form</button>
          <button class="btn btn-ghost" onclick="closePreopFaxModal()">Cancel</button>
          <button id="pof-send-btn" class="btn btn-primary" onclick="window._pofSend()" style="background:#1d3557;border-color:#1d3557">📠 Send Pre-Op Fax</button>
        </div>
      </div>

      <div style="padding:20px 24px;background:#f4f4f4">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#666;margin-bottom:10px">FAX PREVIEW</div>
        <div id="pof-preview" style="background:#fff;border:1px solid #ccc;border-radius:4px;padding:24px;font-family:Arial,sans-serif;font-size:11px;color:#000;max-width:760px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.08)"></div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  _modalBuilt = true;
}

function applyPreset() {
  const sel = $('pof-preset');
  if(!sel) return;
  const preset = FAX_PRESETS.find(p => p.id === sel.value);
  if(!preset) return;
  $('pof-to').value  = preset.name;
  $('pof-fax').value = preset.fax;
  // Phone is intentionally left untouched — not part of the preset.
  refreshPreview();
}
window._pofApplyPreset = applyPreset;

function buildPreviewHTML() {
  const r = readPreopForm();
  const w = workerFromForm();
  const today = todayIso();

  const checked = id => $('pof-' + id)?.checked;
  const recOtherTxt   = $('pof-rec-other-text')?.value.trim() || '';
  const recOtherOn    = checked('rec-other-cb') || !!recOtherTxt;
  const labOtherTxt   = $('pof-lab-other-text')?.value.trim() || '';
  const testOtherTxt  = $('pof-test-other-text')?.value.trim() || '';
  const urgency       = document.querySelector('input[name="pof-urgency"]:checked')?.value || '';

  const to       = $('pof-to')?.value.trim()       || '';
  const practice = $('pof-practice')?.value.trim() || '';
  const fax      = $('pof-fax')?.value.trim()      || '';
  const phone    = $('pof-phone')?.value.trim()    || '';
  const rangeFrom = $('pof-range-from')?.value || '';
  const rangeTo   = $('pof-range-to')?.value || '';

  const box = (on, lbl) => `<span style="display:inline-block;width:11px;height:11px;border:1px solid #444;text-align:center;line-height:9px;font-size:9px;font-weight:bold;margin-right:5px;vertical-align:middle">${on?'✗':''}</span>${lbl}`;
  const grid = (items) => `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 12px">${items.map(s=>`<div>${s}</div>`).join('')}</div>`;
  const labelVal = (lbl, val) => `<div style="margin-bottom:4px"><span style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase">${lbl}:</span> <span style="border-bottom:1px solid #888;display:inline-block;min-width:140px;padding-left:4px">${val||'&nbsp;'}</span></div>`;

  return `
    <div style="background:#1d3557;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;margin:-24px -24px 14px">
      <div>
        <div style="font-size:18px;font-weight:bold;letter-spacing:.5px">ATLAS ANESTHESIA</div>
        <div style="font-size:10px;opacity:.85;margin-top:1px">Mobile Office-Based Anesthesia</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:18px;font-weight:bold">FAX</div>
        <div style="font-size:10px;opacity:.85;margin-top:1px">RECORDS REQUEST</div>
      </div>
    </div>

    <div style="font-size:14px;font-weight:bold;color:#1d3557;margin-bottom:2px">Pre-Operative Records Request</div>
    <div style="font-size:11px;color:#333;margin-bottom:10px">Please fax the records, labs, and diagnostic testing checked below for the patient identified.</div>

    <div style="background:#fff8d6;border:1px solid #e8c200;border-radius:3px;padding:6px 10px;margin-bottom:10px;font-size:10px">
      <strong style="color:#1d3557">RECORDS DATE RANGE:</strong>
      &nbsp; FROM: <span style="border-bottom:1px solid #888;display:inline-block;min-width:90px;padding:0 4px">${fmtDate(rangeFrom)||'&nbsp;'}</span>
      &nbsp; TO: <span style="border-bottom:1px solid #888;display:inline-block;min-width:90px;padding:0 4px">${fmtDate(rangeTo)||'&nbsp;'}</span>
      <span style="color:#888;font-style:italic;font-size:9px">&nbsp;(MM/DD/YYYY)</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:12px">
      <div>
        ${labelVal('TO', to)}
        ${labelVal('PRACTICE', practice)}
        ${labelVal('FAX #', fax)}
        ${labelVal('PHONE', phone)}
      </div>
      <div>
        ${labelVal('FROM', 'Atlas Anesthesia')}
        ${labelVal('REQ. PROVIDER', providerName(w))}
        ${labelVal('DATE', fmtDate(today))}
        ${labelVal('RETURN FAX', ATLAS_RETURN_FAX)}
      </div>
    </div>

    <div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px">PATIENT INFORMATION</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:8px 0 12px">
      <div>
        ${labelVal('NAME', r.patientName || '')}
        ${labelVal('PHONE', r.patientPhone || '')}
      </div>
      <div>
        ${labelVal('DOB', r.patientDob ? fmtDate(r.patientDob) : '')}
        ${labelVal('PROCEDURE DATE', r.surgeryDate ? fmtDate(r.surgeryDate) : '')}
      </div>
    </div>

    <div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px">RECORDS REQUESTED</div>
    <div style="margin:8px 0 4px">
      ${grid([
        box(checked('rec-preop-clearance'), 'Pre-Op Clearance Notes'),
        box(checked('rec-hp'),               'History &amp; Physical (H&amp;P)'),
        box(checked('rec-cardiac-clear'),    'Cardiac Clearance Letter'),
        box(checked('rec-meds-allergies'),   'Medication List / Allergies'),
        box(checked('rec-office-visit'),     'Recent Office Visit Notes'),
        box(recOtherOn,                       'Other: ' + (recOtherTxt ? `<span style="border-bottom:1px solid #888;padding-left:4px">${recOtherTxt}</span>` : ''))
      ])}
    </div>

    <div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px;margin-top:8px">LABS REQUESTED</div>
    <div style="margin:8px 0 4px">
      ${grid(LABS.map(([id, lbl]) => box(checked(id), lbl)))}
    </div>
    ${labOtherTxt ? `<div style="font-size:10px;margin-top:2px"><strong>OTHER LABS:</strong> <span style="border-bottom:1px solid #888;padding:0 4px">${labOtherTxt}</span></div>` : ''}

    <div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px;margin-top:8px">DIAGNOSTIC TESTING REQUESTED</div>
    <div style="margin:8px 0 4px">
      ${grid(TESTS.map(([id, lbl]) => box(checked(id), lbl)))}
    </div>
    ${testOtherTxt ? `<div style="font-size:10px;margin-top:2px"><strong>OTHER TESTING:</strong> <span style="border-bottom:1px solid #888;padding:0 4px">${testOtherTxt}</span></div>` : ''}

    <div style="margin-top:10px;font-size:11px"><strong>URGENCY:</strong>
      ${URGENCY.map(u => `<span style="margin-left:14px">${box(urgency===u, u)}</span>`).join('')}
    </div>

    <div style="margin-top:12px;display:grid;grid-template-columns:2fr 1fr;gap:18px;align-items:end">
      <div>
        ${labelVal('PROVIDER', providerName(w))}
      </div>
      <div>
        ${labelVal('DATE', fmtDate(today))}
      </div>
    </div>
    ${r.providerSig ? `<div style="margin-top:4px"><img src="${r.providerSig}" style="height:36px"></div>` : '<div style="margin-top:4px;height:36px;border-bottom:1px solid #888;width:240px"></div>'}

    <div style="margin-top:14px;background:#fdecec;border:1px solid #f5b5b5;border-radius:3px;padding:6px 10px;font-size:9px;color:#444;line-height:1.4">
      <strong style="color:#a13030">CONFIDENTIALITY &amp; AUTHORIZATION NOTICE</strong><br>
      This request is made for the purpose of pre-anesthesia evaluation. The patient has authorized release of records to Atlas Anesthesia for the procedure noted above. This facsimile transmission may contain protected health information privileged and confidential under HIPAA and applicable state law. It is intended only for the addressee. If you received this fax in error, please notify Atlas Anesthesia immediately and destroy all copies. Records may be returned via the fax number listed in the "RETURN FAX" field above.
    </div>

    <div style="margin-top:8px;font-size:9px;color:#888;text-align:center">Atlas Anesthesia · Pre-Operative Records Request · Page 1 of 1</div>
  `;
}

function refreshPreview() {
  const el = $('pof-preview');
  if(el) el.innerHTML = buildPreviewHTML();
}
window._pofPreview = refreshPreview;

function clearForm() {
  ['pof-preset','pof-to','pof-practice','pof-fax','pof-phone','pof-range-from','pof-range-to',
   'pof-rec-other-text','pof-lab-other-text','pof-test-other-text'].forEach(id => {
    const el = $(id); if(el) el.value = '';
  });
  document.querySelectorAll('#preopFaxModal input[type="checkbox"]').forEach(cb => cb.checked = false);
  document.querySelectorAll('#preopFaxModal input[name="pof-urgency"]').forEach(r => r.checked = false);
  refreshPreview();
}
window._pofClear = clearForm;

window.openPreopFaxModal = function() {
  buildModal();
  clearForm();
  $('preopFaxModal').style.display = 'flex';
};

window.closePreopFaxModal = function() {
  const m = $('preopFaxModal');
  if(m) m.style.display = 'none';
};

window._pofSend = async function() {
  const fax = $('pof-fax')?.value.trim() || '';
  const to  = $('pof-to')?.value.trim()  || '';
  if(!fax) { alert('Please enter a Recipient Fax #.'); return; }
  if(!fax.startsWith('+')) { alert('Fax number needs the country code, e.g. +19205551234'); return; }
  if(!to)  { alert('Please enter the Recipient Name (or pick a preset).'); return; }

  const btn = $('pof-send-btn');
  if(btn) { btn.textContent = 'Sending...'; btn.disabled = true; }

  try {
    const html = buildPreviewHTML();
    const w = workerFromForm();
    const r = readPreopForm();
    const res = await fetch(FAX_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: fax,
        caseId: to,                    // shows up as the recipient label in the worker logs
        worker: w,
        html
      })
    });
    const data = await res.json();
    if(res.ok && data.success) {
      alert('✅ Pre-Op fax sent to ' + fax + '! SID: ' + (data.sid || 'N/A'));
      // Mark the pre-op record as having had a fax sent — the button turns
      // green with a SENT tag, and the state persists with the saved record.
      const flag = $('po-bellin-fax-sent-flag');
      if(flag) flag.value = 'true';
      syncSendButtonState();
      window.closePreopFaxModal();
    } else {
      alert('❌ Pre-Op fax failed: ' + (data.error || 'Unknown error'));
    }
  } catch(e) {
    alert('❌ Error sending fax: ' + e.message);
  } finally {
    if(btn) { btn.textContent = '📠 Send Pre-Op Fax'; btn.disabled = false; }
  }
};
