// jordan-portal-photos.js — "📷 Portal Photos" reference button (Jordan only).
//
// When Jordan is filling out a pre-op assessment, he can pull up the six
// airway photos the patient uploaded through their portal (schedule.html).
// Photos live at atlas/preop_photos_<visitId>_<angleKey> where visitId is
// the preop_visits entry id linked to this pre-op record via po-preopVisitId.

(() => {
  const ANGLES = [
    { key: 'neckExt',  label: 'Neck extended' },
    { key: 'profile',  label: 'Profile (side)' },
    { key: 'straight', label: 'Straight on' },
    { key: 'right',    label: 'Head turned right' },
    { key: 'left',     label: 'Head turned left' },
    { key: 'throat',   label: 'Back of the throat' }
  ];

  // Show the button only when Jordan (assistant role) is logged in. Visibility
  // logic runs once after auth settles plus on every tab switch — keeps the
  // button accurate even if the role isn't ready when this file first loads.
  function refreshButton() {
    const btn = document.getElementById('preop-portal-photos-btn');
    if(!btn) return;
    const show = (window._userRole === 'assistant');
    btn.style.display = show ? '' : 'none';
  }
  // Run after the page hydrates the role.
  setInterval(refreshButton, 1000);
  document.addEventListener('DOMContentLoaded', refreshButton);

  // Resolve the preop_visits entry id linked to the currently-loaded pre-op
  // record. Two paths:
  //   1) The hidden #po-preopVisitId input populated when the record was
  //      created from Nicole's inbox or the schedule-modal "Open Pre-Op" link.
  //   2) Fallback: scan window._preopVisitEntries for an entry whose
  //      preopRecordId matches the currently-loaded record id.
  function _getLinkedVisitId() {
    const v = document.getElementById('po-preopVisitId')?.value;
    if(v) return v;
    const recId = window._editingPreopId || document.getElementById('po-caseId')?.value;
    const entries = window._preopVisitEntries || [];
    const match = entries.find(e => e && e.preopRecordId === recId);
    return match ? match.id : '';
  }

  window.openPortalPhotosViewer = async function() {
    if(window._userRole !== 'assistant') return;
    const visitId = _getLinkedVisitId();
    if(!visitId) {
      alert('No patient portal record is linked to this pre-op yet. Photos appear here once the patient has uploaded them through the scheduling portal.');
      return;
    }
    if(typeof window.db !== 'object' || typeof window.getDoc !== 'function' || typeof window.doc !== 'function') {
      alert('Database not ready yet — try again in a moment.');
      return;
    }
    const prior = document.getElementById('jordanPhotosModal');
    if(prior) prior.remove();
    const wrap = document.createElement('div');
    wrap.id = 'jordanPhotosModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px';
    wrap.onclick = e => { if(e.target === wrap) wrap.remove(); };
    wrap.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:1100px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)">
      <div style="background:#1d3557;color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0">Patient Portal Reference</div>
          <div style="font-size:17px;font-weight:700;margin-top:2px">Airway Photos</div>
        </div>
        <button onclick="document.getElementById('jordanPhotosModal').remove()" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:14px;font-family:inherit">✕ Close</button>
      </div>
      <div id="jpv-body" style="padding:22px;overflow-y:auto;background:#f8fafc">
        <div style="text-align:center;padding:30px;color:#64748b">Loading photos…</div>
      </div>
    </div>`;
    document.body.appendChild(wrap);

    // Fetch all 6 photo docs in parallel.
    const snaps = await Promise.all(ANGLES.map(a =>
      window.getDoc(window.doc(window.db, 'atlas', 'preop_photos_' + visitId + '_' + a.key))
        .catch(() => null)
    ));
    const tiles = ANGLES.map((a, i) => {
      const snap = snaps[i];
      const url  = (snap && snap.exists && snap.exists()) ? (snap.data().dataUrl || '') : '';
      if(!url) {
        return `<div style="background:#fff;border:1px dashed #cbd5e1;border-radius:10px;padding:18px;text-align:center;min-height:200px;display:flex;flex-direction:column;justify-content:center;color:#94a3b8;font-size:13px">
          <div style="font-weight:600;color:#475569;margin-bottom:6px">${a.label}</div>
          <div style="font-style:italic">Not uploaded yet</div>
        </div>`;
      }
      return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;display:flex;flex-direction:column">
        <div style="padding:8px 12px;font-size:12px;font-weight:700;color:#1d3557;background:#f1f5f9;border-bottom:1px solid #e2e8f0">${a.label}</div>
        <img src="${url}" style="width:100%;display:block;background:#000" alt="${a.label}">
      </div>`;
    }).join('');
    const body = document.getElementById('jpv-body');
    if(body) body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">${tiles}</div>`;
  };
})();
