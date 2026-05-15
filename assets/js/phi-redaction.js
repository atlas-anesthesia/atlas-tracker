// PHI Redaction System for Atlas Tracker
// Automatically hides patient health information 3+ days after surgery date.
// Reveal requires password re-prompt (Josh or Dev only). All reveals audit-logged.

(function() {
  'use strict';

  const PHI_HIDE_DAYS = 3;

  // Set of case IDs revealed in this page session (in-memory only — cleared on refresh).
  window._revealedCases = window._revealedCases || new Set();

  // ──────────────────────────────────────────────────────────────────────────
  // Core helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if PHI should be hidden for this case.
   * @param {string} surgeryDateStr - ISO date string (YYYY-MM-DD)
   * @param {string} caseId
   */
  window.isPHIHidden = function(surgeryDateStr, caseId) {
    if (!surgeryDateStr) return false;
    if (caseId && window._revealedCases.has(caseId)) return false;
    const surgDate = new Date(surgeryDateStr + 'T12:00:00Z');
    if (isNaN(surgDate.getTime())) return false;
    const now = Date.now();
    const daysSince = (now - surgDate.getTime()) / 86400000;
    return daysSince > PHI_HIDE_DAYS;
  };

  /**
   * Returns the value if visible, or a styled "[hidden]" placeholder if hidden.
   * Use this anywhere PHI content needs to be displayed.
   */
  window.maskPHI = function(value, hidden) {
    if (!hidden) return value || '';
    if (value === undefined || value === null || value === '') return '';
    return '<span style="color:#94a3b8;font-style:italic;font-size:12px;background:#f1f5f9;padding:1px 8px;border-radius:8px">[hidden]</span>';
  };

  /**
   * Returns HTML for the "🔒 Show patient details" button to put on a hidden case.
   * @param {string} caseId - the case ID
   * @param {string} refreshFnName - the name of a global function to call after reveal (e.g. 'renderMidCases')
   */
  window.phiRevealButtonHTML = function(caseId, refreshFnName) {
    const safeFn = refreshFnName ? `'${refreshFnName}'` : 'null';
    return `<button onclick="event.stopPropagation();window.openPHIRevealModal('${caseId}',${safeFn})" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;font-size:10px;font-weight:600;padding:3px 9px;border-radius:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px" title="Patient details hidden under HIPAA minimum-necessary rule">🔒 Show patient details</button>`;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Reveal flow (password re-prompt)
  // ──────────────────────────────────────────────────────────────────────────

  // Only Josh or Dev (clinical providers) may reveal.
  function canReveal() {
    const worker = (window.currentWorker || '').toLowerCase();
    return worker === 'josh' || worker === 'dev';
  }

  window.openPHIRevealModal = function(caseId, refreshFnName) {
    if (!canReveal()) {
      alert('Only Josh or Dev can reveal patient information.');
      return;
    }
    ensureModalExists();
    const modal = document.getElementById('phiRevealModal');
    const input = document.getElementById('phiRevealPassword');
    const err = document.getElementById('phiRevealError');
    document.getElementById('phiRevealCaseId').textContent = caseId || '—';
    input.value = '';
    err.style.display = 'none';
    modal.style.display = 'flex';
    window._phiRevealCaseId = caseId;
    window._phiRevealRefreshFn = refreshFnName;
    setTimeout(() => input.focus(), 50);
  };

  window.closePHIRevealModal = function() {
    const modal = document.getElementById('phiRevealModal');
    if (modal) modal.style.display = 'none';
    window._phiRevealCaseId = null;
    window._phiRevealRefreshFn = null;
  };

  window.submitPHIReveal = async function() {
    const password = (document.getElementById('phiRevealPassword').value || '').trim();
    const err = document.getElementById('phiRevealError');
    const btn = document.getElementById('phiRevealSubmitBtn');
    err.style.display = 'none';
    if (!password) {
      err.textContent = 'Enter your password';
      err.style.display = 'block';
      return;
    }
    if (typeof window.verifyCurrentUserPassword !== 'function') {
      err.textContent = 'Password verification not available. Refresh the page.';
      err.style.display = 'block';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    try {
      await window.verifyCurrentUserPassword(password);
      const caseId = window._phiRevealCaseId;
      const refreshFn = window._phiRevealRefreshFn;
      if (caseId) window._revealedCases.add(caseId);
      // Audit log
      try {
        if (typeof window.logAudit === 'function') {
          window.logAudit('phi-revealed', caseId || '', '');
        }
      } catch (e) { /* non-fatal */ }
      window.closePHIRevealModal();
      // Trigger refresh of whichever view called this
      if (refreshFn && typeof window[refreshFn] === 'function') {
        try { window[refreshFn](); } catch (e) { console.warn('PHI refresh fn failed:', e); }
      }
    } catch (e) {
      err.textContent = 'Incorrect password. Try again.';
      err.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Reveal';
    }
  };

  // Create the modal HTML if not present
  function ensureModalExists() {
    if (document.getElementById('phiRevealModal')) return;
    const div = document.createElement('div');
    div.id = 'phiRevealModal';
    div.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,.55);z-index:9999;align-items:center;justify-content:center;padding:20px';
    div.innerHTML = `
      <div style="background:#fff;border-radius:14px;padding:28px;max-width:430px;width:100%;box-shadow:0 25px 50px -12px rgba(0,0,0,.35)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <div style="font-size:22px">🔒</div>
          <div style="font-size:18px;font-weight:700;color:#1e293b">Reveal Patient Information</div>
        </div>
        <div style="font-size:13px;color:#64748b;line-height:1.5;margin-bottom:18px">Patient details for case <strong id="phiRevealCaseId" style="color:#1e293b;font-family:'DM Mono',monospace">—</strong> are hidden because the case is more than 3 days old. Enter your password to reveal them for this session.</div>
        <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;color:#64748b;letter-spacing:.5px;margin-bottom:6px">Your password</label>
        <input type="password" id="phiRevealPassword" autocomplete="current-password" onkeydown="if(event.key==='Enter'){event.preventDefault();window.submitPHIReveal();}" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid #cbd5e1;border-radius:8px;outline:none;box-sizing:border-box">
        <div id="phiRevealError" style="display:none;color:#dc2626;font-size:12px;margin-top:8px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:6px 10px"></div>
        <div style="font-size:11px;color:#94a3b8;margin-top:10px;line-height:1.4">ⓘ This action will be recorded in the audit log.</div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
          <button onclick="window.closePHIRevealModal()" style="background:#f1f5f9;color:#475569;border:none;font-size:13px;font-weight:500;padding:9px 18px;border-radius:8px;cursor:pointer">Cancel</button>
          <button id="phiRevealSubmitBtn" onclick="window.submitPHIReveal()" style="background:#1d3557;color:#fff;border:none;font-size:13px;font-weight:600;padding:9px 18px;border-radius:8px;cursor:pointer">Reveal</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    // Click outside to close
    div.addEventListener('click', (e) => { if (e.target === div) window.closePHIRevealModal(); });
  }

  // Ensure modal exists once DOM is ready (in case helpers are called early)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureModalExists);
  } else {
    ensureModalExists();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Pre-Op form: PHI field detection and modal masking
  // ──────────────────────────────────────────────────────────────────────────

  // Field IDs in the pre-op form considered PHI. When editing a 3+ day old
  // record, these are NOT populated until the user re-verifies their password.
  const PHI_EXACT_FIELDS = new Set([
    'po-patientEmail',
    'po-patientFirstName', 'po-patientLastName',
    'po-patientPhone', 'po-patientDOB', 'po-sex',
    'po-contact-name', 'po-contact-type', 'po-contact-phone',
    'po-driverName', 'po-driverRel',
    'po-pcp-name', 'po-pcp-phone', 'po-pcp-appt-date',
    'po-height-ft', 'po-height-in', 'po-weight-lbs',
    'po-height-cm-val', 'po-weight-kg-val', 'po-bmi-val',
    'po-allergies', 'po-medications', 'po-surgicalHistory',
    'po-comments', 'po-assessTime',
    'po-venipuncture', 'po-totalFluids', 'po-ebl',
    'po-iv-difficulty-comment', 'po-anesthesia-issues-comment',
    'po-heart-notes', 'po-lungs-notes', 'po-abd-notes',
    'po-providerSignature', 'mallampati'
  ]);
  const PHI_PREFIXES = [
    'po-cv-', 'po-pulm-', 'po-ekg-', 'po-gastro-', 'po-renal-',
    'po-neuro-', 'po-meta-', 'po-teeth-', 'po-other-',
    'po-pupil-', 'po-iv-', 'po-anesthesia-'
  ];

  // ──────────────────────────────────────────────────────────────────────────
  // Case Display ID: patient-friendly label until 3 days post-surgery,
  // then reverts to the technical case ID.
  // ──────────────────────────────────────────────────────────────────────────

  // Examples:
  //   getCaseDisplayId('JOSH-05-15-2026-01', '2026-05-15', 'John', 'Smith')
  //     → "Smith, J — 05/15/2026"   (case is within last 3 days)
  //     → "JOSH-05-15-2026-01"       (case is 3+ days old, hidden)
  //     → "JOSH-05-15-2026-01"       (no patient name available)
  window.getCaseDisplayId = function(technicalCaseId, surgeryDate, firstName, lastName) {
    const tech = technicalCaseId || '';
    if(window.isPHIHidden && window.isPHIHidden(surgeryDate, tech)) return tech;
    const first = (firstName || '').trim();
    const last = (lastName || '').trim();
    if(!first && !last) return tech;
    const initial = first ? first[0].toUpperCase() : '';
    const namePart = last && initial ? `${last}, ${initial}` :
                     last ? last :
                     initial;
    if(!surgeryDate) return namePart || tech;
    const parts = surgeryDate.split('-');
    if(parts.length !== 3) return `${namePart} — ${surgeryDate}`;
    return `${namePart} — ${parts[1]}/${parts[2]}/${parts[0]}`;
  };

  // Helper for pre-op records (po-* field names)
  window.getCaseDisplayIdFromPreop = function(preopRec) {
    if(!preopRec) return '';
    return window.getCaseDisplayId(
      preopRec['po-caseId'],
      preopRec['po-surgeryDate'],
      preopRec['po-patientFirstName'],
      preopRec['po-patientLastName']
    );
  };

  // Helper for case records — looks up patient name from the linked pre-op
  window.getCaseDisplayIdFromCase = function(caseRec) {
    if(!caseRec) return '';
    const preopRec = (window._rawPreopRecords||[]).find(r => r['po-caseId'] === caseRec.caseId);
    return window.getCaseDisplayId(
      caseRec.caseId,
      caseRec.date,
      preopRec ? preopRec['po-patientFirstName'] : '',
      preopRec ? preopRec['po-patientLastName'] : ''
    );
  };

  window.isPHIField = function(fid) {
    if (!fid) return false;
    if (PHI_EXACT_FIELDS.has(fid)) return true;
    return PHI_PREFIXES.some(p => fid.startsWith(p));
  };

  // After reveal, populate the PHI fields from the stored record.
  window.fillPreopPHIFields = function(record) {
    if (!record) return;
    Object.keys(record).forEach(fid => {
      if (!window.isPHIField(fid)) return;
      const el = document.getElementById(fid);
      if (!el) return;
      if (el.type === 'checkbox') {
        el.checked = !!record[fid];
      } else if (el.type !== 'radio') {
        el.value = record[fid] || '';
      }
    });
    // Mallampati radio
    if (record['mallampati']) {
      const radio = document.querySelector(`input[name="mallampati"][value="${record['mallampati']}"]`);
      if (radio) radio.checked = true;
    }
    // Sex segmented button (custom-styled radio group)
    if (record['po-sex'] && typeof window._preopSetSex === 'function') {
      window._preopSetSex(record['po-sex']);
    }
    // BMI / height / weight display labels
    if (record['po-height-cm-val']) {
      const cmEl = document.getElementById('po-height-cm');
      if (cmEl) cmEl.textContent = record['po-height-cm-val'] + ' cm';
    }
    if (record['po-weight-kg-val']) {
      const kgEl = document.getElementById('po-weight-kg');
      if (kgEl) kgEl.textContent = record['po-weight-kg-val'] + ' kg';
    }
    if (record['po-bmi-val']) {
      const bmiEl = document.getElementById('po-bmi');
      if (bmiEl) bmiEl.textContent = record['po-bmi-val'];
    }
  };

  // Inject the PHI-hidden banner at the top of the pre-op form.
  window.injectPreopPHIBanner = function(caseId, surgeryDate) {
    window.removePreopPHIBanner();
    const preopTab = document.getElementById('tab-preop');
    if (!preopTab) return;
    const banner = document.createElement('div');
    banner.id = 'preop-phi-banner';
    banner.style.cssText = 'margin:14px 0;padding:14px 18px;background:#fef3c7;border:1px solid #fde68a;border-left:4px solid #d97706;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap';
    banner.innerHTML = `
      <div style="flex:1;min-width:220px">
        <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:3px">🔒 Patient details are hidden</div>
        <div style="font-size:12px;color:#78350f;line-height:1.4">This case is more than ${PHI_HIDE_DAYS} days post-surgery. Patient name, contact info, allergies, medical history, and measurements are not loaded. Click to verify your identity and unlock.</div>
      </div>
      ${window.phiRevealButtonHTML(caseId, 'revealPreopPHIFields')}
    `;
    const actionBar = preopTab.querySelector('.action-bar');
    if (actionBar && actionBar.nextElementSibling) {
      preopTab.insertBefore(banner, actionBar.nextElementSibling);
    } else if (actionBar) {
      actionBar.parentNode.insertBefore(banner, actionBar.nextSibling);
    } else {
      preopTab.insertBefore(banner, preopTab.firstChild);
    }
  };

  window.removePreopPHIBanner = function() {
    const banner = document.getElementById('preop-phi-banner');
    if (banner) banner.remove();
  };

  // Called via the reveal flow's refreshFn hook when PHI is unlocked while
  // editing a pre-op record. Fills the hidden fields and removes the banner.
  window.revealPreopPHIFields = function() {
    if (!window._editingPreopRecord) return;
    window.fillPreopPHIFields(window._editingPreopRecord);
    window.removePreopPHIBanner();
  };

  // Strip PHI fields from a save payload so empty/unrevealed values don't
  // overwrite existing PHI in the database. Used by savePreop when editing.
  window.stripPHIFromUpdate = function(textData, checkData) {
    const cleanText = {};
    const cleanCheck = {};
    Object.keys(textData || {}).forEach(k => {
      if (!window.isPHIField(k)) cleanText[k] = textData[k];
    });
    Object.keys(checkData || {}).forEach(k => {
      if (!window.isPHIField(k)) cleanCheck[k] = checkData[k];
    });
    return { textData: cleanText, checkData: cleanCheck };
  };
})();
