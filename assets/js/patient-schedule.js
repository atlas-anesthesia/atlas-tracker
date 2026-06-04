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
  // Terms & Privacy Acknowledgment — patients must check the box AND have a
  // slot selected before the Confirm button enables.
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
}

function _openTermsModal()  { const m = $('terms-modal'); if(m) m.classList.remove('hidden'); }
function _closeTermsModal() { const m = $('terms-modal'); if(m) m.classList.add('hidden'); }
function _termsAccepted()   { return !!($('terms-checkbox')?.checked); }
function _refreshBookBtn()  {
  const btn = $('book-btn');
  if(!btn) return;
  btn.disabled = !(_selected && _termsAccepted());
}

function paintSlots() {
  const taken = new Set();
  _allEntries.forEach(e => {
    if(e.date && e.time) taken.add(e.date + ' ' + e.time);
  });
  const surgIso = _entry.surgeryDate || '';
  const todayIso = new Date().toISOString().split('T')[0];

  const grouped = {};
  Object.keys(_slots).sort().forEach(date => {
    if(date < todayIso) return;
    if(surgIso && date >= surgIso) return;
    const all = new Set();
    (_slots[date] || []).forEach(s => expand15(s.start, s.end).forEach(t => all.add(t)));
    const free = [...all].filter(t => !taken.has(date + ' ' + t)).sort();
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
      // HIPAA audit trail — patient checked the Privacy Acknowledgment
      // box before the booking was committed. Stored alongside the entry
      // so we can prove consent during compliance reviews.
      consent: {
        accepted: true,
        acceptedAt: new Date().toISOString(),
        version: 'v1-2026-05-13',
        document: 'Atlas Anesthesia Patient Terms & Privacy Acknowledgment'
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

// ── email helpers ──────────────────────────────────────────────────────────
function fireEmail(to, subject, html) {
  if(!to || !html) return;
  fetch(WORKER_URL + '/outreach-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, html })
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
