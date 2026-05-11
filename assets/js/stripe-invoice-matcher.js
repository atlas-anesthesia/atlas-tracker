// -- stripe-invoice-matcher.js — match Stripe payments to office invoices ----
// Adds a "Match Invoices" button on the Payments page. Clicking it asks the
// Cloudflare worker for recent Stripe payments, then for each unpaid invoice
// in the Payments table finds candidate Stripe payments where the gross
// amount matches. Date proximity to the case date and an email match against
// the Surgery Center's invoiceEmail boost the confidence score.
//
// All matches go into a review modal — nothing is auto-marked paid. The user
// confirms each one, which then flips the row's paid flag and saves.
//
// Depends on: app.js (window.uid, window.setDoc, window.doc, window.db),
//             payments.js (window._paymentRows, renderPaymentRows,
//                          renderPaymentSummary, savePaymentRows).

const WORKER_URL = 'https://atlas-reminder.blue-disk-9b10.workers.dev';

function $(id) { return document.getElementById(id); }

// Pull every unpaid invoice from the Payments table that's worth scanning.
// Treat "unpaid" as: an invoice has been issued (invoicedAmount > 0 OR
// invoiceSent flag is set) AND the office-paid checkbox is not yet flipped.
function unpaidInvoices() {
  const rows = window._paymentRows || [];
  return rows
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => {
      const amt = parseFloat(r.invoicedAmount) || 0;
      const hasInvoice = amt > 0 || !!r.invoiceSent;
      return hasInvoice && !r.paid;
    });
}

// Within a few cents to absorb Stripe's processing-fee rounding quirks.
const AMOUNT_TOLERANCE = 0.005;

function amountsMatch(invoiceAmt, stripeAmt) {
  return Math.abs(invoiceAmt - stripeAmt) <= AMOUNT_TOLERANCE;
}

// Score a candidate Stripe payment against an invoice. Higher = better.
// Required:  amount matches (exact gross within rounding tolerance)
// Boosts:    Stripe email matches the Surgery Center's invoiceEmail
//            Stripe payment date close to the case date
function scoreCandidate(invoice, payment, surgeryCenter) {
  const reasons = [];
  let score = 100; // base for amount match

  const centerEmail = (surgeryCenter?.invoiceEmail || '').trim().toLowerCase();
  if(centerEmail && payment.email && centerEmail === payment.email) {
    score += 80;
    reasons.push(`Email matches Surgery Center (${payment.email})`);
  }
  // Date proximity — invoice's caseDate vs Stripe payment date
  if(invoice.caseDate) {
    const caseTs = new Date(invoice.caseDate + 'T12:00:00').getTime();
    const payTs  = new Date(payment.createdAt).getTime();
    const days   = Math.round(Math.abs(payTs - caseTs) / 86400000);
    if(days <= 7)       { score += 40; reasons.push(`Paid ${days} day${days===1?'':'s'} from case`); }
    else if(days <= 30) { score += 20; reasons.push(`Paid within a month of case`); }
    else if(days <= 90) { score += 5;  reasons.push(`Paid within 3 months of case`); }
    else                { reasons.push(`Paid ${days} days from case`); }
  }
  return { score, reasons };
}

// For each unpaid invoice, find all Stripe payments with a matching amount
// and pick the highest-scoring candidate. Used Stripe payment IDs are tracked
// across invoices so the same payment can't be claimed twice.
function buildMatches(invoices, payments) {
  // Sort invoices by case date so older invoices match older payments first.
  const sortedInvoices = invoices.slice().sort((a, b) => (a.r.caseDate || '').localeCompare(b.r.caseDate || ''));
  const usedIds = new Set();
  const matches = [];
  for(const inv of sortedInvoices) {
    const amt = parseFloat(inv.r.invoicedAmount) || 0;
    if(amt <= 0) continue;
    const center = (window.surgeryCenters || []).find(c => c.id === inv.r.surgeryCenter);
    const candidates = payments
      .filter(p => !usedIds.has(p.id) && amountsMatch(amt, p.amount))
      .map(p => ({ payment: p, ...scoreCandidate(inv.r, p, center) }))
      .sort((a, b) => b.score - a.score);
    if(candidates.length) {
      const best = candidates[0];
      usedIds.add(best.payment.id);
      matches.push({
        invoice: inv,
        candidate: best.payment,
        score: best.score,
        reasons: best.reasons,
        otherCandidates: candidates.slice(1, 4) // up to 3 alternates
      });
    }
  }
  return matches;
}

// ── Review modal ─────────────────────────────────────────────────────────
let _modalBuilt = false;
let _currentMatches = [];
let _allRecentPayments = [];

function buildModal() {
  if(_modalBuilt) return;
  const wrap = document.createElement('div');
  wrap.id = 'stripeMatchModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;align-items:flex-start;justify-content:center;overflow-y:auto;padding:30px 16px';
  wrap.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:960px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#635bff;color:#fff;padding:18px 24px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:600">💵 Match Stripe Payments to Invoices</div>
          <div style="font-size:12px;opacity:.85;margin-top:2px" id="stripe-match-summary">Scanning…</div>
        </div>
        <button onclick="closeStripeMatchModal()" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">Close</button>
      </div>
      <div id="stripe-match-body" style="padding:14px 24px;max-height:65vh;overflow-y:auto"></div>
      <div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div id="stripe-match-foot" style="font-size:12px;color:var(--text-faint)"></div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-ghost" onclick="closeStripeMatchModal()">Done</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  _modalBuilt = true;
}

function fmtPaymentDate(iso) {
  if(!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderMatchModal() {
  const body = $('stripe-match-body');
  const summary = $('stripe-match-summary');
  const foot = $('stripe-match-foot');
  if(!body) return;
  const total = _currentMatches.length;
  const unmatched = (window._paymentRows || []).filter(r => {
    const amt = parseFloat(r.invoicedAmount) || 0;
    const hasInvoice = amt > 0 || !!r.invoiceSent;
    return hasInvoice && !r.paid && !_currentMatches.find(m => m.invoice.r.caseId === r.caseId);
  }).length;
  if(summary) summary.textContent = total
    ? `Found ${total} likely match${total===1?'':'es'} · ${unmatched} unpaid invoice${unmatched===1?'':'s'} with no Stripe candidate`
    : 'No matches found in the last 60 days of Stripe payments.';
  if(foot) foot.textContent = `Reviewed ${_allRecentPayments.length} Stripe payment${_allRecentPayments.length===1?'':'s'} (last 60 days)`;

  if(!total) {
    body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-faint)">No matches found. Either no recent payments line up with your unpaid invoices, or all invoices are already marked paid.</div>';
    return;
  }

  body.innerHTML = _currentMatches.map((m, i) => {
    const { invoice, candidate, score, reasons } = m;
    const r = invoice.r;
    const center = (window.surgeryCenters||[]).find(c => c.id === r.surgeryCenter);
    const centerName = center?.name || r.surgeryCenterName || '';
    const confidence = score >= 180 ? { tag:'HIGH', color:'#16a34a' }
                      : score >= 130 ? { tag:'MEDIUM', color:'#0369a1' }
                      :                 { tag:'LOW', color:'#d97706' };
    return `
      <div id="stripe-match-row-${i}" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px;background:var(--surface)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">
          <div style="flex:1;min-width:300px">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span style="background:${confidence.color}22;color:${confidence.color};font-size:10px;font-weight:700;padding:3px 10px;border-radius:10px;letter-spacing:.5px">${confidence.tag} CONFIDENCE</span>
              <span style="font-family:'DM Mono',monospace;font-size:13px;font-weight:600">${r.caseId || '—'}</span>
              <span style="font-size:13px;color:var(--text-muted)">${centerName}</span>
            </div>
            <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px">
              <div>
                <div style="color:var(--text-faint);font-size:10px;font-weight:600;text-transform:uppercase;margin-bottom:2px">Invoice</div>
                <div>Amount: <strong>$${(parseFloat(r.invoicedAmount)||0).toFixed(2)}</strong></div>
                <div>Case date: ${r.caseDate || '—'}</div>
                <div>Center email: ${(center?.invoiceEmail) || '<span style="color:var(--text-faint)">none</span>'}</div>
              </div>
              <div>
                <div style="color:var(--text-faint);font-size:10px;font-weight:600;text-transform:uppercase;margin-bottom:2px">Stripe Payment</div>
                <div>Amount: <strong>$${candidate.amount.toFixed(2)}</strong></div>
                <div>Paid: ${fmtPaymentDate(candidate.createdAt)}</div>
                <div>Payer email: ${candidate.email || '<span style="color:var(--text-faint)">unknown</span>'}</div>
              </div>
            </div>
            ${reasons.length ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted)"><strong>Signals:</strong> ${reasons.join(' · ')}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;min-width:130px">
            <button class="btn btn-success btn-sm" onclick="window._stripeMatchConfirm(${i})">✓ Mark Paid</button>
            <button class="btn btn-ghost btn-sm" onclick="window._stripeMatchSkip(${i})">Skip</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window._stripeMatchConfirm = async function(idx) {
  const m = _currentMatches[idx];
  if(!m) return;
  const rows = window._paymentRows || [];
  const realIdx = rows.findIndex(r => r.caseId === m.invoice.r.caseId);
  if(realIdx === -1) { alert('Row not found — maybe it was deleted. Refresh and try again.'); return; }
  rows[realIdx].paid = true;
  if(!rows[realIdx].paidDate) {
    rows[realIdx].paidDate = m.candidate.createdAt.split('T')[0];
  }
  rows[realIdx].stripePaymentId = m.candidate.id;
  try {
    await window.setDoc(window.doc(window.db, 'atlas', 'payments'), { rows });
    if(typeof window.renderPaymentRows === 'function') window.renderPaymentRows();
    if(typeof window.renderPaymentSummary === 'function') window.renderPaymentSummary();
  } catch(e) {
    alert('Could not save: ' + e.message);
    return;
  }
  // Remove this match from the modal
  _currentMatches.splice(idx, 1);
  renderMatchModal();
};

window._stripeMatchSkip = function(idx) {
  _currentMatches.splice(idx, 1);
  renderMatchModal();
};

window.openStripeMatchModal = async function() {
  buildModal();
  $('stripeMatchModal').style.display = 'flex';
  const body = $('stripe-match-body');
  if(body) body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-faint)">⏳ Fetching recent Stripe payments…</div>';
  try {
    const res = await fetch(WORKER_URL + '/stripe-list-payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daysBack: 60 })
    });
    if(!res.ok) {
      body.innerHTML = `<div style="padding:32px;color:var(--warn)">Could not fetch Stripe payments (HTTP ${res.status}). Make sure the new /stripe-list-payments endpoint is deployed to the Cloudflare worker.</div>`;
      return;
    }
    const data = await res.json();
    _allRecentPayments = data.payments || [];
    const invoices = unpaidInvoices();
    _currentMatches = buildMatches(invoices, _allRecentPayments);
    renderMatchModal();
  } catch(e) {
    if(body) body.innerHTML = `<div style="padding:32px;color:var(--warn)">Error: ${e.message}</div>`;
  }
};

window.closeStripeMatchModal = function() {
  const m = $('stripeMatchModal');
  if(m) m.style.display = 'none';
};
