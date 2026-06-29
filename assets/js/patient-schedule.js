// patient-schedule.js — Atlas Anesthesia patient portal.
//
// Three sequential gates the patient walks through after Nicole sends them
// the portal link (with ?t=<tracker-entry-id>):
//
//   1) PHOTOS — six airway-assessment angles. HEIC inputs are converted to
//      JPG client-side. Each image is downscaled + JPEG-compressed and saved
//      to its own Firestore doc so we stay well under the 1 MB per-doc cap.
//   2) PAYMENT — $100 Stripe link. We poll /stripe-check for the patient's
//      email; once it flips paid the gate unlocks. Manual paid stamps from
//      Nicole's side (e.g. card taken over the phone) also unlock it.
//   3) SCHEDULE — 15-min slot picker over Jordan's published availability.
//      Booking re-reads the entries doc to avoid double-booking.
//
// On confirmation we stamp the entry and fire emails to the patient, Jordan,
// and admin via the worker's /outreach-email endpoint.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAAY9Ajrx4PJRqhxW5MgRY3wgZni9rJhMo",
  authDomain: "atlas-ane.firebaseapp.com",
  projectId: "atlas-ane",
  storageBucket: "atlas-ane.firebasestorage.app",
  messagingSenderId: "677020713040",
  appId: "1:677020713040:web:07f52f77fd225c607a5155"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev';
const STRIPE_LINK = 'https://buy.stripe.com/7sY28q4dF5JrfSI6aZejK03';

// Six required photos. Order + copy comes straight from the instruction
// sheet — keep the labels short, the bullets actionable.
const ANGLES = [
  { key: 'neckExt',  label: 'Neck extended', bullets: ['Tilt head back as far as comfortably possible.', 'Look up toward the ceiling.', 'Camera in front of you.', 'Top of chest to top of head.'] },
  { key: 'profile',  label: 'Profile (side)', bullets: ['Turn so the camera sees your side.', 'Head in a natural, neutral position.', 'Camera at eye level.', 'Top of chest to top of head.'] },
  { key: 'straight', label: 'Straight on',    bullets: ['Look straight ahead.', 'Head in a natural, neutral position.', 'Camera at eye level.', 'Top of chest to top of head.'] },
  { key: 'right',    label: 'Head turned right', bullets: ['Turn your head as far right as comfortable.', 'Keep eyes level, face relaxed.', 'Camera in front of you.', 'Top of chest to top of head.'] },
  { key: 'left',     label: 'Head turned left',  bullets: ['Turn your head as far left as comfortable.', 'Keep eyes level, face relaxed.', 'Camera in front of you.', 'Top of chest to top of head.'] },
  { key: 'throat',   label: 'Back of the throat', bullets: ['Open your mouth wide.', 'Stick your tongue out and say "ahh".', 'Camera in front of you.', 'Top of chest to top of head.'] }
];

const PHOTO_MAX_DIMENSION = 1400;   // longest side, in px
const PHOTO_JPEG_QUALITY  = 0.82;   // ~80-300 KB per photo after resize

// ── helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDate     = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }) : '';
const fmtDateShort= iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }) : '';
const fmtTime     = t   => t ? new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '';
function expand15(start, end) {
  if(!start || !end || !start.includes(':') || !end.includes(':')) return [];
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if([sh,sm,eh,em].some(n => Number.isNaN(n))) return [];
  const s = sh*60 + sm, e = eh*60 + em;
  const out = [];
  for(let m = s; m + 15 <= e; m += 15) out.push(String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0'));
  return out;
}
function setBootError(msg) {
  $('boot-state').classList.add('hidden');
  $('boot-error').classList.remove('hidden');
  $('boot-error').innerHTML = '<div class="alert err">' + esc(msg) + '</div>';
}

// ── module state ───────────────────────────────────────────────────────────
let _entry = null;          // matching preop_visits entry
let _allEntries = [];       // full entries array (for double-book check)
let _entryId = '';          // token from URL
let _selected = null;       // chosen { date, time }
let _slots = {};            // Jordan's availability slots map

// ── boot: read token from URL, fetch the entry ────────────────────────────
(async function boot() {
  try {
    const params = new URLSearchParams(window.location.search);
    _entryId = params.get('t') || '';
    if(!_entryId) {
      setBootError("This link is missing the patient token. Please use the link from your Atlas Anesthesia email, or reply to it for a new one.");
      return;
    }
    const snap = await getDoc(doc(db, 'atlas', 'preop_visits'));
    const entries = snap.exists() ? (snap.data().entries || []) : [];
    _allEntries = entries;
    _entry = entries.find(e => e.id === _entryId);
    if(!_entry) {
      setBootError("We couldn't find your record. Reply to the email we sent you and we'll get a fresh link out to you.");
      return;
    }
    // Personalize the header.
    const name = (_entry.patientFirst || '').trim();
    if(name) $('hdr-title').textContent = 'Hi ' + name + " — let's set up your pre-op visit";
    // If already scheduled, jump straight to confirmation view.
    if(_entry.scheduledAt && _entry.date && _entry.time) {
      $('boot-state').classList.add('hidden');
      $('steps-wrap').classList.add('hidden');
      showConfirm({ date: _entry.date, time: _entry.time });
      return;
    }
    $('boot-state').classList.add('hidden');
    $('steps-wrap').classList.remove('hidden');
    renderPhotos();
    renderPayment();
    renderSchedule();
    refreshStripeStatus();   // fire-and-forget initial check
  } catch(err) {
    console.error('boot failed', err);
    const msg = err && (err.code === 'permission-denied' || /permission/i.test(err.message || ''))
      ? "We're temporarily unable to load your record (database is locked). Reply to the email we sent you and we'll get this fixed."
      : 'Something went wrong loading your record (' + (err.message || err.code || 'unknown error') + '). Try refreshing the page.';
    setBootError(msg);
  }
})();

// ══════════════════════════════════════════════════════════════════════════
// STEP 1: PHOTOS
// ══════════════════════════════════════════════════════════════════════════
function renderPhotos() {
  const grid = $('photo-grid');
  const status = _entry.photoStatus || {};
  grid.innerHTML = ANGLES.map((a, i) => {
    const uploaded = !!(status[a.key] && status[a.key].uploadedAt);
    const filename = uploaded ? status[a.key].filename : '';
    return `<div class="photo-card${uploaded ? ' uploaded' : ''}" id="photo-card-${a.key}">
      <div class="photo-num-row"><span class="photo-num">${i+1}</span><span class="photo-label">${esc(a.label)}</span></div>
      <ul>${a.bullets.map(b => '<li>' + esc(b) + '</li>').join('')}</ul>
      <input type="file" class="photo-input" accept="image/*,.heic,.heif" data-angle="${a.key}">
      <img class="photo-preview ${uploaded ? '' : 'hidden'}" id="photo-preview-${a.key}" alt="${esc(a.label)} preview">
      <div class="check">✓ Uploaded${filename ? ' · ' + esc(filename) : ''}</div>
    </div>`;
  }).join('');
  // For already-uploaded photos, load + render the preview from Firestore
  // so the patient sees what they sent on a return visit.
  ANGLES.forEach(async a => {
    if(!status[a.key]) return;
    try {
      const ps = await getDoc(doc(db, 'atlas', 'preop_photos_' + _entryId + '_' + a.key));
      if(ps.exists()) {
        const dataUrl = ps.data().dataUrl;
        const img = $('photo-preview-' + a.key);
        if(img) img.src = dataUrl;
      }
    } catch(_) {}
  });
  // Wire file inputs
  grid.querySelectorAll('.photo-input').forEach(inp => {
    inp.addEventListener('change', e => handlePhotoUpload(inp.dataset.angle, e.target.files[0]));
  });
  updatePhotosStatus();
}

async function handlePhotoUpload(angleKey, file) {
  if(!file) return;
  const card = $('photo-card-' + angleKey);
  card.classList.remove('uploaded');
  const img = $('photo-preview-' + angleKey);
  if(img) { img.classList.add('hidden'); img.src = ''; }
  const checkEl = card.querySelector('.check');
  if(checkEl) checkEl.textContent = 'Processing…';
  try {
    let blob = file;
    const name = (file.name || '').toLowerCase();
    const isHeic = file.type === 'image/heic' || file.type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif');
    if(isHeic) {
      if(typeof window.heic2any !== 'function') {
        throw new Error('HEIC converter not loaded yet. Try again in a few seconds.');
      }
      blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: PHOTO_JPEG_QUALITY });
      if(Array.isArray(blob)) blob = blob[0];
    }
    // Downscale + re-encode to JPEG (regardless of source type) so each photo
    // fits comfortably under the 1 MB Firestore doc limit.
    const jpgDataUrl = await downscaleToJpeg(blob, PHOTO_MAX_DIMENSION, PHOTO_JPEG_QUALITY);
    // Save the photo to its own doc.
    const docId = 'preop_photos_' + _entryId + '_' + angleKey;
    const sizeBytes = Math.ceil((jpgDataUrl.length - jpgDataUrl.indexOf(',') - 1) * 0.75);
    await setDoc(doc(db, 'atlas', docId), {
      filename: file.name || (angleKey + '.jpg'),
      dataUrl: jpgDataUrl,
      contentType: 'image/jpeg',
      sizeBytes,
      uploadedAt: new Date().toISOString()
    });
    // Update the entry's photoStatus and persist. Use the freshest entries
    // copy so we don't clobber any other in-flight edits.
    const snap = await getDoc(doc(db, 'atlas', 'preop_visits'));
    const entries = snap.exists() ? (snap.data().entries || []) : [];
    const idx = entries.findIndex(e => e.id === _entryId);
    if(idx === -1) throw new Error('Record lost during upload — please refresh.');
    const ps = entries[idx].photoStatus || {};
    ps[angleKey] = { filename: file.name || (angleKey + '.jpg'), uploadedAt: new Date().toISOString() };
    entries[idx].photoStatus = ps;
    await setDoc(doc(db, 'atlas', 'preop_visits'), { entries });
    _allEntries = entries;
    _entry = entries[idx];
    // Update UI
    card.classList.add('uploaded');
    if(img) { img.src = jpgDataUrl; img.classList.remove('hidden'); }
    if(checkEl) checkEl.textContent = '✓ Uploaded · ' + (file.name || angleKey + '.jpg');
    updatePhotosStatus();
  } catch(err) {
    console.error('photo upload failed', err);
    if(checkEl) checkEl.textContent = '';
    alert('Could not upload ' + angleKey + ': ' + (err.message || err) + '\n\nTry again, or pick a different photo.');
  }
}

function downscaleToJpeg(blob, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const jpg = canvas.toDataURL('image/jpeg', quality);
        URL.revokeObjectURL(url);
        resolve(jpg);
      } catch(e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
    img.src = url;
  });
}

function updatePhotosStatus() {
  const status = _entry.photoStatus || {};
  const done = ANGLES.filter(a => status[a.key]).length;
  const pill = $('photos-status');
  if(done === 0) { pill.className = 'step-status pending'; pill.textContent = '0 / 6 uploaded'; }
  else if(done < 6) { pill.className = 'step-status inprogress'; pill.textContent = done + ' / 6 uploaded'; }
  else { pill.className = 'step-status done'; pill.textContent = 'All 6 uploaded'; }
  // Toggle step lock state
  $('step-photos').classList.toggle('done', done === 6);
  if(done === 6) {
    $('step-pay').classList.remove('locked');
  } else {
    $('step-pay').classList.add('locked');
    $('step-sched').classList.add('locked');
  }
  // In-step "you must finish the previous step" banners. CSS already greys
  // out locked steps, but the banner makes the *reason* unmissable.
  const payNotice = $('pay-locked-notice');
  if(payNotice) payNotice.style.display = (done === 6) ? 'none' : 'block';
  const schedNotice = $('sched-locked-notice');
  if(schedNotice) schedNotice.style.display = (done === 6 && _entry._paid) ? 'none' : 'block';
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 2: PAYMENT
// ══════════════════════════════════════════════════════════════════════════
function renderPayment() {
  $('pay-link').href = STRIPE_LINK;
  $('pay-refresh-btn').addEventListener('click', refreshStripeStatus);
  updatePayUI();
}

async function refreshStripeStatus() {
  const btn = $('pay-refresh-btn');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    // Manual paid stamp from the internal team also unlocks the gate.
    if(_entry.manualPaidAt) { _entry._paid = true; updatePayUI(); return; }
    if(!_entry.patientEmail) { _entry._paid = false; updatePayUI(); return; }
    const res = await fetch(WORKER_URL + '/stripe-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerEmail: _entry.patientEmail, caseId: _entry.caseId || '' })
    });
    if(!res.ok) { updatePayUI(); return; }
    const data = await res.json();
    _entry._paid = !!data.preopVisitPaid;
    updatePayUI();
    // If we just confirmed payment, persist the flag to Firestore so the
    // worker's daily reminder cron stops nagging. Before this, the cron had
    // to re-look-up Stripe by email — any case mismatch (different email,
    // +tag, etc.) meant the patient kept getting reminders even after they
    // paid. Now the portal IS the source of truth and writes the flag once
    // confirmed.
    if(_entry._paid && !_entry.preopVisitPaidConfirmed) {
      try {
        const snap = await getDoc(doc(db, 'atlas', 'preop_visits'));
        const entries = snap.exists() ? (snap.data().entries || []) : [];
        const idx = entries.findIndex(x => x.id === _entry.id);
        if(idx !== -1) {
          entries[idx].preopVisitPaidConfirmed = true;
          entries[idx].preopVisitPaidAt = data.preopVisitPaidAt || new Date().toISOString();
          entries[idx].preopVisitPaidAmount = data.preopVisitAmount || 100;
          await setDoc(doc(db, 'atlas', 'preop_visits'), { entries });
          _entry.preopVisitPaidConfirmed = true;
          _allEntries = entries;
        }
      } catch(persistErr) { console.warn('failed to persist paid flag:', persistErr); }
    }
  } catch(_) {
    // leave previous state
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

function updatePayUI() {
  const photosDone = (_entry.photoStatus && ANGLES.every(a => _entry.photoStatus[a.key]));
  const paid = !!_entry._paid;
  const statusEl = $('pay-status');
  const pill = $('pay-status-pill');
  if(paid) {
    statusEl.className = 'pay-status paid';
    statusEl.textContent = '✓ Payment confirmed — thanks!';
    pill.className = 'step-status done';
    pill.textContent = 'Paid';
    $('step-pay').classList.add('done');
    if(photosDone) $('step-sched').classList.remove('locked');
  } else {
    statusEl.className = 'pay-status pending';
    statusEl.textContent = '⏳ Payment pending';
    pill.className = 'step-status pending';
    pill.textContent = 'Pending';
    $('step-pay').classList.remove('done');
    $('step-sched').classList.add('locked');
  }
  // Keep the locked-step banner accurate when payment state changes too.
  const schedNotice = $('sched-locked-notice');
  if(schedNotice) schedNotice.style.display = (photosDone && paid) ? 'none' : 'block';
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 3: SCHEDULE
// ══════════════════════════════════════════════════════════════════════════
async function renderSchedule() {
  try {
    const snap = await getDoc(doc(db, 'atlas', 'availability'));
    const data = snap.exists() ? snap.data() : {};
    _slots = (data && data.jordan && data.jordan.slots) || {};
  } catch(_) {}
  paintSlots();
  $('book-btn').addEventListener('click', confirmBooking);
  // Terms & Privacy Acknowledgment + Anesthesia Informed Consent —
  // patients must check BOTH boxes AND have a slot selected before the
  // Confirm button enables.
  const tcb = $('terms-checkbox');
  if(tcb) tcb.addEventListener('change', _refreshBookBtn);
  const tr  = $('terms-readmore');
  if(tr)  tr.addEventListener('click', e => { e.preventDefault(); _openTermsModal(); });
  const tc1 = $('terms-modal-close');
  if(tc1) tc1.addEventListener('click', _closeTermsModal);
  const tc2 = $('terms-modal-close-2');
  if(tc2) tc2.addEventListener('click', _closeTermsModal);
  const tm  = $('terms-modal');
  if(tm)  tm.addEventListener('click', e => { if(e.target === tm) _closeTermsModal(); });

  // Anesthesia consent — checkbox is read-only. Patient must open the
  // modal, sign in the canvas, and click "I Agree & Sign" — only then
  // does the checkbox auto-tick and the signature get stored in memory.
  const ccb = $('consent-checkbox');
  if(ccb) {
    ccb.disabled = true; // can't be checked directly
    ccb.addEventListener('click', e => {
      // Force the user through the modal.
      e.preventDefault();
      _openConsentModal();
    });
  }
  const cr   = $('consent-readmore');
  if(cr)   cr.addEventListener('click', e => { e.preventDefault(); _openConsentModal(); });
  const cc1 = $('consent-modal-close');     // ✕ in header
  if(cc1)  cc1.addEventListener('click', _closeConsentModal);
  const ccn = $('consent-modal-cancel');    // Cancel in footer
  if(ccn)  ccn.addEventListener('click', _closeConsentModal);
  const cag = $('consent-modal-agree');     // I Agree & Sign
  if(cag)  cag.addEventListener('click', _onConsentAgree);
  const cm  = $('consent-modal');
  if(cm)   cm.addEventListener('click', e => { if(e.target === cm) _closeConsentModal(); });
  // Click on the consent box label (not the disabled checkbox) opens modal.
  const cBox = $('consent-box');
  if(cBox) cBox.querySelector('label')?.addEventListener('click', e => {
    e.preventDefault();
    _openConsentModal();
  });
  _initSignaturePad();
}

// ── Signature pad ─────────────────────────────────────────────────────────
let _sigCtx, _sigDrawing = false, _sigHasInk = false, _sigDataUrl = '';
let _sigListenersBound = false;
// Resize the backing pixels of the signature canvas to match its visible
// CSS size. Must be called AFTER the consent modal becomes visible —
// when called while hidden, getBoundingClientRect() returns 0×0 and the
// canvas gets clamped to 1×1, which produced blank PNG signatures.
function _resizeSignatureCanvas() {
  const c = $('sig-canvas');
  if(!c) return;
  const ratio = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  if(rect.width === 0) return; // still hidden, nothing to size to
  c.width  = Math.max(1, Math.round(rect.width  * ratio));
  c.height = Math.max(1, Math.round(rect.height * ratio));
  _sigCtx = c.getContext('2d');
  _sigCtx.scale(ratio, ratio);
  _sigCtx.lineWidth   = 2.5;
  _sigCtx.lineCap     = 'round';
  _sigCtx.lineJoin    = 'round';
  _sigCtx.strokeStyle = '#0f172a';
  _sigHasInk = false;
  _updateSigStatus();
}
function _initSignaturePad() {
  const c = $('sig-canvas');
  if(!c) return;
  _resizeSignatureCanvas();
  if(_sigListenersBound) return;
  _sigListenersBound = true;
  const pos = (ev) => {
    const r = c.getBoundingClientRect();
    const t = ev.touches ? ev.touches[0] : ev;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = (ev) => { ev.preventDefault(); _sigDrawing = true; const p = pos(ev); _sigCtx.beginPath(); _sigCtx.moveTo(p.x, p.y); };
  const move  = (ev) => { if(!_sigDrawing) return; ev.preventDefault(); const p = pos(ev); _sigCtx.lineTo(p.x, p.y); _sigCtx.stroke(); _sigHasInk = true; _updateSigStatus(); };
  const end   = (ev) => { if(!_sigDrawing) return; _sigDrawing = false; _sigCtx.closePath(); };
  c.addEventListener('mousedown',  start);
  c.addEventListener('mousemove',  move);
  c.addEventListener('mouseup',    end);
  c.addEventListener('mouseleave', end);
  c.addEventListener('touchstart', start, { passive: false });
  c.addEventListener('touchmove',  move,  { passive: false });
  c.addEventListener('touchend',   end);
  $('sig-clear')?.addEventListener('click', _clearSignature);
}
function _clearSignature() {
  if(!_sigCtx) return;
  const c = $('sig-canvas');
  _sigCtx.clearRect(0, 0, c.width, c.height);
  _sigHasInk = false;
  _updateSigStatus();
}
function _updateSigStatus() {
  const agree  = $('consent-modal-agree');
  const status = $('sig-status');
  if(_sigHasInk) {
    if(status) { status.textContent = '✓ Signature captured.'; status.style.color = '#166534'; }
    if(agree)  { agree.disabled = false; agree.style.opacity = ''; agree.style.cursor = ''; }
  } else {
    if(status) { status.textContent = 'Please sign above before agreeing.'; status.style.color = ''; }
    if(agree)  { agree.disabled = true;  agree.style.opacity = '.55'; agree.style.cursor = 'not-allowed'; }
  }
}
function _onConsentAgree() {
  if(!_sigHasInk) return;
  const c = $('sig-canvas');
  // Flatten onto white so the PNG attachment isn't transparent. Some mail
  // clients render a transparent PNG against their dark theme background
  // — which makes dark-navy ink basically invisible.
  const flat = document.createElement('canvas');
  flat.width = c.width;
  flat.height = c.height;
  const fctx = flat.getContext('2d');
  fctx.fillStyle = '#ffffff';
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(c, 0, 0);
  _sigDataUrl = flat.toDataURL('image/png');
  const ccb = $('consent-checkbox');
  if(ccb) { ccb.checked = true; }
  _closeConsentModal();
  _refreshBookBtn();
}

function _openTermsModal()   { const m = $('terms-modal'); if(m) m.classList.remove('hidden'); }
function _closeTermsModal()  { const m = $('terms-modal'); if(m) m.classList.add('hidden'); }
function _openConsentModal() {
  const m = $('consent-modal');
  if(m) m.classList.remove('hidden');
  // Resize the canvas every time the modal opens — first open sized to 0×0
  // while still hidden, so without this the captured PNG was 1×1 blank.
  setTimeout(_resizeSignatureCanvas, 30);
}
function _closeConsentModal(){ const m = $('consent-modal'); if(m) m.classList.add('hidden'); }
function _termsAccepted()   { return !!($('terms-checkbox')?.checked); }
function _consentAccepted() { return !!($('consent-checkbox')?.checked); }
function _refreshBookBtn()  {
  const btn = $('book-btn');
  if(!btn) return;
  btn.disabled = !(_selected && _termsAccepted() && _consentAccepted());
}

function paintSlots() {
  const taken = new Set();
  _allEntries.forEach(e => {
    if(e.date && e.time) taken.add(e.date + ' ' + e.time);
  });
  const surgIso = _entry.surgeryDate || '';
  const todayIso = new Date().toISOString().split('T')[0];
  // Patients have to book at least 48 hours out — same-day or next-day spots
  // don't give Jordan enough time to prep, and we had one patient grab a
  // 1:00 PM slot at 12:45 PM. cutoffMs is a wall-clock timestamp; the slot
  // datetime is built from the slot's date + time assuming the patient's
  // local clock matches Central (where the slots are published).
  const MIN_LEAD_MS = 48 * 60 * 60 * 1000;
  const cutoffMs = Date.now() + MIN_LEAD_MS;

  const grouped = {};
  Object.keys(_slots).sort().forEach(date => {
    if(date < todayIso) return;
    if(surgIso && date >= surgIso) return;
    const all = new Set();
    (_slots[date] || []).forEach(s => expand15(s.start, s.end).forEach(t => all.add(t)));
    const free = [...all].filter(t => {
      if(taken.has(date + ' ' + t)) return false;
      const slotMs = new Date(date + 'T' + t + ':00').getTime();
      if(isNaN(slotMs)) return false;
      return slotMs >= cutoffMs;
    }).sort();
    if(free.length) grouped[date] = free;
  });
  const dates = Object.keys(grouped).sort();
  const list = $('slot-list');
  if(!dates.length) {
    list.innerHTML = '<div class="alert warn">Jordan, APRN, FNP doesn’t have any open windows that fit your timeline right now. Reply to the email we sent you and we’ll work it out directly.</div>';
    return;
  }
  list.innerHTML = dates.slice(0, 14).map(date => {
    const chips = grouped[date].map(t =>
      '<button type="button" class="slot" data-date="' + date + '" data-time="' + t + '">' + esc(fmtTime(t)) + '</button>'
    ).join('');
    return '<div class="day-block"><div class="day-header">' + esc(fmtDateShort(date)) + '</div><div class="slots">' + chips + '</div></div>';
  }).join('');
  list.querySelectorAll('.slot').forEach(btn => {
    btn.addEventListener('click', () => {
      list.querySelectorAll('.slot').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      _selected = { date: btn.dataset.date, time: btn.dataset.time };
      const sum = $('selection-summary');
      sum.innerHTML = '<div class="summary">📞 <strong>' + esc(fmtDate(_selected.date)) + ' at ' + esc(fmtTime(_selected.time)) + '</strong> — Jordan, APRN, FNP will call you from a 317 area code.</div>';
      sum.classList.remove('hidden');
      _refreshBookBtn();
    });
  });
}

async function confirmBooking() {
  if(!_selected || !_entry) return;
  // Re-check gates before committing.
  const photosDone = (_entry.photoStatus && ANGLES.every(a => _entry.photoStatus[a.key]));
  if(!photosDone) { alert('Please upload all 6 photos first.'); return; }
  if(!_entry._paid) { alert('Please complete the $100 payment first.'); return; }
  if(!_termsAccepted()) { alert('Please review and check the Patient Terms & Privacy Acknowledgment box before scheduling.'); return; }
  if(!_consentAccepted()) { alert('Please review and check the Anesthesia Informed Consent box before scheduling.'); return; }
  const btn = $('book-btn');
  btn.disabled = true; btn.textContent = 'Confirming…';
  $('sched-error').innerHTML = '';
  try {
    // Re-fetch entries right before the write so we catch any concurrent
    // bookings that grabbed our slot.
    const snap = await getDoc(doc(db, 'atlas', 'preop_visits'));
    const entries = snap.exists() ? (snap.data().entries || []) : [];
    const idx = entries.findIndex(e => e.id === _entryId);
    if(idx === -1) throw new Error('Could not find your record.');
    if(entries.some(e => e.id !== _entryId && e.date === _selected.date && e.time === _selected.time)) {
      $('sched-error').innerHTML = '<div class="alert err">That exact time was just claimed by another patient. Pick another slot.</div>';
      _allEntries = entries;
      paintSlots();
      btn.disabled = false; btn.textContent = 'Confirm This Time';
      return;
    }
    entries[idx] = {
      ...entries[idx],
      date: _selected.date,
      time: _selected.time,
      scheduledAt: new Date().toISOString(),
      scheduledBy: 'patient-portal',
      // HIPAA + medico-legal audit trail — patient checked BOTH the
      // Privacy Acknowledgment and the Anesthesia Informed Consent
      // before the booking was committed. Both are stamped here with
      // version + timestamp so the consent on file can be matched to
      // the document the patient actually saw.
      consent: {
        accepted: true,
        acceptedAt: new Date().toISOString(),
        version: 'v1-2026-05-13',
        document: 'Atlas Anesthesia Patient Terms & Privacy Acknowledgment'
      },
      anesthesiaConsent: {
        accepted: true,
        acceptedAt: new Date().toISOString(),
        version: 'v1-2026-05-13',
        document: 'Atlas Anesthesia Informed Consent for Anesthesia Care',
        signatureDataUrl: _sigDataUrl || ''
      }
    };
    await setDoc(doc(db, 'atlas', 'preop_visits'), { entries });

    const patientName = [_entry.patientFirst, _entry.patientLast].filter(Boolean).join(' ') || 'Patient';
    const internalSubject = 'Pre-op call self-scheduled — ' + patientName;
    const internalHtml    = buildInternalHTML(patientName, _selected);
    const patientHtml     = buildPatientConfirmHTML(_entry.patientFirst || '', _selected);
    fireEmail(_entry.patientEmail, 'Pre-Op Call Confirmed — Atlas Anesthesia', patientHtml);
    fireEmail('jordan@atlasanesthesia.co', internalSubject, internalHtml);
    fireEmail('admin@atlasanesthesia.co', internalSubject, internalHtml);
    // Also send the signed anesthesia consent to the assigned CRNA so
    // they have a record of consent + the patient's signature image on
    // file before the day of surgery. Falls back to admin@ if the entry
    // doesn't have a crna assigned yet.
    const crnaEmail = _entry.crna === 'josh' ? 'josh@atlasanesthesia.co'
                    : _entry.crna === 'dev'  ? 'dev@atlasanesthesia.co'
                    : 'admin@atlasanesthesia.co';
    const consentHtml = buildSignedConsentEmailHTML(patientName, _sigDataUrl, new Date());
    // Strip the "data:image/png;base64," prefix so the worker can hand the
    // raw base64 bytes to SES as a Content-Transfer-Encoding: base64 part.
    const sigAttachments = (() => {
      if(!_sigDataUrl) return [];
      const i = _sigDataUrl.indexOf(',');
      const b64 = i >= 0 ? _sigDataUrl.slice(i + 1) : _sigDataUrl;
      return [{
        filename:    'Patient-Signature.png',
        contentType: 'image/png',
        base64:      b64
      }];
    })();
    fireEmail(crnaEmail, 'Signed Anesthesia Consent — ' + patientName, consentHtml, sigAttachments);

    showConfirm(_selected);
  } catch(err) {
    console.error('book failed', err);
    $('sched-error').innerHTML = '<div class="alert err">Could not confirm — please try again, or reply to your email.</div>';
    btn.disabled = false; btn.textContent = 'Confirm This Time';
  }
}

function showConfirm(sel) {
  $('steps-wrap').classList.add('hidden');
  $('stage-confirm').classList.remove('hidden');
  $('confirm-summary').innerHTML =
    '<div style="margin-bottom:6px"><strong>' + esc(fmtDate(sel.date)) + '</strong></div>'
    + '<div style="font-size:18px;font-weight:700;color:var(--accent);font-family:DM Mono,monospace">' + esc(fmtTime(sel.time)) + ' Central Time</div>';
}

// Build the CRNA-bound email body that contains the full signed consent.
// The signature image is sent as an actual file attachment (Patient-
// Signature.png) rather than inlined as a data: URL — Gmail/Outlook/
// Apple Mail block inline data: URLs for security, so inlining showed a
// broken placeholder instead of the signature. Most clients render
// image attachments as a thumbnail at the bottom of the email anyway.
function buildSignedConsentEmailHTML(patientName, sigDataUrl, signedAt) {
  const sigImg = sigDataUrl
    ? '<div style="border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc;padding:14px 16px;color:#475569;font-size:13px"><strong>📎 Patient signature</strong> is attached as <code style="background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;font-family:DM Mono,monospace;font-size:12px">Patient-Signature.png</code> below.</div>'
    : '<div style="font-style:italic;color:#94a3b8">No signature captured.</div>';
  const when = signedAt instanceof Date
    ? signedAt.toLocaleString('en-US', { dateStyle:'long', timeStyle:'short' })
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;line-height:1.55">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
      <table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.06)">
        <tr><td style="background:#1d3557;color:#fff;padding:18px 22px">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0">Atlas Anesthesia · For Your Records</div>
          <div style="font-size:18px;font-weight:700;margin-top:2px">Signed Anesthesia Consent — ${esc(patientName)}</div>
        </td></tr>
        <tr><td style="padding:18px 22px;font-size:13px;color:#475569;background:#f8fafc;border-bottom:1px solid #e2e8f0">
          <strong>Patient:</strong> ${esc(patientName)} &nbsp;·&nbsp;
          <strong>Signed:</strong> ${esc(when)}
        </td></tr>
        <tr><td style="padding:22px 24px;font-size:13px;color:#0f172a">
          <h3 style="margin:0 0 8px 0;font-size:15px;color:#1d3557">Patient Signature</h3>
          ${sigImg}
          <h3 style="margin:18px 0 6px 0;font-size:15px;color:#1d3557">Atlas Anesthesia Informed Consent for Anesthesia Care</h3>
          <p>I authorize any qualified contractor or subcontractor working for Atlas Anesthesia LLC to administer anesthesia for my procedure. I understand the plan may include general anesthesia or monitored anesthesia care (MAC) / IV sedation, and that the provider will choose and may adjust the technique they believe is safest for me based on clinical judgment.</p>
          <p><strong>Common risks and side effects</strong> include nausea/vomiting, sore throat, hoarseness, dry mouth, headache, dizziness, muscle aches, shivering, IV-site bruising, confusion or memory disturbance, minor lip/tooth/gum/restoration soreness, eye irritation, and temporary nerve tingling.</p>
          <p><strong>Serious risks</strong> (rare but possible) include severe allergic reaction, difficult/failed intubation and dental damage, aspiration, awareness during general anesthesia, damage to teeth or restorations, nerve injury, cardiovascular events including cardiac arrest, stroke or other neurologic injury, malignant hyperthermia, blood clots/bleeding/infection, postoperative cognitive dysfunction, and in extremely rare cases, death.</p>
          <p>I authorize the provider to <strong>change the anesthesia plan</strong> as needed for safety, and to perform <strong>emergency procedures</strong> including additional IV/airway placement, emergency medications, CPR/defibrillation, and 911 transfer. Atlas does not administer blood products in office-based settings.</p>
          <p><strong>I agree to my patient responsibilities:</strong> NPO for at least 8 hours, full disclosure of medications, supplements, recreational substances, medical history, allergies, and possible pregnancy; arrange a responsible adult to drive me home and stay with me several hours after the procedure; no driving, work, or signing legal documents for several hours after anesthesia.</p>
          <p>I understand that <strong>no guarantee</strong> of outcome has been made. By signing above, I confirm I have read and understood the entire consent, had the opportunity to ask questions, am voluntarily consenting, and am at least 18 years old or am the legal guardian/parent of a minor signing on their behalf.</p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:14px 22px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center">
          Atlas Anesthesia LLC · admin@atlasanesthesia.co · (262) 573-9095
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

// ── email helpers ──────────────────────────────────────────────────────────
// `attachments` is optional — pass [{filename, contentType, base64}, ...] to
// include real file attachments alongside the HTML body.
function fireEmail(to, subject, html, attachments) {
  if(!to || !html) return;
  const body = { to, subject, html };
  if(Array.isArray(attachments) && attachments.length) body.attachments = attachments;
  fetch(WORKER_URL + '/outreach-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}
function buildPatientConfirmHTML(firstName, sel) {
  const greet = firstName ? ' ' + esc(firstName) : ' there';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <tr><td style="background:#1d3557;padding:22px 28px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Atlas Anesthesia · Pre-Op Visit</div><div style="font-size:20px;font-weight:700;color:#fff">Your Pre-Op Call is Confirmed</div></td></tr>
      <tr><td style="padding:24px 28px;font-size:14px;color:#1e293b;line-height:1.6">
        <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0f172a">Hi${greet},</p>
        <p style="margin:0 0 14px">Your pre-op clearance call with our nurse practitioner <strong>Jordan, APRN, FNP</strong> is set for:</p>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 18px;margin:14px 0;text-align:center">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#1d4ed8;letter-spacing:.6px;margin-bottom:4px">Scheduled For</div>
          <div style="font-size:18px;font-weight:700;color:#0f172a">${esc(fmtDate(sel.date))}</div>
          <div style="font-size:16px;font-weight:600;color:#1d4ed8;font-family:'DM Mono',monospace;margin-top:4px">${esc(fmtTime(sel.time))} Central Time</div>
        </div>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin:18px 0">
          <div style="font-size:14px;font-weight:700;color:#1e3a8a;margin-bottom:6px">What to expect</div>
          <div style="font-size:13px;color:#1e293b;line-height:1.55">Jordan, APRN, FNP will reach out by phone at the scheduled time from a <strong>317 area code</strong> number — please answer or save it to your contacts so the call doesn’t get flagged as spam.</div>
          <div style="font-size:13px;color:#1e293b;line-height:1.55;margin-top:8px"><strong>Before the call, please have ready:</strong></div>
          <ul style="font-size:13px;color:#1e293b;line-height:1.55;margin:4px 0 0;padding-left:22px">
            <li>Your full medical history</li>
            <li>A current list of all medications you take (including dosages)</li>
          </ul>
        </div>
        <p style="margin:18px 0 0">If you need to reschedule or have questions before the call, just reply to this email.</p>
        <p style="margin:14px 0 0">Talk soon,<br><strong>Atlas Anesthesia</strong></p>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0"><div style="font-size:11px;color:#94a3b8;text-align:center">This is a confirmation message from Atlas Anesthesia.</div></td></tr>
    </table></td></tr></table></body></html>`;
}
function buildInternalHTML(patientName, sel) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <tr><td style="background:#1d3557;padding:22px 28px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Atlas Anesthesia · Internal</div><div style="font-size:20px;font-weight:700;color:#fff">Pre-op call self-scheduled</div></td></tr>
      <tr><td style="padding:24px 28px;font-size:14px;color:#1e293b;line-height:1.6">
        <p style="margin:0 0 14px;font-size:16px;font-weight:600">${esc(patientName)} just picked a time via the patient portal:</p>
        <div style="background:#eff6ff;border-left:3px solid #1d4ed8;padding:14px 16px;border-radius:6px">
          <div style="font-size:16px;font-weight:700;color:#0f172a">${esc(fmtDate(sel.date))}</div>
          <div style="font-size:14px;color:#1d4ed8;font-family:'DM Mono',monospace;margin-top:4px">${esc(fmtTime(sel.time))} Central Time</div>
        </div>
        <p style="margin:18px 0 0;font-size:13px;color:#64748b">The Tracker row is now marked scheduled. Six airway photos and the $100 fee were captured before the patient reached this step.</p>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0"><div style="font-size:11px;color:#94a3b8;text-align:center">Sent by Atlas Tracker · self-scheduling portal.</div></td></tr>
    </table></td></tr></table></body></html>`;
}
