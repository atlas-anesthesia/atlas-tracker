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

// Insurance presets can be filled in here later — same idea as the Pre-Op fax
// modal's Bellin Prep Team preset. Each entry auto-fills Insurer + Fax #.
const INSURANCE_PRESETS = [
  // { id: 'delta-dental', name: 'Delta Dental', fax: '+18005551234' }
];

let _modalBuilt = false;
let _mode = 'josh-receipt';   // 'josh-receipt' | 'flat' | 'cdt'

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
  return {
    provider:  r['po-provider'] || '',
    procedure: r['po-procedureType'] || '',
    patientName: [r['po-firstName']||'', r['po-lastName']||''].filter(Boolean).join(' ').trim()
              || r['po-patient'] || '',
    patientDob:  r['po-dob'] || '',
    patientPhone: r['po-contact-phone'] || '',
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
        const name = [r['po-firstName']||'', r['po-lastName']||''].filter(Boolean).join(' ').trim()
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
          <div style="font-size:12px;opacity:.75;margin-top:2px">Send a flat-fee or CDT-code claim by email</div>
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

      <div style="padding:14px 24px;border-bottom:1px solid var(--border);background:#f8fafc;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">Claim Type</span>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
          <input type="radio" name="ins-mode" value="josh-receipt" checked onchange="window._insSetMode('josh-receipt')" style="margin:0"> Receipt Form (Josh)
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
          <input type="radio" name="ins-mode" value="flat" onchange="window._insSetMode('flat')" style="margin:0"> Flat Fee
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
          <input type="radio" name="ins-mode" value="cdt" onchange="window._insSetMode('cdt')" style="margin:0"> CDT Codes
        </label>
      </div>

      <div style="padding:14px 24px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Insurer Preset</label>
          <select id="ins-preset" onchange="window._insApplyPreset()" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
            <option value="">— Custom recipient —</option>
            ${INSURANCE_PRESETS.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Insurer / Recipient</label>
          <input type="text" id="ins-to" oninput="window._insPreview()" placeholder="e.g. Delta Dental" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Recipient Email</label>
          <input type="email" id="ins-email" oninput="window._insPreview()" placeholder="claims@insurer.com" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Recipient Phone</label>
          <input type="tel" id="ins-phone" oninput="window._insPreview()" placeholder="(555) 555-5555" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
        </div>
      </div>

      <div id="ins-form-area" style="padding:14px 24px;border-bottom:1px solid var(--border)">
        <!-- Filled in by setMode() based on Flat Fee vs CDT Codes -->
      </div>

      <div style="padding:10px 24px;border-bottom:1px solid var(--border)">${(typeof window.scheduleToggleHTML==='function')?window.scheduleToggleHTML('ins'):''}</div>

      <div style="padding:14px 24px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-faint)">Patient info pulls from the current case being finalized.</div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-ghost" onclick="closeInsuranceSheetModal()">Cancel</button>
          <button id="ins-send-btn" class="btn btn-primary" onclick="window._insSend()" style="background:#1d3557;border-color:#1d3557">📧 Send Insurance Email</button>
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

function renderJoshReceiptForm() {
  // Defaults for patient/office fields come from the selected pre-op record.
  // The user can override before sending if the chart is out of date.
  const ctx = readCaseContext();
  const defaultOffice = _selectedPreop?.['po-officeAddress']
    || _selectedPreop?.['po-dentistAddress']
    || '';
  const defaultSex = _selectedPreop?.['po-sex'] || '';
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
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">Josh Receipt / Insurance Claim Form</div>

    <div style="display:grid;grid-template-columns:130px 1fr;gap:12px;margin-bottom:14px;padding:10px;background:#f8fafc;border:1px solid var(--border);border-radius:6px;align-items:end">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Sex</label>
        <div id="ins-jr-sex-group" style="display:inline-flex;align-items:stretch;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:#fff;font-size:13px;font-weight:500;height:30px;line-height:1">
          <label style="flex:1;display:flex;align-items:center;justify-content:center;min-width:44px;padding:0;cursor:pointer;border-right:1px solid var(--border);user-select:none;margin:0;background:${defaultSex==='M'?'#1d3557':'#fff'};color:${defaultSex==='M'?'#fff':'var(--text)'}" onclick="this.parentNode.querySelectorAll('label').forEach(l=>{l.style.background='#fff';l.style.color='var(--text)'});this.style.background='#1d3557';this.style.color='#fff';this.querySelector('input').checked=true;window._insPreview()">
            <input type="radio" name="ins-jr-sex" value="M" ${defaultSex==='M'?'checked':''} style="display:none"><span>M</span>
          </label>
          <label style="flex:1;display:flex;align-items:center;justify-content:center;min-width:44px;padding:0;cursor:pointer;user-select:none;margin:0;background:${defaultSex==='F'?'#1d3557':'#fff'};color:${defaultSex==='F'?'#fff':'var(--text)'}" onclick="this.parentNode.querySelectorAll('label').forEach(l=>{l.style.background='#fff';l.style.color='var(--text)'});this.style.background='#1d3557';this.style.color='#fff';this.querySelector('input').checked=true;window._insPreview()">
            <input type="radio" name="ins-jr-sex" value="F" ${defaultSex==='F'?'checked':''} style="display:none"><span>F</span>
          </label>
        </div>
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Dentist Office Address</label>
        <input type="text" id="ins-jr-office-address" value="${defaultOffice.replace(/"/g,'&quot;')}" oninput="window._insPreview()" placeholder="e.g. 123 Main St, Green Bay, WI 54301" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text);box-sizing:border-box;height:30px">
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
    <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;padding:12px;background:#f8fafc;border:1px solid var(--border);border-radius:6px">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">D9222 15-min Units</label>
        <input type="number" id="ins-jr-units" min="1" max="20" value="4" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Charge per 15-min Unit</label>
        <input type="number" id="ins-jr-per-unit" min="0" step="0.01" value="240" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">CC Transaction Fee %</label>
        <input type="number" id="ins-jr-cc-pct" min="0" step="0.1" value="3.5" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Medical 00170 (Min)</label>
        <input type="number" id="ins-jr-medical-min" min="0" step="1" value="0" oninput="window._insPreview()" style="width:100%;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)" placeholder="Optional">
      </div>
    </div>

    <div style="margin-top:14px;padding:12px;border:1px solid var(--border);border-radius:6px;background:#fafbfd">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#1d3557;margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span>📄 Page 2 — Payor Disclosure</span>
        <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px;color:var(--text-faint);font-style:italic">(optional — only sent when filled in)</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Insurance Carrier / Payor Name</label>
          <input type="text" id="ins-jr-payor-name" oninput="window._insPreview()" placeholder="e.g. Delta Dental of Wisconsin" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Payor Mailing Address</label>
          <input type="text" id="ins-jr-payor-address" oninput="window._insPreview()" placeholder="Street, City, State, ZIP" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Subscriber Name</label>
          <input type="text" id="ins-jr-subscriber-name" oninput="window._insPreview()" placeholder="If different from patient" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Relationship to Subscriber</label>
          <select id="ins-jr-relationship" onchange="window._insPreview()" style="width:100%;padding:6px 9px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
            <option value="">— Select —</option>
            <option value="Self">Self</option>
            <option value="Spouse">Spouse</option>
            <option value="Child">Child</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Subscriber ID / Member #</label>
          <input type="text" id="ins-jr-subscriber-id" oninput="window._insPreview()" placeholder="Member or Policy #" style="width:100%;padding:6px 9px;font-size:13px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:3px">Group #</label>
          <input type="text" id="ins-jr-group-num" oninput="window._insPreview()" placeholder="Group # (if applicable)" style="width:100%;padding:6px 9px;font-size:13px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:4px;background:#fff;color:var(--text)">
        </div>
      </div>
    </div>
  `;
}

function renderFlatFeeForm() {
  return `
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">Flat Fee Claim — placeholder fields</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Service Description</label>
        <input type="text" id="ins-flat-desc" oninput="window._insPreview()" placeholder="e.g. General anesthesia for dental procedure" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Flat Fee Amount ($)</label>
        <input type="number" id="ins-flat-amount" oninput="window._insPreview()" placeholder="0.00" min="0" step="0.01" style="width:100%;padding:7px 10px;font-size:13px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
      </div>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Notes</label>
      <textarea id="ins-flat-notes" oninput="window._insPreview()" rows="3" placeholder="Anything else the insurer needs to know" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;resize:vertical;font-family:'DM Sans',sans-serif"></textarea>
    </div>
    <div style="margin-top:8px;font-size:11px;color:#9b6d00;font-style:italic">⚠ Placeholder layout — final fields will match your Flat Fee sheet once you share the PDF.</div>
  `;
}

function renderCdtForm() {
  return `
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">CDT Code Claim — placeholder fields</div>
    <div id="ins-cdt-lines"></div>
    <button class="btn btn-ghost btn-sm" onclick="window._insAddCdtLine()" style="margin-top:8px;font-size:12px">+ Add CDT Line</button>
    <div style="margin-top:10px;display:grid;grid-template-columns:1fr 200px;gap:10px;align-items:end">
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Notes</label>
        <input type="text" id="ins-cdt-notes" oninput="window._insPreview()" placeholder="(optional)" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Total ($)</label>
        <div id="ins-cdt-total" style="padding:7px 11px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:14px;font-weight:600;font-family:'DM Mono',monospace;color:var(--text)">0.00</div>
      </div>
    </div>
    <div style="margin-top:8px;font-size:11px;color:#9b6d00;font-style:italic">⚠ Placeholder layout — final fields will match your CDT sheet once you share the PDF.</div>
  `;
}

function renderCdtLineRow(idx) {
  return `
    <div class="ins-cdt-line" data-idx="${idx}" style="display:grid;grid-template-columns:90px 1fr 80px 90px 30px;gap:8px;align-items:center;margin-bottom:6px">
      <input type="text" class="ins-cdt-code" placeholder="e.g. D9223" oninput="window._insCdtRecalc()" style="padding:6px 9px;font-size:12px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm)">
      <input type="text" class="ins-cdt-desc" placeholder="Description" oninput="window._insCdtRecalc()" style="padding:6px 9px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-sm)">
      <input type="number" class="ins-cdt-qty"  placeholder="Qty" min="1" step="1" value="1" oninput="window._insCdtRecalc()" style="padding:6px 9px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-sm)">
      <input type="number" class="ins-cdt-fee"  placeholder="0.00" min="0" step="0.01" oninput="window._insCdtRecalc()" style="padding:6px 9px;font-size:12px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm)">
      <button onclick="window._insRemoveCdtLine(${idx})" title="Remove" style="background:none;border:none;color:var(--warn);font-size:16px;cursor:pointer;padding:0">×</button>
    </div>
  `;
}

window._insAddCdtLine = function() {
  const wrap = $('ins-cdt-lines');
  if(!wrap) return;
  const idx = wrap.children.length;
  wrap.insertAdjacentHTML('beforeend', renderCdtLineRow(idx));
  recalcCdt();
};
window._insRemoveCdtLine = function(idx) {
  const wrap = $('ins-cdt-lines');
  if(!wrap) return;
  const row = wrap.querySelector(`.ins-cdt-line[data-idx="${idx}"]`);
  if(row) row.remove();
  recalcCdt();
};
function recalcCdt() {
  let total = 0;
  document.querySelectorAll('#ins-cdt-lines .ins-cdt-line').forEach(row => {
    const qty = parseFloat(row.querySelector('.ins-cdt-qty')?.value) || 0;
    const fee = parseFloat(row.querySelector('.ins-cdt-fee')?.value) || 0;
    total += qty * fee;
  });
  const out = $('ins-cdt-total');
  if(out) out.textContent = total.toFixed(2);
  refreshPreview();
}
window._insCdtRecalc = recalcCdt;

window._insSetMode = function(mode) {
  _mode = mode;
  const area = $('ins-form-area');
  if(!area) return;
  if(mode === 'josh-receipt') {
    area.innerHTML = renderJoshReceiptForm();
  } else if(mode === 'cdt') {
    area.innerHTML = renderCdtForm();
    window._insAddCdtLine();
  } else {
    area.innerHTML = renderFlatFeeForm();
  }
  refreshPreview();
};

window._insApplyPreset = function() {
  const sel = $('ins-preset');
  if(!sel) return;
  const preset = INSURANCE_PRESETS.find(p => p.id === sel.value);
  if(!preset) return;
  $('ins-to').value  = preset.name;
  if($('ins-email')) $('ins-email').value = preset.email || preset.fax || '';
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

  const units    = parseInt($('ins-jr-units')?.value, 10) || 0;
  const perUnit  = parseFloat($('ins-jr-per-unit')?.value) || 0;
  const ccPct    = parseFloat($('ins-jr-cc-pct')?.value) || 0;
  const medMin   = parseInt($('ins-jr-medical-min')?.value, 10) || 0;
  const medUnits = medMin ? (medMin / 12) : 0;

  const subtotalCharges = units * perUnit;
  const ccFee           = subtotalCharges * (ccPct / 100);
  const total           = subtotalCharges + ccFee;

  const sexFromDob = document.querySelector('input[name="ins-jr-sex"]:checked')?.value || '';
  const dentistOffice = $('ins-jr-office-address')?.value.trim() || '';
  // Page 2 payor disclosure inputs (all optional)
  const payorName       = $('ins-jr-payor-name')?.value.trim()       || '';
  const payorAddress    = $('ins-jr-payor-address')?.value.trim()    || '';
  const subscriberName  = $('ins-jr-subscriber-name')?.value.trim()  || '';
  const subscriberId    = $('ins-jr-subscriber-id')?.value.trim()    || '';
  const groupNum        = $('ins-jr-group-num')?.value.trim()        || '';
  const relationship    = $('ins-jr-relationship')?.value            || '';
  // Page 2 always renders. Empty fields render as blank underlines so the form
  // can be filled by hand or by the payor's office if needed.
  const hasPage2 = true;

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

  // Billing rows — one D9222 row per unit. The PDF has 14 blank rows; we'll
  // print rows for the checked unit count and leave the rest blank.
  const billingRows = [];
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

  const field = (lbl, val, width) => `<div style="display:inline-block;margin-right:14px;margin-bottom:5px;font-size:11px"><span style="font-weight:700">${lbl}:</span> <span style="border-bottom:1px solid #555;display:inline-block;min-width:${width||120}px;padding:0 4px">${val||'&nbsp;'}</span></div>`;

  return `
    <div style="text-align:center;border-bottom:2px solid #1d3557;padding-bottom:10px;margin-bottom:14px">
      <div style="font-size:22px;font-weight:bold;letter-spacing:1px;color:#1d3557">Atlas Anesthesia, LLC</div>
      <div style="font-size:10.5px;margin-top:4px;color:#333">Federal Tax ID #41-4070944 &nbsp;·&nbsp; NPI #1861900201</div>
      <div style="font-size:10.5px;margin-top:2px;color:#333">Joshua Condado, CRNA &nbsp;·&nbsp; (715) 499-6858</div>
    </div>

    <div style="text-align:center;font-size:14px;font-weight:bold;letter-spacing:.8px;margin-bottom:12px;color:#1d3557">RECEIPT / INSURANCE CLAIM INFORMATION</div>

    <div style="margin-bottom:10px">
      ${field('Date of Service', ctx.surgeryDate ? fmtDate(ctx.surgeryDate) : '', 110)}
      ${field('Patient Name', ctx.patientName, 200)}
    </div>
    <div style="margin-bottom:10px">
      ${field('DOB', ctx.patientDob ? fmtDate(ctx.patientDob) : '', 110)}
      ${field('Sex', sexFromDob, 60)}
      ${field('Dentist', ctx.provider, 200)}
    </div>
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

    <div style="background:#fff3cd;border:1px solid #d4a017;padding:6px 10px;font-size:10.5px;margin-bottom:6px">
      <strong>x ${ccPct.toFixed(1)}% CC Transaction Fee</strong>
      <span style="float:right;font-family:'DM Mono',monospace">$${ccFee.toFixed(2)}</span>
    </div>

    <div style="border:1px solid #999;padding:6px 10px;font-size:10.5px;margin-bottom:10px">
      Medical Anesthesia Billing Code <strong>00170</strong> Intra-oral Procedure &nbsp;5 units&nbsp;+&nbsp;
      <span style="border-bottom:1px solid #555;display:inline-block;min-width:40px;padding:0 4px;text-align:center">${medMin || '&nbsp;'}</span>
      &nbsp;minutes / 12 =&nbsp;
      <span style="border-bottom:1px solid #555;display:inline-block;min-width:40px;padding:0 4px;text-align:center">${medUnits ? medUnits.toFixed(2) : '&nbsp;'}</span>
      &nbsp;Time Units
    </div>

    <div style="background:#1d3557;color:#fff;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:bold;margin-bottom:14px">
      <span>TOTAL CHARGES</span>
      <span style="font-family:'DM Mono',monospace;font-size:15px">$${total.toFixed(2)}</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 200px;gap:18px;align-items:end;margin-top:18px">
      <div>
        <div style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase;margin-bottom:2px">Signed</div>
        <img src="assets/signatures/josh.png" style="height:46px;mix-blend-mode:multiply;display:block" alt="Signature" onerror="this.style.display='none'">
        <div style="border-top:1px solid #000;width:240px;font-size:10px;padding-top:2px;margin-top:2px">Joshua Condado, CRNA · Atlas Anesthesia, LLC</div>
      </div>
      <div style="text-align:right;font-size:10px;color:#555">DATE: <span style="border-bottom:1px solid #888;padding:0 6px">${fmtDate(today)}</span></div>
    </div>

    <div style="margin-top:14px;background:#fdecec;border:1px solid #f5b5b5;border-radius:3px;padding:6px 10px;font-size:9px;color:#444;line-height:1.4">
      <strong style="color:#a13030">CONFIDENTIALITY &amp; AUTHORIZATION NOTICE</strong><br>
      This receipt contains protected health information privileged and confidential under HIPAA and applicable state law. It is intended only for the addressee. If you received this email in error, please notify Atlas Anesthesia immediately and destroy all copies.
    </div>

    <div style="margin-top:8px;font-size:9px;color:#888;text-align:center">Atlas Anesthesia, LLC · Receipt / Insurance Claim · Page 1 of ${hasPage2 ? '2' : '1'}</div>

    ${hasPage2 ? `
    <div style="page-break-before:always;margin-top:30px;padding-top:24px;border-top:3px double #1d3557">
      <div style="text-align:center;border-bottom:2px solid #1d3557;padding-bottom:10px;margin-bottom:14px">
        <div style="font-size:22px;font-weight:bold;letter-spacing:1px;color:#1d3557">Atlas Anesthesia, LLC</div>
        <div style="font-size:10.5px;margin-top:4px;color:#333">Federal Tax ID #41-4070944 &nbsp;·&nbsp; NPI #1861900201</div>
      </div>

      <div style="text-align:center;font-size:14px;font-weight:bold;letter-spacing:.8px;margin-bottom:14px;color:#1d3557">PAYOR DISCLOSURE</div>

      <div style="margin-bottom:14px">
        ${field('Patient Name', ctx.patientName, 220)}
        ${field('DOB', ctx.patientDob ? fmtDate(ctx.patientDob) : '', 110)}
      </div>

      <div style="border:1px solid #aaa;padding:12px;background:#fafafa;margin-bottom:14px">
        <div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;color:#1d3557;border-bottom:1px solid #1d3557;padding-bottom:3px;margin-bottom:8px">Insurance Carrier</div>
        <div style="margin-bottom:8px">${field('Payor Name', payorName, 280)}</div>
        <div style="margin-bottom:8px">${field('Mailing Address', payorAddress, 380)}</div>
      </div>

      <div style="border:1px solid #aaa;padding:12px;background:#fafafa;margin-bottom:14px">
        <div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;color:#1d3557;border-bottom:1px solid #1d3557;padding-bottom:3px;margin-bottom:8px">Subscriber Information</div>
        <div style="margin-bottom:8px">${field('Subscriber Name', subscriberName || ctx.patientName, 260)} ${field('Relationship to Subscriber', relationship, 120)}</div>
        <div>${field('Subscriber ID / Member #', subscriberId, 180)} ${field('Group #', groupNum, 140)}</div>
      </div>

      <div style="border:1px solid #aaa;padding:12px;background:#fff;margin-bottom:16px;font-size:10.5px;line-height:1.5">
        <div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;color:#1d3557;border-bottom:1px solid #1d3557;padding-bottom:3px;margin-bottom:8px">Payor Agreement</div>
        <div style="margin-bottom:8px">Anesthesia charges will be collected as follows on the day of services:</div>
        <ul style="margin:0 0 0 18px;padding:0;list-style-type:disc">
          <li style="margin-bottom:6px"><strong>Thank you for trusting Atlas Anesthesia with your care. We want to be as transparent as possible about anesthesia fees so there are no surprises on the day of your procedure.</strong></li>
          <li style="margin-bottom:6px">If you have already made a deposit, it will be applied to the total amount. All procedures include a one-hour minimum anesthesia charge.</li>
          <li style="margin-bottom:6px">Payment &amp; Accepted Methods
            <ul style="margin:4px 0 0 18px;padding:0;list-style-type:circle">
              <li style="margin-bottom:3px">The remaining balance is due in full on the day of your procedure.</li>
              <li style="margin-bottom:3px">We accept debit and credit cards only.</li>
              <li style="margin-bottom:3px">A 3.5% processing fee applies to credit card payments.</li>
              <li style="margin-bottom:3px">We do not accept checks or CareCredit.</li>
            </ul>
          </li>
          <li style="margin-bottom:6px">If a patient is unable to proceed due to NPO status or does not arrive for their appointment, a one-hour anesthesia fee may apply. All insurance billing is the responsibility of the insured.</li>
          <li style="margin-bottom:6px">Any delinquent or accrued charges may be sent to collections and will incur an additional 50% collection fee.</li>
          <li style="margin-bottom:6px">If missed appointment, no-show, failure to follow NPO guidelines/one hour charge will be assessed.</li>
          <li><strong>I have read, understand, and agree to the above Payor Agreement.</strong></li>
        </ul>
      </div>

      <div style="display:grid;grid-template-columns:1fr 200px;gap:18px;align-items:end;margin-top:24px">
        <div>
          <div style="border-top:1px solid #000;width:300px;font-size:10px;padding-top:3px">Patient / Subscriber Signature</div>
        </div>
        <div style="text-align:right;font-size:10px;color:#555">DATE: <span style="border-bottom:1px solid #888;padding:0 6px;display:inline-block;min-width:90px">&nbsp;</span></div>
      </div>

      <div style="margin-top:16px;background:#fdecec;border:1px solid #f5b5b5;border-radius:3px;padding:6px 10px;font-size:9px;color:#444;line-height:1.4">
        <strong style="color:#a13030">CONFIDENTIALITY &amp; AUTHORIZATION NOTICE</strong><br>
        This disclosure contains protected health information privileged and confidential under HIPAA and applicable state law. It is intended only for the addressee.
      </div>

      <div style="margin-top:8px;font-size:9px;color:#888;text-align:center">Atlas Anesthesia, LLC · Payor Disclosure · Page 2 of 2</div>
    </div>
    ` : ''}
  `;
}

function buildPreviewHTML() {
  if(_mode === 'josh-receipt') return buildJoshReceiptHTML();

  const ctx = readCaseContext();
  const w   = workerNow();
  const to       = $('ins-to')?.value.trim()       || '';
  const fax      = $('ins-email')?.value.trim()    || '';
  const phone    = $('ins-phone')?.value.trim()    || '';
  const today    = todayIso();
  const labelVal = (lbl, val) => `<div style="margin-bottom:4px"><span style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase">${lbl}:</span> <span style="border-bottom:1px solid #888;display:inline-block;min-width:140px;padding-left:4px">${val||'&nbsp;'}</span></div>`;

  let body = '';
  if(_mode === 'flat') {
    const desc = $('ins-flat-desc')?.value.trim() || '';
    const amt  = parseFloat($('ins-flat-amount')?.value) || 0;
    const notes = $('ins-flat-notes')?.value.trim() || '';
    body = `
      <div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px;margin-top:8px">FLAT FEE CLAIM</div>
      <div style="margin:8px 0">
        ${labelVal('SERVICE', desc)}
        ${labelVal('AMOUNT', amt ? '$'+amt.toFixed(2) : '')}
      </div>
      ${notes ? `<div style="margin-top:6px;font-size:11px"><strong>Notes:</strong> ${notes}</div>` : ''}
    `;
  } else {
    const lines = Array.from(document.querySelectorAll('#ins-cdt-lines .ins-cdt-line')).map(row => ({
      code: row.querySelector('.ins-cdt-code')?.value.trim() || '',
      desc: row.querySelector('.ins-cdt-desc')?.value.trim() || '',
      qty:  parseFloat(row.querySelector('.ins-cdt-qty')?.value) || 0,
      fee:  parseFloat(row.querySelector('.ins-cdt-fee')?.value) || 0
    })).filter(l => l.code || l.desc || l.qty || l.fee);
    const total = lines.reduce((s,l) => s + (l.qty * l.fee), 0);
    const notes = $('ins-cdt-notes')?.value.trim() || '';
    body = `
      <div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px;margin-top:8px">CDT CODE CLAIM</div>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:11px">
        <tr style="background:#f5f5f5">
          <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #ccc;width:80px">Code</th>
          <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #ccc">Description</th>
          <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #ccc;width:50px">Qty</th>
          <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #ccc;width:80px">Fee</th>
          <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #ccc;width:90px">Line Total</th>
        </tr>
        ${lines.map(l => `
          <tr>
            <td style="padding:4px 6px;font-family:'DM Mono',monospace">${l.code}</td>
            <td style="padding:4px 6px">${l.desc}</td>
            <td style="padding:4px 6px;text-align:right">${l.qty || ''}</td>
            <td style="padding:4px 6px;text-align:right;font-family:'DM Mono',monospace">${l.fee ? '$'+l.fee.toFixed(2) : ''}</td>
            <td style="padding:4px 6px;text-align:right;font-family:'DM Mono',monospace">${(l.qty*l.fee) ? '$'+(l.qty*l.fee).toFixed(2) : ''}</td>
          </tr>
        `).join('')}
        <tr>
          <td colspan="4" style="padding:6px;text-align:right;font-weight:bold;border-top:2px solid #444">TOTAL</td>
          <td style="padding:6px;text-align:right;font-weight:bold;font-family:'DM Mono',monospace;border-top:2px solid #444">$${total.toFixed(2)}</td>
        </tr>
      </table>
      ${notes ? `<div style="margin-top:6px;font-size:11px"><strong>Notes:</strong> ${notes}</div>` : ''}
    `;
  }

  return `
    <div style="background:#1d3557;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;margin:-24px -24px 14px">
      <div>
        <div style="font-size:18px;font-weight:bold;letter-spacing:.5px">ATLAS ANESTHESIA</div>
        <div style="font-size:10px;opacity:.85;margin-top:1px">Mobile Office-Based Anesthesia</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:18px;font-weight:bold">INSURANCE CLAIM</div>
        <div style="font-size:10px;opacity:.85;margin-top:1px">Email Submission</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:12px">
      <div>
        ${labelVal('TO', to)}
        ${labelVal('EMAIL', fax)}
        ${labelVal('PHONE', phone)}
      </div>
      <div>
        ${labelVal('FROM', 'Atlas Anesthesia')}
        ${labelVal('PROVIDER', providerName(w))}
        ${labelVal('DATE', fmtDate(today))}
        ${labelVal('REPLY TO', 'admin@atlasanesthesia.co')}
      </div>
    </div>

    <div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px">PATIENT &amp; CASE INFO</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:8px 0 12px">
      <div>
        ${labelVal('NAME', ctx.patientName)}
        ${labelVal('DOB', ctx.patientDob ? fmtDate(ctx.patientDob) : '')}
        ${labelVal('PHONE', ctx.patientPhone)}
      </div>
      <div>
        ${labelVal('PROCEDURE', ctx.procedure)}
        ${labelVal('SURGERY DATE', ctx.surgeryDate ? fmtDate(ctx.surgeryDate) : '')}
        ${labelVal('DENTIST', ctx.provider)}
      </div>
    </div>

    ${body}

    <div style="margin-top:18px;display:grid;grid-template-columns:1fr 200px;gap:18px;align-items:end">
      <div>
        <div style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase;margin-bottom:2px">Provider Signature</div>
        <img src="assets/signatures/${w === 'josh' ? 'josh' : 'dev'}.png" style="height:46px;mix-blend-mode:multiply;display:block" alt="Signature" onerror="this.style.display='none'">
        <div style="border-top:1px solid #000;width:240px;font-size:10px;padding-top:2px;margin-top:2px">${providerName(w)} &middot; Atlas Anesthesia</div>
      </div>
      <div style="text-align:right;font-size:10px;color:#555">DATE: <span style="border-bottom:1px solid #888;padding:0 6px">${fmtDate(today)}</span></div>
    </div>

    <div style="margin-top:14px;background:#fdecec;border:1px solid #f5b5b5;border-radius:3px;padding:6px 10px;font-size:9px;color:#444;line-height:1.4">
      <strong style="color:#a13030">CONFIDENTIALITY &amp; AUTHORIZATION NOTICE</strong><br>
      This claim contains protected health information privileged and confidential under HIPAA and applicable state law. It is intended only for the addressee. If you received this email in error, please notify Atlas Anesthesia immediately and destroy all copies.
    </div>

    <div style="margin-top:8px;font-size:9px;color:#888;text-align:center">Atlas Anesthesia · Insurance Claim · Page 1 of 1</div>
  `;
}

function refreshPreview() {
  const el = $('ins-preview');
  if(el) el.innerHTML = buildPreviewHTML();
}
window._insPreview = refreshPreview;

window.openInsuranceSheetModal = function() {
  buildModal();
  // Reset transient fields each open
  ['ins-preset','ins-to','ins-email','ins-phone'].forEach(id => {
    const el = $(id); if(el) el.value = '';
  });
  // Always default back to Josh's Receipt Form on open
  document.querySelectorAll('input[name="ins-mode"]').forEach(r => r.checked = (r.value === 'josh-receipt'));
  _mode = 'josh-receipt';
  window._insSetMode('josh-receipt');
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
  const email = $('ins-email')?.value.trim() || '';
  const to    = $('ins-to')?.value.trim()  || '';
  if(!email) { alert('Please enter a Recipient Email.'); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('Please enter a valid email address (e.g. claims@insurer.com).'); return; }
  if(!to)    { alert('Please enter the Insurer / Recipient name (or pick a preset).'); return; }

  const btn = $('ins-send-btn');
  const origLabel = btn?.textContent;
  if(btn) { btn.textContent = 'Sending...'; btn.disabled = true; }

  try {
    const html = buildPreviewHTML();
    const w = workerNow();
    const caseId = _selectedPreop['po-caseId'] || '';
    // Use the existing /invoice email endpoint on the worker. It expects
    // { to, invoiceNum, html } and emails via AWS SES.
    const INVOICE_URL = FAX_WORKER_URL.replace('/fax', '/invoice');
    const rsp = await fetch(INVOICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: email,
        invoiceNum: 'Insurance Claim — ' + (caseId || to),
        html
      })
    });
    const data = await rsp.json();
    if(rsp.ok && data.success) {
      // Build a compact log entry of what was sent. Total is best-effort.
      let total = 0;
      if(_mode === 'josh-receipt') {
        const units   = parseInt($('ins-jr-units')?.value, 10) || 0;
        const perUnit = parseFloat($('ins-jr-per-unit')?.value) || 0;
        const ccPct   = parseFloat($('ins-jr-cc-pct')?.value) || 0;
        const sub     = units * perUnit;
        total = sub + sub * (ccPct / 100);
      } else if(_mode === 'flat') {
        total = parseFloat($('ins-flat-amount')?.value) || 0;
      } else {
        total = Array.from(document.querySelectorAll('#ins-cdt-lines .ins-cdt-line')).reduce((s, row) => {
          const qty = parseFloat(row.querySelector('.ins-cdt-qty')?.value) || 0;
          const fee = parseFloat(row.querySelector('.ins-cdt-fee')?.value) || 0;
          return s + qty * fee;
        }, 0);
      }
      const ctx = readCaseContext();
      await logSentInsurance({
        id: Math.random().toString(36).slice(2, 11),
        sentAt: new Date().toISOString(),
        worker: w,
        mode: _mode,
        caseId,
        patientName: ctx.patientName,
        surgeryDate: ctx.surgeryDate,
        recipient: to,
        recipientEmail: email,
        total,
        html
      });
      try { window.logAudit && window.logAudit('insurance-email-sent', caseId, `to ${to} <${email}>`); } catch(e){}
      if(typeof window.toastSuccess === 'function') window.toastSuccess('Insurance claim emailed to ' + email);
      else alert('✅ Insurance email sent to ' + email);
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
    if(btn) { btn.textContent = origLabel || '📧 Send Insurance Email'; btn.disabled = false; }
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
      const mode = e.mode === 'cdt' ? 'CDT' : e.mode === 'josh-receipt' ? 'Receipt' : 'Flat Fee';
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
