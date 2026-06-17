import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, getDocs, onSnapshot, collection, addDoc, query, orderBy, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
// -- FIREBASE CONFIG --
const firebaseConfig = {
apiKey: "AIzaSyAAY9Ajrx4PJRqhxW5MgRY3wgZni9rJhMo",
authDomain: "atlas-ane.firebaseapp.com",
projectId: "atlas-ane",
storageBucket: "atlas-ane.firebasestorage.app",
messagingSenderId: "677020713040",
appId: "1:677020713040:web:07f52f77fd225c607a5155"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Offline persistence: cache reads in IndexedDB, queue writes locally, and
// sync them when the network comes back. persistentMultipleTabManager lets
// Nicole/Jordan/Josh/Dev all have the app open in parallel tabs without
// fighting over the same cache. Falls back to in-memory if IndexedDB isn't
// available (e.g. private browsing on some browsers).
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch(e) {
  console.warn('Firestore offline cache init failed — falling back to memory:', e);
  db = getFirestore(app);
}

// ── LOCAL-TIMEZONE DATE HELPERS ──────────────────────────────────────────────
// Use these instead of `todayStr()`. The ISO
// version returns the UTC date, which flips to the next calendar day in the
// evening for users in negative-offset timezones (e.g. US Central). These
// helpers always return the date as it appears on the user's local clock.
function localDateStr(d) {
  d = d || new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function todayStr() { return localDateStr(new Date()); }
// addDays(isoDate, n) — returns YYYY-MM-DD n days after the input. Used by the
// reminder modal's quick-pick buttons and the daily-reminder scheduler.
function addDays(isoDate, n) {
  const base = isoDate ? new Date(isoDate + 'T00:00:00') : new Date();
  base.setDate(base.getDate() + (n || 0));
  return localDateStr(base);
}
window.localDateStr = localDateStr;
window.todayStr = todayStr;
window.addDays = addDays;

// ── HIPAA: AUTO-LOGOUT AFTER INACTIVITY ───────────────────────────────────────
// Signs the user out after 20 min of no mouse/keyboard activity. Shows a small
// warning at 19 min so they can wiggle the mouse to stay in.
const INACTIVITY_LIMIT_MS = 20 * 60 * 1000;
const INACTIVITY_WARN_MS  = 60 * 1000;
let _inactivityTimer = null;
let _inactivityWarnTimer = null;

function _hideInactivityWarning() {
  const div = document.getElementById('inactivity-warning');
  if(div) div.remove();
}
function _showInactivityWarning() {
  let div = document.getElementById('inactivity-warning');
  if(!div) {
    div = document.createElement('div');
    div.id = 'inactivity-warning';
    div.style.cssText = 'position:fixed;top:20px;right:20px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:14px 18px;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.18);font-size:13px;max-width:280px;color:#92400e';
    document.body.appendChild(div);
  }
  div.innerHTML = '<strong>⏰ Inactivity warning</strong><br>You will be logged out in about 1 minute. Click or move the mouse to stay logged in.';
}
function _autoLogout() {
  // Final guard: if we somehow reached here while the user is mid-case
  // (Surgery Mode on OR sitting on the Live Case tab), don't log out. Just
  // reset the timer instead so a stale schedule from before surgery doesn't
  // boot the CRNA in the middle of a procedure.
  if(_isInActiveSurgery()) {
    try { logAudit('inactivity-logout-suppressed', '', 'mid-case'); } catch(e){}
    clearTimeout(_inactivityTimer);
    clearTimeout(_inactivityWarnTimer);
    _hideInactivityWarning();
    return;
  }
  _hideInactivityWarning();
  try { logAudit('auto-logout-inactivity'); } catch(e){}
  alert('You have been logged out due to inactivity.');
  signOut(auth).catch(()=>{});
}
// Returns true if the user is mid-procedure on the Live Case tab. Used as a
// safety net so even if Surgery Mode was never toggled on, the inactivity
// timer can't fire and boot the CRNA mid-case.
function _isInActiveSurgery() {
  if(window._surgeryModeActive) return true;
  const liveTab = document.getElementById('tab-live-case');
  if(liveTab && liveTab.classList.contains('active')) return true;
  return false;
}

function resetInactivityTimer() {
  if(!currentUser) return;
  if(_isInActiveSurgery()) {
    // Belt-and-suspenders: also clear any pending timers that may have been
    // scheduled before the user navigated into Live Case.
    clearTimeout(_inactivityTimer);
    clearTimeout(_inactivityWarnTimer);
    _hideInactivityWarning();
    return;
  }
  clearTimeout(_inactivityTimer);
  clearTimeout(_inactivityWarnTimer);
  _hideInactivityWarning();
  _inactivityWarnTimer = setTimeout(_showInactivityWarning, INACTIVITY_LIMIT_MS - INACTIVITY_WARN_MS);
  _inactivityTimer = setTimeout(_autoLogout, INACTIVITY_LIMIT_MS);
}
['mousemove','mousedown','keydown','touchstart','scroll'].forEach(ev => {
  document.addEventListener(ev, resetInactivityTimer, { passive: true });
});

// ── SURGERY MODE ──────────────────────────────────────────────────────────────
// When active: pauses auto-logout AND keeps the screen on via Wake Lock API.
// Use during anesthesia administration so the iPad doesn't sleep or log out
// mid-case. Banner shows clearly so it's never left on accidentally.
window._surgeryModeActive = false;
let _wakeLock = null;

async function _acquireWakeLock() {
  try {
    if('wakeLock' in navigator) {
      _wakeLock = await navigator.wakeLock.request('screen');
      // Re-acquire if the lock is released (e.g. tab loses focus then regains)
      _wakeLock.addEventListener('release', () => {
        if(window._surgeryModeActive) {
          setTimeout(() => { if(window._surgeryModeActive) _acquireWakeLock(); }, 500);
        }
      });
    }
  } catch(e) { console.warn('Wake Lock failed:', e); }
}
function _releaseWakeLock() {
  if(_wakeLock) {
    try { _wakeLock.release(); } catch(e){}
    _wakeLock = null;
  }
}

function _renderSurgeryModeBanner() {
  let banner = document.getElementById('surgery-mode-banner');
  if(window._surgeryModeActive) {
    if(!banner) {
      banner = document.createElement('div');
      banner.id = 'surgery-mode-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;background:#fef3c7;border-bottom:2px solid #d97706;padding:8px 16px;text-align:center;font-size:13px;font-weight:600;color:#78350f;box-shadow:0 2px 8px rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center;gap:12px';
      banner.innerHTML = `<span>🏥 <strong>SURGERY MODE ACTIVE</strong> &middot; Screen will stay on, auto-logout paused. Turn off when case ends.</span><button onclick="toggleSurgeryMode()" style="background:#92400e;color:#fff;border:none;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer">Turn Off</button>`;
      document.body.appendChild(banner);
      // Add top padding to body so content doesn't hide under banner
      document.body.style.paddingTop = '38px';
    }
  } else {
    if(banner) banner.remove();
    document.body.style.paddingTop = '';
  }
}

function _applySurgeryModeNav() {
  const nav = document.querySelector('.nav');
  if(!nav) return;
  const liveBtn = document.getElementById('nav-live-case');
  // Direct children of .nav — buttons AND the Reports dropdown wrapper
  Array.from(nav.children).forEach(child => {
    if(child === liveBtn || child.id === 'nav-live-case') {
      // Live Case button — only visible in surgery mode
      child.style.display = window._surgeryModeActive ? '' : 'none';
    } else {
      // Everything else — hidden in surgery mode
      child.style.display = window._surgeryModeActive ? 'none' : '';
    }
  });
}

window.toggleSurgeryMode = async function() {
  window._surgeryModeActive = !window._surgeryModeActive;
  // Persist so an iPad sleep/wake that triggers a page reload doesn't drop
  // the user out of surgery mode mid-case — the inactivity timer would then
  // start ticking and log them out 20 min later.
  try {
    if(window._surgeryModeActive) localStorage.setItem('atlas_surgery_mode', '1');
    else localStorage.removeItem('atlas_surgery_mode');
  } catch(e) {}
  if(window._surgeryModeActive) {
    await _acquireWakeLock();
    clearTimeout(_inactivityTimer);
    clearTimeout(_inactivityWarnTimer);
    _hideInactivityWarning();
    try { logAudit('surgery-mode-on'); } catch(e){}
    // Navigate to Live Case automatically
    try { showTab('live-case'); if(typeof renderLiveCase === 'function') renderLiveCase(); } catch(e){}
  } else {
    _releaseWakeLock();
    resetInactivityTimer();
    try { logAudit('surgery-mode-off'); } catch(e){}
    // Refresh the live picker so any test cases drop back out of the list
    try { if(typeof renderLiveCase === 'function') renderLiveCase(); } catch(e){}
    // Return to Mid-Case when leaving surgery mode (most natural landing spot)
    try { showTab('mid-case'); } catch(e){}
  }
  _applySurgeryModeNav();
  _renderSurgeryModeBanner();
  // Update the toggle button text/style
  const btn = document.getElementById('surgery-mode-toggle');
  if(btn) {
    btn.textContent = window._surgeryModeActive ? '🏥 Surgery Mode: ON' : '🏥 Surgery Mode';
    btn.style.background = window._surgeryModeActive ? '#d97706' : '';
    btn.style.color = window._surgeryModeActive ? '#fff' : '';
    btn.style.borderColor = window._surgeryModeActive ? '#d97706' : '';
  }
  // Also update the in-page button on the Live Case tab
  const liveBtn = document.getElementById('live-surgery-toggle');
  if(liveBtn) {
    liveBtn.textContent = window._surgeryModeActive ? '🏥 Surgery Mode: ON' : '🏥 Surgery Mode';
    liveBtn.style.background = window._surgeryModeActive ? '#d97706' : '';
    liveBtn.style.color = window._surgeryModeActive ? '#fff' : '';
  }
};

// Reacquire wake lock when tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if(window._surgeryModeActive && !document.hidden) {
    _acquireWakeLock();
  }
});

// ── LIVE CASE PORTAL ──────────────────────────────────────────────────────────
// Single-case tablet-optimized view used during anesthesia administration.
// Pairs with Surgery Mode (keeps screen on, pauses auto-logout).
window._currentLiveCaseDraft = null; // the active case draft being tracked
window._liveTimerInterval = null;
window._liveTimerStartedAt = null;     // ms epoch when timer started running
window._liveTimerAccumulatedMs = 0;    // total elapsed time before current run

function _formatLiveTimer(totalMs) {
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function _liveTimerTick() {
  const el = document.getElementById('live-timer');
  if(!el) return;
  const running = window._liveTimerStartedAt;
  const elapsed = window._liveTimerAccumulatedMs + (running ? (Date.now() - running) : 0);
  el.textContent = _formatLiveTimer(elapsed);
}

window.toggleLiveTimer = function() {
  const btn = document.getElementById('live-timer-toggle');
  if(window._liveTimerStartedAt) {
    // Currently running — pause
    window._liveTimerAccumulatedMs += Date.now() - window._liveTimerStartedAt;
    window._liveTimerStartedAt = null;
    clearInterval(window._liveTimerInterval);
    window._liveTimerInterval = null;
    if(btn) { btn.textContent = '▶ Resume'; btn.style.background = '#2d6a4f'; }
  } else {
    // Currently paused — start/resume
    window._liveTimerStartedAt = Date.now();
    window._liveTimerInterval = setInterval(_liveTimerTick, 1000);
    if(btn) { btn.textContent = '⏸ Pause'; btn.style.background = '#1d3557'; }
    _liveTimerTick();
  }
};

window.resetLiveTimer = function() {
  if(!confirm('Reset the case timer to 00:00:00?')) return;
  clearInterval(window._liveTimerInterval);
  window._liveTimerInterval = null;
  window._liveTimerStartedAt = null;
  window._liveTimerAccumulatedMs = 0;
  const el = document.getElementById('live-timer');
  if(el) el.textContent = '00:00:00';
  const btn = document.getElementById('live-timer-toggle');
  if(btn) { btn.textContent = '▶ Start'; btn.style.background = '#1d3557'; }
};

window.renderLiveCase = function() {
  const picker = document.getElementById('live-case-picker');
  if(!picker) return;
  // Surgery Mode ON → include test cases so the user can sandbox a full
  // workflow. Surgery Mode OFF → hide them so real-day work isn't cluttered.
  const includeTests = !!window._surgeryModeActive;
  const allCases = (window.cases || []).filter(c => includeTests || !c.isTest);
  const drafts = allCases.filter(c => c.draft);
  // Case IDs that have already been finalized — used to hide their pre-ops
  // from the active dropdown (the live picker is for in-progress cases only).
  const finalizedCaseIds = new Set(allCases.filter(c => !c.draft).map(c => c.caseId));
  const preops = (window._rawPreopRecords || []).filter(r => includeTests || !r.isTest);
  // Show drafts first, then any pre-op without a draft (or finalized case) yet
  const allActive = [];
  drafts.forEach(d => allActive.push({ kind:'draft', id:d.id, caseId:d.caseId, date:d.date, worker:d.worker, ref:d }));
  preops.forEach(p => {
    const cid = p['po-caseId'];
    if(!cid) return;
    if(finalizedCaseIds.has(cid)) return; // skip already-finalized cases
    if(!allActive.find(a => a.caseId === cid)) {
      allActive.push({ kind:'preop', id:p.id, caseId:cid, date:p['po-surgeryDate'], worker:p.worker, ref:p });
    }
  });
  // Sort: upcoming/today first (earliest first), then past (most recent first)
  const today_ = todayStr();
  allActive.sort((a,b) => {
    const aDate = a.date || '';
    const bDate = b.date || '';
    const aFuture = aDate >= today_;
    const bFuture = bDate >= today_;
    if(aFuture && !bFuture) return -1;
    if(!aFuture && bFuture) return 1;
    if(aFuture && bFuture) return aDate.localeCompare(bDate);
    return bDate.localeCompare(aDate);
  });
  const currentVal = picker.value;
  picker.innerHTML = '<option value="">— Select an active case —</option>' +
    allActive.map(a => {
      const displayId = (typeof window.getCaseDisplayId === 'function')
        ? window.getCaseDisplayId(a.caseId, a.date,
            a.kind === 'preop' ? a.ref['po-patientFirstName'] : '',
            a.kind === 'preop' ? a.ref['po-patientLastName'] : '')
        : a.caseId;
      const dateLabel = a.date ? fmtDate(a.date) : 'No date';
      const isToday = a.date === today_;
      const isPast = a.date && a.date < today_;
      let prefix = dateLabel;
      if(isToday) prefix = 'TODAY · ' + dateLabel;
      else if(isPast) prefix = dateLabel + ' (past)';
      const tag = a.kind === 'draft' ? ' [Draft]' : '';
      return `<option value="${a.kind}:${a.id}" ${currentVal===a.kind+':'+a.id?'selected':''}>${prefix} — ${displayId}${tag}</option>`;
    }).join('');
  if(currentVal) onLiveCaseChange();
};

window.onLiveCaseChange = function() {
  const picker = document.getElementById('live-case-picker');
  const empty = document.getElementById('live-case-empty');
  const content = document.getElementById('live-case-content');
  if(!picker || !empty || !content) return;
  const val = picker.value;
  if(!val) {
    empty.style.display = 'block';
    content.style.display = 'none';
    window._currentLiveCaseDraft = null;
    return;
  }
  const [kind, id] = val.split(':');
  let caseRec = null, preopRec = null;
  if(kind === 'draft') {
    caseRec = (window.cases || []).find(c => c.id === id);
    if(caseRec) preopRec = (window._rawPreopRecords || []).find(p => p['po-caseId'] === caseRec.caseId);
  } else if(kind === 'preop') {
    preopRec = (window._rawPreopRecords || []).find(p => p.id === id);
    // For pre-op-only selections: if no draft exists yet, look for one with
    // the same caseId. If still none, kick off draft creation so the Add
    // Supplies / Add CS buttons (which gate on _currentLiveCaseDraft) work.
    if(preopRec) {
      const cid = preopRec['po-caseId'];
      caseRec = (window.cases || []).find(c => c.draft && c.caseId === cid);
      if(!caseRec && typeof window.startCaseFromPreop === 'function') {
        // Fire-and-forget — startCaseFromPreop creates the draft then calls
        // resumeCase which navigates to Finalize. We swap back to live-case
        // and re-trigger this picker change so we land on the new draft.
        window.startCaseFromPreop(id).then(() => {
          setTimeout(() => {
            try { showTab('live-case'); } catch(e){}
            const newDraft = (window.cases || []).find(c => c.draft && c.caseId === cid);
            if(newDraft) {
              const picker2 = document.getElementById('live-case-picker');
              if(picker2) {
                renderLiveCase();
                picker2.value = 'draft:' + newDraft.id;
                onLiveCaseChange();
              }
            }
          }, 100);
        });
        return; // exit until the draft is ready
      }
    }
  }
  if(!caseRec && !preopRec) {
    empty.style.display = 'block';
    content.style.display = 'none';
    return;
  }
  window._currentLiveCaseDraft = caseRec;
  window._currentLivePreop = preopRec;
  empty.style.display = 'none';
  content.style.display = 'block';
  // Silently load the draft into form state so "Add Supplies" / "Add CS" save
  // to THIS case. resumeCase() navigates to Finalize tab as a side-effect, so
  // we flip back to Live Case immediately. Without this, supplies added in
  // Live Case would be lost when "Go to Finalize" reloads the draft.
  if(caseRec && caseRec.id && typeof window.resumeCase === 'function' && window._activeDraftId !== caseRec.id) {
    try { window.resumeCase(caseRec.id); } catch(e){}
    setTimeout(() => { try { showTab('live-case'); } catch(e){} }, 50);
  }
  // Populate header
  const caseId = (caseRec && caseRec.caseId) || (preopRec && preopRec['po-caseId']) || '—';
  const surgDate = (caseRec && caseRec.date) || (preopRec && preopRec['po-surgeryDate']) || '';
  const displayId = (typeof window.getCaseDisplayId === 'function')
    ? window.getCaseDisplayId(caseId, surgDate,
        preopRec ? preopRec['po-patientFirstName'] : '',
        preopRec ? preopRec['po-patientLastName'] : '')
    : caseId;
  const idEl = document.getElementById('live-case-id');
  if(idEl) idEl.textContent = displayId;
  // Meta line: provider, surgery center, time
  const parts = [];
  const provider = (caseRec && caseRec.provider) || (preopRec && preopRec['po-provider']);
  if(provider) parts.push(provider);
  if(preopRec && preopRec['po-surgery-center']) {
    const center = (window.surgeryCenters || []).find(x => x.id === preopRec['po-surgery-center']);
    if(center) parts.push(center.name);
  }
  if(surgDate) parts.push(fmtDate(surgDate));
  const startTime = preopRec && preopRec['po-startTime'];
  if(startTime) parts.push(startTime);
  const metaEl = document.getElementById('live-case-meta');
  if(metaEl) metaEl.textContent = parts.join(' · ') || '—';
  // Patient info card (PHI-aware)
  const phiHidden = preopRec && typeof window.isPHIHidden === 'function' && window.isPHIHidden(surgDate, caseId);
  const patientCard = document.getElementById('live-patient-info');
  if(patientCard) {
    if(phiHidden) {
      patientCard.innerHTML = `<div style="color:#64748b;font-style:italic">🔒 Patient details are hidden (case is 3+ days old). Use the reveal button in Mid-Case to unlock.</div>`;
    } else if(!preopRec) {
      patientCard.innerHTML = `<div style="color:var(--text-faint);font-style:italic">No pre-op record linked yet.</div>`;
    } else {
      const allergies = preopRec['po-allergies'];
      const mall = preopRec['mallampati'];
      const weight = preopRec['po-weight-kg-val'];
      const bmi = preopRec['po-bmi-val'];
      const meds = preopRec['po-medications'];
      let html = '';
      if(allergies) html += `<div style="background:#fee2e2;color:#b91c1c;padding:8px 12px;border-radius:6px;font-weight:600;margin-bottom:8px">⚠ ALLERGIES: ${allergies}</div>`;
      const inline = [];
      if(mall) inline.push(`<strong>Mallampati:</strong> ${mall}`);
      if(weight) inline.push(`<strong>Wt:</strong> ${weight} kg`);
      if(bmi) inline.push(`<strong>BMI:</strong> ${bmi}`);
      if(inline.length) html += `<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--text);margin-bottom:6px">${inline.join('')}</div>`;
      if(meds) html += `<div style="font-size:12px;color:var(--text-muted)"><strong>Meds:</strong> ${meds}</div>`;
      patientCard.innerHTML = html || '<div style="color:var(--text-faint);font-style:italic">No medical details entered.</div>';
    }
  }
  // Render the supplies/CS list. Now extracted so applyQuickAddSupplies /
  // applyCSQuickAdd can re-render after the user adds something live.
  window.renderLiveLoggedList();
  // Restore notes from the draft
  const notesEl = document.getElementById('live-notes');
  if(notesEl) notesEl.value = (caseRec && (caseRec.liveNotes || caseRec.caseComments)) || '';
  // Suggest enabling Surgery Mode if not already
  const toggleBtn = document.getElementById('live-surgery-toggle');
  if(toggleBtn) {
    toggleBtn.textContent = window._surgeryModeActive ? '🏥 Surgery Mode: ON' : '🏥 Surgery Mode';
    toggleBtn.style.background = window._surgeryModeActive ? '#d97706' : '';
    toggleBtn.style.color = window._surgeryModeActive ? '#fff' : '';
  }
};

// Refresh the Live Case "Supplies & CS Logged This Case" panel from whatever
// is currently in the active draft + the live session arrays. Prefer session
// state (window.caseItems / window.csEntries) when populated — covers the
// moment right after Apply where the draft has not yet been saved to Firestore.
// In Surgery Mode each row is inline-editable so the CRNA can adjust qty or
// drop an item without re-opening the Quick Add modal.
window.renderLiveLoggedList = function() {
  const loggedList = document.getElementById('live-logged-list');
  if(!loggedList) return;
  const caseRec = window._currentLiveCaseDraft;
  const sessionItems = (window.caseItems || []);
  const sessionCS = (window.csEntries || []);
  const draftItems = (caseRec && caseRec.items) || [];
  const draftCS = (caseRec && caseRec.savedCsEntries) || [];
  const items = sessionItems.length ? sessionItems : draftItems;
  const cs = sessionCS.length ? sessionCS : draftCS;
  let html = '';
  if(items.length) {
    html += `<div style="margin-bottom:8px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint)">Supplies</div>`;
    html += items.map(i => {
      const line = (parseFloat(i.cost)||0) * (parseFloat(i.qty)||0);
      const safeId = (i.id || '').replace(/'/g, "\\'");
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 90px 80px 30px;gap:8px;align-items:center">
        <span style="font-size:13px">${i.generic||i.name||'—'}</span>
        <input type="number" min="0" step="0.5" value="${i.qty}" onchange="window._liveUpdateSupplyQty('${safeId}', this.value)" style="width:100%;padding:4px 8px;text-align:center;font-size:13px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
        <span style="font-size:12px;color:var(--text-muted);text-align:right;font-family:'DM Mono',monospace">$${line.toFixed(2)}</span>
        <button onclick="window._liveRemoveSupply('${safeId}')" title="Remove" style="background:none;border:none;color:var(--warn);font-size:18px;line-height:1;cursor:pointer;padding:0">×</button>
      </div>`;
    }).join('');
  }
  if(cs.length) {
    html += `<div style="margin-top:10px;margin-bottom:8px;font-size:11px;font-weight:700;text-transform:uppercase;color:#d97706">Controlled Substances</div>`;
    html += cs.map(e => {
      const drug = e.drug || e.generic || '—';
      const safeId = (e.id || '').replace(/'/g, "\\'");
      const safeDrug = (e.drug || '').replace(/'/g, "\\'");
      const amt = e.amountGiven || '0';
      const left = e.leftInVial || '0';
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 70px 70px 30px;gap:8px;align-items:center">
        <span style="font-size:13px;text-transform:capitalize">${drug}</span>
        <input type="number" min="0" step="0.1" value="${amt}" placeholder="given" title="Amount given (mg/mL)" onchange="window._liveUpdateCSField('${safeId}','amountGiven', this.value)" style="width:100%;padding:4px 6px;text-align:center;font-size:12px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
        <input type="number" min="0" step="0.1" value="${left}" placeholder="left" title="Amount left in vial" onchange="window._liveUpdateCSField('${safeId}','leftInVial', this.value)" style="width:100%;padding:4px 6px;text-align:center;font-size:12px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
        <button onclick="window._liveRemoveCS('${safeId}','${safeDrug}')" title="Remove" style="background:none;border:none;color:var(--warn);font-size:18px;line-height:1;cursor:pointer;padding:0">×</button>
      </div>`;
    }).join('');
    html += `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;font-style:italic">Adjust the given / left-in-vial numbers as the case progresses. Use the 💊 Add CS button for signatures.</div>`;
  }
  loggedList.innerHTML = html || '<div style="color:var(--text-faint);font-style:italic">Nothing logged yet. Use the buttons above to add supplies or controlled substances.</div>';
};

// ── Live Case inline edit helpers ──
// Persist any inline edits to (1) session state, (2) the active draft, and
// (3) Firestore. Re-render the panel + finalize-case supplies table so the
// edit is reflected everywhere.
function _liveSyncAndPersist() {
  const draft = window._currentLiveCaseDraft;
  if(draft) {
    draft.items = (window.caseItems || []).map(i => ({
      id: i.id, generic: i.generic, name: i.name,
      cost: i.cost, qty: i.qty, lineTotal: (i.cost || 0) * (i.qty || 0)
    }));
    draft.savedCsEntries = (window.csEntries || []).map(e => ({...e}));
    if(typeof window.saveCases === 'function') {
      window.saveCases().catch(e => console.warn('saveCases (live edit) failed:', e));
    }
  }
  if(typeof window.renderLiveLoggedList === 'function') window.renderLiveLoggedList();
  if(typeof window.renderCaseSupplies === 'function') window.renderCaseSupplies();
}
window._liveUpdateSupplyQty = function(itemId, val) {
  const qty = Math.max(0, parseFloat(val) || 0);
  const arr = window.caseItems || [];
  const idx = arr.findIndex(i => i.id === itemId);
  if(idx === -1) return;
  if(qty === 0) arr.splice(idx, 1);
  else arr[idx].qty = qty;
  window.caseItems = arr;
  _liveSyncAndPersist();
};
window._liveRemoveSupply = function(itemId) {
  const arr = (window.caseItems || []).filter(i => i.id !== itemId);
  window.caseItems = arr;
  _liveSyncAndPersist();
};
window._liveUpdateCSField = function(entryId, field, val) {
  const arr = window.csEntries || [];
  const e = arr.find(x => x.id === entryId);
  if(!e) return;
  e[field] = val;
  window.csEntries = arr;
  _liveSyncAndPersist();
};
window._liveRemoveCS = function(entryId, drugLabel) {
  if(!confirm('Remove ' + (drugLabel || 'this CS entry') + ' from this case?')) return;
  const arr = (window.csEntries || []).filter(e => e.id !== entryId);
  window.csEntries = arr;
  _liveSyncAndPersist();
};

let _liveNotesSaveTimer = null;
window.saveLiveNotes = function() {
  clearTimeout(_liveNotesSaveTimer);
  _liveNotesSaveTimer = setTimeout(async () => {
    const notesEl = document.getElementById('live-notes');
    if(!notesEl || !window._currentLiveCaseDraft) return;
    const value = notesEl.value;
    try {
      window._currentLiveCaseDraft.liveNotes = value;
      // Persist to the case record if it's a finalized draft
      if(typeof saveCasesToFirestore === 'function') {
        await saveCasesToFirestore(window.cases);
      }
    } catch(e) { console.warn('saveLiveNotes failed:', e); }
  }, 800);
};

// ── EXTERNAL PORTAL: link generation ──────────────────────────────────────────
// Cloudflare worker URL — must match the live worker domain
const PORTAL_WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev';
const PORTAL_PAGE_BASE  = 'https://atlas-anesthesia.github.io/atlas-tracker';

async function _createPortalToken(caseId, type, centerId) {
  const res = await fetch(`${PORTAL_WORKER_URL}/portal-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId, type, centerId, expiresInDays: 60 })
  });
  if(!res.ok) throw new Error('Could not create portal link.');
  return await res.json();
}

async function _copyToClipboard(text) {
  try {
    if(navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch(e){}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    return true;
  } catch(e){ return false; }
}

window.generatePatientPortalLink = async function(caseId) {
  if(!caseId) return;
  try {
    const result = await _createPortalToken(caseId, 'patient');
    const url = `${PORTAL_PAGE_BASE}/portal.html?t=${result.token}`;
    const copied = await _copyToClipboard(url);
    try { logAudit('portal-link-generated', caseId, 'patient link created'); } catch(e){}
    alert(`Patient portal link created${copied ? ' and copied to clipboard' : ''}:\n\n${url}\n\nExpires in 60 days. Share via email, text, or print.`);
  } catch(err) {
    alert('Failed to generate patient link: ' + err.message);
  }
};

window.goToFinalizeFromLive = function() {
  if(!window._currentLiveCaseDraft) {
    if(window._currentLivePreop) {
      // Start a case from the pre-op
      if(typeof window.startCaseFromPreop === 'function') {
        window.startCaseFromPreop(window._currentLivePreop.id);
        return;
      }
    }
    alert('No active case to finalize. Select a draft from the dropdown.');
    return;
  }
  // Resume the draft case (sets up Finalize form with this case's data)
  if(typeof window.resumeCase === 'function') {
    window.resumeCase(window._currentLiveCaseDraft.id);
  } else {
    showTab('new-case');
  }
};

// ── HIPAA: AUDIT LOG ──────────────────────────────────────────────────────────
// Append-only log in Firestore (atlas/audit_log). Captures who did what and
// when for important PHI-touching actions. Capped at the last 5000 entries to
// stay under Firestore's 1MB doc limit. Older entries fall off the bottom.
async function logAudit(action, target, details) {
  if(typeof setDoc !== 'function' || typeof doc !== 'function' || !db) return;
  try {
    const snap = await getDoc(doc(db, 'atlas', 'audit_log')).catch(()=>null);
    const entries = snap && snap.exists() ? (snap.data().entries || []) : [];
    entries.unshift({
      id: Math.random().toString(36).slice(2, 11),
      at: new Date().toISOString(),
      email: currentUser?.email || 'unauthenticated',
      worker: (typeof currentWorker !== 'undefined' ? currentWorker : '') || '',
      action: String(action || 'unknown'),
      target: target ? String(target) : '',
      details: details ? String(details).slice(0, 240) : ''
    });
    if(entries.length > 5000) entries.length = 5000;
    await setDoc(doc(db, 'atlas', 'audit_log'), { entries });
  } catch(e) {
    console.warn('audit log write failed:', e);
  }
}
window.logAudit = logAudit;

// PHI Redaction support: verifies the current user's password without
// changing the session. Used by phi-redaction.js when the user wants to
// reveal hidden PHI for a case older than 3 days. Throws on wrong password.
window.verifyCurrentUserPassword = async function(password) {
  if(!currentUser || !currentUser.email) throw new Error('Not logged in');
  const credential = EmailAuthProvider.credential(currentUser.email, password);
  await reauthenticateWithCredential(currentUser, credential);
};

// Simple Audit Log viewer. Reads the last N entries and displays them in a
// modal. Read-only — entries are never editable, that's the whole point.
let _auditModalBuilt = false;
function _buildAuditModal() {
  if(_auditModalBuilt) return;
  const wrap = document.createElement('div');
  wrap.id = 'auditLogModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px';
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:920px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 24px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:600">🔍 Audit Log</div>
          <div style="font-size:12px;opacity:.75;margin-top:2px">Append-only record of who did what and when — required for HIPAA.</div>
        </div>
        <button onclick="closeAuditLogModal()" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
      </div>
      <div id="audit-log-body" style="padding:14px 24px;max-height:70vh;overflow-y:auto"></div>
    </div>
  `;
  document.body.appendChild(wrap);
  _auditModalBuilt = true;
}
window.openAuditLogModal = async function() {
  _buildAuditModal();
  document.getElementById('auditLogModal').style.display = 'flex';
  const body = document.getElementById('audit-log-body');
  body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint)">Loading…</div>';
  try {
    const snap = await getDoc(doc(db, 'atlas', 'audit_log'));
    const entries = snap.exists() ? (snap.data().entries || []) : [];
    if(!entries.length) {
      body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint)">No entries yet.</div>';
      return;
    }
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:160px 200px 1fr 1fr;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
        <span>When</span><span>Who</span><span>Action</span><span>Target / Details</span>
      </div>
      ${entries.map(e => {
        const when = new Date(e.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
        return `<div style="display:grid;grid-template-columns:160px 200px 1fr 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:start">
          <span style="color:var(--text-muted)">${when}</span>
          <span><div style="font-weight:500">${e.email||'—'}</div><div style="font-size:10px;color:var(--text-faint)">${e.worker||''}</div></span>
          <span><span style="background:var(--info-light);color:var(--info);font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px">${e.action||''}</span></span>
          <span style="font-family:'DM Mono',monospace;font-size:11px">${e.target||''}<div style="font-family:'DM Sans',sans-serif;font-size:11px;color:var(--text-faint);margin-top:2px">${e.details||''}</div></span>
        </div>`;
      }).join('')}
    `;
  } catch(e) {
    body.innerHTML = `<div style="padding:20px;color:var(--warn)">Error: ${e.message}</div>`;
  }
};
window.closeAuditLogModal = function() {
  const m = document.getElementById('auditLogModal');
  if(m) m.style.display = 'none';
};

// ── MANUAL BACKUP DOWNLOAD ─────────────────────────────────────────────────────
// ── PI FORMULA GLOBAL STORE ───────────────────────────────────────────────────
window._atlasFormulaData = null;
async function loadAtlasFormula() {
  try {
    const snap = await getDoc(doc(db, 'atlas', 'personal_income_formula'));
    const data = snap.exists() ? snap.data() : { centers: [] };
    window._atlasFormulaData = data;
    window._piFormula_get = () => data;
  } catch(e) { window._atlasFormulaData = { centers: [] }; }
}
// Personal-income calculator removed. Self-pay now comes straight off the
// invoice modal (one entry per case) — no formula, no per-center rules.

// ── EMERGENCY RECOVERY: list + restore from a daily Firestore backup ────────
// Call from the browser console:
//   window.listInventoryBackups()            → prints every backup_YYYY-MM-DD
//   window.restoreInventoryFrom('2026-05-14')→ pulls that day's inventory back
// Both are no-ops if no matching backup doc exists. Restore prompts before
// writing so the user can bail.
window.listInventoryBackups = async function() {
  try {
    const snap = await getDocs(collection(db, 'atlas'));
    const backups = [];
    snap.forEach(d => {
      const id = d.id;
      if(!id.startsWith('backup_')) return;
      const data = d.data() || {};
      // Backups may store inventory in different shapes — try a few.
      const inv = data.inventory || data.data?.inventory || null;
      const items = inv?.items || [];
      const nonZero = items.filter(i => (i.stockDev > 0 || i.stockJosh > 0)).length;
      backups.push({ id, date: id.replace('backup_', ''), itemCount: items.length, nonZeroCount: nonZero });
    });
    backups.sort((a, b) => b.date.localeCompare(a.date)); // newest first
    if(!backups.length) {
      console.log('%cNo daily backups found in Firestore (atlas/backup_*).', 'color:#dc2626;font-weight:600');
      return [];
    }
    console.log('%cAvailable backups (newest first):', 'color:#1d3557;font-weight:600;font-size:13px');
    console.table(backups);
    console.log('%cTo restore: window.restoreInventoryFrom("YYYY-MM-DD")', 'color:#666;font-style:italic');
    return backups;
  } catch(e) {
    console.error('listInventoryBackups failed:', e);
  }
};

// Dump the raw structure of a backup doc so we can find inventory data in
// whatever shape the cron stored it. Prints top-level keys and a tree of
// nested keys (1 level deep).
window.inspectBackup = async function(dateStr) {
  if(!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    console.log('Usage: inspectBackup("2026-05-12")');
    return;
  }
  const snap = await getDoc(doc(db, 'atlas', 'backup_' + dateStr));
  if(!snap.exists()) { console.log('No backup_' + dateStr + ' doc found.'); return; }
  const data = snap.data();
  console.log('%cTOP-LEVEL fields:', 'color:#1d3557;font-weight:600');
  console.log(Object.keys(data));
  Object.keys(data).forEach(k => {
    const v = data[k];
    if(v && typeof v === 'object' && !Array.isArray(v)) {
      console.log('  ' + k + ' →', Object.keys(v).slice(0, 12).join(', '));
    } else if(Array.isArray(v)) {
      console.log('  ' + k + ' → Array(' + v.length + ')');
    } else {
      console.log('  ' + k + ' →', typeof v, JSON.stringify(v).slice(0, 60));
    }
  });
  // Also stash on window for poking around
  window._lastInspectedBackup = data;
  console.log('%cStashed at window._lastInspectedBackup for further poking.', 'color:#666;font-style:italic');
  return data;
};

window.restoreInventoryFrom = async function(dateStr) {
  if(!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    alert('Pass a date like restoreInventoryFrom("2026-05-14")');
    return;
  }
  try {
    const docRef = doc(db, 'atlas', 'backup_' + dateStr);
    const snap = await getDoc(docRef);
    if(!snap.exists()) {
      alert('No backup found for ' + dateStr + '. Run window.listInventoryBackups() to see available dates.');
      return;
    }
    const data = snap.data() || {};
    const invData = data.inventory || data.data?.inventory || null;
    const restoreItems = invData?.items;
    if(!restoreItems || !restoreItems.length) {
      alert('Backup for ' + dateStr + ' has no inventory data inside.');
      return;
    }
    const nonZero = restoreItems.filter(i => (i.stockDev > 0 || i.stockJosh > 0)).length;
    const yes = confirm(
      'Restore inventory from ' + dateStr + '?\n\n' +
      '• ' + restoreItems.length + ' items in the backup\n' +
      '• ' + nonZero + ' items have non-zero stock\n\n' +
      'This OVERWRITES your current atlas/inventory document. Cannot be undone without another backup.'
    );
    if(!yes) return;
    // Snapshot current state first so the user can roll back if needed
    const beforeSnap = await getDoc(doc(db, 'atlas', 'inventory'));
    if(beforeSnap.exists()) {
      const snapId = 'inventory_pre_restore_' + new Date().toISOString().replace(/[:.]/g, '-');
      await setDoc(doc(db, 'atlas', snapId), beforeSnap.data());
      console.log('%cSnapshot of current inventory saved at atlas/' + snapId, 'color:#1d3557');
    }
    await setDoc(doc(db, 'atlas', 'inventory'), { items: restoreItems });
    try { logAudit('inventory-restored', '', 'from backup_' + dateStr); } catch(e){}
    alert('✓ Inventory restored from ' + dateStr + '. Refresh the page if needed.');
  } catch(e) {
    alert('Restore failed: ' + (e.message || e));
    console.error(e);
  }
};

// ── CASES MONTHLY-CHUNKED STORAGE ─────────────────────────────────────────────
// atlas/cases used to hold a single { cases: [...] } array. Once cases + their
// embedded photo data crossed ~1MB total, Firestore started rejecting writes.
// Cases are now sharded by month: each calendar month lives in its own doc at
// atlas/cases_YYYY-MM, and atlas/cases becomes a tiny manifest:
//   { format: 'monthly-v2', months: ['2026-04','2026-05',...], updatedAt }
// The format flag lets the code keep working for users still on the legacy
// single-doc layout until they run migrateCasesToMonthly() once.
let _casesFormat = 'legacy';

function _monthKey(c) {
  return ((c?.date || '').slice(0, 7)) || 'unknown';
}

async function _loadAllCases() {
  const meta = await getDoc(doc(db, 'atlas', 'cases'));
  if(!meta.exists()) { _casesFormat = 'legacy'; return []; }
  const data = meta.data();
  let arr;
  if(data.format === 'monthly-v2' && Array.isArray(data.months)) {
    _casesFormat = 'monthly-v2';
    const snaps = await Promise.all(data.months.map(m => getDoc(doc(db, 'atlas', 'cases_' + m))));
    arr = snaps.flatMap(s => s.exists() ? (s.data().cases || []) : []);
  } else {
    _casesFormat = 'legacy';
    arr = data.cases || [];
  }
  await _hydrateCasePhotos(arr);
  return arr;
}

async function _saveAllCases(casesArray) {
  // Push any inline photo dataUrls out to per-photo docs (one doc per photo)
  // and strip the dataUrls from the snapshot we're about to write. Keeps
  // the cases doc tiny and well under Firestore's 1MB-per-doc cap.
  await _extractCasePhotos(casesArray);
  const slim = _stripPhotoData(casesArray);
  if(_casesFormat === 'monthly-v2') {
    const byMonth = {};
    for(const c of slim) {
      const m = _monthKey(c);
      if(!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(c);
    }
    const months = Object.keys(byMonth).sort();
    const now = new Date().toISOString();
    await Promise.all(months.map(m =>
      setDoc(doc(db, 'atlas', 'cases_' + m), { cases: byMonth[m], updatedAt: now })
    ));
    return setDoc(doc(db, 'atlas', 'cases'), { format: 'monthly-v2', months, updatedAt: now });
  }
  return setDoc(doc(db, 'atlas', 'cases'), { cases: slim });
}

// === Per-photo storage =====================================================
// Photos used to live inline in the cases doc as base64 data URLs. That made
// the monthly cases doc balloon past Firestore's 1MB-per-doc cap once a few
// cases each had 3+ photos. Each photo now gets its own doc at
//   atlas/case_photo_<photoId>
// and the case object stores only `{ id }`. The dataUrl is hydrated back
// into the in-memory case on load so rendering code keeps working unchanged.
const _photoCache = new Map(); // photoId -> dataUrl, session-only

async function _savePhotoDoc(photoId, dataUrl) {
  await setDoc(doc(db, 'atlas', 'case_photo_' + photoId), {
    dataUrl,
    updatedAt: new Date().toISOString()
  });
  _photoCache.set(photoId, dataUrl);
}

async function _loadPhotoDoc(photoId) {
  if(_photoCache.has(photoId)) return _photoCache.get(photoId);
  try {
    const snap = await getDoc(doc(db, 'atlas', 'case_photo_' + photoId));
    if(!snap.exists()) return null;
    const url = snap.data().dataUrl || null;
    if(url) _photoCache.set(photoId, url);
    return url;
  } catch(e) { return null; }
}

// Walk each case's images: if a photo has an inline dataUrl and that exact
// dataUrl isn't already in cache, write it to its own doc. Skips re-writing
// already-persisted photos so repeat saves are cheap.
async function _extractCasePhotos(casesArray) {
  const writes = [];
  for(const c of casesArray) {
    const imgs = Array.isArray(c.images) ? c.images : [];
    for(const im of imgs) {
      if(!im || !im.id || !im.dataUrl) continue;
      if(_photoCache.get(im.id) === im.dataUrl) continue;
      writes.push(_savePhotoDoc(im.id, im.dataUrl));
    }
  }
  if(writes.length) await Promise.all(writes);
}

// Build a clone of cases with photo dataUrls dropped — only the {id}
// references remain on each image. The live `cases` array still has the
// dataUrls so rendering keeps working; this slim version is what gets saved.
function _stripPhotoData(casesArray) {
  return casesArray.map(c => {
    // If the case has no images field, return it untouched. The previous
    // version would set `images: undefined` on such cases via the spread,
    // which Firestore refuses (setDoc throws "Unsupported field value:
    // undefined").
    if(!Array.isArray(c.images)) return c;
    return {
      ...c,
      images: c.images.map(im => (im && im.id) ? { id: im.id } : null)
    };
  });
}

// After a load, fetch every photo doc referenced by the cases (via id only)
// and stitch the dataUrl back onto the in-memory image objects. Cache hits
// skip the network entirely so repeat snapshots stay fast.
async function _hydrateCasePhotos(casesArray) {
  const need = new Set();
  for(const c of casesArray) {
    const imgs = Array.isArray(c.images) ? c.images : [];
    for(const im of imgs) {
      if(im && im.id && !im.dataUrl) need.add(im.id);
    }
  }
  if(!need.size) return;
  const ids = [...need];
  const urls = await Promise.all(ids.map(id => _loadPhotoDoc(id)));
  const byId = new Map(ids.map((id, i) => [id, urls[i]]));
  for(const c of casesArray) {
    const imgs = Array.isArray(c.images) ? c.images : [];
    for(const im of imgs) {
      if(im && im.id && !im.dataUrl) {
        const url = byId.get(im.id);
        if(url) im.dataUrl = url;
      }
    }
  }
}

// One-time migration: splits the legacy atlas/cases.cases array into per-month
// docs and flips atlas/cases to the new manifest format. Safe to run twice —
// the second call detects monthly-v2 and exits without changes. Console-only;
// not exposed in the UI to avoid accidental clicks.
window.migrateCasesToMonthly = async function() {
  const metaSnap = await getDoc(doc(db, 'atlas', 'cases'));
  if(!metaSnap.exists()) { alert('No atlas/cases doc exists — nothing to migrate.'); return; }
  const data = metaSnap.data();
  if(data.format === 'monthly-v2') { alert('Already migrated to monthly format (' + (data.months?.length || 0) + ' month docs).'); return; }
  const legacy = data.cases || [];
  if(!legacy.length) { alert('atlas/cases has no cases to migrate.'); return; }
  const byMonth = {};
  for(const c of legacy) {
    const m = _monthKey(c);
    if(!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(c);
  }
  const months = Object.keys(byMonth).sort();
  const sizes = months.map(m => ({ m, n: byMonth[m].length }));
  const yes = confirm(
    'Migrate ' + legacy.length + ' cases into ' + months.length + ' monthly buckets?\n\n' +
    sizes.map(s => '  • ' + s.m + ' — ' + s.n + ' case' + (s.n === 1 ? '' : 's')).join('\n') + '\n\n' +
    'A backup of the current atlas/cases will be saved to atlas/cases_pre_migration_<ts> first. ' +
    'After migration, atlas/cases becomes a small manifest doc and the case data lives in atlas/cases_YYYY-MM.'
  );
  if(!yes) return;
  // Pre-migration snapshot
  const snapId = 'cases_pre_migration_' + new Date().toISOString().replace(/[:.]/g, '-');
  await setDoc(doc(db, 'atlas', snapId), data);
  console.log('%cPre-migration snapshot saved at atlas/' + snapId, 'color:#1d3557;font-weight:600');
  // Write per-month docs
  const now = new Date().toISOString();
  await Promise.all(months.map(m =>
    setDoc(doc(db, 'atlas', 'cases_' + m), { cases: byMonth[m], updatedAt: now })
  ));
  // Flip atlas/cases to manifest form (this also wipes the legacy .cases array)
  await setDoc(doc(db, 'atlas', 'cases'), { format: 'monthly-v2', months, updatedAt: now });
  _casesFormat = 'monthly-v2';
  try { logAudit('cases-migrated-monthly', '', legacy.length + ' cases → ' + months.length + ' month docs'); } catch(e){}
  alert('✓ Migrated ' + legacy.length + ' cases into ' + months.length + ' monthly buckets.\n\nMonths: ' + months.join(', ') + '\n\nRefresh the page to verify everything loads correctly.');
};

// Restore atlas/inventory from a local atlas-backup-*.json file on disk.
// Opens a file picker, validates the JSON, snapshots the current inventory
// to atlas/inventory_pre_restore_<timestamp> first (so we can roll back if
// the restore is wrong), then overwrites atlas/inventory with the backup.
window.restoreInventoryFromFile = async function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    try {
      const text = await file.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch(parseErr) { alert('That file isn\'t valid JSON: ' + parseErr.message); return; }
      // Accept both shapes: full export { data: { inventory: { items } } } or
      // the bare { inventory: { items } } / { items } variants.
      const invData = parsed?.data?.inventory || parsed?.inventory || parsed;
      const restoreItems = invData?.items;
      if(!Array.isArray(restoreItems) || !restoreItems.length) {
        alert('That file has no inventory.items array inside (or it\'s empty).');
        return;
      }
      const nonZero = restoreItems.filter(i => (Number(i.stockDev)||0) > 0 || (Number(i.stockJosh)||0) > 0).length;
      const exportedAt = parsed.exportedAt || '(unknown date)';
      const yes = confirm(
        'Restore inventory from local backup?\n\n' +
        '• File: ' + file.name + '\n' +
        '• Exported at: ' + exportedAt + '\n' +
        '• ' + restoreItems.length + ' items in the backup\n' +
        '• ' + nonZero + ' items have non-zero stock\n\n' +
        'This OVERWRITES your current atlas/inventory document.\n' +
        'A snapshot of the current inventory will be saved first so you can roll back.'
      );
      if(!yes) return;
      // Snapshot current state first
      const beforeSnap = await getDoc(doc(db, 'atlas', 'inventory'));
      if(beforeSnap.exists()) {
        const snapId = 'inventory_pre_restore_' + new Date().toISOString().replace(/[:.]/g, '-');
        await setDoc(doc(db, 'atlas', snapId), beforeSnap.data());
        console.log('%cSnapshot of pre-restore inventory saved at atlas/' + snapId, 'color:#1d3557;font-weight:600');
      }
      await setDoc(doc(db, 'atlas', 'inventory'), { items: restoreItems });
      try { logAudit('inventory-restored', '', 'from local file ' + file.name + ' (exportedAt ' + exportedAt + ')'); } catch(e){}
      alert('✓ Inventory restored from ' + file.name + '.\n\nRefresh the page if the table doesn\'t update on its own.');
    } catch(err) {
      alert('Restore failed: ' + (err.message || err));
      console.error(err);
    }
  };
  input.click();
};

window.downloadFullBackup = async function() {
  const btn = document.getElementById('backup-download-btn');
  if(btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    const COLS = ['inventory','cases','preop','payments','deposits','payouts',
      'surgerycenters','cslog','cstransfers','saved_pdfs','personal_income_formula'];
    const backup = { exportedAt: new Date().toISOString(), version: 'atlas-1.0', data: {} };
    for(const col of COLS) {
      try {
        const snap = await getDoc(doc(db, 'atlas', col));
        if(snap.exists()) backup.data[col] = snap.data();
      } catch(e) { console.warn('Skip:', col); }
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'atlas-backup-' + todayStr() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) { alert('Backup failed: ' + e.message); }
  finally { if(btn) { btn.textContent = '⬇ Backup'; btn.disabled = false; } }
};



// -- STATE --
let items = [];
let cases = [];
let caseItems = [];
let currentWorker = 'dev';
let currentInvTab = 'dev';
let currentHistoryFilter = 'all';
let pendingImageData = null;       // legacy mirror of pendingImages[0] for older refs
let pendingImages = [];            // [{id, dataUrl}] — supports multiple case-log photos
let currentUser = null;
// -- DEFAULT INVENTORY --
const ITEM_TEMPLATE = [
{id:'141-1719',code:'141-1719',generic:'Face Mask O2',name:"Mask O2 Elongated 7\' Tube",category:'Airway Supplies',supplier:'Medline Industries Inc.',unitSize:'50/CA',costPerUnit:1.34,stockDev:0,stockJosh:0,alert:25},
{id:'420-9994',code:'420-9994',generic:'Nasal Atomizer',name:"Nasal Atomization Device W/O Syringe",category:'Airway Supplies',supplier:'LMA North-America',unitSize:'CS=25/EA',costPerUnit:7.67,stockDev:0,stockJosh:0,alert:20},
{id:'987-0285',code:'987-0285',generic:'20G IV',name:"Insyte Autoguard BC PNK 20Gx1.16",category:'IV Supplies',supplier:'Becton-Dickinson',unitSize:'50/BX',costPerUnit:2.31,stockDev:0,stockJosh:0,alert:20},
{id:'987-0284',code:'987-0284',generic:'22G IV',name:"Insyte Autoguard BC BL 22Gx1",category:'IV Supplies',supplier:'Becton-Dickinson',unitSize:'50/BX',costPerUnit:2.31,stockDev:0,stockJosh:0,alert:20},
{id:'118-7249',code:'118-7249',generic:'KY Jelly',name:"Lubricating Jelly Fliptop 2oz/Sterile",category:'Supplies',supplier:'HR Healthcare',unitSize:'EA',costPerUnit:1.55,stockDev:0,stockJosh:0,alert:3},
{id:'777-9152',code:'777-9152',generic:'Tegaderm',name:"Tegaderm Transparent Dressing 2.4x2.8",category:'Supplies',supplier:'3M Medical Products',unitSize:'100/BX',costPerUnit:0.26,stockDev:0,stockJosh:0,alert:20},
{id:'777-7305',code:'777-7305',generic:'Eye Tape',name:"Tape Transpore Plast Transprnt 1\"x10yd",category:'Supplies',supplier:'3M Medical Products',unitSize:'EA',costPerUnit:0.82,stockDev:0,stockJosh:0,alert:5},
{id:'146-4280',code:'146-4280',generic:'LMA 2.5',name:"Airway LMA Unique SU Size 2.5",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'10/BX',costPerUnit:7.69,stockDev:0,stockJosh:0,alert:3},
{id:'LMA-4',code:'LMA-4',generic:'LMA 4',name:"LMA Unique Size 4",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'EA',costPerUnit:7.69,stockDev:0,stockJosh:0,alert:2},
{id:'LMA-5',code:'LMA-5',generic:'LMA 5',name:"LMA Unique Size 5",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'EA',costPerUnit:7.69,stockDev:0,stockJosh:0,alert:2},
{id:'136-3903',code:'136-3903',generic:'ETT 4.0',name:"Airway Silicone w/Cuff Pilot Size 4",category:'Airway Supplies',supplier:'LMA North-America',unitSize:'10/BX',costPerUnit:7.69,stockDev:0,stockJosh:0,alert:3},
{id:'136-3901',code:'136-3901',generic:'ETT 5.0',name:"Airway Silicone w/Cuff Pilot Size 5",category:'Airway Supplies',supplier:'LMA North-America',unitSize:'10/BX',costPerUnit:7.69,stockDev:0,stockJosh:0,alert:3},
{id:'139-3110',code:'139-3110',generic:'LMA 3',name:"Airway LMA Unique w/Cuff Sze 3 Mask",category:'Teleflex LLC',supplier:'Teleflex LLC',unitSize:'10/BX',costPerUnit:7.69,stockDev:0,stockJosh:0,alert:3},
{id:'113-5785',code:'113-5785',generic:'Nasal ETT 4.0',name:"AGT Nasal Tube Cuffed ET 4.0",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'10/BX',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'113-2941',code:'113-2941',generic:'Nasal ETT 4.5',name:"Cannula Nasal Cuff w/Tube 4.5\'",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'10/BX',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'743-0717',code:'743-0717',generic:'Nasal ETT 5.0',name:"Tube Endotrach Preformed 5.0MM",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'10/BX',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'146-9367',code:'146-9367',generic:'Nasal ETT 5.5',name:"Endotracheal Tube Preformed 5.5mm",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'CS=10/EA',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'491-8760',code:'491-8760',generic:'Nasal ETT 6.0',name:"Tube Endotrach 6.0mm Agt Nasal",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'EA',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'147-3037',code:'147-3037',generic:'Nasal ETT 6.5',name:"Pref AGT Endotrach Tubes 6.5mm",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'EA',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'123-5611',code:'123-5611',generic:'Nasal ETT 7.0',name:"Tube Endo Trach Nasal Cuffed 7mm",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'EA',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'743-3905',code:'743-3905',generic:'Nasal ETT 7.5',name:"Tube Endotrach Preformed 7.5MM",category:'Airway Supplies',supplier:'Teleflex LLC',unitSize:'EA',costPerUnit:5.98,stockDev:0,stockJosh:0,alert:3},
{id:'112-7097',code:'112-7097',generic:'Blunt Needle',name:"Needle Blunt Fill 18Gx1.5",category:'Supplies',supplier:'Henry Shein Inc.',unitSize:'100/BX',costPerUnit:0.13,stockDev:0,stockJosh:0,alert:20},
{id:'148-6288',code:'148-6288',generic:'TB Syringe',name:"Syringe Hypodermic TB LuerLock 1cc",category:'Supplies',supplier:'Nipro Medical Corp',unitSize:'100/BX',costPerUnit:0.17,stockDev:0,stockJosh:0,alert:20},
{id:'987-0248',code:'987-0248',generic:'3CC Syringe',name:"Luer-Lok Syringe Only 3cc",category:'Supplies',supplier:'Becton-Dickinson',unitSize:'100/BX',costPerUnit:0.11,stockDev:0,stockJosh:0,alert:50},
{id:'127-8254',code:'127-8254',generic:'10CC Syringe',name:"Syringe 10cc LL w/o Needle 10ml",category:'Supplies',supplier:'Becton-Dickinson',unitSize:'100/BX',costPerUnit:0.17,stockDev:0,stockJosh:0,alert:20},
{id:'987-3800',code:'987-3800',generic:'50CC Syringe',name:"Syringe w/o Needle LL 50ml",category:'Supplies',supplier:'Becton-Dickinson',unitSize:'30/BX',costPerUnit:0.79,stockDev:0,stockJosh:0,alert:10},
{id:'570-3406',code:'570-3406',generic:'IV Start Kit',name:"IV Start Kit w/ Chloraprep",category:'IV Supplies',supplier:'Henry Shein Inc.',unitSize:'EA',costPerUnit:1.56,stockDev:0,stockJosh:0,alert:10},
{id:'114-0817',code:'114-0817',generic:'Propofol Tubing',name:"Anesthesia Ext Tube 72\"",category:'Airway Supplies',supplier:'Wall Medical Inc',unitSize:'EA',costPerUnit:3.68,stockDev:0,stockJosh:0,alert:10},
{id:'681-3457',code:'681-3457',generic:'ETT Tape',name:"Tape Waterproof Adhesv .5x2.5yd",category:'Supplies',supplier:'Dukal LLC',unitSize:'EA',costPerUnit:0.35,stockDev:0,stockJosh:0,alert:5},
{id:'570-0887',code:'570-0887',generic:'IVF Tubing',name:"IV Admin Set 15 DRP 2 Port 105\"",category:'IV Supplies',supplier:'Henry Shein Inc.',unitSize:'EA',costPerUnit:2.95,stockDev:0,stockJosh:0,alert:10},
{id:'145-7149',code:'145-7149',generic:'Nasal Cannula',name:"Cannula CO2 Sampling Female 7 Adult",category:'Airway Supplies',supplier:'Medline Industries Inc.',unitSize:'EA',costPerUnit:3.93,stockDev:0,stockJosh:0,alert:5},
{id:'700-1576',code:'700-1576',generic:'NPA 28',name:"Robertazzi Naso Airway 28/FR",category:'Airway Supplies',supplier:'Medsource International',unitSize:'EA',costPerUnit:3.67,stockDev:0,stockJosh:0,alert:5},
{id:'700-1577',code:'700-1577',generic:'NPA 30',name:"Robertazzi Naso Airway 30/FR",category:'Airway Supplies',supplier:'Medsource International',unitSize:'EA',costPerUnit:3.67,stockDev:0,stockJosh:0,alert:5},
{id:'700-1579',code:'700-1579',generic:'NPA 34',name:"Robertazzi Naso Airway 34/FR",category:'Airway Supplies',supplier:'Medsource International',unitSize:'EA',costPerUnit:3.67,stockDev:0,stockJosh:0,alert:5},
{id:'106-1241',code:'106-1241',generic:'SCD Medium',name:"SCD Express Sleeve Knee Medium",category:'Supplies',supplier:'Cardinal Health',unitSize:'EA',costPerUnit:56.44,stockDev:0,stockJosh:0,alert:1},
{id:'113-9573',code:'113-9573',generic:'SCD Large',name:"SCD Express Sleeve Knee Pair Large",category:'Supplies',supplier:'Cardinal Health',unitSize:'EA',costPerUnit:70.4,stockDev:0,stockJosh:0,alert:1},
{id:'122-8718',code:'122-8718',generic:'JacksonRees Circuit',name:"Circuit Anesthesia JacksonRees",category:'Airway Supplies',supplier:'Medline Industries Inc.',unitSize:'EA',costPerUnit:12.6,stockDev:0,stockJosh:0,alert:5},
{id:'627-0136',code:'627-0136',generic:'Mask 5',name:"Mask Anesthesia Prem Cushion Sz 5",category:'Airway Supplies',supplier:'Trinity Medical Devices',unitSize:'EA',costPerUnit:0.28,stockDev:0,stockJosh:0,alert:3},
{id:'627-0140',code:'627-0140',generic:'Mask 4',name:"Mask Anesthesia Prem Cushion Sz 4",category:'Airway Supplies',supplier:'Trinity Medical Devices',unitSize:'EA',costPerUnit:0.28,stockDev:0,stockJosh:0,alert:3},
{id:'627-0141',code:'627-0141',generic:'Mask 3',name:"Mask Anesthesia Prem Cushion Sz 3",category:'Airway Supplies',supplier:'Trinity Medical Devices',unitSize:'EA',costPerUnit:0.28,stockDev:0,stockJosh:0,alert:3},
{id:'570-3485',code:'570-3485',generic:'Gloves N300',name:"N300 Nitrile Exam Gloves Large Black Non-Sterile",category:'Supplies',supplier:'Criterion',unitSize:'1 Box',costPerUnit:0.04,stockDev:0,stockJosh:0,alert:1},
{id:'570-3490',code:'570-3490',generic:'Gloves N200',name:"N200 Nitrile Exam Gloves Large Black Non-Sterile",category:'Supplies',supplier:'Criterion',unitSize:'1 Box',costPerUnit:0.06,stockDev:0,stockJosh:0,alert:1},
{id:'777-9475',code:'777-9475',generic:'EKG Sticker',name:"Red Dot Electrocardiogram Electrode Adult 4x3-1/2cm Foam",category:'Supplies',supplier:'3M Medical Products',unitSize:'2 Bag',costPerUnit:0.23,stockDev:0,stockJosh:0,alert:1},
{id:'149-6489',code:'149-6489',generic:'Magills',name:"Magill Catheter Forceps 8\"",category:'Supplies',supplier:'Elmed Instruments',unitSize:'EA',costPerUnit:10.66,stockDev:0,stockJosh:0,alert:5},
{id:'3WSTOPCOK',code:'3WSTOPCOK',generic:'3 Way Stop Cock',name:"3 Way Stop Cock",category:'Supplies',supplier:'Various',unitSize:'EA',costPerUnit:0.5,stockDev:0,stockJosh:0,alert:10},
{id:'CO2CONN',code:'CO2CONN',generic:'CO2 Connector',name:"CO2 Connector",category:'Supplies',supplier:'Various',unitSize:'EA',costPerUnit:0.5,stockDev:0,stockJosh:0,alert:10},
{id:'00904-6720-59',code:'00904-6720-59',generic:'Tylenol',name:"Acetaminophen 500mg Caplets",category:'Drugs / Medications',supplier:'Various',unitSize:'100ct',costPerUnit:0.04,stockDev:0,stockJosh:0,alert:10},
{id:'00093-3174-31',code:'00093-3174-31',generic:'Albuterol',name:"Albuterol HFA Inhaler (Proair) 200 dose",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:16.0,stockDev:0,stockJosh:0,alert:2},
{id:'00143-9875-25',code:'00143-9875-25',generic:'Amiodarone',name:"Amiodarone 150mg/3mL vials",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:1.32,stockDev:0,stockJosh:0,alert:3},
{id:'00904-6794-89',code:'00904-6794-89',generic:'ASA',name:"Aspirin 81mg chewable",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.03,stockDev:0,stockJosh:0,alert:10},
{id:'64253-0400-91',code:'64253-0400-91',generic:'Atropine',name:"Atropine 1mg/10mL syringes",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:11.2,stockDev:0,stockJosh:0,alert:3},
{id:'00641-6145-25',code:'00641-6145-25',generic:'Decadron',name:"Dexamethasone 4mg/mg Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.96,stockDev:0,stockJosh:0,alert:5},
{id:'71288-0505-03',code:'71288-0505-03',generic:'Precedex',name:"Dexmedetomidine 200mcg/2mL vials",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:2.84,stockDev:0,stockJosh:0,alert:3},
{id:'76329-3302-01',code:'76329-3302-01',generic:'D50',name:"Dextrose 50% 50mL Syringe",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:20.9,stockDev:0,stockJosh:0,alert:2},
{id:'25021-0319-10',code:'25021-0319-10',generic:'Cardizem',name:"Diltiazem 50mg/10mL",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:6.2,stockDev:0,stockJosh:0,alert:2},
{id:'72485-0101-25',code:'72485-0101-25',generic:'Benadryl',name:"Diphenhydramine 50mg/mg",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:1.08,stockDev:0,stockJosh:0,alert:3},
{id:'70700-0249-25',code:'70700-0249-25',generic:'Ephedrine',name:"Ephedrine 50mg/mg Vial",category:'Controlled Substances',supplier:'Various',unitSize:'EA',costPerUnit:4.4,stockDev:0,stockJosh:0,alert:3},
{id:'76329-3318-01',code:'76329-3318-01',generic:'Epi',name:"Epinephrine 0.1mg/mg Syringe",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:14.0,stockDev:0,stockJosh:0,alert:2},
{id:'55150-0194-10',code:'55150-0194-10',generic:'Esmolol',name:"Esmolol 10mg/mg Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:2.24,stockDev:0,stockJosh:0,alert:3},
{id:'70860-0751-02',code:'70860-0751-02',generic:'Pepcid',name:"Famotidine 20mg/2mL SDV",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.84,stockDev:0,stockJosh:0,alert:3},
{id:'71288-0203-05',code:'71288-0203-05',generic:'Lasix',name:"Furosemide 40mg/4mL Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.72,stockDev:0,stockJosh:0,alert:3},
{id:'66794-0204-42',code:'66794-0204-42',generic:'Robinul',name:"Glycopyrrolate 1mg/5mL Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:2.12,stockDev:0,stockJosh:0,alert:5},
{id:'00641-6231-25',code:'00641-6231-25',generic:'Hydralazine',name:"Hydralazine 20mg/mg Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:3.2,stockDev:0,stockJosh:0,alert:3},
{id:'76204-0600-30',code:'76204-0600-30',generic:'DuoNeb',name:"Ipratropium 0.5mg-Albuterol 3mg/mg Neb Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.3,stockDev:0,stockJosh:0,alert:2},
{id:'72266-0118-25',code:'72266-0118-25',generic:'Toradol',name:"Ketorolac 30mg/mg Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.76,stockDev:0,stockJosh:0,alert:5},
{id:'36000-0322-02',code:'36000-0322-02',generic:'Labetalol',name:"Labetalol 100mg/20mL MDV",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:4.0,stockDev:0,stockJosh:0,alert:2},
{id:'00264-7750-00',code:'00264-7750-00',generic:'Lactated Ringers',name:"Lactated Ringers 1L Bag",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:3.42,stockDev:0,stockJosh:0,alert:3},
{id:'00143-9595-25',code:'00143-9595-25',generic:'Lidocaine 1%',name:"Lidocaine 1% SDV (preservative-free)",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:1.76,stockDev:0,stockJosh:0,alert:3},
{id:'00009-3073-01',code:'00009-3073-01',generic:'Solumedrol',name:"Methylprednisolone 40mg/mg Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:9.0,stockDev:0,stockJosh:0,alert:1},
{id:'23155-0240-41',code:'23155-0240-41',generic:'Reglan',name:"Metoclopramide 10mg/2mL Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:1.4,stockDev:0,stockJosh:0,alert:5},
{id:'36000-0033-10',code:'36000-0033-10',generic:'Metoprolol',name:"Metoprolol 5mg/5mL SDV",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.9,stockDev:0,stockJosh:0,alert:2},
{id:'70069-0671-10',code:'70069-0671-10',generic:'Nubain (Nalbuphine)',name:"Nalbuphine 10mg/mg ampule",category:'Drugs / Medications',supplier:'Smith Pharmacy',unitSize:'10mLx25',costPerUnit:6.9,stockDev:0,stockJosh:0,alert:5},
{id:'23155-0518-41',code:'23155-0518-41',generic:'Neostigmine',name:"Neostigmine 10mg/10mL MDV",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:3.7,stockDev:0,stockJosh:0,alert:3},
{id:'69339-0174-41',code:'69339-0174-41',generic:'Nitro Tabs',name:"Nitroglycerin 0.4mg SL tabs",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:10.0,stockDev:0,stockJosh:0,alert:5},
{id:'60505-6130-05',code:'60505-6130-05',generic:'Zofran',name:"Ondansetron 4mg/2mL Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:0.44,stockDev:0,stockJosh:0,alert:5},
{id:'00904-6761-30',code:'00904-6761-30',generic:'Afrin',name:"Oxymetazoline (Afrin) 0.5% Nasal Spray",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:3.0,stockDev:0,stockJosh:0,alert:2},
{id:'70756-0621-25',code:'70756-0621-25',generic:'Neo',name:"Phenylephrine 10mg SDV",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:1.2,stockDev:0,stockJosh:0,alert:3},
{id:'23155-0345-44',code:'23155-0345-44',generic:'Propofol 20mL',name:"Propofol 200mg/20mL Vials",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:2.3,stockDev:0,stockJosh:0,alert:5},
{id:'23155-0345-42',code:'23155-0345-42',generic:'Propofol 50mL',name:"Propofol 500mg/50mL Vials",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:5.2,stockDev:0,stockJosh:0,alert:5},
{id:'00487-5901-99',code:'00487-5901-99',generic:'Racemic',name:"Racepinephrine-S2 2.25% soln",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:2.53,stockDev:0,stockJosh:0,alert:3},
{id:'43066-0007-10',code:'43066-0007-10',generic:'Roc',name:"Rocuronium 50mg/5mL Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:3.7,stockDev:0,stockJosh:0,alert:2},
{id:'70069-0301-25',code:'70069-0301-25',generic:'Sux (Succinylcholine)',name:"Succinylcholine 20mg/mg Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:2.08,stockDev:0,stockJosh:0,alert:3},
{id:'0143-9509-10',code:'0143-9509-10',generic:'Ketamine',name:"Ketamine HCI Injection 500mg/5mL",category:'Controlled Substances',supplier:'Smith Pharmacy',unitSize:'10mLx25',costPerUnit:14.67,stockDev:0,stockJosh:0,alert:2},
{id:'LTA-kit',code:'LTA-kit',generic:'LTA',name:"LTA Kit",category:'Supplies',supplier:'Various',unitSize:'EA',costPerUnit:5.0,stockDev:0,stockJosh:0,alert:1},
{id:'VERSED-MDZ',code:'VERSED-MDZ',generic:'Versed (Midazolam)',name:"Midazolam 5mg/mg Vial",category:'Controlled Substances',supplier:'Various',unitSize:'EA',costPerUnit:2.5,stockDev:0,stockJosh:0,alert:3},
{id:'LIDO2PCT',code:'LIDO2PCT',generic:'Lido 2%',name:"Lidocaine 2% SDV",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:1.5,stockDev:0,stockJosh:0,alert:5},
{id:'VASOPRESSIN',code:'VASOPRESSIN',generic:'Vasopressin',name:"Vasopressin 20units/mg",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:3.0,stockDev:0,stockJosh:0,alert:2},
{id:'ANCEF',code:'ANCEF',generic:'Ancef',name:"Cefazolin 1g/10mL Vial",category:'Drugs / Medications',supplier:'Various',unitSize:'EA',costPerUnit:2.5,stockDev:0,stockJosh:0,alert:5}
];
const DEFAULT_STOCK = {
'141-1719':100,'420-9994':100,'146-4280':10,'136-3903':10,'136-3901':10,'139-3110':10,'113-5785':10,'113-2941':10,'743-0717':10,'146-9367':10,'491-8760':10,'147-3037':10,'123-5611':10,'743-3905':10,'700-1576':50,'700-1577':50,'700-1579':5,'627-0136':20,'627-0140':20,'627-0141':20,'122-8718':20,'145-7149':50,'149-6489':50,'987-0285':50,'987-0284':50,'118-7249':12,'777-9152':100,'777-7305':24,'112-7097':200,'148-6288':0,'987-0248':400,'127-8254':400,'987-3800':160,'570-3406':100,'114-0817':120,'681-3457':36,'570-0887':100,'777-9475':250,'106-1241':5,'113-9573':5,'570-3485':600,'570-3490':400,'00904-6720-59':100,'00093-3174-31':8,'00143-9875-25':25,'00904-6794-89':90,'64253-0400-91':10,'00641-6145-25':49,'71288-0505-03':25,'76329-3302-01':10,'25021-0319-10':10,'72485-0101-25':25,'70700-0249-25':25,'76329-3318-01':10,'55150-0194-10':25,'70860-0751-02':25,'71288-0203-05':25,'66794-0204-42':50,'00641-6231-25':25,'76204-0600-30':25,'72266-0118-25':49,'0143-9509-10':3,'36000-0322-02':8,'00264-7750-00':36,'00143-9595-25':50,'00009-3073-01':2,'23155-0240-41':25,'36000-0033-10':10,'70069-0671-10':20,'23155-0518-41':10,'69339-0174-41':25,'60505-6130-05':50,'00904-6761-30':10,'70756-0621-25':25,'23155-0345-44':80,'23155-0345-42':200,'00487-5901-99':30,'43066-0007-10':10,'70069-0301-25':25
};
// -- SYNC INDICATOR --
function setSyncing(on) {
const dot = document.getElementById('syncDot');
const txt = document.getElementById('syncText');
if(on){dot.className='sync-dot syncing';txt.textContent='Saving...';}
else{dot.className='sync-dot';txt.textContent='Synced';}
}
// -- AUTH --
window.doLogin = async function() {
const email = document.getElementById('loginEmail').value.trim();
const pass = document.getElementById('loginPassword').value;
const errEl = document.getElementById('loginError');
errEl.style.display='none';
try {
await signInWithEmailAndPassword(auth, email, pass);
} catch(e) {
errEl.style.display='block';
errEl.textContent = e.code==='auth/invalid-credential' ? 'Incorrect email or password.' : e.message;
}
};
window.doLogout = async function() {
await signOut(auth);
};
// -- AUTH STATE --
// -- EMAIL → WORKER MAP --
const EMAIL_WORKER_MAP = {
'jxcondado@gmail.com': 'josh',
'murthy.devarsh@gmail.com': 'dev'
};
// Role map — controls what each login can see.
//   'crna'      → full access (Josh, Dev)
//   'assistant' → pre-op admin only (Pre-Op, Mid-Case, Calendar + deposit emails)
// Add the assistant's Firebase login email below, lowercase, mapped to 'assistant'.
const EMAIL_ROLE_MAP = {
'jxcondado@gmail.com': 'crna',
'murthy.devarsh@gmail.com': 'crna',
'vallieresjordan@gmail.com': 'assistant', // Jordan — pre-op nurse
'condadonicole@gmail.com':   'scheduler'  // Nicole — schedules pre-op visits
};
// Stripe link the patient can use to pay the $100 pre-op fee directly, used
// only as a backup when card info couldn't be collected over the phone.
const PREOP_VISIT_STRIPE_LINK = 'https://buy.stripe.com/7sY28q4dF5JrfSI6aZejK03';

// Unknown emails default to the restricted 'assistant' role (least privilege).
function getUserRole(email) {
  return EMAIL_ROLE_MAP[(email||'').toLowerCase()] || 'assistant';
}
// Per-email display name. Decoupled from role so a typoed/unknown email never
// silently borrows another person's label (e.g. assistant default → "Jordan").
const EMAIL_NAME_MAP = {
  'jxcondado@gmail.com':       'Josh',
  'murthy.devarsh@gmail.com':  'Devarsh',
  'vallieresjordan@gmail.com': 'Jordan',
  'condadonicole@gmail.com':   'Nicole'
};
function getUserDisplayName(email, role) {
  const known = EMAIL_NAME_MAP[(email||'').toLowerCase()];
  if(known) return known;
  // No exact match → don't pretend to know who they are.
  return role === 'crna' ? 'CRNA' : 'User';
}
// Tabs an assistant (Jordan) is allowed to open. He has his own Availability
// tab + shared Tracker so he can see what Nicole booked and update his own
// clearance progress pills on each row.
// Jordan works exclusively from the Tracker: she opens the linked Pre-Op
// from each row, manages her Availability, and now has her own Calendar
// view showing her scheduled clearance calls. Mid-Case is CRNA-only.
const ASSISTANT_TABS = ['scheduler-tracker','calendar','preop','availability','preop-history','phone-tracker'];
// Scheduler (Nicole) sees Jordan's availability calendar and the same Tracker
// table — she manages "Called" + watches $100 Stripe + Jordan's clearance.
const SCHEDULER_TABS = ['scheduler-tracker','calendar'];

// Hide nav / forms based on role. Assistant (Jordan) only sees pre-op tabs.
// Scheduler (Nicole) only sees the calendar. View looks otherwise normal.
function applyRoleRestrictions(role) {
  const isAssistant = role === 'assistant';
  const isScheduler = role === 'scheduler';
  const restricted = isAssistant || isScheduler;

  // Top-level nav buttons assistants/schedulers shouldn't see.
  // Jordan: no Pre-Op nav entry (she opens pre-ops from the Tracker row),
  //         no Mid-Case (her workflow lives entirely on the Tracker).
  const assistantHide = ['nav-home','nav-preop','nav-mid-case','nav-new-case','nav-payments'];
  const schedulerHide = ['nav-home','nav-preop','nav-mid-case','nav-new-case','nav-payments'];
  const toHide = isScheduler ? schedulerHide : (isAssistant ? assistantHide : []);
  ['nav-home','nav-preop','nav-mid-case','nav-new-case','nav-payments'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = toHide.includes(id) ? 'none' : '';
  });

  // Reports + Setup dropdowns — hidden for restricted roles.
  const reportsDd = document.getElementById('reports-dropdown');
  if(reportsDd) reportsDd.style.display = restricted ? 'none' : '';
  const setupDd = document.getElementById('setup-dropdown');
  if(setupDd) setupDd.style.display = restricted ? 'none' : '';
  // Top-level Calendar — shown to Nicole and Jordan (each gets a role-
  // tailored event set via getCalEvents). CRNAs reach Calendar via the Setup
  // dropdown like before.
  const navCalendar = document.getElementById('nav-calendar');
  if(navCalendar) navCalendar.style.display = (isScheduler || isAssistant) ? '' : 'none';
  // Availability tab — Jordan only.
  const navAvail = document.getElementById('nav-availability');
  if(navAvail) navAvail.style.display = isAssistant ? '' : 'none';
  // Phone Tracker tab — Jordan only.
  const navPhone = document.getElementById('nav-phone-tracker');
  if(navPhone) navPhone.style.display = isAssistant ? '' : 'none';
  // Tracker tab — both Jordan (assistant) and Nicole (scheduler) see it.
  const navTracker = document.getElementById('nav-scheduler-tracker');
  if(navTracker) navTracker.style.display = (isAssistant || isScheduler) ? '' : 'none';
  // Calendar clutter for Nicole — she only cares about surgery dates +
  // Jordan's availability. Hide everything else on the calendar tab.
  if(isScheduler) {
    ['cal-legend-preop-call','cal-legend-final-payment','cal-preop-days-row','cal-deposit-days-row','cal-worker-key','cal-controls-card']
      .forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
    // Show the Jordan-Available legend chip only on the scheduler's calendar.
    const jordanLegend = document.getElementById('cal-legend-jordan-avail');
    if(jordanLegend) jordanLegend.style.display = 'flex';
  }
  // Jordan's Calendar: only her scheduled 📞 calls are plotted, so every
  // legend/colorkey/days-input on the Calendar tab is noise. Hide it all.
  if(isAssistant) {
    ['cal-legend-bar','cal-worker-key','cal-controls-card']
      .forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
  }

  // CRNA-assignment toggle on the Pre-Op form — only relevant for assistants.
  const crnaPick = document.getElementById('po-assign-crna-row');
  if(crnaPick) crnaPick.style.display = isAssistant ? '' : 'none';

  // Buttons on the Pre-Op tab + the header Surgery Mode toggle.
  // Jordan: no $500 deposit, no anesthesia record, no surgery mode.
  // Nicole: also no surgery mode (she never operates a case).
  ['preop-deposit-btn','preop-print-record-btn'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = isAssistant ? 'none' : '';
  });
  const surgeryModeBtn = document.getElementById('surgery-mode-toggle');
  if(surgeryModeBtn) surgeryModeBtn.style.display = (isAssistant || isScheduler) ? 'none' : '';

  // "+ New Pre-Op" shortcut on Mid-Case — hide for restricted roles since
  // they shouldn't be creating fresh pre-ops from scratch.
  const midNewPreop = document.getElementById('mid-case-new-preop-btn');
  if(midNewPreop) midNewPreop.style.display = restricted ? 'none' : '';
  // Tracker's "+ Add Patient" entry — only Nicole adds patients.
  const strAddBtn = document.getElementById('str-add-patient-btn');
  if(strAddBtn) strAddBtn.style.display = isScheduler ? '' : 'none';
  // Tracker's "Send Fax" button — Jordan's workflow lives on the Tracker,
  // so the fax entry point lives there for her (and stays available to
  // CRNAs too, who can also pop into the tab if needed).
  const strFaxBtn = document.getElementById('str-fax-btn');
  if(strFaxBtn) strFaxBtn.style.display = isScheduler ? 'none' : '';
  // Move Mid-Case header's fax entry away — only CRNAs need it (and they
  // already have access via Pre-Op).
  const midFaxBtn = document.getElementById('mid-case-fax-btn');
  if(midFaxBtn) midFaxBtn.style.display = isAssistant ? 'none' : '';
  // Pre-Op tab's fax / scheduled-faxes buttons — Jordan reaches the fax
  // picker from the Tracker header instead, so hide them from her view.
  if(isAssistant) {
    document.querySelectorAll('#tab-preop .action-bar button').forEach(b => {
      const txt = (b.textContent || '').trim();
      if(txt.includes('Send Fax') || txt.includes('Scheduled Faxes')) b.style.display = 'none';
    });
  }

  // Bounce restricted roles off any tab they shouldn't be on.
  if(restricted) {
    const active = document.querySelector('.section.active');
    const activeTab = active ? active.id.replace('tab-','') : '';
    const allowed = isScheduler ? SCHEDULER_TABS : ASSISTANT_TABS;
    if(!allowed.includes(activeTab)) {
      try { showTab(allowed[0]); } catch(e){}
    }
  }
}

// ── SCHEDULE PRE-OP VISIT MODAL ───────────────────────────────────────────────
// Used by Nicole (and Jordan) to book a pre-op clearance visit + email the
// patient a $100 Stripe link. The patient pays the $100 BEFORE Jordan does
// the clearance, per the agreed workflow.
window.openSchedulePreopVisitModal = function(entryId) {
  // The modal is only useful when called from a Tracker row — that's where the
  // patient + surgery info lives. Block ad-hoc opens to keep the flow tidy.
  if(!entryId) {
    alert('Open a patient from the Tracker to schedule their pre-op visit.');
    if(typeof showTab === 'function') showTab('scheduler-tracker');
    return;
  }
  const entry = (typeof window._strGetEntry === 'function') ? window._strGetEntry(entryId) : null;
  if(!entry) {
    alert('Could not find this patient on the Tracker. Reload and try again.');
    return;
  }
  window._spvEntryId = entryId;
  window._spvEntry = entry;
  const prior = document.getElementById('schedulePreopVisitModal');
  if(prior) prior.remove();
  const wrap = document.createElement('div');
  wrap.id = 'schedulePreopVisitModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
  wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };
  const todayIso = new Date().toISOString().split('T')[0];
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmtDate = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' }) : '—';
  const fmtTime = t => t ? new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '';
  const patientName = [entry.patientFirst, entry.patientLast].filter(Boolean).join(' ') || '—';
  // Surgery date - 1 day; visit date input clamps below this.
  let visitMax = '';
  if(entry.surgeryDate) {
    const d = new Date(entry.surgeryDate + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    visitMax = d.toISOString().split('T')[0];
  }
  const lockedCss = 'background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;cursor:not-allowed';

  wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:920px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
    <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
      <div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">Schedule</div><div style="font-size:16px;font-weight:600">Pre-Op Visit with Jordan, APRN, FNP · ${esc(patientName)}</div></div>
      <button onclick="document.getElementById('schedulePreopVisitModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button>
    </div>
    <div class="spv-body" style="display:flex;gap:0;flex-wrap:wrap">

      <!-- LEFT: form -->
      <div style="flex:1.4 1 360px;min-width:0;padding:20px 22px;border-right:1px solid var(--border)">
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e3a8a;line-height:1.5">Patient info below comes from the Tracker — tap ✏ on the row to edit it. Here, just add the email and the pre-op visit time you agreed on with the patient.</div>

        <!-- Locked patient + surgery info -->
        <div style="border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:12px 14px;margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);margin-bottom:8px">From Tracker</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;font-size:13px">
            <div><div style="font-size:11px;color:var(--text-faint)">Patient</div><div style="font-weight:600">${esc(patientName)}</div></div>
            <div><div style="font-size:11px;color:var(--text-faint)">Phone</div><div style="font-weight:600">${esc(entry.patientPhone || '—')}</div></div>
            <div><div style="font-size:11px;color:var(--text-faint)">PCP</div><div style="font-weight:600">${esc(entry.pcp || '—')}</div></div>
            <div><div style="font-size:11px;color:var(--text-faint)">Surgery Center</div><div style="font-weight:600">${esc(entry.surgeryCenterName || '—')}</div></div>
            <div><div style="font-size:11px;color:var(--text-faint)">Surgery Date</div><div style="font-weight:600;color:#9a3412">${esc(fmtDate(entry.surgeryDate))}</div></div>
            <div><div style="font-size:11px;color:var(--text-faint)">Surgery Start</div><div style="font-weight:600;color:#9a3412">${esc(fmtTime(entry.surgeryTime)) || '—'}</div></div>
          </div>
        </div>

        <!-- Editable fields -->
        <div style="margin-bottom:14px"><label style="margin-top:0">Patient email <span style="color:var(--warn)">*</span></label><input type="email" id="spv-email" placeholder="patient@email.com" value="${esc(entry.patientEmail || '')}" oninput="window._spvRefreshPreview()"></div>
        <!-- Visit date/time + Jordan's slot picker removed: the patient now
             picks their own time via the self-scheduling portal once the
             $100 fee is paid. Date/time get stamped on the entry when the
             patient confirms. -->
        <input type="hidden" id="spv-date" value="">
        <input type="hidden" id="spv-time" value="">
        <div style="margin-bottom:14px"><label style="margin-top:0">Assign to CRNA <span style="color:var(--warn)">*</span></label><div class="worker-toggle" style="margin-bottom:0"><button type="button" class="worker-btn active-josh" id="spv-josh" onclick="window._spvSetCrna('josh')">Josh</button><button type="button" class="worker-btn" id="spv-dev" onclick="window._spvSetCrna('dev')">Devarsh</button></div></div>
        <!-- $100 collection toggle removed — patient always pays via the
             portal Stripe link, no over-the-phone option anymore. -->

        <div style="margin-bottom:14px"><label style="margin-top:0">Note for patient (optional)</label><textarea id="spv-note" placeholder="Anything the patient should know about the visit..." oninput="window._spvRefreshPreview()" style="width:100%;min-height:72px;padding:10px 12px;font-family:inherit;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;color:var(--text);outline:none;resize:vertical"></textarea></div>
        <div style="margin-bottom:14px;border:1px solid var(--border);border-radius:8px;background:#fafafa">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px">
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-faint)">Confirmation email preview</div>
            <button type="button" id="spv-preview-toggle" onclick="window._spvTogglePreview()" class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 10px">👁 Show preview</button>
          </div>
          <div id="spv-preview-box" style="display:none;border-top:1px solid var(--border);background:#f1f5f9">
            <iframe id="spv-preview-iframe" sandbox="allow-same-origin" style="width:100%;height:380px;border:none;display:block"></iframe>
          </div>
        </div>
        <div id="spv-status" style="font-size:13px;padding:6px 0;min-height:18px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--border)">
          <button class="btn btn-ghost" onclick="document.getElementById('schedulePreopVisitModal').remove()">Cancel</button>
          <button id="spv-send-btn" class="btn btn-primary" onclick="window._spvSend()" style="background:#1d3557;border-color:#1d3557">📧 Book & Send Confirmation</button>
        </div>
      </div>

      <!-- RIGHT: call script panel -->
      <div style="flex:1 1 280px;min-width:0;background:#f8fafc;padding:20px 22px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#1d3557;margin-bottom:10px">📞 Call script</div>
        <div id="spv-script" style="font-size:13px;color:#1e293b;line-height:1.6;font-style:normal"></div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  window._spvCrna = 'josh';
  window._spvPayMethod = 'email';   // Always email-via-portal now
  setTimeout(() => {
    document.getElementById('spv-email')?.focus();
    // Slot picker removed — patient self-schedules via the portal post-payment.
    window._spvRefreshPreview();
    window._spvRenderScript();
  }, 60);
};

// Render the call-script panel with the patient/surgery info filled in.
window._spvRenderScript = function() {
  const host = document.getElementById('spv-script');
  if(!host) return;
  const e = window._spvEntry || {};
  const center = e.surgeryCenterName || '____';
  const surgeon = e.surgeon || '____';
  const fmtDate = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }) : '____';
  const fmtTime = t => t ? new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '____';
  const surgD = fmtDate(e.surgeryDate);
  const surgT = fmtTime(e.surgeryTime);
  // Only highlight the dynamic placeholders that vary per patient — name +
  // "you" stay plain so the script reads naturally.
  const hl = s => `<strong style="background:#dcfce7;border-radius:4px;padding:1px 5px;color:#166534">${s}</strong>`;
  host.innerHTML = `
    <p style="margin:0 0 10px">Hi, my name is Nicole calling from Atlas Anesthesia.</p>
    <p style="margin:0 0 10px">I see you have an upcoming procedure with ${hl(surgeon)} at ${hl(center)} on ${hl(surgD)} at ${hl(surgT)}.</p>
    <p style="margin:0 0 10px">We wanted to call to schedule anesthesia clearance.</p>
    <p style="margin:0 0 10px">We have our own nurse practitioner, ${hl('Jordan, APRN, FNP')}, who will give you a call and walk you through everything you need to do.</p>
    <p style="margin:0 0 10px">There's a <strong>$100 fee</strong> for the clearance — I'll email you a secure payment link, and once that's paid you'll pick a time to talk with ${hl('Jordan, APRN, FNP')}.</p>
    <p style="margin:0 0 10px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:9px 11px;color:#92400e"><strong>📧 Don't forget — ask for their email address</strong> so I can send the payment link and scheduling portal. Drop it in the form to the left before clicking Send.</p>
    <div style="margin-top:14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:11px 12px;color:#1e3a8a">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#1d4ed8;margin-bottom:6px">📨 If you reach voicemail</div>
      <p style="margin:0 0 8px">Hello, my name is Nicole from Atlas Anesthesia. I see you have an upcoming procedure with ${hl(surgeon)} at ${hl(center)}.</p>
      <p style="margin:0">I'm calling to schedule your clearance for anesthesia. Please give us a call back at your earliest convenience so we can proceed to schedule anesthesia for your case.</p>
    </div>
    <hr style="border:0;border-top:1px solid #e2e8f0;margin:14px 0">
    <div style="font-size:11px;color:var(--text-faint);font-style:normal">Once they agree, drop their email in the form to the left and pick a visit time from Jordan's open slots. The confirmation email goes out as soon as you book.</div>
  `;
};

// Toggle between phone-collected card info (default) and emailing the Stripe
// link as a backup. Drives the "What to expect" copy in the patient email.
window._spvSetPayMethod = function(m) {
  // Toggle is gone; this remains as a no-op stub so older inline
  // handlers (or anything reading the global) don't error.
  window._spvPayMethod = 'email';
  window._spvRefreshPreview();
};

// Render Jordan's open availability slots as tap-to-fill chips inside the
// Schedule Pre-Op Visit modal. Pulls from window._availabilitySlots which is
// kept in sync by availability.js.
// Break a "HH:MM"–"HH:MM" availability window into 15-minute start times.
// Each entry is a valid pre-op visit start; final increment must fit inside.
function _spvExpand15(start, end) {
  if(!start || !end) return [];
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if([sh, sm, eh, em].some(n => Number.isNaN(n))) return [];
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const out = [];
  for(let m = startMin; m + 15 <= endMin; m += 15) {
    out.push(String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0'));
  }
  return out;
}

window._spvRenderOpenSlots = async function() {
  const host = document.getElementById('spv-open-slots');
  if(!host) return;
  // If availability.js hasn't published slots yet, give it one chance to load.
  if((!window._availabilitySlots || !Object.keys(window._availabilitySlots).length) && typeof window.openAvailability === 'function') {
    try { await window.openAvailability(); } catch(e){}
  }
  const slots = window._availabilitySlots || {};
  const todayIso = new Date().toISOString().split('T')[0];

  // Already-booked starts (date + time) so we don't offer a taken slot.
  const taken = new Set();
  try {
    const visitsSnap = await getDoc(doc(db, 'atlas', 'preop_visits'));
    if(visitsSnap.exists()) {
      (visitsSnap.data().entries || []).forEach(e => {
        if(e.date && e.time) taken.add(e.date + ' ' + e.time);
      });
    }
  } catch(e) { /* fall through — show all 15-min slots if we can't load bookings */ }

  // For each upcoming day, build the de-duped sorted list of free 15-min starts.
  // Stored slots are Central → convert each 15-min start to Eastern before
  // showing to Nicole and before checking against existing (Eastern) bookings.
  const grouped = {};
  Object.keys(slots).sort().forEach(date => {
    if(date < todayIso) return;
    const all = new Set();
    (slots[date] || []).forEach(s =>
      _spvExpand15(s.start, s.end).forEach(t => all.add(t))
    );
    const free = [...all].filter(t => !taken.has(date + ' ' + t)).sort();
    if(free.length) grouped[date] = free;
  });

  const dates = Object.keys(grouped).sort();
  if(!dates.length) {
    host.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:6px 10px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px">Jordan hasn’t opened any pre-op visit slots yet, or every slot is already booked. Enter a date/time manually below.</div>';
    return;
  }

  const fmtDate = iso => {
    try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }); }
    catch(e) { return iso; }
  };
  const fmtTime = t => {
    try { return new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }); }
    catch(e) { return t; }
  };

  // Group the chips by day so Nicole can scan visually.
  const dayBlocks = dates.slice(0, 14).map(date => {
    const chips = grouped[date].map(t =>
      `<button type="button" onclick="window._spvFillSlot('${date}','${t}')" style="background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:12px;font-weight:600;padding:4px 9px;border-radius:12px;cursor:pointer;font-family:inherit;white-space:nowrap">${fmtTime(t)}</button>`
    ).join('');
    return `<div style="margin-bottom:8px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-faint);margin-bottom:4px">${fmtDate(date)}</div><div style="display:flex;gap:4px;flex-wrap:wrap">${chips}</div></div>`;
  }).join('');

  host.innerHTML = `
    <label style="margin-top:0">Jordan’s open slots <span style="font-weight:400;color:var(--text-faint);font-size:11px">(15-min increments)</span></label>
    <div style="max-height:220px;overflow-y:auto;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:#f8fafc">${dayBlocks}</div>
    <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Tap a slot to fill the date and time below.</div>
  `;
};

window._spvFillSlot = function(date, time) {
  const d = document.getElementById('spv-date');
  const t = document.getElementById('spv-time');
  if(d) d.value = date;
  if(t) t.value = time;
};

// Whenever Nicole edits the surgery date, clamp the pre-op visit date picker
// so it can't be on or after surgery. If the existing visit date is now
// invalid, blank it so she's forced to repick from Jordan's open slots.
window._spvSyncSurgeryDate = function() {
  const surgEl = document.getElementById('spv-surgery-date');
  const visitEl = document.getElementById('spv-date');
  if(!surgEl || !visitEl) return;
  const surg = surgEl.value;
  if(!surg) { visitEl.removeAttribute('max'); return; }
  // max attribute on a date input is inclusive, so subtract one day.
  const d = new Date(surg + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  const maxIso = d.toISOString().split('T')[0];
  visitEl.max = maxIso;
  if(visitEl.value && visitEl.value >= surg) visitEl.value = '';
};

window._spvSetCrna = function(w) {
  window._spvCrna = (w === 'dev') ? 'dev' : 'josh';
  const jb = document.getElementById('spv-josh');
  const db_ = document.getElementById('spv-dev');
  if(jb) jb.className = 'worker-btn' + (window._spvCrna === 'josh' ? ' active-josh' : '');
  if(db_) db_.className = 'worker-btn' + (window._spvCrna === 'dev' ? ' active-dev' : '');
  window._spvRefreshPreview();
};

// Patient-facing confirmation email — no payment link, just confirms the
// pre-op visit time with Jordan. Card info is handled separately by phone.
function _spvBuildEmailHTML() {
  const $ = id => document.getElementById(id);
  // Patient first name + the tracker entry id (used as the portal token).
  const first    = (window._spvEntry?.patientFirst) || '';
  const entryId  = window._spvEntryId || (window._spvEntry?.id) || '';
  const note  = $('spv-note')?.value.trim() || '';
  const crna  = window._spvCrna || 'josh';
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Unique per-patient portal link — three steps: upload airway photos,
  // pay the $100 fee, pick a time with Jordan.
  const portalUrl = 'https://atlas-anesthesia.github.io/atlas-tracker/schedule.html?t=' + encodeURIComponent(entryId);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <tr><td style="background:#1d3557;padding:22px 28px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Atlas Anesthesia · Pre-Op Visit</div><div style="font-size:20px;font-weight:700;color:#fff">Your Pre-Op Patient Portal</div></td></tr>
      <tr><td style="padding:24px 28px;font-size:14px;color:#1e293b;line-height:1.6">
        <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0f172a">Hi${first ? ' ' + esc(first) : ' there'},</p>
        <p style="margin:0 0 14px">Thanks for your time on the phone. Use your <strong>personal patient portal</strong> below — it has three quick steps:</p>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin:18px 0">
          <div style="font-size:13px;color:#1e293b;line-height:1.7">
            <div><strong>1.</strong> Upload 6 short airway photos (we'll guide you through each angle).</div>
            <div><strong>2.</strong> Pay the $100 pre-op clearance fee (secure Stripe checkout).</div>
            <div><strong>3.</strong> Pick a time for your pre-op call with our nurse practitioner <strong>Jordan, APRN, FNP</strong>.</div>
          </div>
        </div>
        <div style="text-align:center;margin:22px 0">
          <a href="${portalUrl}" style="display:inline-block;background:#1d3557;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:600">Open My Patient Portal →</a>
        </div>
        <p style="margin:14px 0 0;font-size:13px;color:#475569">Jordan, APRN, FNP will call you from a <strong>317 area code</strong> at the time you choose. Please have your medical history and a current medication list handy for the call.</p>
        <p style="margin:10px 0 0;font-size:13px;color:#475569">After your clearance, ${crna === 'josh' ? 'Joshua Condado, CRNA' : 'Devarsh Murthy, CRNA'} will follow up separately to walk through your anesthesia plan.</p>
        ${note ? `<div style="background:#f1f5f9;border-left:3px solid #1d3557;padding:10px 14px;margin-top:18px;font-size:13px;color:#1e293b;line-height:1.5">${esc(note).replace(/\n/g,'<br>')}</div>` : ''}
        <p style="margin:18px 0 0">If you need to reschedule or have questions before the visit, just reply to this email.</p>
        <p style="margin:14px 0 0">Talk soon,<br><strong>Atlas Anesthesia</strong></p>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0"><div style="font-size:11px;color:#94a3b8;text-align:center">This link is unique to you — please don't share it.</div></td></tr>
    </table></td></tr></table></body></html>`;
}

window._spvRefreshPreview = function() {
  const iframe = document.getElementById('spv-preview-iframe');
  if(!iframe) return;
  const html = _spvBuildEmailHTML();
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if(!doc) return;
  doc.open(); doc.write(html); doc.close();
};

window._spvTogglePreview = function() {
  const box = document.getElementById('spv-preview-box');
  const btn = document.getElementById('spv-preview-toggle');
  if(!box || !btn) return;
  const isOpen = box.style.display !== 'none';
  if(isOpen) { box.style.display = 'none'; btn.textContent = '👁 Show preview'; }
  else       { box.style.display = '';     btn.textContent = '🔼 Hide preview'; window._spvRefreshPreview(); }
};

// Internal notification email sent to Jordan whenever Nicole books a new
// pre-op visit. Includes patient contact info + surgery + visit times so
// Jordan can plan her clearance call.
function _spvBuildJordanNotificationHTML(p) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmtDate = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }) : '—';
  const fmtTime = t => t ? new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '';
  const fullName = [p.first, p.last].filter(Boolean).join(' ') || 'New patient';
  const crnaName = p.crna === 'dev' ? 'Devarsh Murthy, CRNA' : 'Joshua Condado, CRNA';
  const row = (label, val) => val ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:160px">${esc(label)}</td><td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:500">${val}</td></tr>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <tr><td style="background:#1d3557;padding:22px 28px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Atlas Anesthesia · Internal</div><div style="font-size:20px;font-weight:700;color:#fff">New pre-op visit scheduled</div></td></tr>
      <tr><td style="padding:24px 28px;font-size:14px;color:#1e293b;line-height:1.6">
        <p style="margin:0 0 14px;font-size:16px;font-weight:600">Hi Jordan, APRN, FNP,</p>
        <p style="margin:0 0 18px">Nicole just scheduled a new pre-op clearance visit. Here are the details — please reach out to the patient for the clearance call before surgery.</p>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 18px">
          ${row('Patient', esc(fullName))}
          ${row('Email', esc(p.email))}
          ${row('Phone', esc(p.phone))}
          ${row('PCP', esc(p.pcp))}
          ${row('Surgery', esc(fmtDate(p.surgeryDate)) + (p.surgeryTime ? ' · ' + esc(fmtTime(p.surgeryTime)) : ''))}
          ${row('Pre-op visit', esc(fmtDate(p.visitDate)) + (p.visitTime ? ' · ' + esc(fmtTime(p.visitTime)) : ''))}
          ${row('CRNA on case', esc(crnaName))}
        </table>
        ${p.note ? `<div style="background:#f1f5f9;border-left:3px solid #1d3557;padding:10px 14px;font-size:13px;color:#1e293b;line-height:1.5;margin:0 0 18px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:4px">Note from Nicole</div>${esc(p.note).replace(/\n/g,'<br>')}</div>` : ''}
        <p style="margin:0;font-size:13px;color:#64748b">A pre-op case has already been created in Atlas Tracker and tagged for your review. Open it from the Mid-Case list when you're ready.</p>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0"><div style="font-size:11px;color:#94a3b8;text-align:center">Sent by Atlas Tracker — this is an internal notification, no patient action required.</div></td></tr>
    </table></td></tr></table></body></html>`;
}

window._spvSend = async function() {
  const $ = id => document.getElementById(id);
  const entryId = window._spvEntryId;
  const entry = window._spvEntry;
  if(!entryId || !entry) { alert('Tracker entry not loaded — close the modal and try again.'); return; }
  // Locked fields come straight from the Tracker entry.
  const first = entry.patientFirst || '';
  const last  = entry.patientLast || '';
  const phone = entry.patientPhone || '';
  const pcp   = entry.pcp || '';
  const pcpPhone = entry.pcpPhone || '';
  const pcpFax   = entry.pcpFax   || '';
  const dob   = entry.patientDOB || '';
  const surgeon = entry.surgeon || '';
  const surgeryDate = entry.surgeryDate || '';
  const surgeryTime = entry.surgeryTime || '';
  // Editable fields.
  const email = $('spv-email')?.value.trim() || '';
  const date  = $('spv-date')?.value || '';
  const time  = $('spv-time')?.value || '';
  const note  = $('spv-note')?.value.trim() || '';
  const status = $('spv-status');
  const btn = $('spv-send-btn');
  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('Valid patient email required (a confirmation will be sent there).'); return; }
  if(!surgeryDate) { alert('Surgery date is missing on the Tracker entry — edit the patient first.'); return; }
  const todayIso = new Date().toISOString().split('T')[0];
  if(surgeryDate < todayIso) { alert('Surgery date is in the past — fix it on the Tracker first.'); return; }
  // Visit date/time are now picked by the patient via the self-scheduling
  // portal, so we don't require them here. They get stamped on the entry
  // when the patient confirms their slot.
  btn.disabled = true; btn.textContent = 'Sending...';
  if(status) { status.textContent = ''; status.style.color = ''; }
  const crna = window._spvCrna || 'josh';
  const patientLabel = [first, last].filter(Boolean).join(' ');
  const html = _spvBuildEmailHTML();
  try {
    // Send the patient confirmation email FIRST. If this fails the booking
    // doesn't go through — Nicole can fix the email and retry.
    const visitEmailUrl = 'https://atlas-reminder.blue-disk-9b10.workers.dev/preop-visit-email';
    const res = await fetch(visitEmailUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: email, patientName: patientLabel, crna, html })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok || !data.success) throw new Error(data.error || 'send failed');

    // Stamp the existing Tracker entry — don't create a new one. The entry
    // started as a "pending" patient and is now marked scheduled.
    try {
      if(typeof window._strUpdateEntry === 'function') {
        // Sending the portal email means Nicole has just spoken with the
        // patient — auto-flip the "Nicole's Call" pill to Called so she
        // doesn't have to remember to tap it separately. Pre-op visit
        // date/time are NOT stamped here anymore; the patient picks them
        // on the portal once they've paid.
        const patch = {
          patientEmail: email,
          note,
          crna,
          callStatus: 'called',
          callStatusAt: new Date().toISOString(),
          callStatusBy: (currentUser?.email) || ''
        };
        await window._strUpdateEntry(entryId, patch);
        // Also mirror onto the linked pre-op record so Josh/Dev's Follow-up
        // Tracker stays in agreement with the Tracker pill.
        try {
          const entry = (typeof window._strGetEntry === 'function') ? window._strGetEntry(entryId) : null;
          let preopId = entry?.preopRecordId || '';
          if(!preopId) {
            const recs = window._rawPreopRecords || [];
            const match = recs.find(r => r && r['po-preopVisitId'] === entryId);
            if(match) preopId = match.id;
          }
          if(preopId && typeof window._updatePreopStatusField === 'function') {
            await window._updatePreopStatusField(preopId, 'po-callStatus', 'spoken');
          }
        } catch(_){}
      }
    } catch(e) { console.warn('Could not update tracker entry:', e); }

    // Auto-create a pre-op case for Josh/Dev pre-filled with what Nicole knows,
    // tagged "to review by Nicole" so the CRNA sees who created it and that
    // Jordan still needs to do the clearance.
    try {
      const preSnap = await getDoc(doc(db, 'atlas', 'preop'));
      const existing = preSnap.exists() ? (preSnap.data().records || []) : [];
      window._cachedPreopRecords = existing;
      const newCaseId = generateCaseId(crna, surgeryDate);
      const newRecordId = uid ? uid() : Math.random().toString(36).slice(2,11);
      // Pull surgery center details so the auto-created record also pre-fills
      // the Dentist Office Address from whatever Josh/Dev set up in the
      // Surgery Centers tab.
      const _scForEntry = (window.surgeryCenters || []).find(c => c.id === entry.surgeryCenterId);
      const newRecord = {
        id: newRecordId,
        worker: crna,
        savedAt: new Date().toISOString(),
        createdBy: 'nicole',
        'po-reviewStatus': 'by-nicole',
        'po-caseId': newCaseId,
        'po-surgeryDate': surgeryDate,
        'po-startTime': surgeryTime || '',
        'po-surgery-center': entry.surgeryCenterId || '',
        'po-provider': surgeon,                          // Dentist (surgeon from inbox modal)
        'po-officeAddress': _scForEntry?.address || '',  // Office address from surgery center setup
        'po-patientFirstName': first,
        'po-patientLastName': last,
        'po-patientDOB': dob,
        'po-patientEmail': email,
        'po-patientPhone': phone,
        'po-pcp-name': pcp,
        'po-pcp-phone': pcpPhone,
        'po-pcp-fax':   pcpFax,
        'po-preopVisitId': entryId,
        'po-preopVisitDate': date,
        'po-preopVisitTime': time
      };
      existing.unshift(newRecord);
      await savePreopRecords(existing);
      // Stamp the tracker entry with a pointer to the new pre-op so Jordan's
      // "Open Pre-Op" button on the Tracker row can jump straight to it.
      try {
        if(typeof window._strUpdateEntry === 'function') {
          await window._strUpdateEntry(entryId, {
            preopRecordId: newRecordId,
            preopCaseId: newCaseId
          });
        }
      } catch(_) {}
      try { logAudit && logAudit('preop-autocreated-by-nicole', newCaseId, patientLabel); } catch(e){}
    } catch(e) { console.warn('Could not auto-create pre-op case:', e); }

    try { logAudit && logAudit('preop-visit-scheduled', '', patientLabel + ' @ ' + (date||'?') + ' / ' + crna); } catch(e){}

    // Internal notification — admin only. Jordan deliberately NOT notified
    // here because there's no scheduled time yet at this stage: Nicole has
    // only sent the portal link, the patient hasn't picked a slot. Jordan
    // gets his "Pre-Op Call Confirmed" email later, from patient-schedule.js,
    // the moment the patient confirms a time on the portal.
    try {
      const jordanHtml = _spvBuildJordanNotificationHTML({
        first, last, email, phone, pcp,
        surgeryDate, surgeryTime,
        visitDate: date, visitTime: time,
        crna, note
      });
      const internalSubject = 'Portal link sent — ' + (patientLabel || 'patient');
      fetch('https://atlas-reminder.blue-disk-9b10.workers.dev/outreach-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'admin@atlasanesthesia.co', subject: internalSubject, html: jordanHtml })
      }).catch(() => {});
    } catch(e) { console.warn('Internal booking notifications skipped:', e); }

    if(status) { status.textContent = '✓ Visit booked. Confirmation emailed to ' + email + '.'; status.style.color = '#166534'; }
    setTimeout(() => { document.getElementById('schedulePreopVisitModal')?.remove(); if(window.buildCalendar) window.buildCalendar(); }, 1500);
  } catch(err) {
    if(status) { status.textContent = '✗ ' + (err.message || err); status.style.color = '#b91c1c'; }
    btn.disabled = false; btn.textContent = '📧 Book & Send Confirmation';
  }
};

// Assistant picks which CRNA a pre-op is assigned to (since they aren't one).
// Defaults to 'josh'. Stored on window so savePreop can read it.
window._assistantCrna = 'josh';
window._assistantSetCrna = function(w) {
  window._assistantCrna = (w === 'dev') ? 'dev' : 'josh';
  const jb = document.getElementById('po-assign-josh');
  const db_ = document.getElementById('po-assign-dev');
  if(jb) jb.className = 'worker-btn' + (window._assistantCrna === 'josh' ? ' active-josh' : '');
  if(db_) db_.className = 'worker-btn' + (window._assistantCrna === 'dev' ? ' active-dev' : '');
  // Re-roll the Case-ID preview so it tracks whichever CRNA the assistant
  // is about to assign the case to.
  if(typeof window.updatePreopCaseIdDisplay === 'function') window.updatePreopCaseIdDisplay();
};

onAuthStateChanged(auth, async (user) => {
document.getElementById('loadingScreen').style.display='none';
if(user) {
const isNewLogin = !currentUser;
// Snapshot the saved tab BEFORE any showTab() call clobbers localStorage.
// On a hard refresh, Firebase auth restores the session and isNewLogin
// fires (currentUser is module-scoped and reset by the page load), so without
// this snapshot the "land on Home" block below would overwrite the user's
// last active tab.
const _savedTabSnapshot = window.location.hash.replace('#','').trim() || localStorage.getItem('atlas_active_tab') || '';
currentUser = user;
if(isNewLogin) {
  try { logAudit('login'); } catch(e){}
}
resetInactivityTimer();
document.getElementById('loginScreen').style.display='none';
document.getElementById('appScreen').style.display='block';
// Always land on Home (Dashboard) when logging in — but skip when a saved
// tab exists (i.e. on a hard refresh restoring a Firebase session).
if(isNewLogin) {
  if(!_savedTabSnapshot) {
    try { showTab('home'); if(typeof renderDashboard === 'function') renderDashboard(); } catch(e){}
  }
  // Start checking for app updates so Dev/Josh see a banner if a new version is deployed
  try { _startUpdateChecker(); } catch(e){}
  // Show today's follow-ups / overdue reminders as a notification panel
  try { if(typeof showLoginNotifications === 'function') showLoginNotifications(); } catch(e){}
}
// Determine role (crna vs assistant) — drives what the user can see.
window._userRole = getUserRole(user.email);
// Auto-set worker based on email
const mappedWorker = EMAIL_WORKER_MAP[user.email.toLowerCase()] || 'dev';
currentWorker = mappedWorker;
currentInvTab = mappedWorker;
// Lock worker toggle to their own account
const wbtnDev = document.getElementById('wbtn-dev');
const wbtnJosh = document.getElementById('wbtn-josh');
if(mappedWorker === 'dev') {
wbtnDev.className = 'worker-btn active-dev';
wbtnJosh.className = 'worker-btn';
wbtnJosh.disabled = true;
wbtnJosh.style.opacity = '0.35';
wbtnJosh.style.cursor = 'not-allowed';
wbtnJosh.title = 'You can only log cases for your own inventory';
} else {
wbtnJosh.className = 'worker-btn active-josh';
wbtnDev.className = 'worker-btn';
wbtnDev.disabled = true;
wbtnDev.style.opacity = '0.35';
wbtnDev.style.cursor = 'not-allowed';
wbtnDev.title = 'You can only log cases for your own inventory';
}
const ind = document.getElementById('workerIndicator');
ind.className = 'worker-pill ' + (mappedWorker==='dev' ? 'pill-dev' : 'pill-josh');
ind.textContent = (mappedWorker==='dev' ? 'Devarsh' : 'Josh') + "'s inventory will be updated";
// Footer city — Josh works out of Fox Valley, Dev out of Stevens Point.
const _brandCityEl = document.getElementById('branding-city');
if(_brandCityEl) _brandCityEl.textContent = mappedWorker === 'josh' ? 'Fox Valley, WI' : 'Stevens Point, WI';
// Default inventory tab to their own
['dev','josh','combined'].forEach(x => document.getElementById('itab-'+x).classList.toggle('active', x===mappedWorker));
document.getElementById('userLabel').textContent = getUserDisplayName(user.email, window._userRole);
// Show payout tab only for Josh (now lives inside the Setup dropdown)
const payoutNavBtn = document.getElementById('subnav-payout');
if(payoutNavBtn) payoutNavBtn.style.display = '';
// Apply role-based UI restrictions (assistant = pre-op only)
try { applyRoleRestrictions(window._userRole); } catch(e) { console.warn('applyRoleRestrictions:', e); }
// Default Case Log, CS Log, and Case History to logged-in user's perspective
currentCaseLogTab = mappedWorker;
['dev','josh'].forEach(x => { const el=document.getElementById('cltab-'+x); if(el) el.classList.toggle('active', x===mappedWorker); });
document.getElementById('caselog-dev').style.display = mappedWorker==='dev' ? '' : 'none';
document.getElementById('caselog-josh').style.display = mappedWorker==='josh' ? '' : 'none';
// Default Case History filter to "All" for Jordan/Nicole so they see cases
// from BOTH CRNAs by default. Josh and Devarsh still land on their own
// perspective.
currentHistoryFilter = (window._userRole === 'assistant' || window._userRole === 'scheduler') ? 'all' : mappedWorker;
['all','dev','josh'].forEach(x => { const el=document.getElementById('hbtn-'+x); if(el) el.className='worker-btn'+(x===currentHistoryFilter?(currentHistoryFilter==='all'?' active':' '+(currentHistoryFilter==='dev'?'active-dev':'active-josh')):''); });
if(currentHistoryFilter !== 'all') document.getElementById('hbtn-all').className = 'worker-btn';
{ const _dd = document.getElementById('dateDisplay'); if(_dd) _dd.textContent = new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'}); }
document.getElementById('caseDate').value = todayStr();
await initData();
updateCaseIdDisplays();
renderCSEntries();
updatePreopCaseIdDisplay();
refreshDraftPicker();
loadSavedInvoices();
setInvoiceProvider();
setTimeout(wireEKGDetection, 600);
loadSurgeryCenters();
loadAtlasFormula(); // pre-load PI formula at startup
// Restore last active tab — uses the snapshot captured at the top of the
// auth handler so a hard refresh keeps the user on whatever tab they were on.
const _savedTab = _savedTabSnapshot || 'preop';
showTab(_savedTab, false);
// Restore Surgery Mode if it was active before a page reload (iPad sleep,
// network blip, etc.). Without this, the inactivity timer would resume and
// log the user out 20 min later — mid-case.
try {
  if(localStorage.getItem('atlas_surgery_mode') === '1' && !window._surgeryModeActive) {
    setTimeout(() => { try { window.toggleSurgeryMode(); } catch(e){} }, 800);
  }
} catch(e) {}
// Re-apply after data loads (onSnapshot can briefly re-render UI)
[500, 1000, 2000].forEach(ms => setTimeout(() => {
  const active = document.querySelector('.section.active');
  if(active && active.id !== 'tab-' + _savedTab) showTab(_savedTab, false);
}, ms));
// Pre-warm calendar data
setTimeout(() => {
if(window.buildCalendar) window.buildCalendar();
}, 2000);
} else {
if(currentUser) {
  try { logAudit('logout'); } catch(e){}
}
currentUser = null;
clearTimeout(_inactivityTimer);
clearTimeout(_inactivityWarnTimer);
_hideInactivityWarning();
document.getElementById('loginScreen').style.display='flex';
document.getElementById('appScreen').style.display='none';
}
});
// -- FIRESTORE INIT --
async function initData() {
// Listen to items in real time

// -- Global refresh — called after any data mutation to sync all views --------
window._globalRefresh = function() {
  renderHistory();
  renderReports();
  renderCaseLog();
  renderMidCase();
  refreshDraftPicker();
  // Refresh E&D if open (recalculates personal income with updated cases)
  if(document.getElementById('tab-payout')?.classList.contains('active')) {
    renderPayoutTab();
  }
  if(document.getElementById('tab-calendar')?.classList.contains('active')) {
    setTimeout(buildCalendar, 100);
  }
  if(document.getElementById('tab-payments')?.classList.contains('active') && typeof loadPaymentRows==='function') {
    loadPaymentRows();
  }
  if(document.getElementById('tab-saved-pdfs')?.classList.contains('active') && typeof loadSavedPDFs==='function') {
    loadSavedPDFs();
  }
  if(document.getElementById('tab-preop-history')?.classList.contains('active')) {
    renderPreopHistory();
  }
};
onSnapshot(doc(db,'atlas','inventory'), (snap) => {
if(snap.exists()) {
items = snap.data().items || [];
} else {
// First time — seed with template
items = ITEM_TEMPLATE.map(t => ({...t}));
setDoc(doc(db,'atlas','inventory'), {items});
}
// One-time normalization: older items may have devStock/joshStock from the
// original ITEM_TEMPLATE before names were unified. Copy any old values
// onto the canonical stockDev/stockJosh keys and drop the old ones. If the
// canonical key already exists, keep it (already correct).
let migrated = 0;
items.forEach(it => {
  if(it.devStock !== undefined) {
    if(it.stockDev === undefined) it.stockDev = it.devStock;
    delete it.devStock;
    migrated++;
  }
  if(it.joshStock !== undefined) {
    if(it.stockJosh === undefined) it.stockJosh = it.joshStock;
    delete it.joshStock;
    migrated++;
  }
});
if(migrated > 0) {
  console.log(`Inventory normalization: migrated ${migrated} old field name(s) to stockDev/stockJosh`);
  setDoc(doc(db,'atlas','inventory'), {items}).catch(()=>{});
}
linkCSInvIds();
refreshItemSelect();
renderInventory();
renderReports();
});
// Listen to cases in real time
onSnapshot(doc(db,'atlas','cases'), async (snap) => {
if(snap.exists()) {
const data = snap.data();
if(data.format === 'monthly-v2' && Array.isArray(data.months)) {
  _casesFormat = 'monthly-v2';
  const snaps = await Promise.all(data.months.map(m => getDoc(doc(db,'atlas','cases_'+m))));
  cases = snaps.flatMap(s => s.exists() ? (s.data().cases || []) : []);
} else {
  _casesFormat = 'legacy';
  cases = data.cases || [];
}
  // Photos live in their own docs now — re-attach dataUrls before any
  // render runs. Cache hits skip the network entirely.
  await _hydrateCasePhotos(cases);
  const beforeLen = cases.length;
  deduplicateCases();
  // After replacing `cases`, repoint the live-case draft reference so the
  // Add Supplies / Add CS flows mutate the CURRENT in-array object rather
  // than a stale orphan that won't get persisted on the next saveCases().
  if(window._currentLiveCaseDraft) {
    const refreshed = cases.find(c => c.id === window._currentLiveCaseDraft.id);
    if(refreshed) window._currentLiveCaseDraft = refreshed;
  }
  // If dedup removed entries, save cleaned data back to Firestore immediately
  if(cases.length < beforeLen) {
    _saveAllCases(cases).catch(()=>{});
    console.log('Auto-cleaned', beforeLen - cases.length, 'duplicate case(s) from database');
  }
} else {
_casesFormat = 'legacy';
cases = [];
}
// Pre-load preop records for calendar (store raw separately)
getDoc(doc(db,'atlas','preop')).then(ps => {
window._rawPreopRecords = ps.exists() ? (ps.data().records||[]) : [];
window._cachedPreopRecords = [...(window._rawPreopRecords||[])];
// Refresh dashboard now that preop data is loaded
if(typeof renderDashboard === 'function') renderDashboard();
}).catch(()=>{});
// Update was from Firestore — refresh all dependent views
if(typeof _globalRefresh === 'function') {
  _globalRefresh();
} else {
  renderHistory();
  renderReports();
  refreshDraftPicker();
  renderCaseLog();
  renderMidCase();
}
// Refresh dashboard with the freshly loaded cases
if(typeof renderDashboard === 'function') renderDashboard();
// Refresh calendar if open
if(document.getElementById('tab-calendar')?.classList.contains('active')) {
  setTimeout(buildCalendar, 100);
}
});

// Listen for preop changes (real-time sync between users)
onSnapshot(doc(db,'atlas','preop'), (snap) => {
  let records = snap.exists() ? (snap.data().records||[]) : [];
  // Auto-clean any duplicates that slipped in (mirrors the cases onSnapshot pattern)
  const beforeLen = records.length;
  const cleaned = deduplicatePreop(records);
  if(cleaned.length < beforeLen) {
    setDoc(doc(db,'atlas','preop'), {records: cleaned}).catch(()=>{});
    console.log('Auto-cleaned', beforeLen - cleaned.length, 'duplicate preop record(s) from database');
    records = cleaned;
  }
  window._rawPreopRecords = records;
  window._cachedPreopRecords = [...records];
  // Re-render tabs that depend on preop data
  const activeTab = document.querySelector('.section.active')?.id?.replace('tab-','');
  if(activeTab === 'preop-history') renderPreopHistory();
  if(activeTab === 'mid-case') renderMidCase();
  if(activeTab === 'history') renderHistory();
  if(activeTab === 'caselog') renderCaseLog();
  // Sync payment rows if loaded
  if(typeof _paymentRows !== 'undefined' && _paymentRows.length > 0) syncPaymentRowsFromCases();
});

// Tracker entries (atlas/preop_visits) — surfaced to window so the Home-tab
// Follow-up Tracker can cross-reference Jordan's "Call Made" pill state when
// a pre-op record's po-callStatus hasn't been synced yet.
onSnapshot(doc(db,'atlas','preop_visits'), (snap) => {
  window._preopVisitEntries = snap.exists() ? (snap.data().entries || []) : [];
  // Refresh the Home Follow-up Tracker if it's the active tab so its call
  // column updates live when Nicole / Jordan flip a pill.
  const activeTab = document.querySelector('.section.active')?.id?.replace('tab-','');
  if(activeTab === 'home' && typeof renderFollowupTab === 'function') renderFollowupTab();
});

// Effective call status — combines what's on the pre-op record with what
// Nicole AND Jordan logged on the Tracker. Either pill marking the call as
// successful is treated as "spoken" so the Home Follow-up Tracker stays in
// agreement with what Nicole/Jordan see on their screens.
window._effectiveCallStatus = function(preopRecord) {
  if(!preopRecord) return 'not-called';
  const fromRecord = preopRecord['po-callStatus'] || 'not-called';
  if(fromRecord === 'spoken') return 'spoken';
  const entries = window._preopVisitEntries || [];
  // Match by preopRecordId (newer entries) OR po-preopVisitId on the record.
  const visit = entries.find(e =>
    (preopRecord.id && e.preopRecordId === preopRecord.id) ||
    (preopRecord['po-preopVisitId'] && e.id === preopRecord['po-preopVisitId'])
  );
  if(!visit) return fromRecord;
  // Jordan's "Call Made" pill → po-callStatus = 'spoken'
  if(visit.nurseCalledAt) return 'spoken';
  // Nicole's multi-state call pill maps as follows:
  //   'called'    → 'spoken'    (reached patient, scheduled)
  //   'voicemail' → 'voicemail' (left a message)
  //   'failed'    → 'no-answer' (tried but didn't reach)
  //   'none'      → fall through to po-callStatus
  if(visit.callStatus === 'called')    return 'spoken';
  if(visit.callStatus === 'voicemail') return 'voicemail';
  if(visit.callStatus === 'failed')    return 'no-answer';
  return fromRecord;
};
}
async function saveInventory() {
setSyncing(true);
const safeItems = sanitizeForFirestore(items) || [];
try {
  await setDoc(doc(db,'atlas','inventory'),{items: safeItems});
} catch(err) {
  setSyncing(false);
  if(typeof window.atlasError === 'function') {
    window.atlasError('INV-001', err.message || String(err));
  }
  throw err;
}
// Verify the write actually persisted by reading back. Catches the case
// where setDoc resolves locally (offline cache) but the server never
// received it — user would think they saved, then lose their changes when
// the snapshot caught up to the real server state.
try {
  const verify = await getDoc(doc(db,'atlas','inventory'));
  const persistedCount = verify.exists() ? (verify.data().items || []).length : 0;
  if(persistedCount !== safeItems.length) {
    if(typeof window.atlasError === 'function') {
      window.atlasError('INV-002', `Expected ${safeItems.length} items, server has ${persistedCount}.`);
    }
  } else {
    try { logAudit('inventory-save-ok', '', `${safeItems.length} items by ` + (currentWorker || 'unknown')); } catch(e){}
  }
} catch(verifyErr) {
  console.warn('Inventory save verification skipped:', verifyErr);
}
setSyncing(false);
}

// -- Deduplication — ensures no two cases share the same caseId ---------------
// Keeps the finalized (non-draft) version if one exists, otherwise most recent
function deduplicateCases() {
  const seen = new Map();
  cases.forEach(c => {
    // Use caseId as key — cases with same caseId AND different startTime
    // are truly different cases, so include startTime in the key
    const key = c.caseId;
    if(!key) return;
    if(!seen.has(key)) {
      seen.set(key, c);
    } else {
      const existing = seen.get(key);
      // Prefer finalized over draft
      if(existing.draft && !c.draft) { seen.set(key, c); return; }
      if(!existing.draft && c.draft) { return; } // keep existing finalized
      // Both same type — keep most recently saved
      const existingTime = existing.savedAt || existing.date || '';
      const newTime = c.savedAt || c.date || '';
      if(newTime > existingTime) seen.set(key, c);
    }
  });
  const deduped = Array.from(seen.values());
  if(deduped.length !== cases.length) {
    console.log(`Dedup: removed ${cases.length - deduped.length} duplicate case(s)`);
    cases = deduped;
  }
}
// -- Deduplication — ensures no two pre-op records share the same caseId+worker.
// Mirrors deduplicateCases. Called automatically by savePreopRecords on every
// preop write so all paths (savePreop, edit, delete, deposit/notes updates,
// cleanup, etc.) get protection without each having to dedup itself.
function deduplicatePreop(records) {
  const seen = new Map();
  const noKey = []; // records missing caseId — preserved as-is
  (records || []).forEach(r => {
    const cid = r && r['po-caseId'];
    if(!cid) { noKey.push(r); return; }
    const key = cid + '|' + (r.worker || 'dev');
    const existing = seen.get(key);
    if(!existing || (r.savedAt || '') > (existing.savedAt || '')) {
      seen.set(key, r);
    }
  });
  return [...Array.from(seen.values()), ...noKey];
}
async function savePreopRecords(records) {
  const cleaned = deduplicatePreop(records);
  const removed = (records||[]).length - cleaned.length;
  if(removed > 0) console.log(`Preop dedup: removed ${removed} duplicate(s) on save`);
  await setDoc(doc(db,'atlas','preop'), { records: cleaned });
  return cleaned;
}
// Clean a value so Firestore will accept it. Firestore rejects:
//   - arrays as direct elements of another array (e.g. [[1,2],[3,4]])
//   - undefined values
//   - NaN / Infinity
//   - functions, symbols, DOM nodes, class instances
// Converts a raw array-in-array to {values:[...]} so the data is preserved.
function sanitizeForFirestore(value, _inArray = false) {
  if(value === undefined) return _inArray ? null : undefined;
  if(value === null) return null;
  if(typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if(typeof value === 'string' || typeof value === 'boolean') return value;
  if(value instanceof Date) return value.toISOString();
  if(Array.isArray(value)) {
    return value.map(item => {
      if(Array.isArray(item)) {
        // Wrap nested arrays in an object so Firestore accepts them.
        console.warn('Sanitizer: wrapped nested array');
        return { values: item.map(v => sanitizeForFirestore(v, true)) };
      }
      return sanitizeForFirestore(item, true);
    });
  }
  if(typeof value === 'object') {
    // Skip non-POJOs (DOM nodes, class instances, etc.) — drop or stringify
    const proto = Object.getPrototypeOf(value);
    if(proto !== Object.prototype && proto !== null) {
      console.warn('Sanitizer: dropped non-plain object', value);
      return null;
    }
    const out = {};
    Object.keys(value).forEach(k => {
      const v = sanitizeForFirestore(value[k], false);
      if(v !== undefined) out[k] = v;
    });
    return out;
  }
  // functions, symbols, etc.
  return null;
}
async function saveCases() {
deduplicateCases();
setSyncing(true);
// JSON round-trip strips undefined, functions, Dates → strings, etc.
// Then run the array sanitizer to wrap any nested arrays Firestore would reject.
let safeCases;
try {
  safeCases = JSON.parse(JSON.stringify(cases));
} catch(e) {
  console.warn('Cases JSON clone failed:', e);
  safeCases = cases;
}
safeCases = sanitizeForFirestore(safeCases) || [];
try {
  await _saveAllCases(safeCases);
} catch(setErr) {
  // Log the actual cases payload so we can identify the offending field in dev tools.
  console.error('saveCases setDoc failed:', setErr);
  console.error('Cases count:', safeCases.length, 'Cases payload:', safeCases);
  setSyncing(false);
  if(typeof window.atlasError === 'function') {
    window.atlasError('CASE-001', setErr.message || String(setErr));
  }
  throw setErr;
}
// CASE-002 verification: read back to confirm the write actually persisted.
// This is the critical guard against "I saved supplies but they're gone."
try {
  const persisted = await _loadAllCases();
  const persistedById = new Map(persisted.map(c => [c.id, c]));
  let mismatches = 0;
  let detail = '';
  for(const c of safeCases) {
    const p = persistedById.get(c.id);
    if(!p) { mismatches++; detail += `\n• ${c.caseId||c.id}: NOT FOUND on server`; continue; }
    const localItems = (c.items||[]).length;
    const serverItems = (p.items||[]).length;
    if(localItems !== serverItems) {
      mismatches++;
      detail += `\n• ${c.caseId||c.id}: local has ${localItems} supplies, server has ${serverItems}`;
    }
  }
  if(mismatches > 0) {
    if(typeof window.atlasError === 'function') {
      window.atlasError('CASE-002', `${mismatches} case(s) mismatch:${detail}\n\nDO NOT close the app — refresh and check the affected case. If supplies are missing, re-enter them.`);
    }
  } else {
    try { logAudit('cases-save-ok', '', `${safeCases.length} cases verified persisted`); } catch(e){}
  }
} catch(verifyErr) {
  console.warn('Cases save verification skipped:', verifyErr);
}
setSyncing(false);
// onSnapshot fires automatically and calls _globalRefresh indirectly,
// but sync payments immediately if loaded
if(typeof _paymentRows !== 'undefined' && _paymentRows.length > 0) {
  syncPaymentRowsFromCases();
}
}
// -- HELPERS --
function getStock(item,w){return w==='dev'?item.stockDev:item.stockJosh;}
function setStock(item,w,val){if(w==='dev')item.stockDev=val;else item.stockJosh=val;}
function uid(){return Math.random().toString(36).substr(2,9);}
function generateCaseId(worker, date) {
const w = worker === 'dev' ? 'DEV' : 'JOSH';
const dateStr = date || todayStr(); // YYYY-MM-DD
const [y, m, d] = dateStr.split('-');
// New format: WORKER-MM-DD-YYYY-NN  (e.g. JOSH-05-04-2026-01)
const newPrefix = `${w}-${m}-${d}-${y}-`;
// Old format: ATL-WORKER-YYYYMMDD-NNN — still recognized so sequence numbers
// don't reset to 01 when old records already exist for this date.
const oldPrefix = `ATL-${w}-${y}${m}${d}-`;
const extractSeq = (id) => {
if (!id) return 0;
if (id.startsWith(newPrefix)) return parseInt(id.slice(newPrefix.length)) || 0;
if (id.startsWith(oldPrefix)) return parseInt(id.slice(oldPrefix.length)) || 0;
return 0;
};
// Count finalized cases (excluding the one being edited)
const existingNums = cases
.filter(c => c.id !== window._editingCaseId)
.map(c => extractSeq(c.caseId));
// Count pre-op records for this date/worker
const preopNums = (window._cachedPreopRecords||[]).map(r => extractSeq(r['po-caseId']));
const allNums = [...existingNums, ...preopNums].filter(n => n > 0);
const maxNum = allNums.length > 0 ? Math.max(...allNums) : 0;
const seq = String(maxNum + 1).padStart(2, '0');
return `${newPrefix}${seq}`;
}
window.updateCaseIdDisplays = function updateCaseIdDisplays() {
const ncDisplay = document.getElementById('caseId-display');
const ncInput = document.getElementById('caseId');
// If editing or resuming a draft, keep the original case ID — never regenerate
const activeId = window._editingCaseId || window._activeDraftId;
if(activeId) {
const c = cases.find(x => x.id === activeId);
if(c && ncDisplay) ncDisplay.textContent = c.caseId;
if(c && ncInput) ncInput.value = c.caseId;
return;
}
const date = document.getElementById('caseDate')?.value || todayStr();
const id = generateCaseId(currentWorker, date);
if(ncDisplay) ncDisplay.textContent = id;
if(ncInput) ncInput.value = id;
}
window.updatePreopCaseIdDisplay = function updatePreopCaseIdDisplay() {
const surgeryDate = document.getElementById('po-surgeryDate')?.value;
const display = document.getElementById('po-caseId-display');
const input = document.getElementById('po-caseId');
// When editing an existing record, keep its original Case ID — never
// regenerate. Otherwise build a fresh preview from the surgery date and
// whichever CRNA the form is currently assigning the case to.
if(window._editingPreopId && input && input.value) {
  if(display) { display.textContent = input.value; display.style.opacity = '1'; display.title = ''; }
  return;
}
// For assistants, the worker comes from the Assign-to-CRNA toggle, not the
// logged-in inventory owner (Jordan isn't a CRNA herself).
const effectiveWorker = (window._userRole === 'assistant')
  ? (window._assistantCrna || 'josh')
  : currentWorker;
const dateToUse = surgeryDate || todayStr();
const id = generateCaseId(effectiveWorker, dateToUse);
if(display) {
  display.textContent = id;
  display.style.opacity = surgeryDate ? '1' : '0.5';
  display.title = surgeryDate ? '' : 'Preview — will update when surgery date is selected';
}
if(input) input.value = id;
}
// -- WORKER / TAB --
window.setWorker = function(w) {
// Prevent switching to the other person's worker
if(currentUser && EMAIL_WORKER_MAP[currentUser.email.toLowerCase()] !== w) {
alert('You can only log cases for your own inventory.');
return;
}
currentWorker=w;
document.getElementById('wbtn-dev').className='worker-btn'+(w==='dev'?' active-dev':'');
document.getElementById('wbtn-josh').className='worker-btn'+(w==='josh'?' active-josh':'');
const ind=document.getElementById('workerIndicator');
ind.className='worker-pill '+(w==='dev'?'pill-dev':'pill-josh');
ind.textContent=(w==='dev'?'Devarsh':'Josh')+"'s inventory will be updated";
if(!window._editingCaseId) { caseItems=[]; renderCaseSupplies(); refreshItemSelect(); }
updateCaseIdDisplays();
updatePreopCaseIdDisplay();
// Mid-Case now filters by currentWorker — refresh both lists when worker changes
if(typeof renderMidCase === 'function') renderMidCase();
if(typeof renderReviewTomorrow === 'function') renderReviewTomorrow();
};
window.setInvTab = function(t) {
currentInvTab=t;
['dev','josh','combined'].forEach(x=>document.getElementById('itab-'+x).classList.toggle('active',x===t));
renderInventory();
};
window.setHistoryFilter = function(f) {
currentHistoryFilter=f;
['all','dev','josh'].forEach(x=>{
const btn=document.getElementById('hbtn-'+x);
btn.style.background=x===f?(x==='dev'?'var(--dev)':x==='josh'?'var(--josh)':'var(--info)'):'';
btn.style.color=x===f?'#fff':'';
});
renderHistory();
};
// -- CALENDAR --
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calFilter = 'all';
window.setCalFilter = function(f) {
calFilter = f;
['all','dev','josh'].forEach(x => {
const btn = document.getElementById('calbtn-'+x);
if(!btn) return;
if(x===f) {
btn.style.background = x==='dev'?'var(--dev)':x==='josh'?'var(--josh)':'var(--info)';
btn.style.color = '#fff';
} else {
btn.style.background = 'transparent';
btn.style.color = 'var(--text-muted)';
}
});
buildCalendar();
};
window.changeMonth = function(dir) {
calMonth += dir;
if(calMonth > 11) { calMonth=0; calYear++; }
if(calMonth < 0) { calMonth=11; calYear--; }
buildCalendar();
};
function getCalEvents() {
// Jordan (assistant) sees only the scheduled pre-op visit calls — her own
// availability windows are managed on the Availability tab, so showing them
// here too would just clutter the view.
if(window._userRole === 'assistant') {
  const out = [];
  const fmtTime = t => t ? new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '';
  const entries = (typeof window._strGetAllEntries === 'function') ? window._strGetAllEntries() : [];
  entries.forEach(e => {
    if(!e.scheduledAt || !e.date) return;
    const name = [e.patientFirst, e.patientLast].filter(Boolean).join(' ') || 'Patient';
    out.push({
      type: 'preop-call',
      date: e.date,
      label: `📞 ${fmtTime(e.time)} · ${name}`,
      worker: 'josh',
      _trackerEntryId: e.id,
      detail: `Call ${name} (${e.patientPhone || 'no phone'}) for pre-op clearance`
    });
  });
  return out;
}
// Nicole (scheduler role) sees Jordan's availability slots (green, clickable)
// + the surgery dates Josh/Dev have on the books (so she avoids double-booking
// pre-op visits onto surgery days). NO preop-call or deposit events — those
// would clutter her view with reminders that aren't hers to act on.
if(window._userRole === 'scheduler') {
  const slots = window._availabilitySlots || {};
  const out = [];
  const fmtTime = t => {
    if(!t) return '';
    try { return new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }); }
    catch(e) { return t; }
  };
  // 1) Availability slots — Jordan converts her times to Central before
  //    entering them, so they display as-is for Nicole (also Central).
  Object.keys(slots).forEach(iso => {
    (slots[iso] || []).forEach(s => {
      out.push({
        type: 'availability',
        date: iso,
        label: `✓ Jordan Available · ${fmtTime(s.start)}–${fmtTime(s.end)}`,
        worker: 'josh',
        _availability: true,
        _slotStart: s.start,
        _slotEnd: s.end
      });
    });
  });
  // 2) Surgery dates from preop records — include start/end time on the label
  //    so Nicole knows when each day's surgeries are booked.
  const records = window._cachedPreopRecords || [];
  const findCase = (cid) => (window.cases || []).find(c => c.caseId === cid && !c.draft) || null;
  records.forEach(r => {
    const surgDate = r['po-surgeryDate'];
    if(!surgDate || surgDate === '—') return;
    const caseId = r['po-caseId'] || '—';
    const worker = r.worker || 'dev';
    // Start time comes from the preop (scheduled). End time only exists on a
    // finalized case record (CRNA enters it after the procedure).
    const startTime = r['po-startTime'] || '';
    const c = findCase(caseId);
    const endTime = c?.endTime || '';
    const start = startTime ? fmtTime(startTime) : '';
    const end   = endTime   ? fmtTime(endTime)   : '';
    let timeTxt = '';
    if(start && end) timeTxt = `${start}–${end} · `;
    else if(start)   timeTxt = `${start} · `;
    out.push({
      type: 'surgery',
      date: surgDate,
      label: `${worker==='josh'?'J':'D'} ${timeTxt}Surgery · ${caseId}`,
      caseId,
      worker,
      surgDate
    });
  });
  return out;
}
try {
const preopDays = parseInt(document.getElementById('cal-preop-days')?.value) || 30;
const depositDays = parseInt(document.getElementById('cal-deposit-days')?.value) || 7;
const records = window._cachedPreopRecords || [];
const events = [];
records.forEach(r => {
try {
// Shared calendar — show all workers' events
const surgDate = r['po-surgeryDate'];
if(!surgDate || surgDate === '—') return;
const caseId = r['po-caseId'] || '—';
const provider = r['po-provider'] || '';
const worker = r.worker || 'dev';
const wname = worker==='dev'?'Devarsh':'Josh';
const email = r['po-patientEmail'] || '';
events.push({ type:'surgery', date:surgDate, label:`${worker==='josh'?'J':'D'} ${caseId}`, caseId, provider:provider||wname, worker, email, surgDate });
const callD = new Date(surgDate+'T12:00:00');
callD.setDate(callD.getDate() - preopDays);
events.push({ type:'preop-call', date:localDateStr(callD), label:`📞 ${worker==='josh'?'J':'D'} ${caseId}`, caseId, provider:provider||wname, worker, email, surgDate });
const depD = new Date(surgDate+'T12:00:00');
depD.setDate(depD.getDate() - depositDays);
events.push({ type:'deposit', date:localDateStr(depD), label:`💰 ${worker==='josh'?'J':'D'} ${caseId}`, caseId, provider:provider||wname, worker, email, surgDate });
} catch(rowErr) { console.warn('Calendar row error:', rowErr); }
});
return events;
} catch(e) {
console.error('getCalEvents error:', e);
return [];
}
}
// FullCalendar instance (lazy-init)
window._fcInstance = null;
function buildCalendar() {
const fcEl = document.getElementById('fullcalendar');
const grid = document.getElementById('cal-grid');
const label = document.getElementById('cal-month-label');
// Merge preop records + finalized cases, strictly deduped by caseId
try {
const preopSnap = window._rawPreopRecords || [];
const caseRecs = (cases||[]).filter(c=>!c.draft&&c.date).map(c=>({
'po-surgeryDate':c.date,'po-caseId':c.caseId,'po-provider':c.provider,
'po-patientEmail':'',worker:c.worker
}));
// Use a Map so each caseId appears exactly once; preop records win
const seen = new Map();
preopSnap.forEach(r => { if(r['po-caseId']) seen.set(r['po-caseId'], r); });
caseRecs.forEach(r => { if(r['po-caseId'] && !seen.has(r['po-caseId'])) seen.set(r['po-caseId'], r); });
window._cachedPreopRecords = Array.from(seen.values());
} catch(e) { console.warn('Calendar merge error:', e); window._cachedPreopRecords = window._cachedPreopRecords||[]; }
const months = ['January','February','March','April','May','June','July',
'August','September','October','November','December'];
if(label) label.textContent = `${months[calMonth]} ${calYear}`;
let events = [];
try { events = getCalEvents(); } catch(e) { console.warn('getCalEvents error', e); }

// ── FullCalendar render path ─────────────────────────────────────────────
if(fcEl && typeof FullCalendar !== 'undefined') {
  // Map our events to FullCalendar format
  const workerColors = {
    josh: { surgery: '#dc2626', 'preop-call': '#ea580c', deposit: '#ca8a04', default: '#b91c1c' },
    dev:  { surgery: '#2563eb', 'preop-call': '#16a34a', deposit: '#9333ea', default: '#1d4ed8' }
  };
  const fcEvents = events.map(e => {
    // Availability events render green regardless of worker.
    if(e._availability) {
      return {
        id: 'avail-' + e.date,
        title: e.label || '✓ Available',
        start: e.date,
        allDay: true,
        backgroundColor: '#16a34a',
        borderColor: '#16a34a',
        textColor: '#fff',
        extendedProps: { _raw: e }
      };
    }
    const w = e.worker === 'josh' ? 'josh' : 'dev';
    const color = (workerColors[w][e.type] || workerColors[w].default);
    return {
      id: e.id || (e.date + '-' + (e.type||'')),
      title: e.label || '',
      start: e.date,
      allDay: true,
      backgroundColor: color,
      borderColor: color,
      textColor: '#fff',
      extendedProps: { _raw: e }
    };
  });
  if(!window._fcInstance) {
    window._fcInstance = new FullCalendar.Calendar(fcEl, {
      initialView: 'dayGridMonth',
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listWeek' },
      buttonText: { today: 'Today', month: 'Month', week: 'Week', list: 'List' },
      height: 'auto',
      dayMaxEvents: 4,
      editable: false, // events are not draggable — dates are fixed
      eventClick: function(info) {
        const raw = info.event.extendedProps._raw;
        // Scheduler clicks an availability event → bounce them to the Tracker
        // since booking now requires a patient row. A toast hint is friendlier
        // than silently doing nothing.
        if(raw && raw._availability && window._userRole === 'scheduler') {
          alert('Open a patient from the Tracker to book this slot.');
          if(typeof showTab === 'function') showTab('scheduler-tracker');
          return;
        }
        if(raw && typeof showCalDetail === 'function') {
          try { showCalDetail(raw); } catch(e){}
        }
      }
    });
    window._fcInstance.render();
  }
  // Update events
  window._fcInstance.removeAllEvents();
  fcEvents.forEach(e => window._fcInstance.addEvent(e));
  return; // Skip the legacy grid render
}

// Legacy grid (fallback if FullCalendar not loaded)
if(!grid) { console.error('cal-grid not found'); return; }
const today = todayStr();
const firstDay = new Date(calYear, calMonth, 1).getDay();
const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
const prevDays = new Date(calYear, calMonth, 0).getDate();
// Clear grid but keep it visible
grid.innerHTML = '';
// Day headers
['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
const h = document.createElement('div');
h.style.cssText = 'background:var(--info);color:#fff;text-align:center;padding:8px 4px;font-size:11px;font-weight:600;letter-spacing:.5px;';
h.textContent = d;
grid.appendChild(h);
});
// Prev month padding
for(let i=firstDay-1;i>=0;i--) {
const d = document.createElement('div');
d.style.cssText = 'background:var(--surface2);min-height:80px;padding:6px;';
d.innerHTML = `<div style="font-size:11px;color:var(--text-faint)">${prevDays-i}</div>`;
grid.appendChild(d);
}
// Current month days
for(let day=1;day<=daysInMonth;day++) {
const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
const dayEvents = events.filter(e=>e.date===dateStr);
const isToday = dateStr===today;
const d = document.createElement('div');
d.style.cssText = `background:${isToday?'var(--info-light)':'var(--surface)'};min-height:80px;padding:6px;border:1px solid transparent;`;
const numEl = document.createElement('div');
numEl.style.cssText = `font-size:12px;font-weight:${isToday?'700':'500'};color:${isToday?'var(--info)':'var(--text-muted)'};margin-bottom:3px;`;
numEl.textContent = day;
d.appendChild(numEl);
dayEvents.forEach(e => {
const ev = document.createElement('div');
// Color by worker: Josh = warm red/orange, Dev = blue/teal
const workerColors = {
  josh: { surgery:'background:#fff1f0;color:#b91c1c;border-left:3px solid #f87171;', 'preop-call':'background:#fff7ed;color:#c2410c;border-left:3px solid #fb923c;', deposit:'background:#fef9c3;color:#854d0e;border-left:3px solid #facc15;' },
  dev:  { surgery:'background:#eff6ff;color:#1d4ed8;border-left:3px solid #60a5fa;', 'preop-call':'background:#f0fdf4;color:#166534;border-left:3px solid #4ade80;', deposit:'background:#faf5ff;color:#6b21a8;border-left:3px solid #c084fc;' },
};
const workerKey = e.worker === 'josh' ? 'josh' : 'dev';
const typeStyle = workerColors[workerKey][e.type] || (workerKey==='josh' ? 'background:#fff1f0;color:#b91c1c;' : 'background:#eff6ff;color:#1d4ed8;');
ev.style.cssText = `font-size:10px;font-weight:500;padding:3px 6px;border-radius:3px;margin-bottom:2px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;display:block;width:100%;box-sizing:border-box;${typeStyle}`;
ev.textContent = e.label;
ev.title = e.detail || e.label;
ev.onclick = () => { try { showCalDetail(e); } catch(err) { console.warn(err); } };
d.appendChild(ev);
});
grid.appendChild(d);
}
// Next month padding
const total = Math.ceil((firstDay+daysInMonth)/7)*7;
for(let i=1;i<=total-(firstDay+daysInMonth);i++) {
const d = document.createElement('div');
d.style.cssText = 'background:var(--surface2);min-height:80px;padding:6px;';
d.innerHTML = `<div style="font-size:11px;color:var(--text-faint)">${i}</div>`;
grid.appendChild(d);
}
console.log('Calendar rendered:', months[calMonth], calYear, 'Events:', events.length);
};
// Alias for showTab compatibility
window.renderCalendar = buildCalendar;
window.buildCalendar = buildCalendar;
function showCalDetail(e) {
window._calDetailCaseId = e.caseId;
const typeLabel = {surgery:'🔴 Surgery','preop-call':'📞 Pre-Op Call Due',deposit:'💰 Initiate Final Payment'};
const typeBg = {surgery:'#fee2e2','preop-call':'#dbeafe',deposit:'#dcfce7'};
const typeColor = {surgery:'#b91c1c','preop-call':'#1d4ed8',deposit:'#166534'};
let modal = document.getElementById('cal-detail-modal');
if(!modal) {
modal = document.createElement('div');
modal.id = 'cal-detail-modal';
modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;align-items:center;justify-content:center;padding:20px;';
modal.onclick = (ev) => { if(ev.target===modal) modal.style.display='none'; };
document.body.appendChild(modal);
}
const bg = typeBg[e.type] || 'var(--surface2)';
const col = typeColor[e.type] || 'var(--text)';
// Build inner HTML (no onclick strings — we attach listeners below)
modal.innerHTML = `
<div style="background:var(--surface);border-radius:var(--radius);max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden"><div style="background:${bg};padding:16px 20px;border-bottom:2px solid ${col}22"><div style="font-size:15px;font-weight:700;color:${col}">${typeLabel[e.type]||e.type}</div><div style="font-size:12px;color:${col};opacity:.8;margin-top:2px">${e.caseId}</div></div><div style="padding:18px 20px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px"><div style="background:var(--surface2);padding:8px 12px;border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-faint);margin-bottom:2px">Surgery Date</div><div style="font-size:13px;font-weight:500">${fmtDate(e.surgDate)}</div></div><div style="background:var(--surface2);padding:8px 12px;border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-faint);margin-bottom:2px">Event Date</div><div style="font-size:13px;font-weight:500">${fmtDate(e.date)}</div></div>
${e.provider ? `<div style="background:var(--surface2);padding:8px 12px;border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-faint);margin-bottom:2px">Dentist</div><div style="font-size:13px">${e.provider}</div></div>` : ''}
${e.worker ? `<div style="background:var(--surface2);padding:8px 12px;border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-faint);margin-bottom:2px">Worker</div><div style="font-size:13px">${e.worker==='dev'?'Devarsh':'Josh'}</div></div>` : ''}
</div>
${e.email ? `<div style="font-size:12px;color:var(--text-faint);margin-bottom:14px;font-family:'DM Mono',monospace">📧 ${e.email}</div>` : ''}
<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px"><button id="cal-view-preop-btn" class="btn btn-primary btn-sm" style="font-size:12px">📋 View Pre-Op / Case</button><button id="cal-close-btn" class="btn btn-ghost btn-sm">Close</button></div></div></div>`;
modal.style.display = 'flex';
// Use modal.querySelector to avoid ID conflicts with static HTML
modal.querySelector('#cal-close-btn').addEventListener('click', () => {
modal.style.display = 'none';
});
modal.querySelector('#cal-view-preop-btn').addEventListener('click', () => {
modal.style.display = 'none';
// Small delay to ensure modal is fully hidden before opening preview
setTimeout(() => window.viewPreopFromCalendar(e.caseId), 100);
});
}
window.viewPreopFromCalendar = async function(caseId) {
if(!caseId) return;
try {
// Load preop records fresh
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records||[]) : [];
window._rawPreopRecords = records;
const record = records.find(r => (r['po-caseId']||'').trim() === caseId.trim());
if(record) {
// Open the pre-op record in edit mode directly
editPreopRecord(record.id);
return;
}
// Finalized case — go to Case History and expand it
const c = (cases||[]).find(x => (x.caseId||'').trim() === caseId.trim());
if(c) {
showTab('history');
await new Promise(r => setTimeout(r, 300));
renderHistory();
await new Promise(r => setTimeout(r, 300));
const el = document.getElementById('detail_' + c.id);
if(el) {
el.classList.add('open');
el.scrollIntoView({ behavior: 'smooth', block: 'center' });
const parent = el.previousElementSibling || el.closest('.case-item');
if(parent) {
parent.style.outline = '3px solid var(--info)';
setTimeout(() => { parent.style.outline = ''; }, 2500);
}
}
} else {
alert('No record found for: ' + caseId);
}
} catch(err) {
console.error('viewPreopFromCalendar error:', err);
alert('Error: ' + err.message);
}
};
window.showCalEventDetail = showCalDetail;
window.showTab = function(tab, pushState) { if(pushState===undefined) pushState=true;
try { localStorage.setItem('atlas_active_tab', tab); } catch(e) {}
if(pushState) {
try { history.pushState({ tab }, '', '#' + tab); } catch(e) {}
}
document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
document.querySelectorAll('.nav-dropdown-btn').forEach(b=>b.classList.remove('active'));
document.querySelectorAll('.nav-dropdown-menu button').forEach(b=>b.classList.remove('active'));
const tabEl = document.getElementById('tab-'+tab); if(tabEl) tabEl.classList.add('active'); else return;
// Highlight correct nav item
const directBtn = document.querySelector(`.nav > button[onclick="showTab('${tab}')"]`);
if(directBtn) directBtn.classList.add('active');
// If it's a reports sub-tab, highlight the dropdown button and sub-item
const reportsTabs = ['reports','history','caselog','cs-log'];
if(reportsTabs.includes(tab)) {
document.getElementById('reports-dropdown-btn').classList.add('active');
const subBtn = document.getElementById('subnav-'+tab);
if(subBtn) subBtn.classList.add('active');
}
if(tab==='new-case') refreshDraftPicker();
if(tab==='inventory') renderInventory();
if(tab==='history') { loadSavedInvoices().then(() => renderHistory()); }
if(tab==='reports') renderReports();
if(tab==='preop-history') renderPreopHistory();
if(tab==='preop') { setTimeout(wireEKGDetection, 300); }
if(tab==='invoice') { loadSavedInvoices(); setInvoiceProvider(); renderDraftInvoices(); setTimeout(populateCenterDropdowns,100); setTimeout(injectBillingToggle, 100); }
if(tab==='cs-log') { renderCSLog(); renderTransferLog(); }
if(tab==='analytics') {
// Ensure preop records are loaded for projections
if(!window._rawPreopRecords || !window._rawPreopRecords.length) {
getDoc(doc(db,'atlas','preop')).then(snap => {
window._rawPreopRecords = snap.exists() ? (snap.data().records||[]) : [];
renderAnalytics(); renderSurgeryCenters();
}).catch(() => { renderAnalytics(); renderSurgeryCenters(); });
} else {
renderAnalytics(); renderSurgeryCenters();
}
}
if(tab==='calendar') {
setTimeout(buildCalendar, 50);
}
if(tab==='mid-case') renderMidCase();
if(tab==='caselog') renderCaseLog();
if(tab==='payout') renderPayoutTab();
if(tab==='payments' && typeof loadPaymentRows==='function') loadPaymentRows();
if(tab==='saved-pdfs' && typeof loadSavedPDFs==='function') loadSavedPDFs();
};




// -- PAYOUT CALCULATOR --
(function() {
  async function _load() {
    try {
      const snap = await getDoc(doc(db, 'atlas', 'payouts'));
      return snap.exists() ? snap.data() : { entries: [], distributions: [] };
    } catch(e) { return { entries: [], distributions: [] }; }
  }
  async function _save(data) {
    setSyncing(true);
    await setDoc(doc(db, 'atlas', 'payouts'), data);
    setSyncing(false);
  }
  function _uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function _fmt(n) { return '$' + Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function _fmtD(d) { if(!d) return ''; const p=d.split('-'); return p[1]+'/'+p[2]+'/'+p[0]; }

  // cat → { label, color, isExpense }
  const CAT_META = {
    expense:           { label:'EXPENSE',            color:'var(--warn)',  bg:'rgba(239,68,68,0.1)',   isExpense:true  },
    income:            { label:'INCOME',             color:'#2d6a4f',     bg:'rgba(45,106,79,0.1)',    isExpense:false },
    'case-income':     { label:'CASE INVOICE',       color:'#0369a1',     bg:'rgba(3,105,161,0.1)',    isExpense:false },
    'initial-invest':  { label:'INITIAL INVESTMENT', color:'var(--info)', bg:'rgba(29,83,198,0.1)',   isExpense:false },
  };
  function _meta(cat) { return CAT_META[cat] || CAT_META.expense; }
  function _isExp(cat) { return _meta(cat).isExpense; }
  // Self-pay accessor. New invoices store the value on `selfPay`; legacy
  // case-income entries (synced before the rework) have `personalIncome` —
  // fall back to that so historical totals don't drop to zero.
  function _entrySelfPay(e) {
    if(typeof e.selfPay === 'number') return e.selfPay;
    return e.personalIncome || 0;
  }

  function _totals(worker, data) {
    const entries     = (data.entries||[]).filter(e=>e.worker===worker);
    const dists       = (data.distributions||[]).filter(d=>d.worker===worker);
    const totalOut    = entries.filter(e=>e.cat==='expense').reduce((s,e)=>s+(e.amount||0),0);
    const totalIn     = entries.filter(e=>e.cat==='income').reduce((s,e)=>s+(e.amount||0),0);
    const totalInvest    = entries.filter(e=>e.cat==='initial-invest').reduce((s,e)=>s+(e.amount||0),0);
    const totalDist      = dists.reduce((s,d)=>s+(d.amount||0),0);
    // Track how much of invest has been paid back incrementally via distributions
    const totalInvestPaid = dists.reduce((s,d)=>s+(d.investPaid||0),0);
    const investOwed     = Math.max(0, totalInvest - totalInvestPaid);
    // Revenue and self-pay come from the case-income log entries themselves —
    // amount = what the surgery center was invoiced, selfPay = what the
    // worker is paying themselves out of it (entered manually on the invoice
    // modal). For legacy entries written before selfPay existed we fall back
    // to the old personalIncome snapshot so totals don't suddenly drop.
    const caseIncomeEntries = entries.filter(e => e.cat === 'case-income');
    const rev          = caseIncomeEntries.reduce((s,e) => s + (e.amount || 0), 0);
    const selfPayTotal = caseIncomeEntries.reduce((s,e) => s + _entrySelfPay(e), 0);
    const revSuggested = Math.max(0, selfPayTotal + totalIn - totalOut - totalDist);
    return { entries, dists, totalIn, totalOut, totalInvest, totalInvestPaid, totalDist, rev, selfPayTotal, revSuggested, investOwed };
  }

  function _lbl(text, optional) {
    return '<label style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">'
      +text+(optional?' <span style="font-weight:400;text-transform:none;font-style:italic">(optional)</span>':'')+' </label>';
  }
  function _field(id, type, placeholder) {
    return '<input type="'+type+'" id="'+id+'" placeholder="'+(placeholder||'')+'" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box">';
  }

  // Sum the per-invoice amounts on an Initial Investment entry. Returns 0 for
  // entries without an invoices array (legacy entries) — those keep their
  // stored .amount as the canonical value. Once an entry has even one invoice,
  // its .amount is treated as a derived field maintained by add/delete below.
  function _sumInvoices(entry) {
    if(!entry || !Array.isArray(entry.invoices)) return 0;
    return entry.invoices.reduce(function(s, inv) {
      return s + (parseFloat(inv.amount) || 0);
    }, 0);
  }

  // Distinct vendor names already used for initial-invest entries — fed to
  // the Add/Edit form's vendor dropdown so the user picks an existing vendor
  // rather than re-typing it. Scoped to the worker so each person's list is
  // their own. Includes a sentinel "+ New vendor" option in the UI elsewhere.
  function _initInvestVendors(data, worker) {
    if(!data || !Array.isArray(data.entries)) return [];
    var names = data.entries
      .filter(function(e) { return e.cat === 'initial-invest' && e.worker === worker; })
      .map(function(e) { return (e.name || '').trim(); })
      .filter(Boolean);
    return Array.from(new Set(names)).sort();
  }

  function _entryFormHTML(worker, editing) {
    var title = editing ? 'Edit Entry' : 'Add Entry';
    return '<div style="font-size:13px;font-weight:600;margin-bottom:12px">'+title+'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div id="payout-name-wrap-'+worker+'">'+_lbl('Name')+_field('payout-name-'+worker,'text','e.g. Propofol restock')+'</div>'
        +'<div>'+_lbl('Type')
          +'<select id="payout-cat-'+worker+'" onchange="window._onPayoutCatChange(\''+worker+'\')" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">'
            +'<option value="expense">Expense</option>'
            +'<option value="income">Income</option>'
            +'<option value="initial-invest">Initial Investment</option>'
          +'</select>'
        +'</div>'
      +'</div>'
      // Vendor dropdown — only shown when Type=Initial Investment. Populated
      // from existing initial-invest vendor names so the user picks rather
      // than re-types. Selecting "+ New vendor" reveals a free-text input.
      +'<div id="payout-vendor-wrap-'+worker+'" style="display:none;margin-bottom:10px">'
        +_lbl('Vendor')
        +'<select id="payout-vendor-'+worker+'" onchange="window._onVendorPick(\''+worker+'\')" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">'
          +'<option value="">— Select vendor —</option>'
        +'</select>'
        +'<input type="text" id="payout-vendor-new-'+worker+'" placeholder="New vendor name" style="display:none;width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box;margin-top:6px">'
      +'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div>'+_lbl('Amount')+_field('payout-amount-'+worker,'number','0.00')+'</div>'
        +'<div>'+_lbl('Supplier',true)+_field('payout-supplier-'+worker,'text','e.g. Henry Schein')+'</div>'
      +'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div>'+_lbl('Date',true)+_field('payout-date-'+worker,'date','')+'</div>'
        +'<div>'+_lbl('Notes',true)+_field('payout-notes-'+worker,'text','Additional details...')+'</div>'
      +'</div>'
      +'<input type="hidden" id="payout-editing-id-'+worker+'" value="">'
      +'<div style="display:flex;gap:8px">'
        +'<button class="btn btn-primary btn-sm" id="payout-save-'+worker+'">Save</button>'
        +'<button class="btn btn-ghost btn-sm" id="payout-cancel-'+worker+'">Cancel</button>'
      +'</div>';
  }

  // When Type changes, swap between the free-text Name field and the
  // vendor dropdown. Initial Investment uses the dropdown so vendors are
  // reused consistently across invoices.
  window._onPayoutCatChange = async function(w) {
    var catEl = document.getElementById('payout-cat-' + w);
    if(!catEl) return;
    var nameWrap   = document.getElementById('payout-name-wrap-' + w);
    var vendorWrap = document.getElementById('payout-vendor-wrap-' + w);
    var vendorSel  = document.getElementById('payout-vendor-' + w);
    if(catEl.value === 'initial-invest') {
      // Populate dropdown from existing vendors
      var data = await _load();
      var vendors = _initInvestVendors(data, w);
      var current = (document.getElementById('payout-name-' + w) || {}).value || '';
      var opts = '<option value="">— Select vendor —</option>';
      vendors.forEach(function(v) {
        var sel = (v === current) ? ' selected' : '';
        opts += '<option value="' + v.replace(/"/g, '&quot;') + '"' + sel + '>' + v + '</option>';
      });
      opts += '<option value="__new__">+ New vendor…</option>';
      if(vendorSel) vendorSel.innerHTML = opts;
      if(nameWrap)   nameWrap.style.display   = 'none';
      if(vendorWrap) vendorWrap.style.display = '';
    } else {
      if(nameWrap)   nameWrap.style.display   = '';
      if(vendorWrap) vendorWrap.style.display = 'none';
    }
  };

  // Show/hide the "new vendor" text field based on dropdown choice. The
  // same text field is reused for both "+ New vendor…" and the
  // "Rename current vendor…" flow — for rename, we pre-fill with the
  // current selected option's label so the user can edit it inline.
  window._onVendorPick = function(w) {
    var sel    = document.getElementById('payout-vendor-' + w);
    var newEl  = document.getElementById('payout-vendor-new-' + w);
    var nameEl = document.getElementById('payout-name-' + w);
    if(!sel) return;
    if(sel.value === '__new__') {
      if(newEl) {
        newEl.value = '';
        newEl.placeholder = 'New vendor name';
        newEl.style.display = '';
        newEl.focus();
      }
    } else if(sel.value === '__rename__') {
      // Pre-fill with the existing vendor name (extracted from the
      // sentinel option's label). The user can then edit it freely.
      var current = (nameEl && nameEl.value) || '';
      // Fallback: parse from the option text if hidden name isn't set
      if(!current) {
        var opt = sel.options[sel.selectedIndex];
        var m = opt && /^✎ Rename "(.+)"…$/.exec(opt.textContent);
        if(m) current = m[1];
      }
      if(newEl) {
        newEl.value = current;
        newEl.placeholder = 'Rename to…';
        newEl.style.display = '';
        newEl.focus();
        newEl.select();
      }
    } else {
      if(newEl) newEl.style.display = 'none';
      if(nameEl) nameEl.value = sel.value;
    }
  };


  function _buildSection(worker, canEdit, data, container) {
    const wname  = worker==='dev'?'Devarsh':'Josh';
    const wcolor = worker==='dev'?'var(--dev)':'var(--josh)';
    const { entries, dists, totalIn, totalOut, totalInvest, totalInvestPaid, totalDist, rev, selfPayTotal, revSuggested, investOwed } = _totals(worker, data);
    const sorted  = [...entries].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    const sortedD = [...dists].sort((a,b)=>(b.date||'').localeCompare(a.date||''));

    // Pre-compute the set of dates that have 2+ case-income entries for
    // this worker. Any case-income row falling on one of these dates with
    // PI=$0 is a "same-day stack" — the first case absorbed the day's PI,
    // the rest land at $0. Used by the SAME DAY tag below.
    const _caseDateCounts = {};
    entries.forEach(function(e) {
      if(e.cat === 'case-income' && e.date) {
        _caseDateCounts[e.date] = (_caseDateCounts[e.date] || 0) + 1;
      }
    });
    const _sameDayCaseDates = new Set(
      Object.keys(_caseDateCounts).filter(function(d) { return _caseDateCounts[d] > 1; })
    );

    // Build a Set of entry IDs that have been included in any distribution
    // for this worker, so the entry list can show a "DISTRIBUTED" badge on
    // those rows. Only new-format distributions (with lineItems referencing
    // sourceId) can be cross-checked — pre-modal legacy distributions had no
    // line items and so contribute nothing here, which is fine.
    const distributedIds = new Set();
    dists.forEach(function(d) {
      (d.lineItems || []).forEach(function(li) {
        if(li.sourceId) distributedIds.add(li.sourceId);
      });
    });

    const wrap = document.createElement('div');
    wrap.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px';

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:15px;font-weight:700;color:'+wcolor+';margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid '+wcolor+'22';
    hdr.textContent = wname;
    wrap.appendChild(hdr);

    // ── Metric cards: Self-Pay (this is the worker's salary base), invoiced
    //    revenue (informational), expenses, investment owed ───────────────
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:16px';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px';
    [
      ['Self-Pay (all time)', _fmt(selfPayTotal),   '#166534'],
      ['Invoiced Revenue',    _fmt(rev),            'var(--text-muted)'],
    ].forEach(function(item) {
      const card = document.createElement('div');
      card.className = 'metric-card';
      card.style.cssText = 'padding:14px 16px';
      card.innerHTML = '<div class="metric-label" style="font-size:11px">'+item[0]+'</div><div class="metric-value" style="color:'+item[2]+';font-size:24px;line-height:1.1;margin-top:2px">'+item[1]+'</div>';
      topRow.appendChild(card);
    });
    grid.appendChild(topRow);

    const secRow = document.createElement('div');
    secRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px';
    [
      ['Expenses',             _fmt(totalOut),   'var(--warn)'],
      ['Investment Owed Back', _fmt(investOwed), 'var(--info)'],
    ].forEach(function(item) {
      const card = document.createElement('div');
      card.className = 'metric-card';
      card.innerHTML = '<div class="metric-label">'+item[0]+'</div><div class="metric-value" style="color:'+item[2]+'">'+item[1]+'</div>';
      secRow.appendChild(card);
    });
    grid.appendChild(secRow);

    wrap.appendChild(grid);

    // Month-end Review button — opens a modal showing every case for a given
    // month with invoiced + self-pay so the worker can confirm before paying
    // themselves their salary.
    if(canEdit) {
      const reviewRow = document.createElement('div');
      reviewRow.style.cssText = 'margin-bottom:14px';
      const reviewBtn = document.createElement('button');
      reviewBtn.className = 'btn btn-primary btn-sm';
      reviewBtn.style.cssText = 'background:#166534;border-color:#166534';
      reviewBtn.textContent = '📋 Month-End Salary Review';
      reviewBtn.addEventListener('click', function() {
        if(typeof window.openMonthEndReview === 'function') window.openMonthEndReview(worker);
      });
      reviewRow.appendChild(reviewBtn);
      wrap.appendChild(reviewRow);
    }

    // Action buttons
    if(canEdit) {
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap';
      const b1 = document.createElement('button'); b1.className='btn btn-ghost btn-sm'; b1.textContent='+ Add Entry';
      b1.addEventListener('click', function() { window.showAddPayoutExpense(worker); });
      const b2 = document.createElement('button'); b2.className='btn btn-ghost btn-sm'; b2.style.color='var(--accent)'; b2.textContent='Record Payout';
      b2.addEventListener('click', function() { window.openDistributionModal(worker); });
      btnRow.appendChild(b1); btnRow.appendChild(b2);
      wrap.appendChild(btnRow);
    } else {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px;color:var(--text-faint);margin-bottom:12px;font-style:italic';
      note.textContent = 'View only — log in as '+wname+' to edit';
      wrap.appendChild(note);
    }

    // Add/Edit entry form
    const addForm = document.createElement('div');
    addForm.id = 'payout-add-form-'+worker;
    addForm.style.cssText = 'display:none;background:var(--surface2);border-radius:var(--radius-sm);padding:14px;margin-bottom:14px';
    addForm.innerHTML = _entryFormHTML(worker, false);
    wrap.appendChild(addForm);

    // Distribution form removed — handled by distribution-modal.js
    // (window.openDistributionModal opens the new itemized builder modal)

    // ── Entries list ─────────────────────────────────────────────────────────
    // Category-grouped layout: instead of a flat list with the same pill
    // repeated row-after-row (visually heavy), entries collapse under
    // colored category headers that show count + subtotal. The pill on each
    // row is hidden inside its group since the group header already conveys
    // the category — keeps rows clean and lets the eye scan by amount.
    const eLabel = document.createElement('div');
    eLabel.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);letter-spacing:.5px;margin-bottom:10px';
    eLabel.textContent = 'Expense & Income Log';
    wrap.appendChild(eLabel);

    if(!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state'; empty.style.fontSize = '12px';
      empty.textContent = 'No entries yet'; wrap.appendChild(empty);
    } else {
      // Group order matters — case invoices first (most-touched), then other
      // income, then expenses, then the static initial-investment block last.
      // Within each group we keep the existing date-desc sort.
      const GROUPS = [
        { key:'case-income',    title:'Case Invoices',          accent:'#0369a1' },
        { key:'other-income',   title:'Other Income',           accent:'#2d6a4f',
          test: function(e) { return e.cat === 'income'; } },
        { key:'expenses',       title:'Expenses & Supplies',    accent:'#b91c1c',
          test: function(e) { return e.cat === 'expense' || e.cat === 'supplies'; } },
        { key:'initial-invest', title:'Initial Investment',     accent:'#1d4380' }
      ];

      // Case invoices: render each calendar month as its own card so the
      // worker can scan a month at a time. Other categories stay as a single
      // card (with month sub-headers inside) since their volume is lower.
      const _monthLabel = (iso) => {
        if(!iso) return 'Undated';
        const d = new Date(iso + 'T12:00:00Z');
        if(isNaN(d.getTime())) return 'Undated';
        return d.toLocaleDateString('en-US', { month:'long', year:'numeric' });
      };
      const renderGroups = [];
      GROUPS.forEach(function(g) {
        const items = sorted.filter(function(e) {
          if(g.test) return g.test(e);
          return e.cat === g.key;
        });
        if(!items.length) return;
        if(g.key === 'case-income') {
          // Bucket by month, preserving the date-desc order of the input.
          const byMonth = new Map();
          items.forEach(function(e) {
            const k = (e.date ? e.date.slice(0,7) : 'undated');
            if(!byMonth.has(k)) byMonth.set(k, []);
            byMonth.get(k).push(e);
          });
          const sortedKeys = [...byMonth.keys()].sort(function(a,b){
            if(a === 'undated') return 1;
            if(b === 'undated') return -1;
            return b.localeCompare(a);
          });
          sortedKeys.forEach(function(k) {
            const monthItems = byMonth.get(k);
            const sampleDate = monthItems[0].date || '';
            renderGroups.push({
              key: 'case-income-' + k,
              title: g.title + ' · ' + _monthLabel(sampleDate),
              accent: g.accent,
              items: monthItems,
              showMonthSubheaders: false
            });
          });
        } else {
          renderGroups.push({ key: g.key, title: g.title, accent: g.accent, items, showMonthSubheaders: true });
        }
      });

      renderGroups.forEach(function(g) {
        const items = g.items;

        // Subtotal: self-pay for case invoices, absolute amount for everything
        // else. Legacy entries (no selfPay field) fall back to personalIncome
        // so totals don't suddenly drop after the switch.
        let subtotal = 0;
        items.forEach(function(e) {
          if(e.cat === 'case-income') subtotal += _entrySelfPay(e);
          else                         subtotal += (e.amount || 0);
        });

        // Group header — accent stripe on the left, title + count + subtotal on the right
        const groupBox = document.createElement('div');
        groupBox.style.cssText = 'margin-bottom:14px;border:1px solid var(--border);border-radius:8px;background:var(--bg);overflow:hidden';

        const ghdr = document.createElement('div');
        ghdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:9px 14px;background:'+g.accent+'10;border-bottom:1px solid '+g.accent+'20;border-left:3px solid '+g.accent;
        const subLabel = items[0]?.cat === 'case-income' ? 'self-pay total' : 'subtotal';
        ghdr.innerHTML =
          '<div style="display:flex;align-items:baseline;gap:10px">'
          + '<span style="font-size:12px;font-weight:700;color:'+g.accent+';letter-spacing:.2px">'+g.title+'</span>'
          + '<span style="font-size:10px;font-weight:600;color:var(--text-faint);background:rgba(0,0,0,0.04);padding:1px 7px;border-radius:10px">'+items.length+'</span>'
          +'</div>'
          + '<div style="display:flex;align-items:baseline;gap:6px">'
          + '<span style="font-size:9px;font-weight:700;text-transform:uppercase;color:var(--text-faint);letter-spacing:.5px">'+subLabel+'</span>'
          + '<span style="font-size:13px;font-weight:700;color:'+g.accent+';font-family:DM Mono,monospace">'+_fmt(subtotal)+'</span>'
          +'</div>';
        groupBox.appendChild(ghdr);

        // Month sub-headers — used in non-case categories where one card
        // covers all months. Case-income rendering already gives each month
        // its own card, so no sub-headers needed there.
        let _prevMonthKey = null;
        items.forEach(function(e, i) {
        if(g.showMonthSubheaders) {
        const monthKey = e.date ? e.date.slice(0,7) : 'undated';
        if(monthKey !== _prevMonthKey) {
          _prevMonthKey = monthKey;
          // Subtotal for just this month within this category.
          const monthItems = items.filter(x => (x.date || '').slice(0,7) === (e.date || '').slice(0,7));
          let monthSub = 0;
          monthItems.forEach(x => {
            if(x.cat === 'case-income') monthSub += _entrySelfPay(x);
            else                          monthSub += (x.amount || 0);
          });
          const mhdr = document.createElement('div');
          mhdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 14px;background:'+g.accent+'06;border-top:1px solid '+g.accent+'15;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)';
          mhdr.innerHTML = '<span>'+_monthLabel(e.date)+' · '+monthItems.length+' '+(monthItems.length===1?'entry':'entries')+'</span><span style="font-family:DM Mono,monospace;color:'+g.accent+'">'+_fmt(monthSub)+'</span>';
          groupBox.appendChild(mhdr);
        }
        }
        const row = document.createElement('div');
        // Two-zone flex layout: content on the left, amount block on the right.
        // Edit/delete actions live in a flexbox slot before the amount and fade
        // in on row hover only — keeps the resting state clean.
        const isLast = i === items.length - 1;
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding:11px 14px;'+(isLast?'':'border-bottom:1px solid var(--border);')+'transition:background .12s';
        row.addEventListener('mouseenter', function() { row.style.background = g.accent + '08'; });
        row.addEventListener('mouseleave', function() { row.style.background = ''; });

        // ── LEFT: name on first line, dotted meta on second ──
        const left = document.createElement('div');
        left.style.cssText = 'min-width:0;flex:1';
        const autoTag = e.cat==='case-income'
          ? '<span style="font-size:9px;color:var(--text-faint);margin-left:8px;font-style:italic;font-weight:400">auto</span>'
          : '';
        // SAME DAY tag — when two or more case-income entries share a date
        // (same worker) and one was left at $0 self-pay, tag it so the row
        // doesn't look like a stalled case. Mostly informational.
        const sameDayTag = (e.cat === 'case-income'
            && _entrySelfPay(e) === 0
            && e.date
            && _sameDayCaseDates.has(e.date))
          ? '<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:700;letter-spacing:.4px;background:rgba(180,83,9,0.12);color:#b45309;margin-left:8px;vertical-align:middle">SAME DAY</span>'
          : '';
        // "Distributed" badge — shown on any entry that's appeared as a line
        // item in a saved distribution. Subtle green pill with a checkmark so
        // it visually echoes the existing "Sent" badge on Saved PDFs.
        const distTag = distributedIds.has(e.id)
          ? '<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:700;letter-spacing:.4px;background:rgba(45,106,79,0.12);color:#2d6a4f;margin-left:8px;vertical-align:middle">✓ PAID OUT</span>'
          : '';
        // Build dotted meta line: date · supplier · notes (with " · " separators)
        const metaParts = [];
        if(e.date) metaParts.push(_fmtD(e.date));
        if(e.supplier) metaParts.push(e.supplier);
        // For case-income rows the "Center: X" notes string duplicates the pill;
        // strip that prefix so the meta line stays clean.
        let displayNotes = e.notes || '';
        if(e.cat === 'case-income' && displayNotes.indexOf('Center: ') === 0) {
          displayNotes = displayNotes.slice(8);
        }
        if(displayNotes) metaParts.push(displayNotes);
        const metaLine = metaParts.length
          ? '<div style="font-size:11px;color:var(--text-faint);margin-top:4px;line-height:1.4">'+metaParts.join('<span style="margin:0 6px;opacity:.5">·</span>')+'</div>'
          : '';
        left.innerHTML =
          '<div style="font-size:13px;font-weight:600;line-height:1.3;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+(e.name||'-')+sameDayTag+autoTag+distTag+'</div>'
          + metaLine;

        // ── RIGHT: hover-only action icons, then amount block ──
        const right = document.createElement('div');
        right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';

        if(canEdit && e.cat !== 'case-income') {
          const actions = document.createElement('div');
          actions.style.cssText = 'display:flex;gap:2px;opacity:0;transition:opacity .12s';
          row.addEventListener('mouseenter', function() { actions.style.opacity = '1'; });
          row.addEventListener('mouseleave', function() { actions.style.opacity = '0'; });

          const editBtn = document.createElement('button');
          editBtn.innerHTML = '✎';
          editBtn.title = 'Edit';
          editBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;color:var(--info);padding:4px 7px;border-radius:4px;line-height:1';
          editBtn.addEventListener('mouseenter', function() { editBtn.style.background = 'rgba(29,83,198,0.12)'; });
          editBtn.addEventListener('mouseleave', function() { editBtn.style.background = 'none'; });
          (function(entry, w) {
            editBtn.addEventListener('click', function() { window.editPayoutEntry(entry, w); });
          })(e, worker);

          const delBtn = document.createElement('button');
          delBtn.innerHTML = '🗑';
          delBtn.title = 'Delete';
          delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;padding:4px 7px;border-radius:4px;line-height:1;opacity:.7';
          delBtn.addEventListener('mouseenter', function() { delBtn.style.background = 'rgba(239,68,68,0.12)'; delBtn.style.opacity = '1'; });
          delBtn.addEventListener('mouseleave', function() { delBtn.style.background = 'none'; delBtn.style.opacity = '.7'; });
          (function(eid, ew) {
            delBtn.addEventListener('click', function() { window.deletePayoutEntry(eid, ew); });
          })(e.id, worker);

          actions.appendChild(editBtn); actions.appendChild(delBtn);
          right.appendChild(actions);
        }

        // Amount block — right-aligned, monospace, consistent min-width
        const amtCol = document.createElement('div');
        amtCol.style.cssText = 'text-align:right;min-width:108px';
        if(e.cat === 'case-income') {
          // Case-income rows lead with self-pay (what the worker is paying
          // themselves out of the invoice) and show the underlying invoice
          // amount as a caption beneath. Three display states:
          //   1. Not yet invoiced + no self-pay        → "PENDING / $X invoiced"
          //   2. Case happened, not invoiced           → "no self-pay yet / awaiting invoice"
          //   3. Invoiced (self-pay set on send)       → "+$selfPay / of $X inv."
          const spVal = _entrySelfPay(e);
          const todayStr = new Date().toISOString().slice(0, 10);
          const isFutureCase = e.date && e.date > todayStr;
          const invAmt = e.amount || 0;
          const isInvoiced = (typeof e.invoiced === 'boolean' ? e.invoiced : invAmt > 0);
          if(isFutureCase && spVal === 0) {
            amtCol.innerHTML =
              '<div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.6px;line-height:1.2">PENDING</div>'
              + '<div style="font-size:10px;color:var(--text-faint);margin-top:3px;font-family:DM Mono,monospace">'+_fmt(invAmt)+' invoiced</div>';
          } else if(!isInvoiced) {
            amtCol.innerHTML =
              '<div style="font-size:13px;font-weight:600;color:var(--text-faint);line-height:1.2">no self-pay yet</div>'
              + '<div style="font-size:10px;color:#b45309;margin-top:3px;font-style:italic">awaiting invoice</div>';
          } else {
            amtCol.innerHTML =
              '<div style="font-size:14px;font-weight:700;color:#166534;font-family:DM Mono,monospace;line-height:1.2">+'+_fmt(spVal)+'</div>'
              + '<div style="font-size:10px;color:var(--text-faint);margin-top:3px;font-family:DM Mono,monospace">of '+_fmt(invAmt)+' inv.</div>';
          }
        } else {
          const sign = _isExp(e.cat) ? '−' : '+';   // U+2212 minus for visual weight
          const amtColor = e.cat==='initial-invest' ? '#1d4380' : (_isExp(e.cat) ? '#b91c1c' : '#2d6a4f');
          amtCol.innerHTML = '<div style="font-size:14px;font-weight:700;color:'+amtColor+';font-family:DM Mono,monospace;line-height:1.2">'+sign+_fmt(e.amount)+'</div>';
        }
        right.appendChild(amtCol);

        row.appendChild(left); row.appendChild(right);
        groupBox.appendChild(row);

        // For Initial Investment entries with invoices, render an expandable
        // panel directly under the row that lists each invoice (date, #, $)
        // and lets the user add/delete invoices inline. The row itself becomes
        // a click-toggle for showing/hiding the panel.
        // Only Henry Schein, Smith Pharmacy, and Toad (any variation) support
        // invoice tracking — other vendors stay as plain lump-sum entries.
        // Substring match so renames like "Henry Schein" → "Henry Schein Inc."
        // or "Toad" → "Toad Airway" keep their panels. We don't gate on
        // category — these vendors might be tracked as Expense, Initial
        // Investment, or Supplies depending on how the user filed them.
        const VENDORS_WITH_INVOICES = ['henry schein', 'smith pharmacy', 'toad'];
        const vendorKey = (e.name || '').trim().toLowerCase();
        const supportsInvoices = e.cat !== 'case-income'
          && VENDORS_WITH_INVOICES.some(function(v) { return vendorKey.indexOf(v) !== -1; });
        if(supportsInvoices && canEdit) {
          const invoices = Array.isArray(e.invoices) ? e.invoices : [];
          // Make the left content clickable to toggle the panel — but skip
          // clicks that hit the action buttons (those have their own handlers
          // and stopPropagation isn't reliable across browsers for icons).
          row.style.cursor = 'pointer';
          row.title = invoices.length
            ? 'Click to view invoices'
            : 'Click to add invoices';

          // Chevron in the meta line — appended to left so it sits under name
          const chevron = document.createElement('span');
          chevron.id = 'inv-chev-' + e.id;
          chevron.textContent = invoices.length ? '▾ ' + invoices.length + ' invoice' + (invoices.length === 1 ? '' : 's') : '▾ Add invoices';
          chevron.style.cssText = 'display:inline-block;margin-top:6px;font-size:11px;font-weight:600;color:var(--info);background:rgba(29,67,128,0.08);padding:2px 8px;border-radius:10px;letter-spacing:.2px';
          left.appendChild(chevron);

          const panel = document.createElement('div');
          panel.id = 'inv-panel-' + e.id;
          panel.style.cssText = 'display:none;padding:12px 14px 14px;background:rgba(29,67,128,0.04);border-top:1px solid var(--border)' + (isLast ? '' : ';border-bottom:1px solid var(--border)');

          // Build the panel content via an extracted renderer so add/delete
          // can re-render in place without touching the rest of the page.
          (function renderPanel() {
            const list = (Array.isArray(e.invoices) ? e.invoices : [])
              .slice()
              .sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
            let html = '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);margin-bottom:8px;letter-spacing:.4px">Invoices</div>';
            if(!list.length) {
              html += '<div style="font-size:12px;color:var(--text-faint);font-style:italic;margin-bottom:10px">No invoices yet — add the first one below.</div>';
            } else {
              html += '<div style="display:grid;grid-template-columns:110px 1fr 100px 30px;gap:8px;align-items:center;font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.3px;padding:0 4px 4px;border-bottom:1px solid var(--border)">'
                + '<div>Date</div><div>Invoice #</div><div style="text-align:right">Amount</div><div></div>'
                + '</div>';
              list.forEach(function(inv) {
                const dateStr = inv.date ? _fmtD(inv.date) : '—';
                const numStr  = inv.invoiceNumber ? String(inv.invoiceNumber) : '—';
                html += '<div style="display:grid;grid-template-columns:110px 1fr 100px 30px;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid var(--border);font-size:12px">'
                  + '<div style="font-family:DM Mono,monospace;color:var(--text-muted)">' + dateStr + '</div>'
                  + '<div style="font-family:DM Mono,monospace;color:var(--text);overflow:hidden;text-overflow:ellipsis">' + numStr + '</div>'
                  + '<div style="text-align:right;font-family:DM Mono,monospace;font-weight:600;color:#1d4380">' + _fmt(inv.amount || 0) + '</div>'
                  + '<button onclick="window.deleteEDInvoice(\'' + e.id + '\',\'' + inv.id + '\',\'' + worker + '\')" title="Delete invoice" style="background:none;border:none;cursor:pointer;color:var(--text-faint);padding:2px 4px;border-radius:4px;font-size:13px;line-height:1">🗑</button>'
                  + '</div>';
              });
              const subtotal = list.reduce(function(s, inv) { return s + (parseFloat(inv.amount) || 0); }, 0);
              html += '<div style="display:grid;grid-template-columns:110px 1fr 100px 30px;gap:8px;align-items:center;padding:8px 4px 4px;font-size:12px">'
                + '<div></div>'
                + '<div style="text-align:right;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-faint);letter-spacing:.3px">Total</div>'
                + '<div style="text-align:right;font-family:DM Mono,monospace;font-weight:700;color:#1d4380;font-size:13px">' + _fmt(subtotal) + '</div>'
                + '<div></div>'
                + '</div>';
            }
            // Add-invoice form — three small inputs side by side, one Save button
            const today = new Date().toISOString().slice(0, 10);
            html += '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border)">'
              + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);margin-bottom:6px;letter-spacing:.4px">Add invoice</div>'
              + '<div style="display:grid;grid-template-columns:130px 1fr 110px auto;gap:8px;align-items:end">'
              + '<input type="date" id="inv-add-date-'+e.id+'" value="'+today+'" style="padding:7px 9px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box;font-family:DM Mono,monospace">'
              + '<input type="text" id="inv-add-num-'+e.id+'" placeholder="Invoice #" style="padding:7px 9px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box;font-family:DM Mono,monospace">'
              + '<input type="number" id="inv-add-amt-'+e.id+'" placeholder="0.00" min="0" step="0.01" style="padding:7px 9px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box;font-family:DM Mono,monospace;text-align:right">'
              + '<button onclick="window.addEDInvoice(\''+e.id+'\',\''+worker+'\')" class="btn btn-primary btn-sm" style="font-size:12px;padding:7px 14px">Add</button>'
              + '</div>'
              + '</div>';
            // Bulk import section — collapsible, lets the user paste many
            // invoices at once (CSV / tab / comma / multi-space separated).
            html += '<div style="margin-top:10px">'
              + '<button onclick="window.toggleBulkImport(\''+e.id+'\')" style="background:none;border:1px dashed var(--border);color:var(--text-muted);padding:5px 12px;border-radius:var(--radius-sm);font-size:11px;cursor:pointer;font-family:inherit">📋 Bulk import invoices…</button>'
              + '<div id="inv-bulk-wrap-'+e.id+'" style="display:none;margin-top:10px;padding:12px;background:rgba(29,67,128,0.06);border-radius:var(--radius-sm);border:1px solid rgba(29,67,128,0.15)">'
                + '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">'
                  + 'Paste one invoice per line, in this order: <strong>date, invoice #, amount</strong>.<br>'
                  + 'Separators: comma, tab, or 2+ spaces. Dates: <code style="background:rgba(0,0,0,0.05);padding:1px 4px;border-radius:3px">MM/DD/YY</code> or <code style="background:rgba(0,0,0,0.05);padding:1px 4px;border-radius:3px">YYYY-MM-DD</code>. Amount can include <code style="background:rgba(0,0,0,0.05);padding:1px 4px;border-radius:3px">$</code> or <code style="background:rgba(0,0,0,0.05);padding:1px 4px;border-radius:3px">*</code>.'
                + '</div>'
                + '<textarea id="inv-bulk-text-'+e.id+'" placeholder="04/08/26, 55587271, $*652.28&#10;04/10/26, 55670042, 59.70&#10;04/06/26, 55454142, 74.94" style="width:100%;min-height:120px;padding:8px 10px;font-size:12px;font-family:DM Mono,monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box;resize:vertical"></textarea>'
                + '<div style="display:flex;gap:8px;margin-top:8px;align-items:center">'
                  + '<button onclick="window.runBulkImport(\''+e.id+'\',\''+worker+'\')" class="btn btn-primary btn-sm" style="font-size:12px">Import</button>'
                  + '<button onclick="window.toggleBulkImport(\''+e.id+'\')" class="btn btn-ghost btn-sm" style="font-size:12px">Cancel</button>'
                  + '<span id="inv-bulk-status-'+e.id+'" style="font-size:11px;color:var(--text-faint);margin-left:6px"></span>'
                + '</div>'
              + '</div>'
              + '</div>';
            panel.innerHTML = html;
          })();

          // Toggle panel visibility on row click — but ignore clicks on the
          // action buttons (✎ ✏ 🗑) so editing/deleting still works.
          row.addEventListener('click', function(ev) {
            if(ev.target.closest('button')) return;
            const open = panel.style.display !== 'none';
            panel.style.display = open ? 'none' : 'block';
          });

          groupBox.appendChild(panel);
        }
        });

        wrap.appendChild(groupBox);
      });
    }

    // ── Distributions list ───────────────────────────────────────────────────
    // Investment payback progress bar (if investments exist)
    const investEntries = entries.filter(e=>e.cat==='initial-invest');
    if(investEntries.length > 0 || totalInvestPaid > 0) {
      const investBar = document.createElement('div');
      investBar.style.cssText = 'margin:10px 0 14px;padding:10px 12px;background:rgba(29,83,198,0.06);border:1px solid rgba(29,83,198,0.2);border-radius:6px';
      const pct = totalInvest > 0 ? Math.min(100, (totalInvestPaid/totalInvest)*100) : 0;
      investBar.innerHTML = '<div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:var(--info);margin-bottom:6px">'
        +'<span>Investment Payback Progress</span>'
        +'<span>'+_fmt(totalInvestPaid)+' / '+_fmt(totalInvest)+'</span></div>'
        +'<div style="background:rgba(29,83,198,0.15);border-radius:10px;height:8px;overflow:hidden">'
          +'<div style="background:var(--info);height:100%;border-radius:10px;width:'+pct.toFixed(1)+'%;transition:width .3s"></div>'
        +'</div>'
        +'<div style="font-size:11px;color:var(--text-faint);margin-top:5px">'+_fmt(investOwed)+' remaining to pay back</div>';
      wrap.appendChild(investBar);
    }

    const dLabel = document.createElement('div');
    dLabel.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);margin:14px 0 6px';
    dLabel.textContent = 'Payout History';
    wrap.appendChild(dLabel);

    if(!sortedD.length) {
      const empty2 = document.createElement('div');
      empty2.className = 'empty-state'; empty2.style.fontSize = '12px';
      empty2.textContent = 'No payouts yet'; wrap.appendChild(empty2);
    } else {
      sortedD.forEach(function(d) {
        const row = document.createElement('div');
        // Same two-zone flex layout used by the entry list above for visual consistency.
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:14px;padding:11px 8px;border-bottom:1px solid var(--border);border-radius:4px;transition:background .12s';
        row.addEventListener('mouseenter', function() { row.style.background = 'rgba(0,0,0,0.025)'; });
        row.addEventListener('mouseleave', function() { row.style.background = ''; });

        // Left: title (Distribution + ref#) + meta line (date · notes)
        const left = document.createElement('div');
        left.style.cssText = 'min-width:0;flex:1';
        const refTag = d.refNum
          ? '<span style="font-size:10px;font-family:DM Mono,monospace;color:var(--text-faint);margin-left:8px;font-weight:500">'+d.refNum+'</span>'
          : '';
        const metaParts = [];
        if(d.date)  metaParts.push(_fmtD(d.date));
        if(d.notes) metaParts.push(d.notes);
        const metaLine = metaParts.length
          ? '<div style="font-size:11px;color:var(--text-faint);margin-top:4px;line-height:1.4">'+metaParts.map(function(s){return String(s).replace(/[<>&]/g,function(c){return ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c];});}).join('<span style="margin:0 6px;opacity:.5">·</span>')+'</div>'
          : '';
        left.innerHTML =
          '<div style="font-size:13px;font-weight:600;color:#2d6a4f;line-height:1.3">Payout'+refTag+'</div>'
          + metaLine;

        // Right: hover-only action icons + amount
        const right = document.createElement('div');
        right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:2px;opacity:0;transition:opacity .12s';
        row.addEventListener('mouseenter', function() { actions.style.opacity = '1'; });
        row.addEventListener('mouseleave', function() { actions.style.opacity = '0'; });

        // Preview — opens the saved sheet in the modal's preview view.
        // Only offered for new-format distributions (those with lineItems);
        // legacy records have nothing itemized to display, so skip the button.
        if(d.lineItems && d.lineItems.length && typeof window.openDistributionPreview === 'function') {
          const viewBtn = document.createElement('button');
          viewBtn.innerHTML = '👁';
          viewBtn.title = 'Preview';
          viewBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;padding:4px 7px;border-radius:4px;line-height:1';
          viewBtn.addEventListener('mouseenter', function() { viewBtn.style.background = 'rgba(0,0,0,0.06)'; });
          viewBtn.addEventListener('mouseleave', function() { viewBtn.style.background = 'none'; });
          (function(dist, w) {
            viewBtn.addEventListener('click', function() { window.openDistributionPreview(dist, w); });
          })(d, worker);
          actions.appendChild(viewBtn);
        }

        // PDF — re-generates the PDF for the saved distribution
        if(typeof window.redownloadDistributionPDF === 'function') {
          const pdfBtn = document.createElement('button');
          pdfBtn.innerHTML = '📄';
          pdfBtn.title = 'Download PDF';
          pdfBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:13px;padding:4px 7px;border-radius:4px;line-height:1';
          pdfBtn.addEventListener('mouseenter', function() { pdfBtn.style.background = 'rgba(29,83,198,0.12)'; });
          pdfBtn.addEventListener('mouseleave', function() { pdfBtn.style.background = 'none'; });
          (function(dist, w) {
            pdfBtn.addEventListener('click', function() { window.redownloadDistributionPDF(dist, w); });
          })(d, worker);
          actions.appendChild(pdfBtn);
        }

        // Delete (only when canEdit)
        if(canEdit) {
          const delBtn = document.createElement('button');
          delBtn.innerHTML = '🗑';
          delBtn.title = 'Delete';
          delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;padding:4px 7px;border-radius:4px;line-height:1;opacity:.7';
          delBtn.addEventListener('mouseenter', function() { delBtn.style.background = 'rgba(239,68,68,0.12)'; delBtn.style.opacity = '1'; });
          delBtn.addEventListener('mouseleave', function() { delBtn.style.background = 'none'; delBtn.style.opacity = '.7'; });
          (function(did, dw) {
            delBtn.addEventListener('click', function() { window.deleteDistribution(did, dw); });
          })(d.id, worker);
          actions.appendChild(delBtn);
        }
        right.appendChild(actions);

        // Amount block
        const amtCol = document.createElement('div');
        amtCol.style.cssText = 'text-align:right;min-width:108px';
        amtCol.innerHTML = '<div style="font-size:14px;font-weight:700;color:#2d6a4f;font-family:DM Mono,monospace;line-height:1.2">'+_fmt(d.amount)+'</div>';
        right.appendChild(amtCol);

        row.appendChild(left); row.appendChild(right);
        wrap.appendChild(row);
      });
    }

    container.appendChild(wrap);

    setTimeout(function() {
      var saveBtn    = document.getElementById('payout-save-'+worker);
      var cancelBtn  = document.getElementById('payout-cancel-'+worker);
      if(saveBtn)    saveBtn.addEventListener('click', function() { window.savePayoutEntry(worker); });
      if(cancelBtn)  cancelBtn.addEventListener('click', function() { window.cancelPayoutEntry(worker); });
    }, 0);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.renderPayoutTab = async function() {
    // Load the exact same formula payments.js uses
    if(typeof window._loadPIFormula === 'function') await window._loadPIFormula();
    else await loadAtlasFormula();
    // Load cases + preop if not yet available
    if(!window.cases || !window.cases.length) {
      try { window.cases = await _loadAllCases(); } catch(e) {}
    }
    if(!window._rawPreopRecords || !window._rawPreopRecords.length) {
      try { const s = await getDoc(doc(db,'atlas','preop')); if(s.exists()) window._rawPreopRecords = s.data().records||[]; } catch(e) {}
    }
    // Personal-income formula is gone — E&D reads self-pay straight off
    // case-income entries instead. Just load the entries and render.
    const data = await _load();
    const me = currentUser ? (EMAIL_WORKER_MAP[currentUser.email.toLowerCase()]||'dev') : 'dev';
    const el = document.getElementById('payout-sections');
    if(!el) return;
    el.innerHTML = '';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:18px';
    el.appendChild(grid);
    _buildSection('dev',  me==='dev',  data, grid);
    _buildSection('josh', me==='josh', data, grid);
  };

  window.showAddPayoutExpense = function(w) {
    var f = document.getElementById('payout-add-form-'+w);
    var d = document.getElementById('payout-dist-form-'+w);
    if(f) { f.innerHTML = _entryFormHTML(w, false); f.style.display=''; }
    if(d) d.style.display='none';
    // Re-wire buttons
    setTimeout(function() {
      var sb = document.getElementById('payout-save-'+w);
      var cb = document.getElementById('payout-cancel-'+w);
      if(sb) sb.addEventListener('click', function() { window.savePayoutEntry(w); });
      if(cb) cb.addEventListener('click', function() { window.cancelPayoutEntry(w); });
    }, 0);
  };

  window.editPayoutEntry = function(e, w) {
    var f = document.getElementById('payout-add-form-'+w);
    var d = document.getElementById('payout-dist-form-'+w);
    if(f) { f.innerHTML = _entryFormHTML(w, true); f.style.display=''; }
    if(d) d.style.display='none';
    // Populate fields
    setTimeout(async function() {
      var n = document.getElementById('payout-name-'+w); if(n) n.value = e.name||e.desc||'';
      var c = document.getElementById('payout-cat-'+w);  if(c) c.value = e.cat||'expense';
      var a = document.getElementById('payout-amount-'+w); if(a) a.value = e.amount||'';
      var s = document.getElementById('payout-supplier-'+w); if(s) s.value = e.supplier||'';
      var dt= document.getElementById('payout-date-'+w);   if(dt) dt.value = e.date||'';
      var nt= document.getElementById('payout-notes-'+w);  if(nt) nt.value = e.notes||'';
      var ei= document.getElementById('payout-editing-id-'+w); if(ei) ei.value = e.id;
      // For initial-invest entries, swap to the vendor dropdown and select
      // the existing vendor name so the user sees it pre-picked.
      if(e.cat === 'initial-invest') {
        await window._onPayoutCatChange(w);
        var vsel = document.getElementById('payout-vendor-'+w);
        if(vsel) {
          // Try to match the existing name; if not in the list (rare), keep
          // the hidden Name field as the source of truth.
          var found = Array.from(vsel.options).some(function(o) { return o.value === (e.name||''); });
          if(found) vsel.value = e.name || '';
          // Append a "Rename current vendor" sentinel option that, when picked,
          // reveals the new-vendor text field pre-filled with the current
          // name so the user can edit it in place. Only shown in edit mode.
          if(e.name) {
            var renameOpt = document.createElement('option');
            renameOpt.value = '__rename__';
            renameOpt.textContent = '✎ Rename "' + e.name + '"…';
            vsel.appendChild(renameOpt);
          }
        }
        // Lock the manual Amount field for entries with invoices — it's
        // derived from the invoice list and shouldn't be edited directly.
        if(Array.isArray(e.invoices) && e.invoices.length) {
          if(a) {
            a.readOnly = true;
            a.title = 'Amount is the sum of invoices. Edit invoices in the row below.';
            a.style.background = 'var(--surface2)';
            a.style.cursor = 'not-allowed';
          }
        }
      }
      var sb = document.getElementById('payout-save-'+w);
      var cb = document.getElementById('payout-cancel-'+w);
      if(sb) sb.addEventListener('click', function() { window.savePayoutEntry(w); });
      if(cb) cb.addEventListener('click', function() { window.cancelPayoutEntry(w); });
    }, 0);
  };

  window.cancelPayoutEntry = function(w) {
    var f = document.getElementById('payout-add-form-'+w); if(f) f.style.display='none';
  };

  window.savePayoutEntry = async function(w) {
    var cat      = document.getElementById('payout-cat-'+w).value;
    // Resolve the entry's display name. For Initial Investment, use the
    // vendor dropdown (or the "new vendor" text field if "+ New" is picked).
    // For other types, fall back to the standard Name input.
    var name = '';
    if(cat === 'initial-invest') {
      var vendorSel = document.getElementById('payout-vendor-'+w);
      var vendorNew = document.getElementById('payout-vendor-new-'+w);
      // Both "+ New vendor" and "✎ Rename current vendor" use the same
      // text input — its value is the vendor name to save.
      if(vendorSel && (vendorSel.value === '__new__' || vendorSel.value === '__rename__')) {
        name = (vendorNew && vendorNew.value || '').trim();
      } else if(vendorSel) {
        name = (vendorSel.value || '').trim();
      }
      if(!name) {
        name = (document.getElementById('payout-name-'+w).value||'').trim();
      }
    } else {
      name = (document.getElementById('payout-name-'+w).value||'').trim();
    }
    var amount   = parseFloat(document.getElementById('payout-amount-'+w).value)||0;
    var supplier = (document.getElementById('payout-supplier-'+w).value||'').trim();
    var date     = document.getElementById('payout-date-'+w).value || null;
    var notes    = (document.getElementById('payout-notes-'+w).value||'').trim();
    var editingId= (document.getElementById('payout-editing-id-'+w).value||'').trim();
    if(!name)   { alert(cat === 'initial-invest' ? 'Please pick or enter a vendor.' : 'Please enter a name.'); return; }
    if(!amount && cat !== 'initial-invest') { alert('Please enter an amount.'); return; }
    var data = await _load();
    if(!data.entries) data.entries = [];
    if(editingId) {
      // Update existing — preserve the invoices array if it exists; if the
      // entry has invoices, the form's manual amount is ignored in favor of
      // the derived sum.
      var idx = data.entries.findIndex(function(e){return e.id===editingId;});
      if(idx !== -1) {
        var existing = data.entries[idx];
        var derivedAmt = (Array.isArray(existing.invoices) && existing.invoices.length)
          ? _sumInvoices(existing)
          : amount;
        data.entries[idx] = Object.assign({}, existing, {name,cat,amount:derivedAmt,supplier,date,notes,updatedAt:new Date().toISOString()});
      }
    } else {
      data.entries.push({id:_uid(),worker:w,cat,name,supplier,date,amount,notes,createdAt:new Date().toISOString()});
    }
    await _save(data);
    renderPayoutTab();
  };

  window.deletePayoutEntry = async function(id, w) {
    if(!confirm('Delete this entry?')) return;
    var data = await _load();
    data.entries = (data.entries||[]).filter(function(e){return e.id!==id;});
    await _save(data);
    renderPayoutTab();
  };

  // ── Initial Investment per-invoice tracking ────────────────────────────────
  // Each initial-invest entry can carry an `invoices` array of
  //   { id, date, invoiceNumber, amount, createdAt }
  // The entry's top-level .amount is always kept in sync with the sum of
  // these invoices (so totals/payback/distribution math stays untouched).
  // Legacy entries with no invoices array continue to use their stored
  // .amount; once the user adds the first invoice, the entry switches to
  // derived-amount mode.
  window.addEDInvoice = async function(entryId, w) {
    var dateEl = document.getElementById('inv-add-date-' + entryId);
    var numEl  = document.getElementById('inv-add-num-'  + entryId);
    var amtEl  = document.getElementById('inv-add-amt-'  + entryId);
    if(!dateEl || !numEl || !amtEl) return;
    var date    = dateEl.value || null;
    var invNum  = (numEl.value || '').trim();
    var amount  = parseFloat(amtEl.value) || 0;
    if(!amount) { alert('Please enter an amount.'); amtEl.focus(); return; }
    if(!date)   { alert('Please pick a date.');     dateEl.focus(); return; }
    var data = await _load();
    var idx  = (data.entries || []).findIndex(function(e) { return e.id === entryId; });
    if(idx === -1) { alert('Entry not found — was it deleted?'); return; }
    var entry = data.entries[idx];
    if(!Array.isArray(entry.invoices)) entry.invoices = [];
    entry.invoices.push({
      id:            _uid(),
      date:          date,
      invoiceNumber: invNum,
      amount:        amount,
      createdAt:     new Date().toISOString()
    });
    // Derived total — keeps the rest of the app's math working without
    // needing to know about the invoices array.
    entry.amount    = _sumInvoices(entry);
    entry.updatedAt = new Date().toISOString();
    await _save(data);
    renderPayoutTab();
  };

  window.deleteEDInvoice = async function(entryId, invoiceId, w) {
    if(!confirm('Delete this invoice?')) return;
    var data = await _load();
    var idx  = (data.entries || []).findIndex(function(e) { return e.id === entryId; });
    if(idx === -1) return;
    var entry = data.entries[idx];
    if(!Array.isArray(entry.invoices)) return;
    entry.invoices = entry.invoices.filter(function(inv) { return inv.id !== invoiceId; });
    entry.amount    = _sumInvoices(entry);
    entry.updatedAt = new Date().toISOString();
    await _save(data);
    renderPayoutTab();
  };

  // Toggle the bulk-import panel visibility.
  window.toggleBulkImport = function(entryId) {
    var wrap = document.getElementById('inv-bulk-wrap-' + entryId);
    if(!wrap) return;
    var open = wrap.style.display !== 'none';
    wrap.style.display = open ? 'none' : 'block';
    if(!open) {
      var ta = document.getElementById('inv-bulk-text-' + entryId);
      if(ta) ta.focus();
      var status = document.getElementById('inv-bulk-status-' + entryId);
      if(status) status.textContent = '';
    }
  };

  // Parse a single bulk-import line into an invoice object, or return an
  // {error} object if it's malformed. Lenient on separators (tab, comma,
  // multi-space) and on date/amount formatting (handles $, *, MM/DD/YY,
  // MM/DD/YYYY, YYYY-MM-DD).
  function _parseBulkInvoiceLine(rawLine) {
    var line = (rawLine || '').trim();
    if(!line) return null; // blank line — skip silently
    var parts = line.split(/\t|,|\s{2,}/).map(function(p) { return p.trim(); }).filter(Boolean);
    if(parts.length < 3) {
      return { error: 'Need 3 fields (date, invoice #, amount)' };
    }
    // If user pasted more than 3 fields, treat the first as date, the last
    // as amount, and join the middle as the invoice number.
    var dateStr = parts[0];
    var amtStr  = parts[parts.length - 1];
    var invNum  = parts.slice(1, parts.length - 1).join(' ');
    // Date — accept YYYY-MM-DD or M/D/YY or MM/DD/YYYY etc.
    var date = null;
    var iso = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    var us  = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if(iso) {
      date = iso[1] + '-' + iso[2].padStart(2,'0') + '-' + iso[3].padStart(2,'0');
    } else if(us) {
      var yyyy = us[3].length === 2 ? '20' + us[3] : us[3];
      date = yyyy + '-' + us[1].padStart(2,'0') + '-' + us[2].padStart(2,'0');
    } else {
      return { error: 'Bad date "' + dateStr + '"' };
    }
    // Amount — strip $, *, commas, whitespace
    var clean = amtStr.replace(/[$*,\s]/g, '');
    var amount = parseFloat(clean);
    if(!(amount > 0)) {
      return { error: 'Bad amount "' + amtStr + '"' };
    }
    return { date: date, invoiceNumber: invNum, amount: amount };
  }

  window.runBulkImport = async function(entryId, w) {
    var ta     = document.getElementById('inv-bulk-text-' + entryId);
    var status = document.getElementById('inv-bulk-status-' + entryId);
    if(!ta) return;
    var lines = (ta.value || '').split(/\r?\n/);
    var parsed = [];
    var errors = [];
    lines.forEach(function(line, i) {
      var result = _parseBulkInvoiceLine(line);
      if(result === null) return; // blank
      if(result.error) {
        errors.push('Line ' + (i + 1) + ': ' + result.error);
      } else {
        parsed.push(result);
      }
    });
    if(!parsed.length && !errors.length) {
      if(status) status.textContent = 'No data to import.';
      return;
    }
    // Confirmation summary before writing
    var confirmMsg = 'Import ' + parsed.length + ' invoice' + (parsed.length === 1 ? '' : 's') + '?';
    if(errors.length) {
      confirmMsg += '\n\n' + errors.length + ' line(s) had errors and will be skipped:\n' + errors.slice(0, 5).join('\n');
      if(errors.length > 5) confirmMsg += '\n…and ' + (errors.length - 5) + ' more';
    }
    if(parsed.length && !confirm(confirmMsg)) return;
    if(!parsed.length) {
      if(status) status.innerHTML = '<span style="color:var(--warn)">No valid rows to import.</span>';
      return;
    }
    // One Firestore write for the whole batch — much faster than 18 sequential writes.
    var data = await _load();
    var idx  = (data.entries || []).findIndex(function(e) { return e.id === entryId; });
    if(idx === -1) { alert('Entry not found — was it deleted?'); return; }
    var entry = data.entries[idx];
    if(!Array.isArray(entry.invoices)) entry.invoices = [];
    var nowIso = new Date().toISOString();
    parsed.forEach(function(inv) {
      entry.invoices.push({
        id:            _uid(),
        date:          inv.date,
        invoiceNumber: inv.invoiceNumber,
        amount:        inv.amount,
        createdAt:     nowIso
      });
    });
    entry.amount    = _sumInvoices(entry);
    entry.updatedAt = nowIso;
    await _save(data);
    renderPayoutTab();
  };

  // Record Distribution flow now lives in distribution-modal.js:
  //   window.openDistributionModal(worker)      — opens the new builder modal
  //   window.redownloadDistributionPDF(dist, w) — regenerates a saved PDF
  // The old inline form, showRecordDistribution, cancelDistribution,
  // saveDistribution, and the old redownloadDistributionPDF were removed.

  window.deleteDistribution = async function(id, w) {
    if(!confirm('Delete this payout?')) return;
    var data = await _load();
    data.distributions = (data.distributions||[]).filter(function(d){return d.id!==id;});
    await _save(data);
    renderPayoutTab();
  };

  // ── Month-end salary review ────────────────────────────────────────────────
  // Lists every case-income entry for the chosen worker + month, with what
  // was invoiced and what self-pay was entered. Confirming stamps a
  // reviewedAt marker on atlas/payout_reviews so the row shows as locked
  // afterwards. Once locked, case-income self-pay edits for that month are
  // discouraged (we don't prevent edits — Firestore-level locking would
  // require rules — but the UI shows the lock state).
  const REVIEWS_DOC = 'payout_reviews';
  async function _loadReviews() {
    try { const s = await getDoc(doc(db, 'atlas', REVIEWS_DOC));
          return s.exists() ? (s.data() || { months: {} }) : { months: {} };
    } catch(e) { return { months: {} }; }
  }
  async function _saveReviews(data) {
    await setDoc(doc(db, 'atlas', REVIEWS_DOC), data);
  }

  window.openMonthEndReview = async function(worker) {
    const prior = document.getElementById('monthEndReviewModal');
    if(prior) prior.remove();
    const wrap = document.createElement('div');
    wrap.id = 'monthEndReviewModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };

    // Pick the previous calendar month by default — typical "review last
    // month before paying salary" cadence.
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const defaultMonth = last.getFullYear() + '-' + String(last.getMonth()+1).padStart(2,'0');

    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:820px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#166534;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#bbf7d0;margin-bottom:3px">Salary Review</div><div style="font-size:16px;font-weight:600">Month-End — ${worker==='dev'?'Devarsh':'Josh'}</div></div>
        <button onclick="document.getElementById('monthEndReviewModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button>
      </div>
      <div style="padding:20px 22px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
          <div style="font-size:13px;color:var(--text-muted)">Review the month before paying yourself. Confirming stamps a locked marker so Atlas knows the month is reconciled.</div>
          <div style="display:flex;align-items:center;gap:8px">
            <label style="margin:0;font-size:12px;color:var(--text-muted)">Month:</label>
            <input type="month" id="mer-month" value="${defaultMonth}" onchange="window._merRenderRows('${worker}')" style="padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);outline:none">
          </div>
        </div>
        <div id="mer-body" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px"></div>
        <div id="mer-status" style="font-size:13px;padding:6px 0;min-height:18px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--border)">
          <button class="btn btn-ghost" onclick="document.getElementById('monthEndReviewModal').remove()">Close</button>
          <button id="mer-confirm-btn" class="btn btn-primary" onclick="window._merConfirm('${worker}')" style="background:#166534;border-color:#166534">✓ Mark Month Reviewed</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    window._merRenderRows(worker);
  };

  window._merRenderRows = async function(worker) {
    const monthVal = document.getElementById('mer-month')?.value || '';
    const body = document.getElementById('mer-body');
    if(!body) return;
    body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint);font-size:13px">Loading…</div>';
    const [data, reviews] = await Promise.all([_load(), _loadReviews()]);
    const entries = (data.entries || [])
      .filter(e => e.worker === worker && e.cat === 'case-income')
      .filter(e => (e.date || '').slice(0,7) === monthVal)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const reviewKey = worker + '|' + monthVal;
    const reviewed = reviews.months && reviews.months[reviewKey];
    const totalInv  = entries.reduce((s,e) => s + (e.amount || 0), 0);
    const totalPay  = entries.reduce((s,e) => s + _entrySelfPay(e), 0);
    const monthLabel = monthVal
      ? new Date(monthVal + '-01T12:00:00Z').toLocaleDateString('en-US', { month:'long', year:'numeric' })
      : 'Unselected';

    if(!entries.length) {
      body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint);font-size:13px">No case invoices in '+monthLabel+' for this worker.</div>';
      _merUpdateStatus(reviewed, monthLabel, 0, 0);
      return;
    }

    const headerCss = 'display:grid;grid-template-columns:1.2fr 100px 130px 130px;gap:8px;padding:10px 14px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)';
    const rowCss    = 'display:grid;grid-template-columns:1.2fr 100px 130px 130px;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;align-items:center';
    let html = `<div style="${headerCss}"><span>Case</span><span>Date</span><span style="text-align:right">Invoiced</span><span style="text-align:right">Self-Pay</span></div>`;
    entries.forEach(e => {
      const dateTxt = e.date ? new Date(e.date + 'T12:00:00Z').toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '—';
      const center = (e.notes || '').replace(/^Center:\s*/, '');
      const inv = e.amount || 0;
      const sp  = _entrySelfPay(e);
      // Self-pay column is inline-editable so the worker can backfill old
      // entries (most legacy case-income rows have no selfPay set, since the
      // field didn't exist when they were synced) right from the review.
      const spInput = `<input type="number" step="0.01" min="0" value="${(sp || 0).toFixed(2)}" data-entry-id="${e.id}" onchange="window._merSaveSelfPay('${worker}','${e.id}',this.value)" style="width:110px;padding:5px 8px;font-family:DM Mono,monospace;font-size:13px;font-weight:700;color:#166534;border:1px solid #86efac;border-radius:6px;background:#f0fdf4;text-align:right;outline:none">`;
      html += `<div style="${rowCss}">
        <div><div style="font-weight:600;font-family:DM Mono,monospace;font-size:12px">${e.name || e.caseId || ''}</div>${center ? '<div style="font-size:11px;color:var(--text-faint)">'+center+'</div>' : ''}</div>
        <div style="color:var(--text-muted);font-size:12px">${dateTxt}</div>
        <div style="text-align:right;font-family:DM Mono,monospace">${_fmt(inv)}</div>
        <div style="text-align:right">${spInput}</div>
      </div>`;
    });
    html += `<div style="${rowCss};background:#f0fdf4;border-top:2px solid #86efac;font-weight:700">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#166534">Totals · ${entries.length} ${entries.length===1?'case':'cases'}</div>
      <div></div>
      <div style="text-align:right;font-family:DM Mono,monospace">${_fmt(totalInv)}</div>
      <div style="text-align:right;font-family:DM Mono,monospace;color:#166534">${_fmt(totalPay)}</div>
    </div>`;
    body.innerHTML = html;
    _merUpdateStatus(reviewed, monthLabel, entries.length, totalPay);
  };

  // Inline edit: write a new self-pay value back to the case-income entry
  // straight from the review modal. Used to backfill historical entries that
  // were synced before the selfPay field existed.
  window._merSaveSelfPay = async function(worker, entryId, newVal) {
    const val = parseFloat(newVal);
    if(Number.isNaN(val) || val < 0) { alert('Self-pay must be a non-negative number.'); window._merRenderRows(worker); return; }
    try {
      const data = await _load();
      const idx = (data.entries || []).findIndex(e => e.id === entryId);
      if(idx === -1) { alert('Entry not found — try reopening the modal.'); return; }
      data.entries[idx].selfPay = val;
      // Drop the legacy field so we don't double-source; selfPay is now
      // authoritative going forward.
      delete data.entries[idx].personalIncome;
      data.entries[idx].syncedAt = new Date().toISOString();
      await _save(data);
      try { logAudit && logAudit('case-income-selfpay-edit', entryId, '$' + val.toFixed(2)); } catch(e){}
      // Re-render the modal totals so the footer updates immediately.
      window._merRenderRows(worker);
      // Also refresh E&D in the background if it's the active tab.
      if(typeof renderPayoutTab === 'function') renderPayoutTab();
    } catch(err) { alert('Could not save self-pay: ' + (err.message || err)); }
  };

  function _merUpdateStatus(reviewed, monthLabel, count, totalPay) {
    const status = document.getElementById('mer-status');
    const btn = document.getElementById('mer-confirm-btn');
    if(!status || !btn) return;
    if(reviewed) {
      const at = reviewed.reviewedAt ? new Date(reviewed.reviewedAt).toLocaleString('en-US', {dateStyle:'medium', timeStyle:'short'}) : '';
      status.innerHTML = '🔒 <strong>Locked</strong> — reviewed' + (at ? ' on ' + at : '') + (reviewed.reviewedBy ? ' by ' + reviewed.reviewedBy : '') + '.';
      status.style.color = '#166534';
      btn.textContent = '✗ Unlock Month';
      btn.style.background = '#b45309';
      btn.style.borderColor = '#b45309';
    } else {
      status.textContent = count ? (count + ' case' + (count===1?'':'s') + ' · paying yourself ' + _fmt(totalPay) + ' for ' + monthLabel) : '';
      status.style.color = 'var(--text-muted)';
      btn.textContent = '✓ Mark Month Reviewed';
      btn.style.background = '#166534';
      btn.style.borderColor = '#166534';
    }
  }

  window._merConfirm = async function(worker) {
    const monthVal = document.getElementById('mer-month')?.value || '';
    if(!monthVal) return;
    const status = document.getElementById('mer-status');
    const btn = document.getElementById('mer-confirm-btn');
    btn.disabled = true;
    try {
      const reviews = await _loadReviews();
      if(!reviews.months) reviews.months = {};
      const key = worker + '|' + monthVal;
      if(reviews.months[key]) {
        if(!confirm('This month is already locked. Unlock it?')) { btn.disabled = false; return; }
        delete reviews.months[key];
      } else {
        // Snapshot the totals at lock time so retrospective reports stay
        // honest even if someone edits case-income entries later.
        const data = await _load();
        const entries = (data.entries || []).filter(e => e.worker === worker && e.cat === 'case-income' && (e.date || '').slice(0,7) === monthVal);
        const totalInv = entries.reduce((s,e) => s + (e.amount || 0), 0);
        const totalPay = entries.reduce((s,e) => s + _entrySelfPay(e), 0);
        reviews.months[key] = {
          worker, month: monthVal,
          reviewedAt: new Date().toISOString(),
          reviewedBy: (currentUser?.email) || '',
          caseCount: entries.length,
          totalInvoiced: totalInv,
          totalSelfPay: totalPay
        };
      }
      await _saveReviews(reviews);
      try { logAudit && logAudit('month-review-toggle', worker + '|' + monthVal); } catch(e){}
      window._merRenderRows(worker);
    } catch(err) {
      if(status) { status.textContent = '✗ ' + (err.message || err); status.style.color = '#b91c1c'; }
    } finally {
      btn.disabled = false;
    }
  };

})();

// -- ITEM SELECT --
function refreshItemSelect() {
const sel=document.getElementById('addItemSelect');if(!sel)return;
sel.innerHTML='<option value="">— Select an item to add —</option>';
const used=new Set(caseItems.map(i=>i.id));
linkCSInvIds();
[...items].filter(i=>!used.has(i.id) && !isCSItem(i)).sort((a,b)=>a.generic.localeCompare(b.generic)).forEach(item=>{
const stock=getStock(item,currentWorker);
const opt=document.createElement('option');
opt.value=item.id;
opt.textContent=`${item.generic} — $${item.costPerUnit.toFixed(2)} (${stock} in stock)`;
sel.appendChild(opt);
});
}
window.addCaseItem = function() {
const sel=document.getElementById('addItemSelect');
const id=sel.value;if(!id)return;
const inv=items.find(i=>i.id===id);if(!inv)return;
caseItems.push({id:inv.id,generic:inv.generic,name:inv.name,cost:inv.costPerUnit,qty:1,stock:getStock(inv,currentWorker)});
renderCaseSupplies();refreshItemSelect();
};
function renderCaseSupplies() {
const container=document.getElementById('caseSupplyRows');
const warnings=document.getElementById('lowStockWarnings');
container.innerHTML='';warnings.innerHTML='';
let total=0;let lowList=[];
caseItems.forEach((item,idx)=>{
const line=item.cost*item.qty;total+=line;
const remaining=item.stock-item.qty;
const inv=items.find(i=>i.id===item.id);
const al=inv?inv.alert:0;
if(remaining<=al) lowList.push(item.generic);
const row=document.createElement('div');row.className='supply-row';
row.innerHTML=`
<div style="font-size:13px;font-weight:500">${item.generic}
<div style="font-size:11px;color:var(--text-faint)">${item.name}</div></div><div style="font-size:13px;font-family:'DM Mono',monospace">$${item.cost.toFixed(2)}</div><div><span class="stock-badge ${remaining<0?'stock-critical':remaining<=al?'stock-low':'stock-ok'}">${item.stock}</span></div><div><input type="number" min="0" value="${item.qty}" style="width:70px;text-align:center"></div><div style="font-size:14px;font-weight:500;font-family:'DM Mono',monospace">$${line.toFixed(2)}</div><button style="background:none;border:none;cursor:pointer;color:var(--text-faint);font-size:18px;line-height:1">×</button>`;
// Attach events directly using closure — no stale index issues
const qtyInput = row.querySelector('input[type="number"]');
qtyInput.setAttribute('step', '0.5');
const removeBtn = row.querySelector('button');
const capturedIdx = idx;
qtyInput.addEventListener('change', function() {
caseItems[capturedIdx].qty = Math.max(0, parseFloat(this.value)||0);
renderCaseSupplies();
});
removeBtn.addEventListener('click', function() {
caseItems.splice(capturedIdx, 1);
renderCaseSupplies();
refreshItemSelect();
});
container.appendChild(row);
});
// Add CS estimated cost to total display
const csTotal = csEntries.reduce((sum, entry) => {
const cpm = getCostPerMG(entry.drug);
const mg = (parseFloat(entry.amountGiven)||0) + (parseFloat(entry.wastedAmt)||0);
return sum + cpm * mg;
}, 0);
const grandTotal = total + csTotal;
document.getElementById('caseTotalDisplay').textContent='$'+grandTotal.toFixed(2);
if(lowList.length) warnings.innerHTML=`<div class="alert alert-warn">⚠ Low stock after this case: ${lowList.join(', ')}</div>`;
renderLiveSummary(total, csTotal);
}
function renderLiveSummary(total, csTotal) { if(csTotal===undefined) csTotal=0;
const el=document.getElementById('liveSummary');
const grandTotal = total + csTotal;
if(!caseItems.length && csTotal===0){el.innerHTML='<div class="empty-state">Add supplies below to see cost summary</div>';return;}
const byCategory={};
caseItems.forEach(item=>{const inv=items.find(i=>i.id===item.id);const cat=inv?inv.category:'Other';byCategory[cat]=(byCategory[cat]||0)+item.cost*item.qty;});
let html='';
Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).forEach(([cat,amt])=>{
const pct=grandTotal>0?Math.round((amt/grandTotal)*100):0;
html+=`<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px"><span style="color:var(--text-muted)">${cat}</span><span style="font-family:'DM Mono',monospace;font-weight:500">$${amt.toFixed(2)}</span></div><div style="background:var(--surface2);border-radius:3px;height:5px"><div style="width:${pct}%;height:100%;background:var(--info);border-radius:3px"></div></div></div>`;
});
// Add CS row if any
if(csTotal > 0) {
const csPct = grandTotal>0 ? Math.round((csTotal/grandTotal)*100) : 0;
html+=`<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px"><span style="color:var(--warn)">Controlled Substances <span style="font-size:10px">(est.)</span></span><span style="font-family:'DM Mono',monospace;font-weight:500;color:var(--warn)">≈ $${csTotal.toFixed(2)}</span></div><div style="background:var(--surface2);border-radius:3px;height:5px"><div style="width:${csPct}%;height:100%;background:var(--warn);border-radius:3px"></div></div></div>`;
}
html+=`<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
${csTotal>0?`<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-faint);margin-bottom:4px"><span>Supplies</span><span style="font-family:'DM Mono',monospace">$${total.toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--warn);margin-bottom:6px"><span>CS (est.)</span><span style="font-family:'DM Mono',monospace">≈ $${csTotal.toFixed(2)}</span></div>`:''}
<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:12px;font-weight:600;color:var(--text-muted)">TOTAL</span><span style="font-size:19px;font-weight:500;font-family:'DM Mono',monospace;color:var(--info)">$${grandTotal.toFixed(2)}</span></div></div>`;
el.innerHTML=html;
}
window.updateQty=(idx,val)=>{caseItems[idx].qty=Math.max(0,parseInt(val)||0);renderCaseSupplies();};
window.removeItem=(idx)=>{caseItems.splice(idx,1);renderCaseSupplies();refreshItemSelect();};
// -- IMAGE --
// Helper: read the photos saved on a case, falling back to the legacy single
// imageData string if no new-format images array is present.
function caseImages(c) {
  if(!c) return [];
  if(Array.isArray(c.images) && c.images.length) return c.images;
  if(c.imageData) return [{ id: 'legacy', dataUrl: c.imageData }];
  return [];
}
window.caseImages = caseImages;

// Resize + JPEG-encode a single uploaded File. Returns {id, dataUrl} or throws.
// Each photo now lives in its own atlas/case_photo_<id> doc (refactored
// earlier), so the only constraint per photo is the 1 MB Firestore-doc cap.
// Targeting ~700 KB of base64 (~520 KB binary JPEG) leaves comfortable
// headroom under the cap and still allows readable photos.
const CASE_PHOTO_MAX_SIDE = 1600;
const CASE_PHOTO_QUALITY = 0.80;
const CASE_PHOTO_LIMIT = 4;
const CASE_PHOTO_TARGET_B64 = 700 * 1024;
// Hard ceiling — anything still over this after extreme compression gets
// rejected with a clear error so we never try to save a doc that Firestore
// will refuse.
const CASE_PHOTO_HARD_CEILING_B64 = 900 * 1024;

// Lazy-load heic2any from CDN the first time we encounter a HEIC. Avoids
// pulling ~150 KB of JS on every page load for the 99% of cases that
// upload JPEGs/PNGs.
let _heic2anyLoading = null;
function _ensureHeic2Any() {
  if(typeof window.heic2any === 'function') return Promise.resolve();
  if(_heic2anyLoading) return _heic2anyLoading;
  _heic2anyLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load HEIC converter.'));
    document.head.appendChild(s);
  });
  return _heic2anyLoading;
}

// Render a Blob/File onto a canvas at maxSide, return a JPEG data URL.
function _renderToJpeg(blob, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale) || img.width;
        const h = Math.round(img.height * scale) || img.height;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject('BAD_IMAGE');
      img.src = ev.target.result;
    };
    reader.onerror = () => reject('BAD_IMAGE');
    reader.readAsDataURL(blob);
  });
}

async function _processCaseImageFile(file) {
  // Auto-convert HEIC/HEIF from iPhone Camera to JPEG client-side so we
  // don't ask the user to change a camera setting.
  const isHeic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
  let workingBlob = file;
  if(isHeic) {
    try { await _ensureHeic2Any(); }
    catch(e) { throw 'HEIC'; }
    if(typeof window.heic2any !== 'function') throw 'HEIC';
    try {
      const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      workingBlob = Array.isArray(out) ? out[0] : out;
    } catch(e) { throw 'HEIC'; }
  }

  // Aggressively iterate until the photo fits comfortably under the target.
  // Each pass either drops JPEG quality (down to 0.30) or shrinks the longest
  // side (down to 400 px) — whichever has more headroom left. The loop has a
  // safety cap of 20 iterations and a hard floor so it always terminates,
  // and a final guard rejects anything still over the hard ceiling so we
  // never hand Firestore a doc it'll refuse.
  let maxSide = CASE_PHOTO_MAX_SIDE;
  let quality = CASE_PHOTO_QUALITY;
  let dataUrl = '';
  const MIN_QUALITY = 0.30;
  const MIN_SIDE    = 400;
  for(let attempt = 0; attempt < 20; attempt++) {
    try { dataUrl = await _renderToJpeg(workingBlob, maxSide, quality); }
    catch(e) { throw 'BAD_IMAGE'; }
    if(dataUrl.length <= CASE_PHOTO_TARGET_B64) break;
    // Already at the floor on both axes — can't compress any further.
    if(quality <= MIN_QUALITY && maxSide <= MIN_SIDE) break;
    if(quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality - 0.10);
    } else if(maxSide > MIN_SIDE) {
      maxSide = Math.max(MIN_SIDE, Math.round(maxSide * 0.82));
    }
  }
  if(dataUrl.length > CASE_PHOTO_HARD_CEILING_B64) {
    // This shouldn't happen with normal phone photos — only if someone
    // uploads a giant scanned PDF or a multi-megapixel panorama that
    // doesn't compress well. Tell the user clearly so they can save a
    // smaller version and retry.
    throw 'TOO_BIG';
  }
  return { id: uid(), dataUrl };
}

window.handleImageUpload = async function(e) {
  const files = Array.from(e.target.files || []);
  if(!files.length) return;
  let heicWarned = false, badWarned = false, limitWarned = false, tooBigWarned = false;
  for(const file of files) {
    if(pendingImages.length >= CASE_PHOTO_LIMIT) {
      if(!limitWarned) {
        limitWarned = true;
        alert(`Maximum of ${CASE_PHOTO_LIMIT} photos per case. Remove one if you want to add another.`);
      }
      break;
    }
    try {
      const item = await _processCaseImageFile(file);
      pendingImages.push(item);
    } catch(err) {
      if(err === 'HEIC' && !heicWarned) {
        heicWarned = true;
        alert('Could not convert a HEIC photo automatically.\n\nQuick fix: open the photo in your Photos app and pick "Export Unmodified" or save it as JPEG, then try again. (Or on iPhone: Settings → Camera → Formats → "Most Compatible" so new photos are JPEG by default.)');
      } else if(err === 'TOO_BIG' && !tooBigWarned) {
        tooBigWarned = true;
        alert('That photo is unusually large and we couldn\'t compress it small enough to save.\n\nTry cropping it first, or take a new photo at a normal size and try again.');
      } else if(err !== 'HEIC' && err !== 'TOO_BIG' && !badWarned) {
        badWarned = true;
        alert('Could not load one of the images. Try JPEG or PNG.');
      }
    }
  }
  e.target.value = '';
  renderCaseImagePreviews();
};

function renderCaseImagePreviews() {
  const list = document.getElementById('imgPreviewList');
  const zone = document.getElementById('uploadZone');
  if(!zone) return;
  // Zone always visible so users can add more pictures.
  zone.style.display = 'block';
  if(!list) { pendingImageData = pendingImages[0]?.dataUrl || null; return; }
  if(!pendingImages.length) {
    list.innerHTML = '';
    list.style.display = 'none';
  } else {
    list.style.display = 'grid';
    list.innerHTML = pendingImages.map((im, idx) => `
      <div style="position:relative;display:inline-block">
        <img src="${im.dataUrl}" style="width:100%;max-width:180px;height:120px;object-fit:cover;border:1px solid var(--border);border-radius:6px;display:block;cursor:pointer" onclick="openPendingLightbox(${idx})">
        <button type="button" onclick="removeImage('${im.id}')" title="Remove this photo" style="position:absolute;top:4px;right:4px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:22px;height:22px;font-size:14px;cursor:pointer;line-height:1">×</button>
      </div>
    `).join('');
  }
  // Keep the legacy single var pointing at the first image for any leftover refs.
  pendingImageData = pendingImages[0]?.dataUrl || null;
}
window.renderCaseImagePreviews = renderCaseImagePreviews;

window.openPendingLightbox = function(idx) {
  const im = pendingImages[idx];
  if(!im) return;
  document.getElementById('lightboxImg').src = im.dataUrl;
  document.getElementById('lightbox').style.display = 'flex';
};

window.removeImage = function(id) {
  // No arg → clear all (used by clearCase / post-save reset).
  if(id === undefined || id === null) {
    pendingImages = [];
  } else {
    pendingImages = pendingImages.filter(im => im.id !== id);
  }
  const input = document.getElementById('caseImageInput');
  if(input) input.value = '';
  renderCaseImagePreviews();
};
// -- SAVE CASE --
window.saveCase = async function() {
const caseId=document.getElementById('caseId').value.trim()||'CASE-'+Date.now();
// Test cases (caseId prefixed with TEST-) are sandbox-only — they save a
// case record so the UI flow can be tested end-to-end, but they MUST NOT
// touch real inventory or the CS log. The isTest flag keeps them out of
// stats and reports too.
const _isTestCase = caseId.startsWith('TEST-');
// Case Procedure is required — every case must be identifiable by what was
// actually done. The previous fallback to "Unnamed Procedure" let blank
// values slip through, which made later reporting/lookup unreliable.
const procedureEl = document.getElementById('procedure');
const proc = procedureEl ? procedureEl.value.trim() : '';
if(!proc) {
  alert('Case Procedure is required.');
  if(procedureEl) procedureEl.focus();
  return;
}
const provider=document.getElementById('provider').value.trim();
const date=document.getElementById('caseDate').value||todayStr();
const notes=document.getElementById('caseNotes')?document.getElementById('caseNotes').value.trim():'';
const comments=document.getElementById('caseComments')?document.getElementById('caseComments').value.trim():'';
// If editing an existing case, update it instead of creating new
if(window._editingCaseId) {
const editId = window._editingCaseId;
try {
let idx = cases.findIndex(x => x.id === editId);
if(idx === -1) {
alert('Error: Case not found. Try refreshing the page.');
return;
}
const oldCase = {...cases[idx]};
const suppliesTotal = caseItems.reduce((s,i)=>s+(parseFloat(i.cost)||0)*(parseFloat(i.qty)||0),0);
const csTotal = csEntries.reduce((sum,entry)=>{
try { const cpm=getCostPerMG(entry.drug); const mg=(parseFloat(entry.amountGiven)||0)+(parseFloat(entry.wastedAmt)||0); return sum+cpm*mg; } catch(e){ return sum; }
},0);
const total = suppliesTotal + csTotal;
// Build updated case object
const updatedCase = {
...cases[idx],
procedure:proc, provider, date,
notes,
startTime: document.getElementById('caseStartTime')?.value || cases[idx].startTime || '',
endTime: document.getElementById('caseEndTime')?.value || cases[idx].endTime || '',
caseComments:comments, worker:currentWorker,
items: caseItems.map(i=>({id:i.id,generic:i.generic||'',name:i.name||'',cost:parseFloat(i.cost)||0,qty:parseFloat(i.qty)||0,lineTotal:(parseFloat(i.cost)||0)*(parseFloat(i.qty)||0)})),
savedCsEntries: csEntries.map(e=>({...e})),
csTotal, total,
// Whatever photos are currently in the upload area — could be original
// loaded by editFinalizedCase, new uploads, or empty after Remove.
images: pendingImages.map(im => ({ id: im.id, dataUrl: im.dataUrl }))
};
// Inventory diff — reverse old, apply new (test cases skip this entirely)
if(!_isTestCase) {
  (oldCase.items || []).forEach(oldItem => {
    const inv = items.find(i => i.id === oldItem.id);
    if(inv) setStock(inv, oldCase.worker || currentWorker, getStock(inv, oldCase.worker || currentWorker) + (parseFloat(oldItem.qty)||0));
  });
  caseItems.forEach(item => {
    const inv = items.find(i => i.id === item.id);
    if(inv) setStock(inv, currentWorker, Math.max(0, getStock(inv, currentWorker) - (parseFloat(item.qty)||0)));
  });
}
updatedCase.isTest = _isTestCase || !!oldCase.isTest;
// Save inventory first
setSyncing(true);
if(!_isTestCase) await saveInventory();
// Re-find index after async (onSnapshot may have replaced the array)
const freshIdx = cases.findIndex(x => x.id === editId);
if(freshIdx !== -1) {
cases[freshIdx] = updatedCase;
} else {
cases.unshift(updatedCase);
}
await saveCases();
setSyncing(false);
// CS log update (best-effort, won't block save if it fails)
// Test cases never touch the controlled-substance log.
if(!_isTestCase) try {
const csSnap = await getDoc(doc(db,'atlas','cslog'));
let csLog = csSnap.exists() ? (csSnap.data().entries||[]) : [];
csLog = csLog.filter(e => e.caseId !== oldCase.caseId);
csEntries.forEach(entry => {
csLog.unshift({
id:uid(), drug:entry.drug, drugLabel:entry.drug,
caseId:oldCase.caseId, date, provider, worker:currentWorker,
amountGiven:parseFloat(entry.amountGiven)||0,
leftInVial:parseFloat(entry.leftInVial)||0,
wastedAmt:parseFloat(entry.wastedAmt)||0,
newBottle:entry.newBottle||false,
witnessSignature:entry.witnessSignature||'',
providerSignature:entry.providerSignature||'',
savedAt:new Date().toISOString()
});
});
await setDoc(doc(db,'atlas','cslog'), {entries:csLog});
} catch(csErr) {
console.warn('CS log update skipped:', csErr);
}
// Remove any draft linked to this caseId from Mid-Case
cases = cases.filter(x => !(x.draft && x.caseId === updatedCase.caseId));
// Clear editing state
window._editingCaseId = null;
const banner = document.getElementById('case-edit-banner');
if(banner) banner.remove();
const saveBtn = document.querySelector('#tab-new-case .btn-success');
if(saveBtn) saveBtn.textContent = '✓ Finalize Case & Update Inventory';
clearCase();
renderHistory();
renderMidCase();
try { logAudit('case-edit', updatedCase.caseId || editId); } catch(e){}
alert('✓ Case updated successfully!');
showTab('history');
} catch(editErr) {
setSyncing(false);
console.error('Edit save error:', editErr);
alert('Error saving edit: ' + editErr.message);
}
return;
}
const suppliesTotal2=caseItems.reduce((s,i)=>s+i.cost*i.qty,0);
const csTotal2=csEntries.reduce((sum,entry)=>{
const cpm=getCostPerMG(entry.drug);
const mg=(parseFloat(entry.amountGiven)||0)+(parseFloat(entry.wastedAmt)||0);
return sum+cpm*mg;
},0);
const total=suppliesTotal2+csTotal2;
// Snapshot inventory so we can roll back deductions if the cloud save fails
// partway. Without this, a failure mid-save would leave inventory deducted
// while the case record never made it to Firestore.
const inventorySnapshot = items.map(i => ({id:i.id, stockDev:i.stockDev, stockJosh:i.stockJosh}));
const casesSnapshot = cases.map(c => c);
try {
// STEP 1 — write the case record FIRST. Nothing has been deducted yet, so if
// this fails we just throw and the user gets a clear error with no orphaned
// inventory changes.
const existingFinalIdx = cases.findIndex(c => c.caseId === caseId && !c.draft);
if(existingFinalIdx !== -1) {
  cases[existingFinalIdx] = { ...cases[existingFinalIdx],
    procedure:proc, provider, date, notes, worker:currentWorker,
    caseComments:comments, total,
    items:caseItems.map(i=>({id:i.id,generic:i.generic,name:i.name,cost:i.cost,qty:i.qty,lineTotal:i.cost*i.qty})),
    savedCsEntries:csEntries.map(e=>({...e})),
    csTotal:csTotal2, savedAt:new Date().toISOString()
  };
} else {
cases.unshift({
id:uid(),caseId,procedure:proc,provider,date,notes,worker:currentWorker,
startTime: document.getElementById('caseStartTime')?.value || '',
endTime: document.getElementById('caseEndTime')?.value || '',
caseComments:comments,
isTest: _isTestCase,
surgeryCenter: (() => { const preopRec = (window._rawPreopRecords||[]).find(r=>r['po-caseId']===caseId); return preopRec?.['po-surgery-center']||''; })(),
patientEmail: (() => { const preopRec = (window._rawPreopRecords||[]).find(r=>r['po-caseId']===caseId); return preopRec?.['po-patientEmail']||''; })(),
items:caseItems.map(i=>({id:i.id,generic:i.generic,name:i.name,cost:i.cost,qty:i.qty,lineTotal:i.cost*i.qty})),
savedCsEntries:csEntries.map(e=>({...e})),
csTotal:csTotal2,
total, images: pendingImages.map(im => ({ id: im.id, dataUrl: im.dataUrl })),
savedAt:new Date().toISOString()
});
} // end duplicate guard
// Drop the matching draft locally before saving so the cloud copy is clean.
cases = cases.filter(x => !(x.draft && x.caseId === caseId));
let _step = 'saving case record';
try {
await saveCases();
if(!_isTestCase) {
  // STEP 2 — case record is committed. Now deduct regular supplies from inventory.
  caseItems.forEach(item=>{
  const inv=items.find(i=>i.id===item.id);
  if(inv) setStock(inv,currentWorker,Math.max(0,getStock(inv,currentWorker)-item.qty));
  });
  // STEP 3 — save CS log entries and deduct CS inventory (no-op if no CS entries).
  _step = 'saving controlled-substance log';
  await saveCSEntriesWithCase(caseId, date, provider);
  // STEP 4 — persist final inventory state (covers regular supply deductions).
  _step = 'saving inventory';
  await saveInventory();
} else {
  // Test case path — flush CS entries from the form without writing to the log
  csEntries = [];
}
} catch(stepErr) {
stepErr.atlasStep = _step;
throw stepErr;
}
window._activeDraftId = null;
csEntries = [];
renderCSEntries();
clearCase();
try { logAudit('case-save', caseId, `total $${total.toFixed(2)}` + (_isTestCase ? ' [TEST]' : '')); } catch(e){}
if(_isTestCase) {
  alert(`🧪 Test case saved — inventory NOT changed.\nTotal: $${total.toFixed(2)}\nThis case is excluded from stats.`);
} else {
  alert(`✓ Case saved & synced!\nTotal: $${total.toFixed(2)}\n${currentWorker==='dev'?'Devarsh':'Josh'}'s inventory updated.`);
}
showTab('history');
} catch(saveErr) {
// Roll back local inventory + cases state so the UI matches reality.
console.error('Save case error:', saveErr);
inventorySnapshot.forEach(snap => {
const inv = items.find(i => i.id === snap.id);
if(inv) { inv.stockDev = snap.stockDev; inv.stockJosh = snap.stockJosh; }
});
cases = casesSnapshot;
setSyncing(false);
const stepLabel = saveErr?.atlasStep ? `\n\nFailed during: ${saveErr.atlasStep}` : '';
alert('⚠ Could not save case.\n\n' + (saveErr?.message || saveErr) + stepLabel + '\n\nNothing was changed. Please check your internet connection and try again.');
}
};
window.clearCase=function(){
// Don't clear if actively editing a case
if(window._editingCaseId) return;
caseItems=[];
// Clear controlled substance entries
csEntries=[];
renderCSEntries();
['caseId','procedure','provider','caseNotes','caseComments'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
const preopSummary = document.getElementById('finalize-preop-summary');
if(preopSummary) preopSummary.style.display = 'none';

const draftCard = document.getElementById('draft-invoice-card');
if(draftCard) draftCard.style.display = 'none';
const startEl = document.getElementById('caseStartTime');
const endEl = document.getElementById('caseEndTime');
if(startEl) startEl.value = '';
if(endEl) endEl.value = '';
document.getElementById('caseDate').value=todayStr();
// Clear BMI displays
['po-height-cm','po-weight-kg','po-bmi'].forEach(id => {
const el = document.getElementById(id);
if(el) el.textContent = '—';
});
window._editingPreopId = null;
window._activeDraftId = null;
const picker = document.getElementById('draftCasePicker');
if(picker) picker.value = '';
removeImage();renderCaseSupplies();refreshItemSelect();
updateCaseIdDisplays();
};
// -- INVENTORY --
window.renderInventory = function renderInventory() {
const search=(document.getElementById('invSearch')?.value||'').toLowerCase();
const alertsEl=document.getElementById('inventoryAlerts');
const tableEl=document.getElementById('inventoryTable');
const tab=currentInvTab;
let lowList=tab==='dev'?items.filter(i=>i.stockDev<=i.alert):tab==='josh'?items.filter(i=>i.stockJosh<=i.alert):items.filter(i=>(i.stockDev+i.stockJosh)<=(i.alert*2));
alertsEl.innerHTML=lowList.length
?`<div class="alert alert-warn">⚠ <strong>${lowList.length} item(s)</strong> at or below restock level: ${lowList.map(i=>i.generic).join(', ')}</div>`
:`<div class="alert alert-success">✓ All items are sufficiently stocked</div>`;
const filtered=items.filter(i=>i.generic.toLowerCase().includes(search)||i.name.toLowerCase().includes(search)||i.code.toLowerCase().includes(search)||i.category.toLowerCase().includes(search));
const byCategory={};
filtered.forEach(item=>{if(!byCategory[item.category])byCategory[item.category]=[];byCategory[item.category].push(item);});
let html='';
if(tab==='combined'){
Object.entries(byCategory).sort().forEach(([cat,itms])=>{
html+=`<div class="cat-label">${cat}</div>`;
html+=`<div style="display:grid;grid-template-columns:2fr 80px 80px 80px 70px 70px 80px;gap:8px;padding-bottom:7px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint)"><span>Generic / Item</span><span>Unit Cost</span><span>Dev</span><span>Josh</span><span>Total</span><span>Alert</span><span></span></div>`;
itms.sort((a,b)=>a.generic.localeCompare(b.generic)).forEach(item=>{
const tot=item.stockDev+item.stockJosh;
const scD=item.stockDev===0?'stock-critical':item.stockDev<=item.alert?'stock-low':'stock-ok';
const scJ=item.stockJosh===0?'stock-critical':item.stockJosh<=item.alert?'stock-low':'stock-ok';
const costStyle = (!item.costPerUnit||item.costPerUnit===0) ? 'background:#fde8e0;color:#b5451b;font-weight:700;border-radius:4px;padding:2px 6px' : '';
html+=`<div style="display:grid;grid-template-columns:2fr 80px 80px 80px 70px 70px 80px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)"><div><div style="font-size:13px;font-weight:500">${item.generic}</div><div style="font-size:11px;color:var(--text-faint)">${item.name}</div></div><div style="font-family:'DM Mono',monospace;font-size:13px;${costStyle}">$${item.costPerUnit.toFixed(2)}</div>`+`<div><span class="stock-badge ${scD}">${item.stockDev}</span></div><div><span class="stock-badge ${scJ}">${item.stockJosh}</span></div><div style="font-size:13px;font-weight:500;font-family:'DM Mono',monospace">${tot}</div><div style="font-size:13px;color:var(--text-muted)">${item.alert}</div><div><button onclick="editItem('${item.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">Edit</button></div></div>`;
});
});
} else {
const w=tab;
Object.entries(byCategory).sort().forEach(([cat,itms])=>{
html+=`<div class="cat-label">${cat}</div>`;
html+=`<div class="inv-header"><span>Generic / Item</span><span>Unit Cost</span><span>In Stock</span><span>Alert At</span><span>Supplier</span><span>Add Stock</span><span></span></div>`;
itms.sort((a,b)=>a.generic.localeCompare(b.generic)).forEach(item=>{
const stock=getStock(item,w);
const sc=stock===0?'stock-critical':stock<=item.alert?'stock-low':'stock-ok';
html+=`<div class="inv-row"><div><div style="font-size:13px;font-weight:500">${item.generic}</div><div style="font-size:11px;color:var(--text-faint)">${item.name}</div><div style="font-size:10px;color:var(--text-faint);font-family:'DM Mono',monospace">${item.code} · ${item.unitSize}</div></div><div style="display:flex;align-items:center;gap:3px"><span style="font-size:12px;color:var(--text-muted)">$</span><input type="number" value="${item.costPerUnit.toFixed(2)}" step="0.01" min="0"
style="width:70px;padding:4px 6px;font-size:13px;font-family:'DM Mono',monospace;${(!item.costPerUnit||item.costPerUnit===0)?'background:#fde8e0;color:#b5451b;font-weight:700;border-color:#b5451b':''}"
onchange="updateCost('${item.id}', this.value)"
title="Edit unit cost"></div><div><span class="stock-badge ${sc}">${stock}</span></div><div style="font-size:13px;color:var(--text-muted)">${item.alert}</div><div style="font-size:12px;color:var(--text-faint)">${item.supplier}</div><div style="display:flex;gap:5px;align-items:center"><input type="number" id="restock_${item.id}" style="width:58px;padding:4px 7px;font-size:13px" placeholder="qty" min="0" step="0.5"><button onclick="adjustStock('${item.id}')" class="btn btn-ghost btn-sm">+</button></div><div style="display:flex;gap:4px"><button onclick="editItem('${item.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">Edit</button><button onclick="deleteItem('${item.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">Del</button></div></div>`;
});
});
}
if(!filtered.length) html='<div class="empty-state">No items found.</div>';
tableEl.innerHTML=html;
}
window.adjustStock = async function(id) {
const input=document.getElementById('restock_'+id);
const qty=parseInt(input.value)||0;
if(qty<=0){alert('Enter a positive quantity to add.');return;}
const item=items.find(i=>i.id===id);
if(item){
// Stock changes always target the logged-in worker (currentWorker), never
// the tab being viewed. Block the action if there's a mismatch — better to
// surface the conflict than to silently update the "wrong" person's stock.
const w = currentWorker;
if(currentInvTab !== 'combined' && currentInvTab !== w) {
const wname   = w==='dev' ? 'Devarsh' : 'Josh';
const tabName = currentInvTab==='dev' ? 'Devarsh' : 'Josh';
alert(`You're logged in as ${wname} but viewing ${tabName}'s tab.\n\nStock changes only apply to the logged-in worker. Switch to ${wname}'s tab, or change the Logged-In Worker on the Finalize Case page first.`);
return;
}
setStock(item,w,getStock(item,w)+qty);
await saveInventory();
input.value='';
const wname = w==='dev' ? 'Devarsh' : 'Josh';
input.style.background='#dcfce7';
setTimeout(()=>{ input.style.background=''; },800);
input.title = `+${qty} added to ${wname}`;
}
};
window.editItem = function(id) {
const item = items.find(i => i.id === id);
if(!item) return;

// Collect unique categories for dropdown
const cats = [...new Set(items.map(i => i.category||'').filter(Boolean))].sort();
const catOptions = cats.map(c => `<option value="${c}" ${c===item.category?'selected':''}>${c}</option>`).join('');

const old = document.getElementById('edit-item-modal');
if(old) old.remove();
const modal = document.createElement('div');
modal.id = 'edit-item-modal';
modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
modal.innerHTML = `
  <div style="background:var(--surface);border-radius:12px;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
    <div style="background:#1d3557;padding:16px 24px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1">
      <div style="color:#fff;font-size:15px;font-weight:600">Edit Item</div>
      <button id="ei-close" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:13px">✕</button>
    </div>
    <div style="padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div style="grid-column:1/-1"><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Generic Name</label>
        <input id="ei-generic" type="text" value="${item.generic||''}" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div style="grid-column:1/-1"><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Brand / Full Name</label>
        <input id="ei-name" type="text" value="${item.name||''}" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div style="grid-column:1/-1"><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Supplier</label>
        <input id="ei-supplier" type="text" value="${item.supplier||''}" placeholder="e.g. Henry Schein, Cardinal Health" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Category</label>
        <select id="ei-category" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
          ${catOptions}
          <option value="__custom__">+ New category...</option>
        </select>
        <input id="ei-category-custom" type="text" placeholder="New category name" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);margin-top:6px;display:none">
      </div>
      <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Item Code / ID</label>
        <input id="ei-code" type="text" value="${item.code||item.id||''}" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Unit Cost ($)</label>
        <input id="ei-cost" type="number" min="0" step="0.01" value="${item.costPerUnit||0}" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Low Stock Alert</label>
        <input id="ei-alert" type="number" min="0" step="1" value="${item.alert||0}" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Josh Stock</label>
        <input id="ei-stock-josh" type="number" min="0" step="1" value="${item.stockJosh||0}" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Dev Stock</label>
        <input id="ei-stock-dev" type="number" min="0" step="1" value="${item.stockDev||0}" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </div>
      <div style="grid-column:1/-1;display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);margin-top:4px">
        <button id="ei-delete" style="background:rgba(239,68,68,.1);color:var(--warn);border:1px solid var(--warn);border-radius:6px;padding:8px 16px;font-size:13px;cursor:pointer">🗑 Delete Item</button>
        <button id="ei-save" style="background:#1d3557;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:14px;font-weight:600;cursor:pointer">✓ Save Changes</button>
      </div>
    </div>
  </div>`;
document.body.appendChild(modal);

// Category custom input toggle
document.getElementById('ei-category').addEventListener('change', e => {
  document.getElementById('ei-category-custom').style.display = e.target.value === '__custom__' ? '' : 'none';
});

document.getElementById('ei-close').addEventListener('click', () => modal.remove());
modal.addEventListener('click', e => { if(e.target === modal) modal.remove(); });

document.getElementById('ei-delete').addEventListener('click', async () => {
  if(!confirm(`Delete "${item.generic||item.name}"? This cannot be undone.`)) return;
  items = items.filter(i => i.id !== id);
  setSyncing(true); await saveInventory(); setSyncing(false);
  renderInventory(); modal.remove();
});

document.getElementById('ei-save').addEventListener('click', async () => {
  const catSel = document.getElementById('ei-category').value;
  const catCustom = document.getElementById('ei-category-custom').value.trim();
  const category = catSel === '__custom__' ? catCustom : catSel;
  item.generic      = document.getElementById('ei-generic').value.trim() || item.generic;
  item.name         = document.getElementById('ei-name').value.trim() || item.name;
  item.supplier     = document.getElementById('ei-supplier').value.trim();
  item.category     = category || item.category;
  item.code         = document.getElementById('ei-code').value.trim() || item.code;
  item.costPerUnit  = parseFloat(document.getElementById('ei-cost').value) || 0;
  item.alert        = parseInt(document.getElementById('ei-alert').value) || 0;
  item.stockJosh    = parseInt(document.getElementById('ei-stock-josh').value) || 0;
  item.stockDev     = parseInt(document.getElementById('ei-stock-dev').value) || 0;
  setSyncing(true); await saveInventory(); setSyncing(false);
  renderInventory(); modal.remove();
});
};
window.deleteItem = async function(id) {
if(!confirm('Delete this item?'))return;
items=items.filter(i=>i.id!==id);
await saveInventory();refreshItemSelect();
};
window.toggleAddForm=function(){
const f=document.getElementById('addItemForm');
f.style.display=f.style.display==='none'?'block':'none';
// Close quick add if open
const qa=document.getElementById('quickAddForm');
if(qa&&qa.style.display!=='none') { qa.style.display='none'; }
};


// ── QUICK ADJUST LOW STOCK ALERTS ────────────────────────────────────────────
let _quickAdjustMode = 'alert'; // 'alert' or 'stock'
window.toggleQuickAdjust = function(mode) {
  const qa = document.getElementById('quickAdjustForm');
  if(!qa) return;
  const isOpen = qa.style.display !== 'none';
  // If already open in same mode, just close
  if(isOpen && _quickAdjustMode === mode) { qa.style.display = 'none'; return; }
  // If switching modes while open, just re-render (don't close then reopen)
  _quickAdjustMode = mode || 'alert';
  qa.style.display = 'block';
  const addForm = document.getElementById('addItemForm');
  if(addForm && addForm.style.display !== 'none') addForm.style.display = 'none';
  const quickAdd = document.getElementById('quickAddForm');
  if(quickAdd && quickAdd.style.display !== 'none') quickAdd.style.display = 'none';
  // Update title/description/button
  const titleEl = document.getElementById('quickAdjustTitle');
  const descEl  = document.getElementById('quickAdjustDesc');
  const saveEl  = document.getElementById('quickAdjustSaveLabel');
  if(mode === 'stock') {
    if(titleEl) titleEl.textContent = '📦 Quick Adjust Stock';
    if(descEl)  descEl.textContent  = 'Set exact stock quantities for each item — replaces current values.';
    if(saveEl)  saveEl.textContent  = '✓ Apply Stock Changes';
  } else {
    if(titleEl) titleEl.textContent = '🔔 Quick Adjust Alert Thresholds';
    if(descEl)  descEl.textContent  = 'Set the low stock alert threshold. Items at or below this number trigger a warning.';
    if(saveEl)  saveEl.textContent  = '✓ Apply Alert Changes';
  }
  const list = document.getElementById('quickAdjustList');
  if(!list) return;
  const sorted = [...items].sort((a,b) => {
    const cat = (a.category||'').localeCompare(b.category||'');
    return cat !== 0 ? cat : (a.generic||a.name||'').localeCompare(b.generic||b.name||'');
  });
  const byCategory = {};
  sorted.forEach(item => {
    const cat = item.category || 'Other';
    if(!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  });
  let html = '';
  // For stock mode, prepend a worker banner — stock changes apply only to the
  // logged-in worker. Alert thresholds are global (one number per item, shared
  // across both workers), so the banner is omitted in alert mode.
  if(mode === 'stock') {
    const wname  = currentWorker==='dev' ? 'Devarsh' : 'Josh';
    const wpill  = currentWorker==='dev' ? 'pill-dev' : 'pill-josh';
    const tabMismatch = (currentInvTab==='dev' || currentInvTab==='josh') && currentInvTab !== currentWorker;
    const tabName = currentInvTab==='dev' ? 'Devarsh' : currentInvTab==='josh' ? 'Josh' : 'Combined';
    html += `<div style="grid-column:1/-1;display:flex;align-items:center;gap:10px;padding:10px 14px;background:${tabMismatch?'rgba(181,69,27,0.08)':'rgba(45,106,79,0.06)'};border:1px solid ${tabMismatch?'var(--warn)':'var(--success,#2d6a4f)'};border-radius:var(--radius-sm);margin-bottom:8px">
      <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted)">Adjusting:</span>
      <span class="worker-pill ${wpill}" style="font-size:13px;padding:3px 12px">${wname}'s stock</span>
      ${tabMismatch ? `<span style="font-size:11px;color:var(--warn);margin-left:auto;font-weight:500">⚠ Viewing ${tabName}'s tab — switch the Logged-In Worker on Finalize Case if this is wrong</span>` : `<span style="font-size:11px;color:var(--text-faint);margin-left:auto">Switch worker via the Finalize Case toggle</span>`}
    </div>`;
  }
  Object.entries(byCategory).sort((a,b) => a[0].localeCompare(b[0])).forEach(([cat, catItems]) => {
    html += `<div style="grid-column:1/-1;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);padding:6px 0 2px;border-top:1px solid var(--border);margin-top:4px">${cat}</div>`;
    catItems.forEach(item => {
      const stock = getStock(item, currentWorker);
      const alertVal = item.alert || 0;
      const isLow = stock <= alertVal;
      const val   = mode === 'stock' ? stock : alertVal;
      const label = mode === 'stock' ? 'Qty' : 'Alert at';
      const inputId = mode === 'stock' ? `qadj-stock-${item.id}` : `qadj-alert-${item.id}`;
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:${isLow&&mode==='alert'?'rgba(181,69,27,0.06)':'var(--surface2)'};border-radius:var(--radius-sm);border:1px solid ${isLow&&mode==='alert'?'var(--warn)':'var(--border)'}">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.generic||item.name}</div>
          <div style="font-size:11px;color:var(--text-faint)">${mode==='stock'?`Alert: <span style="font-family:monospace">${alertVal}</span>`:`Stock: <span style="font-family:monospace;color:${isLow?'var(--warn)':'inherit'}">${stock}</span>`}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:9px;color:var(--text-faint);margin-bottom:2px">${label}</div>
          <input type="number" id="${inputId}" min="0" step="1" value="${val}" style="width:56px;text-align:center;padding:5px 6px;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg)">
        </div>
      </div>`;
    });
  });
  list.innerHTML = html;
};

window.saveAllQuickAdjust = async function() {
  let changed = 0;
  items.forEach(item => {
    const inputId = _quickAdjustMode === 'stock' ? `qadj-stock-${item.id}` : `qadj-alert-${item.id}`;
    const input = document.getElementById(inputId);
    if(!input) return;
    const newVal = parseInt(input.value);
    if(isNaN(newVal) || newVal < 0) return;
    if(_quickAdjustMode === 'stock') {
      const current = getStock(item, currentWorker);
      if(newVal !== current) { setStock(item, currentWorker, newVal); changed++; }
    } else {
      if(newVal !== (item.alert||0)) { item.alert = newVal; changed++; }
    }
  });
  if(!changed) { alert('No changes made — all values are the same.'); return; }
  setSyncing(true);
  await saveInventory();
  setSyncing(false);
  renderInventory();
  document.getElementById('quickAdjustForm').style.display = 'none';
  if(_quickAdjustMode === 'stock') {
    const wname = currentWorker==='dev' ? 'Devarsh' : 'Josh';
    alert('✓ ' + changed + ' stock quantity(ies) updated for ' + wname + '!');
  } else {
    alert('✓ ' + changed + ' alert threshold(s) updated!');
  }
};

window.toggleQuickAdd=function(){
const qa=document.getElementById('quickAddForm');
if(!qa) return;
const isOpen=qa.style.display!=='none';
qa.style.display=isOpen?'none':'block';
const f=document.getElementById('addItemForm');
if(f&&f.style.display!=='none') f.style.display='none';
if(!isOpen) {
const list=document.getElementById('quickAddList');
if(!list) return;
const sorted=[...items].sort((a,b)=>{
const cat=(a.category||'').localeCompare(b.category||'');
return cat!==0?cat:(a.generic||a.name||'').localeCompare(b.generic||b.name||'');
});
// Group by category
const byCategory={};
sorted.forEach(item=>{
const cat=item.category||'Other';
if(!byCategory[cat]) byCategory[cat]=[];
byCategory[cat].push(item);
});
// Worker banner — make it unmissable WHO this form will update.
// "currentWorker" is the persistent logged-in user (set via the toggle on
// Finalize Case). If they're viewing a different worker's inv tab, surface
// that mismatch so they can decide whether to switch worker or proceed.
const wname  = currentWorker==='dev' ? 'Devarsh' : 'Josh';
const wpill  = currentWorker==='dev' ? 'pill-dev' : 'pill-josh';
const tabMismatch = (currentInvTab==='dev' || currentInvTab==='josh') && currentInvTab !== currentWorker;
const tabName = currentInvTab==='dev' ? 'Devarsh' : currentInvTab==='josh' ? 'Josh' : 'Combined';
const banner = `<div style="grid-column:1/-1;display:flex;align-items:center;gap:10px;padding:10px 14px;background:${tabMismatch?'rgba(181,69,27,0.08)':'rgba(45,106,79,0.06)'};border:1px solid ${tabMismatch?'var(--warn)':'var(--accent)'};border-radius:var(--radius-sm);margin-bottom:8px">
  <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted)">Adding to:</span>
  <span class="worker-pill ${wpill}" style="font-size:13px;padding:3px 12px">${wname}'s stock</span>
  ${tabMismatch ? `<span style="font-size:11px;color:var(--warn);margin-left:auto;font-weight:500">⚠ Viewing ${tabName}'s tab — switch the Logged-In Worker on Finalize Case if this is wrong</span>` : `<span style="font-size:11px;color:var(--text-faint);margin-left:auto">Switch worker via the Finalize Case toggle</span>`}
</div>`;
let html=banner;
Object.entries(byCategory).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([cat,catItems])=>{
html+=`<div style="grid-column:1/-1;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);padding:6px 0 2px;border-top:1px solid var(--border);margin-top:4px">${cat}</div>`;
catItems.forEach(item=>{
const stock=getStock(item,currentWorker);
html+=`<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:var(--radius-sm);border:1px solid var(--border)">
<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.generic||item.name}</div><div style="font-size:11px;color:var(--text-faint)">Stock: <span id="qa-stock-${item.id}" style="font-family:monospace">${stock}</span></div></div>
<input type="number" id="qa-qty-${item.id}" min="0" step="1" placeholder="0" style="width:64px;text-align:center;padding:5px 6px;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg)">
</div>`;
});
});
list.innerHTML=html;
}
};
window.saveAllQuickAdd=async function(){
const updates=[];
items.forEach(item=>{
const input=document.getElementById('qa-qty-'+item.id);
const qty=input?parseInt(input.value)||0:0;
if(qty>0) updates.push({item,qty});
});
if(!updates.length){alert('No quantities entered — nothing to save.');return;}
const wname = currentWorker==='dev' ? 'Devarsh' : 'Josh';
updates.forEach(({item,qty})=>{
setStock(item,currentWorker,getStock(item,currentWorker)+qty);
});
setSyncing(true);
await saveInventory();
setSyncing(false);
renderInventory();
// Update stock displays and clear inputs
updates.forEach(({item})=>{
const stockEl=document.getElementById('qa-stock-'+item.id);
const input=document.getElementById('qa-qty-'+item.id);
if(stockEl) stockEl.textContent=getStock(item,currentWorker);
if(input){ input.value=''; input.style.background='#dcfce7'; setTimeout(()=>{ input.style.background=''; },600); }
});
alert('✓ ' + updates.length + ' item(s) added to ' + wname + "'s stock!");
};
window.saveNewItem = async function() {
const name=document.getElementById('newItemName').value.trim();
const generic=document.getElementById('newGeneric').value.trim()||name;
if(!name){alert('Please enter an item name.');return;}
items.push({
id:uid(),code:document.getElementById('newCode').value.trim()||uid(),
generic,name,category:document.getElementById('newItemCategory').value,
supplier:document.getElementById('newSupplier').value.trim()||'',
unitSize:document.getElementById('newUnitSize').value.trim()||'',
costPerUnit:parseFloat(document.getElementById('newItemCost').value)||0,
stockDev:parseInt(document.getElementById('newItemStockDev').value)||0,
stockJosh:parseInt(document.getElementById('newItemStockJosh').value)||0,
alert:parseInt(document.getElementById('newItemAlert').value)||0,
});
await saveInventory();
['newCode','newGeneric','newItemName','newSupplier','newUnitSize','newItemCost','newItemStockDev','newItemStockJosh','newItemAlert'].forEach(id=>document.getElementById(id).value='');
toggleAddForm();refreshItemSelect();
};
// -- HISTORY --
window.renderHistory = renderHistory;
function renderHistory() {
const el=document.getElementById('caseHistoryList');
let filtered=cases;
if(currentHistoryFilter!=='all') filtered=cases.filter(c=>c.worker===currentHistoryFilter);
// Sort: upcoming cases first (soonest first), then past cases (most recent
// first). This puts what's most relevant — what's coming up and what just
// happened — at the top.
const today_ = todayStr();
filtered = [...filtered].sort((a,b) => {
  const aDate = a.date || '';
  const bDate = b.date || '';
  const aFuture = aDate >= today_;
  const bFuture = bDate >= today_;
  if (aFuture && !bFuture) return -1;
  if (!aFuture && bFuture) return 1;
  if (aFuture && bFuture) return aDate.localeCompare(bDate);
  return bDate.localeCompare(aDate);
});
const invoices = window._savedInvoices || [];
if(!filtered.length){el.innerHTML='<div class="empty-state"><span class="empty-state-icon">📋</span><div class="empty-state-title">No cases recorded yet</div><div class="empty-state-sub">Cases will appear here after you finalize them. Start by saving a Pre-Op record.</div><button class="empty-state-cta" onclick="showTab(\'preop\')">+ New Pre-Op →</button></div>';return;}
const today = todayStr();
// Helper: format the date into a group label like "May 2026" or "This Week"
function _historyGroupFor(dateStr, todayStr) {
  if(!dateStr) return { key: 'undated', label: 'No date' };
  const d = new Date(dateStr + 'T12:00:00');
  if(isNaN(d.getTime())) return { key: 'undated', label: 'No date' };
  const now = new Date(todayStr + 'T12:00:00');
  const diffDays = Math.round((d - now) / 86400000);
  if(diffDays === 0) return { key: 'today', label: 'Today' };
  if(diffDays === 1) return { key: 'tomorrow', label: 'Tomorrow' };
  if(diffDays > 1 && diffDays <= 7) return { key: 'thisweek', label: 'This Week' };
  if(diffDays > 7 && diffDays <= 14) return { key: 'nextweek', label: 'Next Week' };
  if(diffDays === -1) return { key: 'yesterday', label: 'Yesterday' };
  if(diffDays < 0 && diffDays >= -7) return { key: 'lastweek', label: 'Last Week' };
  // Otherwise group by Month YYYY
  const monthName = d.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  return { key: 'm-'+monthName, label: monthName };
}
let _lastHistoryGroup = '';
el.innerHTML=filtered.map(c=>{
const group = _historyGroupFor(c.date, today);
const groupHeader = (group.key !== _lastHistoryGroup) ? `<div class="history-group-header"><span>${group.label}</span></div>` : '';
_lastHistoryGroup = group.key;
const pill=c.worker==='dev'?'pill-dev':'pill-josh';
const wname=c.worker==='dev'?'Devarsh':'Josh';
const isPast = c.date && c.date < today;
const isToday = c.date === today;
// HIPAA: hide PHI for cases 3+ days post-surgery (HHS minimum-necessary rule)
const phiHidden = typeof window.isPHIHidden === 'function' && window.isPHIHidden(c.date, c.caseId);
const phiBadge = phiHidden ? `<span style="background:#f1f5f9;color:#64748b;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px" title="Case notes and photos hidden — case is 3+ days old">🔒 PHI HIDDEN</span>` : '';
const borderColor = c.draft ? 'var(--warn)' : isPast ? '#94a3b8' : isToday ? 'var(--accent)' : 'var(--info)';
const bgTint = c.draft ? 'transparent' : isPast ? 'rgba(148,163,184,0.06)' : isToday ? 'rgba(45,106,79,0.04)' : 'rgba(29,53,87,0.03)';
const dateBadge = c.draft ? '' : isPast
? `<span style="background:#f1f5f9;color:#64748b;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">⏱ PAST</span>`
: isToday
? `<span style="background:var(--accent-light);color:var(--accent);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">● TODAY</span>`
: `<span style="background:var(--info-light);color:var(--info);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">📅 UPCOMING</span>`;
return groupHeader + `<div class="case-item" style="border-left:3px solid ${borderColor};background:${bgTint}"><div class="case-item-header" onclick="toggleCase('${c.id}')"><div><div class="case-name" style="display:flex;align-items:center;gap:8px">
${typeof window.getCaseDisplayIdFromCase === 'function' ? window.getCaseDisplayIdFromCase(c) : (c.caseId||'No Case ID')}
<span class="worker-pill ${pill}" style="font-size:10px">${wname}</span>
${c.draft?'<span style="background:var(--warn-light);color:var(--warn);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">✏ DRAFT</span>':''}
${dateBadge}
${phiBadge}
</div><div class="case-date">${fmtDate(c.date)} · ${c.procedure||c.caseId}${c.provider?' · '+c.provider:''}</div>
${(() => {
const inv = invoices.find(i => i.linkedCaseId === c.caseId);
const invHtml = inv
? `<span style="background:#dcfce7;color:#166534;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px">✓ INVOICED</span><span style="font-size:11px;color:var(--text-faint)">${inv.invoiceNum} · $${inv.total.toFixed(2)}</span><button onclick="event.stopPropagation();window.redownloadInvoice('${inv.id}')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px">⬇ PDF</button>`
: c.manuallyInvoiced
? `<span style="background:#dcfce7;color:#166534;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px">✓ INVOICED</span><span style="font-size:11px;color:var(--text-faint)">${c.manuallyInvoicedNote||'Manual'}</span><button onclick="event.stopPropagation();window.unmarkCaseInvoiced('${c.id}')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px;color:var(--warn)">✕ Undo</button>`
: ``;
const preopRec = (window._rawPreopRecords||[]).find(r=>r['po-caseId']===c.caseId);
const ds = c.depositStatus || preopRec?.['po-depositStatus'] || 'not-paid';
const pn = c.paymentNotes || preopRec?.['po-paymentNotes'] || '';
const paidHtml = ds === 'paid'
? `<span style="background:#dcfce7;color:#166534;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px">✓ DEPOSIT PAID</span>${pn?`<span style="font-size:10px;color:var(--text-faint)">${pn}</span>`:''}<button onclick="event.stopPropagation();window.unmarkCaseDepositPaid('${c.id}')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px;color:var(--warn)">✕ Undo</button>`
: ``;
return `<div style="margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">${invHtml}</div><div style="margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">${paidHtml}</div>`;
})()}
</div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><div class="case-cost">${c.draft?'Not Finalized':'$'+getCaseTotal(c).toFixed(2)}</div>
<div style="position:relative;display:inline-block"><button onclick="event.stopPropagation();toggleHistoryDropdown('${c.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">Actions ▾</button><div id="history-menu-${c.id}" style="display:none;position:absolute;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:0 4px 12px rgba(0,0,0,.12);z-index:100;min-width:160px;overflow:hidden">${c.draft
? `<button onclick="event.stopPropagation();toggleHistoryDropdown('${c.id}');resumeCase('${c.id}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--text);font-family:inherit">Resume Case →</button>`
: `<button onclick="event.stopPropagation();toggleHistoryDropdown('${c.id}');editFinalizedCase('${c.id}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--text);font-family:inherit">✏ Edit Case</button>`
}
<button onclick="event.stopPropagation();toggleHistoryDropdown('${c.id}');viewLinkedPreop('${c.caseId}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--info);font-family:inherit">📋 Edit Pre-Op</button><button onclick="event.stopPropagation();toggleHistoryDropdown('${c.id}');deleteFinalizedCase(this)" data-id="${c.id}" data-label="${c.procedure||c.caseId||'Case'}" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--warn);font-family:inherit">🗑 Delete</button></div></div></div></div><div class="case-items-list" id="detail_${c.id}">
${c.items&&c.items.length?c.items.map(i=>`<div class="case-item-row"><span>${i.generic} × ${i.qty}</span><span>$${i.lineTotal.toFixed(2)}</span></div>`).join(''):'<div style="font-size:13px;color:var(--text-faint);padding:6px 0">No supplies logged yet.</div>'}
${(!phiHidden && c.notes) ? `<div style="margin-top:6px;font-size:12px;color:var(--text-faint);font-style:italic">${c.notes}</div>` : ''}
${(function(){
  if(phiHidden) return '';
  const imgs = caseImages(c);
  if(!imgs.length) return '';
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">` + imgs.map((im, idx) =>
    `<img src="${im.dataUrl}" class="case-log-img" onclick="openLightbox('${c.id}', ${idx})" title="Click to enlarge" style="cursor:pointer">`
  ).join('') + `</div>`;
})()}
${phiHidden && (c.notes || (caseImages(c)||[]).length) ? `<div style="margin-top:8px;padding:10px 12px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;text-align:center"><div style="font-size:12px;color:#64748b;margin-bottom:6px">🔒 Case notes and photos are hidden under HIPAA minimum-necessary rule.</div>${window.phiRevealButtonHTML(c.caseId, 'renderHistory')}</div>` : ''}
${c.preopId?`<div style="margin-top:8px"><button onclick="event.stopPropagation();viewLinkedPreop('${c.preopId}')" class="btn btn-ghost btn-sm" style="font-size:11px">📋 View Pre-Op Record</button></div>`:''}
</div></div>`;
}).join('');
// Auto-check Stripe deposits for history cases
setTimeout(() => checkHistoryDeposits(filtered), 500);
}
window.editFinalizedCase = function(id) {
const c = cases.find(x => x.id === id);
if(!c) { alert('Case not found'); return; }
// 1. Set editing flag immediately
window._editingCaseId = id;
// 2. Set worker (with guard active, won't clear caseItems)
currentWorker = c.worker || 'josh';
// 3. Restore supplies and CS directly
caseItems = (c.items || []).map(i => {
const inv = items.find(x => x.id === i.id);
return {
id: i.id,
generic: i.generic || i.name || 'Unknown',
name: i.name || i.generic || 'Unknown',
cost: parseFloat(i.cost) || 0,
qty: parseFloat(i.qty) || 1,
stock: inv ? getStock(inv, currentWorker) : parseFloat(i.qty) || 1
};
});
csEntries = (c.savedCsEntries || []).map(e => ({...e}));
// 3b. Restore the case-log photo previews from the saved data so the user
// sees what's already attached, and the edit save path has the data to
// write back. Without this, opening the edit form silently wipes saved
// photos on the next save.
pendingImages = caseImages(c).map(im => ({ id: im.id || uid(), dataUrl: im.dataUrl }));
renderCaseImagePreviews();
// 4. Switch tab manually (bypasses refreshDraftPicker)
document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
const tabEl = document.getElementById('tab-new-case');
if(tabEl) tabEl.classList.add('active');
// 5. Fill form + render after short delay
setTimeout(() => {
const el = id => document.getElementById(id);
if(el('caseId')) el('caseId').value = c.caseId || '';
if(el('procedure')) el('procedure').value = c.procedure || '';
if(el('provider')) el('provider').value = c.provider || '';
if(el('caseDate')) el('caseDate').value = c.date || '';
if(el('caseNotes')) el('caseNotes').value = c.notes || '';
if(el('caseComments'))el('caseComments').value= c.caseComments || '';
if(el('caseStartTime'))el('caseStartTime').value = c.startTime || '';
if(el('caseEndTime')) el('caseEndTime').value = c.endTime || '';
// Update worker UI without clearing items
const devBtn = document.getElementById('wbtn-dev');
const joshBtn = document.getElementById('wbtn-josh');
const ind = document.getElementById('workerIndicator');
if(devBtn) devBtn.className = 'worker-btn' + (currentWorker==='dev' ?' active-dev':'');
if(joshBtn) joshBtn.className = 'worker-btn' + (currentWorker==='josh'?' active-josh':'');
if(ind) { ind.className = 'worker-pill ' + (currentWorker==='dev'?'pill-dev':'pill-josh'); ind.textContent = (currentWorker==='dev'?'Devarsh':'Josh') + "'s inventory will be updated"; }
// Render supplies and CS
renderCaseSupplies();
renderCSEntries();
refreshItemSelect();
updateCaseIdDisplays();
// Edit banner
const old = document.getElementById('case-edit-banner');
if(old) old.remove();
const banner = document.createElement('div');
banner.id = 'case-edit-banner';
banner.style.cssText = 'background:var(--info-light);border:1px solid #b8cfe8;border-radius:var(--radius-sm);padding:10px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;';
banner.innerHTML = '<span style="font-size:13px;color:var(--info);font-weight:500">✏ Editing: ' + (c.caseId||c.procedure) + '</span><button onclick="cancelEditCase()" class="btn btn-ghost btn-sm" style="font-size:11px">Cancel Edit</button>';
const bar = document.querySelector('#tab-new-case .action-bar');
if(bar) bar.insertAdjacentElement('afterend', banner);
const saveBtn = document.querySelector('#tab-new-case .btn-success');
if(saveBtn) saveBtn.textContent = '✓ Save Edits & Update Inventory';
const newFormBtn = document.getElementById('new-form-btn');
if(newFormBtn) newFormBtn.style.display = 'inline-flex';
// Load pre-op summary for this specific case
const linkedPreop = (window._cachedPreopRecords||[]).find(r => r['po-caseId'] === c.caseId);
if(linkedPreop) {
populateFinalizeFromPreop(linkedPreop);
} else {
// Hide stale summary while we fetch
const stale = document.getElementById('finalize-preop-summary');
if(stale) stale.style.display = 'none';
getDoc(doc(db,'atlas','preop')).then(snap => {
const records = snap.exists() ? (snap.data().records||[]) : [];
const preop = records.find(r => r['po-caseId'] === c.caseId);
if(preop) populateFinalizeFromPreop(preop);
}).catch(()=>{});
}
}, 100);
};
window.cancelEditCase = function() {
window._editingCaseId = null;
const banner = document.getElementById('case-edit-banner');
if(banner) banner.remove();
const saveBtn = document.querySelector('#tab-new-case .btn-success');
if(saveBtn) saveBtn.textContent = '✓ Finalize Case & Update Inventory';
clearCase();
};
window.startNewCaseForm = function() {
// Abandon current edit/draft without affecting the saved case, start fresh
window._editingCaseId = null;
window._activeDraftId = null;
const banner = document.getElementById('case-edit-banner');
if(banner) banner.remove();
const saveBtn = document.querySelector('#tab-new-case .btn-success');
if(saveBtn) saveBtn.textContent = '✓ Finalize Case & Update Inventory';
const newFormBtn = document.getElementById('new-form-btn');
if(newFormBtn) newFormBtn.style.display = 'none';
// Force-clear without the editing guard
caseItems = []; csEntries = [];
['caseId','procedure','provider','caseNotes','caseComments','caseDate','caseStartTime','caseEndTime'].forEach(id => {
  const el = document.getElementById(id); if(el) el.value = '';
});
const preopSummary = document.getElementById('finalize-preop-summary');
if(preopSummary) preopSummary.style.display = 'none';
renderCaseSupplies(); renderCSEntries(); refreshItemSelect(); updateCaseIdDisplays();
};

window.deleteFinalizedCase = async function(btnEl) {
const id = btnEl.getAttribute('data-id');
const label = btnEl.getAttribute('data-label') || 'this case';
const _c = cases.find(c => c.id === id);
const _cid = _c && _c.caseId;
const _isTest = _cid && _cid.startsWith('TEST-');
// Route every delete through the bulletproof purge.
if(_cid) {
  const prompt = _isTest
    ? 'Delete TEST case "' + label + '"?\n\nThis will fully remove it from every part of the app.'
    : 'Delete "' + label + '"?\n\nThis permanently removes the case, pre-op, payments row, CS log, deposits, saved PDFs, and payouts.\n\nThis cannot be undone.';
  if(!confirm(prompt)) return;
  await window._purgeCaseEverywhere(_cid);
  if(typeof _globalRefresh === 'function') _globalRefresh();
  if(typeof toastSuccess === 'function') toastSuccess('Case ' + _cid + ' deleted everywhere.');
  return;
}
const confirmed = confirm(
'Are you sure you want to delete "' + label + '"?\n\nThis will permanently remove the case from Case History, Overview, and all Reports.\n\nThis cannot be undone.'
);
if(!confirmed) return;
try {
// Find the case being deleted so we can also remove any linked draft
const caseBeingDeleted = cases.find(c => c.id === id);
const linkedCaseId = caseBeingDeleted?.caseId;
// Remove the case itself, plus any draft with the same caseId
cases = cases.filter(c => c.id !== id && !(c.draft && linkedCaseId && c.caseId === linkedCaseId));
setSyncing(true);
await saveCases();
// Clean up CS log entries for this case
if(linkedCaseId) {
  try {
    const csSnap = await getDoc(doc(db,'atlas','cslog'));
    if(csSnap.exists()) {
      const csEntries = csSnap.data().entries || [];
      const updatedCS = csEntries.filter(e => e.caseId !== linkedCaseId);
      if(updatedCS.length !== csEntries.length) {
        await setDoc(doc(db,'atlas','cslog'), { entries: updatedCS });
        console.log('Cleaned', csEntries.length - updatedCS.length, 'CS log entries for', linkedCaseId);
      }
    }
  } catch(csErr) { console.warn('CS log cleanup skipped:', csErr); }
  // Also clean up payments row
  try {
    if(typeof _paymentRows !== 'undefined') {
      const before = _paymentRows.length;
      _paymentRows = _paymentRows.filter(r => r.caseId !== linkedCaseId);
      if(_paymentRows.length !== before) {
        await setDoc(doc(db,'atlas','payments'), { rows: _paymentRows }).catch(()=>{});
      }
    }
  } catch(e) {}
  // Also clean up saved PDFs
  try {
    const pdfSnap = await getDoc(doc(db,'atlas','saved_pdfs'));
    if(pdfSnap.exists()) {
      const pdfs = pdfSnap.data().pdfs || [];
      const updatedPdfs = pdfs.filter(p => p.caseId !== linkedCaseId);
      if(updatedPdfs.length !== pdfs.length) {
        await setDoc(doc(db,'atlas','saved_pdfs'), { pdfs: updatedPdfs });
      }
    }
  } catch(e) {}
  // Also clean up payouts (Expenses & Distributions case-income entries)
  try {
    const payoutSnap = await getDoc(doc(db,'atlas','payouts'));
    if(payoutSnap.exists()) {
      const pdata = payoutSnap.data();
      const entries = pdata.entries || [];
      const updatedEntries = entries.filter(e => e.caseId !== linkedCaseId);
      if(updatedEntries.length !== entries.length) {
        await setDoc(doc(db,'atlas','payouts'), { ...pdata, entries: updatedEntries });
      }
    }
  } catch(e) {}
}
setSyncing(false);
// Re-render everything that shows cases
renderHistory();
renderReports();
renderCaseLog();
renderMidCase();
refreshDraftPicker();
if(typeof renderCSLog === 'function') renderCSLog();
if(document.getElementById('tab-calendar')?.classList.contains('active')) {
window._cachedPreopRecords = null;
renderCalendar();
}
alert('✓ Case deleted.');
} catch(e) {
setSyncing(false);
alert('Error deleting case: ' + e.message);
console.error(e);
}
};
window.toggleCase=function(id){document.getElementById('detail_'+id).classList.toggle('open');};
// Lift the parent row above neighbors while a dropdown is open so menu items
// don't fall behind buttons from the next row in the list (e.g. Patient Link
// click landing on Finalize Case underneath).
function _resetCaseItemZ(menu) {
  if(!menu) return;
  const row = menu.closest('.case-item');
  if(row) { row.style.zIndex = ''; row.style.position = ''; }
}
function _liftCaseItem(menu) {
  if(!menu) return;
  const row = menu.closest('.case-item');
  if(row) { row.style.position = 'relative'; row.style.zIndex = '500'; }
}
window.toggleMidCaseDropdown=function(id){
  document.querySelectorAll('[id^="midcase-menu-"]').forEach(m=>{
    if(m.id!=='midcase-menu-'+id) { m.style.display='none'; _resetCaseItemZ(m); }
  });
  const m=document.getElementById('midcase-menu-'+id);
  if(!m) return;
  const wasOpen = m.style.display === 'block';
  m.style.display = wasOpen ? 'none' : 'block';
  if(wasOpen) _resetCaseItemZ(m); else _liftCaseItem(m);
};
window.toggleHistoryDropdown=function(id){
  document.querySelectorAll('[id^="history-menu-"]').forEach(m=>{
    if(m.id!=='history-menu-'+id) { m.style.display='none'; _resetCaseItemZ(m); }
  });
  const m=document.getElementById('history-menu-'+id);
  if(!m) return;
  const wasOpen = m.style.display === 'block';
  m.style.display = wasOpen ? 'none' : 'block';
  if(wasOpen) _resetCaseItemZ(m); else _liftCaseItem(m);
};
document.addEventListener('click',function(){
  document.querySelectorAll('[id^="history-menu-"],[id^="midcase-menu-"]').forEach(m=>{
    m.style.display='none';
    _resetCaseItemZ(m);
  });
});
window.openLightbox=function(caseId, idx){
const c=cases.find(x=>x.id===caseId);
const imgs=caseImages(c);
if(!imgs.length)return;
const i = (typeof idx === 'number' && idx >= 0 && idx < imgs.length) ? idx : 0;
document.getElementById('lightboxImg').src=imgs[i].dataUrl;
document.getElementById('lightbox').style.display='flex';
};
window.closeLightbox=function(){document.getElementById('lightbox').style.display='none';};
// -- REPORTS --
function renderReports() {
const devCases=cases.filter(c=>c.worker==='dev'&&!c.draft);
const joshCases=cases.filter(c=>c.worker==='josh'&&!c.draft);
function buildCard(el,label,cs,color){
const total=cs.reduce((s,c)=>s+c.total,0);
const avg=cs.length?total/cs.length:0;
el.innerHTML=`<div class="card-title" style="color:${color}">${label}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div><div class="metric-label">Cases</div><div class="metric-value">${cs.length}</div></div><div><div class="metric-label">Total Spend</div><div class="metric-value">$${total.toFixed(0)}</div></div><div style="grid-column:1/-1"><div class="metric-label">Avg Cost / Case</div><div class="metric-value">$${avg.toFixed(2)}</div></div></div>`;
}
buildCard(document.getElementById('reportDev'),'Devarsh',devCases,'var(--dev)');
buildCard(document.getElementById('reportJosh'),'Josh',joshCases,'var(--josh)');
const allFinalized = cases.filter(c=>!c.draft);
buildCard(document.getElementById('reportCombined'),'Combined',allFinalized,'var(--info)');
const usage={};
allFinalized.forEach(c=>c.items.forEach(i=>{if(!usage[i.generic])usage[i.generic]={qty:0,cost:0};usage[i.generic].qty+=i.qty;usage[i.generic].cost+=i.lineTotal;}));
const sorted=Object.entries(usage).sort((a,b)=>b[1].cost-a[1].cost).slice(0,10);
const topCard=document.getElementById('topItemsCard');
if(!sorted.length){topCard.innerHTML='<div class="empty-state">No usage data yet</div>';return;}
topCard.innerHTML=`<div class="card-title">Top Items by Total Cost</div><div style="display:grid;grid-template-columns:2fr 80px 80px;gap:8px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint);padding-bottom:7px;border-bottom:1px solid var(--border-strong)"><span>Item</span><span style="text-align:right">Units Used</span><span style="text-align:right">Total Cost</span></div>
${sorted.map(([name,data])=>`
<div style="display:grid;grid-template-columns:2fr 80px 80px;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:13px">${name}</span><span style="font-size:13px;font-family:'DM Mono',monospace;text-align:right">${data.qty}</span><span style="font-size:13px;font-family:'DM Mono',monospace;text-align:right;font-weight:500">$${data.cost.toFixed(2)}</span></div>`).join('')}`;
}
// -- DRAFT CASE PICKER --
window.deleteSelectedDraft = async function() {
const sel = document.getElementById('draftCasePicker');
const id = sel ? sel.value : '';
if(!id) {
alert('Please select a draft from the dropdown first.');
return;
}
const c = cases.find(x => x.id === id);
const label = c ? c.caseId : 'this draft';
if(!confirm(`Delete draft "${label}"? This cannot be undone.`)) return;
cases = cases.filter(x => x.id !== id);
if(window._activeDraftId === id) {
window._activeDraftId = null;
clearCase();
}
await saveCases();
refreshDraftPicker();
alert(`Draft "${label}" deleted.`);
};
window.refreshDraftPicker = function refreshDraftPicker() {
const sel = document.getElementById('draftCasePicker');
if(!sel) return;
sel.innerHTML = '<option value="">— Start a new case —</option>';
const drafts = cases.filter(c => c.draft);
if(!drafts.length) {
const opt = document.createElement('option');
opt.disabled = true;
opt.textContent = 'No draft cases available';
sel.appendChild(opt);
return;
}
drafts.forEach(c => {
const opt = document.createElement('option');
opt.value = c.id;
const wname = c.worker === 'dev' ? 'Devarsh' : 'Josh';
const proc = c.procedure ? ` — ${c.procedure}` : '';
opt.textContent = `${c.caseId} (${wname} · ${c.date}${proc})`;
sel.appendChild(opt);
});
}
window.loadDraftFromPicker = function() {
// Don't interfere if we're editing a finalized case
if(window._editingCaseId) return;
const sel = document.getElementById('draftCasePicker');
const id = sel.value;
if(!id) {
// "Start a new case" selected — clear the form
clearCase();
return;
}
const c = cases.find(x => x.id === id);
if(!c) return;
// Fill in case info
const ncDisplay = document.getElementById('caseId-display');
const ncInput = document.getElementById('caseId');
if(ncDisplay) ncDisplay.textContent = c.caseId;
if(ncInput) ncInput.value = c.caseId;
document.getElementById('procedure').value = c.procedure || '';
document.getElementById('provider').value = c.provider || '';
document.getElementById('caseDate').value = c.date || todayStr();
if(document.getElementById('caseNotes')) document.getElementById('caseNotes').value = c.notes || '';
// Set correct worker
const mappedWorker = EMAIL_WORKER_MAP[currentUser.email.toLowerCase()] || 'dev';
if(c.worker === mappedWorker) {
currentWorker = c.worker;
}
// Load any already-saved items
caseItems = (c.items || []).map(i => ({
id: i.id, generic: i.generic, name: i.name, cost: i.cost, qty: i.qty,
stock: (items.find(x => x.id === i.id) ? getStock(items.find(x => x.id === i.id), c.worker) : 0)
}));
// Store the draft ID so we can remove it only when the case is fully saved
window._activeDraftId = id;
renderCaseSupplies();
refreshItemSelect();
};
// -- RESUME DRAFT CASE --
window.resumeCase = function(draftId) {
const c = cases.find(x => x.id === draftId);
if(!c) return;
// Clear first
clearCase();
// Pre-fill all fields
const el = id => document.getElementById(id);
if(el('caseId')) el('caseId').value = c.caseId || '';
if(el('procedure')) el('procedure').value = c.procedure || '';
if(el('provider')) el('provider').value = c.provider || '';
if(el('caseDate')) el('caseDate').value = c.date || todayStr();
if(el('caseNotes')) el('caseNotes').value = c.notes || '';
if(el('caseComments')) el('caseComments').value = c.caseComments || '';
if(el('caseStartTime')) el('caseStartTime').value = c.startTime || '';
if(el('caseEndTime'))   el('caseEndTime').value   = c.endTime   || '';
// Set worker to match the draft
setWorker(c.worker || currentWorker);
// Pre-load saved items
caseItems = (c.items || []).map(i => {
const invItem = items.find(x => x.id === i.id);
return {
id: i.id,
generic: i.generic || i.name || 'Unknown',
name: i.name || i.generic || 'Unknown',
cost: parseFloat(i.cost) || 0,
qty: parseFloat(i.qty) || 1,
stock: invItem ? getStock(invItem, c.worker) : parseFloat(i.qty) || 1
};
});
// Restore the case-log image preview (same reasoning as editFinalizedCase).
if(c.imageData) {
  pendingImageData = c.imageData;
  const uz = document.getElementById('uploadZone');
  const ip = document.getElementById('imgPreview');
  const pv = document.getElementById('previewImg');
  if(uz) uz.style.display = 'none';
  if(ip) ip.style.display = 'block';
  if(pv) pv.src = c.imageData;
} else {
  pendingImageData = null;
}
// Store draft ID
window._activeDraftId = draftId;
renderCaseSupplies();
refreshItemSelect();
// Load pre-op summary if available
const linkedPreop = (window._cachedPreopRecords||[]).find(r => r['po-caseId'] === c.caseId);
if(linkedPreop) {
populateFinalizeFromPreop(linkedPreop);
} else {
// Try loading from Firebase
getDoc(doc(db,'atlas','preop')).then(snap => {
const records = snap.exists() ? (snap.data().records||[]) : [];
const preop = records.find(r => r['po-caseId'] === c.caseId);
if(preop) populateFinalizeFromPreop(preop);
}).catch(()=>{});
}
const nfBtn = document.getElementById('new-form-btn');
if(nfBtn) nfBtn.style.display = 'inline-flex';
showTab('new-case');
};
window.viewLinkedPreop = async function(preopCaseId) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records || []) : [];
const record = records.find(r => r['po-caseId'] === preopCaseId);
if(!record) { alert('Pre-op record not found for Case ID: ' + preopCaseId); return; }
// Route through editPreopRecord so _editingPreopId is set and no new draft is created on save
await editPreopRecord(record.id);
} catch(e) {
alert('Error loading pre-op record.');
console.error(e);
}
};
// -- PRE-OP --
function getPreopCheckboxes() {
const fields = [
'po-npo','po-driver','po-nodrive',
'po-pupil-normal','po-pupil-dilated','po-pupil-constricted',
'po-cv-neg','po-cv-htn','po-cv-cad','po-cv-angina','po-cv-mi','po-cv-chf','po-cv-murmur','po-cv-arrythmia',
'po-ekg-nsr','po-ekg-afib','po-ekg-bbb','po-ekg-lvh','po-ekg-chngs',
'po-pulm-neg','po-pulm-asthma','po-pulm-copd','po-pulm-uri','po-pulm-o2','po-pulm-cpap','po-pulm-sleep-apnea','po-pulm-bl-breath-sounds','po-pulm-smoker',
'po-gastro-neg','po-gastro-gerd','po-gastro-hiat-hern','po-gastro-ulcer',
'po-renal-neg','po-renal-dialysis','po-renal-esrd',
'po-neuro-neg','po-neuro-depression','po-neuro-anxiety-disorder','po-neuro-seizures','po-neuro-cva','po-neuro-nm-disease',
'po-meta-neg','po-meta-iddm','po-meta-niddm','po-meta-thyroid','po-meta-hx-hep','po-meta-obesity','po-meta-morbid-obesity',
'po-teeth-intact','po-teeth-missing','po-teeth-denture',
'po-other-hiv','po-other-hep-c','po-other-anemia','po-other-steroids','po-other-cancers','po-other-drug-abuse','po-other-coagulopathy','po-other-chemotherapy',
'po-vss','po-a0x3','po-qa','po-iv-difficulty','po-anesthesia-issues','po-other-other','po-pupil-other-cb','po-cv-other-cb','po-ekg-other-cb','po-pulm-other-cb','po-gastro-other-cb','po-renal-other-cb','po-neuro-other-cb','po-meta-other-cb','po-teeth-other-cb','po-other-other-cb',
'po-heart-wnl','po-lungs-wnl','po-abd-wnl'
];
const data = {};
fields.forEach(id => {
const el = document.getElementById(id);
if(el) data[id] = el.checked;
});
// Mallampati radio
const mall = document.querySelector('input[name="mallampati"]:checked');
data['mallampati'] = mall ? mall.value : '';
return data;
}
function getPreopTextFields() {
const fields = ['po-caseId','po-surgeryDate','po-startTime','po-procedureType','po-callDateTime','po-provider','po-surgery-center','po-est-hours','po-patientEmail','po-contact-name','po-contact-type','po-contact-phone','po-pcp-name','po-pcp-phone','po-pcp-fax','po-pcp-appt-date','po-bellin-fax-sent-flag','po-driverName','po-driverRel','po-height-ft','po-height-in','po-weight-lbs','po-height-cm-val','po-weight-kg-val','po-bmi-val','po-iv-difficulty-comment','po-anesthesia-issues-comment','po-cv-other',
'po-allergies','po-medications','po-surgicalHistory','po-venipuncture','po-totalFluids','po-ebl',
'po-comments','po-heart-notes','po-lungs-notes','po-abd-notes','po-assessTime','po-cv-other','po-pupil-comment','po-cv-comment','po-ekg-comment','po-pulm-comment','po-gastro-comment','po-renal-comment','po-neuro-comment','po-meta-comment','po-teeth-comment','po-other-comment','po-other-other-comment','po-providerSignature','po-pupil-other-val','po-pupil-comment','po-cv-other-val','po-cv-comment','po-ekg-other-val','po-ekg-comment','po-pulm-other-val','po-pulm-comment','po-gastro-other-val','po-gastro-comment','po-renal-other-val','po-renal-comment','po-neuro-other-val','po-neuro-comment','po-meta-other-val','po-meta-comment','po-teeth-other-val','po-teeth-comment','po-other-other-val','po-other-comment',
'po-patientFirstName','po-patientLastName','po-patientPhone','po-patientDOB','po-archType','po-officeAddress',
'po-callStatus','po-invoiceStatus','po-paymentStatus','po-lastFollowupAt','po-reminderDate','po-depositSentAt'];
const data = {};
fields.forEach(id => {
const el = document.getElementById(id);
if(el) data[id] = el.value;
});
// Sex is a radio group, not a normal input — pull the checked value separately.
const sexEl = document.querySelector('input[name="po-sex"]:checked');
data['po-sex'] = sexEl ? sexEl.value : '';
return data;
}
// ── ONE-TIME ADMIN: Dedupe duplicate pre-op records ─────────────────────────
// Run from browser console: cleanupPreopDuplicates()
// Scans atlas/preop.records and atlas/cases, groups by po-caseId+worker (or
// caseId+worker for cases), and keeps only the most recently saved entry of
// each. Reports duplicates and prompts before writing.
window.cleanupPreopDuplicates = async function() {
  if(!confirm('Scan Firestore for duplicate pre-op records and case drafts?\n\nThis is safe to run — it will preview duplicates first and only write if you confirm.')) return;
  try {
    setSyncing(true);

    // ─ PREOP RECORDS ─────────────────────────────────────────────────────────
    const preopSnap = await getDoc(doc(db,'atlas','preop'));
    const preopRecs = preopSnap.exists() ? (preopSnap.data().records || []) : [];
    const preopBefore = preopRecs.length;

    const preopByKey = new Map();
    const preopOrphans = [];
    preopRecs.forEach((r, idx) => {
      const cid = r['po-caseId'];
      if(!cid) { preopOrphans.push(r); return; }
      const key = cid + '|' + (r.worker || 'dev');
      const existing = preopByKey.get(key);
      if(!existing) { preopByKey.set(key, r); return; }
      if((r.savedAt || '') > (existing.savedAt || '')) preopByKey.set(key, r);
    });
    const preopCleaned = [...Array.from(preopByKey.values()), ...preopOrphans];
    const preopRemoved = preopBefore - preopCleaned.length;

    // ─ CASES (drafts may also be duplicated) ─────────────────────────────────
    const allCases = await _loadAllCases();
    const casesBefore = allCases.length;

    const casesByKey = new Map();
    const casesOrphans = [];
    allCases.forEach(c => {
      // Only dedupe DRAFT cases — finalized cases are intentional records and
      // should never be touched by this cleanup.
      if(!c.draft) { casesOrphans.push(c); return; }
      const cid = c.caseId;
      if(!cid) { casesOrphans.push(c); return; }
      const key = cid + '|' + (c.worker || 'dev');
      const existing = casesByKey.get(key);
      if(!existing) { casesByKey.set(key, c); return; }
      if((c.savedAt || '') > (existing.savedAt || '')) casesByKey.set(key, c);
    });
    const casesCleaned = [...Array.from(casesByKey.values()), ...casesOrphans];
    const casesRemoved = casesBefore - casesCleaned.length;

    // ─ Build a duplicate report ──────────────────────────────────────────────
    const tally = (rows, getKey) => {
      const counts = {};
      rows.forEach(r => { const k = getKey(r); if(k) counts[k] = (counts[k]||0) + 1; });
      return Object.entries(counts).filter(([_,c]) => c > 1);
    };
    const preopDupes = tally(preopRecs, r => r['po-caseId'] && (r['po-caseId']+' ('+(r.worker||'dev')+')'));
    const draftDupes = tally(allCases.filter(c=>c.draft), c => c.caseId && (c.caseId+' ('+(c.worker||'dev')+') [draft]'));

    if(preopRemoved === 0 && casesRemoved === 0) {
      setSyncing(false);
      alert(`✓ No duplicates found.\n\nPre-op records: ${preopBefore}\nCase entries:   ${casesBefore}\n\nNothing to clean up.`);
      return;
    }

    const preopList = preopDupes.map(([k,c]) => `  • ${k}: ${c} copies → keep 1, remove ${c-1}`).join('\n') || '  (none)';
    const draftList = draftDupes.map(([k,c]) => `  • ${k}: ${c} copies → keep 1, remove ${c-1}`).join('\n') || '  (none)';
    const msg =
      `Pre-op records:\n` +
      `  Before: ${preopBefore}, After: ${preopCleaned.length}, Remove: ${preopRemoved}\n` +
      preopList + '\n\n' +
      `Draft cases:\n` +
      `  Before: ${casesBefore}, After: ${casesCleaned.length}, Remove: ${casesRemoved}\n` +
      draftList + '\n\n' +
      `Tiebreaker for each duplicate group: keep the entry with the most recent savedAt.\n\n` +
      `Proceed with cleanup?`;

    if(!confirm(msg)) { setSyncing(false); return; }

    // ─ Write back ────────────────────────────────────────────────────────────
    if(preopRemoved > 0) {
      await savePreopRecords(preopCleaned);
      window._rawPreopRecords = preopCleaned;
      window._cachedPreopRecords = [...preopCleaned];
    }
    if(casesRemoved > 0) {
      await _saveAllCases(casesCleaned);
      // Sync local `cases` array used by the rest of the app
      if(typeof cases !== 'undefined' && Array.isArray(cases)) {
        cases.length = 0;
        casesCleaned.forEach(c => cases.push(c));
      }
    }

    setSyncing(false);
    console.log('Cleanup report', {
      preop: { before: preopBefore, after: preopCleaned.length, removed: preopRemoved, dupes: preopDupes },
      cases: { before: casesBefore, after: casesCleaned.length, removed: casesRemoved, dupes: draftDupes }
    });
    alert(`✓ Cleanup complete!\n\nPre-op: removed ${preopRemoved} duplicate(s)\nDrafts: removed ${casesRemoved} duplicate(s)\n\nRefresh the page to see the cleaned data everywhere.`);
  } catch(e) {
    setSyncing(false);
    alert('Cleanup error: '+e.message);
    console.error('cleanupPreopDuplicates error:', e);
  }
};

window.savePreop = async function() {
// Jordan (assistant) can ONLY edit pre-ops that were spawned by Nicole's
// booking flow. She can't start a brand-new pre-op from scratch — they
// must come through the Schedule Pre-Op Visit modal first.
if(window._userRole === 'assistant' && !window._editingPreopId) {
  alert('You can only fill in pre-ops created by Nicole. Open a case from the Mid-Case list to edit it.');
  return;
}
const textData = getPreopTextFields();
const checkData = getPreopCheckboxes();
// Always generate Case ID fresh from surgery date at save time
const surgeryDate = textData['po-surgeryDate'];
if(!surgeryDate) {
alert('Please enter the Date of Surgery — it is used to generate the Case ID.');
return;
}
// Case Procedure is required — keeps Pre-Op records identifiable and lets
// the Mid-Case → Finalize flow inherit a meaningful procedure name when the
// case is loaded from this Pre-Op draft. Same rule as saveCase.
const procText = (textData['po-procedureType'] || '').trim();
if(!procText) {
  alert('Case Procedure is required.');
  const el = document.getElementById('po-procedureType');
  if(el) el.focus();
  return;
}
// Deposit Email is required — every Pre-Op needs a working email so the
// Send Deposit Link / invoice flows have somewhere to deliver to. Also do
// a quick format check so "yes" or other typos can't sneak through; the
// regex is intentionally loose (anything-at-anything-dot-anything) so it
// matches real-world addresses without false-positives on tags or pluses.
const emailText = (textData['po-patientEmail'] || '').trim();
if(!emailText) {
  alert('Deposit Email is required.');
  const el = document.getElementById('po-patientEmail');
  if(el) el.focus();
  return;
}
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailText)) {
  alert('Please enter a valid Deposit Email address.');
  const el = document.getElementById('po-patientEmail');
  if(el) { el.focus(); el.select && el.select(); }
  return;
}
// If editing an existing record, update it instead of creating new
if(window._editingPreopId) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records || []) : [];
const idx = records.findIndex(r => r.id === window._editingPreopId);
if(idx !== -1) {
// Keep the ORIGINAL case ID — do not regenerate
textData['po-caseId'] = records[idx]['po-caseId'];
// HIPAA: if PHI was hidden in the modal and never revealed, strip PHI
// fields from the update payload so we don't overwrite existing PHI
// values with empty strings.
let mergeText = textData, mergeCheck = checkData;
if(typeof window.isPHIHidden === 'function' && window.isPHIHidden(records[idx]['po-surgeryDate'], records[idx]['po-caseId']) && typeof window.stripPHIFromUpdate === 'function') {
  const stripped = window.stripPHIFromUpdate(textData, checkData);
  mergeText = stripped.textData;
  mergeCheck = stripped.checkData;
}
const updated = { ...records[idx], ...mergeText, ...mergeCheck, savedAt: new Date().toISOString() };
// Review-status transitions:
//   Jordan saves   → 'by-jordan'  (still pre-CRNA, row stays greyed)
//   CRNA saves     → cleared       (case graduates out of the pre-CRNA pipeline,
//                                    row returns to normal styling)
if(window._userRole === 'assistant') updated['po-reviewStatus'] = 'by-jordan';
else if(window._userRole === 'crna') updated['po-reviewStatus'] = '';
// HARDENED: filter out ALL records with same caseId+worker (cleans up any
// pre-existing duplicates) and re-add the updated one. Prevents dupes from
// ever surviving a save.
const cleaned = records.filter(r =>
  !(r['po-caseId'] === updated['po-caseId'] && (r.worker||'dev') === (updated.worker||'dev'))
);
cleaned.unshift(updated);
setSyncing(true);
await savePreopRecords(cleaned);
setSyncing(false);
try { logAudit('preop-edit', updated['po-caseId'] || ''); } catch(e){}
// Jordan stays on the form after editing too — keep _editingPreopId set so
// the next save continues to update this same record.
if(window._userRole === 'assistant') {
  toastSuccess('Pre-Op record updated');
} else {
  window._editingPreopId = null;
  const editBanner = document.getElementById('preop-edit-banner');
  if(editBanner) editBanner.remove();
  clearPreop();
  toastSuccess('Pre-Op record updated');
  showTab('mid-case');
}
return;
}
} catch(e) {
setSyncing(false);
alert('Error updating pre-op: ' + e.message);
console.error(e);
return;
}
}
// SINGLE Firestore read — generate ID and dedupe atomically
const snap0 = await getDoc(doc(db,'atlas','preop'));
const existingRecs = snap0.exists() ? (snap0.data().records||[]) : [];
// An assistant isn't a CRNA, so the pre-op is assigned to whichever CRNA they
// picked in the "Assign to CRNA" toggle. CRNAs use their own worker.
const effectiveWorker = (window._userRole === 'assistant') ? (window._assistantCrna || 'josh') : currentWorker;
// Always generate a fresh unique case ID — multiple cases on same day are allowed
const generatedId = generateCaseId(effectiveWorker, surgeryDate);
textData['po-caseId'] = generatedId;
// Update the display too
const display = document.getElementById('po-caseId-display');
const input = document.getElementById('po-caseId');
if(display) display.textContent = generatedId;
if(input) input.value = generatedId;
// If a record already exists with this caseId+worker, preserve its internal id
const existingMatch = existingRecs.find(r => r['po-caseId'] === generatedId && (r.worker||'dev') === effectiveWorker);
const record = {
id: existingMatch ? existingMatch.id : uid(),
savedAt: new Date().toISOString(),
worker: effectiveWorker,
...textData,
...checkData
};
// When Jordan creates/saves a brand-new pre-op directly, also tag as
// "by-jordan" so the CRNA knows she's the latest reviewer.
if(window._userRole === 'assistant') record['po-reviewStatus'] = 'by-jordan';
// HARDENED: filter out ALL records with same caseId+worker (not just findIndex
// the first one) — this cleans up any pre-existing duplicates on every save.
const cleaned = existingRecs.filter(r =>
  !(r['po-caseId'] === generatedId && (r.worker||'dev') === effectiveWorker)
);
cleaned.unshift(record);
setSyncing(true);
await savePreopRecords(cleaned);
setSyncing(false);
try { logAudit('preop-save', record['po-caseId'] || ''); } catch(e){}
// Create or update the linked draft case for this Case ID
// Check for any existing case with this ID (draft OR finalized)
const existingFinalized = cases.find(c => c.caseId === record['po-caseId'] && !c.draft);
if(existingFinalized) {
  // Finalized case exists — just update its provider/date/surgeryCenter from preop, don't create new draft
  const fIdx = cases.findIndex(c => c.id === existingFinalized.id);
  if(fIdx !== -1) {
    cases[fIdx] = { ...cases[fIdx],
      provider: record['po-provider'] || cases[fIdx].provider,
      date: record['po-surgeryDate'] || cases[fIdx].date,
      surgeryCenter: record['po-surgery-center'] || cases[fIdx].surgeryCenter || '',
      savedAt: new Date().toISOString()
    };
    await saveCases();
  }
} else {
const existingDraft = cases.find(c => c.caseId === record['po-caseId'] && c.draft);
if(existingDraft) {
// Update the existing draft's provider/date to match updated pre-op, preserve items
const draftIdx = cases.findIndex(c => c.id === existingDraft.id);
if(draftIdx !== -1) {
cases[draftIdx] = {
...cases[draftIdx],
provider: record['po-provider'] || cases[draftIdx].provider,
date: record['po-surgeryDate'] || cases[draftIdx].date,
surgeryCenter: record['po-surgery-center'] || cases[draftIdx].surgeryCenter || '',
savedAt: new Date().toISOString()
};
await saveCases();
}
} else {
const draftCase = {
id: uid(),
caseId: record['po-caseId'],
procedure: '',
provider: record['po-provider'] || '',
date: record['po-surgeryDate'] || todayStr(),
notes: '',
worker: effectiveWorker,
items: [],
total: 0,
imageData: null,
draft: true,
preopId: record['po-caseId'],
surgeryCenter: record['po-surgery-center'] || '',
savedAt: new Date().toISOString()
};
cases.unshift(draftCase);
await saveCases();
}
} // end of finalized check else
// Pre-fill the New Case form with pre-op info
prefillNewCase(record);
// Check if surgery is within 30 days — send immediate pre-op call reminder
const today2 = todayStr();
const surgDate2 = textData['po-surgeryDate'];
if(surgDate2) {
const daysUntil = Math.ceil((new Date(surgDate2+'T12:00:00') - new Date(today2+'T12:00:00')) / (1000*60*60*24));
if(daysUntil > 0 && daysUntil <= 30) {
// Surgery is within 30 days — trigger immediate pre-op call reminder
try {
const reminderWorkerUrl = 'https://atlas-reminder.blue-disk-9b10.workers.dev';
fetch(reminderWorkerUrl + '?immediate=1&caseId=' + encodeURIComponent(textData['po-caseId'] || '')).catch(()=>{});
console.log('Immediate pre-op call reminder triggered for', textData['po-caseId'], '(' + daysUntil + ' days until surgery)');
} catch(e) { console.warn('Could not trigger reminder:', e); }
}
}
// Refresh preop cache so all views have latest data
getDoc(doc(db,'atlas','preop')).then(ps => {
  window._rawPreopRecords = ps.exists() ? (ps.data().records||[]) : [];
  window._cachedPreopRecords = [...(window._rawPreopRecords||[])];
  _globalRefresh();
}).catch(()=>{});
alert('✓ Pre-Op record saved!');
// Jordan stays on the Pre-Op form so he can keep working on the same patient
// (attach docs, mark cleared, etc.) — set the editing id so the next save
// updates this record instead of duplicating it. Everyone else jumps back
// to Mid-Case as before.
if(window._userRole === 'assistant') {
  window._editingPreopId = record.id;
} else {
  clearPreop();
  showTab('mid-case');
}
};
function prefillNewCase(preopRecord) {
const caseIdEl = document.getElementById('caseId');
const providerEl = document.getElementById('provider');
const caseDateEl = document.getElementById('caseDate');
const procedureEl = document.getElementById('procedure');
if(caseIdEl) caseIdEl.value = preopRecord['po-caseId'] || '';
if(providerEl) providerEl.value = preopRecord['po-provider'] || '';
if(caseDateEl) caseDateEl.value = preopRecord['po-surgeryDate'] || todayStr();
if(procedureEl) procedureEl.value = preopRecord['po-procedureType'] || '';
}
// Toggle the M/F segmented button in the pre-op form. Also reachable from
// the inline onclick handlers in the rendered HTML and from editPreopRecord.
window._preopSetSex = function(value) {
  const group = document.getElementById('po-sex-group');
  if(!group) return;
  group.querySelectorAll('label').forEach(l => {
    const input = l.querySelector('input[type="radio"]');
    const isActive = input && input.value === value;
    l.style.background = isActive ? '#1d3557' : '#fff';
    l.style.color = isActive ? '#fff' : 'var(--text)';
    if(input) input.checked = isActive;
  });
};

window.clearPreop = function() {
// Clear text fields
['po-caseId','po-surgeryDate','po-startTime','po-callDateTime','po-provider','po-officeAddress','po-patientEmail','po-patientFirstName','po-patientLastName','po-patientPhone','po-patientDOB','po-archType','po-contact-name','po-contact-type','po-contact-phone','po-pcp-name','po-pcp-phone','po-pcp-fax','po-pcp-appt-date','po-bellin-fax-sent-flag','po-driverName','po-driverRel',
'po-height-ft','po-height-in','po-weight-lbs','po-iv-difficulty-comment','po-anesthesia-issues-comment',
'po-allergies','po-medications','po-surgicalHistory','po-venipuncture','po-totalFluids','po-ebl',
'po-comments','po-heart-notes','po-lungs-notes','po-abd-notes','po-assessTime','po-cv-other',
'po-est-hours'].forEach(id => {
const el = document.getElementById(id);
if(el) el.value = '';
});
// Clear dropdowns
const surgCenterSel = document.getElementById('po-surgery-center');
if(surgCenterSel) surgCenterSel.value = '';
// Clear checkboxes and radios
document.querySelectorAll('#tab-preop input[type="checkbox"]').forEach(el => el.checked = false);
document.querySelectorAll('#tab-preop input[type="radio"]').forEach(el => el.checked = false);
// Reset visual state of the Sex segmented button
window._preopSetSex('');
// Clear BMI displays
['po-height-cm','po-weight-kg','po-bmi'].forEach(id => {
const el = document.getElementById(id);
if(el) el.textContent = '—';
});
// Clear case ID display
const caseIdDisplay = document.getElementById('po-caseId-display');
if(caseIdDisplay) caseIdDisplay.textContent = '';
// NOTE: do NOT reset _editingPreopId here — editing state is managed by editPreopRecord/cancelEditPreop/savePreop
// Clear cached PHI-edit state and any PHI-hidden banner
window._editingPreopRecord = null;
if(typeof window.removePreopPHIBanner === 'function') window.removePreopPHIBanner();
// Reset the Procedure Type dropdown back to the empty option + hide custom.
if(typeof window._poProcedureTypeHydrate === 'function') window._poProcedureTypeHydrate();
};
async function renderPreopHistory() {
const el = document.getElementById('preopHistoryList');
el.innerHTML = '<div class="empty-state">Loading...</div>';
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const allRecords = snap.exists() ? (snap.data().records || []) : [];
window._rawPreopRecords = allRecords; // keep full cache in sync
// Only show cases that are NOT yet finalized (i.e. no finalized case in Case History)
const finalizedIds = new Set(cases.filter(c => !c.draft).map(c => c.caseId).filter(Boolean));
const records = allRecords
  .filter(r => !finalizedIds.has(r['po-caseId']))
  .sort((a,b) => {
  const dateA = a['po-surgeryDate']||'', dateB = b['po-surgeryDate']||'';
  if(dateA !== dateB) return dateA.localeCompare(dateB);
  // Same date — sort by po-startTime from preop record (earliest first)
  const timeA = a['po-startTime'] || '99:99';
  const timeB = b['po-startTime'] || '99:99';
  if(timeA !== timeB) return timeA.localeCompare(timeB);
  return (a['po-caseId']||'').localeCompare(b['po-caseId']||'');
});
if(!allRecords.length) { el.innerHTML='<div class="empty-state"><span class="empty-state-icon">📝</span><div class="empty-state-title">No pre-op records yet</div><div class="empty-state-sub">Start by creating your first pre-op assessment for an upcoming case.</div><button class="empty-state-cta" onclick="showTab(\'preop\')">+ New Pre-Op →</button></div>'; return; }
if(!records.length) { el.innerHTML='<div class="empty-state"><span class="empty-state-icon">✅</span><div class="empty-state-title">All caught up</div><div class="empty-state-sub">Every pre-op record has been finalized. Nice work.</div></div>'; return; }
el.innerHTML = records.map(r => {
const pill = r.worker==='dev' ? 'pill-dev' : 'pill-josh';
const wname = r.worker==='dev' ? 'Devarsh' : 'Josh';
const cvChecked = ['neg','htn','cad','angina','mi','chf','murmur','arrythmia'].filter(x=>r['po-cv-'+x]).join(', ').toUpperCase();
const pulmChecked = ['neg','asthma','copd','uri','o2','cpap','sleep-apnea','bl-breath-sounds','smoker'].filter(x=>r['po-pulm-'+x]).map(x=>x.replace(/-/g,' ')).join(', ').toUpperCase();
return `<div class="case-item"><div class="case-item-header" onclick="togglePreop('${r.id}')"><div><div class="case-name" style="display:flex;align-items:center;gap:8px">
${r['po-caseId'] || 'No Case ID'}
<span class="worker-pill ${pill}" style="font-size:10px">${wname}</span></div><div class="case-date">Surgery: ${fmtDate(r['po-surgeryDate'])||'—'} · Dentist: ${r['po-provider']||'—'}</div></div><div style="display:flex;gap:8px;align-items:center"><button onclick="event.stopPropagation();editPreopRecord('${r.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">✏ Edit</button><button onclick="event.stopPropagation();previewAnesthesiaRecord(window._rawPreopRecords?.find(x=>x.id==='${r.id}')||{})" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--info);border-color:var(--info)">🖨 Print Record</button><button onclick="event.stopPropagation();deletePreopRecord('${r.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">Delete</button><div style="font-size:12px;color:var(--text-faint)">Saved ${new Date(r.savedAt).toLocaleDateString()}</div></div></div><div class="case-items-list" id="preop-detail-${r.id}"><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px"><div>
${r['po-contact-phone']?`<div style="margin-bottom:8px;padding:8px 10px;background:var(--info-light);border-radius:var(--radius-sm)"><strong style="font-size:11px;text-transform:uppercase;color:var(--info)">📞 Contact${r['po-contact-type']?' · '+r['po-contact-type']:''}</strong><div style="font-size:13px;margin-top:3px;color:var(--text)">${r['po-contact-phone']}</div></div>`:''}
${r['po-allergies']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Allergies</strong><div style="font-size:13px;margin-top:3px">${r['po-allergies']}</div></div>`:''}
${cvChecked?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Cardiovascular</strong><div style="font-size:13px;margin-top:3px">${cvChecked}</div></div>`:''}
${pulmChecked?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Pulmonary</strong><div style="font-size:13px;margin-top:3px">${pulmChecked}</div></div>`:''}
${r['po-patientEmail']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Invoice Email</strong><div style="font-size:13px;margin-top:3px;font-family:'DM Mono',monospace">${r['po-patientEmail']}</div></div>`:''}
${r['po-medications']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Medications</strong><div style="font-size:13px;margin-top:3px">${r['po-medications']}</div></div>`:''}
</div><div>
${r['mallampati']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Mallampati Score</strong><div style="font-size:18px;font-weight:500;font-family:'DM Mono',monospace;margin-top:3px">${r['mallampati']}</div></div>`:''}
${r['po-totalFluids']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Total Fluids</strong><div style="font-size:13px;margin-top:3px">${r['po-totalFluids']}</div></div>`:''}
${r['po-ebl']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">EBL</strong><div style="font-size:13px;margin-top:3px">${r['po-ebl']}</div></div>`:''}
${r['po-surgicalHistory']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Surgical History</strong><div style="font-size:13px;margin-top:3px">${r['po-surgicalHistory']}</div></div>`:''}
${r['po-comments']?`<div style="margin-bottom:8px"><strong style="font-size:11px;text-transform:uppercase;color:var(--text-faint)">Comments</strong><div style="font-size:13px;margin-top:3px">${r['po-comments']}</div></div>`:''}
</div></div></div></div>`;
}).join('');
} catch(e) {
el.innerHTML = '<div class="empty-state">Error loading records</div>';
console.error(e);
}
}
// Wipe every trace of a case ID from Firestore + local caches. Used as the
// thorough cleanup for test cases (caseId starts with TEST-) so deleting one
// from anywhere in the app removes it everywhere. Cleans: preop, cases (draft
// + finalized), payments, cslog, deposits, saved_pdfs, payouts.
window._purgeCaseEverywhere = async function(caseId) {
  if(!caseId) return;
  try {
    setSyncing(true);
    // 1. Pre-op
    try {
      const snap = await getDoc(doc(db,'atlas','preop'));
      const records = snap.exists() ? (snap.data().records || []) : [];
      const updated = records.filter(r => r['po-caseId'] !== caseId);
      if(updated.length !== records.length) {
        await savePreopRecords(updated);
        window._rawPreopRecords = updated;
        window._cachedPreopRecords = [...updated];
      }
    } catch(e) { console.warn('purge: preop', e); }
    // 2. Cases (drafts + finalized)
    try {
      const before = cases.length;
      cases = cases.filter(c => c.caseId !== caseId);
      if(cases.length !== before) await saveCases();
    } catch(e) { console.warn('purge: cases', e); }
    // 3. Payments
    try {
      if(typeof _paymentRows !== 'undefined') {
        const before = _paymentRows.length;
        _paymentRows = _paymentRows.filter(r => r.caseId !== caseId);
        if(_paymentRows.length !== before) {
          await setDoc(doc(db,'atlas','payments'), { rows: _paymentRows });
        }
      }
    } catch(e) { console.warn('purge: payments', e); }
    // 4. CS log
    try {
      const snap = await getDoc(doc(db,'atlas','cslog'));
      if(snap.exists()) {
        const entries = snap.data().entries || [];
        const updated = entries.filter(e => e.caseId !== caseId);
        if(updated.length !== entries.length) {
          await setDoc(doc(db,'atlas','cslog'), { entries: updated });
        }
      }
    } catch(e) { console.warn('purge: cslog', e); }
    // 5. Deposits
    try {
      const snap = await getDoc(doc(db,'atlas','deposits'));
      if(snap.exists()) {
        const records = snap.data().records || [];
        const updated = records.filter(r => r.caseId !== caseId);
        if(updated.length !== records.length) {
          await setDoc(doc(db,'atlas','deposits'), { records: updated });
        }
      }
    } catch(e) { console.warn('purge: deposits', e); }
    // 6. Saved PDFs
    try {
      const snap = await getDoc(doc(db,'atlas','saved_pdfs'));
      if(snap.exists()) {
        const pdfs = snap.data().pdfs || [];
        const updated = pdfs.filter(p => p.caseId !== caseId);
        if(updated.length !== pdfs.length) {
          await setDoc(doc(db,'atlas','saved_pdfs'), { pdfs: updated });
        }
      }
    } catch(e) { console.warn('purge: saved_pdfs', e); }
    // 7. Payouts (Expenses & Distributions)
    try {
      const snap = await getDoc(doc(db,'atlas','payouts'));
      if(snap.exists()) {
        const pdata = snap.data();
        const entries = pdata.entries || [];
        const updated = entries.filter(e => e.caseId !== caseId);
        if(updated.length !== entries.length) {
          await setDoc(doc(db,'atlas','payouts'), { ...pdata, entries: updated });
        }
      }
    } catch(e) { console.warn('purge: payouts', e); }
    setSyncing(false);
    try { logAudit('purge-test-case', caseId, 'full delete across all collections'); } catch(e){}
  } catch(err) {
    setSyncing(false);
    console.error('purge error:', err);
    throw err;
  }
};

window.deletePreopRecord = async function(id) {
const _rec = (window._rawPreopRecords || []).find(r => r.id === id);
const _cid = _rec && _rec['po-caseId'];
const _isTest = _cid && _cid.startsWith('TEST-');
// Route every delete through the bulletproof purge so the case disappears
// from every collection in one click (no orphan payments rows, CS log,
// deposits, saved PDFs, or payouts left behind).
if(_cid) {
  const prompt = _isTest
    ? 'Delete TEST case ' + _cid + '?\n\nThis will fully remove it from every part of the app.'
    : 'Delete case ' + _cid + '?\n\nThis permanently removes the pre-op, the finalized case, payments row, CS log, deposits, saved PDFs, and payouts.\n\nThis cannot be undone.';
  if(!confirm(prompt)) return;
  await window._purgeCaseEverywhere(_cid);
  if(typeof _globalRefresh === 'function') _globalRefresh();
  if(typeof renderPreopHistory === 'function') renderPreopHistory();
  if(typeof toastSuccess === 'function') toastSuccess('Case ' + _cid + ' deleted everywhere.');
  return;
}
if(!confirm('Delete this pre-op record?\n\nThis will also remove the linked case from Mid-Case and Case History.')) return;
try {
  setSyncing(true);
  // 1. Get and update preop records
  const preopSnap = await getDoc(doc(db,'atlas','preop'));
  const records = preopSnap.exists() ? (preopSnap.data().records||[]) : [];
  const deletedRecord = records.find(r => r.id === id);
  const updatedPreop = records.filter(r => r.id !== id);
  await savePreopRecords(updatedPreop);
  // Update local preop cache immediately
  window._rawPreopRecords = updatedPreop;
  window._cachedPreopRecords = [...updatedPreop];
  // 2. Remove linked case from cases array (matched by caseId)
  if(deletedRecord?.['po-caseId']) {
    const deletedCaseId = deletedRecord['po-caseId'];
    const allCases = await _loadAllCases();
    const updatedCases = allCases.filter(c => c.caseId !== deletedCaseId);
    if(updatedCases.length !== allCases.length) {
      cases = updatedCases;
      await _saveAllCases(cases);
    }
    // 3. Remove from payments rows
    if(typeof _paymentRows !== 'undefined') {
      const before = _paymentRows.length;
      _paymentRows = _paymentRows.filter(r => r.caseId !== deletedCaseId);
      if(_paymentRows.length !== before) {
        await setDoc(doc(db,'atlas','payments'), { rows: _paymentRows }).catch(()=>{});
      }
    }
    // 4. Remove from CS log
    try {
      const csSnap = await getDoc(doc(db,'atlas','cslog'));
      if(csSnap.exists()) {
        const csEntries = csSnap.data().entries || [];
        const updatedCS = csEntries.filter(e => e.caseId !== deletedCaseId);
        if(updatedCS.length !== csEntries.length) {
          await setDoc(doc(db,'atlas','cslog'), { entries: updatedCS });
        }
      }
    } catch(csErr) { console.warn('CS log cleanup skipped:', csErr); }
    // 5. Remove from deposits
    try {
      const depSnap = await getDoc(doc(db,'atlas','deposits'));
      if(depSnap.exists()) {
        const depRecords = depSnap.data().records || [];
        const updatedDep = depRecords.filter(r => r.caseId !== deletedCaseId);
        if(updatedDep.length !== depRecords.length) {
          await setDoc(doc(db,'atlas','deposits'), { records: updatedDep });
        }
      }
    } catch(depErr) { console.warn('Deposits cleanup skipped:', depErr); }
    // 6. Remove from saved PDFs
    try {
      const pdfSnap = await getDoc(doc(db,'atlas','saved_pdfs'));
      if(pdfSnap.exists()) {
        const pdfs = pdfSnap.data().pdfs || [];
        const updatedPdfs = pdfs.filter(p => p.caseId !== deletedCaseId);
        if(updatedPdfs.length !== pdfs.length) {
          await setDoc(doc(db,'atlas','saved_pdfs'), { pdfs: updatedPdfs });
        }
      }
    } catch(pdfErr) { console.warn('Saved PDFs cleanup skipped:', pdfErr); }
  }
  setSyncing(false);
  // 4. Refresh all views
  _globalRefresh();
  renderPreopHistory();
} catch(e) { setSyncing(false); console.error(e); alert('Error deleting: '+e.message); }
};
// Procedure Type dropdown (with "Custom…") syncs into the hidden po-procedureType
// input so the existing save/load arrays don't need changes. Sync runs on
// user interaction; Hydrate runs after a record loads (or clearPreop) to
// reflect whatever's already stored in the hidden field.
window._poProcedureTypeSync = function() {
  const sel = document.getElementById('po-procedureType-select');
  const cus = document.getElementById('po-procedureType-custom');
  const hid = document.getElementById('po-procedureType');
  if(!sel || !cus || !hid) return;
  if(sel.value === '__custom') {
    cus.style.display = '';
    hid.value = cus.value || '';
  } else {
    cus.style.display = 'none';
    hid.value = sel.value || '';
  }
};
window._poProcedureTypeHydrate = function() {
  const sel = document.getElementById('po-procedureType-select');
  const cus = document.getElementById('po-procedureType-custom');
  const hid = document.getElementById('po-procedureType');
  if(!sel || !cus || !hid) return;
  const val = hid.value || '';
  const known = ['', 'General Anesthesia', 'Monitored Anesthesia Care (MAC) / IV Sedation'];
  if(known.includes(val)) {
    sel.value = val;
    cus.value = '';
    cus.style.display = 'none';
  } else {
    sel.value = '__custom';
    cus.value = val;
    cus.style.display = '';
  }
};

window.editPreopRecord = async function(id) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records || []) : [];
const record = records.find(r => r.id === id);
if(!record) { alert('Record not found.'); return; }
// (Prior to 2026-06-11 Jordan was blocked from CRNA-created records;
// removed per user feedback — he needs visibility on every case.)
// Navigate to pre-op tab FIRST so DOM elements exist
showTab('preop');
// Small delay to ensure tab is visible and DOM is ready
await new Promise(resolve => setTimeout(resolve, 150));
// Clear the form
clearPreop();
// Store editing ID immediately after clear (clearPreop resets it)
window._editingPreopId = id;
// Sync the assistant's CRNA toggle to the case's actual worker so the
// Pre-Op form (Case ID display, the active button, etc.) matches.
if(window._userRole === 'assistant' && typeof window._assistantSetCrna === 'function') {
  window._assistantSetCrna(record.worker || 'josh');
}
// HIPAA: hide PHI fields if case is 3+ days post-surgery (until reveal)
const phiHiddenInModal = typeof window.isPHIHidden === 'function' && window.isPHIHidden(record['po-surgeryDate'], record['po-caseId']);
window._editingPreopRecord = record; // stored so reveal can fill PHI fields later
// Fill saved fields (skip PHI fields when hidden — they'll fill on reveal)
Object.keys(record).forEach(fid => {
if(phiHiddenInModal && typeof window.isPHIField === 'function' && window.isPHIField(fid)) return;
const el = document.getElementById(fid);
if(!el) return;
if(el.type === 'checkbox') {
el.checked = !!record[fid];
} else if(el.type !== 'radio') {
el.value = record[fid] || '';
}
});
// Fill radio (mallampati) — also PHI
if(!phiHiddenInModal && record['mallampati']) {
const radio = document.querySelector(`input[name="mallampati"][value="${record['mallampati']}"]`);
if(radio) radio.checked = true;
}
// Restore Sex segmented button (PHI — only if not hidden)
if(!phiHiddenInModal && record['po-sex'] && typeof window._preopSetSex === 'function') {
  window._preopSetSex(record['po-sex']);
}
// Restore BMI displays (PHI — skip when hidden)
if(!phiHiddenInModal && record['po-height-cm-val']) {
const cmEl = document.getElementById('po-height-cm');
if(cmEl) cmEl.textContent = record['po-height-cm-val'] + ' cm';
}
if(!phiHiddenInModal && record['po-weight-kg-val']) {
const kgEl = document.getElementById('po-weight-kg');
if(kgEl) kgEl.textContent = record['po-weight-kg-val'] + ' kg';
}
if(!phiHiddenInModal && record['po-bmi-val']) {
const bmiEl = document.getElementById('po-bmi');
if(bmiEl) bmiEl.textContent = record['po-bmi-val'];
}
// Inject the PHI-hidden banner so the user can reveal
if(phiHiddenInModal && typeof window.injectPreopPHIBanner === 'function') {
window.injectPreopPHIBanner(record['po-caseId'] || '', record['po-surgeryDate'] || '');
}
// Restore OTHER rows visibility
['po-pupil','po-cv','po-ekg','po-pulm','po-gastro','po-renal','po-neuro','po-meta','po-teeth','po-other'].forEach(p => {
const cb = document.getElementById(p+'-other-cb');
const row = document.getElementById(p+'-other-row');
if(cb && row) row.style.display = cb.checked ? 'block' : 'none';
});
// Hydrate the Procedure Type dropdown from whatever just landed in the
// hidden po-procedureType — picks the right option, or falls into Custom…
// with the saved text shown.
if(typeof window._poProcedureTypeHydrate === 'function') window._poProcedureTypeHydrate();
// Check EKG conditions
checkEKGConditions();
// Update case ID display
updatePreopCaseIdDisplay();
// Remove any existing edit banner
const existing = document.getElementById('preop-edit-banner');
if(existing) existing.remove();
// Show edit banner — insert at top of pre-op tab
const editBanner = document.createElement('div');
editBanner.id = 'preop-edit-banner';
editBanner.style.cssText = 'background:var(--info-light);border:1px solid #b8cfe8;border-radius:var(--radius-sm);padding:10px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;';
editBanner.innerHTML = `
<span style="font-size:13px;color:var(--info);font-weight:500">✏ Editing: ${record['po-caseId']||'No Case ID'}</span><button onclick="cancelEditPreop()" class="btn btn-ghost btn-sm" style="font-size:11px">Cancel Edit</button>`;
// Find a reliable anchor in the pre-op tab
const preopTab = document.getElementById('tab-preop');
const actionBar = preopTab ? preopTab.querySelector('.action-bar') : null;
if(actionBar) {
actionBar.insertAdjacentElement('afterend', editBanner);
} else if(preopTab) {
preopTab.insertBefore(editBanner, preopTab.firstChild);
}
} catch(e) {
alert('Error loading record: ' + e.message);
console.error(e);
}
};
window.cancelEditPreop = function() {
const banner = document.getElementById('preop-edit-banner');
if(banner) banner.remove();
clearPreop();
// clearPreop may reset _editingPreopId — ensure it's null
window._editingPreopId = null;
};
window.togglePreop = function(id) { document.getElementById('preop-detail-'+id).classList.toggle('open'); };
// -- CASE LOG HELPERS --
window.clearCaseLogDates = function() {
const f = document.getElementById('cl-date-from');
const t = document.getElementById('cl-date-to');
if(f) f.value = '';
if(t) t.value = '';
renderCaseLog();
};
window.downloadCaseLogPDF = function() {
const worker = currentCaseLogTab;
const wname = worker === 'dev' ? 'Devarsh Murthy' : 'Josh Condado';
const fromDate = document.getElementById('cl-date-from')?.value || '';
const toDate = document.getElementById('cl-date-to')?.value || '';
let workerCases = cases.filter(c => c.worker === worker && !c.draft);
if(fromDate) workerCases = workerCases.filter(c => c.date >= fromDate);
if(toDate) workerCases = workerCases.filter(c => c.date <= toDate);
const sorted = [...workerCases].sort((a,b) => new Date(b.date) - new Date(a.date));
if(!sorted.length) { alert('No cases found for the selected range.'); return; }
const { jsPDF } = window.jspdf;
const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
const W = 215.9;
const navy = [29, 53, 87];
const lightGray = [240, 239, 233];
const gray = [107, 104, 96];
const black = [26, 25, 22];
const white = [255, 255, 255];
const lightBlue = [232, 238, 245];
// -- HEADER --
doc.setFillColor(...navy);
doc.rect(0, 0, W, 38, 'F');
// Logo white circle + image
doc.setFillColor(255, 255, 255);
doc.circle(20, 19, 12, 'F');
const logoEl = document.querySelector('img[style*="border-radius:50%"]');
if(logoEl) {
try { doc.addImage(logoEl.src, 'PNG', 9, 8, 22, 22); } catch(e) {}
}
doc.setTextColor(...white);
doc.setFontSize(18);
doc.setFont('helvetica', 'bold');
doc.text('ATLAS ANESTHESIA', 38, 16);
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.text('Mobile Anesthesia Services', 38, 23);
// Right side - title
doc.setFontSize(14);
doc.setFont('helvetica', 'bold');
doc.text('CASE LOG', W - 15, 16, { align: 'right' });
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.text(wname, W - 15, 23, { align: 'right' });
doc.text(`Generated: ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}`, W - 15, 29, { align: 'right' });
let y = 48;
// -- DATE RANGE BANNER --
if(fromDate || toDate) {
doc.setFillColor(...lightBlue);
doc.roundedRect(14, y, W-28, 10, 1, 1, 'F');
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...navy);
const rangeText = `Date Range: ${fromDate ? new Date(fromDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'All'} → ${toDate ? new Date(toDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'All'}`;
doc.text(rangeText, W/2, y+7, { align:'center' });
y += 14;
}
// -- SUMMARY CARDS --
doc.setFillColor(...lightGray);
doc.roundedRect(14, y, 56, 18, 2, 2, 'F');
doc.roundedRect(78, y, 56, 18, 2, 2, 'F');
doc.roundedRect(142, y, 56, 18, 2, 2, 'F');
doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(...gray);
doc.text('TOTAL CASES', 42, y+6, {align:'center'});
doc.text('THIS REPORT', 106, y+6, {align:'center'});
doc.text('PROVIDER', 170, y+6, {align:'center'});
doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.setTextColor(...navy);
doc.text(String(sorted.length), 42, y+15, {align:'center'});
doc.text(String(sorted.length), 106, y+15, {align:'center'});
doc.setFontSize(9); doc.setFont('helvetica','normal');
doc.text(worker==='dev'?'Devarsh':'Josh', 170, y+14, {align:'center'});
y += 26;
// -- TABLE HEADER --
doc.setFillColor(...navy);
doc.roundedRect(14, y, W-28, 9, 1, 1, 'F');
doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(...white);
doc.text('DATE', 18, y+6);
doc.text('CASE ID', 52, y+6);
doc.text('PROCEDURE', 90, y+6);
doc.text('DENTIST', 155, y+6);
doc.text('NOTES', 185, y+6);
y += 11;
// -- TABLE ROWS --
sorted.forEach((c, i) => {
// Check if we need a new page
if(y > 250) {
doc.addPage();
y = 20;
// Re-draw table header on new page
doc.setFillColor(...navy);
doc.roundedRect(14, y, W-28, 9, 1, 1, 'F');
doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(...white);
doc.text('DATE', 18, y+6);
doc.text('CASE ID', 52, y+6);
doc.text('PROCEDURE', 90, y+6);
doc.text('DENTIST', 155, y+6);
doc.text('NOTES', 185, y+6);
y += 11;
}
if(i%2===0) {
doc.setFillColor(...lightGray);
doc.rect(14, y, W-28, 9, 'F');
}
doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...black);
doc.text(c.date || '—', 18, y+6);
doc.text((c.caseId||'—').substring(0,18), 52, y+6);
// Truncate procedure if too long
const proc = (c.procedure||'—').substring(0,28);
doc.text(proc, 90, y+6);
doc.text((c.provider||'—').substring(0,14), 155, y+6);
const noteText = ((c.notes||'')+(c.caseComments?' '+c.caseComments:'')).substring(0,18);
if(noteText) { doc.setTextColor(...gray); doc.text(noteText, 185, y+6); }
y += 9;
});
// -- FOOTER LINE --
y += 6;
doc.setDrawColor(...navy);
doc.setLineWidth(0.8);
doc.line(14, y, W-14, y);
y += 5;
doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
doc.text(`Atlas Anesthesia · ${wname} Case Log · ${sorted.length} cases`, W/2, y, {align:'center'});
// File name
const fromStr = fromDate ? fromDate.replace(/-/g,'') : 'all';
const toStr = toDate ? toDate.replace(/-/g,'') : 'all';
doc.save(`Atlas-CaseLog-${worker.toUpperCase()}-${fromStr}-${toStr}.pdf`);
};
// -- INLINE COST UPDATE --
window.updateCost = async function(id, val) {
const cost = parseFloat(val);
if(isNaN(cost) || cost < 0) return;
const item = items.find(i => i.id === id);
if(!item) return;
const oldCost = item.costPerUnit;
item.costPerUnit = cost;
// Log price change in item history
if(!item.priceHistory) item.priceHistory = [];
item.priceHistory.unshift({
date: todayStr(),
oldCost: parseFloat(oldCost.toFixed(2)),
newCost: parseFloat(cost.toFixed(2)),
changedBy: currentUser ? currentUser.email.split('@')[0] : 'unknown'
});
await saveInventory();
refreshItemSelect();
};
// -- SET INVOICE PROVIDER FROM LOGGED IN USER --
function setInvoiceProvider() {
if(!currentUser) return;
const w = EMAIL_WORKER_MAP[currentUser.email.toLowerCase()];
const name = w === 'dev' ? 'Devarsh Murthy' : 'Josh Condado';
const display = document.getElementById('inv-provider-display');
const input = document.getElementById('inv-provider');
if(display) display.textContent = name;
if(input) input.value = name;
}
// -- CASE LOG --
let currentCaseLogTab = 'dev';
window.setCaseLogTab = function(tab) {
currentCaseLogTab = tab;
['dev','josh'].forEach(x => {
document.getElementById('cltab-'+x).classList.toggle('active', x===tab);
document.getElementById('caselog-'+x).style.display = x===tab ? 'block' : 'none';
});
};
window.renderCaseLog = function renderCaseLog() {
const fromDate = document.getElementById('cl-date-from')?.value || '';
const toDate = document.getElementById('cl-date-to')?.value || '';
['dev','josh'].forEach(worker => {
let workerCases = cases.filter(c => c.worker === worker && !c.draft);
if(fromDate) workerCases = workerCases.filter(c => c.date >= fromDate);
if(toDate) workerCases = workerCases.filter(c => c.date <= toDate);
const wname = worker === 'dev' ? 'Devarsh' : 'Josh';
// Metrics
const total = workerCases.reduce((s,c) => s+c.total, 0);
const avg = workerCases.length ? total/workerCases.length : 0;
const thisMonth = workerCases.filter(c => {
const d = new Date(c.date);
const now = new Date();
return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
});
const monthTotal = thisMonth.reduce((s,c) => s+c.total, 0);
// Total unique days worked
const uniqueDays = new Set(workerCases.map(c => c.date)).size;
// Avg cost per case
const avgCost = workerCases.length ? (total / workerCases.length) : 0;
document.getElementById('cl-metrics-'+worker).innerHTML = `
<div class="metric-card"><div class="metric-label">Total Cases</div><div class="metric-value">${workerCases.length}</div></div>
<div class="metric-card"><div class="metric-label">Total Days</div><div class="metric-value">${uniqueDays}</div></div>
<div class="metric-card"><div class="metric-label">This Month</div><div class="metric-value">${thisMonth.length}</div></div>
<div class="metric-card"><div class="metric-label">Avg Cost / Case</div><div class="metric-value">$${avgCost.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})}</div></div>
`;
// Table
const tableEl = document.getElementById('cl-table-'+worker);
if(!workerCases.length) {
tableEl.innerHTML = '<div class="empty-state">No cases logged for ' + wname + ' yet</div>';
return;
}
const sorted = [...workerCases].sort((a,b) => new Date(b.date) - new Date(a.date));
tableEl.innerHTML = `
<div style="display:grid;grid-template-columns:110px 1fr 120px 90px 70px;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint)"><span>Date</span><span>Procedure</span><span>Case ID</span><span>Dentist</span><span></span></div>
${sorted.map((c,i) => `
<div style="display:grid;grid-template-columns:110px 1fr 120px 90px 70px;gap:8px;padding:9px 0;border-bottom:1px solid var(--border);align-items:center;background:${i%2===0?'transparent':'var(--surface2)'}"><div style="font-size:13px;font-family:'DM Mono',monospace">${fmtDate(c.date)}</div><div style="font-size:13px;font-weight:500">${c.procedure||'—'}
${c.notes?`<div style="font-size:11px;color:var(--text-faint)">${c.notes}</div>`:''}
${c.caseComments?`<div style="font-size:11px;color:var(--text-faint);font-style:italic">${c.caseComments}</div>`:''}
</div><div style="font-size:11px;font-family:'DM Mono',monospace;color:var(--text-faint)">${c.caseId||'—'}</div><div style="font-size:13px;color:var(--text-muted)">${c.provider||'—'}</div><div><button onclick="editFinalizedCase('${c.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px">✏ Edit</button></div></div>`).join('')}
<div style="padding-top:12px;margin-top:4px;border-top:2px solid var(--border-strong)"><span style="font-size:13px;font-weight:600;color:var(--text-muted)">${workerCases.length} case${workerCases.length!==1?'s':''} total</span></div>
`;
});
}
// -- CONTROLLED SUBSTANCES --
const STRIPE_WORKER_URL = 'https://gentle-voice-6881.blue-disk-9b10.workers.dev';
// -- CASE TOTAL HELPER --
function getCaseTotal(c) {
const suppliesTotal = (c.items||[]).reduce((s,i) => s + (parseFloat(i.cost)||0)*(parseFloat(i.qty)||0), 0);
const csTotal = (c.savedCsEntries||[]).reduce((s,e) => {
const cpm = getCostPerMG(e.drug);
const mg = (parseFloat(e.amountGiven)||0) + (parseFloat(e.wastedAmt)||0);
return s + cpm * mg;
}, 0);
return suppliesTotal + csTotal;
}
// -- DATE FORMATTER --
function fmtDate(dateStr) {
if(!dateStr || dateStr === '—') return dateStr || '—';
const parts = dateStr.split('-');
if(parts.length !== 3) return dateStr;
return `${parts[1]}/${parts[2]}/${parts[0]}`;
}
const CS_DRUGS = {
ephedrine: { label: 'Ephedrine', invId: '70700-0249-25', keywords: ['ephedrine'], vialML: 1, vialMG: 50 },
ketamine:  { label: 'Ketamine',  invId: '0143-9509-10',  keywords: ['ketamine'],  vialML: 5, vialMG: 500 },
versed:    { label: 'Versed (Midazolam)', invId: null,   keywords: ['versed','midazolam'], vialML: 2, vialMG: 2 }
};
// Returns cost per mg for a CS drug based on vial size
function getCostPerMG(drugKey) {
const drug = CS_DRUGS[drugKey];
if(!drug) return 0;
linkCSInvIds();
const invId = drug.invId;
if(!invId) return 0;
const invItem = items.find(i => i.id === invId);
if(!invItem) return 0;
// Use vialMG (total mg per vial) for accurate cost per mg
const totalMG = drug.vialMG || drug.vialML; // fallback to vialML if vialMG not set
return invItem.costPerUnit / totalMG;
}
// Legacy alias — use getCostPerMG going forward
function getCostPerML(drugKey) { return getCostPerMG(drugKey); }
// Returns true if an inventory item is a controlled substance (should be excluded from supplies)
function isCSItem(item) {
const nameLC = (item.name + ' ' + item.generic).toLowerCase();
return Object.values(CS_DRUGS).some(drug =>
(drug.invId && drug.invId === item.id) ||
drug.keywords.some(kw => nameLC.includes(kw))
);
}
// When a CS drug is added to inventory, link it to CS_DRUGS
function linkCSInvIds() {
Object.entries(CS_DRUGS).forEach(([key, drug]) => {
if(!drug.invId) {
const match = items.find(i => {
const n = (i.name + ' ' + i.generic).toLowerCase();
return drug.keywords.some(kw => n.includes(kw));
});
if(match) CS_DRUGS[key].invId = match.id;
}
});
}
let csEntries = []; // current case CS entries being built
let currentCSEntry = null; // entry awaiting witness sig
let witnessDrawing = false;
let witnessLastX = 0, witnessLastY = 0;
let currentCSTab = 'ephedrine';
window.addCSEntry = function() {
const sel = document.getElementById('addCSSelect');
const drug = sel ? sel.value : 'nubain';
if(!drug) { alert('Please select a controlled substance first.'); return; }
const id = uid();
csEntries.push({
id, drug, amountGiven: '', leftInVial: '', wasted: false,
wastedAmt: '', newBottle: false, crnaSignature: '', witnessSignature: ''
});
if(sel) sel.value = '';
renderCSEntries();
renderCaseSupplies();
};
function renderCSEntries() {
const container = document.getElementById('cs-entries-container');
const totalBar = document.getElementById('cs-total-bar');
if(!container) return;
if(!csEntries.length) {
container.innerHTML = '<div style="font-size:13px;color:var(--text-faint);padding:8px 0">No controlled substances added yet.</div>';
if(totalBar) totalBar.innerHTML = '';
return;
}
let csTotal = 0;
container.innerHTML = csEntries.map((entry, idx) => {
const inv = CS_DRUGS[entry.drug]?.invId ? items.find(i => i.id === CS_DRUGS[entry.drug].invId) : null;
const stock = inv ? getStock(inv, currentWorker) : '?';
const costPerML = getCostPerMG(entry.drug); // returns cost per mg
const drug = CS_DRUGS[entry.drug];
const vialCost = inv ? inv.costPerUnit : 0;
const amtGiven = parseFloat(entry.amountGiven) || 0;
const wasted = parseFloat(entry.wastedAmt) || 0;
const totalML = amtGiven + wasted;
const estimatedCost = costPerML * totalML;
csTotal += estimatedCost;
const ei = idx; // alias to avoid any closure issues
return `
<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><div style="font-size:14px;font-weight:500">${CS_DRUGS[entry.drug]?.label || entry.drug}</div><div style="display:flex;align-items:center;gap:10px"><span style="font-size:11px;color:var(--text-faint)">Stock: ${stock} vials · $${vialCost.toFixed(2)}/vial · $${costPerML.toFixed(2)}/mg</span><button onclick="window.removeCSEntry(${ei})" style="background:none;border:none;cursor:pointer;color:var(--text-faint);font-size:20px;line-height:1">×</button></div></div><div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:14px"><div><div style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Amount Given (mg)</div><input type="number" min="0" step="0.1" value="${entry.amountGiven}" placeholder="0"
onchange="window.updateCSEntry(${ei},'amountGiven',this.value)"
style="width:100%;padding:8px 10px;font-size:14px;text-align:center"></div><div><div style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Left in Vial (mg)</div><input type="number" min="0" step="0.1" value="${entry.leftInVial}" placeholder="0.0"
onchange="window.updateCSEntry(${ei},'leftInVial',this.value)"
style="width:100%;padding:8px 10px;font-size:14px;text-align:center"></div><div><div style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Wasted (mg)</div><input type="number" min="0" step="0.1" value="${entry.wastedAmt}" placeholder="0.0"
onchange="window.updateCSEntry(${ei},'wastedAmt',this.value)"
style="width:100%;padding:8px 10px;font-size:14px;text-align:center"></div><div><div style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Estimated Cost</div><div style="padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);text-align:center">
${totalML > 0 && costPerML > 0
? `<div style="font-size:15px;font-weight:500;font-family:'DM Mono',monospace;color:var(--warn)">≈ $${estimatedCost.toFixed(2)}</div><div style="font-size:10px;color:var(--text-faint)">${totalML.toFixed(2)} mg × $${costPerML.toFixed(2)}/mg</div>`
: `<div style="font-size:13px;color:var(--text-faint)">Enter mg above</div>`
}
</div></div></div><div style="padding-top:12px;border-top:1px solid var(--border)"><div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px"><label style="margin:0;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;cursor:pointer"><input type="checkbox" ${entry.newBottle?'checked':''} onchange="updateCSEntry(${idx},'newBottle',this.checked)"
style="width:16px;height:16px"><span>New Bottle Opened</span>
${entry.newBottle ? '<span style="background:var(--accent-light);color:var(--accent);font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px">YES</span>' : ''}
</label></div><div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center"><div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--text-faint);font-weight:500">Witness:</span>
${entry.witnessSignature
? `<div style="display:flex;align-items:center;gap:6px"><img src="${entry.witnessSignature}" style="height:32px;border:1px solid var(--border);border-radius:4px;background:#fff;padding:2px"><button class="btn btn-ghost btn-sm" onclick="window.openWitnessModal(${ei})" style="font-size:11px">Re-sign</button></div>`
: `<button class="btn btn-ghost btn-sm" onclick="window.openWitnessModal(${ei})" style="font-size:11px;color:var(--warn);border-color:var(--warn)">✍ Witness Sign</button>`
}
</div><div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--text-faint);font-weight:500">Provider:</span>
${entry.providerSignature
? `<div style="display:flex;align-items:center;gap:6px"><img src="${entry.providerSignature}" style="height:32px;border:1px solid var(--border);border-radius:4px;background:#fff;padding:2px"><button class="btn btn-ghost btn-sm" onclick="window.openCSProviderModal(${ei})" style="font-size:11px">Re-sign</button></div>`
: `<button class="btn btn-ghost btn-sm" onclick="window.openCSProviderModal(${ei})" style="font-size:11px;color:var(--info);border-color:var(--info)">✍ Provider Sign</button>`
}
</div></div></div></div>`;
}).join('');
// Update CS total bar
if(totalBar) {
totalBar.innerHTML = csTotal > 0 ? `
<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--warn-light);border-radius:var(--radius-sm);border:1px solid #f0c4b0;margin-top:6px"><span style="font-size:13px;font-weight:600;color:var(--warn)">Estimated CS Cost</span><span style="font-size:18px;font-weight:500;font-family:'DM Mono',monospace;color:var(--warn)">≈ $${csTotal.toFixed(2)}</span></div>` : '';
}
}
window.updateCSEntry = function(idx, field, val) {
csEntries[idx][field] = val;
if(field === 'hasOther') {
// Toggle other comment visibility without full re-render
const row = document.getElementById('cs-other-comment-row-' + idx);
if(row) { row.style.display = val ? 'block' : 'none'; return; }
}
renderCSEntries();
renderCaseSupplies();
};
window.removeCSEntry = function(idx) {
csEntries.splice(idx, 1);
renderCSEntries();
renderCaseSupplies();
};
// -- WITNESS SIGNATURE MODAL --
window.openWitnessModal = function(entryIdx) {
currentCSEntry = entryIdx;
document.getElementById('witnessModal').style.display = 'flex';
clearWitnessCanvas();
setupWitnessCanvas();
};
window.closeWitnessModal = function() {
document.getElementById('witnessModal').style.display = 'none';
currentCSEntry = null;
};
function setupWitnessCanvas() {
const canvas = document.getElementById('witnessCanvas');
const ctx = canvas.getContext('2d');
ctx.strokeStyle = '#1d3557';
ctx.lineWidth = 2.5;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
function getPos(e) {
const rect = canvas.getBoundingClientRect();
const scaleX = canvas.width / rect.width;
const scaleY = canvas.height / rect.height;
const src = e.touches ? e.touches[0] : e;
return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
}
canvas.onmousedown = canvas.ontouchstart = function(e) {
e.preventDefault();
witnessDrawing = true;
const p = getPos(e);
witnessLastX = p.x; witnessLastY = p.y;
ctx.beginPath();
ctx.moveTo(p.x, p.y);
};
canvas.onmousemove = canvas.ontouchmove = function(e) {
e.preventDefault();
if(!witnessDrawing) return;
const p = getPos(e);
ctx.lineTo(p.x, p.y);
ctx.stroke();
witnessLastX = p.x; witnessLastY = p.y;
};
canvas.onmouseup = canvas.ontouchend = function(e) {
e.preventDefault();
witnessDrawing = false;
};
}
window.clearWitnessCanvas = function() {
const canvas = document.getElementById('witnessCanvas');
const ctx = canvas.getContext('2d');
ctx.clearRect(0, 0, canvas.width, canvas.height);
};
window.saveWitnessSignature = function() {
const canvas = document.getElementById('witnessCanvas');
const sigData = canvas.toDataURL('image/png');
if(currentCSEntry !== null) {
csEntries[currentCSEntry].witnessSignature = sigData;
renderCSEntries();
}
closeWitnessModal();
}

// -- SAVE CS ENTRIES WITH CASE --
async function saveCSEntriesWithCase(caseId, caseDate, provider) {
if(!csEntries.length) return;
const snap = await getDoc(doc(db,'atlas','cslog'));
const existing = snap.exists() ? (snap.data().entries || []) : [];
csEntries.forEach(entry => {
const logEntry = {
id: uid(),
drug: entry.drug,
drugLabel: CS_DRUGS[entry.drug]?.label || entry.drug,
caseId,
date: caseDate,
provider,
worker: currentWorker,
amountGiven: parseFloat(entry.amountGiven) || 0,
leftInVial: parseFloat(entry.leftInVial) || 0,
wastedAmt: parseFloat(entry.wastedAmt) || 0,
newBottle: entry.newBottle || false,
witnessSignature: entry.witnessSignature || '',
providerSignature: entry.providerSignature || '',
hasOther: entry.hasOther || false,
otherComment: entry.otherComment || '',
savedAt: new Date().toISOString()
};
existing.unshift(logEntry);
// Deduct from inventory only — CS drugs are tracked separately, not added to case supplies
linkCSInvIds();
const invId = CS_DRUGS[entry.drug]?.invId;
if(invId) {
const invItem = items.find(i => i.id === invId);
if(invItem && entry.newBottle) {
const newStock = Math.max(0, getStock(invItem, currentWorker) - 1);
setStock(invItem, currentWorker, newStock);
}
}
});
setSyncing(true);
const safeEntries = sanitizeForFirestore(existing) || [];
await setDoc(doc(db,'atlas','cslog'), { entries: safeEntries });
await saveInventory();
setSyncing(false);
csEntries = [];
renderCSEntries();
}
// -- CS LOG TAB --
window.setCSTab = function(tab) {
currentCSTab = tab;
['ephedrine','ketamine','versed'].forEach(x => {
const btn = document.getElementById('cstab-'+x);
if(btn) btn.classList.toggle('active', x===tab);
});
renderCSLog();
};
window.clearCSDates = function() {
document.getElementById('cs-date-from').value = '';
document.getElementById('cs-date-to').value = '';
renderCSLog();
};
window.renderCSLog = async function renderCSLog() {
const el = document.getElementById('cs-log-content');
if(!el) return;
el.innerHTML = '<div class="empty-state">Loading...</div>';
try {
const snap = await getDoc(doc(db,'atlas','cslog'));
const all = snap.exists() ? (snap.data().entries || []) : [];
const fromDate = document.getElementById('cs-date-from')?.value || '';
const toDate = document.getElementById('cs-date-to')?.value || '';
// Only show entries for cases that still exist as finalized cases
const finalizedCaseIds = new Set(cases.filter(c => !c.draft).map(c => c.caseId).filter(Boolean));
let entries = all.filter(e => e.drug === currentCSTab && (!e.caseId || finalizedCaseIds.has(e.caseId)));
if(fromDate) entries = entries.filter(e => e.date >= fromDate);
if(toDate) entries = entries.filter(e => e.date <= toDate);
entries.sort((a,b) => new Date(b.date) - new Date(a.date));
const drug = CS_DRUGS[currentCSTab];
if(!entries.length) {
el.innerHTML = `<div class="empty-state">No ${drug.label} entries found</div>`;
return;
}
el.innerHTML = `
<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><div class="card-title" style="margin-bottom:0">${drug.label} — ${entries.length} entr${entries.length===1?'y':'ies'}</div></div><div style="display:grid;grid-template-columns:90px 70px 1fr 80px 80px 70px 60px 80px 80px;gap:6px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)"><span>Date</span><span>Time</span><span>Location/Case</span><span>Given</span><span>Left in Vial</span><span>Wasted</span><span>New Btl</span><span>CRNA</span><span>Witness</span></div>
${entries.map((e,i) => `
<div style="display:grid;grid-template-columns:90px 70px 1fr 80px 80px 70px 60px 80px 80px;gap:6px;padding:8px 0;border-bottom:1px solid var(--border);align-items:center;background:${i%2===0?'transparent':'var(--surface2)'}"><div style="font-size:12px;font-family:'DM Mono',monospace">${fmtDate(e.date)||'—'}</div><div style="font-size:12px;color:var(--text-faint)">${e.savedAt?new Date(e.savedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'—'}</div><div style="font-size:12px;font-weight:500">${e.caseId||'—'}<div style="font-size:11px;color:var(--text-faint)">${e.provider||''}</div></div><div style="font-size:12px;font-family:'DM Mono',monospace">${e.amountGiven||0} mg</div><div style="font-size:12px;font-family:'DM Mono',monospace">${e.leftInVial||0} mg</div><div style="font-size:12px;font-family:'DM Mono',monospace;color:${e.wastedAmt>0?'var(--warn)':'var(--text-faint)'}">${e.wastedAmt||0} mg</div><div style="text-align:center">${e.newBottle?'<span style="background:var(--accent-light);color:var(--accent);font-size:10px;font-weight:600;padding:2px 6px;border-radius:10px">YES</span>':'—'}</div><div style="font-size:11px;color:var(--text-muted)">${e.worker==='dev'?'Devarsh':'Josh'}</div><div>${e.witnessSignature?`<img src="${e.witnessSignature}" style="height:30px;border:1px solid var(--border);border-radius:3px;background:#fff" title="Witness signature">`:'<span style="font-size:11px;color:var(--warn)">No sig</span>'}</div></div>`).join('')}
</div>`;
} catch(err) {
el.innerHTML = '<div class="empty-state">Error loading CS log</div>';
console.error(err);
}
}
window.downloadCSLogPDF = async function() {
const drug = CS_DRUGS[currentCSTab];
const fromDate = document.getElementById('cs-date-from')?.value || '';
const toDate = document.getElementById('cs-date-to')?.value || '';
const snap = await getDoc(doc(db,'atlas','cslog'));
const all = snap.exists() ? (snap.data().entries || []) : [];
let entries = all.filter(e => e.drug === currentCSTab);
if(fromDate) entries = entries.filter(e => e.date >= fromDate);
if(toDate) entries = entries.filter(e => e.date <= toDate);
entries.sort((a,b) => new Date(a.date) - new Date(b.date));
if(!entries.length) { alert('No entries found for this drug/range.'); return; }
const { jsPDF } = window.jspdf;
const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'letter' });
const W = 279.4, H = 215.9;
const navy = [29,53,87], white = [255,255,255], gray = [107,104,96];
const lightGray = [240,239,233], warn = [181,69,27], black = [26,25,22];
// Header
doc.setFillColor(...navy);
doc.rect(0, 0, W, 28, 'F');
doc.setFillColor(255,255,255);
doc.circle(16, 14, 10, 'F');
const logoEl = document.querySelector('img[style*="border-radius:50%"]');
if(logoEl) { try { doc.addImage(logoEl.src,'PNG',7,5,18,18); } catch(e){} }
doc.setTextColor(...white);
doc.setFontSize(16); doc.setFont('helvetica','bold');
doc.text('CONTROLLED SUBSTANCE INVENTORY LOG', 32, 12);
doc.setFontSize(11); doc.setFont('helvetica','normal');
doc.text(drug.label.toUpperCase(), 32, 20);
doc.setFontSize(9);
doc.text(`Generated: ${new Date().toLocaleDateString()}`, W-10, 10, {align:'right'});
if(fromDate||toDate) doc.text(`Period: ${fromDate||'start'} to ${toDate||'present'}`, W-10, 18, {align:'right'});
// Month/CRNA header row
let y = 34;
doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(...black);
doc.text(`Month/Period: ${fromDate||'—'} to ${toDate||'—'}`, 10, y);
doc.text(`CRNA: Devarsh Murthy / Josh Condado`, W/2, y, {align:'center'});
y += 8;
// Table header
doc.setFillColor(...navy);
doc.rect(10, y, W-20, 8, 'F');
doc.setFontSize(7.5); doc.setFont('helvetica','bold'); doc.setTextColor(...white);
const cols = [10, 32, 52, 90, 122, 148, 172, 194, 220, 252];
const headers = ['Date','Time','Location / Case ID','Amount Given','Left in Vial','Wasted','New Bottle','CRNA','Witness Sig','Notes'];
headers.forEach((h,i) => doc.text(h, cols[i], y+5.5));
y += 10;
entries.forEach((e, i) => {
if(y > H-20) {
doc.addPage();
y = 15;
doc.setFillColor(...navy);
doc.rect(10, y, W-20, 8, 'F');
doc.setFontSize(7.5); doc.setFont('helvetica','bold'); doc.setTextColor(...white);
headers.forEach((h,i) => doc.text(h, cols[i], y+5.5));
y += 10;
}
if(i%2===0) { doc.setFillColor(...lightGray); doc.rect(10, y, W-20, 10, 'F'); }
doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...black);
doc.text(fmtDate(e.date)||'—', cols[0], y+7);
doc.text(e.savedAt?new Date(e.savedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'—', cols[1], y+7);
doc.text((e.caseId||'—').substring(0,20), cols[2], y+7);
doc.text(`${e.amountGiven||0} mg`, cols[3], y+7);
doc.text(`${e.leftInVial||0} mg`, cols[4], y+7);
if(e.wastedAmt>0) { doc.setTextColor(...warn); doc.text(`${e.wastedAmt} mg`, cols[5], y+7); doc.setTextColor(...black); }
else doc.text('—', cols[5], y+7);
doc.text(e.newBottle?'YES':'—', cols[6], y+7);
doc.text(e.worker==='dev'?'D. Murthy':'J. Condado', cols[7], y+7);
if(e.witnessSignature) {
try { doc.addImage(e.witnessSignature,'PNG',cols[8],y+1,18,8); } catch(ex){}
} else { doc.setTextColor(...warn); doc.text('NO SIG', cols[8], y+7); doc.setTextColor(...black); }
if(e.providerSignature) {
try { doc.addImage(e.providerSignature,'PNG',cols[9]||242,y+1,18,8); } catch(ex){}
} else { doc.setTextColor(...warn); doc.text('NO SIG', cols[9]||242, y+7); doc.setTextColor(...black); }
y += 10;
});
// Footer
doc.setDrawColor(...navy); doc.setLineWidth(0.8);
doc.line(10, H-10, W-10, H-10);
doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
doc.text(`Atlas Anesthesia · CS Log · ${drug.label} · ${entries.length} entries`, W/2, H-5, {align:'center'});
doc.save(`Atlas-CSLog-${currentCSTab}-${fromDate||'all'}-${toDate||'all'}.pdf`);
};
// -- INVOICE GENERATOR --
function timeToMinutes(t) {
if(!t) return 0;
const [h, m] = t.split(':').map(Number);
return h * 60 + m;
}
function roundUpTo15(minutes) {
return Math.ceil(minutes / 15) * 15;
}
function generateInvoiceNumber() {
const now = new Date();
const d = localDateStr(now).replace(/-/g,'');
const seq = String(Math.floor(Math.random()*900)+100);
return `ATL-INV-${d}-${seq}`;
}
window.calculateInvoice = function() {
const start = document.getElementById('inv-start').value;
const end = document.getElementById('inv-end').value;
const firstHourRate = parseFloat(document.getElementById('inv-first-hour').value) || 0;
const per15Rate = parseFloat(document.getElementById('inv-per-15').value) || 0;
const summaryEl = document.getElementById('inv-summary');
const totalEl = document.getElementById('inv-total');
if(!start || !end) {
summaryEl.innerHTML = 'Enter times and rates to see summary';
totalEl.textContent = '$0.00';
return;
}
let totalMins = timeToMinutes(end) - timeToMinutes(start);
if(totalMins <= 0) {
summaryEl.innerHTML = '<span style="color:var(--warn)">End time must be after start time</span>';
totalEl.textContent = '$0.00';
return;
}
const roundedMins = roundUpTo15(totalMins);
const hrs = Math.floor(roundedMins / 60);
const mins = roundedMins % 60;
const timeStr = hrs > 0 ? `${hrs}h ${mins > 0 ? mins + 'm' : ''}`.trim() : `${mins}m`;
let total = 0;
let breakdown = '';
if(roundedMins <= 60) {
// Within first hour — just charge first hour rate
total = firstHourRate;
breakdown = `<div style="display:flex;justify-content:space-between;padding:4px 0"><span>First hour (${timeStr})</span><span style="font-family:'DM Mono',monospace">$${firstHourRate.toFixed(2)}</span></div>`;
} else {
// First hour + additional 15-min blocks
const extraMins = roundedMins - 60;
const extra15Blocks = extraMins / 15;
const extraCost = extra15Blocks * per15Rate;
total = firstHourRate + extraCost;
breakdown = `
<div style="display:flex;justify-content:space-between;padding:4px 0"><span>First hour</span><span style="font-family:'DM Mono',monospace">$${firstHourRate.toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;padding:4px 0"><span>${extra15Blocks} × 15-min block${extra15Blocks!==1?'s':''} (${extraMins}min)</span><span style="font-family:'DM Mono',monospace">$${extraCost.toFixed(2)}</span></div>
`;
}
const actualMins = totalMins;
const aHrs = Math.floor(actualMins/60);
const aMins = actualMins%60;
const actualStr = aHrs>0?`${aHrs}h ${aMins>0?aMins+'m':''}`.trim():`${aMins}m`;
summaryEl.innerHTML = `
<div style="font-size:12px;color:var(--text-faint);margin-bottom:8px">Actual: ${actualStr} · Billed: ${timeStr}</div>
${breakdown}
`;
totalEl.textContent = '$' + total.toFixed(2);
return { total, roundedMins, timeStr, actualStr, breakdown };
};
window.generateInvoicePDF = function() {
  var bt=window._billingType||'hourly';
  var cSel=document.getElementById('inv-location-select');
  var cVal=cSel?cSel.value:'';
  var center=(window.surgeryCenters||surgeryCenters||[]).find(function(c){return c.id===cVal;});
  var locInput=document.getElementById('inv-location');
  var location=center?center.name:(locInput?locInput.value.trim():'');
  var date=document.getElementById('inv-date')?document.getElementById('inv-date').value:'';
  var provider=document.getElementById('inv-provider')?document.getElementById('inv-provider').value:'';
  if(!location||!date){alert('Please select a surgery center and date.');return;}
  if(bt==='flat'){
    // Read from the editable Procedure / Amount inputs. The preset dropdown
    // populates them on selection but the user can override before
    // generating — supports cases like "1.5 Arch @ $3250".
    var cpEl=document.getElementById('inv-custom-procedure');
    var caEl=document.getElementById('inv-custom-amount');
    var proc=cpEl?cpEl.value.trim():'';
    var amt=caEl?parseFloat(caEl.value)||0:0;
    if(!proc||!amt){alert('Please enter a procedure and amount.');return;}
    _generateFlatRateInvoicePDF(location,date,provider,proc,amt);
    return;
  }
  var start=document.getElementById('inv-start')?document.getElementById('inv-start').value:'';
  var end=document.getElementById('inv-end')?document.getElementById('inv-end').value:'';
  if(!start||!end){alert('Please fill in start and end time.');return;}
  var calc=calculateInvoice();
  if(!calc) return;
  var total=calc.total,roundedMins=calc.roundedMins,timeStr=calc.timeStr,actualStr=calc.actualStr;
  const invoiceNum = generateInvoiceNumber();
  const formattedDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
// Format times
const fmtTime = t => {
const [h, m] = t.split(':').map(Number);
const ampm = h >= 12 ? 'PM' : 'AM';
const hour = h % 12 || 12;
return `${hour}:${String(m).padStart(2,'0')} ${ampm}`;
};
const { jsPDF } = window.jspdf;
const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
const W = 215.9;
const navy = [29, 53, 87];
const lightBlue = [232, 238, 245];
const gray = [107, 104, 96];
const lightGray = [240, 239, 233];
const black = [26, 25, 22];
const white = [255, 255, 255];
// -- HEADER BAND --
doc.setFillColor(...navy);
doc.rect(0, 0, W, 42, 'F');
// White circle behind logo
doc.setFillColor(255, 255, 255);
doc.circle(20, 20, 12, 'F');
// Atlas logo
const logoData = 'data:image/png;base64,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';
doc.addImage(logoData, 'PNG', 10, 10, 20, 20);
// Company name + tagline
doc.setTextColor(...white);
doc.setFontSize(20);
doc.setFont('helvetica', 'bold');
doc.text('ATLAS ANESTHESIA', 36, 20);
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.text('Mobile Anesthesia Services', 36, 28);
// INVOICE label right side
doc.setFontSize(26);
doc.setFont('helvetica', 'bold');
doc.setTextColor(255, 255, 255);
doc.text('INVOICE', W - 15, 20, { align: 'right' });
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.text(`# ${invoiceNum}`, W - 15, 28, { align: 'right' });
doc.text(`Date: ${formattedDate}`, W - 15, 34, { align: 'right' });
let y = 55;
// -- BILLED TO / FROM --
doc.setFillColor(...lightGray);
doc.roundedRect(14, y, 85, 38, 2, 2, 'F');
doc.roundedRect(116, y, 85, 38, 2, 2, 'F');
doc.setFontSize(8);
doc.setFont('helvetica', 'bold');
doc.setTextColor(...gray);
doc.text('BILLED TO', 20, y + 8);
doc.text('FROM', 122, y + 8);
doc.setFontSize(11);
doc.setFont('helvetica', 'bold');
doc.setTextColor(...black);
doc.text(location, 20, y + 17);
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...gray);
doc.text('Anesthesia Services', 20, y + 25);
doc.text(formattedDate, 20, y + 32);
doc.setFontSize(11);
doc.setFont('helvetica', 'bold');
doc.setTextColor(...black);
doc.text('Atlas Anesthesia', 122, y + 17);
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...gray);
doc.text(`Provider: ${provider}`, 122, y + 25);
doc.text('Mobile Anesthesia Services', 122, y + 32);
y += 50;
// -- SERVICE TABLE HEADER --
doc.setFillColor(...navy);
doc.roundedRect(14, y, W - 28, 10, 1, 1, 'F');
doc.setFontSize(9);
doc.setFont('helvetica', 'bold');
doc.setTextColor(...white);
doc.text('DESCRIPTION', 20, y + 7);
doc.text('TIME', 110, y + 7, { align: 'center' });
doc.text('RATE', 155, y + 7, { align: 'center' });
doc.text('AMOUNT', W - 20, y + 7, { align: 'right' });
y += 12;
// -- ROW 1: First hour --
doc.setFillColor(...lightGray);
doc.rect(14, y, W - 28, 10, 'F');
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...black);
doc.text('Anesthesia Services — First Hour', 20, y + 7);
doc.text('60 min', 110, y + 7, { align: 'center' });
doc.text(`$${firstHourRate.toFixed(2)}`, 155, y + 7, { align: 'center' });
doc.text(`$${firstHourRate.toFixed(2)}`, W - 20, y + 7, { align: 'right' });
y += 12;
// -- ROW 2: Additional time (if any) --
if(roundedMins > 60) {
const extraMins = roundedMins - 60;
const extra15Blocks = extraMins / 15;
const extraCost = extra15Blocks * per15Rate;
doc.setFillColor(...white);
doc.rect(14, y, W - 28, 10, 'F');
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...black);
doc.text(`Additional Time (${extra15Blocks} × 15-min block${extra15Blocks!==1?'s':''})`, 20, y + 7);
doc.text(`${extraMins} min`, 110, y + 7, { align: 'center' });
doc.text(`$${per15Rate.toFixed(2)}/15min`, 155, y + 7, { align: 'center' });
doc.text(`$${extraCost.toFixed(2)}`, W - 20, y + 7, { align: 'right' });
y += 12;
}
y += 4;
// -- TIME DETAIL BOX --
doc.setFillColor(...lightBlue);
doc.roundedRect(14, y, W - 28, 22, 2, 2, 'F');
doc.setFontSize(9);
doc.setFont('helvetica', 'bold');
doc.setTextColor(...navy);
doc.text('TIME DETAIL', 20, y + 8);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...black);
doc.text(`Start: ${fmtTime(start)} | End: ${fmtTime(end)} | Actual Duration: ${actualStr} | Billed Duration: ${timeStr}`, 20, y + 16);
y += 30;
// -- TOTAL BOX --
doc.setFillColor(...navy);
doc.roundedRect(120, y, W - 134, 18, 2, 2, 'F');
doc.setFontSize(10);
doc.setFont('helvetica', 'bold');
doc.setTextColor(...white);
doc.text('TOTAL DUE', 128, y + 7);
doc.setFontSize(16);
doc.text(`$${total.toFixed(2)}`, W - 20, y + 12, { align: 'right' });
y += 28;
// -- FOOTER --
doc.setFontSize(8);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...gray);
doc.text('Thank you for choosing Atlas Anesthesia — Mobile Anesthesia Services', W / 2, y, { align: 'center' });
doc.text(`Invoice ${invoiceNum} · Generated ${new Date().toLocaleDateString()}`, W / 2, y + 6, { align: 'center' });
// -- BOTTOM LINE --
doc.setDrawColor(...navy);
doc.setLineWidth(1.5);
doc.line(14, y + 12, W - 14, y + 12);
doc.save(`Atlas-Invoice-${invoiceNum}.pdf`);
// Save invoice record to Firestore
// Link invoice to case if generated from a draft
const linkedCaseId = window._draftInvoiceData?.caseId || '';
const invoiceRecord = {
id: uid(),
invoiceNum,
location,
date: formattedDate,
rawDate: date,
provider,
start: fmtTime(start),
end: fmtTime(end),
actualDuration: actualStr,
billedDuration: timeStr,
firstHourRate,
per15Rate,
total,
savedAt: new Date().toISOString(),
worker: currentWorker,
linkedCaseId
};
saveInvoiceRecord(invoiceRecord);
  if(typeof renderAnalytics === 'function') setTimeout(renderAnalytics, 500);
};
async function saveInvoiceRecord(record) {
try {
const snap = await getDoc(doc(db,'atlas','invoices'));
const existing = snap.exists() ? (snap.data().invoices || []) : [];
existing.unshift(record);
setSyncing(true);
await setDoc(doc(db,'atlas','invoices'), { invoices: existing });
setSyncing(false);
window._savedInvoices = existing;
renderSavedInvoices(existing);
if(typeof renderAnalytics === 'function') setTimeout(renderAnalytics, 300);
} catch(e) {
console.error('Error saving invoice:', e);
}
return record;
}
async function loadSavedInvoices() {
try {
const snap = await getDoc(doc(db,'atlas','invoices'));
const invoices = snap.exists() ? (snap.data().invoices || []) : [];
window._savedInvoices = invoices;
renderSavedInvoices(invoices);
return invoices;
} catch(e) {
console.error('Error loading invoices:', e);
return [];
}
}
function renderSavedInvoices(invoices) {
window._savedInvoices = invoices; // cache for re-download
const el = document.getElementById('savedInvoicesList');
if(!el) return;
if(!invoices.length) {
el.innerHTML = '<div class="empty-state">No invoices saved yet</div>';
return;
}
el.innerHTML = invoices.map(inv => {
const pill = inv.worker==='dev' ? 'pill-dev' : 'pill-josh';
const wname = inv.worker==='dev' ? 'Devarsh' : 'Josh';
return `<div class="case-item"><div class="case-item-header" onclick="toggleInvoice('${inv.id}')"><div><div class="case-name" style="display:flex;align-items:center;gap:8px">
${inv.invoiceNum}
<span class="worker-pill ${pill}" style="font-size:10px">${wname}</span></div><div class="case-date">${fmtDate(inv.date)} · ${inv.location}</div></div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><div class="case-cost">$${(Number(inv.total)||0).toFixed(2)}</div><button onclick="event.stopPropagation();redownloadInvoice('${inv.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">⬇ Re-download</button><button onclick="event.stopPropagation();deleteInvoice('${inv.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">Delete</button></div></div><div class="case-items-list" id="inv-detail-${inv.id}"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px"><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);font-weight:600;margin-bottom:4px">Provider</div><div style="font-size:13px">${inv.provider}</div></div><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);font-weight:600;margin-bottom:4px">Location</div><div style="font-size:13px">${inv.location}</div></div><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);font-weight:600;margin-bottom:4px">Time</div><div style="font-size:13px">${inv.start} → ${inv.end}</div></div><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);font-weight:600;margin-bottom:4px">Duration</div><div style="font-size:13px">${inv.actualDuration} → billed ${inv.billedDuration}</div></div><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);font-weight:600;margin-bottom:4px">First Hour Rate</div><div style="font-size:13px;font-family:'DM Mono',monospace">$${(Number(inv.firstHourRate)||0).toFixed(2)}</div></div><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);font-weight:600;margin-bottom:4px">Per 15-Min Rate</div><div style="font-size:13px;font-family:'DM Mono',monospace">$${(Number(inv.per15Rate)||0).toFixed(2)}</div></div></div><div style="margin-top:12px;padding:10px 14px;background:var(--info-light);border-radius:var(--radius-sm);display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;font-weight:600;color:var(--info)">Total Billed</span><span style="font-size:18px;font-weight:500;font-family:'DM Mono',monospace;color:var(--info)">$${(Number(inv.total)||0).toFixed(2)}</span></div></div></div>`;
}).join('');
}
window.toggleInvoice = function(id) {
document.getElementById('inv-detail-'+id).classList.toggle('open');
};
// ── PRE-OP FOLLOW-UP TRACKING ───────────────────────────────────────────────
// Three status fields on each pre-op record so providers can track:
//   po-callStatus:    'not-called' | 'no-answer' | 'spoken' | 'voicemail'
//   po-invoiceStatus: 'not-sent' | 'sent' | 'paid'  (for direct-billed patients)
//   po-paymentStatus: 'not-paid' | 'paid'
// Plus po-lastFollowupAt timestamp to auto-flag "needs follow-up" cases.

const CALL_STATES = ['not-called', 'voicemail', 'no-answer', 'spoken'];
const CALL_LABELS = {
  'not-called': '📞 Call Pending',
  'voicemail':  '📞 Voicemail Left',
  'no-answer':  '📞 No Answer',
  // Same concept as Nicole's "Called" pill — keep the language identical
  // across Tracker + Follow-up Tracker so it doesn't read like two states.
  'spoken':     '✓ Called'
};
const CALL_COLORS = {
  'not-called': { bg: '#fef3c7', color: '#92400e' },
  'voicemail':  { bg: '#dbeafe', color: '#1e40af' },
  'no-answer':  { bg: '#fee2e2', color: '#991b1b' },
  'spoken':     { bg: '#dcfce7', color: '#166534' }
};

async function _updatePreopStatusField(preopId, field, value) {
  try {
    const snap = await getDoc(doc(db, 'atlas', 'preop'));
    const records = snap.exists() ? (snap.data().records || []) : [];
    const idx = records.findIndex(r => r.id === preopId);
    if(idx === -1) return false;
    records[idx][field] = value;
    if(field === 'po-callStatus') records[idx]['po-lastFollowupAt'] = new Date().toISOString();
    records[idx].savedAt = new Date().toISOString();
    setSyncing(true);
    await savePreopRecords(records);
    setSyncing(false);
    try { logAudit('preop-status-update', records[idx]['po-caseId'] || '', `${field}=${value}`); } catch(e){}
    return true;
  } catch(err) {
    console.error('updatePreopStatus failed:', err);
    if(typeof toastError === 'function') toastError('Failed to update status: ' + err.message, { persist: true });
    return false;
  }
}
// Exposed so scheduler-tracker.js can sync Jordan's "Call Made" pill into the
// linked pre-op record's po-callStatus, keeping Josh/Dev's Follow-up Tracker
// in agreement with what Jordan logged on the Tracker.
window._updatePreopStatusField = _updatePreopStatusField;

// Modal selector for call status — replaces the cycle behavior so all options
// are visible at once instead of having to click through them.
window.openCallStatusModal = function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  const current = preop['po-callStatus'] || 'not-called';
  const caseId = preop['po-caseId'] || '';
  const displayId = (typeof window.getCaseDisplayIdFromPreop === 'function') ? window.getCaseDisplayIdFromPreop(preop) : caseId;
  // Remove any existing modal
  const existing = document.getElementById('call-status-modal');
  if(existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'call-status-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  const optionHTML = CALL_STATES.map(state => {
    const c = CALL_COLORS[state];
    const isSelected = state === current;
    return `<button onclick="window._pickCallStatus('${preopId}','${state}')" style="display:flex;align-items:center;gap:12px;width:100%;padding:14px 18px;background:${isSelected?c.bg:'#fff'};border:2px solid ${isSelected?c.color:'#e2e8f0'};border-radius:10px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:${isSelected?'700':'500'};color:${isSelected?c.color:'#1e293b'};text-align:left;transition:all .12s"><span style="font-size:18px">${state==='spoken'?'✓':state==='voicemail'?'📨':state==='no-answer'?'❌':'📞'}</span><span style="flex:1">${CALL_LABELS[state]}</span>${isSelected?'<span style="font-size:11px;background:'+c.color+';color:#fff;padding:2px 8px;border-radius:8px">CURRENT</span>':''}</button>`;
  }).join('');
  overlay.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden">
    <div style="background:#1d3557;color:#fff;padding:18px 22px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Call Status</div>
      <div style="font-size:17px;font-weight:700">${displayId}</div>
    </div>
    <div style="padding:18px;display:flex;flex-direction:column;gap:8px">${optionHTML}</div>
    <div style="padding:0 18px 18px;text-align:right"><button onclick="document.getElementById('call-status-modal').remove()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Cancel</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
};

window._pickCallStatus = async function(preopId, state) {
  const overlay = document.getElementById('call-status-modal');
  if(overlay) overlay.remove();
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  preop['po-callStatus'] = state;
  preop['po-lastFollowupAt'] = new Date().toISOString();
  if(typeof renderMidCase === 'function') renderMidCase();
  if(typeof renderFollowupTab === 'function') renderFollowupTab();
  await _updatePreopStatusField(preopId, 'po-callStatus', state);
  if(typeof toastSuccess === 'function') toastSuccess('Call status: ' + CALL_LABELS[state]);
};

// Keep cycle function as deprecated alias for any external callers
window.cyclePreopCallStatus = window.openCallStatusModal;

// Helper: find the payment row for a pre-op's case
function _findPaymentRowForPreop(preop) {
  if(!preop || !window._paymentRows) return null;
  const caseId = preop['po-caseId'];
  if(!caseId) return null;
  return window._paymentRows.find(r => r.caseId === caseId) || null;
}
// Create a new payment row from a pre-op record. Used when the user toggles
// a deposit/payment pill before the Payments tab has been visited (rows
// load lazily). Mirrors the auto-create logic in payments.js syncFromCases.
function _createPaymentRowFromPreop(preop) {
  if(!preop || !window._paymentRows) window._paymentRows = window._paymentRows || [];
  const caseId = preop['po-caseId'];
  if(!caseId) return null;
  const sc = preop['po-surgery-center'] || '';
  const center = (window.surgeryCenters||[]).find(c => c.id === sc);
  const row = {
    id: (window.uid ? window.uid() : Date.now().toString(36)),
    caseId,
    name: caseId,
    worker: preop.worker || 'josh',
    caseDate: preop['po-surgeryDate'] || '',
    callDate: (preop['po-callDateTime']||'').split('T')[0] || '',
    depositDate: '', paidDate: '',
    dep500Paid: false, paid: false, invoiceSent: false,
    invoicedAmount: 0, projOverride: null, caseCost: 0,
    estHrs: parseFloat(preop['po-est-hours']) || 0,
    surgeryCenter: sc, surgeryCenterName: (center && center.name) || '',
    patientEmail: preop['po-patientEmail'] || ''
  };
  window._paymentRows.unshift(row);
  return row;
}

// Save current _paymentRows to Firestore (mirrors what Payments tab does)
async function _savePaymentRowsFromFollowup() {
  if(!window._paymentRows) return;
  try {
    const docRef = doc(db, 'atlas', 'payments');
    const snap = await getDoc(docRef);
    const existing = snap.exists() ? snap.data() : {};
    await setDoc(docRef, {
      ...existing,
      rows: window._paymentRows,
      excludedCaseIds: existing.excludedCaseIds || []
    });
  } catch(e) {
    if(typeof window.atlasError === 'function') window.atlasError('PAY-001', e.message);
    throw e;
  }
}

// Returns whether this case is billed to the patient (vs the surgery center).
// The Follow-up Tracker only shows patient-billed cases per the user's spec.
function _whoPaysFor(preop) {
  const row = _findPaymentRowForPreop(preop);
  const centerId = (row && row.surgeryCenter) || (preop && preop['po-surgery-center']) || '';
  const center = (window.surgeryCenters||[]).find(c => c.id === centerId);
  return (center && center.billingType === 'center') ? 'center' : 'patient';
}
window.isPatientBilled = function(preop) { return _whoPaysFor(preop) === 'patient'; };

// $500 deposit status (from the Payments row)
window.getPreopDepositStatus = function(preop) {
  const row = _findPaymentRowForPreop(preop);
  if(!row) return { paid: false, date: '' };
  return { paid: !!row.dep500Paid, date: row.depositDate || '' };
};
// Remaining payment (final balance) status
window.getPreopRemainingStatus = function(preop) {
  const row = _findPaymentRowForPreop(preop);
  if(!row) return { paid: false, date: '' };
  if(row.paid) return { paid: true, date: row.paidDate || '' };
  if(row.received) return { paid: true, date: '' };
  return { paid: false, date: '' };
};
// Legacy getters used by Mid-Case pills — map to deposit/remaining
window.getPreopInvoiceStatus = function(preop) {
  return window.getPreopDepositStatus(preop).paid ? 'sent' : 'not-sent';
};
window.getPreopPaymentStatus = function(preop) {
  return window.getPreopRemainingStatus(preop).paid ? 'paid' : 'not-paid';
};

window.togglePreopDepositStatus = async function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  // Auto-create the Payments row if it doesn't exist yet — they should always
  // match 1:1 so the user doesn't see "No row exists" errors.
  let row = _findPaymentRowForPreop(preop);
  if(!row) row = _createPaymentRowFromPreop(preop);
  if(!row) { if(typeof toastError === 'function') toastError('Could not create payment row.'); return; }
  row.dep500Paid = !row.dep500Paid;
  if(row.dep500Paid && !row.depositDate) row.depositDate = todayStr();
  if(typeof renderFollowupTab === 'function') renderFollowupTab();
  if(typeof renderPaymentRows === 'function') renderPaymentRows();
  try { await _savePaymentRowsFromFollowup(); try { logAudit('deposit500-toggle', preop['po-caseId']||'', 'paid=' + row.dep500Paid); } catch(e){} } catch(e){}
};
window.togglePreopRemainingStatus = async function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  let row = _findPaymentRowForPreop(preop);
  if(!row) row = _createPaymentRowFromPreop(preop);
  if(!row) { if(typeof toastError === 'function') toastError('Could not create payment row.'); return; }
  const who = _whoPaysFor(preop);
  if(who === 'center') { row.received = !row.received; }
  else { row.paid = !row.paid; if(row.paid && !row.paidDate) row.paidDate = todayStr(); }
  if(typeof renderFollowupTab === 'function') renderFollowupTab();
  if(typeof renderPaymentRows === 'function') renderPaymentRows();
  try { await _savePaymentRowsFromFollowup(); try { logAudit('remaining-toggle', preop['po-caseId']||'', 'paid=' + (who==='center'?row.received:row.paid)); } catch(e){} } catch(e){}
};
window.togglePreopRemPayment = window.togglePreopRemainingStatus;

window.togglePreopInvoiceStatus = async function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  const row = _findPaymentRowForPreop(preop);
  if(row) {
    // Update the Payments row so the Payments tab and Follow-up stay in sync
    row.invoiceSent = !row.invoiceSent;
    if(typeof renderMidCase === 'function') renderMidCase();
    if(typeof renderFollowupTab === 'function') renderFollowupTab();
    if(typeof renderPaymentRows === 'function') renderPaymentRows();
    try {
      await _savePaymentRowsFromFollowup();
      try { logAudit('invoice-status-toggle', preop['po-caseId']||'', 'invoiceSent=' + row.invoiceSent); } catch(e){}
    } catch(e) { /* atlasError already shown */ }
  } else {
    // No payment row exists — fall back to pre-op field
    const current = preop['po-invoiceStatus'] || 'not-sent';
    const next = current === 'sent' ? 'not-sent' : 'sent';
    preop['po-invoiceStatus'] = next;
    if(typeof renderMidCase === 'function') renderMidCase();
    if(typeof renderFollowupTab === 'function') renderFollowupTab();
    await _updatePreopStatusField(preopId, 'po-invoiceStatus', next);
  }
};

window.togglePreopPaymentStatus = async function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  const row = _findPaymentRowForPreop(preop);
  if(row) {
    // Determine which flag to flip: patient-billed cases use `paid`,
    // surgery-center-billed cases use `received`.
    const center = (window.surgeryCenters||[]).find(c => c.id === row.surgeryCenter);
    const centerPays = center && center.billingType === 'center';
    if(centerPays) {
      row.received = !row.received;
    } else {
      row.paid = !row.paid;
      if(row.paid && !row.paidDate) row.paidDate = todayStr();
    }
    if(typeof renderMidCase === 'function') renderMidCase();
    if(typeof renderFollowupTab === 'function') renderFollowupTab();
    if(typeof renderPaymentRows === 'function') renderPaymentRows();
    try {
      await _savePaymentRowsFromFollowup();
      try { logAudit('payment-status-toggle', preop['po-caseId']||'', 'paid=' + (centerPays?row.received:row.paid)); } catch(e){}
    } catch(e) { /* atlasError already shown */ }
  } else {
    const current = preop['po-paymentStatus'] || 'not-paid';
    const next = current === 'paid' ? 'not-paid' : 'paid';
    preop['po-paymentStatus'] = next;
    if(typeof renderMidCase === 'function') renderMidCase();
    if(typeof renderFollowupTab === 'function') renderFollowupTab();
    await _updatePreopStatusField(preopId, 'po-paymentStatus', next);
  }
};

// Toggle $500 deposit status. Three states cycle: not-sent → sent → paid → not-sent
// Auto-creates the Payments row if it doesn't exist yet so the pills always work.
window.togglePreopDepositStatus = async function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  let row = _findPaymentRowForPreop(preop);
  if(!row) row = _createPaymentRowFromPreop(preop);
  if(!row) { if(typeof toastError === 'function') toastError('Could not create payment row — pre-op is missing a Case ID.'); return; }
  const depositSent = !!(row.depositDate || preop['po-depositSentAt']);
  const depositPaid = !!row.dep500Paid;
  if(!depositSent) { row.depositDate = todayStr(); preop['po-depositSentAt'] = new Date().toISOString(); await _savePaymentRowsFromFollowup(); await _updatePreopStatusField(preopId, 'po-depositSentAt', preop['po-depositSentAt']); }
  else if(!depositPaid) { row.dep500Paid = true; await _savePaymentRowsFromFollowup(); }
  else { row.depositDate = ''; row.dep500Paid = false; preop['po-depositSentAt'] = ''; await _savePaymentRowsFromFollowup(); await _updatePreopStatusField(preopId, 'po-depositSentAt', ''); }
  if(typeof renderFollowupTab === 'function') renderFollowupTab();
  if(typeof renderMidCase === 'function') renderMidCase();
  if(typeof renderPaymentRows === 'function') renderPaymentRows();
  try { logAudit('deposit-status-toggle', preop['po-caseId']||'', `sent=${!!row.depositDate} paid=${!!row.dep500Paid}`); } catch(e){}
};

window.togglePreopRemPayment = async function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  let row = _findPaymentRowForPreop(preop);
  if(!row) row = _createPaymentRowFromPreop(preop);
  if(!row) { if(typeof toastError === 'function') toastError('Could not create payment row — pre-op is missing a Case ID.'); return; }
  row.paid = !row.paid;
  if(row.paid && !row.paidDate) row.paidDate = todayStr();
  await _savePaymentRowsFromFollowup();
  if(typeof renderFollowupTab === 'function') renderFollowupTab();
  if(typeof renderMidCase === 'function') renderMidCase();
  if(typeof renderPaymentRows === 'function') renderPaymentRows();
  try { logAudit('rem-payment-toggle', preop['po-caseId']||'', 'paid=' + row.paid); } catch(e){}
};

window.openReminderModal = function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  const caseId = preop['po-caseId'] || '';
  const current = preop['po-reminderDate'] || '';
  const today = todayStr();
  const existing = document.getElementById('reminder-modal');
  if(existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'reminder-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden">
    <div style="background:#1d3557;color:#fff;padding:18px 22px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Set Follow-up Reminder</div>
      <div style="font-size:17px;font-weight:700">${caseId}</div>
    </div>
    <div style="padding:20px 22px">
      <div style="font-size:12px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:.3px;margin-bottom:10px">Quick pick</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
        <button onclick="window._setReminder('${preopId}','${addDays(today,1)}')" style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit">Tomorrow</button>
        <button onclick="window._setReminder('${preopId}','${addDays(today,3)}')" style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit">In 3 days</button>
        <button onclick="window._setReminder('${preopId}','${addDays(today,7)}')" style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit">In 1 week</button>
        <button onclick="window._setReminder('${preopId}','${addDays(today,14)}')" style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit">In 2 weeks</button>
      </div>
      <div style="font-size:12px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px">Or pick a date</div>
      <input type="date" id="reminder-date-input" value="${current}" min="${today}" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid #cbd5e1;border-radius:8px;outline:none;font-family:inherit;margin-bottom:14px">
      <div style="display:flex;gap:8px;justify-content:space-between">
        ${current ? `<button onclick="window._setReminder('${preopId}','')" style="padding:9px 16px;background:transparent;color:#dc2626;border:1px solid #fca5a5;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Clear</button>` : '<div></div>'}
        <div style="display:flex;gap:8px">
          <button onclick="document.getElementById('reminder-modal').remove()" style="padding:9px 18px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
          <button onclick="window._setReminder('${preopId}',document.getElementById('reminder-date-input').value)" style="padding:9px 18px;background:#1d3557;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Set</button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
};

window._setReminder = async function(preopId, dateStr) {
  const overlay = document.getElementById('reminder-modal');
  if(overlay) overlay.remove();
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  preop['po-reminderDate'] = dateStr || '';
  if(typeof renderFollowupTab === 'function') renderFollowupTab();
  await _updatePreopStatusField(preopId, 'po-reminderDate', dateStr || '');
  if(typeof toastSuccess === 'function') toastSuccess(dateStr ? `Reminder set for ${fmtDate(dateStr)}` : 'Reminder cleared');
};

// ── LOGIN NOTIFICATIONS ──────────────────────────────────────────────────────
window.showLoginNotifications = function() {
  setTimeout(() => {
    const preops = (window._rawPreopRecords || []).filter(r => !r.isTest);
    if(!preops.length) return;
    const today = todayStr();
    const overdueReminders = [], todayReminders = [], needsFollowup = [];
    preops.forEach(r => {
      const rd = r['po-reminderDate'];
      if(rd) { if(rd < today) overdueReminders.push(r); else if(rd === today) todayReminders.push(r); }
      const cs = r['po-callStatus'];
      const lf = r['po-lastFollowupAt'];
      if(cs && cs !== 'spoken' && cs !== 'not-called' && lf) {
        const days = (Date.now() - new Date(lf).getTime()) / 86400000;
        if(days >= 5) needsFollowup.push({ rec: r, days: Math.floor(days) });
      }
    });
    const total = overdueReminders.length + todayReminders.length + needsFollowup.length;
    if(total === 0) return;
    const renderRow = (r, badge, bg, color) => {
      const cid = r['po-caseId'] || '—';
      const phiHidden = typeof window.isPHIHidden === 'function' && window.isPHIHidden(r['po-surgeryDate'], cid);
      const pname = phiHidden ? '[hidden]' : ([r['po-patientLastName'], r['po-patientFirstName']].filter(Boolean).join(', ') || cid);
      return `<div onclick="window._notifGoToCase('${r.id}')" style="padding:10px 14px;border-bottom:1px solid #f1f5f9;cursor:pointer;display:flex;align-items:center;gap:10px" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='#fff'">
        <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:6px;background:${bg};color:${color};white-space:nowrap">${badge}</span>
        <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${pname}</div><div style="font-size:11px;color:#94a3b8;font-family:monospace">${cid}</div></div>
        <span style="font-size:11px;color:#cbd5e1">→</span>
      </div>`;
    };
    const overlay = document.createElement('div');
    overlay.id = 'login-notif-overlay';
    overlay.style.cssText = 'position:fixed;top:80px;right:20px;z-index:9998;background:#fff;border-radius:12px;max-width:380px;width:calc(100vw - 40px);box-shadow:0 12px 40px rgba(15,23,42,.18);overflow:hidden;animation:toastSlideIn .25s ease;max-height:calc(100vh - 120px);display:flex;flex-direction:column';
    let body = '';
    if(overdueReminders.length) body += '<div style="padding:8px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#dc2626;background:#fef2f2;border-bottom:1px solid #fecaca">⏰ Overdue Reminders</div>' + overdueReminders.map(r => renderRow(r, 'OVERDUE', '#fee2e2', '#991b1b')).join('');
    if(todayReminders.length) body += '<div style="padding:8px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#d97706;background:#fef3c7;border-bottom:1px solid #fde68a">⏰ Reminders for Today</div>' + todayReminders.map(r => renderRow(r, 'TODAY', '#fef3c7', '#92400e')).join('');
    if(needsFollowup.length) body += '<div style="padding:8px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#dc2626;background:#fef2f2;border-bottom:1px solid #fecaca">⚠ Follow-up Needed</div>' + needsFollowup.map(x => renderRow(x.rec, x.days + 'd ago', '#fee2e2', '#991b1b')).join('');
    overlay.innerHTML = `<div style="background:#1d3557;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#90b8e0">Welcome back</div><div style="font-size:15px;font-weight:700">${total} item${total!==1?'s':''} need${total===1?'s':''} attention</div></div><button onclick="window._dismissLoginNotif()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:13px">✕</button></div><div style="overflow-y:auto;flex:1">${body}</div><div style="padding:10px 14px;border-top:1px solid #e2e8f0;background:#f8fafc"><button onclick="showTab('followup');renderFollowupTab();window._dismissLoginNotif()" style="width:100%;background:#1d3557;color:#fff;border:none;padding:9px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">Open Follow-up Tracker →</button></div>`;
    document.body.appendChild(overlay);
  }, 2500);
};
window._notifGoToCase = function(preopId) { window._dismissLoginNotif(); showTab('followup'); if(typeof renderFollowupTab === 'function') renderFollowupTab(); };
window._dismissLoginNotif = function() { const o = document.getElementById('login-notif-overlay'); if(o) o.remove(); };

// Bulk Stripe check — runs through every patient-billed pre-op with an
// email and not-yet-paid status, calling /stripe-check for each. Updates
// payment rows + follow-up tracker as it finds payments.
window.checkStripeForAllFollowups = async function() {
  if(!window._rawPreopRecords || !window._rawPreopRecords.length) return;
  if(typeof toastInfo === 'function') toastInfo('Checking Stripe for all upcoming patients...');
  const today = todayStr();
  const candidates = window._rawPreopRecords.filter(r => {
    if(r.isTest) return false;
    if(!r['po-patientEmail']) return false;
    const surgDate = r['po-surgeryDate'];
    if(surgDate && surgDate < today) return false; // upcoming only
    if(typeof window.isPatientBilled === 'function' && !window.isPatientBilled(r)) return false;
    const row = window._paymentRows && window._paymentRows.find(pr => pr.caseId === r['po-caseId']);
    if(row && row.paid) return false; // already paid
    return true;
  });
  let updated = 0;
  for(const r of candidates) {
    try {
      const res = await fetch('https://atlas-reminder.blue-disk-9b10.workers.dev/stripe-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerEmail: r['po-patientEmail'] })
      });
      if(!res.ok) continue;
      const data = await res.json();
      if(data.paid) {
        const row = window._paymentRows && window._paymentRows.find(pr => pr.caseId === r['po-caseId']);
        if(row) {
          let changed = false;
          if(!row.dep500Paid) { row.dep500Paid = true; if(!row.depositDate) row.depositDate = new Date(data.paidAt).toISOString().split('T')[0]; changed = true; }
          if(data.remainderPaid && !row.paid) { row.paid = true; if(!row.paidDate) row.paidDate = new Date(data.remainderPaidAt).toISOString().split('T')[0]; changed = true; }
          if(changed) updated++;
        }
      }
    } catch(e) { /* skip individual failure */ }
  }
  if(updated > 0) {
    try { await _savePaymentRowsFromFollowup(); } catch(e){}
    if(typeof renderFollowupTab === 'function') renderFollowupTab();
    if(typeof renderPaymentRows === 'function') renderPaymentRows();
    if(typeof toastSuccess === 'function') toastSuccess(updated + ' patient(s) auto-marked paid from Stripe.');
  } else {
    if(typeof toastInfo === 'function') toastInfo('No new Stripe payments found.');
  }
};

// Check Stripe for payment status of a pre-op's patient. If found paid,
// update the payment row and refresh the Follow-up Tracker.
window.checkStripeForFollowup = async function(preopId) {
  const preop = (window._rawPreopRecords||[]).find(r => r.id === preopId);
  if(!preop) return;
  const email = preop['po-patientEmail'];
  if(!email) {
    if(typeof toastWarn === 'function') toastWarn('No patient email on this pre-op — cannot check Stripe.');
    return;
  }
  if(typeof toastInfo === 'function') toastInfo('Checking Stripe for ' + email + '...');
  try {
    const res = await fetch('https://atlas-reminder.blue-disk-9b10.workers.dev/stripe-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerEmail: email })
    });
    const data = await res.json();
    if(data.paid) {
      const row = _findPaymentRowForPreop(preop);
      if(row) {
        row.dep500Paid = true;
        if(!row.depositDate) row.depositDate = new Date(data.paidAt).toISOString().split('T')[0];
        if(data.remainderPaid) {
          row.paid = true;
          if(!row.paidDate) row.paidDate = new Date(data.remainderPaidAt).toISOString().split('T')[0];
        }
        await _savePaymentRowsFromFollowup();
        if(typeof renderFollowupTab === 'function') renderFollowupTab();
        if(typeof renderPaymentRows === 'function') renderPaymentRows();
      }
      if(typeof toastSuccess === 'function') toastSuccess('Stripe: deposit paid' + (data.remainderPaid ? ' + remainder' : '') + ' for ' + email);
    } else {
      if(typeof toastInfo === 'function') toastInfo('Stripe: no payment found yet for ' + email);
    }
  } catch(err) {
    if(typeof window.atlasError === 'function') window.atlasError('PAY-001', 'Stripe check failed: ' + err.message);
  }
};

// Helper for renderMidCase: returns just the "needs follow-up" warning chip
// when the case is overdue. Call / invoice / payment status pills used to live
// here but were removed — those statuses are now only edited from the
// Follow-up Tracker (Home) and Payments tab to avoid duplicate clutter.
window.buildPreopFollowupPills = function(r) {
  const callStatus = r['po-callStatus'] || 'not-called';
  const lastFollowup = r['po-lastFollowupAt'];
  let needsFollowup = false;
  if(callStatus !== 'spoken' && callStatus !== 'not-called' && lastFollowup) {
    const daysSince = (Date.now() - new Date(lastFollowup).getTime()) / 86400000;
    if(daysSince >= 5) needsFollowup = true;
  }
  if(!needsFollowup) return '';
  return `<div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap;align-items:center">
    <span title="Called ${Math.floor((Date.now() - new Date(lastFollowup).getTime())/86400000)} days ago without a response" style="background:#fef2f2;color:#dc2626;font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;border:1px dashed #fca5a5">⚠ FOLLOW-UP</span>
  </div>`;
};

// ── FOLLOW-UP TAB ─────────────────────────────────────────────────────────────
// Chart-style view of every pre-op's call / invoice / payment status, similar
// to the Payments tab. Lets Josh/Dev see who they need to follow up with at
// a glance and update statuses inline.

window._followupFilter = 'all';
window.setFollowupFilter = function(f) {
  window._followupFilter = f;
  ['all','followup','uncalled','unpaid'].forEach(k => {
    const btn = document.getElementById('fu-filter-' + k);
    if(btn) {
      btn.style.background = f === k ? 'var(--info)' : 'transparent';
      btn.style.color = f === k ? '#fff' : 'var(--text-muted)';
    }
  });
  renderFollowupTab();
};

window.renderFollowupTab = function() {
  const body = document.getElementById('fu-table-body');
  if(!body) return;
  const allPreops = (window._rawPreopRecords || []).filter(r => !r.isTest);
  // Filter out surgery-center-billed cases — they don't use the deposit/remainder
  // workflow. We only show cases where the patient pays directly.
  const patientBilledPreops = allPreops.filter(r => {
    const centerId = r['po-surgery-center'];
    if(!centerId) return true; // no center selected → assume patient-billed
    const center = (window.surgeryCenters||[]).find(c => c.id === centerId);
    if(!center) return true;
    return center.billingType !== 'center'; // exclude surgery-center-billed
  });
  if(!patientBilledPreops.length) {
    body.innerHTML = '<div class="empty-state" style="margin:0;border:none"><span class="empty-state-icon">📞</span><div class="empty-state-title">No patient-billed pre-ops</div><div class="empty-state-sub">This tracker shows only cases where the patient pays directly. Surgery-center-billed cases are handled in the Payments tab.</div></div>';
    return;
  }
  const today = todayStr();
  const filter = window._followupFilter || 'all';
  const filtered = patientBilledPreops.filter(r => {
    // Hide past cases — Follow-up Tracker is for upcoming cases only.
    const surgDate = r['po-surgeryDate'];
    if(surgDate && surgDate < today) return false;
    // Hide PHI-hidden cases (3+ days post-surgery — but those are past anyway).
    if(typeof window.isPHIHidden === 'function' && window.isPHIHidden(surgDate, r['po-caseId'])) return false;
    // Josh/Dev's own call status — INTENTIONALLY independent of Nicole's
    // and Jordan's pills. They each make their own call to the patient
    // (pre-op vs day-of call), so this column tracks only po-callStatus
    // updated via Josh/Dev's own Call Status modal.
    const callStatus = r['po-callStatus'] || 'not-called';
    const row = window._paymentRows && window._paymentRows.find(pr => pr.caseId === r['po-caseId']);
    const remPaid = row ? !!row.paid : false;
    const lastFollowup = r['po-lastFollowupAt'];
    const needsFollowup = callStatus !== 'spoken' && callStatus !== 'not-called' && lastFollowup
      ? ((Date.now() - new Date(lastFollowup).getTime()) / 86400000) >= 5
      : false;
    if(filter === 'followup') return needsFollowup;
    if(filter === 'uncalled') return callStatus === 'not-called';
    if(filter === 'unpaid') return !remPaid;
    return true;
  });
  // Sort: needs follow-up first, then by surgery date (most recent past first)
  filtered.sort((a, b) => {
    const aDate = a['po-surgeryDate'] || '';
    const bDate = b['po-surgeryDate'] || '';
    // Upcoming/today first, then most recent past
    const aFuture = aDate >= today;
    const bFuture = bDate >= today;
    if(aFuture && !bFuture) return -1;
    if(!aFuture && bFuture) return 1;
    if(aFuture && bFuture) return aDate.localeCompare(bDate);
    return bDate.localeCompare(aDate);
  });
  if(!filtered.length) {
    body.innerHTML = '<div class="empty-state" style="margin:0;border:none"><span class="empty-state-icon">✓</span><div class="empty-state-title">Nothing matches this filter</div><div class="empty-state-sub">Try selecting "All" or another filter above.</div></div>';
    return;
  }
  // Table header — cleaner layout with status columns matching Payments tab
  // Compact column widths so the whole chart fits without horizontal scroll.
  // Case ID is truncated — full text appears on hover via the title attr.
  // No indicator column — the ⚠/⏰ icons are inline with the Case ID instead.
  const COLS = '140px 1fr 90px 160px 110px 130px 110px 110px';
  const cellCSS = 'display:flex;align-items:center';
  let html = `<div style="display:grid;grid-template-columns:${COLS};gap:6px;padding:10px 14px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-faint)">
    <span>Case ID</span><span>Patient</span><span>Surgery</span><span style="text-align:center">Cleared</span><span style="text-align:center">Call</span><span style="text-align:center">$500 Deposit</span><span style="text-align:center">Rem Payment</span><span style="text-align:center">Reminder</span>
  </div>`;
  // Cleared-status styling — mirrors Jordan's Tracker pill so Josh/Dev see
  // the exact same state. Read-only here; only Jordan cycles it on his side.
  const CLEARED_STATES = {
    '':        { label: '○ Pending',              bg:'#fff',    fg:'#64748b', border:'#cbd5e1', dashed:true  },
    'faxed':   { label: '📠 Faxed',               bg:'#ffedd5', fg:'#9a3412', border:'#fed7aa', dashed:false },
    'waiting': { label: '⏳ Waiting for records', bg:'#fef3c7', fg:'#92400e', border:'#fde68a', dashed:false },
    'cleared': { label: '✓ Cleared',              bg:'#e0e7ff', fg:'#3730a3', border:'#a5b4fc', dashed:false }
  };
  filtered.forEach(r => {
    const caseId = r['po-caseId'] || '—';
    const surgDate = r['po-surgeryDate'] || '';
    const surgDateFmt = surgDate ? fmtDate(surgDate) : '—';
    const isPast = surgDate && surgDate < today;
    const phiHidden = typeof window.isPHIHidden === 'function' && window.isPHIHidden(surgDate, caseId);
    // Patient-friendly display: "Smith, J — 05/15/2026" until 3 days post-surgery,
    // then auto-reverts to the technical case ID.
    const displayId = (typeof window.getCaseDisplayIdFromPreop === 'function')
      ? window.getCaseDisplayIdFromPreop(r)
      : caseId;
    const patientName = phiHidden
      ? '<span style="color:#94a3b8;font-style:italic">[hidden]</span>'
      : [r['po-patientLastName'], r['po-patientFirstName']].filter(Boolean).join(', ') || '—';
    // "From Nicole" / "From Jordan" tags removed per user request — Josh/Dev
    // don't want the noise on their dashboard tracker. The underlying
    // po-reviewStatus field is still maintained elsewhere; we just don't
    // render it here.
    const reviewStatus = r['po-reviewStatus'] || '';
    const reviewTag = '';
    const isPreCrna = reviewStatus === 'by-nicole' || reviewStatus === 'by-jordan';
    // Cleared status — mirrors Jordan's Tracker pill so Josh knows when the
    // patient is medically cleared and ready for him to call. Look up the
    // matching atlas/preop_visits entry by either preopRecordId (newer) or
    // po-preopVisitId on the pre-op record.
    const visitEntries = window._preopVisitEntries || [];
    const matchingVisit = visitEntries.find(e =>
      (r.id && e.preopRecordId === r.id) ||
      (r['po-preopVisitId'] && e.id === r['po-preopVisitId'])
    );
    const clearedKey = matchingVisit
      ? (matchingVisit.clearedStatus || (matchingVisit.clearedAt ? 'cleared' : ''))
      : '';
    const clearedState = CLEARED_STATES[clearedKey] || CLEARED_STATES[''];

    // Josh/Dev's own call — independent of Nicole's and Jordan's pills.
    const callStatus = r['po-callStatus'] || 'not-called';
    const lastFollowup = r['po-lastFollowupAt'];
    const callC = CALL_COLORS[callStatus] || CALL_COLORS['not-called'];
    const needsFollowup = callStatus !== 'spoken' && callStatus !== 'not-called' && lastFollowup
      ? ((Date.now() - new Date(lastFollowup).getTime()) / 86400000) >= 5
      : false;

    // $500 Deposit status — 3 states using Payments row + deposits cache
    const row = window._paymentRows && window._paymentRows.find(pr => pr.caseId === caseId);
    // Look up a matching record in atlas/deposits (created when "Send Deposit Link" was clicked)
    const depositRecord = (window._depositsCache || []).find(d => d.caseId === caseId);
    const depositSent = !!(row && row.depositDate) || !!depositRecord || !!r['po-depositSentAt'];
    const depositPaid = (row && row.dep500Paid) || (depositRecord && depositRecord.paid) || false;
    let depState, depBg, depColor, depLabel;
    if(depositPaid)       { depState='paid';    depBg='#dcfce7'; depColor='#166534'; depLabel='✓ $500 Paid'; }
    else if(depositSent)  { depState='sent';    depBg='#dbeafe'; depColor='#1e40af'; depLabel='📧 Sent (awaiting)'; }
    else                  { depState='not-sent'; depBg='#fef3c7'; depColor='#92400e'; depLabel='📧 Not Sent'; }

    // Remaining payment status
    const remPaid = row ? !!row.paid : false;

    // Reminder date
    const reminderDate = r['po-reminderDate'] || '';
    const reminderOverdue = reminderDate && reminderDate < today;
    const reminderToday = reminderDate === today;

    const rowBg = needsFollowup || reminderOverdue ? 'rgba(239,68,68,0.04)' : (reminderToday ? 'rgba(245,158,11,0.06)' : '');

    // Left-edge indicator
    const indicator = needsFollowup
      ? '<span title="Follow-up needed" style="color:#dc2626;font-size:14px">⚠</span>'
      : reminderOverdue
      ? '<span title="Reminder overdue" style="color:#dc2626;font-size:14px">⏰</span>'
      : reminderToday
      ? '<span title="Reminder today" style="color:#d97706;font-size:14px">⏰</span>'
      : '';

    // Inline indicator next to the case ID (instead of a separate column)
    const inlineIndicator = needsFollowup
      ? '<span title="Follow-up needed" style="color:#dc2626;font-size:13px;margin-right:4px;flex-shrink:0">⚠</span>'
      : reminderOverdue ? '<span title="Reminder overdue" style="color:#dc2626;font-size:13px;margin-right:4px;flex-shrink:0">⏰</span>'
      : reminderToday   ? '<span title="Reminder today" style="color:#d97706;font-size:13px;margin-right:4px;flex-shrink:0">⏰</span>'
      : '';
    const fuLabel = (displayId || caseId || '—').replace(/'/g, '&#39;');
    // First three cells (Case ID / Patient / Surgery) are clickable — opens
    // the Pre-Op vs Finalize Case picker. The remaining cells are interactive
    // status buttons and keep their own behavior.
    const openOC = `onclick="openCaseActionModal('${r.id}','${caseId}','${fuLabel}')"`;
    // Pre-CRNA rows used to be greyed out (opacity:.5, grayscale) to flag
    // "not ready for review yet." Keeping the From Nicole / From Jordan
    // tag is enough signal on its own and reading the row is much easier
    // at full contrast — so the dim-out is gone.
    const preCrnaStyle = '';
    html += `<div style="display:grid;grid-template-columns:${COLS};gap:6px;padding:10px 14px;border-bottom:1px solid var(--border);align-items:center;background:${rowBg};transition:background .12s;${preCrnaStyle}" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='${rowBg||'transparent'}'">
      <div ${openOC} title="Open Pre-Op or Finalize Case" style="${cellCSS};font-size:12px;font-weight:600;overflow:hidden;min-width:0;cursor:pointer">${inlineIndicator}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${displayId}</span></div>
      <div ${openOC} title="Open Pre-Op or Finalize Case" style="${cellCSS};font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;min-width:0;cursor:pointer">${patientName}${reviewTag}</div>
      <div ${openOC} title="Open Pre-Op or Finalize Case" style="${cellCSS};font-size:12px;color:var(--text-muted);cursor:pointer">${surgDateFmt}${isPast?' <span style="font-size:9px;color:var(--text-faint);margin-left:4px">(past)</span>':''}</div>
      <div style="${cellCSS};justify-content:center" title="Jordan updates this on his Tracker"><span style="display:inline-flex;align-items:center;justify-content:center;background:${clearedState.bg};color:${clearedState.fg};border:1px ${clearedState.dashed?'dashed':'solid'} ${clearedState.border};font-size:11px;font-weight:${clearedKey==='cleared'?'700':'600'};padding:4px 10px;border-radius:10px;white-space:nowrap">${clearedState.label}</span></div>
      <div style="${cellCSS};justify-content:center"><button onclick="openCallStatusModal('${r.id}')" style="background:${callC.bg};color:${callC.color};font-size:11px;font-weight:600;padding:5px 10px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;white-space:nowrap">${CALL_LABELS[callStatus] || '📞 Pending'}</button></div>
      <div style="${cellCSS};justify-content:center"><button onclick="togglePreopDepositStatus('${r.id}')" style="background:${depBg};color:${depColor};font-size:11px;font-weight:600;padding:5px 10px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;white-space:nowrap">${depLabel}</button></div>
      <div style="${cellCSS};justify-content:center"><button onclick="togglePreopRemPayment('${r.id}')" style="background:${remPaid?'#dcfce7':'#f1f5f9'};color:${remPaid?'#166534':'#64748b'};font-size:11px;font-weight:600;padding:5px 10px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;white-space:nowrap">${remPaid?'✓ Rem Paid':'💰 Pending'}</button></div>
      <div style="${cellCSS};justify-content:center"><button onclick="openReminderModal('${r.id}')" style="background:${reminderDate?(reminderOverdue?'#fef2f2':reminderToday?'#fef3c7':'#dbeafe'):'transparent'};color:${reminderDate?(reminderOverdue?'#dc2626':reminderToday?'#92400e':'#1e40af'):'var(--text-faint)'};border:1px ${reminderDate?'solid':'dashed'} ${reminderDate?(reminderOverdue?'#fca5a5':reminderToday?'#fde68a':'#bfdbfe'):'var(--border)'};font-size:11px;font-weight:600;padding:5px 10px;border-radius:8px;cursor:pointer;font-family:inherit;white-space:nowrap">${reminderDate?'⏰ '+fmtDate(reminderDate):'+ Set'}</button></div>
    </div>`;
  });
  body.innerHTML = html;
};

window.deleteInvoice = async function(id) {
if(!confirm('Delete this invoice record?')) return;
try {
const snap = await getDoc(doc(db,'atlas','invoices'));
const existing = snap.exists() ? (snap.data().invoices || []) : [];
const updated = existing.filter(i => i.id !== id);
setSyncing(true);
await setDoc(doc(db,'atlas','invoices'), { invoices: updated });
setSyncing(false);
renderSavedInvoices(updated);
} catch(e) {
console.error('Error deleting invoice:', e);
}
};
window.redownloadInvoice = function(id) {
// Find the saved invoice record
const invRecords = window._savedInvoices || [];
const inv = invRecords.find(i => i.id === id);
if(!inv) { alert('Invoice data not found. Try refreshing the page.'); return; }
const { jsPDF } = window.jspdf;
const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
const W = 215.9;
const navy = [29, 53, 87];
const lightBlue = [232, 238, 245];
const gray = [107, 104, 96];
const lightGray = [240, 239, 233];
const black = [26, 25, 22];
const white = [255, 255, 255];
// -- HEADER --
doc.setFillColor(...navy);
doc.rect(0, 0, W, 42, 'F');
doc.setFillColor(255, 255, 255);
doc.circle(20, 20, 12, 'F');
const logoEl = document.querySelector('img[style*="border-radius:50%"]');
if(logoEl) { try { doc.addImage(logoEl.src, 'PNG', 10, 10, 20, 20); } catch(e) {} }
doc.setTextColor(...white);
doc.setFontSize(20); doc.setFont('helvetica', 'bold');
doc.text('ATLAS ANESTHESIA', 36, 20);
doc.setFontSize(9); doc.setFont('helvetica', 'normal');
doc.text('Mobile Anesthesia Services', 36, 28);
doc.setFontSize(26); doc.setFont('helvetica', 'bold');
doc.text('INVOICE', W - 15, 20, { align: 'right' });
doc.setFontSize(9); doc.setFont('helvetica', 'normal');
doc.text(`# ${inv.invoiceNum}`, W - 15, 28, { align: 'right' });
doc.text(`Date: ${inv.date}`, W - 15, 34, { align: 'right' });
let y = 55;
// Billed To / From
doc.setFillColor(...lightGray);
doc.roundedRect(14, y, 85, 38, 2, 2, 'F');
doc.roundedRect(116, y, 85, 38, 2, 2, 'F');
doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...gray);
doc.text('BILLED TO', 20, y + 8);
doc.text('FROM', 122, y + 8);
doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...black);
doc.text(inv.location, 20, y + 17);
doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...gray);
doc.text('Anesthesia Services', 20, y + 25);
doc.text(inv.date, 20, y + 32);
doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...black);
doc.text('Atlas Anesthesia', 122, y + 17);
doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...gray);
doc.text(`Provider: ${inv.provider}`, 122, y + 25);
doc.text('Mobile Anesthesia Services', 122, y + 32);
y += 50;
// Table header
doc.setFillColor(...navy);
doc.roundedRect(14, y, W - 28, 10, 1, 1, 'F');
doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...white);
doc.text('DESCRIPTION', 20, y + 7);
doc.text('TIME', 110, y + 7, { align: 'center' });
doc.text('RATE', 155, y + 7, { align: 'center' });
doc.text('AMOUNT', W - 20, y + 7, { align: 'right' });
y += 12;
// Row 1: First hour
doc.setFillColor(...lightGray);
doc.rect(14, y, W - 28, 10, 'F');
doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...black);
doc.text('Anesthesia Services — First Hour', 20, y + 7);
doc.text('60 min', 110, y + 7, { align: 'center' });
doc.text(`$${inv.firstHourRate.toFixed(2)}`, 155, y + 7, { align: 'center' });
doc.text(`$${inv.firstHourRate.toFixed(2)}`, W - 20, y + 7, { align: 'right' });
y += 12;
// Row 2: Additional time if any
const billedMins = inv.billedDuration ? parseInt(inv.billedDuration) : 0;
if(billedMins > 60 || inv.total > inv.firstHourRate) {
const extraCost = inv.total - inv.firstHourRate;
const extraBlocks = inv.per15Rate > 0 ? Math.round(extraCost / inv.per15Rate) : 0;
if(extraBlocks > 0) {
doc.setFillColor(...white);
doc.rect(14, y, W - 28, 10, 'F');
doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...black);
doc.text(`Additional Time (${extraBlocks} × 15-min block${extraBlocks!==1?'s':''})`, 20, y + 7);
doc.text(`$${inv.per15Rate.toFixed(2)}/15min`, 155, y + 7, { align: 'center' });
doc.text(`$${extraCost.toFixed(2)}`, W - 20, y + 7, { align: 'right' });
y += 12;
}
}
y += 4;
// Time detail
doc.setFillColor(...lightBlue);
doc.roundedRect(14, y, W - 28, 14, 2, 2, 'F');
doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...navy);
doc.text('TIME DETAIL', 20, y + 6);
doc.setFont('helvetica', 'normal'); doc.setTextColor(...black);
doc.text(`${inv.start} → ${inv.end}`, 20, y + 12);
doc.text(`Actual: ${inv.actualDuration} · Billed: ${inv.billedDuration}`, 20, y + 19);
y += 28;
// Total
doc.setFillColor(...navy);
doc.roundedRect(120, y, W - 134, 18, 2, 2, 'F');
doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...white);
doc.text('TOTAL DUE', 128, y + 7);
doc.setFontSize(16);
doc.text(`$${inv.total.toFixed(2)}`, W - 20, y + 12, { align: 'right' });
y += 28;
// Footer
doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...gray);
doc.text('Thank you for choosing Atlas Anesthesia — Mobile Anesthesia Services', W/2, y, { align: 'center' });
doc.text(`Invoice ${inv.invoiceNum} · Generated ${new Date().toLocaleDateString()}`, W/2, y+6, { align:'center' });
doc.setDrawColor(...navy); doc.setLineWidth(1.5);
doc.line(14, y+12, W-14, y+12);
doc.save(`Atlas-Invoice-${inv.invoiceNum}.pdf`);
};
window.clearInvoice = function() {
['inv-location','inv-date','inv-start','inv-end','inv-first-hour','inv-per-15'].forEach(id => {
const el = document.getElementById(id);
if(el) el.value = '';
});
document.getElementById('inv-summary').innerHTML = 'Enter times and rates to see summary';
document.getElementById('inv-total').textContent = '$0.00';
};
// -- EKG ORDER LOGIC --
const EKG_CONDITIONS = {
// Cardiovascular
'po-cv-htn': 'Hypertension (HTN)',
'po-cv-cad': 'Coronary Artery Disease (CAD)',
'po-cv-angina': 'Angina',
'po-cv-mi': 'Myocardial Infarction (MI)',
'po-cv-chf': 'Congestive Heart Failure (CHF)',
'po-cv-murmur': 'Cardiac Murmur',
'po-cv-arrythmia':'Arrhythmia',
// EKG findings
'po-ekg-afib': 'Atrial Fibrillation (AFIB)',
'po-ekg-bbb': 'Bundle Branch Block (BBB)',
'po-ekg-lvh': 'Left Ventricular Hypertrophy (LVH)',
'po-ekg-chngs': 'EKG Changes',
// Neuro (cerebrovascular)
'po-neuro-cva': 'Cerebrovascular Accident (CVA/Stroke)',
// Metabolic
'po-meta-iddm': 'Insulin-Dependent Diabetes (IDDM)',
'po-meta-niddm': 'Non-Insulin Dependent Diabetes (NIDDM)',
// Renal
'po-renal-dialysis': 'Dialysis / Chronic Kidney Disease',
'po-renal-esrd': 'End-Stage Renal Disease (ESRD)',
};
// EKG criteria categories for the order
const EKG_CRITERIA_MAP = {
'po-cv-htn': 'Cardiovascular / Major Vascular Disease',
'po-cv-cad': 'Cardiovascular / Major Vascular Disease',
'po-cv-angina': 'Cardiovascular / Major Vascular Disease',
'po-cv-mi': 'Cardiovascular / Major Vascular Disease',
'po-cv-chf': 'Cardiovascular / Major Vascular Disease',
'po-cv-murmur': 'Cardiovascular / Major Vascular Disease',
'po-cv-arrythmia': 'Arrhythmia (bradycardia, heart block, PVC, paced rhythm, or controlled rate AF)',
'po-ekg-afib': 'Arrhythmia — Atrial Fibrillation',
'po-ekg-bbb': 'Arrhythmia — Bundle Branch Block',
'po-ekg-lvh': 'Cardiovascular — LVH',
'po-ekg-chngs': 'Cardiovascular — EKG Changes',
'po-neuro-cva': 'Cerebrovascular Disease (CVA/Stroke)',
'po-meta-iddm': 'Diabetes Mellitus',
'po-meta-niddm': 'Diabetes Mellitus',
'po-renal-dialysis':'Chronic Kidney Disease (GFR <60)',
'po-renal-esrd': 'Chronic Kidney Disease — ESRD',
};
let ekgTriggeredConditions = [];
function checkEKGConditions() {
ekgTriggeredConditions = [];
Object.entries(EKG_CONDITIONS).forEach(([id, label]) => {
const el = document.getElementById(id);
if(el && el.checked) ekgTriggeredConditions.push({ id, label, criteria: EKG_CRITERIA_MAP[id] });
});
const banner = document.getElementById('ekg-alert-banner');
if(!banner) return;
if(ekgTriggeredConditions.length > 0) {
// Group by criteria
const criteria = [...new Set(ekgTriggeredConditions.map(c => c.criteria))];
banner.style.display = 'block';
banner.innerHTML = `
<div style="background:#fef3cd;border:1.5px solid #f59e0b;border-radius:var(--radius-sm);padding:16px 18px"><div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px"><div><div style="font-size:14px;font-weight:600;color:#92400e;margin-bottom:6px">
⚠ EKG / PCP Order Indicated
</div><div style="font-size:12px;color:#78350f;margin-bottom:8px">
Based on the following checked condition(s):
</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#78350f">
${ekgTriggeredConditions.map(c => `<li>${c.label}</li>`).join('')}
</ul></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" onclick="openEKGModal()"
style="background:#92400e;color:#fff;border:none">
📋 View EKG Order
</button><button class="btn btn-ghost btn-sm" onclick="downloadEKGPDF()">
⬇ Download PDF
</button></div></div></div>`;
} else {
banner.style.display = 'none';
banner.innerHTML = '';
}
}
function buildEKGOrderHTML(caseId, surgeryDate, provider, forPDF) {
const criteria = [...new Set(ekgTriggeredConditions.map(c => c.criteria))];
const conditions = ekgTriggeredConditions.map(c => c.label);
const dateStr = surgeryDate
? new Date(surgeryDate + 'T12:00:00').toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})
: new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
const today = new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
const providerName = provider || (currentWorker === 'dev' ? 'Devarsh Murthy, CRNA' : 'Josh Condado, CRNA');
if(forPDF) return { criteria, conditions, dateStr, today, providerName, caseId };
return `
<div style="font-family:'DM Sans',sans-serif;font-size:13px;color:#1a1916;line-height:1.6"><div style="text-align:center;border-bottom:2px solid #1d3557;padding-bottom:16px;margin-bottom:20px"><div style="font-size:18px;font-weight:700;color:#1d3557;letter-spacing:1px">PRE-OPERATIVE EKG ORDER</div><div style="font-size:12px;color:#6b6860;margin-top:4px">Primary Care Physician / Ordering Provider Communication</div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px"><div style="padding:10px 14px;background:#f5f4f0;border-radius:6px"><div style="font-size:10px;font-weight:700;color:#9c9a94;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Case ID</div><div style="font-weight:500">${caseId || '—'}</div></div><div style="padding:10px 14px;background:#f5f4f0;border-radius:6px"><div style="font-size:10px;font-weight:700;color:#9c9a94;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Date of Surgery</div><div style="font-weight:500">${dateStr}</div></div><div style="padding:10px 14px;background:#f5f4f0;border-radius:6px"><div style="font-size:10px;font-weight:700;color:#9c9a94;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Ordering Provider</div><div style="font-weight:500">${providerName}</div></div><div style="padding:10px 14px;background:#f5f4f0;border-radius:6px"><div style="font-size:10px;font-weight:700;color:#9c9a94;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Order Date</div><div style="font-weight:500">${today}</div></div></div><div style="margin-bottom:16px"><div style="font-size:12px;font-weight:700;color:#1d3557;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;border-bottom:1px solid #e2e0d8;padding-bottom:4px">ORDER</div><div style="font-size:14px;font-weight:600;margin-bottom:6px">Please obtain a 12-lead Electrocardiogram (EKG) prior to the scheduled procedure.</div><div style="font-size:13px;color:#6b6860">Results to be forwarded to the anesthesia provider prior to the date of surgery.</div></div><div style="margin-bottom:16px"><div style="font-size:12px;font-weight:700;color:#1d3557;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;border-bottom:1px solid #e2e0d8;padding-bottom:4px">Clinical Indication(s)</div><ul style="margin:0;padding-left:18px">
${conditions.map(c=>`<li style="margin-bottom:4px">${c}</li>`).join('')}
</ul></div><div style="margin-bottom:16px"><div style="font-size:12px;font-weight:700;color:#1d3557;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;border-bottom:1px solid #e2e0d8;padding-bottom:4px">Basis for Order</div><div style="font-size:12px;color:#6b6860;margin-bottom:8px">Per anesthesia pre-operative assessment, EKG is indicated based on:</div><ul style="margin:0;padding-left:18px">
${criteria.map(c=>`<li style="margin-bottom:4px;font-size:13px">${c}</li>`).join('')}
</ul></div><div style="margin-bottom:20px"><div style="font-size:12px;font-weight:700;color:#1d3557;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;border-bottom:1px solid #e2e0d8;padding-bottom:4px">Urgency</div><div style="font-size:13px">
Required <strong>prior to date of surgery (${dateStr})</strong>.
EKG obtained within the past 6 months may be acceptable if the patient's condition has been stable and asymptomatic.
</div></div><div style="border-top:1px solid #e2e0d8;padding-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:20px"><div><div style="font-size:11px;color:#9c9a94;margin-bottom:24px">Ordering Provider Signature</div><div style="border-top:1px solid #1a1916;padding-top:4px;font-size:12px;color:#6b6860">${providerName} — Atlas Anesthesia</div></div><div><div style="font-size:11px;color:#9c9a94;margin-bottom:24px">Date</div><div style="border-top:1px solid #1a1916;padding-top:4px;font-size:12px;color:#6b6860">${today}</div></div></div><div style="margin-top:16px;padding:10px 14px;background:#e8eef5;border-radius:6px;font-size:11px;color:#1d3557"><strong>Atlas Anesthesia</strong> — Mobile Anesthesia Services · Questions: contact ordering provider
</div></div>`;
}
window.openEKGModal = function() {
const caseId = document.getElementById('po-caseId')?.value || document.getElementById('po-caseId-display')?.textContent || '—';
const surgeryDate = document.getElementById('po-surgeryDate')?.value || '';
const provider = document.getElementById('po-provider')?.value || '';
document.getElementById('ekgModalContent').innerHTML = buildEKGOrderHTML(caseId, surgeryDate, provider, false);
document.getElementById('ekgModal').style.display = 'flex';
};
window.closeEKGModal = function() {
document.getElementById('ekgModal').style.display = 'none';
};
window.downloadEKGPDF = function() {
const caseId = document.getElementById('po-caseId')?.value || document.getElementById('po-caseId-display')?.textContent || '—';
const surgeryDate = document.getElementById('po-surgeryDate')?.value || '';
const provider = document.getElementById('po-provider')?.value || '';
const { criteria, conditions, dateStr, today, providerName } = buildEKGOrderHTML(caseId, surgeryDate, provider, true);
const { jsPDF } = window.jspdf;
const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
const W = 215.9;
const navy = [29,53,87], black = [26,25,22], gray = [107,104,96], lightGray = [240,239,233], lightBlue = [232,238,245];
// Title
doc.setFontSize(18); doc.setFont('helvetica','bold'); doc.setTextColor(...navy);
doc.text('PRE-OPERATIVE EKG ORDER', W/2, 20, {align:'center'});
doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
doc.text('Primary Care Physician / Ordering Provider Communication', W/2, 27, {align:'center'});
doc.setDrawColor(...navy); doc.setLineWidth(1); doc.line(14, 30, W-14, 30);
let y = 38;
// Info grid
const infoItems = [
['Case ID', caseId], ['Date of Surgery', dateStr],
['Ordering Provider', providerName], ['Order Date', today]
];
infoItems.forEach((item, i) => {
const x = i%2===0 ? 14 : W/2+2;
if(i%2===0 && i>0) y += 18;
doc.setFillColor(...lightGray);
doc.roundedRect(x, y, W/2-16, 14, 1, 1, 'F');
doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(...gray);
doc.text(item[0].toUpperCase(), x+4, y+6);
doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(...black);
doc.text(String(item[1]).substring(0,35), x+4, y+12);
});
y += 22;
// Order box
doc.setFillColor(...lightBlue);
doc.roundedRect(14, y, W-28, 18, 2, 2, 'F');
doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(...navy);
doc.text('ORDER', 20, y+7);
doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(...black);
doc.text('Please obtain a 12-lead Electrocardiogram (EKG) prior to the scheduled procedure.', 20, y+14);
y += 24;
// Clinical indications
doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...navy);
doc.text('CLINICAL INDICATION(S)', 14, y);
doc.setLineWidth(0.3); doc.setDrawColor(...navy); doc.line(14, y+2, W-14, y+2);
y += 7;
doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(...black);
conditions.forEach(c => {
doc.text(`• ${c}`, 18, y); y += 6;
});
y += 4;
// Basis for order
doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...navy);
doc.text('BASIS FOR ORDER', 14, y);
doc.line(14, y+2, W-14, y+2);
y += 7;
doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
doc.text('Per anesthesia pre-operative assessment, EKG is indicated based on:', 14, y);
y += 6;
doc.setTextColor(...black);
criteria.forEach(c => {
const lines = doc.splitTextToSize(`• ${c}`, W-32);
lines.forEach(line => { doc.text(line, 18, y); y += 5; });
});
y += 4;
// Urgency
doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...navy);
doc.text('URGENCY', 14, y);
doc.line(14, y+2, W-14, y+2);
y += 7;
doc.setFont('helvetica','normal'); doc.setTextColor(...black);
const urgencyText = `Required prior to date of surgery (${dateStr}). EKG obtained within the past 6 months may be acceptable if the patient's condition has been stable and asymptomatic.`;
const urgencyLines = doc.splitTextToSize(urgencyText, W-28);
urgencyLines.forEach(line => { doc.text(line, 14, y); y += 5; });
y += 8;
// Signature lines
doc.setLineWidth(0.5); doc.setDrawColor(...black);
doc.line(14, y+12, 95, y+12);
doc.line(110, y+12, W-14, y+12);
doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
doc.text('Ordering Provider Signature', 14, y+17);
doc.text('Date', 110, y+17);
doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(...black);
doc.text(`${providerName} — Atlas Anesthesia`, 14, y+24);
doc.text(today, 110, y+24);
y += 32;
// Footer
doc.setFillColor(...lightBlue);
doc.rect(14, y, W-28, 10, 'F');
doc.setFontSize(8); doc.setTextColor(...navy);
doc.text('Atlas Anesthesia — Mobile Anesthesia Services', W/2, y+6, {align:'center'});
doc.save(`Atlas-EKG-Order-${caseId}-${(surgeryDate||'').replace(/-/g,'')}.pdf`);
};
// Hook into pre-op checkboxes to auto-detect EKG conditions
function wireEKGDetection() {
Object.keys(EKG_CONDITIONS).forEach(id => {
const el = document.getElementById(id);
if(el) el.addEventListener('change', checkEKGConditions);
});
}
// -- MID-CASE --
let midCaseFilter = 'all';
window.setMidCaseFilter = function(f) {
midCaseFilter = f;
['all','dev','josh'].forEach(x => {
const btn = document.getElementById('mcbtn-'+x);
if(!btn) return;
btn.style.background = x===f ? (x==='dev'?'var(--dev)':x==='josh'?'var(--josh)':'var(--info)') : '';
btn.style.color = x===f ? '#fff' : '';
});
renderMidCase();
};
window.renderMidCase = renderMidCase;
async function renderMidCase() {
const el = document.getElementById('midCaseList');
if(!el) return;
// Mid-Case is now strictly per-worker: each logged-in user only sees their
// own draft cases and pre-ops. The old All/Dev/Josh toggle is hidden because
// it would be confusing — there's nothing to switch between.
const mcAll = document.getElementById('mcbtn-all');
if(mcAll && mcAll.parentElement) mcAll.parentElement.style.display = 'none';
// Get all saved pre-op records
let preopRecords = [];
try {
const snap = await getDoc(doc(db,'atlas','preop'));
preopRecords = snap.exists() ? (snap.data().records || []) : [];
} catch(e) { console.error(e); }
// Get draft cases
let drafts = cases.filter(c => c.draft);
// Filter to the logged-in worker — but Jordan (assistant) and Nicole
// (scheduler) work across both CRNAs, so they see every pre-op and draft.
if(window._userRole !== 'assistant' && window._userRole !== 'scheduler') {
  preopRecords = preopRecords.filter(r => (r.worker || 'dev') === currentWorker);
  drafts = drafts.filter(d => (d.worker || 'dev') === currentWorker);
}
// Match pre-ops to drafts by caseId
const draftIds = new Set(drafts.map(d => d.caseId));
// IDs of already-finalized cases — exclude these from Mid-Case entirely
const finalizedIds = new Set(cases.filter(c => !c.draft).map(c => c.caseId).filter(Boolean));
// Only show pre-ops that don't have a finalized case yet
preopRecords = preopRecords.filter(r => !finalizedIds.has(r['po-caseId']));
// Combine: show all pre-ops, with draft status if applicable
const allPreops = preopRecords.sort((a,b) => {
  const dateA = a['po-surgeryDate']||'', dateB = b['po-surgeryDate']||'';
  if(dateA !== dateB) return dateA.localeCompare(dateB);
  const timeA = a['po-startTime'] || '99:99';
  const timeB = b['po-startTime'] || '99:99';
  if(timeA !== timeB) return timeA.localeCompare(timeB);
  return (a['po-caseId']||'').localeCompare(b['po-caseId']||'');
});
if(!allPreops.length && !drafts.length) {
el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🩺</span><div class="empty-state-title">No mid-case records yet</div><div class="empty-state-sub">Cases waiting to be finalized will appear here once you save a Pre-Op.</div><button class="empty-state-cta" onclick="showTab(\'preop\')">+ New Pre-Op →</button></div>';
return;
}
// Build combined list
const items_html = allPreops.map(r => {
const caseId = r['po-caseId'] || '—';
const displayCaseId = typeof window.getCaseDisplayIdFromPreop === 'function' ? window.getCaseDisplayIdFromPreop(r) : caseId;
const hasDraft = draftIds.has(caseId);
const draft = drafts.find(d => d.caseId === caseId);
const pill = r.worker==='dev' ? 'pill-dev' : 'pill-josh';
const wname = r.worker==='dev' ? 'Devarsh' : 'Josh';
const surgDate = r['po-surgeryDate'] || '—'; // raw for logic
const surgDateFmt = fmtDate(r['po-surgeryDate']) || '—';
const provider = r['po-provider'] || '—';
// PHI auto-hide: hide patient details 3+ days after surgery date (HIPAA minimum-necessary)
const phiHidden = typeof window.isPHIHidden === 'function' && window.isPHIHidden(r['po-surgeryDate'], caseId);
const showAllergies = r['po-allergies'] && !phiHidden;
const showMeds = r['po-medications'] && !phiHidden;
const showComments = r['po-comments'] && !phiHidden;
const phiBadge = phiHidden ? `<span style="background:#f1f5f9;color:#64748b;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;display:inline-flex;align-items:center;gap:3px" title="Patient details hidden — case is 3+ days old">🔒 PHI HIDDEN</span>` : '';
// Summarize checked conditions
const cvFlags = ['htn','cad','angina','mi','chf','murmur','arrythmia'].filter(x=>r['po-cv-'+x]).map(x=>x.toUpperCase());
const pulmFlags = ['asthma','copd','uri','cpap','sleep-apnea','smoker'].filter(x=>r['po-pulm-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const allFlags = [...cvFlags, ...pulmFlags];
const today = todayStr();
const isPast = surgDate !== '—' && surgDate < today;
const isToday = surgDate === today;
const borderColor = isPast ? 'var(--warn)' : isToday ? 'var(--accent)' : 'var(--info)';
const bgTint = isPast ? 'rgba(181,69,27,0.04)' : isToday ? 'rgba(45,106,79,0.04)' : 'transparent';
const dateLabel = isPast
? `<span style="background:var(--warn-light);color:var(--warn);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">⏱ PAST</span>`
: isToday
? `<span style="background:var(--accent-light);color:var(--accent);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">● TODAY</span>`
: `<span style="background:var(--info-light);color:var(--info);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">📅 UPCOMING</span>`;
return `<div class="case-item" style="border-left:3px solid ${borderColor};background:${bgTint}"><div class="case-item-header" onclick="toggleMidCase('${r.id}')"><div><div class="case-name" style="display:flex;align-items:center;gap:8px">
${displayCaseId}
<span class="worker-pill ${pill}" style="font-size:10px">${wname}</span>
${dateLabel}
${hasDraft ? '<span style="background:var(--warn-light);color:var(--warn);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">✏ DRAFT</span>' : ''}
${phiBadge}
</div><div class="case-date">
Surgery: ${surgDateFmt} · Dentist: ${provider}
${showAllergies ? ' · <span style="color:var(--warn)">⚠ Allergies</span>' : ''}
</div>
${phiHidden ? `<div style="margin-top:6px">${window.phiRevealButtonHTML(caseId, 'renderMidCase')}</div>` : ''}
${allFlags.length ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
${allFlags.map(f=>`<span style="background:var(--info-light);color:var(--info);font-size:10px;font-weight:600;padding:1px 7px;border-radius:10px">${f}</span>`).join('')}
</div>` : ''}
${typeof window.buildPreopFollowupPills === 'function' ? window.buildPreopFollowupPills(r) : ''}
</div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
${window._userRole === 'assistant'
? `<button onclick="event.stopPropagation();editPreopRecord('${r.id}')" class="btn btn-primary btn-sm" style="font-size:11px">✏ Edit Pre-Op</button>`
: (hasDraft && draft
  ? `<button onclick="event.stopPropagation();resumeCase('${draft.id}')" class="btn btn-primary btn-sm" style="font-size:11px">Finalize Case →</button>`
  : `<button onclick="event.stopPropagation();startCaseFromPreop('${r.id}')" class="btn btn-primary btn-sm" style="font-size:11px">Finalize Case →</button>`)
}
<div style="position:relative;display:inline-block">
<button onclick="event.stopPropagation();toggleMidCaseDropdown('${r.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">Actions ▾</button>
<div id="midcase-menu-${r.id}" style="display:none;position:absolute;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:0 4px 12px rgba(0,0,0,.12);z-index:9999;min-width:150px;overflow:hidden">
<button onclick="event.stopPropagation();toggleMidCaseDropdown('${r.id}');previewDraft('${r.id}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--text);font-family:inherit">👁 Preview</button>
<button onclick="event.stopPropagation();toggleMidCaseDropdown('${r.id}');editPreopRecord('${r.id}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--text);font-family:inherit">✏ Edit Pre-Op</button>
<button onclick="event.stopPropagation();toggleMidCaseDropdown('${r.id}');generatePatientPortalLink('${caseId}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:#2d6a4f;font-family:inherit">🔗 Patient Portal Link</button>
<button onclick="event.stopPropagation();toggleMidCaseDropdown('${r.id}');deleteMidCase('preop','${r.id}','${caseId}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--warn);font-family:inherit">🗑 Delete</button>
</div>
</div></div></div><div class="case-items-list" id="midcase-detail-${r.id}"><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:10px;font-size:13px"><div><strong style="font-size:10px;text-transform:uppercase;color:var(--text-faint)">Surgery Date</strong><div>${fmtDate(r['po-surgeryDate'])||'—'}</div></div><div><strong style="font-size:10px;text-transform:uppercase;color:var(--text-faint)">Call Date/Time</strong><div>${r['po-callDateTime']||'—'}</div></div><div><strong style="font-size:10px;text-transform:uppercase;color:var(--text-faint)">Mallampati</strong><div style="font-size:18px;font-weight:500;font-family:'DM Mono',monospace">${r['mallampati']||'—'}</div></div>
${showAllergies?`<div style="grid-column:1/-1"><strong style="font-size:10px;text-transform:uppercase;color:var(--warn)">⚠ Allergies</strong><div style="color:var(--warn)">${r['po-allergies']}</div></div>`:''}
${showMeds?`<div style="grid-column:1/-1"><strong style="font-size:10px;text-transform:uppercase;color:var(--text-faint)">Medications</strong><div>${r['po-medications']}</div></div>`:''}
${showComments?`<div style="grid-column:1/-1"><strong style="font-size:10px;text-transform:uppercase;color:var(--text-faint)">Comments</strong><div style="font-style:italic">${r['po-comments']}</div></div>`:''}
${phiHidden && (r['po-allergies'] || r['po-medications'] || r['po-comments'] || r['po-surgicalHistory'] || r['po-driverName'] || r['po-patientEmail']) ? `<div style="grid-column:1/-1;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:10px 12px;text-align:center"><div style="font-size:12px;color:#64748b;margin-bottom:6px">🔒 Patient details (allergies, medications, contact info, etc.) are hidden under HIPAA minimum-necessary rule.</div>${window.phiRevealButtonHTML(caseId, 'renderMidCase')}</div>` : ''}
</div>
${hasDraft && draft && draft.items && draft.items.length ? `
<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)"><strong style="font-size:10px;text-transform:uppercase;color:var(--text-faint)">Supplies Added So Far</strong>
${draft.items.map(i=>`<div class="case-item-row"><span>${i.generic} × ${i.qty}</span><span>$${i.lineTotal.toFixed(2)}</span></div>`).join('')}
</div>` : ''}
</div></div>`;
}).join('');
// Also show drafts that have no matching pre-op. Jordan (assistant) doesn't
// see these — orphan drafts are case-side work and are surfaced for CRNAs
// to finalize, which isn't his job.
const orphanDrafts = (window._userRole === 'assistant') ? [] : drafts
  .filter(d => !preopRecords.find(r => r['po-caseId'] === d.caseId))
  .sort((a,b) => {
    if((a.date||'') !== (b.date||'')) return (a.date||'').localeCompare(b.date||'');
    return (a.startTime||'99:99').localeCompare(b.startTime||'99:99');
  });
const orphanHtml = orphanDrafts.map(d => {
const pill = d.worker==='dev' ? 'pill-dev' : 'pill-josh';
const wname = d.worker==='dev' ? 'Devarsh' : 'Josh';
const dToday = todayStr();
const dIsPast = d.date && d.date < dToday;
const dIsToday = d.date === dToday;
const dBorder = dIsPast ? 'var(--warn)' : dIsToday ? 'var(--accent)' : '#6b7280';
const dBg = dIsPast ? 'rgba(181,69,27,0.04)' : dIsToday ? 'rgba(45,106,79,0.04)' : 'transparent';
const dDateLabel = dIsPast
? `<span style="background:var(--warn-light);color:var(--warn);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">⏱ PAST</span>`
: dIsToday
? `<span style="background:var(--accent-light);color:var(--accent);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">● TODAY</span>`
: `<span style="background:#f3f4f6;color:#6b7280;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">📅 UPCOMING</span>`;
return `<div class="case-item" style="border-left:3px solid ${dBorder};background:${dBg}"><div class="case-item-header"><div><div class="case-name" style="display:flex;align-items:center;gap:8px">
${d.caseId}
<span class="worker-pill ${pill}" style="font-size:10px">${wname}</span>${dDateLabel}<span style="background:var(--warn-light);color:var(--warn);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">✏ DRAFT</span></div><div class="case-date">${fmtDate(d.date)} · ${d.provider||'—'}</div></div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><button onclick="resumeCase('${d.id}')" class="btn btn-primary btn-sm" style="font-size:11px">Finalize Case →</button><button onclick="editFinalizedCase('${d.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">✏ Edit Draft</button><button onclick="deleteMidCase('draft','${d.id}','${d.caseId}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">🗑 Delete</button></div></div></div>`;
}).join('');
el.innerHTML = (items_html + orphanHtml) || '<div class="empty-state">No mid-case records yet.</div>';
// Deposit status is now manual — no Stripe check needed
// Render Review For Tomorrow
renderReviewTomorrow();
}
window.toggleMidCase = function(id) {
document.getElementById('midcase-detail-'+id).classList.toggle('open');
};
window.deleteMidCase = async function(type, id, caseId) {
const label = caseId || id;
const _isTest = caseId && caseId.startsWith('TEST-');
// Route every delete through the bulletproof purge.
if(caseId) {
  const prompt = _isTest
    ? 'Delete TEST case "' + label + '"?\n\nThis will fully remove it from every part of the app.'
    : 'Delete "' + label + '"?\n\nThis permanently removes the pre-op, draft, finalized case, payments row, CS log, deposits, saved PDFs, and payouts.\n\nThis cannot be undone.';
  if(!confirm(prompt)) return;
  await window._purgeCaseEverywhere(caseId);
  if(typeof renderMidCase === 'function') renderMidCase();
  if(typeof refreshDraftPicker === 'function') refreshDraftPicker();
  if(typeof _globalRefresh === 'function') _globalRefresh();
  if(typeof toastSuccess === 'function') toastSuccess('Case ' + caseId + ' deleted everywhere.');
  return;
}
const confirmed = confirm(`Are you sure you want to delete "${label}"?\n\nThis will remove the ${type === 'preop' ? 'pre-op record' : 'draft case'}. This cannot be undone.`);
if(!confirmed) return;
try {
if(type === 'preop') {
// Delete the pre-op record
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records || []) : [];
const updated = records.filter(r => r.id !== id);
setSyncing(true);
await savePreopRecords(updated);
setSyncing(false);
// Also delete any matching draft case
const matchingDraft = cases.find(c => c.draft && c.caseId === caseId);
if(matchingDraft) {
cases = cases.filter(c => c.id !== matchingDraft.id);
await saveCases();
}
} else if(type === 'draft') {
// Delete just the draft case
cases = cases.filter(c => c.id !== id);
await saveCases();
}
renderMidCase();
refreshDraftPicker();
} catch(e) {
alert('Error deleting record. Please try again.');
console.error(e);
}
};
async function autoCheckDeposit(recordId, email) {
const badge = document.getElementById('deposit-badge-' + recordId);
if(!badge || !email) return;
try {
const res = await fetch(STRIPE_WORKER_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ email })
});
const data = await res.json();
if(data.status === 'paid') {
badge.innerHTML = `<span style="background:var(--accent-light);color:var(--accent);font-size:10px;font-weight:600;padding:2px 9px;border-radius:20px">✓ PAID — $${data.amount} ${data.currency}</span>`;
} else if(data.status === 'unpaid') {
badge.innerHTML = `<span style="background:var(--warn-light);color:var(--warn);font-size:10px;font-weight:600;padding:2px 9px;border-radius:20px">✗ NOT PAID</span>`;
} else if(data.status === 'not_found') {
badge.innerHTML = `<span style="background:#f1f5f9;color:#64748b;font-size:10px;font-weight:600;padding:2px 9px;border-radius:20px">? Not in Stripe</span>`;
} else {
badge.innerHTML = `<span style="color:var(--text-faint);font-size:10px">Unable to check</span>`;
}
} catch(err) {
badge.innerHTML = `<span style="color:var(--text-faint);font-size:10px">—</span>`;
}
}
window.checkStripeDeposit = async function(recordId) {
const statusEl = document.getElementById('deposit-status-' + recordId);
const btn = document.getElementById('deposit-btn-' + recordId);
const email = btn ? btn.getAttribute('data-email') : null;
if(!statusEl) return;
statusEl.innerHTML = '<span style="color:var(--text-faint)">Checking...</span>';
try {
const res = await fetch(STRIPE_WORKER_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ email })
});
const data = await res.json();
if(data.status === 'paid') {
statusEl.innerHTML = `
<span style="background:var(--accent-light);color:var(--accent);font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px">
✓ PAID — $${data.amount} ${data.currency} on ${data.date}
</span>`;
} else if(data.status === 'unpaid') {
statusEl.innerHTML = `
<span style="background:var(--warn-light);color:var(--warn);font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px">
✗ NO PAYMENT FOUND
</span>`;
} else if(data.status === 'not_found') {
statusEl.innerHTML = `
<span style="background:#f1f5f9;color:#64748b;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px">
? No Stripe customer found for this email
</span>`;
} else {
statusEl.innerHTML = `
<span style="color:var(--warn);font-size:11px">Error: ${data.error || 'Unknown error'}</span>`;
}
} catch(err) {
statusEl.innerHTML = `<span style="color:var(--warn);font-size:11px">Connection error — try again</span>`;
console.error('Stripe check error:', err);
}
};
function populateFinalizeFromPreop(r) {
if(!r) return;
// HIPAA: 3 days after surgery, patient identifiers (phone, driver name,
// contact phone, etc.) disappear from this summary unless the case has been
// PHI-revealed for the session.
const _phiHide = typeof window.isPHIHidden === 'function'
  && window.isPHIHidden(r['po-surgeryDate'], r['po-caseId']);
const _phiVal = (fid, val) => {
  if(_phiHide && typeof window.isPHIField === 'function' && window.isPHIField(fid)) return null;
  return val;
};
// Fill case fields
const el = id => document.getElementById(id);
if(el('caseId')) el('caseId').value = r['po-caseId'] || '';
if(el('provider')) el('provider').value = r['po-provider'] || '';
if(el('caseDate')) el('caseDate').value = r['po-surgeryDate'] || '';
// Build pre-op summary display
const cvFlags = ['htn','cad','angina','mi','chf','murmur','arrythmia'].filter(x=>r['po-cv-'+x]).map(x=>x.toUpperCase());
const ekgFlags = ['nsr','afib','bbb','lvh','chngs'].filter(x=>r['po-ekg-'+x]).map(x=>x.toUpperCase());
const pulmFlags = ['asthma','copd','uri','o2','cpap','sleep-apnea','smoker'].filter(x=>r['po-pulm-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const metaFlags = ['iddm','niddm','thyroid','obesity','morbid-obesity'].filter(x=>r['po-meta-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const renalFlags = ['dialysis','esrd'].filter(x=>r['po-renal-'+x]).map(x=>x.toUpperCase());
const neuroFlags = ['cva','seizures','nm-disease'].filter(x=>r['po-neuro-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const ekgRequired = ['po-cv-htn','po-cv-cad','po-cv-mi','po-cv-chf','po-cv-arrythmia','po-ekg-afib',
'po-neuro-cva','po-meta-iddm','po-meta-niddm','po-renal-dialysis'].some(k=>r[k]);
const pill = (text, color='var(--info)') =>
`<span style="background:${color}22;color:${color};font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;display:inline-block;margin:2px 3px 2px 0">${text}</span>`;
const row = (label, val, warn=false) => val ? `
<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;font-weight:600;color:${warn?'#b91c1c':'var(--text-faint)'};text-transform:uppercase;letter-spacing:.5px;min-width:110px">${label}</span><span style="font-size:13px;color:${warn?'#7f1d1d':'var(--text)'}">${val}</span></div>` : '';
let html = `
<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:14px"><div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);margin-bottom:3px">Surgery Date</div><div style="font-size:14px;font-weight:500">${fmtDate(r['po-surgeryDate'])||'—'}</div></div><div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);margin-bottom:3px">Mallampati</div><div style="font-size:20px;font-weight:500;font-family:'DM Mono',monospace">${r['mallampati']||'—'}</div></div><div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);margin-bottom:3px">Weight / BMI</div><div style="font-size:13px;font-weight:500">${r['po-weight-kg-val']?r['po-weight-kg-val']+'kg':'—'}${r['po-bmi-val']?' · BMI '+r['po-bmi-val']:''}</div></div><div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);margin-bottom:3px">Dentist</div><div style="font-size:13px;font-weight:500">${r['po-provider']||'—'}</div></div></div>`;
// Warnings first
if(r['po-allergies']) html += `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:8px"><span style="font-size:12px;font-weight:700;color:#b91c1c">⚠ ALLERGIES: ${r['po-allergies']}</span></div>`;
if(r['po-iv-difficulty']) html += `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:8px"><span style="font-size:12px;font-weight:600;color:#856404">⚠ Difficult IV${r['po-iv-difficulty-comment']?' — '+r['po-iv-difficulty-comment']:''}</span></div>`;
if(r['po-anesthesia-issues']) html += `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:8px"><span style="font-size:12px;font-weight:600;color:#856404">⚠ Anesthesia issues${r['po-anesthesia-issues-comment']?' — '+r['po-anesthesia-issues-comment']:''}</span></div>`;
if(ekgRequired) html += `<div style="background:#fef3cd;border:1px solid #f59e0b;border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:8px"><span style="font-size:12px;font-weight:600;color:#92400e">⚠ EKG / PCP Order Required</span></div>`;
// Conditions
html += '<div style="margin-top:8px">';
if(cvFlags.length) html += `<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;margin-right:8px">CV</span>${cvFlags.map(f=>pill(f,'var(--warn)')).join('')}</div>`;
if(ekgFlags.length) html += `<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;margin-right:8px">EKG</span>${ekgFlags.map(f=>pill(f,'var(--info)')).join('')}</div>`;
if(pulmFlags.length) html += `<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;margin-right:8px">PULM</span>${pulmFlags.map(f=>pill(f,'#0891b2')).join('')}</div>`;
if(metaFlags.length) html += `<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;margin-right:8px">METABOLIC</span>${metaFlags.map(f=>pill(f,'#d97706')).join('')}</div>`;
if(renalFlags.length) html += `<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;margin-right:8px">RENAL</span>${renalFlags.map(f=>pill(f,'#7c3aed')).join('')}</div>`;
if(neuroFlags.length) html += `<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;margin-right:8px">NEURO</span>${neuroFlags.map(f=>pill(f,'#059669')).join('')}</div>`;
html += '</div>';
// Key info rows
html += '<div style="margin-top:10px">';
// PHI-protected fields are dropped from the summary 3 days post-surgery.
const _contactPhone = _phiVal('po-contact-phone', r['po-contact-phone']);
const _contactType  = _phiVal('po-contact-type',  r['po-contact-type']);
html += row('Contact', _contactPhone ? [_contactType, _contactPhone].filter(Boolean).join(' · ') : null);
html += row('Medications', _phiVal('po-medications', r['po-medications']));
html += row('Allergies', _phiVal('po-allergies', r['po-allergies']), true);
html += row('Surgical Hx', _phiVal('po-surgicalHistory', r['po-surgicalHistory']));
html += row('NPO Notes', _phiVal('po-comments', r['po-comments']));
html += row('Call Date', fmtDate(r['po-callDateTime']?.split('T')[0]));
const _drvName = _phiVal('po-driverName', r['po-driverName']);
const _drvRel  = _phiVal('po-driverRel', r['po-driverRel']);
html += row('Driver', _drvName ? _drvName + (_drvRel?' ('+_drvRel+')':'') : null);
if(_phiHide) {
  html += '<div style="margin-top:10px;padding:8px 12px;background:#f1f5f9;border:1px dashed #cbd5e1;border-radius:8px;font-size:11px;color:#64748b;text-align:center">🔒 Patient contact details (phone, driver, etc.) hidden under HIPAA minimum-necessary. Use the Pre-Op record to reveal.</div>';
}
html += '</div>';
const summary = document.getElementById('finalize-preop-summary');
const summaryContent = document.getElementById('finalize-preop-content');
if(summary && summaryContent) {
summaryContent.innerHTML = html;
summary.style.display = 'block';
window._currentPreopCaseId = r['po-caseId'] || null;
}
// Update case ID display
updateCaseIdDisplays();
}
window.startCaseFromPreop = async function(preopId) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records||[]) : [];
const r = records.find(x => x.id === preopId);
if(!r) { alert('Pre-op record not found.'); return; }
const caseId = r['po-caseId'] || '';
// Check if a draft already exists for this caseId
const existingDraft = cases.find(c => c.draft && c.caseId === caseId);
if(existingDraft) {
  resumeCase(existingDraft.id);
  return;
}
// Create a new draft case from pre-op data
const newDraft = {
  id: uid(),
  caseId,
  procedure: '',
  provider: r['po-provider'] || '',
  date: r['po-surgeryDate'] || todayStr(),
  notes: '',
  caseComments: '',
  worker: r.worker || currentWorker,
  surgeryCenter: r['po-surgery-center'] || '',
  items: [],
  total: 0,
  draft: true,
  imageData: null
};
cases.unshift(newDraft);
await saveCases();
resumeCase(newDraft.id);
} catch(e) {
console.error(e);
alert('Error loading case: ' + e.message);
}
};
// -- BMI CALCULATOR --
window.calcBMI = function() {
const ft = parseFloat(document.getElementById('po-height-ft')?.value) || 0;
const inches = parseFloat(document.getElementById('po-height-in')?.value) || 0;
const lbs = parseFloat(document.getElementById('po-weight-lbs')?.value) || 0;
if(!ft && !inches && !lbs) return;
const totalInches = (ft * 12) + inches;
const cm = Math.round(totalInches * 2.54);
const kg = Math.round(lbs * 0.453592 * 10) / 10;
const heightM = totalInches * 0.0254;
const bmi = heightM > 0 ? Math.round((lbs * 703) / (totalInches * totalInches) * 10) / 10 : 0;
// Update display
const cmEl = document.getElementById('po-height-cm');
const kgEl = document.getElementById('po-weight-kg');
const bmiEl = document.getElementById('po-bmi');
if(cmEl) cmEl.textContent = cm > 0 ? `${cm} cm` : '—';
if(kgEl) kgEl.textContent = kg > 0 ? `${kg} kg` : '—';
if(bmiEl) {
let bmiLabel = '';
let bmiColor = 'var(--text-muted)';
if(bmi > 0) {
if(bmi < 18.5) { bmiLabel = ' (Underweight)'; bmiColor = 'var(--info)'; }
else if(bmi < 25) { bmiLabel = ' (Normal)'; bmiColor = 'var(--accent)'; }
else if(bmi < 30) { bmiLabel = ' (Overweight)'; bmiColor = 'var(--warn)'; }
else { bmiLabel = ' (Obese)'; bmiColor = '#b91c1c'; }
bmiEl.innerHTML = `<span style="color:${bmiColor};font-weight:500">${bmi}${bmiLabel}</span>`;
} else {
bmiEl.textContent = '—';
}
}
// Store values in hidden fields
const cmVal = document.getElementById('po-height-cm-val');
const kgVal = document.getElementById('po-weight-kg-val');
const bmiVal = document.getElementById('po-bmi-val');
if(cmVal) cmVal.value = cm;
if(kgVal) kgVal.value = kg;
if(bmiVal) bmiVal.value = bmi;
};
// -- H&P AUTO-UNCHECK NEG --
window.onHPCheck = function(checkbox, prefix) {
const negEl = document.getElementById(prefix + '-neg');
if(negEl) {
  if(checkbox.id === prefix + '-neg') {
    if(checkbox.checked) {
      document.querySelectorAll(`[id^="${prefix}-"]`).forEach(el => {
        if(el.type === 'checkbox' && el.id !== prefix + '-neg') el.checked = false;
      });
    }
  } else {
    if(checkbox.checked && negEl) negEl.checked = false;
  }
}
// For pupil exam — enforce single selection (radio-like behavior)
const PUPIL_IDS = ['po-pupil-normal','po-pupil-dilated','po-pupil-constricted','po-pupil-other-cb'];
if(PUPIL_IDS.includes(checkbox.id) && checkbox.checked) {
  PUPIL_IDS.forEach(id => {
    if(id !== checkbox.id) {
      const el = document.getElementById(id);
      if(el) el.checked = false;
    }
  });
  // Hide other-row if non-other selected
  const otherRow = document.getElementById('po-pupil-other-row');
  const otherVal = document.getElementById('po-pupil-other-val');
  if(checkbox.id !== 'po-pupil-other-cb' && otherRow) {
    otherRow.style.display = 'none';
    if(otherVal) otherVal.value = '';
  }
}
// Trigger EKG check in case a CV condition changed
if(typeof checkEKGConditions === 'function') checkEKGConditions();
};
// -- CS PROVIDER SIGNATURE --
let csProviderEntryIdx = null;
let csProviderDrawing = false;
window.openCSProviderModal = function(idx) {
csProviderEntryIdx = idx;
document.getElementById('csProviderModal').style.display = 'flex';
clearCSProviderCanvas();
setupCSProviderCanvas();
};
window.closeCSProviderModal = function() {
document.getElementById('csProviderModal').style.display = 'none';
csProviderEntryIdx = null;
};
function setupCSProviderCanvas() {
const canvas = document.getElementById('csProviderCanvas');
const ctx = canvas.getContext('2d');
ctx.strokeStyle = '#1d3557'; ctx.lineWidth = 2.5;
ctx.lineCap = 'round'; ctx.lineJoin = 'round';
function getPos(e) {
const rect = canvas.getBoundingClientRect();
const scaleX = canvas.width/rect.width; const scaleY = canvas.height/rect.height;
const src = e.touches?e.touches[0]:e;
return {x:(src.clientX-rect.left)*scaleX, y:(src.clientY-rect.top)*scaleY};
}
canvas.onmousedown = canvas.ontouchstart = function(e) {
e.preventDefault(); csProviderDrawing=true;
const p=getPos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y);
};
canvas.onmousemove = canvas.ontouchmove = function(e) {
e.preventDefault(); if(!csProviderDrawing) return;
const p=getPos(e); ctx.lineTo(p.x,p.y); ctx.stroke();
};
canvas.onmouseup = canvas.ontouchend = function(e) { e.preventDefault(); csProviderDrawing=false; };
}
window.clearCSProviderCanvas = function() {
const canvas = document.getElementById('csProviderCanvas');
if(canvas) canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
};
window.saveCSProviderSig = function() {
const canvas = document.getElementById('csProviderCanvas');
const sigData = canvas.toDataURL('image/png');
if(csProviderEntryIdx !== null) {
csEntries[csProviderEntryIdx].providerSignature = sigData;
renderCSEntries();
}
closeCSProviderModal();
};
// -- PROVIDER SIGNATURE --
let providerSigDrawing = false;
window.openProviderSigModal = function() {
document.getElementById('providerSigModal').style.display = 'flex';
clearProviderSigCanvas();
setupProviderSigCanvas();
};
window.closeProviderSigModal = function() {
document.getElementById('providerSigModal').style.display = 'none';
};
function setupProviderSigCanvas() {
const canvas = document.getElementById('providerSigCanvas');
const ctx = canvas.getContext('2d');
ctx.strokeStyle = '#1d3557';
ctx.lineWidth = 2.5;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
function getPos(e) {
const rect = canvas.getBoundingClientRect();
const scaleX = canvas.width / rect.width;
const scaleY = canvas.height / rect.height;
const src = e.touches ? e.touches[0] : e;
return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
}
canvas.onmousedown = canvas.ontouchstart = function(e) {
e.preventDefault(); providerSigDrawing = true;
const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
};
canvas.onmousemove = canvas.ontouchmove = function(e) {
e.preventDefault(); if(!providerSigDrawing) return;
const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke();
};
canvas.onmouseup = canvas.ontouchend = function(e) { e.preventDefault(); providerSigDrawing = false; };
}
window.clearProviderSigCanvas = function() {
const canvas = document.getElementById('providerSigCanvas');
if(canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
};
window.saveProviderSig = function() {
const canvas = document.getElementById('providerSigCanvas');
const sigData = canvas.toDataURL('image/png');
document.getElementById('po-providerSignature').value = sigData;
document.getElementById('providerSigPreview').style.display = 'block';
document.getElementById('providerSigImg').src = sigData;
document.getElementById('providerSigZone').style.display = 'none';
closeProviderSigModal();
};
window.clearProviderSig = function() {
document.getElementById('po-providerSignature').value = '';
document.getElementById('providerSigPreview').style.display = 'none';
document.getElementById('providerSigZone').style.display = 'block';
document.getElementById('providerSigImg').src = '';
};
// -- OTHER TOGGLE IN PRE-OP H&P --
window.onHPOtherToggle = function(prefix) {
const cb = document.getElementById(prefix + '-other-cb');
const row = document.getElementById(prefix + '-other-row');
if(!row) return;
if(cb && cb.checked) {
row.style.display = 'block';
// Uncheck NEG if other is checked
const neg = document.getElementById(prefix + '-neg');
if(neg) neg.checked = false;
} else {
row.style.display = 'none';
const val = document.getElementById(prefix + '-other-val');
if(val) val.value = '';
}
};
// -- OTHER TOGGLE IN PRE-OP --
window.onOtherToggle = function(checkbox) {
const row = document.getElementById('po-other-other-row');
if(row) row.style.display = checkbox.checked ? 'block' : 'none';
if(!checkbox.checked) {
const commentEl = document.getElementById('po-other-other-comment');
if(commentEl) commentEl.value = '';
}
};
// -- PREVIEW DRAFT --
window.previewDraft = async function(id) {
try {
// Use cached records if available, otherwise fetch
let records = window._rawPreopRecords || [];
if(!records.length || !records.find(x => x.id === id)) {
const snap = await getDoc(doc(db,'atlas','preop'));
records = snap.exists() ? (snap.data().records||[]) : [];
window._rawPreopRecords = records;
}
const r = records.find(x => x.id === id);
if(!r) { alert('Record not found.'); return; }
document.getElementById('preview-title').textContent = r['po-caseId'] || 'Draft';
document.getElementById('preview-subtitle').textContent =
`Surgery: ${fmtDate(r['po-surgeryDate'])||'—'} · Dentist: ${r['po-provider']||'—'}`;
// Build condition flags
const cvFlags = ['htn','cad','angina','mi','chf','murmur','arrythmia'].filter(x=>r['po-cv-'+x]).map(x=>x.toUpperCase());
const ekgFlags = ['nsr','afib','bbb','lvh','chngs'].filter(x=>r['po-ekg-'+x]).map(x=>x.toUpperCase());
const pulmFlags = ['asthma','copd','uri','o2','cpap','sleep-apnea','smoker'].filter(x=>r['po-pulm-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const gastroFlags = ['gerd','hiat-hern','ulcer'].filter(x=>r['po-gastro-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const renalFlags = ['dialysis','esrd'].filter(x=>r['po-renal-'+x]).map(x=>x.toUpperCase());
const neuroFlags = ['depression','anxiety-disorder','seizures','cva','nm-disease'].filter(x=>r['po-neuro-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const metaFlags = ['iddm','niddm','thyroid','hx-hep','obesity','morbid-obesity'].filter(x=>r['po-meta-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const teethFlags = ['intact','missing','denture'].filter(x=>r['po-teeth-'+x]).map(x=>x.toUpperCase());
const otherFlags = ['hiv','hep-c','anemia','steroids','cancers','drug-abuse','coagulopathy','chemotherapy'].filter(x=>r['po-other-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
// EKG required check
const ekgConditions = ['po-cv-htn','po-cv-cad','po-cv-angina','po-cv-mi','po-cv-chf','po-cv-murmur',
'po-cv-arrythmia','po-ekg-afib','po-ekg-bbb','po-ekg-lvh','po-ekg-chngs',
'po-neuro-cva','po-meta-iddm','po-meta-niddm','po-renal-dialysis','po-renal-esrd'];
const ekgRequired = ekgConditions.some(k => r[k]);
const makePill = (text, color='var(--info)') =>
`<span style="background:${color}22;color:${color};font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;display:inline-block;margin:2px 3px 2px 0">${text}</span>`;
const makeSection = (title, content) => content ? `
<div style="margin-bottom:14px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);margin-bottom:6px">${title}</div>
${content}
</div>` : '';
const html = `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px"><div style="padding:10px 14px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);margin-bottom:4px">Surgery Date</div><div style="font-size:15px;font-weight:500">${fmtDate(r['po-surgeryDate'])||'—'}</div></div><div style="padding:10px 14px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);margin-bottom:4px">Mallampati</div><div style="font-size:22px;font-weight:500;font-family:'DM Mono',monospace">${r['mallampati']||'—'}</div></div><div style="padding:10px 14px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);margin-bottom:4px">Invoice Email</div><div style="font-size:13px;font-family:'DM Mono',monospace">${r['po-patientEmail']||'—'}</div></div><div style="padding:10px 14px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);margin-bottom:4px">BMI</div><div style="font-size:15px;font-weight:500">${r['po-bmi-val']||'—'}${r['po-weight-kg-val']?' · '+r['po-weight-kg-val']+'kg':''}</div></div></div>
${ekgRequired ? `<div style="background:#fef3cd;border:1.5px solid #f59e0b;border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:16px"><span style="font-size:13px;font-weight:600;color:#92400e">⚠ EKG / PCP Order Required</span></div>` : ''}
${r['po-allergies'] ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:16px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#b91c1c;margin-bottom:4px">⚠ Allergies</div><div style="font-size:13px;color:#7f1d1d">${r['po-allergies']}</div></div>` : ''}
${r['po-iv-difficulty'] ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:var(--radius-sm);padding:8px 14px;margin-bottom:16px"><span style="font-size:13px;font-weight:600;color:#856404">⚠ History of difficult IV placement${r['po-iv-difficulty-comment']?' — '+r['po-iv-difficulty-comment']:''}</span></div>` : ''}
${r['po-anesthesia-issues'] ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:var(--radius-sm);padding:8px 14px;margin-bottom:16px"><span style="font-size:13px;font-weight:600;color:#856404">⚠ Previous anesthesia issues${r['po-anesthesia-issues-comment']?' — '+r['po-anesthesia-issues-comment']:''}</span></div>` : ''}
${makeSection('Cardiovascular', cvFlags.length ? cvFlags.map(f=>makePill(f,'var(--warn)')).join('')+(r['po-cv-comment']?`<div style="font-size:12px;color:var(--text-faint);margin-top:4px">${r['po-cv-comment']}</div>`:'') : '')}
${makeSection('EKG', ekgFlags.length ? ekgFlags.map(f=>makePill(f,'var(--info)')).join('')+(r['po-ekg-comment']?`<div style="font-size:12px;color:var(--text-faint);margin-top:4px">${r['po-ekg-comment']}</div>`:'') : '')}
${makeSection('Pulmonary', pulmFlags.length ? pulmFlags.map(f=>makePill(f,'#0891b2')).join('')+(r['po-pulm-comment']?`<div style="font-size:12px;color:var(--text-faint);margin-top:4px">${r['po-pulm-comment']}</div>`:'') : '')}
${makeSection('Renal', renalFlags.length ? renalFlags.map(f=>makePill(f,'#7c3aed')).join('') : '')}
${makeSection('Neuro', neuroFlags.length ? neuroFlags.map(f=>makePill(f,'#059669')).join('') : '')}
${makeSection('Metabolic', metaFlags.length ? metaFlags.map(f=>makePill(f,'#d97706')).join('') : '')}
${makeSection('Gastro', gastroFlags.length ? gastroFlags.map(f=>makePill(f)).join('') : '')}
${makeSection('Teeth', teethFlags.length ? teethFlags.map(f=>makePill(f)).join('') : '')}
${makeSection('Other Conditions', otherFlags.length ? otherFlags.map(f=>makePill(f,'#6b6860')).join('') : '')}
${makeSection('Medications', r['po-medications'] ? `<div style="font-size:13px">${r['po-medications']}</div>` : '')}
${makeSection('Surgical History', r['po-surgicalHistory'] ? `<div style="font-size:13px">${r['po-surgicalHistory']}</div>` : '')}
${makeSection('NPO / Pre-Op Call Notes', r['po-comments'] ? `<div style="font-size:13px">${r['po-comments']}</div>` : '')}
`;
document.getElementById('previewModalContent').innerHTML = html;
document.getElementById('previewModal').style.display = 'flex';
} catch(e) {
alert('Error loading preview: ' + e.message);
console.error(e);
}
};
window.toggleTomorrowActions = function(id) {
  const all = document.querySelectorAll('[id^="tomorrow-actions-"]');
  all.forEach(el => { if(el.id !== 'tomorrow-actions-'+id) el.style.display = 'none'; });
  const menu = document.getElementById('tomorrow-actions-'+id);
  if(menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
};
document.addEventListener('click', function(e) {
  if(!e.target.closest('[id^="tomorrow-actions-"]') && !e.target.closest('button[onclick*="toggleTomorrowActions"]')) {
    document.querySelectorAll('[id^="tomorrow-actions-"]').forEach(el => el.style.display = 'none');
  }
});
window.loadDraftCaseById = function(caseId) {
  const draft = cases.find(c => c.caseId === caseId && c.draft);
  if(draft) { loadDraftCase(draft.id); showTab('new-case'); }
  else { showTab('new-case'); }
};
window.closePreviewModal = function() {
document.getElementById('previewModal').style.display = 'none';
};
// -- REVIEW FOR TOMORROW --
async function renderReviewTomorrow() {
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const tomorrowStr = localDateStr(tomorrow);
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records||[]) : [];
const tomorrowCases = records.filter(r => r['po-surgeryDate'] === tomorrowStr && (r.worker || 'dev') === currentWorker);
const section = document.getElementById('review-tomorrow-section');
const list = document.getElementById('review-tomorrow-list');
if(!section || !list) return;
if(!tomorrowCases.length) {
section.style.display = 'none';
return;
}
section.style.display = 'block';
list.innerHTML = tomorrowCases.map(r => {
const pill = r.worker==='dev'?'pill-dev':'pill-josh';
const wname = r.worker==='dev'?'Devarsh':'Josh';
const cvFlags = ['htn','cad','angina','mi','chf','murmur','arrythmia'].filter(x=>r['po-cv-'+x]).map(x=>x.toUpperCase());
const pulmFlags = ['asthma','copd','uri','cpap','sleep-apnea'].filter(x=>r['po-pulm-'+x]).map(x=>x.toUpperCase().replace(/-/g,' '));
const allFlags = [...cvFlags,...pulmFlags];
const ekgRequired = ['po-cv-htn','po-cv-cad','po-cv-mi','po-cv-chf','po-cv-arrythmia','po-ekg-afib',
'po-neuro-cva','po-meta-iddm','po-meta-niddm','po-renal-dialysis'].some(k=>r[k]);
return `<div style="background:var(--surface);border:2px solid var(--warn);border-radius:var(--radius-sm);padding:16px 18px;margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px"><div><div style="font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px">
${r['po-caseId']||'—'}
<span class="worker-pill ${pill}" style="font-size:10px">${wname}</span></div><div style="font-size:12px;color:var(--text-faint);margin-top:2px">
Tomorrow · ${r['po-provider']||'—'}
${r['mallampati']?` · Mallampati ${r['mallampati']}`:''}
</div>
${r['po-allergies']?`<div style="margin-top:6px;font-size:12px;font-weight:600;color:#b91c1c">⚠ Allergies: ${r['po-allergies']}</div>`:''}
${r['po-iv-difficulty']?`<div style="margin-top:4px;font-size:12px;color:var(--warn)">⚠ Difficult IV${r['po-iv-difficulty-comment']?' — '+r['po-iv-difficulty-comment']:''}</div>`:''}
${ekgRequired?`<div style="margin-top:4px;font-size:12px;color:var(--warn)">⚠ EKG Required</div>`:''}
${allFlags.length?`<div style="margin-top:6px">${allFlags.map(f=>`<span style="background:var(--warn-light);color:var(--warn);font-size:10px;font-weight:600;padding:1px 7px;border-radius:10px;margin-right:4px">${f}</span>`).join('')}</div>`:''}
${r['po-medications']?`<div style="margin-top:6px;font-size:12px;color:var(--text-muted)"><strong>Meds:</strong> ${r['po-medications']}</div>`:''}
</div><div style="display:flex;gap:6px;align-items:center"><button onclick="previewDraft('${r.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">👁 Preview</button><div style="position:relative;display:inline-block"><button onclick="toggleTomorrowActions('${r.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">Actions ▾</button><div id="tomorrow-actions-${r.id}" style="display:none;position:absolute;right:0;top:100%;margin-top:4px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:0 4px 12px rgba(0,0,0,.12);z-index:100;min-width:160px"><button onclick="editPreopRecord('${r.id}');toggleTomorrowActions('${r.id}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--text);font-family:inherit" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='none'">✏ Edit Pre-Op</button>${window._userRole === 'assistant' ? '' : `<button onclick="loadDraftCaseById('${r['po-caseId']}');toggleTomorrowActions('${r.id}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:var(--text);font-family:inherit" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='none'">✓ Finalize Case</button>`}<div style="border-top:1px solid var(--border);margin:4px 0"></div><button onclick="deletePreopRecord('${r.id}');toggleTomorrowActions('${r.id}')" style="display:block;width:100%;text-align:left;padding:9px 14px;font-size:13px;background:none;border:none;cursor:pointer;color:#dc2626;font-family:inherit" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='none'">🗑 Delete</button></div></div></div></div></div>`;
}).join('');
} catch(e) { console.error(e); }
}
// -- SYNC PRICES FROM TEMPLATE --
window.syncPricesFromTemplate = async function() {
const confirmed = confirm(
'This will:\n\n' +
'• Update all unit prices to the latest values\n' +
'• Add any new items that are missing\n\n' +
'Stock counts will NOT be changed.\n\nContinue?'
);
if(!confirmed) return;
let priceUpdates = 0;
let newItems = 0;
ITEM_TEMPLATE.forEach(template => {
const existing = items.find(i => i.id === template.id);
if(existing) {
// Only update price
if(existing.costPerUnit !== template.costPerUnit) {
if(!existing.priceHistory) existing.priceHistory = [];
existing.priceHistory.unshift({
date: todayStr(),
oldCost: existing.costPerUnit,
newCost: template.costPerUnit,
changedBy: 'template-sync'
});
existing.costPerUnit = template.costPerUnit;
priceUpdates++;
}
// Always sync category from template
if(template.category && existing.category !== template.category) {
existing.category = template.category;
priceUpdates++;
}
} else {
// New item — add with stock at 0
items.push({...template, stockDev: 0, stockJosh: 0});
newItems++;
}
});
try {
setSyncing(true);
await saveInventory();
setSyncing(false);
renderInventory();
refreshItemSelect();
alert(
`✓ Sync complete!\n\n` +
`• ${priceUpdates} price${priceUpdates !== 1 ? 's' : ''} updated\n` +
`• ${newItems} new item${newItems !== 1 ? 's' : ''} added\n\n` +
`Stock counts were not changed.`
);
} catch(e) {
setSyncing(false);
alert('Error saving: ' + e.message);
console.error(e);
}
};
// -- SURGERY CENTERS --
let surgeryCenters = []; // loaded from Firebase
window.surgeryCenters = surgeryCenters;
async function loadSurgeryCenters() {
try {
const snap = await getDoc(doc(db,'atlas','surgerycenters'));
surgeryCenters = snap.exists() ? (snap.data().centers || []) : [];
window.surgeryCenters = surgeryCenters;
} catch(e) { console.warn('loadSurgeryCenters:', e); surgeryCenters = []; window.surgeryCenters = []; }
populateCenterDropdowns();
renderSurgeryCenters();
}
async function saveSurgeryCenters() {
await setDoc(doc(db,'atlas','surgerycenters'), { centers: surgeryCenters });
}
function populateCenterDropdowns() {
window.surgeryCenters = surgeryCenters;
// Pre-Op dropdown
const sel = document.getElementById('po-surgery-center');
if(sel) {
const cur = sel.value;
sel.innerHTML = '<option value="">— Select surgery center —</option>' +
surgeryCenters.map(c => `<option value="${c.id}"${cur===c.id?' selected':''}>${c.name}</option>`).join('');
}
// Invoice dropdown
const invSel = document.getElementById('inv-location-select');
if(invSel) {
const cur = invSel.value;
invSel.innerHTML = '<option value="">— Select a surgery center —</option>' +
surgeryCenters.map(c => `<option value="${c.id}"${cur===c.id?' selected':''}>${c.name}</option>`).join('');
}
}
window.onPreopCenterChange = function() {
const sel = document.getElementById('po-surgery-center');
if(!sel || !sel.value) return;
const center = surgeryCenters.find(c => c.id === sel.value);
if(!center) return;
const providerEl = document.getElementById('po-provider');
const emailEl = document.getElementById('po-patientEmail');
const addressEl = document.getElementById('po-officeAddress');
if(providerEl && !providerEl.value && center.provider) providerEl.value = center.provider;
if(emailEl && !emailEl.value && center.invoiceEmail) emailEl.value = center.invoiceEmail;
// Auto-fill the Dentist Office Address from the surgery center's address.
// This field flows into the Insurance Sheet modal (and any future modal that
// reads po-officeAddress), so the address propagates everywhere it's needed.
if(addressEl && !addressEl.value && center.address) addressEl.value = center.address;
};
window.onInvoiceCenterChange = function() {
  var sel=document.getElementById('inv-location-select');
  var locInput=document.getElementById('inv-location');
  var fhInput=document.getElementById('inv-first-hour');
  var p15Input=document.getElementById('inv-per-15');
  if(!sel) return;
  var val=sel.value;
  var center=(window.surgeryCenters||surgeryCenters||[]).find(function(c){return c.id===val;});

  if(val==='__custom__'){
    // Custom: show location name input for BOTH billing types
    if(locInput){locInput.style.display='';locInput.value='';setTimeout(function(){locInput.focus();},50);}
    if(fhInput) fhInput.value='';
    if(p15Input) p15Input.value='';
    // Show custom procedure/amount fields if flat rate is active
    var bt=window._billingType||'hourly';
    if(bt==='flat'){
      var knownDiv=document.getElementById('inv-flat-known');
      var customDiv=document.getElementById('inv-flat-custom');
      if(knownDiv) knownDiv.style.display='none';
      if(customDiv) customDiv.style.display='';
      var tt=document.getElementById('inv-rate-card-title');
      if(tt) tt.textContent='Custom Flat Rate';
      var rowsEl=document.getElementById('inv-flat-rate-rows');
      if(rowsEl) rowsEl.innerHTML='<div style="padding:16px;font-size:13px;color:var(--text-faint);text-align:center;font-style:italic">Enter procedure and rate on the left → summary updates automatically</div>';
    }
  } else if(center){
    if(locInput){locInput.value=center.name;locInput.style.display='none';}
    if(fhInput) fhInput.value=center.firstHour.toFixed(2);
    if(p15Input) p15Input.value=center.per15.toFixed(2);
    if(window._billingType==='flat'){_refreshFlatRatePanel();populateFlatRateDropdown();}
    else{calculateInvoice();}
  } else {
    if(locInput){locInput.value='';locInput.style.display='none';}
    if(fhInput) fhInput.value='';
    if(p15Input) p15Input.value='';
    var tt2=document.getElementById('inv-rate-card-title');
    if(tt2) tt2.textContent=window._billingType==='flat'?'Flat Rates':'Rate Information';
  }
};;
window.onSurgeryCenterChange = function() {
updateDraftInvoicePreview();
const sel = document.getElementById('po-surgery-center');
if(!sel) return;
const center = surgeryCenters.find(c => c.id === sel.value);
if(center) {
// Auto-fill provider if center has one
if(center.provider) {
const provEl = document.getElementById('po-provider');
if(provEl && !provEl.value) provEl.value = center.provider;
}
// Auto-fill invoice email if center has one
if(center.invoiceEmail) {
const emailEl = document.getElementById('po-patientEmail');
if(emailEl && !emailEl.value) emailEl.value = center.invoiceEmail;
}
// Auto-fill office address if center has one
if(center.address) {
const addrEl = document.getElementById('po-officeAddress');
if(addrEl && !addrEl.value) addrEl.value = center.address;
}
}
};
window.showAddCenterForm = function() {
  window._editingCenterId = null;
  window._editingFlatRates = [];
  if(document.getElementById('sc-name')) document.getElementById('sc-name').value = '';
  if(document.getElementById('sc-first-hour')) document.getElementById('sc-first-hour').value = '';
  if(document.getElementById('sc-per-15')) document.getElementById('sc-per-15').value = '';
  if(document.getElementById('sc-provider')) document.getElementById('sc-provider').value = '';
  if(document.getElementById('sc-invoice-email')) document.getElementById('sc-invoice-email').value = '';
  if(document.getElementById('sc-address')) document.getElementById('sc-address').value = '';
  if(document.getElementById('sc-fr-proc')) document.getElementById('sc-fr-proc').value = '';
  if(document.getElementById('sc-fr-amt')) document.getElementById('sc-fr-amt').value = '';
  document.getElementById('add-center-form').style.display = 'block';
  renderFlatRatesInForm();
};
window.hideAddCenterForm = function() {
document.getElementById('add-center-form').style.display = 'none';
['sc-name','sc-first-hour','sc-per-15','sc-provider','sc-invoice-email','sc-address'].forEach(id => {
const el = document.getElementById(id);
if(el) el.value = '';
});
window._editingCenterId = null;
};
window.saveCenter = async function() {
  const name = document.getElementById('sc-name')?.value.trim();
  const firstHour = parseFloat(document.getElementById('sc-first-hour')?.value) || 0;
  const per15 = parseFloat(document.getElementById('sc-per-15')?.value) || 0;
  if(!name) { alert('Please enter a surgery center name.'); return; }
  const provider = document.getElementById('sc-provider')?.value.trim() || '';
  const invoiceEmail = document.getElementById('sc-invoice-email')?.value.trim() || '';
  const faxNumber = document.getElementById('sc-fax-number')?.value.trim() || '';
  const address = document.getElementById('sc-address')?.value.trim() || '';
  const billingType = document.querySelector('input[name="sc-billing-type"]:checked')?.value || 'patient';
  const hasJosh = document.getElementById('sc-worker-josh')?.checked || false;
  const hasDev  = document.getElementById('sc-worker-dev')?.checked  || false;
  // Grab flat rates from the in-memory editing array
  const flatRates = window._editingFlatRates || [];
  if(window._editingCenterId) {
    const idx = surgeryCenters.findIndex(c => c.id === window._editingCenterId);
    if(idx !== -1) surgeryCenters[idx] = { ...surgeryCenters[idx], name, firstHour, per15, provider, invoiceEmail, faxNumber, address, flatRates, billingType, hasJosh, hasDev };
  } else {
    surgeryCenters.push({ id: uid(), name, firstHour, per15, provider, invoiceEmail, faxNumber, address, flatRates, billingType, hasJosh, hasDev });
  }
  setSyncing(true);
  await saveSurgeryCenters();
  setSyncing(false);
  window._editingFlatRates = [];
  window._editingCenterId = null;
  hideAddCenterForm();
  renderSurgeryCenters();
  populateCenterDropdowns();
  renderAnalytics();
};
window.editCenter = function(id) {
  const c = surgeryCenters.find(x => x.id === id);
  if(!c) return;
  window._editingCenterId = id;
  // Deep copy flat rates so edits don't mutate live data until saved
  window._editingFlatRates = JSON.parse(JSON.stringify(c.flatRates || []));
  document.getElementById('sc-name').value = c.name;
  document.getElementById('sc-first-hour').value = c.firstHour;
  document.getElementById('sc-per-15').value = c.per15;
  document.getElementById('sc-provider').value = c.provider || '';
  document.getElementById('sc-invoice-email').value = c.invoiceEmail || '';
  document.getElementById('sc-fax-number') && (document.getElementById('sc-fax-number').value = c.faxNumber || '');
  document.getElementById('sc-address') && (document.getElementById('sc-address').value = c.address || '');
  const billingRadio = document.querySelector(`input[name="sc-billing-type"][value="${c.billingType||'patient'}"]`);
  if(billingRadio) billingRadio.checked = true;
  const joshBox = document.getElementById('sc-worker-josh'); if(joshBox) joshBox.checked = !!c.hasJosh;
  const devBox  = document.getElementById('sc-worker-dev');  if(devBox)  devBox.checked  = !!c.hasDev;
  if(document.getElementById('sc-fr-proc')) document.getElementById('sc-fr-proc').value = '';
  if(document.getElementById('sc-fr-amt')) document.getElementById('sc-fr-amt').value = '';
  document.getElementById('add-center-form').style.display = 'block';
  document.getElementById('add-center-form').scrollIntoView({ behavior:'smooth' });
  renderFlatRatesInForm();
};
window.deleteCenter = async function(id) {
const c = surgeryCenters.find(x => x.id === id);
if(!confirm(`Delete "${c?.name}"?`)) return;
surgeryCenters = surgeryCenters.filter(x => x.id !== id);
setSyncing(true);
await saveSurgeryCenters();
setSyncing(false);
renderSurgeryCenters();
populateCenterDropdowns();
renderAnalytics();
};
function renderSurgeryCenters() {
const el = document.getElementById('surgery-centers-list');
if(!el) return;
if(!surgeryCenters.length) {
el.innerHTML = '<div class="empty-state">No surgery centers added yet</div>';
return;
}
el.innerHTML = `
<div style="display:grid;grid-template-columns:1fr 120px 120px 80px;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint)"><span>Center Name</span><span>1st Hour</span><span>Per 15-min</span><span></span></div>
${surgeryCenters.map(c => {
  const frs = c.flatRates||[];
  const frBadge = frs.length ? `<span style="background:var(--accent-light);color:var(--accent);font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:8px">${frs.length} flat rate${frs.length>1?'s':''}</span>` : '';
  const billingBadge = c.billingType==='center'
    ? `<span style="background:#dcfce7;color:#166534;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:8px">Center Pays</span>`
    : `<span style="background:#e0f2fe;color:#0369a1;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:8px">Patient Pays</span>`;
  const hasJosh = c.hasJosh || c.workers?.includes('josh');
  const hasDev  = c.hasDev  || c.workers?.includes('dev');
  const workerBadges = [
    hasJosh ? `<span style="background:#fff3e0;color:#e65100;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:4px">Josh</span>` : '',
    hasDev  ? `<span style="background:#e8f5e9;color:#2e7d32;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:4px">Dev</span>`  : ''
  ].join('');
  return `<div style="display:grid;grid-template-columns:1fr 120px 120px 80px;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);align-items:center"><div><div style="font-size:14px;font-weight:500;display:flex;align-items:center">${c.name}${frBadge}${billingBadge}${workerBadges}</div>
${c.provider?`<div style="font-size:11px;color:var(--text-faint)">👤 ${c.provider}</div>`:''}
${c.invoiceEmail?`<div style="font-size:11px;color:var(--text-faint);font-family:'DM Mono',monospace">📧 ${c.invoiceEmail}</div>`:''}
${c.address?`<div style="font-size:11px;color:var(--text-faint)">📍 ${c.address}</div>`:''}
</div><div style="font-size:14px;font-family:'DM Mono',monospace">$${c.firstHour.toFixed(2)}</div><div style="font-size:14px;font-family:'DM Mono',monospace">$${c.per15.toFixed(2)}</div><div style="display:flex;gap:6px"><button onclick="editCenter('${c.id}')" class="btn btn-ghost btn-sm" style="font-size:11px">✏ Edit</button><button onclick="deleteCenter('${c.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">🗑</button></div></div>`;
}).join('')}`;
}
// -- ANALYTICS --
let analyticsFilter = 'all';
window.setAnalyticsFilter = function(f) {
analyticsFilter = f;
['all','dev','josh'].forEach(x => {
const btn = document.getElementById('abtn-'+x);
if(!btn) return;
btn.style.background = x===f ? (x==='dev'?'var(--dev)':x==='josh'?'var(--josh)':'var(--info)') : 'transparent';
btn.style.color = x===f ? '#fff' : 'var(--text-muted)';
});
renderAnalytics();
};
function estimateIncome(c) {
// Find surgery center from case or linked preop
const centerId = c.surgeryCenter || (window._rawPreopRecords||[]).find(r=>r['po-caseId']===c.caseId)?.['po-surgery-center'] || '';
const center = surgeryCenters.find(sc => sc.id === centerId);
if(!center) return null;
// Use actual hours, durationMins, or pre-op estimated hours
let hrs = 0;
if(c.startTime && c.endTime) {
const [sh,sm] = c.startTime.split(':').map(Number);
const [eh,em] = c.endTime.split(':').map(Number);
hrs = Math.max(0, ((eh*60+em)-(sh*60+sm))/60);
} else if(c.durationMins) {
hrs = c.durationMins / 60;
} else {
const preop = (window._rawPreopRecords||[]).find(r=>r['po-caseId']===c.caseId);
hrs = parseFloat(preop?.['po-est-hours']) || 0;
}
if(!hrs) return null;
const mins = hrs * 60;
const extraMins = Math.max(0, mins - 60);
const extra15 = Math.ceil(extraMins / 15);
return center.firstHour + (extra15 * center.per15);
}
function getCenterName(centerId) {
return surgeryCenters.find(c => c.id === centerId)?.name || '—';
}
window.renderAnalytics = function() {
const yearSel = document.getElementById('analytics-year');
const today = todayStr();
const allInvoices = window._savedInvoices || [];
const preops = window._rawPreopRecords || [];
// Collect all years from finalized cases + upcoming preops
const finalized = (cases||[]).filter(c => !c.draft && c.date);
const allYears = [...new Set([
...finalized.map(c=>c.date.substring(0,4)),
...preops.filter(r=>r['po-surgeryDate']>today).map(r=>(r['po-surgeryDate']||'').substring(0,4))
].filter(Boolean))].sort().reverse();
if(!allYears.length) allYears.push(new Date().getFullYear().toString());
if(yearSel) {
const curYear = yearSel.value || new Date().getFullYear().toString();
yearSel.innerHTML = allYears.map(y=>`<option value="${y}"${y===curYear?' selected':''}>${y}</option>`).join('');
}
const selectedYear = yearSel?.value || new Date().getFullYear().toString();
const filtered = analyticsFilter === 'all' ? finalized : finalized.filter(c=>c.worker===analyticsFilter);
const yearCases = filtered.filter(c => c.date.startsWith(selectedYear));
// Upcoming preops for selected year (not yet finalized)
const finalizedCaseIds = new Set(finalized.map(c=>c.caseId));
const upcomingPreops = preops.filter(r => {
const d = r['po-surgeryDate']||'';
if(!d.startsWith(selectedYear)) return false;
if(d <= today) return false;
if(analyticsFilter !== 'all' && r.worker !== analyticsFilter) return false;
// exclude if already finalized
return !finalizedCaseIds.has(r['po-caseId']);
});
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// -- Helpers --
const uniqueDays = arr => new Set(arr.map(c=>c.date)).size;
// Actual hours from finalize case start/end
const calcHours = arr => arr.reduce((s,c)=>{
if(!c.startTime||!c.endTime) return s;
const [sh,sm]=c.startTime.split(':').map(Number);
const [eh,em]=c.endTime.split(':').map(Number);
return s+Math.max(0,((eh*60+em)-(sh*60+sm))/60);
},0);
// Projected pay: pre-op est hours × $600
const calcProjPay = arr => arr.reduce((s,c)=>{
const preop=preops.find(r=>r['po-caseId']===c.caseId);
const estHrs=parseFloat(preop?.['po-est-hours'])||0;
return s+estHrs*600;
},0);
// My Pay: actual hours × surgery center rates (estimateIncome uses start/end time)
const calcMyPay = arr => arr.reduce((s,c)=>{
const pay = estimateIncome(c);
return s+(pay||0);
},0);
// Invoiced: sum of invoices by month+worker (not by case linkage — invoices may not be linked to a case)
// This function takes a month index (0-11) and year string
const sumInvoicesByMonth = (monthIdx, yearStr) => {
const worker = analyticsFilter; // 'all', 'dev', or 'josh'
return allInvoices
.filter(inv => {
// Match by date
const d = inv.rawDate || '';
const parts = d.split('-');
if(parts.length < 2) return false;
if(parts[0] !== yearStr) return false;
if(parseInt(parts[1])-1 !== monthIdx) return false;
// Match by worker — use inv.worker if set, otherwise infer from provider name
if(worker !== 'all') {
if(inv.worker) {
if(inv.worker !== worker) return false;
} else {
// Fallback: infer from provider field
const prov = (inv.provider || '').toLowerCase();
const isJosh = prov.includes('josh') || prov.includes('condado');
const isDev = prov.includes('devarsh') || prov.includes('murthy');
if(worker === 'josh' && !isJosh) return false;
if(worker === 'dev' && !isDev) return false;
}
}
return true;
})
.reduce((s,inv)=>s+(parseFloat(inv.total)||0),0);
};
// Keep old sumInvoices for compatibility (used for per-case linkage elsewhere)
const sumInvoices = arr => arr.reduce((s,c)=>{
const inv=allInvoices.find(i=>i.linkedCaseId===c.caseId);
return s+(inv?parseFloat(inv.total)||0:0);
},0);
// Supply cost: sum of case totals
const calcSupply = arr => arr.reduce((s,c)=>s+(parseFloat(c.total)||0),0);
// Projected pay for upcoming preops: est hours × $600
const upcomingProjPay = arr => arr.reduce((s,r)=>{
return s+(parseFloat(r['po-est-hours'])||0)*600;
},0);
// Group finalized cases by month
const byMonth = {};
for(let m=0;m<12;m++) byMonth[m]=[];
yearCases.forEach(c=>{const m=parseInt(c.date.split('-')[1])-1; if(m>=0&&m<12) byMonth[m].push(c);});
// Group upcoming preops by month
const upcomingByMonth = {};
for(let m=0;m<12;m++) upcomingByMonth[m]=[];
upcomingPreops.forEach(r=>{
const d=r['po-surgeryDate']||'';
const m=parseInt(d.split('-')[1])-1;
if(m>=0&&m<12) upcomingByMonth[m].push(r);
});
const monthEl = document.getElementById('analytics-monthly');
if(!monthEl) return;
// Columns: Month | Cases | Days | Hrs | Proj.Pay | My Pay | Invoiced | Atlas Takeaway
const cols = '90px 60px 55px 60px 105px 105px 105px 105px 105px';
const hdr = (label, align='left', title='') =>
`<span style="text-align:${align}"${title?` title="${title}"`:''}>${label}</span>`;
const gridRow = (cells, style='') =>
`<div style="display:grid;grid-template-columns:${cols};gap:5px;${style}">${cells.join('')}</div>`;
const d_ = (align='right') => `<span style="color:var(--text-faint);font-size:12px;text-align:${align}">—</span>`;
// Totals
const totHrs = calcHours(yearCases);
const totProjPay = calcProjPay(yearCases);
const totMyPay = calcMyPay(yearCases);
const totInv = sumInvoices(yearCases);
const totSupply = calcSupply(yearCases);
const totInvByDate = Array.from({length:12},(_,i)=>sumInvoicesByMonth(i,selectedYear)).reduce((a,b)=>a+b,0);
const totAtlas = Math.max(0, totInvByDate - totMyPay - totSupply);
const totUpcomingCases = upcomingPreops.length;
const totUpcomingDays = new Set(upcomingPreops.map(r=>r['po-surgeryDate'])).size;
const totUpcomingProj = upcomingProjPay(upcomingPreops);
monthEl.innerHTML =
gridRow([
hdr('Month'), hdr('Cases','center'), hdr('Days','center'), hdr('Hrs','center'),
hdr('Proj. Pay','right','Pre-op est. hrs × $600'),
hdr('My Pay','right','Actual hrs × center rate'),
hdr('Invoiced','right'),
hdr('Supply Cost','right'),
hdr('Atlas Takeaway','right','Invoiced − My Pay − Supply Cost')
], 'padding-bottom:8px;border-bottom:2px solid var(--border-strong);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)') +
months.map((m,i)=>{
const mc = byMonth[i];
const uc = upcomingByMonth[i];
const hasFinalized = mc.length > 0;
const hasUpcoming = uc.length > 0;
if(!hasFinalized && !hasUpcoming) return gridRow([
`<span style="color:var(--text-faint);font-size:12px">${m}</span>`,
d_('center'),d_('center'),d_('center'),d_(),d_(),d_(),d_(),d_()
], 'padding:6px 0;border-bottom:1px solid var(--border)');
const hrs = calcHours(mc);
const projPay = calcProjPay(mc) + upcomingProjPay(uc);
const myPay = calcMyPay(mc);
const inv = sumInvoicesByMonth(i, selectedYear);
const supply = calcSupply(mc);
const atlas = Math.max(0, inv - myPay - supply);
const totalCases = mc.length + uc.length;
const totalDays = new Set([...mc.map(c=>c.date),...uc.map(r=>r['po-surgeryDate'])]).size;
// Label upcoming count if mixed
const casesLabel = uc.length > 0
? `<span style="font-size:13px;text-align:center">${mc.length}<span style="font-size:10px;color:var(--info);font-style:italic"> +${uc.length}</span></span>`
: `<span style="font-size:13px;text-align:center">${mc.length}</span>`;
return gridRow([
`<span style="font-size:13px;font-weight:600">${m}</span>`,
casesLabel,
`<span style="font-size:13px;text-align:center">${totalDays}</span>`,
`<span style="font-size:13px;text-align:center;font-family:'DM Mono',monospace">${hrs>0?hrs.toFixed(1):'—'}</span>`,
`<span style="font-size:13px;font-family:'DM Mono',monospace;color:#6b7280;text-align:right;font-style:italic">${projPay>0?'$'+projPay.toFixed(2):'—'}</span>`,
`<span style="font-size:13px;font-family:'DM Mono',monospace;color:#166534;text-align:right">${myPay>0?'$'+myPay.toFixed(2):'—'}</span>`,
`<span style="font-size:13px;font-family:'DM Mono',monospace;color:var(--accent);text-align:right">${inv>0?'$'+inv.toFixed(2):'—'}</span>`,
`<span style="font-size:13px;font-family:'DM Mono',monospace;color:var(--warn);text-align:right">${supply>0?'$'+supply.toFixed(2):'—'}</span>`,
`<span style="font-size:13px;font-family:'DM Mono',monospace;color:var(--info);font-weight:600;text-align:right">${inv>0?'$'+atlas.toFixed(2):'—'}</span>`
], `padding:7px 0;border-bottom:1px solid var(--border);align-items:center${uc.length>0?';background:rgba(29,53,87,0.02)':''}`);
}).join('') +
`<div style="display:grid;grid-template-columns:${cols};gap:5px;padding:10px 0;border-top:2px solid var(--border-strong);align-items:center">
<span style="font-size:13px;font-weight:700">Finalized</span>
<span style="font-size:13px;font-weight:700;text-align:center">${yearCases.length}</span>
<span style="font-size:13px;font-weight:700;text-align:center">${uniqueDays(yearCases)}</span>
<span style="font-size:13px;font-weight:700;text-align:center;font-family:'DM Mono',monospace">${totHrs>0?totHrs.toFixed(1):'—'}</span>
<span style="font-size:13px;font-weight:700;font-family:'DM Mono',monospace;color:#6b7280;text-align:right;font-style:italic">${totProjPay>0?'$'+totProjPay.toFixed(2):'—'}</span>
<span style="font-size:13px;font-weight:700;font-family:'DM Mono',monospace;color:#166534;text-align:right">${totMyPay>0?'$'+totMyPay.toFixed(2):'—'}</span>
<span style="font-size:13px;font-weight:700;font-family:'DM Mono',monospace;color:var(--accent);text-align:right">${totInvByDate>0?'$'+totInvByDate.toFixed(2):'—'}</span>
<span style="font-size:13px;font-weight:700;font-family:'DM Mono',monospace;color:var(--warn);text-align:right">${totSupply>0?'$'+totSupply.toFixed(2):'—'}</span>
<span style="font-size:13px;font-weight:700;font-family:'DM Mono',monospace;color:var(--info);text-align:right">${totInvByDate>0?'$'+totAtlas.toFixed(2):'—'}</span>
</div>` +
(totUpcomingCases > 0 ? `<div style="display:grid;grid-template-columns:${cols};gap:5px;padding:8px 0;border-top:1px dashed var(--border);align-items:center;background:rgba(29,53,87,0.03)">
<span style="font-size:12px;font-weight:600;color:var(--info);font-style:italic">Upcoming</span>
<span style="font-size:12px;text-align:center;color:var(--info)">${totUpcomingCases}</span>
<span style="font-size:12px;text-align:center;color:var(--info)">${totUpcomingDays}</span>
<span style="font-size:12px;text-align:center;color:var(--text-faint)">—</span>
<span style="font-size:12px;font-family:'DM Mono',monospace;color:#6b7280;text-align:right;font-style:italic">${totUpcomingProj>0?'$'+totUpcomingProj.toFixed(2):'—'}</span>
<span style="font-size:12px;text-align:right;color:var(--text-faint)">—</span>
<span style="font-size:12px;text-align:right;color:var(--text-faint)">—</span>
<span style="font-size:12px;text-align:right;color:var(--text-faint)">—</span>
<span style="font-size:12px;text-align:right;color:var(--text-faint)">—</span>
</div>` : '');
};
// -- CS TRANSFER LOG --
window.showAddTransferForm = function() {
const form = document.getElementById('transfer-form');
if(form) {
form.style.display = 'block';
// Default to today
const dateEl = document.getElementById('tf-date');
if(dateEl && !dateEl.value) dateEl.value = todayStr();
}
};
window.hideAddTransferForm = function() {
const form = document.getElementById('transfer-form');
if(form) form.style.display = 'none';
['tf-date','tf-drug','tf-amount','tf-vials','tf-notes'].forEach(id => {
const el = document.getElementById(id);
if(el) el.value = '';
});
};
window.saveTransfer = async function() {
const date = document.getElementById('tf-date')?.value;
const drug = document.getElementById('tf-drug')?.value;
const amount = parseFloat(document.getElementById('tf-amount')?.value) || 0;
const vials = parseInt(document.getElementById('tf-vials')?.value) || 0;
const notes = document.getElementById('tf-notes')?.value?.trim() || '';
if(!date || !drug || !amount) {
alert('Please fill in date, drug, and amount.');
return;
}
try {
const snap = await getDoc(doc(db,'atlas','cstransfers'));
const existing = snap.exists() ? (snap.data().transfers || []) : [];
existing.unshift({
id: uid(),
date,
drug,
amount,
vials,
notes,
from: 'Josh Condado',
to: 'Devarsh Murthy',
recordedBy: currentUser?.email || 'unknown',
savedAt: new Date().toISOString()
});
setSyncing(true);
await setDoc(doc(db,'atlas','cstransfers'), { transfers: existing });
setSyncing(false);
hideAddTransferForm();
renderTransferLog();
} catch(e) {
alert('Error saving: ' + e.message);
console.error(e);
}
};
window.deleteTransfer = async function(id) {
if(!confirm('Delete this transfer record?')) return;
try {
const snap = await getDoc(doc(db,'atlas','cstransfers'));
const existing = snap.exists() ? (snap.data().transfers || []) : [];
const updated = existing.filter(t => t.id !== id);
setSyncing(true);
await setDoc(doc(db,'atlas','cstransfers'), { transfers: updated });
setSyncing(false);
renderTransferLog();
} catch(e) { console.error(e); }
};
async function renderTransferLog() {
const el = document.getElementById('transfer-log-list');
if(!el) return;
el.innerHTML = '<div style="font-size:13px;color:var(--text-faint)">Loading...</div>';
try {
const snap = await getDoc(doc(db,'atlas','cstransfers'));
const transfers = snap.exists() ? (snap.data().transfers || []) : [];
if(!transfers.length) {
el.innerHTML = '<div class="empty-state">No transfers recorded yet</div>';
return;
}
el.innerHTML = `
<div style="display:grid;grid-template-columns:90px 1fr 80px 60px 1fr 80px;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint)"><span>Date</span><span>Drug</span><span>Amount</span><span>Vials</span><span>Notes</span><span></span></div>
${transfers.map((t,i) => `
<div style="display:grid;grid-template-columns:90px 1fr 80px 60px 1fr 80px;gap:8px;padding:9px 0;border-bottom:1px solid var(--border);align-items:center;background:${i%2===0?'transparent':'var(--surface2)'}"><div style="font-size:12px;font-family:'DM Mono',monospace">${fmtDate(t.date)}</div><div style="font-size:13px;font-weight:500">${t.drug}</div><div style="font-size:13px;font-family:'DM Mono',monospace">${t.amount} mg</div><div style="font-size:13px;color:var(--text-muted)">${t.vials||'—'}</div><div style="font-size:12px;color:var(--text-faint);font-style:italic">${t.notes||'—'}<div style="font-size:10px;color:var(--text-faint)">Josh → Dev</div></div><div style="display:flex;gap:4px"><button onclick="deleteTransfer('${t.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">Delete</button></div></div>`).join('')}
<div style="padding-top:10px;margin-top:4px;border-top:2px solid var(--border-strong);font-size:13px;font-weight:600;color:var(--text-muted)">
${transfers.length} transfer${transfers.length!==1?'s':''} recorded
</div>`;
} catch(e) {
el.innerHTML = '<div class="empty-state">Error loading transfers</div>';
console.error(e);
}
}
// -- DRAFT INVOICE --
function calcDraftInvoice(startTime, endTime, firstHourRate, per15Rate) {
if(!startTime || !endTime || !firstHourRate) return null;
const [sh, sm] = startTime.split(':').map(Number);
const [eh, em] = endTime.split(':').map(Number);
const totalMins = (eh * 60 + em) - (sh * 60 + sm);
if(totalMins <= 0) return null;
// First hour is flat; extra time rounds up to nearest 15-min block
const roundedMins = totalMins <= 60 ? 60 : 60 + Math.ceil((totalMins - 60) / 15) * 15;
const actualH = Math.floor(totalMins / 60);
const actualM = totalMins % 60;
const billedH = Math.floor(roundedMins / 60);
const billedM = roundedMins % 60;
const actualStr = `${actualH}h${actualM > 0 ? ' ' + actualM + 'm' : ''}`;
const billedStr = `${billedH}h${billedM > 0 ? ' ' + billedM + 'm' : ''}`;
let total = 0;
if(roundedMins <= 60) {
total = firstHourRate;
} else {
const extraMins = roundedMins - 60;
total = firstHourRate + (extraMins / 15) * per15Rate;
}
const fmt12 = t => {
const [h, m] = t.split(':').map(Number);
const ampm = h >= 12 ? 'PM' : 'AM';
const h12 = h % 12 || 12;
return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
};
return { total, roundedMins, actualStr, billedStr, totalMins,
startFmt: fmt12(startTime), endFmt: fmt12(endTime) };
}
window.updateDraftInvoicePreview = function() {
const startTime = document.getElementById('caseStartTime')?.value;
const endTime = document.getElementById('caseEndTime')?.value;
const card = document.getElementById('draft-invoice-card');
const content = document.getElementById('draft-invoice-content');
if(!card || !content) return;
if(!startTime || !endTime) { card.style.display = 'none'; return; }
// Get surgery center rates
const centerId = document.getElementById('po-surgery-center')?.value || '';
const center = surgeryCenters.find(c => c.id === centerId);
const firstHourRate = parseFloat(document.getElementById('inv2-first-hour')?.value) || parseFloat(center?.firstHour) || 0;
const per15Rate = parseFloat(document.getElementById('inv2-per-15')?.value) || parseFloat(center?.per15) || 0;
const calc = calcDraftInvoice(startTime, endTime, firstHourRate, per15Rate);
if(!calc) { card.style.display = 'none'; return; }
const centerName = center?.name || document.getElementById('po-surgery-center')?.options[document.getElementById('po-surgery-center')?.selectedIndex]?.text || '—';
const caseId = document.getElementById('caseId')?.value || '—';
const caseDate = document.getElementById('caseDate')?.value || '';
const provider = document.getElementById('provider')?.value || '';
content.innerHTML = `
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px"><div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-faint);margin-bottom:2px">Time</div><div style="font-size:13px;font-weight:500">${calc.startFmt} → ${calc.endFmt}</div><div style="font-size:11px;color:var(--text-faint)">Actual: ${calc.actualStr} · Billed: ${calc.billedStr}</div></div><div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-faint);margin-bottom:2px">Surgery Center</div><div style="font-size:13px;font-weight:500">${centerName}</div>
${center ? `<div style="font-size:11px;color:var(--text-faint)">$${center.firstHour.toFixed(2)} / hr · $${center.per15.toFixed(2)} / 15min</div>` : '<div style="font-size:11px;color:var(--warn)">No center selected — rates not applied</div>'}
</div><div style="padding:8px 12px;background:var(--accent-light);border-radius:var(--radius-sm);border:1px solid var(--accent-mid)"><div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--accent);margin-bottom:2px">Estimated Total</div><div style="font-size:20px;font-weight:700;font-family:'DM Mono',monospace;color:var(--accent)">${center ? '$'+calc.total.toFixed(2) : '—'}</div></div></div>`;
card.style.display = 'block';
// Store draft data for invoice tab
window._draftInvoiceData = {
caseId, date: caseDate, location: centerName, centerId,
provider, startTime, endTime,
firstHour: firstHourRate, per15: per15Rate,
calc
};
renderDraftInvoices();
};
function renderDraftInvoices() {
const el = document.getElementById('draftInvoicesList');
if(!el) return;
const d = window._draftInvoiceData;
if(!d || !d.startTime || !d.endTime) {
el.innerHTML = '<div class="empty-state" style="font-size:13px">No draft invoices yet — add start/end time in Finalize Case to auto-generate one</div>';
return;
}
const calc = d.calc;
el.innerHTML = `
<div class="case-item" style="border-left:3px solid var(--accent)"><div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px"><div><div style="font-size:14px;font-weight:600">${d.caseId} <span style="font-size:11px;font-weight:400;color:var(--text-faint)">· ${fmtDate(d.date)}</span></div><div style="font-size:13px;color:var(--text-muted);margin-top:3px">${d.location} · ${calc.startFmt} → ${calc.endFmt}</div><div style="font-size:12px;color:var(--text-faint);margin-top:2px">Actual: ${calc.actualStr} · Billed: ${calc.billedStr}</div>
${d.firstHour ? `<div style="font-size:13px;font-weight:600;color:var(--accent);margin-top:4px;font-family:'DM Mono',monospace">$${calc.total.toFixed(2)}</div>` : '<div style="font-size:12px;color:var(--warn);margin-top:4px">Add surgery center rates in Analytics to calculate</div>'}
</div><div style="display:flex;gap:8px;flex-direction:column;align-items:flex-end"><button class="btn btn-primary btn-sm" onclick="loadDraftIntoInvoice()" style="font-size:11px">✏ Edit Invoice</button><button class="btn btn-ghost btn-sm" onclick="finalizeDraftInvoicePDF()" style="font-size:11px">⬇ Generate PDF</button></div></div></div>`;
}
window.loadDraftIntoInvoice = function() {
const d = window._draftInvoiceData;
if(!d) return;
showTab('invoice');
setTimeout(() => {
const el = id => document.getElementById(id);
if(el('inv-location')) el('inv-location').value = d.location;
if(el('inv-date')) el('inv-date').value = d.date;
if(el('inv-start')) el('inv-start').value = d.startTime;
if(el('inv-end')) el('inv-end').value = d.endTime;
if(el('inv-first-hour')) el('inv-first-hour').value = d.firstHour || '';
if(el('inv-per-15')) el('inv-per-15').value = d.per15 || '';
if(el('inv-location-select') && d.centerId) el('inv-location-select').value = d.centerId;
calculateInvoice();
}, 200);
};
window.editDraftInvoice = window.loadDraftIntoInvoice;
window.finalizeDraftInvoicePDF = function() {
loadDraftIntoInvoice();
setTimeout(() => {
window.generateInvoicePDF();
}, 600);
};
// -- SCHEDULED PROJECTIONS --
function renderScheduledProjections(scheduledDev, scheduledJosh) {
const el = document.getElementById('analytics-scheduled');
if(!el) return;
const PERSONAL_RATE = 600;
const allScheduled = [...scheduledDev, ...scheduledJosh].sort((a,b) => (a['po-surgeryDate']||'').localeCompare(b['po-surgeryDate']||''));
if(!allScheduled.length) {
el.innerHTML = '<div class="empty-state">No upcoming scheduled cases with pre-op records</div>';
return;
}
el.innerHTML = `
<div style="display:grid;grid-template-columns:90px 1fr 80px 120px 90px 90px 90px;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint)"><span>Surgery</span><span>Case</span><span>Worker</span><span>Center</span><span>Est. Hrs</span><span>Personal</span><span>Atlas</span></div>
${allScheduled.map(r => {
const wname = r.worker === 'dev' ? 'Devarsh' : 'Josh';
const wpill = r.worker === 'dev' ? 'pill-dev' : 'pill-josh';
const center = surgeryCenters.find(sc => sc.id === r['po-surgery-center']);
const estHrs = parseFloat(r['po-est-hours']) || 0;
const personalProj = estHrs * PERSONAL_RATE;
let atlasProj = null;
if(center && estHrs) {
const mins = estHrs * 60;
const extraMins = Math.max(0, mins - 60);
const extra15 = Math.ceil(extraMins / 15);
atlasProj = center.firstHour + (extra15 * center.per15);
}
return `<div style="display:grid;grid-template-columns:90px 1fr 80px 120px 90px 90px 90px;gap:8px;padding:9px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:center"><span style="font-family:'DM Mono',monospace;font-size:11px">${fmtDate(r['po-surgeryDate'])}</span><span style="font-weight:500">${r['po-caseId']||'—'}<div style="font-size:10px;color:var(--text-faint)">${r['po-provider']||''}</div></span><span><span class="worker-pill ${wpill}" style="font-size:10px">${wname}</span></span><span style="font-size:11px">${center?.name||'<span style="color:var(--warn)">No center</span>'}</span><span style="font-family:'DM Mono',monospace">${estHrs>0?estHrs+'h':'<span style="color:var(--warn)">—</span>'}</span><span style="font-family:'DM Mono',monospace;color:#166534;font-weight:500">${personalProj>0?'$'+personalProj.toFixed(2):'—'}</span><span style="font-family:'DM Mono',monospace;color:#1d4ed8;font-weight:500">${atlasProj?'$'+atlasProj.toFixed(2):'—'}</span></div>`;
}).join('')}
<div style="display:grid;grid-template-columns:90px 1fr 80px 120px 90px 90px 90px;gap:8px;padding:10px 0;border-top:2px solid var(--border-strong);font-size:12px;font-weight:600"><span>Totals</span><span>${allScheduled.length} cases</span><span></span><span></span><span></span><span style="font-family:'DM Mono',monospace;color:#166534">$${allScheduled.reduce((s,r)=>{const h=parseFloat(r['po-est-hours'])||0;return s+h*PERSONAL_RATE;},0).toFixed(2)}</span><span style="font-family:'DM Mono',monospace;color:#1d4ed8">$${allScheduled.reduce((s,r)=>{
const c=surgeryCenters.find(sc=>sc.id===r['po-surgery-center']);
const h=parseFloat(r['po-est-hours'])||0;
if(!c||!h) return s;
const mins=h*60;const e=Math.max(0,mins-60);const e15=Math.ceil(e/15);
return s+c.firstHour+(e15*c.per15);
},0).toFixed(2)}</span></div>`;
}
window.setMidCaseDeposit = async function(recordId, status) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records||[]) : [];
const rec = records.find(r => r.id === recordId);
if(!rec) return;
rec['po-depositStatus'] = status;
await savePreopRecords(records);
window._rawPreopRecords = records;
renderMidCase();
renderHistory();
} catch(e) { console.error(e); }
};
window.updatePaymentNotes = async function(recordId, notes) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records||[]) : [];
const rec = records.find(r => r.id === recordId);
if(!rec) return;
rec['po-paymentNotes'] = notes;
await savePreopRecords(records);
window._rawPreopRecords = records;
renderHistory();
} catch(e) { console.error(e); }
};
window.setMidCaseDeposit = async function(recordId, status) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records||[]) : [];
const idx = records.findIndex(r => r.id === recordId);
if(idx === -1) return;
records[idx]['po-depositStatus'] = status;
window._rawPreopRecords = records;
setSyncing(true);
await savePreopRecords(records);
setSyncing(false);
renderMidCase();
} catch(e) { console.error(e); }
};
window.saveMidCasePaymentNotes = async function(recordId, notes) {
try {
const snap = await getDoc(doc(db,'atlas','preop'));
const records = snap.exists() ? (snap.data().records||[]) : [];
const idx = records.findIndex(r => r.id === recordId);
if(idx === -1) return;
records[idx]['po-paymentNotes'] = notes;
window._rawPreopRecords = records;
setSyncing(true);
await savePreopRecords(records);
setSyncing(false);
} catch(e) { console.error(e); }
};
window.markCaseInvoiced = async function(caseId) {
const c = cases.find(x => x.id === caseId);
if(!c) return;
const note = prompt('Invoice note (optional — invoice #, amount, method):', '') ?? '';
c.manuallyInvoiced = true;
c.manuallyInvoicedNote = note || 'Manual';
setSyncing(true);
await saveCases();
setSyncing(false);
renderHistory();
};
window.unmarkCaseInvoiced = async function(caseId) {
const c = cases.find(x => x.id === caseId);
if(!c) return;
if(!confirm('Remove the "Invoiced" mark from this case?')) return;
c.manuallyInvoiced = false;
c.manuallyInvoicedNote = '';
setSyncing(true);
await saveCases();
setSyncing(false);
renderHistory();
};
window.markCaseDepositPaid = async function(caseId) {
const c = cases.find(x => x.id === caseId);
if(!c) return;
const note = prompt('Payment notes (optional — method, ref #, amount):', '') ?? '';
c.depositStatus = 'paid';
c.paymentNotes = note;
setSyncing(true);
await saveCases();
setSyncing(false);
renderHistory();
};
window.unmarkCaseDepositPaid = async function(caseId) {
const c = cases.find(x => x.id === caseId);
if(!c) return;
if(!confirm('Reset deposit status back to "Not Paid"?')) return;
c.depositStatus = 'not-paid';
c.paymentNotes = '';
setSyncing(true);
await saveCases();
setSyncing(false);
renderHistory();
};

// -- FLAT RATE MANAGEMENT --
window.showAddFlatRate = function(centerId) {
  const form = document.getElementById('flat-rate-add-form-'+centerId);
  if(form) { form.style.display = form.style.display==='none'?'':'none'; }
};
window.cancelFlatRate = function(centerId) {
  const form = document.getElementById('flat-rate-add-form-'+centerId);
  if(form) form.style.display='none';
};
window.saveFlatRate = async function(centerId) {
  const procEl = document.getElementById('fr-proc-'+centerId);
  const amtEl  = document.getElementById('fr-amt-'+centerId);
  const proc   = procEl ? procEl.value.trim() : '';
  const amount = amtEl  ? parseFloat(amtEl.value)||0 : 0;
  if(!proc || !amount) { alert('Please enter a procedure name and amount.'); return; }
  const center = surgeryCenters.find(c => c.id === centerId);
  if(!center) return;
  if(!center.flatRates) center.flatRates = [];
  center.flatRates.push({ id: uid(), procedure: proc, amount });
  setSyncing(true);
  await saveSurgeryCenters();
  setSyncing(false);
  renderSurgeryCenters();
  populateCenterDropdowns();
};
window.deleteFlatRate = async function(centerId, flatRateId) {
  if(!confirm('Delete this flat rate?')) return;
  const center = surgeryCenters.find(c => c.id === centerId);
  if(!center) return;
  center.flatRates = (center.flatRates||[]).filter(fr => fr.id !== flatRateId);
  setSyncing(true);
  await saveSurgeryCenters();
  setSyncing(false);
  renderSurgeryCenters();
  populateCenterDropdowns();
};

// -- INVOICE BILLING TYPE TOGGLE --
window.onBillingTypeChange = function() {
  var el=document.querySelector('input[name="inv-billing-type"]:checked');
  setBillingType(el?el.value:'hourly');
};;

window.populateFlatRateDropdown = function() {
  var sel=document.getElementById('inv-flat-rate-select');
  var cSel=document.getElementById('inv-location-select');
  if(!sel) return;
  var cid=cSel?cSel.value:'';
  var center=(window.surgeryCenters||surgeryCenters||[]).find(function(c){return c.id===cid;});
  var frs=(center&&Array.isArray(center.flatRates))?center.flatRates:[];
  if(!frs.length){
    sel.innerHTML='<option value="">-- No flat rates for this center --</option>';
  } else {
    sel.innerHTML='<option value="">-- Select procedure --</option>'
      +frs.map(function(fr){return '<option value="'+fr.id+'" data-amount="'+Number(fr.amount).toFixed(2)+'">'+fr.procedure+'</option>';}).join('');
  }
};;

window.onFlatRateSelect = function() {
  var sel=document.getElementById('inv-flat-rate-select');
  var opt=sel&&sel.selectedIndex>=0?sel.options[sel.selectedIndex]:null;
  if(!opt||!opt.value){ _updateFlatSummary('',0); return; }
  // Get amount from data-amount attribute (most reliable)
  var amount=parseFloat(opt.getAttribute('data-amount'))||0;
  // Get procedure name — everything before the dash separator
  var text=opt.textContent||opt.innerText||opt.text||'';
  var proc=text.split('—')[0].split('--')[0].split('$')[0].trim();
  // Populate the editable inputs so the user can override before generating.
  var pInput=document.getElementById('inv-custom-procedure');
  var aInput=document.getElementById('inv-custom-amount');
  if(pInput) pInput.value = proc;
  if(aInput) aInput.value = amount;
  _updateFlatSummary(proc,amount);
};

window.updateInvoiceTotalDisplay = function() {
  const type = document.getElementById('inv-billing-type')?.value || 'hourly';
  if(type === 'flat') {
    // Always pull from the editable inputs so the live total reflects user
    // edits to the preset (or fully-custom entries).
    const procEl = document.getElementById('inv-custom-procedure');
    const amtEl  = document.getElementById('inv-custom-amount');
    const proc = procEl ? procEl.value.trim() : '';
    const amount = amtEl ? parseFloat(amtEl.value)||0 : 0;
    _updateFlatSummary(proc, amount);
  } else {
    if(typeof calculateInvoice === 'function') calculateInvoice();
  }
};


// -- FLAT RATE INVOICE PDF --
function _generateFlatRateInvoicePDF(location, date, provider, procedure, total, invoiceNumOverride) {
  const invoiceNum = invoiceNumOverride || (function() {
    const now = new Date();
    const d = localDateStr(now).replace(/-/g,'');
    return 'ATL-INV-'+d+'-'+String(Math.floor(Math.random()*900)+100);
  })();
  const formattedDate = new Date(date+'T12:00:00').toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'letter' });
  const W = 215.9;
  const navy=[29,53,87], white=[255,255,255], gray=[107,104,96], lightGray=[240,239,233], black=[26,25,22], lightBlue=[232,238,245];

  // Header
  doc.setFillColor(...navy); doc.rect(0,0,W,42,'F');
  doc.setFillColor(255,255,255); doc.circle(20,20,12,'F');
  const logoEl = document.querySelector('img[style*="border-radius:50%"]');
  if(logoEl){try{doc.addImage(logoEl.src,'PNG',10,10,20,20);}catch(e){}}
  doc.setTextColor(...white);
  doc.setFontSize(20); doc.setFont('helvetica','bold'); doc.text('ATLAS ANESTHESIA',36,20);
  doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.text('Mobile Anesthesia Services',36,28);
  doc.setFontSize(26); doc.setFont('helvetica','bold'); doc.text('INVOICE',W-15,20,{align:'right'});
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text('# '+invoiceNum,W-15,28,{align:'right'});
  doc.text('Date: '+formattedDate,W-15,34,{align:'right'});

  let y = 55;

  // Billed To / From
  doc.setFillColor(...lightGray);
  doc.roundedRect(14,y,85,38,2,2,'F'); doc.roundedRect(116,y,85,38,2,2,'F');
  doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(...gray);
  doc.text('BILLED TO',20,y+8); doc.text('FROM',122,y+8);
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...black);
  doc.text(location,20,y+17);
  doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
  doc.text('Anesthesia Services',20,y+25); doc.text(formattedDate,20,y+32);
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...black);
  doc.text('Atlas Anesthesia',122,y+17);
  doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
  doc.text('Provider: '+provider,122,y+25); doc.text('Mobile Anesthesia Services',122,y+32);
  y += 50;

  // Flat Rate badge
  doc.setFillColor(...lightBlue);
  doc.roundedRect(14,y,W-28,10,2,2,'F');
  doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...navy);
  doc.text('FLAT RATE BILLING',W/2,y+7,{align:'center'});
  y += 16;

  // Table
  doc.setFillColor(...navy); doc.roundedRect(14,y,W-28,10,1,1,'F');
  doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...white);
  doc.text('DESCRIPTION',20,y+7); doc.text('BILLING TYPE',110,y+7,{align:'center'}); doc.text('AMOUNT',W-20,y+7,{align:'right'});
  y += 12;

  // Single row: procedure name + flat rate + amount
  doc.setFillColor(...lightGray); doc.rect(14,y,W-28,12,'F');
  doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(...black);
  doc.text(procedure,20,y+8);
  doc.text('Flat Rate',110,y+8,{align:'center'});
  doc.text('$'+total.toFixed(2),W-20,y+8,{align:'right'});
  y += 18;

  // Total
  doc.setFillColor(...navy); doc.roundedRect(120,y,W-134,18,2,2,'F');
  doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(...white);
  doc.text('TOTAL DUE',128,y+7);
  doc.setFontSize(16); doc.text('$'+total.toFixed(2),W-20,y+12,{align:'right'});
  y += 28;

  // Footer
  doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...gray);
  doc.text('Thank you for choosing Atlas Anesthesia — Mobile Anesthesia Services',W/2,y,{align:'center'});
  doc.text('Invoice '+invoiceNum+' · Generated '+new Date().toLocaleDateString(),W/2,y+6,{align:'center'});
  doc.setDrawColor(...navy); doc.setLineWidth(1.5); doc.line(14,y+12,W-14,y+12);

  doc.save('Atlas-Invoice-'+invoiceNum+'.pdf');
  // Save to Firestore + update Saved Invoices list + refresh analytics
  const flatRecord = {
    id: uid(),
    invoiceNum,
    location,
    date: formattedDate,
    rawDate: date,
    provider,
    billingType: 'flat',
    procedure,
    total,
    savedAt: new Date().toISOString(),
    worker: currentWorker,
    linkedCaseId: ''
  };
  saveInvoiceRecord(flatRecord).then(function() {
    if(typeof renderAnalytics === 'function') renderAnalytics();
  });

  // Save record
  const invoiceRecord = {
    id: uid(), invoiceNum, location, date: formattedDate, rawDate: date,
    provider, billingType:'flat', procedure, total,
    savedAt: new Date().toISOString(), worker: currentWorker, linkedCaseId: ''
  };
  saveInvoiceRecord(invoiceRecord);
}


// -- FLAT RATE MANAGEMENT --
window.showAddFlatRate = function(centerId) {
  const form = document.getElementById('flat-rate-add-form-'+centerId);
  if(form) { form.style.display = form.style.display==='none'?'':'none'; }
};
window.cancelFlatRate = function(centerId) {
  const form = document.getElementById('flat-rate-add-form-'+centerId);
  if(form) form.style.display='none';
};
window.saveFlatRate = async function(centerId) {
  const procEl = document.getElementById('fr-proc-'+centerId);
  const amtEl  = document.getElementById('fr-amt-'+centerId);
  const proc   = procEl ? procEl.value.trim() : '';
  const amount = amtEl  ? parseFloat(amtEl.value)||0 : 0;
  if(!proc || !amount) { alert('Please enter a procedure name and amount.'); return; }
  const center = surgeryCenters.find(c => c.id === centerId);
  if(!center) return;
  if(!center.flatRates) center.flatRates = [];
  center.flatRates.push({ id: uid(), procedure: proc, amount });
  setSyncing(true);
  await saveSurgeryCenters();
  setSyncing(false);
  renderSurgeryCenters();
  populateCenterDropdowns();
};
window.deleteFlatRate = async function(centerId, flatRateId) {
  if(!confirm('Delete this flat rate?')) return;
  const center = surgeryCenters.find(c => c.id === centerId);
  if(!center) return;
  center.flatRates = (center.flatRates||[]).filter(fr => fr.id !== flatRateId);
  setSyncing(true);
  await saveSurgeryCenters();
  setSyncing(false);
  renderSurgeryCenters();
  populateCenterDropdowns();
};

// -- INVOICE BILLING TYPE TOGGLE --
window.onBillingTypeChange = function() {
  const type = document.querySelector('input[name="inv-billing-type"]:checked')?.value || 'hourly';
  const hourlyFields = document.getElementById('inv-hourly-fields');
  const flatFields   = document.getElementById('inv-flat-fields');
  if(!hourlyFields || !flatFields) return;
  if(type === 'flat') {
    hourlyFields.style.display = 'none';
    flatFields.style.display   = '';
    populateFlatRateDropdown();
  } else {
    hourlyFields.style.display = '';
    flatFields.style.display   = 'none';
  }
  updateInvoiceTotalDisplay();
};

window.populateFlatRateDropdown = function() {
  const sel = document.getElementById('inv-flat-rate-select');
  const centerSel = document.getElementById('inv-location-select');
  if(!sel) return;
  const centerId = centerSel ? centerSel.value : '';
  const center = surgeryCenters.find(c => c.id === centerId);
  const frs = center ? (center.flatRates||[]) : [];
  sel.innerHTML = '<option value="">— Select procedure —</option>'
    + frs.map(fr => '<option value="'+fr.id+'" data-amount="'+fr.amount+'">'+fr.procedure+' — $'+Number(fr.amount).toFixed(2)+'</option>').join('');
  updateInvoiceTotalDisplay();
};

window.onFlatRateSelect = function() {
  // Copy the selected preset's procedure + amount into the editable inputs
  // so the user can override either before generating the invoice.
  const sel = document.getElementById('inv-flat-rate-select');
  const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  if(opt && opt.value) {
    const amount = parseFloat(opt.getAttribute('data-amount')) || 0;
    const text = opt.textContent || opt.innerText || opt.text || '';
    const proc = text.split('—')[0].split('--')[0].split('$')[0].trim();
    const pInput = document.getElementById('inv-custom-procedure');
    const aInput = document.getElementById('inv-custom-amount');
    if(pInput) pInput.value = proc;
    if(aInput) aInput.value = amount;
  }
  updateInvoiceTotalDisplay();
};

window.updateInvoiceTotalDisplay = function() {
  const type = document.getElementById('inv-billing-type')?.value || 'hourly';
  if(type === 'flat') {
    // Always pull from the editable inputs so the live total reflects user
    // edits to the preset (or fully-custom entries).
    const procEl = document.getElementById('inv-custom-procedure');
    const amtEl  = document.getElementById('inv-custom-amount');
    const proc = procEl ? procEl.value.trim() : '';
    const amount = amtEl ? parseFloat(amtEl.value)||0 : 0;
    _updateFlatSummary(proc, amount);
  } else {
    if(typeof calculateInvoice === 'function') calculateInvoice();
  }
};


// -- FLAT RATE INVOICE PDF --

function injectBillingToggle() { window._billingType='hourly'; setBillingType('hourly'); }


// -- FLAT RATE FORM HELPERS --
window._editingFlatRates = [];

function renderFlatRatesInForm() {
  const list = document.getElementById('sc-flat-rates-list');
  if(!list) return;
  const frs = window._editingFlatRates || [];
  if(!frs.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-faint);font-style:italic;margin-bottom:4px">No flat rates yet</div>';
    return;
  }
  list.innerHTML = frs.map((fr, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <div>
        <span style="font-size:13px;font-weight:500">${fr.procedure}</span>
        <span style="font-size:13px;font-family:'DM Mono',monospace;color:var(--accent);margin-left:12px">$${Number(fr.amount).toFixed(2)}</span>
      </div>
      <button onclick="removeFlatRateFromForm(${i})" style="background:none;border:none;cursor:pointer;color:var(--warn);font-size:13px">🗑</button>
    </div>`).join('');
}

window.addFlatRateToForm = function() {
  const proc = document.getElementById('sc-fr-proc')?.value.trim();
  const amt  = parseFloat(document.getElementById('sc-fr-amt')?.value) || 0;
  if(!proc || !amt) { alert('Enter a procedure name and amount.'); return; }
  if(!window._editingFlatRates) window._editingFlatRates = [];
  window._editingFlatRates.push({ id: Date.now().toString(36), procedure: proc, amount: amt });
  document.getElementById('sc-fr-proc').value = '';
  document.getElementById('sc-fr-amt').value = '';
  renderFlatRatesInForm();
};

window.removeFlatRateFromForm = function(idx) {
  if(!window._editingFlatRates) return;
  window._editingFlatRates.splice(idx, 1);
  renderFlatRatesInForm();
};


// -- INVOICE RATE CARD RENDERERS ----------------------------------------------


function _renderFlatRateInfoCard() { setBillingType("flat"); }

function _renderHourlyRateCard() { setBillingType("hourly"); }


// -- BILLING TYPE --
window.setBillingType = function(type) {
  window._billingType=type;
  var btnH=document.getElementById('inv-btn-hourly');
  var btnF=document.getElementById('inv-btn-flat');
  var hF=document.getElementById('inv-hourly-fields');
  var fF=document.getElementById('inv-flat-fields');
  var hR=document.getElementById('inv-hourly-rate-fields');
  var fR=document.getElementById('inv-flat-rate-display');
  var tt=document.getElementById('inv-rate-card-title');
  var ACTIVE='2px solid var(--info)';var IDLE='2px solid var(--border)';
  if(btnH){btnH.style.border=IDLE;btnH.style.background='var(--surface)';btnH.style.color='var(--text-muted)';btnH.style.fontWeight='500';}
  if(btnF){btnF.style.border=IDLE;btnF.style.background='var(--surface)';btnF.style.color='var(--text-muted)';btnF.style.fontWeight='500';}
  if(type==='flat'){
    if(btnF){btnF.style.border=ACTIVE;btnF.style.background='var(--info-light)';btnF.style.color='var(--info)';btnF.style.fontWeight='600';}
    if(hF) hF.style.display='none';
    if(fF) fF.style.display='';
    if(hR) hR.style.display='none';
    if(fR) fR.style.display='';
    if(tt) tt.textContent='Flat Rates';
    _refreshFlatRatePanel();
    populateFlatRateDropdown();
    // If custom location selected, make sure location name input stays visible
    var cSel=document.getElementById('inv-location-select');
    var locInput=document.getElementById('inv-location');
    if(cSel&&cSel.value==='__custom__'&&locInput) locInput.style.display='';
  } else {
    if(btnH){btnH.style.border=ACTIVE;btnH.style.background='var(--info-light)';btnH.style.color='var(--info)';btnH.style.fontWeight='600';}
    if(hF) hF.style.display='';
    if(fF) fF.style.display='none';
    if(hR) hR.style.display='';
    if(fR) fR.style.display='none';
    if(tt) tt.textContent='Rate Information';
    calculateInvoice();
    // If custom location selected, keep location name input visible
    var cSel2=document.getElementById('inv-location-select');
    var locInput2=document.getElementById('inv-location');
    if(cSel2&&cSel2.value==='__custom__'&&locInput2) locInput2.style.display='';
    // Hide custom procedure/amount when switching to hourly
    var customDiv2=document.getElementById('inv-flat-custom');
    if(customDiv2) customDiv2.style.display='none';
  }
};
function _refreshFlatRatePanel() {
  var sel=document.getElementById('inv-location-select');
  var val=sel?sel.value:'';
  var center=(window.surgeryCenters||surgeryCenters||[]).find(function(c){return c.id===val;});
  var frs=(center&&Array.isArray(center.flatRates))?center.flatRates:[];
  var knownDiv=document.getElementById('inv-flat-known');
  var customDiv=document.getElementById('inv-flat-custom');
  var tt=document.getElementById('inv-rate-card-title');
  var rowsEl=document.getElementById('inv-flat-rate-rows');

  if(val==='__custom__'||(!val)){
    // Custom or nothing selected: show manual entry fields
    if(knownDiv) knownDiv.style.display='none';
    if(customDiv) customDiv.style.display= val==='__custom__' ? '' : 'none';
    if(tt) tt.textContent= val==='__custom__' ? 'Custom Flat Rate' : 'Flat Rates';
    if(rowsEl) rowsEl.innerHTML='<div style="padding:16px;font-size:13px;color:var(--text-faint);text-align:center;font-style:italic">'+(val==='__custom__'?'Enter procedure and rate on the left':'Select a surgery center to see flat rates')+'</div>';
  } else if(center){
    // Known center: show BOTH the preset dropdown and the editable inputs.
    // The dropdown is a starting point — the user can override either field
    // before generating the PDF (e.g. "1.5 Arch" at $3250).
    if(knownDiv) knownDiv.style.display='';
    if(customDiv) customDiv.style.display='';
    if(tt) tt.textContent='Flat Rates — '+center.name;
    if(!frs.length){
      if(rowsEl) rowsEl.innerHTML='<div style="padding:16px;font-size:13px;color:var(--text-faint);text-align:center;font-style:italic">No flat rates. Edit this center in Analytics to add.</div>';
    } else {
      if(rowsEl) rowsEl.innerHTML=frs.map(function(fr,i){
        var bg=i%2===0?'var(--bg)':'var(--surface2)';
        var bb=i<frs.length-1?'border-bottom:1px solid var(--border)':'';
        return '<div style="display:grid;grid-template-columns:1fr auto">'
          +'<div style="padding:10px 14px;font-size:13px;background:'+bg+';'+bb+'">'+fr.procedure+'</div>'
          +'<div style="padding:10px 14px;font-size:14px;font-weight:600;color:var(--accent);background:'+bg+';'+bb+';text-align:right;font-family:DM Mono,monospace">$'+Number(fr.amount).toFixed(2)+'</div>'
          +'</div>';
      }).join('');
    }
  }
}
function _updateFlatSummary(procedure,amount) {
  var totalEl=document.getElementById('inv-total');
  var summaryEl=document.getElementById('inv-summary');
  if(amount>0&&procedure){
    if(totalEl) totalEl.textContent='$'+amount.toFixed(2);
    if(summaryEl) summaryEl.innerHTML='<div style="font-size:11px;color:var(--text-faint);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Flat Rate</div><div style="font-size:15px;font-weight:500;color:var(--text)">'+procedure+'</div><div style="font-size:14px;color:var(--accent);font-weight:600;margin-top:2px">$'+amount.toFixed(2)+'</div>';
  } else {
    if(totalEl) totalEl.textContent='$0.00';
    if(summaryEl) summaryEl.textContent='Select a procedure to see total';
  }
}
window.onCustomFlatChange = function() {
  var proc=(document.getElementById('inv-custom-procedure')||{value:''}).value.trim();
  var amt=parseFloat((document.getElementById('inv-custom-amount')||{value:0}).value)||0;
  _updateFlatSummary(proc,amt);
};

// -- BROWSER BACK BUTTON --
window.addEventListener('popstate', (event) => {
const tab = event.state?.tab || 'preop';
showTab(tab, false); // false = don't push another state
});
// Init: set state for current tab on load
try {
const initTab = localStorage.getItem('atlas_active_tab') || 'preop';
history.replaceState({ tab: initTab }, '', '#' + initTab);
} catch(e) {}
// -- REPORTS DROPDOWN --
window.toggleReportsDropdown = function() {
const btn = document.getElementById('reports-dropdown-btn');
const menu = document.getElementById('reports-dropdown-menu');
// Close other dropdowns first so only one is open at a time
closeWorkflowDropdown(); closeSetupDropdown();
btn.classList.toggle('open');
menu.classList.toggle('open');
};
window.closeReportsDropdown = function() {
const btn = document.getElementById('reports-dropdown-btn');
const menu = document.getElementById('reports-dropdown-menu');
if(btn) btn.classList.remove('open');
if(menu) menu.classList.remove('open');
};

window.toggleWorkflowDropdown = function() {
const btn = document.getElementById('workflow-dropdown-btn');
const menu = document.getElementById('workflow-dropdown-menu');
closeReportsDropdown(); closeSetupDropdown();
if(btn) btn.classList.toggle('open');
if(menu) menu.classList.toggle('open');
};
window.closeWorkflowDropdown = function() {
const btn = document.getElementById('workflow-dropdown-btn');
const menu = document.getElementById('workflow-dropdown-menu');
if(btn) btn.classList.remove('open');
if(menu) menu.classList.remove('open');
};

// ── COMMAND PALETTE (Cmd+K) ───────────────────────────────────────────────────
function _ensureCommandPaletteDOM() {
  if(document.getElementById('cmd-palette-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'cmd-palette-overlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9999;align-items:flex-start;justify-content:center;padding-top:12vh;backdrop-filter:blur(4px)';
  overlay.innerHTML = `
    <div id="cmd-palette-modal" style="background:#fff;width:min(640px,calc(100vw - 32px));max-height:70vh;border-radius:14px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,.35);display:flex;flex-direction:column">
      <div style="padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:10px">
        <span style="font-size:18px;color:#94a3b8">🔍</span>
        <input id="cmd-palette-input" type="text" placeholder="Search cases, supplies, surgery centers, actions..." autocomplete="off" style="flex:1;border:none;outline:none;font-size:15px;background:transparent;color:#1e293b;font-family:inherit">
        <kbd style="font-size:10px;color:#94a3b8;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:2px 6px;font-family:inherit">esc</kbd>
      </div>
      <div id="cmd-palette-results" style="overflow-y:auto;padding:8px 0;flex:1"></div>
      <div style="padding:8px 14px;border-top:1px solid #e2e8f0;background:#f8fafc;font-size:11px;color:#94a3b8;display:flex;gap:14px;align-items:center">
        <span><kbd style="background:#fff;border:1px solid #e2e8f0;border-radius:3px;padding:1px 5px;font-family:inherit;font-size:10px">↑↓</kbd> navigate</span>
        <span><kbd style="background:#fff;border:1px solid #e2e8f0;border-radius:3px;padding:1px 5px;font-family:inherit;font-size:10px">↵</kbd> select</span>
        <span><kbd style="background:#fff;border:1px solid #e2e8f0;border-radius:3px;padding:1px 5px;font-family:inherit;font-size:10px">esc</kbd> close</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if(e.target === overlay) closeCommandPalette(); });
  const input = document.getElementById('cmd-palette-input');
  input.addEventListener('input', () => _renderCommandPaletteResults(input.value));
  input.addEventListener('keydown', _commandPaletteKeyHandler);
}

// ── HELP TOPICS ─────────────────────────────────────────────────────────────
// Natural-language help entries surfaced in the command palette. Each topic
// has a title, search keywords, step-by-step instructions, and an optional
// navigation action (run when the user clicks "Take me there").
const HELP_TOPICS = [
  { title: 'How to create a new Pre-Op assessment',
    keywords: 'pre-op preop new patient assessment first save record start how do i',
    steps: ['Click "Pre-Op" in the Workflow menu (or use Cmd+K → Go to Pre-Op).','Fill in patient name, phone, and date of birth at the top.','Enter the surgery date, time, dentist, and surgery center.','Fill in pre-op call info, medical history, and vitals.','Click "✓ Save Record" at the top right.'],
    action: () => showTab('preop') },
  { title: 'How to send a Pre-Op Evaluation Request fax',
    keywords: 'fax send pre-op evaluation request pcp doctor primary care provider',
    steps: ['Save the Pre-Op record first.','Go to Pre-Op tab → click "📋 PRE-OP EVALUATION REQUEST".','Select the case ID from the dropdown at the top.','Fill in the PCP name and fax number.','Click "Confirm & Send Fax" at the bottom.'],
    action: () => showTab('preop') },
  { title: 'How to send a Facsimile Cover Sheet',
    keywords: 'fax cover sheet send records general purpose',
    steps: ['Open the Pre-Op tab and select the case.','Click "📠 Facsimile Cover Fax".','Enter recipient name, fax number, and requested documents.','Click "Confirm & Send Fax".'],
    action: () => showTab('preop') },
  { title: 'How to finalize a case',
    keywords: 'finalize case complete supplies inventory cs controlled substance',
    steps: ['Go to Mid-Case → click "Finalize Case →" on the right case.','Add all supplies used in the "Supplies Used This Case" section.','Add any controlled substances (Propofol, Fentanyl, etc.) in the CS section.','Optionally add a photo of the paper case log.','Click "✓ Finalize Case & Update Inventory" at the top.'],
    action: () => showTab('mid-case') },
  { title: 'How to send a deposit link to a patient',
    keywords: 'deposit stripe payment $500 patient link send',
    steps: ['Open the Pre-Op tab → make sure Deposit Email is filled in.','Click "💰 Send Deposit Link".','Confirm or update the patient email.','Click Send. A Stripe payment link is emailed automatically.'],
    action: () => showTab('preop') },
  { title: 'How to add a new inventory item',
    keywords: 'inventory new item add supply drug medication stock',
    steps: ['Go to Inventory (in the Setup menu).','Click "+ Add New Item" in the top right.','Fill in item code, name, category, supplier, unit size, price, and stock levels.','Set a restock alert level so you get warned when stock runs low.','Click "Add Item".'],
    action: () => showTab('inventory') },
  { title: 'How to update stock quickly',
    keywords: 'stock add inventory quick adjust restock receive',
    steps: ['Go to Inventory tab.','Click "⚡ Quick Add Stock" at the top.','Enter how many units to add for each item (leave blank to skip).','Click "✓ Save All" when done.'],
    action: () => showTab('inventory') },
  { title: 'How to mark a case as invoiced or deposit paid',
    keywords: 'invoice paid deposit mark payment received',
    steps: ['Go to Case History.','Click the "Actions ▾" dropdown on the case.','For invoiced manually: there is a Mark Invoiced option.','Deposit paid: check the deposit status pill on the row.'],
    action: () => showTab('history') },
  { title: 'How to use Surgery Mode',
    keywords: 'surgery mode screen on keep awake live case ipad tablet',
    steps: ['Click the "🏥 Surgery Mode" button in the top-right header.','A yellow banner will appear at top — screen stays on, auto-logout paused.','You will be auto-navigated to the Live Case tab.','To exit: click "Turn Off" on the yellow banner.'],
    action: () => toggleSurgeryMode() },
  { title: 'How to track supplies during a live case',
    keywords: 'live case surgery mode track real time supplies cs portal',
    steps: ['Activate Surgery Mode (header button).','You will land on Live Case tab.','Pick the active case from the dropdown.','Tap "📦 Add Supplies" or "💊 Add Controlled Substances" as you use them.','Notes auto-save. Click "Go to Finalize Case →" when surgery ends.'],
    action: () => { toggleSurgeryMode(); } },
  { title: 'How to send a patient their appointment link',
    keywords: 'patient portal link share appointment deposit',
    steps: ['Go to Mid-Case tab.','Click "Actions ▾" on the case.','Click "🔗 Patient Portal Link". A URL is copied to your clipboard.','Text or email the link to the patient.','They can see their date/time/deposit status and pay if needed.'],
    action: () => showTab('mid-case') },
  { title: 'How to view the audit log',
    keywords: 'audit log history activity who did what hipaa compliance',
    steps: ['Click the Reports ▾ menu.','Click "Audit Log".','Filter by date or action type if needed.','Every PHI access, edit, login, and reveal is recorded here.'],
    action: () => { if(typeof openAuditLogModal === 'function') openAuditLogModal(); } },
  { title: 'Bug codes reference (copy these when reporting issues)',
    keywords: 'bug codes errors error codes reference list debugging report issue',
    steps: [
      'INV-001 / INV-002 — Inventory save failed or did not persist.',
      'CASE-001 / CASE-002 — Case save failed or supplies did not persist.',
      'CASE-003 / CASE-004 — Case not found, or inventory deduction failed.',
      'PREOP-001 / 002 / 003 — Pre-Op save / lookup / pill update failed.',
      'FAX-001 / 002 / 003 — Fax send / invalid number / scheduler error.',
      'EMAIL-001 / 002 — Email send failed or recipient not verified (SES sandbox).',
      'AUTH-001 / 002 / 003 — Sign-in / session / permission errors.',
      'PHI-001 / 002 — PHI reveal wrong password or unauthorized user.',
      'PAY-001 / 002 — Payment row save or delete failed.',
      'PORTAL-001 / 002 — Portal token create / expired or invalid.',
      'BACKUP-001 / 002 — Backup download or daily-backup write failed.',
      'NET-001 / SYNC-001 — Network or real-time sync issue.',
      'When you see a code in a toast, click the "copy" button and paste it to me — it includes the technical detail too.'
    ],
    action: () => {} },
  { title: 'How to reveal hidden patient details (old cases)',
    keywords: 'phi hidden reveal show patient details unlock password',
    steps: ['Old cases (3+ days post-surgery) hide patient info automatically.','In Mid-Case or Case History, look for a "🔒 Show Patient Details" button.','Click it and enter your account password.','Details unlock for this session only. The reveal is audit-logged.'],
    action: () => {} },
  { title: 'How to send an insurance fax sheet',
    keywords: 'insurance fax sheet send cdt codes flat fee',
    steps: ['Go to Finalize Case after completing a case.','Click "📋 Insurance Sheet".','Pick Flat Fee or CDT Codes mode.','Fill in the recipient fax number and details.','Click Send.'],
    action: () => showTab('new-case') },
  { title: 'How to schedule a fax for later',
    keywords: 'schedule fax later future date send',
    steps: ['Open the fax composer (Cover Sheet or Pre-Op Evaluation).','At the bottom, switch the toggle from "Send Now" to "Schedule".','Pick a date and time.','Click Confirm. The fax sends automatically at the chosen time.'],
    action: () => showTab('preop') },
  { title: 'What does HIPAA Compliant mean here',
    keywords: 'hipaa compliant compliance security what does badge means',
    steps: ['The green ✓ HIPAA badge shows Atlas is configured for HIPAA: encrypted database (Firestore), audit logging of all PHI access, automatic 20-minute logout, signed Business Associate Agreements (Google, AWS, FAXAGE, Stripe), and PHI redaction 3 days after surgery.','Compliance is a process — running the annual HHS Security Risk Assessment and maintaining policies are still required.'],
    action: () => {} },
  { title: 'How to manage Surgery Centers',
    keywords: 'surgery center add edit manage location',
    steps: ['Click Setup ▾ → Surgery Centers.','Add new centers with name, address, contacts, billing info.','Each center can be linked to pre-op records so cases roll up by location.'],
    action: () => showTab('analytics') }
];

function _buildCommandPaletteIndex() {
  const items = [];
  // Help topics
  HELP_TOPICS.forEach(topic => {
    items.push({
      type: 'help',
      label: topic.title,
      sub: 'Help · ' + (topic.keywords.split(' ').slice(0, 5).join(' ')),
      icon: '💡',
      action: () => _showHelpTopic(topic),
      _searchExtra: topic.keywords
    });
  });
  // Navigation actions
  const navs = [
    { type:'nav', label:'Go to Home', icon:'🏠', action:() => showTab('home') },
    { type:'nav', label:'Go to Pre-Op', icon:'📝', action:() => showTab('preop') },
    { type:'nav', label:'Go to Mid-Case', icon:'🩺', action:() => showTab('mid-case') },
    { type:'nav', label:'Go to Finalize Case', icon:'✓', action:() => showTab('new-case') },
    { type:'nav', label:'Go to Inventory', icon:'📦', action:() => showTab('inventory') },
    { type:'nav', label:'Go to Calendar', icon:'📅', action:() => showTab('calendar') },
    { type:'nav', label:'Go to Surgery Centers', icon:'🏥', action:() => showTab('analytics') },
    { type:'nav', label:'Go to Payments', icon:'💰', action:() => showTab('payments') },
    { type:'nav', label:'Go to Case History', icon:'📜', action:() => showTab('history') },
    { type:'nav', label:'Go to Audit Log', icon:'🔍', action:() => { if(typeof openAuditLogModal === 'function') openAuditLogModal(); } },
    { type:'action', label:'Toggle Surgery Mode', icon:'🏥', action:() => toggleSurgeryMode() },
    { type:'action', label:'Download Backup', icon:'⬇', action:() => { if(typeof window.downloadFullBackup === 'function') window.downloadFullBackup(); } },
    { type:'action', label:'Sign Out', icon:'⤴', action:() => { if(typeof doLogout === 'function') doLogout(); } }
  ];
  items.push(...navs);
  // Cases (from window.cases)
  (window.cases || []).forEach(c => {
    const displayId = (typeof window.getCaseDisplayIdFromCase === 'function') ? window.getCaseDisplayIdFromCase(c) : c.caseId;
    items.push({
      type: 'case',
      label: displayId,
      sub: `${fmtDate(c.date)} · ${c.provider || '—'} · ${c.worker === 'dev' ? 'Dev' : 'Josh'}`,
      icon: c.draft ? '✏' : '✓',
      action: () => { showTab('history'); }
    });
  });
  // Pre-op records (from window._rawPreopRecords)
  (window._rawPreopRecords || []).forEach(r => {
    const displayId = (typeof window.getCaseDisplayIdFromPreop === 'function') ? window.getCaseDisplayIdFromPreop(r) : r['po-caseId'];
    items.push({
      type: 'preop',
      label: displayId,
      sub: `Pre-Op · ${fmtDate(r['po-surgeryDate'])} · ${r['po-provider'] || '—'}`,
      icon: '📝',
      action: () => { showTab('mid-case'); }
    });
  });
  // Inventory items
  (window.items || []).slice(0, 100).forEach(i => {
    items.push({
      type: 'inventory',
      label: i.generic || i.name || 'Untitled',
      sub: `Inventory · ${i.category || 'Item'}${i.stockDev != null ? ' · Dev: '+i.stockDev : ''}${i.stockJosh != null ? ' · Josh: '+i.stockJosh : ''}`,
      icon: '📦',
      action: () => showTab('inventory')
    });
  });
  // Surgery centers
  (window.surgeryCenters || []).forEach(c => {
    items.push({
      type: 'center',
      label: c.name || 'Untitled',
      sub: `Surgery Center${c.address ? ' · '+c.address : ''}`,
      icon: '🏥',
      action: () => showTab('analytics')
    });
  });
  return items;
}

function _fuzzyScore(query, text) {
  if(!query) return 0;
  if(!text) return -1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if(t === q) return 1000;
  if(t.startsWith(q)) return 500;
  if(t.includes(q)) return 200;
  // Letter-by-letter fuzzy match
  let qi = 0, score = 0;
  for(let i = 0; i < t.length && qi < q.length; i++) {
    if(t[i] === q[qi]) { score += 5; qi++; }
  }
  return qi === q.length ? score : -1;
}

let _cmdPaletteIndex = [];
let _cmdPaletteSelected = 0;
let _cmdPaletteFiltered = [];

function _renderCommandPaletteResults(query) {
  const resultsEl = document.getElementById('cmd-palette-results');
  if(!resultsEl) return;
  const q = (query || '').trim();
  let filtered;
  if(!q) {
    filtered = _cmdPaletteIndex.slice(0, 20);
  } else {
    const scored = _cmdPaletteIndex.map(item => ({
      item,
      score: Math.max(
        _fuzzyScore(q, item.label),
        _fuzzyScore(q, item.sub || ''),
        _fuzzyScore(q, item._searchExtra || '')
      )
    })).filter(x => x.score > 0)
      .sort((a,b) => b.score - a.score)
      .slice(0, 30);
    filtered = scored.map(x => x.item);
  }
  _cmdPaletteFiltered = filtered;
  _cmdPaletteSelected = 0;
  if(!filtered.length) {
    resultsEl.innerHTML = '<div style="padding:30px 20px;text-align:center;color:#94a3b8;font-size:13px">No results for "'+q.replace(/</g,'&lt;')+'"</div>';
    return;
  }
  resultsEl.innerHTML = filtered.map((item, idx) => `
    <div class="cmd-palette-result" data-idx="${idx}" onclick="window._runCmdPaletteItem(${idx})" style="padding:9px 18px;cursor:pointer;display:flex;align-items:center;gap:12px;background:${idx===0?'#f1f5f9':'transparent'}">
      <span style="font-size:16px;width:22px;text-align:center;flex-shrink:0">${item.icon || '•'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(item.label||'').replace(/</g,'&lt;')}</div>
        ${item.sub ? `<div style="font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.sub.replace(/</g,'&lt;')}</div>` : ''}
      </div>
      <span style="font-size:10px;color:#cbd5e1;text-transform:uppercase;letter-spacing:.5px">${item.type || ''}</span>
    </div>
  `).join('');
}

function _updateCmdPaletteSelection() {
  const items = document.querySelectorAll('.cmd-palette-result');
  items.forEach((el, i) => {
    el.style.background = i === _cmdPaletteSelected ? '#f1f5f9' : 'transparent';
    if(i === _cmdPaletteSelected) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

function _commandPaletteKeyHandler(e) {
  if(e.key === 'ArrowDown') {
    e.preventDefault();
    _cmdPaletteSelected = Math.min(_cmdPaletteSelected + 1, _cmdPaletteFiltered.length - 1);
    _updateCmdPaletteSelection();
  } else if(e.key === 'ArrowUp') {
    e.preventDefault();
    _cmdPaletteSelected = Math.max(_cmdPaletteSelected - 1, 0);
    _updateCmdPaletteSelection();
  } else if(e.key === 'Enter') {
    e.preventDefault();
    window._runCmdPaletteItem(_cmdPaletteSelected);
  } else if(e.key === 'Escape') {
    e.preventDefault();
    closeCommandPalette();
  }
}

window._runCmdPaletteItem = function(idx) {
  const item = _cmdPaletteFiltered[idx];
  if(!item) return;
  closeCommandPalette();
  try { item.action(); } catch(err) { console.error('Command palette action failed:', err); }
};

function _showHelpTopic(topic) {
  const overlay = document.createElement('div');
  overlay.id = 'help-topic-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;max-width:540px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,.35)">
      <div style="padding:22px 26px 18px;background:#1d3557;color:#fff;border-radius:14px 14px 0 0">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">💡 Help Topic</div>
        <div style="font-size:19px;font-weight:700">${topic.title.replace(/</g,'&lt;')}</div>
      </div>
      <div style="padding:22px 26px">
        <ol style="margin:0 0 22px;padding-left:22px;font-size:14px;color:#1e293b;line-height:1.7">
          ${topic.steps.map(s => `<li style="margin-bottom:8px">${s.replace(/</g,'&lt;')}</li>`).join('')}
        </ol>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="_closeHelpTopic()" style="padding:9px 18px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Close</button>
          ${topic.action ? `<button id="help-topic-go" style="padding:9px 18px;background:#1d3557;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Take me there →</button>` : ''}
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if(e.target === overlay) _closeHelpTopic(); });
  const goBtn = document.getElementById('help-topic-go');
  if(goBtn) goBtn.addEventListener('click', () => { _closeHelpTopic(); try { topic.action(); } catch(e){} });
  document.addEventListener('keydown', _helpTopicKeyHandler);
}
function _closeHelpTopic() {
  const overlay = document.getElementById('help-topic-overlay');
  if(overlay) overlay.remove();
  document.removeEventListener('keydown', _helpTopicKeyHandler);
}
window._closeHelpTopic = _closeHelpTopic;
function _helpTopicKeyHandler(e) { if(e.key === 'Escape') _closeHelpTopic(); }

window.openCommandPalette = function() {
  _ensureCommandPaletteDOM();
  _cmdPaletteIndex = _buildCommandPaletteIndex();
  const overlay = document.getElementById('cmd-palette-overlay');
  if(overlay) overlay.style.display = 'flex';
  const input = document.getElementById('cmd-palette-input');
  if(input) { input.value = ''; input.focus(); }
  _renderCommandPaletteResults('');
};
window.closeCommandPalette = function() {
  const overlay = document.getElementById('cmd-palette-overlay');
  if(overlay) overlay.style.display = 'none';
};

// Cmd+K / Ctrl+K opens palette globally
document.addEventListener('keydown', function(e) {
  if((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    if(window.currentUser) openCommandPalette();
  }
});

// ── DARK MODE ─────────────────────────────────────────────────────────────────
window.toggleDarkMode = function() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('atlas-theme', next); } catch(e){}
  const btn = document.getElementById('user-menu-theme');
  if(btn) btn.innerHTML = next === 'dark' ? '☀ Switch to Light Mode' : '🌙 Switch to Dark Mode';
};
// Apply saved theme on load
(function() {
  try {
    const saved = localStorage.getItem('atlas-theme');
    if(saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      setTimeout(() => {
        const btn = document.getElementById('user-menu-theme');
        if(btn) btn.innerHTML = '☀ Switch to Light Mode';
      }, 100);
    }
  } catch(e){}
})();

window.toggleUserMenu = function() {
  const menu = document.getElementById('user-menu-dropdown');
  if(!menu) return;
  const open = menu.style.display === 'block';
  menu.style.display = open ? 'none' : 'block';
  // Populate the date when opening
  if(!open) {
    const dateEl = document.getElementById('user-menu-date');
    const headerDate = document.getElementById('dateDisplay');
    if(dateEl) dateEl.textContent = (headerDate && headerDate.textContent) || new Date().toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
  }
};
window.closeUserMenu = function() {
  const menu = document.getElementById('user-menu-dropdown');
  if(menu) menu.style.display = 'none';
};
document.addEventListener('click', function(e) {
  const menu = document.getElementById('user-menu-dropdown');
  const btn = document.getElementById('user-menu-btn');
  if(menu && menu.style.display === 'block' && !menu.contains(e.target) && !(btn && btn.contains(e.target))) {
    menu.style.display = 'none';
  }
});

window.toggleSetupDropdown = function() {
const btn = document.getElementById('setup-dropdown-btn');
const menu = document.getElementById('setup-dropdown-menu');
closeReportsDropdown(); closeWorkflowDropdown();
if(btn) btn.classList.toggle('open');
if(menu) menu.classList.toggle('open');
};
window.closeSetupDropdown = function() {
const btn = document.getElementById('setup-dropdown-btn');
const menu = document.getElementById('setup-dropdown-menu');
if(btn) btn.classList.remove('open');
if(menu) menu.classList.remove('open');
};

// Close dropdowns when clicking outside any of them
document.addEventListener('click', function(e) {
const r = document.getElementById('reports-dropdown');
const w = document.getElementById('workflow-dropdown');
const s = document.getElementById('setup-dropdown');
if(r && !r.contains(e.target)) closeReportsDropdown();
if(w && !w.contains(e.target)) closeWorkflowDropdown();
if(s && !s.contains(e.target)) closeSetupDropdown();
});

// Update the dropdown parent buttons to show "active" when one of their
// children is the currently shown tab. Hooked into showTab below.
// ── HOME-PAGE CASE QUICK ACTION MODAL ────────────────────────────────────────
// Shared modal used by both "Today's Schedule" and the Follow-up Tracker on
// the Home tab — clicking a case row opens this picker so the user can jump
// straight to either the Pre-Op record or the Finalize Case form.
window.openCaseActionModal = function(preopId, caseId, label) {
  // Remove any prior instance so back-to-back clicks don't pile up overlays.
  const prior = document.getElementById('caseActionModal');
  if(prior) prior.remove();
  const wrap = document.createElement('div');
  wrap.id = 'caseActionModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };
  // Jordan never finalizes cases — that's CRNA-only. Hide the option for her.
  const finalizeBtn = (window._userRole === 'assistant') ? '' : `
        <button onclick="document.getElementById('caseActionModal')?.remove();if(typeof startCaseFromPreop==='function')startCaseFromPreop('${preopId}');else if(typeof loadDraftCaseById==='function')loadDraftCaseById('${caseId}')" style="padding:18px 20px;background:#1d3557;border:2px solid #1d3557;color:#fff;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:12px;text-align:left;font-family:inherit">
          <span style="font-size:22px">✓</span>
          <div style="flex:1;min-width:0">
            <div>Finalize Case</div>
            <div style="font-size:12px;font-weight:400;color:#a8c4e0;margin-top:2px">Log supplies / CS and finalize</div>
          </div>
        </button>`;
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div style="min-width:0">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">Open Case</div>
          <div style="font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label || caseId || '—'}</div>
        </div>
        <button onclick="document.getElementById('caseActionModal')?.remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:22px;display:grid;gap:12px">
        <button onclick="document.getElementById('caseActionModal')?.remove();if(typeof editPreopRecord==='function')editPreopRecord('${preopId}')" style="padding:18px 20px;background:#fff;border:2px solid #1d3557;color:#1d3557;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:12px;text-align:left;font-family:inherit">
          <span style="font-size:22px">📋</span>
          <div style="flex:1;min-width:0">
            <div>Pre-Op</div>
            <div style="font-size:12px;font-weight:400;color:var(--text-muted);margin-top:2px">Edit the pre-op assessment</div>
          </div>
        </button>
        ${finalizeBtn}
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
};

// ── UPDATE DETECTION ──────────────────────────────────────────────────────────
// Checks if a newer version of the app has been deployed (by polling
// index.html for a fresh cache version string). When it detects a mismatch,
// it shows a persistent banner so Dev/Josh know to hard-refresh.
// APP_VERSION is read dynamically from the currently-loaded <script> tag so
// it always matches whatever app.js?v=... the page was served with — no
// manual bump needed when the cache key changes.
const APP_VERSION = (() => {
  const tag = document.querySelector('script[src*="assets/js/app.js"]');
  const m = tag && tag.src.match(/app\.js\?v=([a-zA-Z0-9-]+)/);
  return m ? m[1] : 'unknown';
})();
const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 1000; // poll every 3 minutes

async function _checkForAppUpdate() {
  try {
    // Fetch index.html with cache-bust, extract the app.js cache version.
    // Use a relative path so it resolves correctly under both root hosting
    // (atlasanesthesia.co) and project-page hosting (.../atlas-tracker/).
    const res = await fetch('index.html?_t=' + Date.now(), { cache: 'no-store' });
    if(!res.ok) return;
    const html = await res.text();
    const match = html.match(/app\.js\?v=([a-zA-Z0-9-]+)/);
    if(!match) return;
    const latestVersion = match[1];
    if(latestVersion && APP_VERSION !== 'unknown' && latestVersion !== APP_VERSION) {
      _showUpdateBanner(latestVersion);
    }
  } catch(e) { /* network blip, ignore */ }
}

function _showUpdateBanner(latestVersion) {
  if(document.getElementById('update-banner')) return; // already shown
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;background:#1d3557;color:#fff;padding:10px 18px;display:flex;align-items:center;justify-content:center;gap:14px;font-size:13px;font-weight:500;box-shadow:0 2px 12px rgba(0,0,0,.25);animation:fadeIn .3s ease';
  banner.innerHTML = `
    <span>🆕 A new version of Atlas Tracker is available (${latestVersion}). Please refresh to get the latest features.</span>
    <button onclick="location.reload(true)" style="background:#fef3c7;color:#92400e;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">Refresh Now</button>
    <button onclick="document.getElementById('update-banner').remove()" title="Dismiss for now" style="background:transparent;border:1px solid rgba(255,255,255,.3);color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;cursor:pointer">Later</button>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
  document.body.style.paddingTop = '46px';
}

// Start polling when user is logged in
function _startUpdateChecker() {
  if(window._updateCheckerStarted) return;
  window._updateCheckerStarted = true;
  // Initial check after 30 seconds (give the app time to load)
  setTimeout(_checkForAppUpdate, 30000);
  // Then poll regularly
  setInterval(_checkForAppUpdate, UPDATE_CHECK_INTERVAL_MS);
}

// ── ERROR CODES ───────────────────────────────────────────────────────────────
// Standardized codes so users can quote them when reporting an issue.
// Format: <AREA>-<NUMBER>. Each code maps to a one-line explanation that
// gets shown alongside the technical error message in toasts.
const ERROR_CODES = {
  // Inventory
  'INV-001': 'Inventory save failed — Firestore write rejected',
  'INV-002': 'Inventory save did not persist — write succeeded locally but server has different data',
  // Cases (Finalize, supplies, CS log)
  'CASE-001': 'Case save failed — Firestore write rejected',
  'CASE-002': 'Case save did not persist — supplies/CS data may be lost',
  'CASE-003': 'Could not find case to update — refresh and try again',
  'CASE-004': 'Inventory deduction failed during case save',
  // Supplies (Quick Add modal on Finalize/Live)
  'SUPPLY-001': 'Applying supplies failed — please reopen the supplies modal',
  'SUPPLY-002': 'Selected supplies could not be matched to inventory — try refreshing the page',
  // Pre-Op
  'PREOP-001': 'Pre-Op save failed',
  'PREOP-002': 'Pre-Op record not found',
  'PREOP-003': 'Pre-Op status update failed (call/invoice/payment pills)',
  // Fax
  'FAX-001': 'Fax send failed via FAXAGE',
  'FAX-002': 'Invalid fax number',
  'FAX-003': 'Fax scheduler error',
  // Email
  'EMAIL-001': 'Email send failed via AWS SES',
  'EMAIL-002': 'Email address not verified (SES sandbox mode)',
  // Authentication
  'AUTH-001': 'Sign-in failed',
  'AUTH-002': 'Session expired — please sign in again',
  'AUTH-003': 'Permission denied for this action',
  // PHI redaction
  'PHI-001': 'PHI reveal failed — incorrect password',
  'PHI-002': 'PHI reveal failed — user not authorized to reveal',
  // Payments
  'PAY-001': 'Payment row save failed',
  'PAY-002': 'Payment row delete failed',
  // Portal / external
  'PORTAL-001': 'Portal token creation failed',
  'PORTAL-002': 'Portal token expired or invalid',
  // Backup / data
  'BACKUP-001': 'Backup download failed',
  'BACKUP-002': 'Daily backup write to Firestore failed',
  // Network / sync
  'NET-001': 'Network error — check your internet connection',
  'SYNC-001': 'Real-time sync interrupted'
};

// Throw a coded error or show a coded toast
// Convert any value to a readable string. Prevents "[object Object]"
// from showing up in error toasts.
function _formatErrorDetail(detail) {
  if(detail == null) return '';
  if(typeof detail === 'string') return detail;
  if(detail instanceof Error) return detail.message || detail.toString();
  if(typeof detail === 'object') {
    if(detail.message) return String(detail.message);
    if(detail.error) return String(detail.error);
    try { return JSON.stringify(detail).slice(0, 500); } catch(e) { return '[unserializable error object]'; }
  }
  return String(detail);
}

window.atlasError = function(code, detail, opts) {
  const msg = ERROR_CODES[code] || 'Unknown error';
  const detailStr = _formatErrorDetail(detail);
  const fullMessage = `[${code}] ${msg}` + (detailStr ? '\n→ ' + detailStr : '');
  console.error(fullMessage, detail);
  // Audit log so we can correlate the user's report with what actually happened
  try { if(typeof logAudit === 'function') logAudit('error-' + code, '', detailStr.slice(0, 500)); } catch(e){}
  if(typeof toastError === 'function') {
    toastError(fullMessage, Object.assign({ persist: true }, opts || {}));
  } else if(typeof alert === 'function') {
    alert(fullMessage);
  }
  return new Error(fullMessage);
};

// ── TOAST NOTIFICATIONS ───────────────────────────────────────────────────────
// Slide-in non-blocking notifications that replace many alert() calls.
// Errors PERSIST (no auto-dismiss) so users can read error codes carefully.
// Each toast has a copy button to copy the full message to clipboard.
function _ensureToastContainer() {
  let c = document.getElementById('toast-container');
  if(!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:380px;pointer-events:none';
    document.body.appendChild(c);
  }
  return c;
}

// toast(message, type, options)
//   type: 'success' | 'error' | 'warn' | 'info'
//   options.persist: true to keep visible until manually dismissed
//   options.duration: ms before auto-dismiss (default 4500 for non-errors)
window.toast = function(message, type, options) {
  type = type || 'info';
  options = options || {};
  const persist = options.persist !== undefined ? options.persist : (type === 'error');
  const duration = options.duration || 4500;
  const container = _ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = 'atlas-toast atlas-toast-' + type;
  const palette = {
    success: { bg:'#dcfce7', border:'#86efac', text:'#14532d', icon:'✓' },
    error:   { bg:'#fee2e2', border:'#fca5a5', text:'#991b1b', icon:'✕' },
    warn:    { bg:'#fef3c7', border:'#fde68a', text:'#78350f', icon:'⚠' },
    info:    { bg:'#dbeafe', border:'#bfdbfe', text:'#1e3a8a', icon:'ⓘ' }
  };
  const c = palette[type] || palette.info;
  toast.style.cssText = `background:${c.bg};border:1px solid ${c.border};border-left:4px solid ${c.border};border-radius:8px;padding:12px 14px;box-shadow:0 6px 20px rgba(15,23,42,.12);pointer-events:auto;display:flex;align-items:flex-start;gap:10px;font-size:13px;color:${c.text};animation:toastSlideIn .25s ease;max-width:380px`;
  const escaped = String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  toast.innerHTML = `
    <div style="font-size:16px;line-height:1;margin-top:2px;flex-shrink:0">${c.icon}</div>
    <div style="flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;line-height:1.5">${escaped}</div>
    <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;margin-left:4px">
      <button title="Copy message to clipboard" style="background:transparent;border:1px solid ${c.border};color:${c.text};font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;font-family:inherit">copy</button>
      <button title="Dismiss" style="background:transparent;border:none;color:${c.text};font-size:14px;line-height:1;padding:2px 6px;cursor:pointer;opacity:.7">✕</button>
    </div>`;
  const [copyBtn, closeBtn] = toast.querySelectorAll('button');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(message));
      copyBtn.textContent = 'copied';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
    } catch(e) { copyBtn.textContent = 'err'; }
  });
  closeBtn.addEventListener('click', () => _removeToast(toast));
  container.appendChild(toast);
  if(!persist) {
    setTimeout(() => _removeToast(toast), duration);
  }
  return toast;
};
function _removeToast(toast) {
  if(!toast || !toast.parentNode) return;
  toast.style.animation = 'toastSlideOut .2s ease forwards';
  setTimeout(() => { if(toast.parentNode) toast.remove(); }, 200);
}
// Convenience shorthands
window.toastSuccess = (msg, opts) => window.toast(msg, 'success', opts);
window.toastError   = (msg, opts) => window.toast(msg, 'error', opts);
window.toastWarn    = (msg, opts) => window.toast(msg, 'warn', opts);
window.toastInfo    = (msg, opts) => window.toast(msg, 'info', opts);

// ── TEST CASE ─────────────────────────────────────────────────────────────────
// Creates a clearly-labeled test pre-op record so users can test features
// without polluting real data. Test records are excluded from Dashboard
// stats, reports, and any aggregations (filter by !r.isTest).
window.createTestCase = async function() {
  if(!confirm('Create a TEST CASE? It will be clearly labeled and excluded from stats. You can delete it anytime.')) return;
  try {
    const snap = await getDoc(doc(db, 'atlas', 'preop'));
    const records = snap.exists() ? (snap.data().records || []) : [];
    const today = todayStr();
    const tomorrow = addDays(today, 1);
    const worker = currentWorker || 'josh';
    // Generate a TEST case ID
    const ts = Date.now().toString(36).slice(-5).toUpperCase();
    const caseId = `TEST-${worker.toUpperCase()}-${ts}`;
    const testRecord = {
      id: uid(),
      isTest: true, // KEY FLAG: excludes this from stats
      worker,
      savedAt: new Date().toISOString(),
      'po-caseId': caseId,
      'po-patientFirstName': 'Test',
      'po-patientLastName': 'Patient',
      'po-patientPhone': '(555) 123-4567',
      'po-patientDOB': '1980-01-01',
      'po-patientEmail': 'test@atlasanesthesia.co',
      'po-surgeryDate': tomorrow,
      'po-startTime': '09:00',
      'po-callDateTime': today + 'T10:00',
      'po-procedureType': '🧪 TEST — Sample Procedure',
      'po-provider': 'Dr. Test',
      'po-est-hours': 2,
      'po-allergies': 'NKDA (test data)',
      'po-medications': 'None (test data)',
      'po-surgicalHistory': 'None reported',
      'po-comments': 'This is a TEST CASE for app feature testing. Safe to delete.',
      'po-driverName': 'Test Driver',
      'po-driverRel': 'Family',
      'po-weight-lbs': 165,
      'po-height-ft': 5,
      'po-height-in': 10,
      'po-weight-kg-val': '74.8',
      'po-height-cm-val': '177.8',
      'po-bmi-val': '23.7',
      'mallampati': 'II',
      'po-npo': true,
      'po-driver': true,
      'po-pulm-neg': true,
      'po-cv-neg': true,
      'po-gastro-neg': true,
      'po-renal-neg': true,
      'po-neuro-neg': true,
      'po-meta-neg': true,
      'po-teeth-intact': true
    };
    records.unshift(testRecord);
    await savePreopRecords(records);
    toastSuccess('Test case created: ' + caseId + '\nAppears in Mid-Case with a 🧪 TEST badge. Excluded from stats.');
    if(typeof renderDashboard === 'function') renderDashboard();
  } catch(err) {
    alert('Error creating test case: ' + err.message);
    console.error(err);
  }
};

// ── CUSTOMIZABLE QUICK ACTIONS ────────────────────────────────────────────────
// All available actions. User picks which appear (and in what order) on Home.
const QUICK_ACTIONS_CATALOG = [
  { id: 'preop',       icon: '📝', label: 'New Pre-Op Assessment', action: () => showTab('preop') },
  { id: 'mid-case',    icon: '🩺', label: 'View Mid-Case',         action: () => showTab('mid-case') },
  { id: 'new-case',    icon: '✓',  label: 'Finalize a Case',       action: () => showTab('new-case') },
  { id: 'inventory',   icon: '📦', label: 'Manage Inventory',      action: () => showTab('inventory') },
  { id: 'payments',    icon: '💰', label: 'Payments',              action: () => { showTab('payments'); if(typeof loadPaymentRows === 'function') loadPaymentRows(); } },
  { id: 'calendar',    icon: '📅', label: 'Calendar',              action: () => showTab('calendar') },
  { id: 'centers',     icon: '🏥', label: 'Surgery Centers',       action: () => showTab('analytics') },
  { id: 'history',     icon: '📜', label: 'Case History',          action: () => showTab('history') },
  { id: 'reports',     icon: '📊', label: 'Inventory Reports',     action: () => showTab('reports') },
  { id: 'audit-log',   icon: '🔍', label: 'Audit Log',             action: () => { if(typeof openAuditLogModal === 'function') openAuditLogModal(); } },
  { id: 'surgery-mode',icon: '🏥', label: 'Toggle Surgery Mode',   action: () => { if(typeof toggleSurgeryMode === 'function') toggleSurgeryMode(); } },
  { id: 'backup',      icon: '⬇',  label: 'Download Backup',       action: () => { if(typeof window.downloadFullBackup === 'function') window.downloadFullBackup(); } },
  { id: 'test-case',   icon: '🧪', label: 'Create Test Case',      action: () => { if(typeof createTestCase === 'function') createTestCase(); } },
  { id: 'cs-log',      icon: '⚠',  label: 'Controlled Substance Log', action: () => showTab('cs-log') }
];
const DEFAULT_QUICK_ACTIONS = ['preop','mid-case','new-case','inventory','test-case'];

function _getQuickActions() {
  try {
    const saved = localStorage.getItem('atlas-quick-actions');
    if(saved) {
      const ids = JSON.parse(saved);
      if(Array.isArray(ids) && ids.length) return ids;
    }
  } catch(e){}
  return DEFAULT_QUICK_ACTIONS.slice();
}
function _saveQuickActions(ids) {
  try { localStorage.setItem('atlas-quick-actions', JSON.stringify(ids)); } catch(e){}
}

window.renderQuickActions = function() {
  const container = document.getElementById('quick-actions-list');
  if(!container) return;
  const ids = _getQuickActions();
  if(!ids.length) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-faint);font-style:italic;padding:10px 0">No quick actions configured. Click <strong>⚙ Customize</strong> to add some.</div>';
    return;
  }
  container.innerHTML = ids.map((id, idx) => {
    const a = QUICK_ACTIONS_CATALOG.find(x => x.id === id);
    if(!a) return '';
    const cls = idx === 0 ? 'btn btn-primary' : 'btn btn-ghost';
    return `<button class="${cls}" onclick="window._runQuickAction('${id}')" style="justify-content:flex-start">${a.icon} ${a.label}</button>`;
  }).join('');
};

window._runQuickAction = function(id) {
  const a = QUICK_ACTIONS_CATALOG.find(x => x.id === id);
  if(a) try { a.action(); } catch(e) { console.error('Quick action failed:', e); }
};

window.openQuickActionsCustomize = function() {
  const current = _getQuickActions();
  const existing = document.getElementById('qa-customize-modal');
  if(existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'qa-customize-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden">
    <div style="background:#1d3557;color:#fff;padding:18px 22px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Customize</div>
      <div style="font-size:17px;font-weight:700">Quick Actions</div>
      <div style="font-size:12px;color:#a8c4e0;margin-top:4px">Pick which actions appear on your Home page. The first action is shown as the primary (highlighted) button.</div>
    </div>
    <div style="padding:18px 22px;overflow-y:auto;flex:1">
      <div id="qa-options-list" style="display:flex;flex-direction:column;gap:6px"></div>
    </div>
    <div style="padding:14px 22px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;gap:8px">
      <button onclick="window._qaResetDefaults()" style="background:transparent;color:#64748b;border:1px solid #cbd5e1;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Reset to Default</button>
      <div style="display:flex;gap:8px">
        <button onclick="document.getElementById('qa-customize-modal').remove()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        <button onclick="window._qaSaveCustomization()" style="background:#1d3557;color:#fff;border:none;padding:9px 22px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Save</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
  _renderQuickActionsOptions(current);
};

function _renderQuickActionsOptions(currentIds) {
  const list = document.getElementById('qa-options-list');
  if(!list) return;
  // Show selected items first (in order), then unselected
  const selected = currentIds.map(id => QUICK_ACTIONS_CATALOG.find(a => a.id === id)).filter(Boolean);
  const unselected = QUICK_ACTIONS_CATALOG.filter(a => !currentIds.includes(a.id));
  const renderRow = (a, isSelected, order) => `<div data-action="${a.id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${isSelected?'#f0f9ff':'#fafaf9'};border:1px solid ${isSelected?'#bae6fd':'#e2e8f0'};border-radius:8px">
    <input type="checkbox" data-qa-cb="${a.id}" ${isSelected?'checked':''} onchange="window._qaToggleAction('${a.id}')" style="width:16px;height:16px;cursor:pointer;flex-shrink:0">
    <span style="font-size:16px;width:22px;text-align:center">${a.icon}</span>
    <span style="flex:1;font-size:13px;color:#1e293b;font-weight:${isSelected?'600':'500'}">${a.label}</span>
    ${isSelected ? `<div style="display:flex;gap:4px">
      <button onclick="window._qaMove('${a.id}',-1)" title="Move up" style="background:transparent;border:1px solid #cbd5e1;color:#475569;width:24px;height:24px;border-radius:5px;cursor:pointer;font-size:12px;padding:0">↑</button>
      <button onclick="window._qaMove('${a.id}',1)" title="Move down" style="background:transparent;border:1px solid #cbd5e1;color:#475569;width:24px;height:24px;border-radius:5px;cursor:pointer;font-size:12px;padding:0">↓</button>
    </div>` : ''}
  </div>`;
  list.innerHTML =
    (selected.length ? '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;letter-spacing:.5px;margin:0 0 6px">Showing on Home</div>' : '') +
    selected.map((a,i) => renderRow(a, true, i)).join('') +
    (unselected.length ? '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#94a3b8;letter-spacing:.5px;margin:14px 0 6px">Available</div>' : '') +
    unselected.map(a => renderRow(a, false)).join('');
}

let _qaWorking = null; // working copy of the IDs while modal is open
window._qaToggleAction = function(id) {
  if(!_qaWorking) _qaWorking = _getQuickActions();
  if(_qaWorking.includes(id)) _qaWorking = _qaWorking.filter(x => x !== id);
  else _qaWorking.push(id);
  _renderQuickActionsOptions(_qaWorking);
};
window._qaMove = function(id, dir) {
  if(!_qaWorking) _qaWorking = _getQuickActions();
  const i = _qaWorking.indexOf(id);
  if(i === -1) return;
  const j = i + dir;
  if(j < 0 || j >= _qaWorking.length) return;
  [_qaWorking[i], _qaWorking[j]] = [_qaWorking[j], _qaWorking[i]];
  _renderQuickActionsOptions(_qaWorking);
};
window._qaResetDefaults = function() {
  _qaWorking = DEFAULT_QUICK_ACTIONS.slice();
  _renderQuickActionsOptions(_qaWorking);
};
window._qaSaveCustomization = function() {
  const ids = _qaWorking || _getQuickActions();
  _saveQuickActions(ids);
  _qaWorking = null;
  const overlay = document.getElementById('qa-customize-modal');
  if(overlay) overlay.remove();
  if(typeof renderQuickActions === 'function') renderQuickActions();
  if(typeof toastSuccess === 'function') toastSuccess('Quick Actions saved');
};

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
// Safety: if data isn't loaded yet on first call, retry shortly.
let _dashboardRetried = false;
window.renderDashboard = function() {
  // If preop data hasn't loaded yet on initial render, retry once data arrives
  if(!_dashboardRetried && (!window._rawPreopRecords || window._rawPreopRecords.length === 0) && (!window.cases || window.cases.length === 0)) {
    _dashboardRetried = true;
    setTimeout(() => { _dashboardRetried = false; if(typeof renderDashboard === 'function') renderDashboard(); }, 1500);
  }
  // Continue with normal render (handles both empty and loaded cases)
  return _renderDashboardImpl();
};
function _renderDashboardImpl() {
  // Greeting + date
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = (window.currentUser && window.currentWorker === 'dev') ? 'Dev' : (window.currentWorker === 'josh' ? 'Josh' : '');
  const greetEl = document.getElementById('dashboard-greeting');
  if(greetEl) greetEl.textContent = name ? `${greeting}, ${name}` : greeting;
  const dateEl = document.getElementById('dashboard-date');
  if(dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });

  const today = (typeof todayStr === 'function') ? todayStr() : new Date().toISOString().split('T')[0];
  const weekOut = (typeof addDays === 'function') ? addDays(today, 7) : '';

  // Today's cases (from pre-op records, since pre-ops have surgery dates)
  // Filter out test cases — they should never count toward real stats.
  const allPreops = (window._rawPreopRecords || []).filter(r => !r.isTest);
  const todayCases = allPreops.filter(r => r['po-surgeryDate'] === today);
  const weekCases = allPreops.filter(r => {
    const d = r['po-surgeryDate'];
    return d && d >= today && d <= weekOut;
  });
  const todayCountEl = document.getElementById('dash-today-count');
  if(todayCountEl) todayCountEl.textContent = todayCases.length;
  const todaySubEl = document.getElementById('dash-today-sub');
  if(todaySubEl) todaySubEl.textContent = todayCases.length === 0 ? 'No cases today' : (todayCases.length === 1 ? '1 case scheduled' : `${todayCases.length} cases scheduled`);
  const weekCountEl = document.getElementById('dash-week-count');
  if(weekCountEl) weekCountEl.textContent = weekCases.length;

  // Today + Tomorrow list — same card, two sections separated by a divider.
  const todayListEl = document.getElementById('dash-today-list');
  if(todayListEl) {
    const _addDays = (yyyymmdd, n) => {
      const d = new Date(yyyymmdd + 'T00:00:00');
      d.setDate(d.getDate() + n);
      return d.toISOString().split('T')[0];
    };
    const tomorrow = _addDays(today, 1);
    const tomorrowCases = allPreops.filter(r => r['po-surgeryDate'] === tomorrow);
    const byTime = (a, b) => (a['po-startTime']||'').localeCompare(b['po-startTime']||'');
    todayCases.sort(byTime);
    tomorrowCases.sort(byTime);

    const renderRow = (r) => {
      const id = (typeof window.getCaseDisplayIdFromPreop === 'function') ? window.getCaseDisplayIdFromPreop(r) : r['po-caseId'];
      const time = r['po-startTime'] || '';
      const provider = r['po-provider'] || '';
      const workerName = r.worker === 'dev' ? 'Dev' : 'Josh';
      const pillClass = r.worker === 'dev' ? 'pill-dev' : 'pill-josh';
      const caseId = r['po-caseId'] || '';
      const label = (id || caseId || '—').replace(/'/g, '&#39;');
      return `<div onclick="openCaseActionModal('${r.id}','${caseId}','${label}')" style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;cursor:pointer;transition:background .12s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'" title="Open Pre-Op or Finalize Case"><span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--text-faint);min-width:60px">${time || '—'}</span><div style="flex:1"><div style="font-size:13px;font-weight:600">${id || '—'}</div><div style="font-size:11px;color:var(--text-faint)">${provider || '—'}</div></div><span class="worker-pill ${pillClass}" style="font-size:10px">${workerName}</span></div>`;
    };
    const sectionHeader = (label, top) => `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-faint);padding:${top?'12px 0 4px':'4px 0'};${top?'border-top:1px dashed var(--border);margin-top:6px':''}">${label}</div>`;
    const emptyRow = (label) => `<div style="color:var(--text-faint);font-style:italic;padding:8px 0">No cases scheduled for ${label}.</div>`;

    let html = sectionHeader('Today', false);
    html += todayCases.length ? todayCases.map(renderRow).join('') : emptyRow('today');
    html += sectionHeader('Tomorrow', true);
    html += tomorrowCases.length ? tomorrowCases.map(renderRow).join('') : emptyRow('tomorrow');
    todayListEl.innerHTML = html;
  }

  // Unpaid deposits count
  const deposits = (window._depositsCache || []);
  const unpaidCount = deposits.filter(d => !d.paid).length;
  const unpaidEl = document.getElementById('dash-unpaid-count');
  if(unpaidEl) unpaidEl.textContent = unpaidCount;

  // Low inventory
  // Scope the low-inventory count to the logged-in worker only — each CRNA
  // manages their own stock and doesn't need the other person's alerts on
  // their home screen.
  const items = (window.items || []);
  const me = (typeof currentWorker !== 'undefined' ? currentWorker : '') || 'dev';
  const myStockKey = me === 'josh' ? 'stockJosh' : 'stockDev';
  let lowCount = 0;
  items.forEach(i => {
    const alert = parseFloat(i.alert) || 0;
    const myStock = parseFloat(i[myStockKey]) || 0;
    if(alert > 0 && myStock <= alert) lowCount++;
  });
  const lowEl = document.getElementById('dash-lowstock-count');
  if(lowEl) lowEl.textContent = lowCount;

  // Ensure payment rows are loaded so the deposit / remaining toggles work
  // from the Home page's Follow-up Tracker (they're only auto-loaded when
  // navigating to the Payments tab otherwise).
  if((!window._paymentRows || !window._paymentRows.length) && typeof window.loadPaymentRows === 'function') {
    window.loadPaymentRows().then(() => {
      if(typeof window.renderFollowupTab === 'function') window.renderFollowupTab();
    }).catch(() => {});
  }
  // Prime the deposits cache so the Follow-up Tracker can show "Sent /
  // awaiting" and "Paid" pills on first paint after a page reload. Without
  // this, _depositsCache is only populated once the user opens the deposit
  // modal, so cases that paid through Stripe would appear "Not Sent" again
  // until the user opened that modal.
  if((!window._depositsCache || !window._depositsCache.length) && typeof window._loadDeposits === 'function') {
    window._loadDeposits().then(() => {
      if(typeof window.renderFollowupTab === 'function') window.renderFollowupTab();
    }).catch(() => {});
  }
  // Render customizable Quick Actions
  if(typeof window.renderQuickActions === 'function') {
    try { window.renderQuickActions(); } catch(e) { console.warn('renderQuickActions failed:', e); }
  }
  // Render the embedded Follow-up Tracker (now on Home instead of Recent Activity)
  if(typeof window.renderFollowupTab === 'function') {
    try { window.renderFollowupTab(); } catch(e) { console.warn('renderFollowupTab failed:', e); }
  }
  // Recent activity (kept for backward compatibility if the element exists)
  const auditList = document.getElementById('dash-activity-list');
  if(auditList) {
    const log = window._auditLogCache || [];
    if(!log.length) {
      auditList.innerHTML = '<div style="color:var(--text-faint);font-style:italic;padding:8px 0">Activity will appear here as you use the app.</div>';
    } else {
      auditList.innerHTML = log.slice(0, 12).map(e => {
        const when = e.timestamp ? new Date(e.timestamp).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
        const who = (e.email || '').split('@')[0] || '—';
        const targetHTML = e.target ? ` <span style="color:var(--text-muted);font-family:monospace">${e.target}</span>` : '';
        return `<div style="padding:6px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;font-size:12px"><div><span style="color:var(--text-faint)">${who}</span> <span style="color:var(--text)">${e.action || ''}</span>${targetHTML}</div><span style="color:var(--text-faint);font-size:11px;white-space:nowrap">${when}</span></div>`;
      }).join('');
    }
  }
};

const _DROPDOWN_GROUPS = {
  'setup-dropdown-btn': ['inventory','calendar','analytics','payout'],
  'reports-dropdown-btn': ['history','caselog','cs-log','reports']
};
function _updateNavActiveState(tabName) {
  Object.entries(_DROPDOWN_GROUPS).forEach(([btnId, tabs]) => {
    const btn = document.getElementById(btnId);
    if(btn) btn.classList.toggle('active', tabs.includes(tabName));
  });
  // Standalone (visible) nav buttons
  const standaloneTabs = { 'nav-home':'home', 'nav-preop':'preop', 'nav-mid-case':'mid-case', 'nav-new-case':'new-case', 'nav-payments':'payments', 'nav-live-case':'live-case' };
  Object.entries(standaloneTabs).forEach(([btnId, tab]) => {
    const btn = document.getElementById(btnId);
    if(btn) btn.classList.toggle('active', tabName === tab);
  });
  // Refresh dashboard data when navigating to it
  if(tabName === 'home' && typeof window.renderDashboard === 'function') {
    window.renderDashboard();
  }
}
// Wrap showTab to update active state on the dropdown parent
const _origShowTab = window.showTab;
window.showTab = function(name, pushState) {
  // Role guards — restricted roles can only open their allowed tabs.
  if(window._userRole === 'assistant' && !ASSISTANT_TABS.includes(name)) {
    name = 'preop';
    pushState = false;
  } else if(window._userRole === 'scheduler' && !SCHEDULER_TABS.includes(name)) {
    name = 'calendar';
    pushState = false;
  }
  if(typeof _origShowTab === 'function') _origShowTab(name, pushState);
  _updateNavActiveState(name);
};
// Initialize active state for whatever tab is showing on load
setTimeout(() => {
  const activeSection = document.querySelector('.section.active');
  if(activeSection) _updateNavActiveState(activeSection.id.replace('tab-', ''));
}, 100);



// -- Global exposure for split script files -----------------------------------
// Firebase functions needed by fax.js and payments.js
window.getDoc = getDoc;
window.setDoc = setDoc;
window.deleteDoc = deleteDoc;
window.doc = doc;
window.onSnapshot = onSnapshot;
// fax.js, payments.js, anesthesia.js access these via window.*
window.db = db;
window.uid = uid;
window.setSyncing = setSyncing;
window._generateFlatRateInvoicePDF = _generateFlatRateInvoicePDF;

// Helpers/state needed by quickadd.js (bundles + Quick Add modals)
window.getStock = getStock;
window.isCSItem = isCSItem;
window.linkCSInvIds = linkCSInvIds;
window.CS_DRUGS = CS_DRUGS;
window.getCostPerMG = getCostPerMG;
window.renderCaseSupplies = renderCaseSupplies;
window.renderCSEntries = renderCSEntries;
window.refreshItemSelect = refreshItemSelect;

// For reassignable variables, use property descriptors so window always reflects current value
Object.defineProperty(window, 'cases', {
  get: () => cases, set: v => { cases = v; }, configurable: true
});
Object.defineProperty(window, 'currentWorker', {
  get: () => currentWorker, set: v => { currentWorker = v; }, configurable: true
});
Object.defineProperty(window, 'currentInvTab', {
  get: () => currentInvTab, set: v => { currentInvTab = v; }, configurable: true
});
Object.defineProperty(window, 'items', {
  get: () => items, set: v => { items = v; }, configurable: true
});
Object.defineProperty(window, 'caseItems', {
  get: () => caseItems, set: v => { caseItems = v; }, configurable: true
});
Object.defineProperty(window, 'csEntries', {
  get: () => csEntries, set: v => { csEntries = v; }, configurable: true
});

// ── Offline / Online indicator ──────────────────────────────────────────────
// Tiny pill in the top-right corner that lights up when the browser loses
// network. Firebase offline persistence keeps the app working: writes queue
// in IndexedDB, reads come from cache. We still want the user to *know*
// they're offline so they don't panic when emails / faxes / Stripe sync
// don't fire (those need internet — only Firestore is offline-safe).
(function installOfflineIndicator() {
  if(document.getElementById('netStatusPill')) return;
  const pill = document.createElement('div');
  pill.id = 'netStatusPill';
  pill.style.cssText = 'position:fixed;top:14px;right:14px;z-index:99998;background:#fef2f2;color:#991b1b;border:1px solid #fca5a5;font-size:11px;font-weight:700;padding:6px 11px;border-radius:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.08);display:none;align-items:center;gap:6px;pointer-events:none';
  pill.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626"></span> Offline — changes will sync when you\'re back online';
  document.body.appendChild(pill);
  const update = () => {
    if(navigator.onLine) {
      pill.style.display = 'none';
    } else {
      pill.style.display = 'inline-flex';
    }
  };
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
})();
