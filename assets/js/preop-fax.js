// -- preop-fax.js — "SEND PRE-OP FAX" modal + sender ---------------------------
// Self-contained module that injects the modal on first open. Pulls patient
// info from the currently-loaded Pre-Op form, lets the user pick records/labs/
// tests to request, previews the cover sheet, and sends it via the same
// FaxAge-backed Cloudflare Worker the existing fax modal uses. On a successful
// send it auto-checks the "Schedule through Bellin" status box.

const FAX_WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev/fax';
// Return-fax numbers per worker — patients send records back to whoever
// requested them. Josh and Devarsh have separate dedicated fax lines.
const RETURN_FAX = {
  josh: '833-485-5191',
  dev:  '262-228-1623'
};

// Add more presets here as needed.
const FAX_PRESETS = [
  { id: 'bellin-prep', name: 'Bellin Prep Team', fax: '+19204368549' }
];

// Unified Requested Documentation list — replaces the older split between
// records / labs / diagnostic testing. Order here drives the order in the
// modal grid and on the printed fax.
const REQUESTED_DOCS = [
  ['doc-hp',          'Complete History and Physical'],
  ['doc-cbc',         'CBC'],
  ['doc-bmp',         'BMP'],
  ['doc-hba1c',       'HbA1C'],
  ['doc-coag',        'PT/PTT'],
  ['doc-ekg',         'EKG'],
  ['doc-echo',        'Echocardiogram'],
  ['doc-lipid',       'Lipid Profile'],
  ['doc-cardiac-risk','Cardiac Risk Assessment'],
  ['doc-mgmt-notes',  'Medical Management Notes']
];
const URGENCY = ['Routine','Expedited','Urgent','STAT'];

let _modalBuilt = false;

function $(id) { return document.getElementById(id); }

// ── Signature inlining ─────────────────────────────────────────────────────
// FaxAge (and most HTML→fax renderers) run in a sandbox that can't resolve
// relative asset URLs, and won't honor mix-blend-mode / CSS filters. The old
// approach relied on both, so recipients often saw an empty box where the
// signature should be. Fix: load each signature PNG once, run it through a
// canvas to knock out the white background (any near-white pixel → alpha 0)
// and force the ink to solid black, then cache the resulting base64 data URL.
// Downstream we embed that data URL directly in the fax HTML — no external
// fetches, no CSS trickery required for it to render.
const _SIGNATURE_URLS = {
  josh: 'assets/signatures/josh.png',
  dev:  'assets/signatures/dev.png'
};
const _sigCache   = {};
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
        c.width  = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        // Fill white first so the output is opaque — fax gateways render any
        // transparent pixels as BLACK (that's the "black background" Josh
        // saw), so we produce a plain white-page-with-black-ink signature
        // that matches the fax paper.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height);
        const d  = px.data;
        for(let i = 0; i < d.length; i += 4) {
          const bright = (d[i] + d[i+1] + d[i+2]) / 3;
          if(bright > 200) {
            // background / paper → solid white
            d[i] = 255; d[i+1] = 255; d[i+2] = 255; d[i+3] = 255;
          } else {
            // ink → solid black, opaque so it doesn't rely on alpha at all
            d[i] = 0;   d[i+1] = 0;   d[i+2] = 0;   d[i+3] = 255;
          }
        }
        ctx.putImageData(px, 0, 0);
        // Export as JPEG to guarantee no alpha channel makes it into the fax.
        const url = c.toDataURL('image/jpeg', 0.92);
        _sigCache[key] = url;
        resolve(url);
      } catch(e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Could not load signature: ' + _SIGNATURE_URLS[key]));
    img.src = _SIGNATURE_URLS[key];
  });
  return _sigLoading[key];
}

// Warm the signature cache in the background so the first fax preview
// already has the inlined data URLs to swap in. If the modal is already
// on-screen when the load finishes, kick a preview refresh so the just-
// -processed signature swaps into place immediately.
try {
  _ensureSignatureLoaded('josh').then(() => { if(typeof refreshPreview === 'function') refreshPreview(); }).catch(() => {});
  _ensureSignatureLoaded('dev').then(() => { if(typeof refreshPreview === 'function') refreshPreview(); }).catch(() => {});
} catch(_){}

// Format the current moment as "Jul 30, 2026 at 10:23 AM CT" — used for the
// transmission-timestamp header the recipient sees on the fax.
function _fmtFaxTimestamp() {
  try {
    return new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Chicago'
    }).replace(',', ' ·') + ' CT';
  } catch(e) { return new Date().toISOString(); }
}

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
    btn.innerHTML = '📋 PRE-OP EVALUATION REQUEST <span style="background:rgba(255,255,255,.22);padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;margin-left:8px;letter-spacing:.6px">SENT</span>';
  } else {
    btn.style.background   = '';
    btn.style.borderColor  = '#0369a1';
    btn.style.color        = '#0369a1';
    btn.innerHTML = '📋 PRE-OP EVALUATION REQUEST';
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
// The pre-op record the modal is currently scoped to (chosen via dropdown).
// Until a case is selected, the form's patient fields render blank and Save
// Draft / Send refuse to proceed.
let _selectedPreop = null;

function readPreopForm() {
  // Patient details come from the SELECTED pre-op record (not the live form),
  // so the user explicitly chooses which case the fax is for.
  const r = _selectedPreop || {};
  return {
    patientName: [r['po-firstName']||'', r['po-lastName']||''].filter(Boolean).join(' ').trim()
              || r['po-patient'] || '',
    patientDob:  r['po-dob'] || '',
    patientPhone: r['po-contact-phone'] || '',
    surgeryDate: r['po-surgeryDate'] || '',
    providerSig: r['po-providerSignature'] || '',
    caseWorker:  r.worker || ''
  };
}

function preopChoices() {
  // All upcoming cases with a Case ID, across every CRNA — Jordan needs to fax
  // for cases on both Josh's and Dev's lists. Soonest surgery date first.
  // Drop cases whose surgery date has passed OR whose case has been
  // finalized so the picker stays focused on cases that still need work.
  const records = window._rawPreopRecords || [];
  const todayIso = (typeof window.todayStr === 'function')
    ? window.todayStr()
    : new Date().toISOString().split('T')[0];
  const finalizedIds = new Set(
    (window.cases || []).filter(c => !c.draft && c.caseId).map(c => c.caseId)
  );
  return records
    .filter(r => r['po-caseId'])
    .filter(r => !finalizedIds.has(r['po-caseId']))
    .filter(r => (r['po-surgeryDate'] || '') >= todayIso)
    .sort((a, b) => (a['po-surgeryDate']||'').localeCompare(b['po-surgeryDate']||''));
}

function populateCaseDropdown() {
  const sel = $('pof-case-select');
  if(!sel) return;
  const choices = preopChoices();
  const currentValue = sel.value;
  sel.innerHTML = '<option value="">— Pick a case —</option>'
    + choices.map(r => {
        const name = [r['po-patientFirstName']||'', r['po-patientLastName']||''].filter(Boolean).join(' ').trim()
                  || [r['po-firstName']||'', r['po-lastName']||''].filter(Boolean).join(' ').trim()
                  || r['po-patient'] || '';
        const date = r['po-surgeryDate'] ? fmtDate(r['po-surgeryDate']) : '';
        const bits = [r['po-caseId']];
        if(name) bits.push(name);
        if(date) bits.push(date);
        return `<option value="${r.id}">${bits.join(' · ')}</option>`;
      }).join('');
  if(currentValue) sel.value = currentValue;
}

// Build a short PMH summary from the pre-op record's checked condition flags.
function buildPmhFromPreop(r) {
  if(!r) return '';
  const labels = {
    cv:     { htn:'HTN', cad:'CAD', angina:'Angina', mi:'MI', chf:'CHF', murmur:'Murmur', arrythmia:'Arrhythmia' },
    pulm:   { asthma:'Asthma', copd:'COPD', uri:'URI', 'sleep-apnea':'OSA', smoker:'Smoker' },
    gastro: { gerd:'GERD', 'hiat-hern':'Hiatal hernia', ulcer:'Ulcer' },
    renal:  { dialysis:'Dialysis', esrd:'ESRD' },
    neuro:  { depression:'Depression', 'anxiety-disorder':'Anxiety', seizures:'Seizures', cva:'CVA', 'nm-disease':'Neuromuscular disease' },
    meta:   { iddm:'T1DM', niddm:'T2DM', thyroid:'Thyroid', obesity:'Obesity', 'morbid-obesity':'Morbid obesity' },
    other:  { hiv:'HIV', 'hep-c':'Hep C', anemia:'Anemia', cancers:'Cancer Hx', steroids:'Steroids', coagulopathy:'Coagulopathy' }
  };
  const parts = [];
  Object.keys(labels).forEach(prefix => {
    Object.entries(labels[prefix]).forEach(([flag, lbl]) => {
      if(r[`po-${prefix}-${flag}`]) parts.push(lbl);
    });
  });
  return parts.join(', ');
}

// Push the selected pre-op's data into the editable form fields. Called BEFORE
// a saved draft / sent snapshot is applied on top, so user edits win.
function autofillFromSelectedCase() {
  if(!_selectedPreop) return;
  const r = _selectedPreop;
  // Only overwrite the field if the pre-op has a real value AND the target
  // is currently blank. Prevents autofill from wiping something the user
  // just typed by hand when they change the case selector.
  const setVal = (id, v) => {
    const el = $(id);
    if(!el) return;
    const val = (v == null ? '' : String(v)).trim();
    if(!val) return;
    if(el.value && el.value.trim()) return;   // don't clobber user input
    el.value = val;
  };
  // Patient identity — real field names are po-patientFirstName /
  // po-patientLastName / po-patientDOB / po-patientPhone. The previous
  // autofill was using non-existent field names (po-firstName, po-dob,
  // po-contact-phone) and silently filled nothing.
  const fullName = [r['po-patientFirstName'] || '', r['po-patientLastName'] || '']
    .filter(Boolean).join(' ').trim();
  setVal('pof-pt-name',  fullName);
  setVal('pof-pt-dob',   r['po-patientDOB']);
  setVal('pof-pt-phone', r['po-patientPhone']);
  // TO / practice / fax — pre-fill from the PCP fields Nicole entered on
  // the tracker. Nice-to-have so the CRNA doesn't retype what's on the row.
  setVal('pof-to',       r['po-pcp-name']);
  setVal('pof-fax',      r['po-pcp-fax']);
  setVal('pof-phone',    r['po-pcp-phone']);
  // Procedure details.
  setVal('pof-proc-date', r['po-surgeryDate']);
  setVal('pof-proc-type', r['po-procedureType']);
  setVal('pof-surgeon',   r['po-provider']);
  // Procedure location — surgery center ID → name, fall back to the ID string.
  const centerId = r['po-surgery-center'] || '';
  const center = (window.surgeryCenters || []).find(c => c.id === centerId);
  setVal('pof-proc-loc', center?.name || centerId);
  const hrs = r['po-est-hours'];
  if(hrs) setVal('pof-proc-length', hrs + ' hour' + (parseFloat(hrs) === 1 ? '' : 's'));
  // Medical summary.
  setVal('pof-pmh',       buildPmhFromPreop(r));
  setVal('pof-allergies', r['po-allergies']);
  setVal('pof-meds',      r['po-medications']);
  setVal('pof-past-surg', r['po-surgicalHistory']);
  // Tobacco/alcohol — auto-Yes if smoker flag is checked, otherwise leave blank.
  if(r['po-pulm-smoker']) {
    const yes = document.querySelector('input[name="pof-tobacco-alcohol"][value="Yes"]');
    if(yes && !document.querySelector('input[name="pof-tobacco-alcohol"]:checked')) yes.checked = true;
  }
  // Live preview refresh so the printed cover mirrors what just landed.
  if(typeof window._pofPreview === 'function') { try { window._pofPreview(); } catch(_){} }
}

async function onCaseSelected() {
  const sel = $('pof-case-select');
  if(!sel) return;
  const id = sel.value;
  const records = window._rawPreopRecords || [];
  _selectedPreop = records.find(r => r.id === id) || null;
  updateCaseIndicator();
  clearFormFieldsOnly();
  if(!_selectedPreop) {
    // No case picked → lock the rest of the modal so the user has to pick one.
    setCaseRequiredMode(true);
    showDraftHint(null);
    refreshPreview();
    return;
  }
  setCaseRequiredMode(false);
  autofillFromSelectedCase();
  // Priority: if the case has already been sent, show it in view-only mode.
  // Otherwise, if there's a draft, restore the draft. Otherwise blank slate.
  const sent = loadSentSnapshotForCurrentCase();
  if(sent) {
    applyFormState(sent);
    setViewOnlyMode(true);
    showDraftHint(sent, 'sent');
  } else {
    setViewOnlyMode(false);
    const draft = await loadDraftForCurrentCase();
    if(draft) {
      applyFormState(draft);
      showDraftHint(draft);
    } else {
      showDraftHint(null);
    }
  }
  refreshPreview();
}
window._pofOnCaseChange = onCaseSelected;

function buildModal() {
  if(_modalBuilt) return;
  const wrap = document.createElement('div');
  wrap.id = 'preopFaxModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px';
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:880px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 24px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:600">📋 PRE-OP EVALUATION REQUEST</div>
          <div style="font-size:12px;opacity:.75;margin-top:2px">Request labs, H&amp;P, and clearance from the patient's PCP</div>
        </div>
        <button onclick="closePreopFaxModal()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
      </div>

      <div style="padding:14px 24px;border-bottom:1px solid var(--border);background:#f8fafc">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Case <span style="color:var(--warn)">*</span></label>
        <select id="pof-case-select" onchange="window._pofOnCaseChange()" style="width:100%;padding:9px 11px;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;font-weight:500">
          <option value="">— Pick a case —</option>
        </select>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;font-style:italic">Patient info on the fax will be pulled from whichever case is selected here.</div>
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

      <!-- ─── Patient Info ─────────────────────────────────────────────── -->
      <div style="padding:14px 24px;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">Patient Information</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Patient Name</label>
            <input type="text" id="pof-pt-name" oninput="window._pofPreview()" placeholder="First Last" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Date of Birth</label>
            <input type="date" id="pof-pt-dob" oninput="window._pofPreview()" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Phone</label>
            <input type="tel" id="pof-pt-phone" oninput="window._pofPreview()" placeholder="(555) 555-5555" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Procedure Date</label>
            <input type="date" id="pof-proc-date" oninput="window._pofPreview()" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
          </div>
        </div>
      </div>

      <!-- Procedure Info section removed at Josh's request (not used on the
           records-request fax; adds clutter to the modal). Backing fields
           are kept as hidden inputs so any code that still reads them
           (readPreopForm / draft rehydration) doesn't crash. -->
      <div style="display:none">
        <input type="text" id="pof-proc-type">
        <input type="text" id="pof-surgeon">
        <input type="text" id="pof-proc-loc">
        <input type="text" id="pof-proc-length">
        <input type="radio" name="pof-anesth-type" value="MAC">
        <input type="radio" name="pof-anesth-type" value="General">
      </div>

      <!-- ─── Medical Summary ──────────────────────────────────────────── -->
      <div style="padding:14px 24px;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">Medical Summary</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">PMH (Past Medical History)</label>
            <textarea id="pof-pmh" oninput="window._pofPreview()" rows="2" placeholder="e.g. HTN, T2DM, mild asthma" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;resize:vertical;font-family:'DM Sans',sans-serif"></textarea>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Allergies</label>
            <textarea id="pof-allergies" oninput="window._pofPreview()" rows="2" placeholder="e.g. NKDA, or list" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;resize:vertical;font-family:'DM Sans',sans-serif"></textarea>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Medications</label>
            <textarea id="pof-meds" oninput="window._pofPreview()" rows="2" placeholder="List current meds" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;resize:vertical;font-family:'DM Sans',sans-serif"></textarea>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px">Past Surgical History</label>
            <textarea id="pof-past-surg" oninput="window._pofPreview()" rows="2" placeholder="Prior surgeries" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;resize:vertical;font-family:'DM Sans',sans-serif"></textarea>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:18px;margin-top:10px;flex-wrap:wrap">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);width:130px">Tobacco / Alcohol Use</span>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;margin:0">
            <input type="radio" name="pof-tobacco-alcohol" value="Yes" onchange="window._pofPreview()" style="margin:0"> Yes
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;margin:0">
            <input type="radio" name="pof-tobacco-alcohol" value="No" onchange="window._pofPreview()" style="margin:0"> No
          </label>
        </div>
      </div>

      <!-- ─── Requested Documentation ──────────────────────────────────── -->
      <div style="padding:14px 24px;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:6px">Requested Documentation</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 16px">
          ${REQUESTED_DOCS.map(([id, lbl]) => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
              <input type="checkbox" id="pof-${id}" onchange="window._pofPreview()" style="width:15px;height:15px"> ${lbl}
            </label>`).join('')}
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
            <input type="checkbox" id="pof-doc-other-cb" onchange="window._pofPreview()" style="width:15px;height:15px"> Other
          </label>
        </div>
        <input type="text" id="pof-doc-other-text" oninput="window._pofPreview()" placeholder="Other — describe..." style="width:100%;padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;margin-top:6px">
        <div style="margin-top:8px;font-size:11px;color:var(--text-faint);font-style:italic">Note: Attach any recent stress test results (within the past 5 years), if available.</div>

        <div style="display:grid;grid-template-columns:90px repeat(4,140px);align-items:center;margin-top:12px">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">Urgency</span>
          ${URGENCY.map(u => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0">
              <input type="radio" name="pof-urgency" value="${u}" onchange="window._pofPreview()" style="margin:0"> ${u}
            </label>`).join('')}
        </div>
      </div>

      <div style="padding:10px 24px;border-bottom:1px solid var(--border)">${(typeof window.scheduleToggleHTML==='function')?window.scheduleToggleHTML('pof'):''}</div>

      <div style="padding:14px 24px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-faint)" id="pof-draft-hint">Patient info pulls from the active Pre-Op record automatically.</div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-ghost" onclick="window._pofClear()">Clear Form</button>
          <button class="btn btn-ghost" onclick="closePreopFaxModal()">Cancel</button>
          <button id="pof-save-draft-btn" class="btn btn-ghost" onclick="window._pofSaveDraft()" style="color:#0369a1;border-color:#0369a1">💾 Save Draft</button>
          <button id="pof-send-btn" data-fax-send="pof" class="btn btn-primary" onclick="window._pofSend()" style="background:#1d3557;border-color:#1d3557">📠 Send Pre-Op Fax</button>
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
  const w = workerFromForm();
  const today = todayIso();

  const checked = id => $('pof-' + id)?.checked;
  const urgency = document.querySelector('input[name="pof-urgency"]:checked')?.value || '';
  const anesth  = document.querySelector('input[name="pof-anesth-type"]:checked')?.value || '';
  const tobAlc  = document.querySelector('input[name="pof-tobacco-alcohol"]:checked')?.value || '';

  // Recipient + date range
  const to        = $('pof-to')?.value.trim()       || '';
  const practice  = $('pof-practice')?.value.trim() || '';
  const fax       = $('pof-fax')?.value.trim()      || '';
  const phone     = $('pof-phone')?.value.trim()    || '';
  const rangeFrom = $('pof-range-from')?.value || '';
  const rangeTo   = $('pof-range-to')?.value || '';

  // Patient + procedure (from modal fields — editable, may override the case)
  const ptName   = $('pof-pt-name')?.value.trim()    || '';
  const ptDob    = $('pof-pt-dob')?.value            || '';
  const ptPhone  = $('pof-pt-phone')?.value.trim()   || '';
  const procDate = $('pof-proc-date')?.value         || '';
  const procType = $('pof-proc-type')?.value.trim()  || '';
  const surgeon  = $('pof-surgeon')?.value.trim()    || '';
  const procLoc  = $('pof-proc-loc')?.value.trim()   || '';
  const procLen  = $('pof-proc-length')?.value.trim()|| '';

  // Medical summary
  const pmh       = $('pof-pmh')?.value.trim()        || '';
  const allergies = $('pof-allergies')?.value.trim()  || '';
  const meds      = $('pof-meds')?.value.trim()       || '';
  const pastSurg  = $('pof-past-surg')?.value.trim()  || '';

  // Documentation other
  const docOtherTxt = $('pof-doc-other-text')?.value.trim() || '';
  const docOtherOn  = checked('doc-other-cb') || !!docOtherTxt;

  const box = (on, lbl) => `<span style="display:inline-block;width:11px;height:11px;border:1px solid #444;text-align:center;line-height:9px;font-size:9px;font-weight:bold;margin-right:5px;vertical-align:middle">${on?'✗':''}</span>${lbl}`;
  const grid = (items) => `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 12px">${items.map(s=>`<div>${s}</div>`).join('')}</div>`;
  const labelVal = (lbl, val, minW) => `<div style="margin-bottom:4px"><span style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase">${lbl}:</span> <span style="border-bottom:1px solid #888;display:inline-block;min-width:${minW||140}px;padding-left:4px">${val||'&nbsp;'}</span></div>`;
  const block = (lbl, val) => `<div style="margin-bottom:6px"><div style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase;margin-bottom:2px">${lbl}</div><div style="border-bottom:1px solid #888;min-height:14px;padding:2px 4px;font-size:10px">${val||'&nbsp;'}</div></div>`;
  const sectionHdr = (txt) => `<div style="background:#eef2f7;padding:5px 10px;font-size:10px;font-weight:bold;color:#1d3557;letter-spacing:.5px;margin-top:8px">${txt}</div>`;

  return `
    <div style="background:#1d3557;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;margin:-24px -24px 14px">
      <div>
        <div style="font-size:18px;font-weight:bold;letter-spacing:.5px">ATLAS ANESTHESIA</div>
        <div style="font-size:10px;opacity:.85;margin-top:1px">Mobile Office-Based Anesthesia</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:18px;font-weight:bold">FAX</div>
        <div style="font-size:10px;opacity:.85;margin-top:1px">PRE-OP EVALUATION REQUEST</div>
        <div style="font-size:9px;opacity:.85;margin-top:3px">Transmitted: ${_fmtFaxTimestamp()}</div>
      </div>
    </div>

    <div style="font-size:14px;font-weight:bold;color:#1d3557;margin-bottom:2px">Pre-Operative Evaluation Request</div>
    <div style="font-size:11px;color:#333;margin-bottom:10px">Please review the patient identified below and fax back the documentation checked, along with the signed Provider Certification.</div>

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
        ${labelVal('RETURN FAX', window._userRole === 'assistant' ? '317-608-3539' : (RETURN_FAX[w] || ''))}
      </div>
    </div>

    ${sectionHdr('PATIENT INFORMATION')}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:8px 0 12px">
      <div>
        ${labelVal('NAME', ptName)}
        ${labelVal('PHONE', ptPhone)}
      </div>
      <div>
        ${labelVal('DOB', ptDob ? fmtDate(ptDob) : '')}
        ${labelVal('PROCEDURE DATE', procDate ? fmtDate(procDate) : '')}
      </div>
    </div>

    ${sectionHdr('MEDICAL SUMMARY')}
    <div style="margin:8px 0 4px">
      ${block('PMH', pmh)}
      ${block('ALLERGIES', allergies)}
      ${block('MEDICATIONS', meds)}
      ${block('PAST SURGICAL HISTORY', pastSurg)}
      <div style="font-size:11px;margin-top:6px"><strong style="font-size:9px;color:#555;text-transform:uppercase">Tobacco / Alcohol Use:</strong>
        <span style="margin-left:10px">${box(tobAlc==='Yes', 'Yes')}</span>
        <span style="margin-left:14px">${box(tobAlc==='No', 'No')}</span>
      </div>
    </div>

    ${sectionHdr('REQUESTED DOCUMENTATION')}
    <div style="margin:8px 0 4px">
      ${grid([
        ...REQUESTED_DOCS.map(([id, lbl]) => box(checked(id), lbl)),
        box(docOtherOn, 'Other: ' + (docOtherTxt ? `<span style="border-bottom:1px solid #888;padding-left:4px">${docOtherTxt}</span>` : ''))
      ])}
    </div>
    <div style="font-size:10px;margin-top:6px;font-style:italic;color:#666">Note: Attach any recent stress test results (within the past 5 years), if available.</div>

    <div style="margin-top:10px;font-size:11px"><strong>URGENCY:</strong>
      ${URGENCY.map(u => `<span style="margin-left:14px">${box(urgency===u, u)}</span>`).join('')}
    </div>

    <div style="margin-top:14px;display:grid;grid-template-columns:1fr 200px;gap:18px;align-items:end">
      <div>
        <div style="font-size:9px;color:#555;font-weight:600;text-transform:uppercase;margin-bottom:2px">Requested By</div>
        <img src="${_sigCache[w === 'josh' ? 'josh' : 'dev'] || _SIGNATURE_URLS[w === 'josh' ? 'josh' : 'dev']}" style="height:78px;display:block" alt="Signature" onerror="this.style.display='none'">
        <div style="border-top:1px solid #000;width:240px;font-size:10px;padding-top:2px;margin-top:2px">${providerName(w)} &middot; Atlas Anesthesia</div>
      </div>
      <div style="text-align:right;font-size:10px;color:#555">
        <div>DATE: <span style="border-bottom:1px solid #888;padding:0 6px">${fmtDate(today)}</span></div>
        <div style="margin-top:4px;font-size:9px;color:#666;font-style:italic">Sent: ${_fmtFaxTimestamp()}</div>
      </div>
    </div>

    ${sectionHdr('PROVIDER CERTIFICATION')}
    <div style="margin:8px 0 4px;font-size:11px;line-height:1.5">
      <div>I certify that the patient's medical condition has been reviewed and is:</div>
      <div style="margin:6px 0">
        <span>${box(false, 'Medically Optimized')}</span>
        <span style="margin-left:16px">${box(false, 'Not Medically Optimized')}</span>
      </div>
      ${block('MEDICATIONS TO HOLD PRIOR TO PROCEDURE', '')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:8px">
        <div>${block('PROVIDER SIGNATURE', '')}</div>
        <div>${block('PROVIDER NAME / CREDENTIALS', '')}</div>
      </div>
      ${block('DATE', '')}
    </div>

    <div style="margin-top:14px;background:#fdecec;border:1px solid #f5b5b5;border-radius:3px;padding:6px 10px;font-size:9px;color:#444;line-height:1.4">
      <strong style="color:#a13030">CONFIDENTIALITY &amp; AUTHORIZATION NOTICE</strong><br>
      This request is made for the purpose of pre-anesthesia evaluation. The patient has authorized release of records to Atlas Anesthesia for the procedure noted above. This facsimile transmission may contain protected health information privileged and confidential under HIPAA and applicable state law. It is intended only for the addressee. If you received this fax in error, please notify Atlas Anesthesia immediately and destroy all copies. Records may be returned via the fax number listed in the "RETURN FAX" field above.
    </div>

    <div style="margin-top:8px;font-size:9px;color:#888;text-align:center">Atlas Anesthesia · Pre-Operative Evaluation Request · Page 1 of 1</div>
  `;
}

function refreshPreview() {
  const el = $('pof-preview');
  if(el) el.innerHTML = buildPreviewHTML();
}
window._pofPreview = refreshPreview;

// ── Form-state serialization for drafts ────────────────────────────────────
// Drafts live on the corresponding pre-op record as `_preopFaxDraft` so they
// follow the case automatically — open the same record again, get your draft.

// Render the currently-displayed fax preview into a PDF and return its
// base64 body. Uses the exact same html2canvas + jsPDF pipeline the
// insurance sheet uses so the fax lands as a pixel-perfect copy of what
// the user sees on-screen — colors, layout, fonts, everything. If the
// libraries aren't loaded (unlikely) we return null so the caller can
// fall back to sending raw HTML.
async function _pofBuildPDFBase64() {
  if(typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) return null;
  const src = document.getElementById('pof-preview');
  if(!src) return null;
  // Snapshot at 2× so text edges stay crisp when FaxAge reduces to fax DPI.
  // useCORS lets our inlined signature data URL make it through cleanly.
  const canvas = await window.html2canvas(src, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const imgW = pageW - margin * 2;
  const imgH = imgW * (canvas.height / canvas.width);
  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  if(imgH <= pageH - margin * 2) {
    pdf.addImage(imgData, 'JPEG', margin, margin, imgW, imgH);
  } else {
    // Split onto multiple pages if the preview taller than one Letter sheet.
    let yOffset = 0;
    while(yOffset < imgH) {
      pdf.addImage(imgData, 'JPEG', margin, margin - yOffset, imgW, imgH);
      yOffset += pageH - margin * 2;
      if(yOffset < imgH) pdf.addPage();
    }
  }
  const dataUri = pdf.output('datauristring');
  const base64  = dataUri.split('base64,')[1] || '';
  return base64;
}

function getCurrentCaseId() {
  // Source of truth is the selected pre-op record. Fall back to the live
  // pre-op form's case ID only when nothing is selected yet (rare; would
  // only matter if the modal is opened with the page form pre-populated
  // but the dropdown hasn't initialised).
  return _selectedPreop?.['po-caseId']
      || document.getElementById('po-caseId')?.value
      || document.getElementById('po-caseId-display')?.textContent?.trim()
      || '';
}

function readFormState() {
  const state = { __savedAt: new Date().toISOString() };
  document.querySelectorAll('#preopFaxModal input, #preopFaxModal select, #preopFaxModal textarea').forEach(el => {
    const key = el.id || el.name;
    if(!key) return;
    if(el.type === 'checkbox') state[key] = el.checked;
    else if(el.type === 'radio') { if(el.checked) state[key] = el.value; }
    else state[key] = el.value;
  });
  return state;
}

function applyFormState(state) {
  if(!state) return;
  Object.keys(state).forEach(key => {
    if(key === '__savedAt') return;
    const el = document.getElementById(key);
    if(el) {
      if(el.type === 'checkbox') el.checked = !!state[key];
      else if(el.type !== 'radio') el.value = state[key] || '';
      return;
    }
    // Radios live by name, not id
    document.querySelectorAll(`#preopFaxModal input[name="${key}"]`).forEach(r => {
      if(r.value === state[key]) r.checked = true;
    });
  });
}

function showDraftHint(state, mode) {
  const hint = $('pof-draft-hint');
  if(!hint) return;
  if(mode === 'sent' && state && state.__sentAt) {
    const when = new Date(state.__sentAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const to = state.__sentTo ? ` to ${state.__sentTo}` : '';
    hint.innerHTML = `<span style="color:#16a34a;font-weight:500">📠 Already sent ${when}${to} — view only (locked)</span>`;
    return;
  }
  if(state && state.__savedAt) {
    const when = new Date(state.__savedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    hint.innerHTML = `<span style="color:var(--success,#16a34a);font-weight:500">✓ Draft restored — saved ${when}</span>`;
  } else {
    hint.textContent = 'Patient info pulls from the active Pre-Op record automatically.';
  }
}

// Lock the modal for a case that's already been sent. The case dropdown stays
// usable so the user can switch to a different case; everything else gets
// disabled and the action buttons hidden.
function setViewOnlyMode(on) {
  document.querySelectorAll('#preopFaxModal input, #preopFaxModal select, #preopFaxModal textarea').forEach(el => {
    if(el.id === 'pof-case-select') return;     // keep the case picker live
    el.disabled = !!on;
  });
  const saveBtn  = $('pof-save-draft-btn');
  const sendBtn  = $('pof-send-btn');
  const clearBtn = document.querySelector('#preopFaxModal button[onclick="window._pofClear()"]');
  if(saveBtn)  saveBtn.style.display  = on ? 'none' : '';
  if(sendBtn)  sendBtn.style.display  = on ? 'none' : '';
  if(clearBtn) clearBtn.style.display = on ? 'none' : '';
}

// Disables every form field except the case dropdown until a case is picked.
// Also dims the body of the modal so it's obvious a case ID is required first.
function setCaseRequiredMode(locked) {
  document.querySelectorAll('#preopFaxModal input, #preopFaxModal select, #preopFaxModal textarea').forEach(el => {
    if(el.id === 'pof-case-select') return;
    el.disabled = !!locked;
  });
  const saveBtn = $('pof-save-draft-btn');
  const sendBtn = $('pof-send-btn');
  if(saveBtn) saveBtn.disabled = !!locked;
  if(sendBtn) sendBtn.disabled = !!locked;
  // Make the prompt above the dropdown louder when locked.
  const hint = document.querySelector('#preopFaxModal #pof-case-select')?.parentElement?.querySelector('div[style*="font-style:italic"]');
  if(hint) {
    if(locked) {
      hint.innerHTML = '<span style="color:var(--warn);font-weight:600">⚠ Pick a case ID above before filling in anything else.</span>';
    } else {
      hint.textContent = 'Patient info on the fax will be pulled from whichever case is selected here.';
    }
  }
}

async function loadDraftForCurrentCase() {
  const caseId = getCurrentCaseId();
  if(!caseId) return null;
  // Prefer cached records, fall back to Firestore.
  let records = window._rawPreopRecords || [];
  let r = records.find(x => x['po-caseId'] === caseId);
  if(!r && typeof window.getDoc === 'function') {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', 'preop'));
      records = snap.exists() ? (snap.data().records || []) : [];
      r = records.find(x => x['po-caseId'] === caseId);
    } catch(e) { console.warn('loadDraftForCurrentCase:', e); }
  }
  return r?._preopFaxDraft || null;
}

function loadSentSnapshotForCurrentCase() {
  // Reads from the cached records — doesn't hit Firestore. Returns the
  // form-state object that was sent, or null. Includes __sentAt timestamp.
  const caseId = getCurrentCaseId();
  if(!caseId) return null;
  const records = window._rawPreopRecords || [];
  const r = records.find(x => x['po-caseId'] === caseId);
  return r?._preopFaxSent || null;
}

async function persistSentSnapshot(snapshot) {
  const caseId = getCurrentCaseId();
  if(!caseId || typeof window.getDoc !== 'function') return false;
  try {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'preop'));
    const records = snap.exists() ? (snap.data().records || []) : [];
    const idx = records.findIndex(r => r['po-caseId'] === caseId);
    if(idx === -1) return false;
    records[idx]._preopFaxSent = snapshot;
    await window.setDoc(window.doc(window.db, 'atlas', 'preop'), { records });
    window._rawPreopRecords = records;
    window._cachedPreopRecords = [...records];
    return true;
  } catch(e) {
    console.warn('persistSentSnapshot:', e);
    return false;
  }
}

async function persistDraft(draftOrNull) {
  const caseId = getCurrentCaseId();
  if(!caseId) {
    alert('Cannot save draft — no Case ID is available. Save the Pre-Op record first.');
    return false;
  }
  if(typeof window.getDoc !== 'function') {
    alert('Cloud sync is not ready yet. Try again in a moment.');
    return false;
  }
  try {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'preop'));
    const records = snap.exists() ? (snap.data().records || []) : [];
    const idx = records.findIndex(r => r['po-caseId'] === caseId);
    if(idx === -1) {
      alert('No matching Pre-Op record found for Case ID ' + caseId + '. Save the Pre-Op record first.');
      return false;
    }
    if(draftOrNull) {
      records[idx]._preopFaxDraft = draftOrNull;
    } else {
      delete records[idx]._preopFaxDraft;
    }
    await window.setDoc(window.doc(window.db, 'atlas', 'preop'), { records });
    // Refresh the in-memory cache so subsequent opens see the new draft
    window._rawPreopRecords = records;
    window._cachedPreopRecords = [...records];
    return true;
  } catch(e) {
    console.error('persistDraft:', e);
    alert('Could not save draft: ' + e.message);
    return false;
  }
}

window._pofSaveDraft = async function() {
  if(!_selectedPreop) {
    alert('Pick a case from the dropdown at the top before saving a draft.');
    const sel = $('pof-case-select');
    if(sel) sel.focus();
    return;
  }
  const btn = $('pof-save-draft-btn');
  if(btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  const state = readFormState();
  const ok = await persistDraft(state);
  if(btn) { btn.textContent = '💾 Save Draft'; btn.disabled = false; }
  if(ok) {
    showDraftHint(state);
    alert('✓ Draft saved! You can come back to this Pre-Op later and the form will be restored.');
  }
};

function clearFormFieldsOnly() {
  // Clears recipient + patient info + medical summary + documentation
  // checkboxes. Does NOT touch the case dropdown or _selectedPreop.
  const textIds = [
    'pof-preset','pof-to','pof-practice','pof-fax','pof-phone','pof-range-from','pof-range-to',
    'pof-pt-name','pof-pt-dob','pof-pt-phone','pof-proc-date',
    'pof-proc-type','pof-surgeon','pof-proc-loc','pof-proc-length',
    'pof-pmh','pof-allergies','pof-meds','pof-past-surg',
    'pof-doc-other-text'
  ];
  textIds.forEach(id => { const el = $(id); if(el) el.value = ''; });
  document.querySelectorAll('#preopFaxModal input[type="checkbox"]').forEach(cb => cb.checked = false);
  document.querySelectorAll('#preopFaxModal input[type="radio"]').forEach(r => r.checked = false);
}
function clearForm() {
  clearFormFieldsOnly();
  refreshPreview();
}
window._pofClear = clearForm;

function updateCaseIndicator() {
  const ind = $('pof-case-indicator');
  if(!ind) return;
  const caseId = getCurrentCaseId();
  const r = readPreopForm();
  const name = r.patientName || '';
  const dob  = r.patientDob ? fmtDate(r.patientDob) : '';
  const surg = r.surgeryDate ? fmtDate(r.surgeryDate) : '';
  const chip = (text, mono) => `<span style="background:rgba(255,255,255,.18);color:#fff;padding:3px 10px;border-radius:20px;font-size:11px;${mono?"font-family:'DM Mono',monospace;":''}font-weight:500">${text}</span>`;
  const subtle = (text) => `<span style="color:rgba(255,255,255,.75);font-size:12px">${text}</span>`;
  const parts = [];
  if(caseId) parts.push(chip(caseId, true));
  else parts.push(`<span style="color:#ffb">⚠ Pick a case from the dropdown below</span>`);
  if(name) parts.push(subtle('· ' + name));
  if(dob)  parts.push(subtle('· DOB ' + dob));
  if(surg) parts.push(subtle('· Surgery ' + surg));
  ind.innerHTML = parts.join('');
}

window.openPreopFaxModal = async function() {
  buildModal();
  clearFormFieldsOnly();
  // Refresh the dropdown each open so newly-created pre-ops show up.
  populateCaseDropdown();
  // If the user opened the modal from the PCP card on a loaded Pre-Op form,
  // try to pre-select that case so they don't have to re-pick it.
  const formCaseId = document.getElementById('po-caseId')?.value || '';
  const records = window._rawPreopRecords || [];
  const cw = (typeof window.currentWorker !== 'undefined' ? window.currentWorker : 'dev');
  const match = formCaseId
    ? records.find(r => r['po-caseId'] === formCaseId && (r.worker || 'dev') === cw)
    : null;
  const sel = $('pof-case-select');
  if(match && sel) {
    sel.value = match.id;
    _selectedPreop = match;
  } else {
    if(sel) sel.value = '';
    _selectedPreop = null;
  }
  updateCaseIndicator();
  $('preopFaxModal').style.display = 'flex';
  if(_selectedPreop) {
    setCaseRequiredMode(false);
    autofillFromSelectedCase();
    const sent = loadSentSnapshotForCurrentCase();
    if(sent) {
      applyFormState(sent);
      setViewOnlyMode(true);
      showDraftHint(sent, 'sent');
    } else {
      setViewOnlyMode(false);
      const draft = await loadDraftForCurrentCase();
      if(draft) {
        applyFormState(draft);
        showDraftHint(draft);
      } else {
        showDraftHint(null);
      }
    }
  } else {
    // No case pre-selected (modal opened without a current pre-op) — lock
    // everything until the user picks a case ID from the dropdown.
    setViewOnlyMode(false);
    setCaseRequiredMode(true);
    showDraftHint(null);
  }
  refreshPreview();
};

window.closePreopFaxModal = function() {
  const m = $('preopFaxModal');
  if(m) m.style.display = 'none';
};

window._pofSend = async function() {
  if(!_selectedPreop) {
    alert('Pick a case from the dropdown at the top before sending the fax.');
    const sel = $('pof-case-select');
    if(sel) sel.focus();
    return;
  }
  const rawFax = $('pof-fax')?.value.trim() || '';
  const to  = $('pof-to')?.value.trim()  || '';
  if(!rawFax) { alert('Please enter a Recipient Fax #.'); return; }
  // Normalize to E.164 the same way fax.js does — strip parens, dashes,
  // spaces, and add +1 if the country code is missing. This way Oliver can
  // paste things like "+1(833)485-5191" or "833-485-5191" and it still ends
  // up as +18334855191 for FaxAge.
  const digitsOnly = rawFax.replace(/[^0-9+]/g, '');
  let fax;
  if(digitsOnly.startsWith('+')) {
    fax = '+' + digitsOnly.slice(1).replace(/[^0-9]/g, '');
  } else {
    const digits = digitsOnly.replace(/[^0-9]/g, '');
    if(digits.length === 11 && digits.startsWith('1')) fax = '+' + digits;
    else if(digits.length === 10) fax = '+1' + digits;
    else fax = '';
  }
  if(!fax || fax.length < 12) { alert('That fax number doesn\'t look right. Try the format +19205551234 (or paste with dashes / parens — we\'ll clean them up).'); return; }
  if(!to)  { alert('Please enter the Recipient Name (or pick a preset).'); return; }

  const choice = (typeof window.readScheduleChoice === 'function') ? window.readScheduleChoice('pof') : { mode: 'now' };
  if(choice.error) { alert(choice.error); return; }

  const btn = $('pof-send-btn');
  const origLabel = btn?.textContent;
  if(btn) { btn.textContent = choice.mode === 'later' ? 'Scheduling...' : 'Sending...'; btn.disabled = true; }

  try {
    // Make sure BOTH signatures are baked into the data-URL cache before we
    // build the HTML — otherwise the outgoing fax falls back to the relative
    // asset URL and the FaxAge renderer can't fetch it.
    try {
      await Promise.all([
        _ensureSignatureLoaded('josh').catch(() => {}),
        _ensureSignatureLoaded('dev').catch(() => {})
      ]);
    } catch(_){}
    const html = buildPreviewHTML();
    const w = workerFromForm();
    const r = readPreopForm();
    // Also render the preview to a PDF so the fax matches on-screen
    // pixel-for-pixel (FaxAge accepts PDF and faxes it verbatim, no HTML
    // re-rendering). If the worker doesn't consume pdfBase64, no harm —
    // it still has the html payload to fall back on.
    let pdfBase64 = '';
    try {
      // Make sure the preview DOM is current before we snapshot it.
      if(typeof refreshPreview === 'function') refreshPreview();
      pdfBase64 = await _pofBuildPDFBase64() || '';
    } catch(pdfErr) { console.warn('PDF render for fax failed — falling back to HTML:', pdfErr); }
    const result = (typeof window.sendOrScheduleFax === 'function')
      ? await window.sendOrScheduleFax({ faxNumber: fax, caseId: to, worker: w, html, pdfBase64, source: 'pre-op' }, choice)
      : await (async () => {
          const rsp = await fetch(FAX_WORKER_URL, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ to: fax, caseId: to, worker: w, html, pdfBase64 }) });
          const d = await rsp.json();
          return { success: !!(rsp.ok && d.success), scheduled: false, sid: d.sid, error: d.error };
        })();

    if(result.success && !result.scheduled) {
      try { window.logAudit && window.logAudit('preop-fax-sent', _selectedPreop?.['po-caseId'] || '', `to ${to} (${fax})`); } catch(e){}
      alert('✅ Pre-Op fax sent to ' + fax + '! SID: ' + (result.sid || 'N/A'));
      const flag = $('po-bellin-fax-sent-flag');
      if(flag) flag.value = 'true';
      syncSendButtonState();
      const sentSnapshot = { ...readFormState(), __sentAt: new Date().toISOString(), __sentTo: fax };
      persistSentSnapshot(sentSnapshot).catch(()=>{});
      persistDraft(null).catch(()=>{});
      window.closePreopFaxModal();
    } else if(result.success && result.scheduled) {
      const when = new Date(choice.sendAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
      alert('📅 Pre-Op fax scheduled for ' + when + ' to ' + fax + '. It will be sent automatically. (Use 📅 Scheduled Faxes to cancel.)');
      window.closePreopFaxModal();
    } else {
      alert('❌ Pre-Op fax failed: ' + (result.error || 'Unknown error'));
    }
  } catch(e) {
    alert('❌ Error: ' + e.message);
  } finally {
    if(btn) { btn.textContent = '📠 Send Pre-Op Fax'; btn.disabled = false; }
  }
};
