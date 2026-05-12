// -- scheduled-faxes.js — shared "Send Later" scheduling for all fax modals ----
// Each fax modal (Pre-Op fax, Insurance Sheet, regular Fax) calls
// schedulingHookForModal() during build to inject the Send Now / Schedule
// toggle. When Schedule is picked, the modal's send button POSTs to the
// worker's /fax-schedule endpoint instead of /fax.
//
// A separate "📅 Scheduled Faxes" viewer (window.openScheduledFaxesModal)
// lists pending scheduled faxes and lets the user cancel any of them.
//
// Depends on: app.js (window.currentWorker for filtering the viewer).

const WORKER_BASE = 'https://atlas-reminder.blue-disk-9b10.workers.dev';

function $(id) { return document.getElementById(id); }

// Build the Schedule toggle HTML. Each modal injects this where its Send
// button lives. The prefix lets us scope the field IDs per modal.
window.scheduleToggleHTML = function(prefix) {
  return `
    <div id="${prefix}-schedule-row" style="display:inline-flex;align-items:center;gap:10px;font-size:11px;color:var(--text-muted)">
      <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;margin:0">
        <input type="radio" name="${prefix}-when" value="now" checked onchange="window._toggleScheduleField('${prefix}')" style="margin:0;width:13px;height:13px"> Send now
      </label>
      <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;margin:0">
        <input type="radio" name="${prefix}-when" value="later" onchange="window._toggleScheduleField('${prefix}')" style="margin:0;width:13px;height:13px"> Schedule later
      </label>
      <input type="datetime-local" id="${prefix}-schedule-at" style="display:none;padding:4px 6px;font-size:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">
    </div>
  `;
};

window._toggleScheduleField = function(prefix) {
  const later = document.querySelector(`input[name="${prefix}-when"][value="later"]`)?.checked;
  const input = $(`${prefix}-schedule-at`);
  if(input) {
    input.style.display = later ? '' : 'none';
    if(later && !input.value) {
      // Default to "next hour, on the hour" in local time so the value drops
      // into the datetime-local input cleanly.
      const d = new Date();
      d.setHours(d.getHours() + 1, 0, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      input.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  // Repaint the modal's Send button label so the user sees the action change.
  const sendBtn = document.querySelector(`[data-fax-send="${prefix}"]`);
  if(sendBtn) {
    if(later) {
      sendBtn.dataset.origLabel = sendBtn.dataset.origLabel || sendBtn.textContent;
      sendBtn.textContent = '📅 Schedule Fax';
    } else if(sendBtn.dataset.origLabel) {
      sendBtn.textContent = sendBtn.dataset.origLabel;
    }
  }
};

// Returns { mode: 'now' | 'later', sendAt: ISOString | null }. When mode is
// 'later', sendAt is the chosen local time converted to UTC ISO.
window.readScheduleChoice = function(prefix) {
  const later = document.querySelector(`input[name="${prefix}-when"][value="later"]`)?.checked;
  if(!later) return { mode: 'now', sendAt: null };
  const raw = $(`${prefix}-schedule-at`)?.value || '';
  if(!raw) return { mode: 'later', sendAt: null, error: 'Pick a date and time to schedule the fax.' };
  // datetime-local has no timezone — treat as the user's local clock and
  // convert to UTC ISO for storage.
  const local = new Date(raw);
  if(isNaN(local)) return { mode: 'later', sendAt: null, error: 'Invalid date/time.' };
  if(local.getTime() < Date.now() + 60000) {
    return { mode: 'later', sendAt: null, error: 'Pick a time at least a minute in the future.' };
  }
  return { mode: 'later', sendAt: local.toISOString() };
};

// Send (or schedule) a fax — used by every modal's send handler.
//   opts: { faxNumber, caseId, worker, html, source }
//   choice: result of readScheduleChoice(prefix)
// Returns { success, scheduled, sid, error }
window.sendOrScheduleFax = async function(opts, choice) {
  if(choice.mode === 'now') {
    const res = await fetch(WORKER_BASE + '/fax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: opts.faxNumber, caseId: opts.caseId, worker: opts.worker, html: opts.html })
    });
    const data = await res.json().catch(() => ({}));
    return { success: !!(res.ok && data.success), scheduled: false, sid: data.sid, error: data.error };
  }
  const res = await fetch(WORKER_BASE + '/fax-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sendAt: choice.sendAt,
      to: opts.faxNumber,
      caseId: opts.caseId,
      worker: opts.worker,
      html: opts.html,
      source: opts.source || ''
    })
  });
  const data = await res.json().catch(() => ({}));
  return { success: !!(res.ok && data.success), scheduled: true, sid: data.id, error: data.error };
};

// ── Scheduled Faxes viewer ───────────────────────────────────────────────
let _viewerBuilt = false;

function buildViewer() {
  if(_viewerBuilt) return;
  const wrap = document.createElement('div');
  wrap.id = 'scheduledFaxesModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px';
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:820px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 24px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:600">📅 Scheduled Faxes</div>
          <div style="font-size:12px;opacity:.75;margin-top:2px">Pending faxes the worker will send automatically at their scheduled time</div>
        </div>
        <button onclick="closeScheduledFaxesModal()" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
      </div>
      <div id="sched-fax-list" style="padding:14px 24px;max-height:65vh;overflow-y:auto"></div>
    </div>
  `;
  document.body.appendChild(wrap);
  _viewerBuilt = true;
}

async function loadScheduled() {
  const list = $('sched-fax-list');
  if(!list) return;
  list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint)">Loading…</div>';
  try {
    const res = await fetch(WORKER_BASE + '/fax-schedule-list', { method: 'POST' });
    if(!res.ok) {
      list.innerHTML = `<div style="padding:20px;color:var(--warn)">Could not load scheduled faxes (HTTP ${res.status}). Make sure the worker has /fax-schedule-list deployed.</div>`;
      return;
    }
    const data = await res.json();
    const w = (typeof window.currentWorker !== 'undefined' ? window.currentWorker : 'dev');
    const all = (data.entries || []).filter(e => !e.sentAt && !e.cancelled && (e.worker || 'dev') === w);
    if(!all.length) {
      list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-faint)">No pending scheduled faxes.</div>';
      return;
    }
    list.innerHTML = `
      <div style="display:grid;grid-template-columns:170px 100px 1fr 90px 70px;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
        <span>Scheduled For</span><span>To</span><span>Case / Recipient</span><span>Source</span><span></span>
      </div>
      ${all.map(e => {
        const when = new Date(e.sendAt).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
        return `
          <div style="display:grid;grid-template-columns:170px 100px 1fr 90px 70px;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:center">
            <span>${when}</span>
            <span style="font-family:'DM Mono',monospace;font-size:11px">${e.to || '—'}</span>
            <span>${e.caseId || '—'}</span>
            <span style="font-size:11px;color:var(--text-faint)">${e.source || ''}</span>
            <button onclick="window._cancelScheduledFax('${e.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">Cancel</button>
          </div>
        `;
      }).join('')}
    `;
  } catch(e) {
    list.innerHTML = `<div style="padding:20px;color:var(--warn)">Error: ${e.message}</div>`;
  }
}

window._cancelScheduledFax = async function(id) {
  if(!confirm('Cancel this scheduled fax? It will not be sent.')) return;
  try {
    const res = await fetch(WORKER_BASE + '/fax-schedule-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if(res.ok) loadScheduled();
    else alert('Could not cancel: HTTP ' + res.status);
  } catch(e) {
    alert('Error: ' + e.message);
  }
};

window.openScheduledFaxesModal = function() {
  buildViewer();
  $('scheduledFaxesModal').style.display = 'flex';
  loadScheduled();
};
window.closeScheduledFaxesModal = function() {
  const m = $('scheduledFaxesModal');
  if(m) m.style.display = 'none';
};
