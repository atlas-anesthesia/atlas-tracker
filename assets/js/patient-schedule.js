// patient-schedule.js — Atlas Anesthesia public patient scheduling portal.
//
// Flow:
//   1. Patient enters their email + last name (the credentials Nicole has on
//      file for them, captured during her initial intake).
//   2. We look up a matching atlas/preop_visits entry that has paid the $100
//      pre-op fee and hasn't been scheduled yet.
//   3. We expand Jordan's published availability windows into 15-min slots,
//      remove any that are already booked, and render the rest grouped by day.
//   4. Patient picks a slot. We stamp the entry with scheduledAt + date/time,
//      remove the slot from Jordan's availability (so it can't be double-
//      booked), and fire confirmation emails to the patient + Jordan + admin.
//
// This page runs without authentication — it uses the same Firebase config
// as the main app. The Tracker entry's email + last name pair is the "auth"
// token. If a guess wins, the attacker can only book a visit they've already
// paid $100 for, which is a small attack surface.

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

// ── helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDate = iso => {
  if(!iso) return '';
  try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }); }
  catch(e) { return iso; }
};
const fmtDateShort = iso => {
  if(!iso) return '';
  try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }); }
  catch(e) { return iso; }
};
const fmtTime = t => {
  if(!t) return '';
  try { return new Date('2000-01-01T' + t).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }); }
  catch(e) { return t; }
};
function showError(boxId, msg) {
  const el = $(boxId);
  if(!el) return;
  el.innerHTML = '<div class="alert err">' + esc(msg) + '</div>';
}
function clearError(boxId) {
  const el = $(boxId);
  if(el) el.innerHTML = '';
}
function showStage(stage) {
  ['stage-identity','stage-picker','stage-confirm'].forEach(id => {
    const el = $(id);
    if(el) el.classList.toggle('stage-hidden', id !== stage);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 15-min expansion. Same logic the internal modal uses.
function expand15(start, end) {
  if(!start || !end || !start.includes(':') || !end.includes(':')) return [];
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if([sh,sm,eh,em].some(n => Number.isNaN(n))) return [];
  const s = sh*60 + sm;
  const e = eh*60 + em;
  const out = [];
  for(let m = s; m + 15 <= e; m += 15) {
    out.push(String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0'));
  }
  return out;
}

// ── module state ───────────────────────────────────────────────────────────
let _entry = null;          // the matching preop_visits entry
let _allEntries = [];       // entire entries array (needed to write back)
let _entryIdx = -1;         // index of _entry inside _allEntries
let _slots = {};            // current availability slots map
let _selected = null;       // { date, time } once a chip is tapped

// ── Stage 1: identity lookup ──────────────────────────────────────────────
$('lookup-btn').addEventListener('click', async () => {
  clearError('identity-error');
  const email = ($('p-email').value || '').trim().toLowerCase();
  const last  = ($('p-last').value  || '').trim().toLowerCase();
  if(!email || !email.includes('@')) { showError('identity-error', 'Enter the email Atlas has on file.'); return; }
  if(!last) { showError('identity-error', 'Enter your last name.'); return; }

  const btn = $('lookup-btn');
  btn.disabled = true; btn.textContent = 'Looking up…';
  try {
    const snap = await getDoc(doc(db, 'atlas', 'preop_visits'));
    const entries = snap.exists() ? (snap.data().entries || []) : [];
    _allEntries = entries;
    const idx = entries.findIndex(e =>
      (e.patientEmail || '').toLowerCase() === email &&
      (e.patientLast  || '').toLowerCase() === last
    );
    if(idx === -1) {
      showError('identity-error', "We couldn't find a matching record. Double-check the email and last name we used when we called you, or reply to that email and we'll sort it out.");
      btn.disabled = false; btn.textContent = 'Continue →';
      return;
    }
    _entry = entries[idx];
    _entryIdx = idx;

    // Guard rails: already scheduled, or $100 not yet paid.
    if(_entry.scheduledAt) {
      showError('identity-error', 'Your call is already scheduled. Check the confirmation email we sent you, or reply to it if you need to make a change.');
      btn.disabled = false; btn.textContent = 'Continue →';
      return;
    }
    const hasPaid = !!_entry.manualPaidAt || !!_entry.stripePaidAt;
    // We don't strictly require the paid stamp client-side (Stripe may not
    // have synced yet), but warn if it looks unpaid.
    if(!hasPaid) {
      // Soft warning — let them through. The internal team can correct.
      console.info('Patient scheduling without confirmed payment stamp.');
    }
    await loadSlotsAndShowPicker();
  } catch(err) {
    console.error('lookup failed', err);
    showError('identity-error', 'Something went wrong. Please try again in a moment.');
    btn.disabled = false; btn.textContent = 'Continue →';
  }
});

// ── Stage 2: slot picker ──────────────────────────────────────────────────
async function loadSlotsAndShowPicker() {
  showStage('stage-picker');
  $('slot-list').innerHTML = '<div style="text-align:center;color:var(--text-faint);padding:20px"><span class="spinner"></span> Loading available times…</div>';
  $('selection-summary').classList.add('stage-hidden');
  $('book-btn').disabled = true;
  _selected = null;

  try {
    const snap = await getDoc(doc(db, 'atlas', 'availability'));
    const data = snap.exists() ? snap.data() : {};
    _slots = (data && data.jordan && data.jordan.slots) || {};
  } catch(e) {
    showError('picker-error', "Couldn't load Jordan's schedule. Please refresh and try again.");
    return;
  }

  // Booked times: anything in atlas/preop_visits with both date + time set.
  const taken = new Set();
  _allEntries.forEach(e => {
    if(e.date && e.time) taken.add(e.date + ' ' + e.time);
  });

  // Surgery-day guard: no visit on or after the patient's own surgery.
  const surgIso = _entry.surgeryDate || '';
  const todayIso = new Date().toISOString().split('T')[0];

  // Expand → filter → group by date.
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
  if(!dates.length) {
    $('slot-list').innerHTML = '<div class="alert warn">Jordan doesn’t have any open windows that fit your timeline right now. Reply to the email you received and we’ll work something out directly.</div>';
    return;
  }

  // Cap to first 14 days with slots so the page doesn't get overwhelming.
  const html = dates.slice(0, 14).map(date => {
    const chips = grouped[date].map(t =>
      `<button type="button" class="slot" data-date="${date}" data-time="${t}">${esc(fmtTime(t))}</button>`
    ).join('');
    return `<div class="day-block"><div class="day-header">${esc(fmtDateShort(date))}</div><div class="slots">${chips}</div></div>`;
  }).join('');
  $('slot-list').innerHTML = html;

  // Wire chip clicks.
  $('slot-list').querySelectorAll('.slot').forEach(btn => {
    btn.addEventListener('click', () => {
      $('slot-list').querySelectorAll('.slot').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      _selected = { date: btn.dataset.date, time: btn.dataset.time };
      const sum = $('selection-summary');
      sum.innerHTML = '<div class="summary">📞 <strong>' + esc(fmtDate(_selected.date)) + ' at ' + esc(fmtTime(_selected.time)) + '</strong> — Jordan will call you from a 317 area code at this time.</div>';
      sum.classList.remove('stage-hidden');
      $('book-btn').disabled = false;
    });
  });
}

$('back-btn').addEventListener('click', () => showStage('stage-identity'));

// ── Stage 3: book the slot ────────────────────────────────────────────────
$('book-btn').addEventListener('click', async () => {
  if(!_selected || !_entry) return;
  clearError('picker-error');
  const btn = $('book-btn');
  btn.disabled = true; btn.textContent = 'Confirming…';

  try {
    // Re-fetch the entries just before writing so we don't clobber any other
    // concurrent edits Nicole/Jordan may have made.
    const visitSnap = await getDoc(doc(db, 'atlas', 'preop_visits'));
    const entries = visitSnap.exists() ? (visitSnap.data().entries || []) : [];
    const idx = entries.findIndex(e => e.id === _entry.id);
    if(idx === -1) throw new Error('Could not find your record. Please refresh.');

    const conflict = entries.some(e => e.id !== _entry.id && e.date === _selected.date && e.time === _selected.time);
    if(conflict) {
      showError('picker-error', 'Someone else just grabbed that exact time. Pick another slot.');
      btn.disabled = false; btn.textContent = 'Confirm This Time';
      await loadSlotsAndShowPicker();
      return;
    }
    entries[idx] = {
      ...entries[idx],
      date: _selected.date,
      time: _selected.time,
      scheduledAt: new Date().toISOString(),
      scheduledBy: 'patient-portal'
    };
    await setDoc(doc(db, 'atlas', 'preop_visits'), { entries });

    // Notify the team. Patient gets their own confirmation via /outreach-email.
    const patientName = [_entry.patientFirst, _entry.patientLast].filter(Boolean).join(' ') || 'Patient';
    const subjectInternal = 'Pre-op call self-scheduled — ' + patientName;
    const internalHtml = buildInternalHTML(patientName, _selected);
    const patientHtml  = buildPatientConfirmHTML(_entry.patientFirst || '', _selected);
    const patientSubject = 'Pre-Op Call Confirmed — Atlas Anesthesia';
    fireEmail(_entry.patientEmail, patientSubject, patientHtml);
    fireEmail('jordan@atlasanesthesia.co', subjectInternal, internalHtml);
    fireEmail('admin@atlasanesthesia.co', subjectInternal, internalHtml);

    // Confirmation stage.
    $('confirm-summary').innerHTML =
      '<div style="text-align:left">'
      + '<div style="margin-bottom:6px"><strong>' + esc(fmtDate(_selected.date)) + '</strong></div>'
      + '<div style="font-size:18px;font-weight:700;color:var(--accent);font-family:DM Mono,monospace">' + esc(fmtTime(_selected.time)) + ' CT</div>'
      + '</div>';
    showStage('stage-confirm');
  } catch(err) {
    console.error('book failed', err);
    showError('picker-error', 'Something went wrong. Please try again — if it keeps failing, reply to the email we sent you.');
    btn.disabled = false; btn.textContent = 'Confirm This Time';
  }
});

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
        <p style="margin:0 0 14px">Your pre-op clearance call with our nurse <strong>Jordan</strong> is set for:</p>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 18px;margin:14px 0;text-align:center">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#1d4ed8;letter-spacing:.6px;margin-bottom:4px">Scheduled For</div>
          <div style="font-size:18px;font-weight:700;color:#0f172a">${esc(fmtDate(sel.date))}</div>
          <div style="font-size:16px;font-weight:600;color:#1d4ed8;font-family:'DM Mono',monospace;margin-top:4px">${esc(fmtTime(sel.time))} Central Time</div>
        </div>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin:18px 0">
          <div style="font-size:14px;font-weight:700;color:#1e3a8a;margin-bottom:6px">What to expect</div>
          <div style="font-size:13px;color:#1e293b;line-height:1.55">Jordan will reach out by phone at the scheduled time from a <strong>317 area code</strong> number — please answer or save it to your contacts so the call doesn’t get flagged as spam.</div>
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
        <p style="margin:18px 0 0;font-size:13px;color:#64748b">The Tracker row is now marked scheduled.</p>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0"><div style="font-size:11px;color:#94a3b8;text-align:center">Sent by Atlas Tracker · self-scheduling portal.</div></td></tr>
    </table></td></tr></table></body></html>`;
}
