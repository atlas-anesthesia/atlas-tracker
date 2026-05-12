// -- insurance-sheet.js — Insurance Claim fax modal -----------------------------
// Triggered from the Finalize Case page. Two modes (Flat Fee / CDT Codes)
// share the same recipient + send pipeline (FaxAge via the existing Cloudflare
// Worker), but each renders a different claim sheet. Patient info is read off
// the live Finalize Case form so the user doesn't re-type it.
//
// PLACEHOLDER: the actual field layout for each sheet will be filled in once
// Oliver provides the Flat Fee and CDT Code PDFs.
//
// Depends on: app.js for currentWorker, window.db/getDoc/setDoc/doc.

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
let _mode = 'flat';   // 'flat' | 'cdt'
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
          <div style="font-size:12px;opacity:.75;margin-top:2px">Send a flat-fee or CDT-code claim by fax</div>
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
          <input type="radio" name="ins-mode" value="flat" checked onchange="window._insSetMode('flat')" style="margin:0"> Flat Fee
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
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);display:block;margin-bottom:4px">Recipient Fax #</label>
          <input type="tel" id="ins-fax" oninput="window._insPreview()" placeholder="+18005551234" style="width:100%;padding:7px 10px;font-size:13px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none">
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
          <button id="ins-send-btn" data-fax-send="ins" class="btn btn-primary" onclick="window._insSend()" style="background:#1d3557;border-color:#1d3557">📠 Send Insurance Fax</button>
        </div>
      </div>

      <div style="padding:20px 24px;background:#f4f4f4">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#666;margin-bottom:10px">FAX PREVIEW</div>
        <div id="ins-preview" style="background:#fff;border:1px solid #ccc;border-radius:4px;padding:24px;font-family:Arial,sans-serif;font-size:11px;color:#000;max-width:760px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.08)"></div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  _modalBuilt = true;
}

// ── Placeholder forms for each mode — replace with real fields once the PDFs
// are shared. Both modes need at least: patient info, case info, fee total.

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
  area.innerHTML = mode === 'cdt' ? renderCdtForm() : renderFlatFeeForm();
  if(mode === 'cdt') {
    // Seed with one empty CDT line so the user sees what to do
    window._insAddCdtLine();
  }
  refreshPreview();
};

window._insApplyPreset = function() {
  const sel = $('ins-preset');
  if(!sel) return;
  const preset = INSURANCE_PRESETS.find(p => p.id === sel.value);
  if(!preset) return;
  $('ins-to').value  = preset.name;
  $('ins-fax').value = preset.fax;
  refreshPreview();
};

function buildPreviewHTML() {
  const ctx = readCaseContext();
  const w   = workerNow();
  const to       = $('ins-to')?.value.trim()       || '';
  const fax      = $('ins-fax')?.value.trim()      || '';
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
        <div style="font-size:18px;font-weight:bold">FAX</div>
        <div style="font-size:10px;opacity:.85;margin-top:1px">INSURANCE CLAIM</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:12px">
      <div>
        ${labelVal('TO', to)}
        ${labelVal('FAX #', fax)}
        ${labelVal('PHONE', phone)}
      </div>
      <div>
        ${labelVal('FROM', 'Atlas Anesthesia')}
        ${labelVal('PROVIDER', providerName(w))}
        ${labelVal('DATE', fmtDate(today))}
        ${labelVal('RETURN FAX', RETURN_FAX[w] || '')}
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

    <div style="margin-top:14px;background:#fdecec;border:1px solid #f5b5b5;border-radius:3px;padding:6px 10px;font-size:9px;color:#444;line-height:1.4">
      <strong style="color:#a13030">CONFIDENTIALITY &amp; AUTHORIZATION NOTICE</strong><br>
      This claim contains protected health information privileged and confidential under HIPAA and applicable state law. It is intended only for the addressee. If you received this fax in error, please notify Atlas Anesthesia immediately and destroy all copies.
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
  ['ins-preset','ins-to','ins-fax','ins-phone'].forEach(id => {
    const el = $(id); if(el) el.value = '';
  });
  // Always default back to Flat Fee on open
  document.querySelectorAll('input[name="ins-mode"]').forEach(r => r.checked = (r.value === 'flat'));
  _mode = 'flat';
  window._insSetMode('flat');
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
    alert('Pick a case from the dropdown at the top before sending the fax.');
    const sel = $('ins-case-select');
    if(sel) sel.focus();
    return;
  }
  const fax = $('ins-fax')?.value.trim() || '';
  const to  = $('ins-to')?.value.trim()  || '';
  if(!fax) { alert('Please enter a Recipient Fax #.'); return; }
  if(!fax.startsWith('+')) { alert('Fax number needs the country code, e.g. +18005551234'); return; }
  if(!to)  { alert('Please enter the Insurer / Recipient name (or pick a preset).'); return; }

  const choice = (typeof window.readScheduleChoice === 'function') ? window.readScheduleChoice('ins') : { mode: 'now' };
  if(choice.error) { alert(choice.error); return; }

  const btn = $('ins-send-btn');
  const origLabel = btn?.textContent;
  if(btn) { btn.textContent = choice.mode === 'later' ? 'Scheduling...' : 'Sending...'; btn.disabled = true; }

  try {
    const html = buildPreviewHTML();
    const w = workerNow();
    const result = (typeof window.sendOrScheduleFax === 'function')
      ? await window.sendOrScheduleFax({ faxNumber: fax, caseId: to, worker: w, html, source: 'insurance' }, choice)
      : await (async () => {
          const rsp = await fetch(FAX_WORKER_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ to:fax, caseId:to, worker:w, html }) });
          const d = await rsp.json();
          return { success: !!(rsp.ok && d.success), scheduled: false, sid: d.sid, error: d.error };
        })();
    if(result.scheduled && result.success) {
      const when = new Date(choice.sendAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
      alert('📅 Insurance fax scheduled for ' + when + ' to ' + fax + '. It will be sent automatically.');
      window.closeInsuranceSheetModal();
      return;
    }
    const data = { success: result.success, sid: result.sid, error: result.error };
    if(data.success) {
      // Build a compact log entry of what was sent. Total is best-effort.
      const total = _mode === 'flat'
        ? (parseFloat($('ins-flat-amount')?.value) || 0)
        : Array.from(document.querySelectorAll('#ins-cdt-lines .ins-cdt-line')).reduce((s, row) => {
            const qty = parseFloat(row.querySelector('.ins-cdt-qty')?.value) || 0;
            const fee = parseFloat(row.querySelector('.ins-cdt-fee')?.value) || 0;
            return s + qty * fee;
          }, 0);
      const ctx = readCaseContext();
      await logSentInsurance({
        id: Math.random().toString(36).slice(2, 11),
        sentAt: new Date().toISOString(),
        worker: w,
        mode: _mode,
        caseId: _selectedPreop['po-caseId'] || '',
        patientName: ctx.patientName,
        surgeryDate: ctx.surgeryDate,
        recipient: to,
        faxNumber: fax,
        total,
        sid: data.sid || '',
        html
      });
      alert('✅ Insurance fax sent to ' + fax + '! SID: ' + (data.sid || 'N/A'));
      window.closeInsuranceSheetModal();
    } else {
      alert('❌ Insurance fax failed: ' + (data.error || 'Unknown error'));
    }
  } catch(e) {
    alert('❌ Error sending fax: ' + e.message);
  } finally {
    if(btn) { btn.textContent = origLabel || '📠 Send Insurance Fax'; btn.disabled = false; }
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
      const mode = e.mode === 'cdt' ? 'CDT' : 'Flat Fee';
      const total = e.total ? '$'+Number(e.total).toFixed(2) : '—';
      return `
        <div style="display:grid;grid-template-columns:120px 110px 1fr 1fr 90px 90px 60px;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:center">
          <span style="color:var(--text-muted)">${date}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px">${e.caseId || '—'}</span>
          <span style="font-weight:500">${e.patientName || '—'}</span>
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
