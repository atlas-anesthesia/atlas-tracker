// deposits.js -- Initial Deposits modal, Stripe tracking, Payments sync
// Depends on: app.js (db, currentWorker, uid, setSyncing, _rawPreopRecords, surgeryCenters)
// Worker endpoints used:
//   POST /deposit-email  { to, patientName, caseId, provider, stripeLink, worker, isReminder }
//   POST /stripe-check   { paymentLinkId }  -> { paid: bool, paidAt: string|null }

const WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev';

// Stripe payment link — set in Atlas settings or hardcoded
// Change this to your real Stripe payment link URL
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/00wfZgh0refXfSIarfejK00';

// -- Firestore helpers --------------------------------------------------------
async function _loadDeposits() {
  try {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'deposits'));
    return snap.exists() ? (snap.data().records || []) : [];
  } catch(e) { return []; }
}

async function _saveDeposits(records) {
  window.setSyncing(true);
  await window.setDoc(window.doc(window.db, 'atlas', 'deposits'), { records });
  window.setSyncing(false);
}

// -- Helpers ------------------------------------------------------------------
function _fmtDate(d) {
  if(!d) return '';
  const dt = new Date(d.includes('T') ? d : d + 'T12:00:00Z');
  return dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
}

function _daysAgo(isoStr) {
  if(!isoStr) return 0;
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
}

function _statusPill(record) {
  if(record.paid) {
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(45,106,79,0.12);color:#2d6a4f">PAID</span>';
  }
  const days = _daysAgo(record.sentAt);
  if(days >= 7) {
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(239,68,68,0.1);color:var(--warn)">OVERDUE</span>';
  }
  return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(251,191,36,0.15);color:#b45309">PENDING</span>';
}

// -- Build email HTML ---------------------------------------------------------
function _buildDepositEmailHTML(opts) {
  const { firstName, provider, surgDate, isReminder } = opts;
  const greeting = isReminder
    ? `<p>Hi${firstName ? ' '+firstName : ''},</p><p>We wanted to follow up regarding your upcoming procedure scheduled for <strong>${surgDate||'your upcoming date'}</strong>. We noticed your initial deposit of <strong>$500</strong> has not yet been received.</p>`
    : `<p>Hi${firstName ? ' '+firstName : ''},</p><p>Thank you so much for speaking with us today about your upcoming procedure scheduled for <strong>${surgDate||'your upcoming date'}</strong>. It was a pleasure connecting with you, and we look forward to providing you with exceptional anesthesia care.</p><p>To secure your appointment, we kindly ask for an initial deposit of <strong>$500</strong>, which can be submitted securely online using the link below.</p>`;

  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#000">
  <div style="background:#1d3557;padding:20px 24px;border-radius:8px 8px 0 0">
    <div style="font-size:20px;font-weight:bold;color:#fff">Atlas Anesthesia</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:4px">${isReminder ? 'Deposit Reminder' : 'Thank You & Deposit Request'}</div>
  </div>
  <div style="background:#f9f9f9;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    ${greeting}
    <div style="text-align:center;margin:28px 0">
      <a href="${opts.stripeLink}" style="display:inline-block;background:#1d3557;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:600">
        ${isReminder ? 'Complete $500 Deposit' : 'Pay $500 Deposit Securely'}
      </a>
    </div>
    <p style="background:#f0f5ff;border-left:3px solid #1d3557;padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;color:#333;margin:0 0 16px">
      <strong>Please note:</strong> The remaining balance for your procedure will be collected 7–8 days prior to your surgery date.
    </p>
    ${isReminder
      ? '<p>If you have any questions or need to reschedule, please don\'t hesitate to reach out. We want to make this process as easy as possible for you.</p>'
      : '<p>If you have any questions before your procedure, please don\'t hesitate to reach out. We\'re here to make sure you feel comfortable and well-prepared.</p>'}
    <p>Warm regards,<br><strong>${provider||'Atlas Anesthesia'}</strong><br>Atlas Anesthesia</p>
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:11px;color:#888">
      This is a secure payment request. Your payment is processed safely via Stripe.
    </div>
  </div>
</div>`;
}

// -- Send deposit email -------------------------------------------------------
async function _sendDepositEmail(record, isReminder, firstName) {
  const html = _buildDepositEmailHTML({
        provider: (record.worker || window.currentWorker || 'josh') === 'josh' ? 'Joshua Condado, CRNA' : 'Dev Murthy, CRNA',
    surgDate: _fmtDate(record.surgDate),
    stripeLink: record.stripeLink || STRIPE_PAYMENT_LINK,
    isReminder
  });

  try {
    const res = await fetch(WORKER_URL + '/deposit-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: record.patientEmail,
                caseId: record.caseId,
        provider: (record.worker || window.currentWorker || 'josh') === 'josh' ? 'Joshua Condado, CRNA' : 'Dev Murthy, CRNA',
        stripeLink: record.stripeLink || STRIPE_PAYMENT_LINK,
        worker: record.worker || window.currentWorker || 'josh',
        isReminder,
        html
      })
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.success;
  } catch(e) {
    // Fallback: open mailto
    const subject = encodeURIComponent(isReminder ? 'Reminder: $500 Deposit for Upcoming Procedure' : 'Thank You + $500 Deposit Request');
    const body = encodeURIComponent(`Please see the attached deposit request link: ${record.stripeLink || STRIPE_PAYMENT_LINK}`);
    window.open(`mailto:${record.patientEmail}?subject=${subject}&body=${body}`);
    return false;
  }
}

// -- Check Stripe payment status ----------------------------------------------
async function _checkStripePayment(record) {
  if(!record.stripeSessionId && !record.stripePaymentLinkId) return null;
  try {
    const res = await fetch(WORKER_URL + '/stripe-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerEmail: record.patientEmail,
        caseId: record.caseId
      })
    });
    if(!res.ok) return null;
    return await res.json().catch(() => null);
  } catch(e) { return null; }
}

// -- Render the deposits table ------------------------------------------------
async function _renderDepositsTable(containerEl) {
  const records = await _loadDeposits();

  if(!records.length) {
    containerEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:13px">No deposit requests sent yet</div>';
    return;
  }

  // Sort: unpaid first, then by sentAt desc
  const sorted = [...records].sort((a,b) => {
    if(a.paid !== b.paid) return a.paid ? 1 : -1;
    return (b.sentAt||'').localeCompare(a.sentAt||'');
  });

  const COLS = '1fr 120px 90px 80px 80px 120px';
  let html = `<div style="display:grid;grid-template-columns:${COLS};gap:0;padding:8px 12px;border-bottom:2px solid var(--border)">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint)">Case / Patient</span>
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint)">Email</span>
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);text-align:center">Sent</span>
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);text-align:center">Status</span>
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);text-align:center">Paid On</span>
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-faint);text-align:right">Actions</span>
  </div>`;

  sorted.forEach(r => {
    const days = _daysAgo(r.sentAt);
    const overdue = !r.paid && days >= 7;
    const bg = r.paid ? 'rgba(45,106,79,0.04)' : (overdue ? 'rgba(239,68,68,0.04)' : 'var(--bg)');

    html += `<div data-deposit-id="${r.id}" style="display:grid;grid-template-columns:${COLS};gap:0;padding:10px 12px;border-bottom:1px solid var(--border);align-items:center;background:${bg}">
      <div>
        <div style="font-size:12px;font-weight:600">${r.caseId||'-'}</div>
        <div style="font-size:11px;color:var(--text-muted)">${r.patientName||'-'}</div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.patientEmail||'-'}</div>
      <div style="text-align:center;font-size:11px;color:var(--text-faint)">${_fmtDate(r.sentAt)||'-'}</div>
      <div style="text-align:center">${_statusPill(r)}</div>
      <div style="text-align:center;font-size:11px;color:#2d6a4f;font-weight:600">${r.paidAt ? _fmtDate(r.paidAt) : '-'}</div>
      <div style="text-align:right;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
        ${!r.paid ? `<button onclick="window._depositMarkPaid('${r.id}')" style="font-size:10px;padding:3px 8px;border:1px solid #2d6a4f;background:rgba(45,106,79,0.08);color:#2d6a4f;border-radius:4px;cursor:pointer;font-weight:600">✓ Mark Paid</button>` : ''}
        ${!r.paid ? `<button onclick="window._depositSendReminder('${r.id}')" style="font-size:10px;padding:3px 8px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:4px;cursor:pointer">Remind</button>` : ''}
        <button onclick="window._depositDelete('${r.id}')" style="font-size:10px;padding:3px 8px;border:none;background:none;color:var(--text-faint);cursor:pointer">✕</button>
      </div>
    </div>`;
  });

  containerEl.innerHTML = html;
}

// -- Open modal ---------------------------------------------------------------
window.openDepositsModal = async function() {
  const old = document.getElementById('deposits-modal');
  if(old) old.remove();

  const preops = window._rawPreopRecords || [];

  const modal = document.createElement('div');
  modal.id = 'deposits-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface);border-radius:12px;width:100%;max-width:860px;box-shadow:0 20px 60px rgba(0,0,0,.3)';

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'background:#1d3557;color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center';
  hdr.innerHTML = '<div><div style="font-size:16px;font-weight:600">Initial Deposits</div><div style="font-size:12px;opacity:.7;margin-top:2px">Send $500 deposit requests and track payments via Stripe</div></div>';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:14px';
  closeBtn.onclick = () => modal.remove();
  hdr.appendChild(closeBtn);
  box.appendChild(hdr);

  // Send new deposit form
  const form = document.createElement('div');
  form.style.cssText = 'padding:20px 24px;border-bottom:1px solid var(--border)';

  // Build case options
  const sortedPreops = [...preops].sort((a,b) => (b['po-surgeryDate']||'').localeCompare(a['po-surgeryDate']||''));
  const caseOptions = sortedPreops.map(r => {
    const label = `${r['po-caseId']||r.id} — ${r['po-provider']||''} — ${r['po-surgeryDate']||''}`;
    return `<option value="${r.id}">${label}</option>`;
  }).join('');

  form.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:12px;color:var(--text)">Send New Deposit Request</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Pre-Op Case</label>
        <select id="dep-case-select" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)" onchange="window._depositCaseChanged()">
          <option value="">-- Select a case --</option>
          ${caseOptions}
        </select>
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">Patient Email</label>
        <input type="email" id="dep-email" placeholder="patient@email.com" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-faint);display:block;margin-bottom:4px">First Name <span style="font-weight:400;text-transform:none;font-style:italic;color:var(--text-faint)">(for email only)</span></label>
        <input type="text" id="dep-firstname" placeholder="e.g. Sarah" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);box-sizing:border-box">
      </div>


    </div>
    <div style="display:flex;gap:10px;align-items:center">
      <button id="dep-send-btn" style="padding:9px 20px;background:#1d3557;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">📧 Send Deposit Request</button>
      <span id="dep-send-status" style="font-size:12px;color:var(--text-faint)"></span>
    </div>`;
  box.appendChild(form);

  // Table section
  const tableWrap = document.createElement('div');
  tableWrap.style.padding = '20px 24px';
  const tableLabel = document.createElement('div');
  tableLabel.style.cssText = 'font-size:13px;font-weight:700;margin-bottom:12px;color:var(--text);display:flex;justify-content:space-between;align-items:center';
  tableLabel.innerHTML = 'Deposit Tracker <button onclick="window._depositsCheckAll()" style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:none;color:var(--text-muted);cursor:pointer">🔄 Check All Stripe Payments</button>';
  tableWrap.appendChild(tableLabel);

  const tableContainer = document.createElement('div');
  tableContainer.id = 'deposits-table-container';
  tableContainer.style.cssText = 'border:1px solid var(--border);border-radius:8px;overflow:hidden';
  tableWrap.appendChild(tableContainer);
  box.appendChild(tableWrap);

  modal.appendChild(box);
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target === modal) modal.remove(); });

  // Load table
  await _renderDepositsTable(tableContainer);

  // Wire send button
  document.getElementById('dep-send-btn').addEventListener('click', window._depositSendNew);
};

// -- Auto-fill from case selection --------------------------------------------
window._depositCaseChanged = function() {
  const sel = document.getElementById('dep-case-select');
  const emailEl = document.getElementById('dep-email');
  // Always clear email first so switching cases never keeps a stale email
  if(emailEl) emailEl.value = '';
  if(!sel || !sel.value) return;
  const preops = window._rawPreopRecords || [];
  const record = preops.find(r => r.id === sel.value);
  if(!record) return;
  // Only populate if this case has an email on file
  if(emailEl) emailEl.value = record['po-patientEmail'] || '';
};

// -- Send new deposit request -------------------------------------------------
window._depositSendNew = async function() {
  const sel    = document.getElementById('dep-case-select');
  const email     = (document.getElementById('dep-email')?.value||'').trim();
  const firstName = (document.getElementById('dep-firstname')?.value||'').trim();
  const name   = (document.getElementById('dep-name')?.value||'').trim();
  const link   = STRIPE_PAYMENT_LINK;
  const status = document.getElementById('dep-send-status');

  if(!sel?.value)  { alert('Please select a case.'); return; }
  if(!email)       { alert('Please enter a patient email.'); return; }

  const preops = window._rawPreopRecords || [];
  const preop  = preops.find(r => r.id === sel.value);
  if(!preop)   { alert('Case not found.'); return; }

  const btn = document.getElementById('dep-send-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  if(status) status.textContent = '';

  const newRecord = {
    id:          window.uid ? window.uid() : Date.now().toString(36),
    caseId:      preop['po-caseId'] || '',
    preopId:     preop.id,
    patientEmail: email,
    provider:    preop['po-provider'] || '',
    surgDate:    preop['po-surgeryDate'] || '',
    worker:      window.currentWorker || 'josh',
    stripeLink:  link,
    sentAt:      new Date().toISOString(),
    paid:        false,
    paidAt:      null,
    reminderSentAt: null
  };

  const records = await _loadDeposits();
  records.unshift(newRecord);
  await _saveDeposits(records);

  const sent = await _sendDepositEmail(newRecord, false, firstName);

  btn.disabled = false; btn.textContent = '📧 Send Deposit Request';
  if(status) status.textContent = sent ? '✓ Email sent!' : '⚠ Opened mail client (worker unavailable)';

  // Refresh table
  const tc = document.getElementById('deposits-table-container');
  if(tc) await _renderDepositsTable(tc);
};

// -- Mark as paid manually ---------------------------------------------------
window._depositMarkPaid = async function(id) {
  const records = await _loadDeposits();
  const idx = records.findIndex(r => r.id === id);
  if(idx === -1) return;

  const paidAt = new Date().toISOString();
  records[idx].paid   = true;
  records[idx].paidAt = paidAt;
  await _saveDeposits(records);

  // Update Payments tab: set depositDate + dep500Paid for matching caseId
  await _syncDepositToPayments(records[idx]);

  const tc = document.getElementById('deposits-table-container');
  if(tc) await _renderDepositsTable(tc);
};

// -- Send reminder -----------------------------------------------------------
window._depositSendReminder = async function(id) {
  const records = await _loadDeposits();
  const idx = records.findIndex(r => r.id === id);
  if(idx === -1) return;

  const record = records[idx];
  if(!record.patientEmail) { alert('No email address on file.'); return; }

  const sent = await _sendDepositEmail(record, true);
  records[idx].reminderSentAt = new Date().toISOString();
  await _saveDeposits(records);

  const tc = document.getElementById('deposits-table-container');
  if(tc) await _renderDepositsTable(tc);

  alert(sent ? '✓ Reminder sent!' : 'Opened mail client (worker unavailable)');
};

// -- Delete deposit record ---------------------------------------------------
window._depositDelete = async function(id) {
  if(!confirm('Remove this deposit record?')) return;
  const records = await _loadDeposits();
  await _saveDeposits(records.filter(r => r.id !== id));
  const tc = document.getElementById('deposits-table-container');
  if(tc) await _renderDepositsTable(tc);
};

// -- Sync paid deposit → Payments tab ----------------------------------------
async function _syncDepositToPayments(depositRecord) {
  try {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'payments'));
    if(!snap.exists()) return;
    const rows = snap.data().rows || [];
    const rowIdx = rows.findIndex(r => r.caseId === depositRecord.caseId);
    if(rowIdx === -1) return;

    const paidDate = depositRecord.paidAt
      ? new Date(depositRecord.paidAt).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    rows[rowIdx].depositDate = paidDate;
    rows[rowIdx].dep500Paid  = true;

    await window.setDoc(window.doc(window.db, 'atlas', 'payments'), { rows });
    console.log('Payments tab updated for', depositRecord.caseId);
  } catch(e) {
    console.warn('Could not sync deposit to Payments:', e);
  }
}

// -- Check all Stripe payments -----------------------------------------------
window._depositsCheckAll = async function() {
  const records = await _loadDeposits();
  const unpaid  = records.filter(r => !r.paid);
  if(!unpaid.length) { alert('All deposits are already marked paid.'); return; }

  const btn = document.querySelector('[onclick="window._depositsCheckAll()"]');
  if(btn) btn.textContent = 'Checking...';

  let updated = 0;
  for(const record of unpaid) {
    const result = await _checkStripePayment(record);
    if(result?.paid) {
      const idx = records.findIndex(r => r.id === record.id);
      records[idx].paid   = true;
      records[idx].paidAt = result.paidAt || new Date().toISOString();
      await _syncDepositToPayments(records[idx]);
      updated++;
    }
  }

  await _saveDeposits(records);
  if(btn) btn.textContent = '🔄 Check All Stripe Payments';

  const tc = document.getElementById('deposits-table-container');
  if(tc) await _renderDepositsTable(tc);

  alert(updated > 0
    ? `${updated} payment(s) confirmed via Stripe!`
    : 'No new payments detected. Payments may take a few minutes to appear.'
  );
};

// -- Auto-reminder check (runs on load) --------------------------------------
window._depositsAutoReminder = async function() {
  try {
    const records = await _loadDeposits();
    const toRemind = records.filter(r =>
      !r.paid &&
      _daysAgo(r.sentAt) >= 7 &&
      !r.reminderSentAt
    );
    for(const r of toRemind) {
      await _sendDepositEmail(r, true);
      const idx = records.findIndex(x => x.id === r.id);
      if(idx !== -1) records[idx].reminderSentAt = new Date().toISOString();
    }
    if(toRemind.length > 0) {
      await _saveDeposits(records);
      console.log(`Auto-reminder sent to ${toRemind.length} patient(s)`);
    }
  } catch(e) {
    console.warn('Auto-reminder check failed:', e);
  }
};

// Run auto-reminder check 5 seconds after load (non-blocking)
setTimeout(window._depositsAutoReminder, 5000);
