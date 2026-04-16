// payout-pdf.js -- Distribution PDF generator + investment payback history
// Depends on: app.js (db, currentWorker, uid, setSyncing)

// ── Generate a PDF receipt when a distribution is recorded ───────────────────
window.generateDistributionPDF = function(opts) {
  // opts: { worker, amount, date, notes, invoicedRev, expenses, investOwed, investPaid }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = 612, M = 50;
  const worker    = opts.worker || 'josh';
  const name      = worker === 'josh' ? 'Josh Condado' : 'Dr. Dev Murthy';
  const dateStr   = opts.date ? new Date(opts.date+'T12:00:00').toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const refNum    = opts.refNum || ('DIST-'+Date.now().toString(36).toUpperCase());
  const fmt       = n => '$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

  // ── Header ─────────────────────────────────────────────────────────────────
  doc.setFillColor(29,53,87);
  doc.rect(0, 0, W, 70, 'F');
  doc.setFont('Helvetica','bold');
  doc.setFontSize(18); doc.setTextColor(255,255,255);
  doc.text('Atlas Anesthesia', M, 30);
  doc.setFontSize(10); doc.setFont('Helvetica','normal');
  doc.text('Distribution Receipt', M, 46);
  doc.setFontSize(9);
  doc.text(refNum, W-M, 30, {align:'right'});
  doc.text(dateStr, W-M, 46, {align:'right'});

  let y = 95;

  // ── Recipient ──────────────────────────────────────────────────────────────
  doc.setTextColor(0,0,0);
  doc.setFont('Helvetica','bold'); doc.setFontSize(11);
  doc.text('Distribution To:', M, y); y += 16;
  doc.setFont('Helvetica','normal'); doc.setFontSize(10);
  doc.text(name, M, y); y += 13;
  doc.text('Atlas Anesthesia', M, y); y += 24;

  // ── Divider ────────────────────────────────────────────────────────────────
  doc.setDrawColor(200,200,200); doc.setLineWidth(0.5);
  doc.line(M, y, W-M, y); y += 18;

  // ── Breakdown table ────────────────────────────────────────────────────────
  doc.setFont('Helvetica','bold'); doc.setFontSize(10);
  doc.text('Breakdown', M, y); y += 14;

  const rows = [
    ['Invoiced Revenue',          fmt(opts.invoicedRev||0),  [0,0,0]],
    ['Other Income',              fmt(opts.otherIncome||0),   [0,0,0]],
    ['Expenses',                  '- '+fmt(opts.expenses||0), [200,60,60]],
    ['Previous Distributions',   '- '+fmt(opts.prevDist||0), [200,60,60]],
  ];
  if(opts.investPaid > 0) {
    rows.push(['Initial Investment Payback', fmt(opts.investPaid||0), [29,83,198]]);
  }
  rows.push(['__separator__', '', []]);
  rows.push(['Total Distribution', fmt(opts.amount||0), [45,106,79]]);

  const colX = [M, W-M-120, W-M];
  rows.forEach(row => {
    if(row[0] === '__separator__') {
      doc.setDrawColor(220,220,220); doc.line(M, y-3, W-M, y-3); y += 6;
      return;
    }
    const [label, val, color] = row;
    const isBold = label === 'Total Distribution';
    doc.setFont('Helvetica', isBold ? 'bold' : 'normal');
    doc.setFontSize(isBold ? 11 : 10);
    doc.setTextColor(color[0]||0, color[1]||0, color[2]||0);
    doc.text(label, colX[0], y);
    doc.text(val, colX[2], y, {align:'right'});
    y += isBold ? 16 : 14;
  });

  y += 10;
  doc.setDrawColor(200,200,200); doc.line(M, y, W-M, y); y += 18;

  // ── Amount box ─────────────────────────────────────────────────────────────
  doc.setFillColor(240,247,240);
  doc.setDrawColor(45,106,79); doc.setLineWidth(1);
  doc.roundedRect(M, y, W-2*M, 44, 4, 4, 'FD');
  doc.setFont('Helvetica','bold'); doc.setFontSize(11);
  doc.setTextColor(80,80,80);
  doc.text('AMOUNT DISTRIBUTED', W/2, y+14, {align:'center'});
  doc.setFontSize(20); doc.setTextColor(45,106,79);
  doc.text(fmt(opts.amount||0), W/2, y+34, {align:'center'});
  y += 62;

  // ── Notes ──────────────────────────────────────────────────────────────────
  if(opts.notes) {
    doc.setFont('Helvetica','bold'); doc.setFontSize(9);
    doc.setTextColor(100,100,100);
    doc.text('Notes:', M, y); y += 12;
    doc.setFont('Helvetica','normal');
    const noteLines = doc.splitTextToSize(opts.notes, W-2*M);
    noteLines.forEach(l => { doc.text(l, M, y); y += 12; });
    y += 6;
  }

  // ── Investment payback note ────────────────────────────────────────────────
  if(opts.investPaid > 0) {
    doc.setFillColor(235,242,255);
    doc.setDrawColor(29,83,198); doc.setLineWidth(0.5);
    doc.roundedRect(M, y, W-2*M, 38, 3, 3, 'FD');
    doc.setFont('Helvetica','bold'); doc.setFontSize(9);
    doc.setTextColor(29,83,198);
    doc.text('Initial Investment Repayment: '+fmt(opts.investPaid), M+10, y+14);
    doc.setFont('Helvetica','normal'); doc.setFontSize(8); doc.setTextColor(80,80,80);
    doc.text('This distribution includes repayment of personal funds invested in Atlas Anesthesia.', M+10, y+28);
    y += 50;
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  doc.setFont('Helvetica','normal'); doc.setFontSize(8);
  doc.setTextColor(160,160,160);
  doc.text('Atlas Anesthesia  ·  Distribution Record  ·  '+refNum+'  ·  '+dateStr, W/2, 760, {align:'center'});
  doc.text('This document is for internal accounting purposes only.', W/2, 772, {align:'center'});

  doc.save('Distribution_'+name.replace(' ','_')+'_'+refNum+'.pdf');
  return refNum;
};

// ── Record investment payback: archive invested entries, log in history ────────
window.recordInvestmentPayback = async function(worker, amountPaid) {
  try {
    setSyncing(true);
    const snap = await getDoc(doc(db, 'atlas', 'payouts'));
    const data = snap.exists() ? snap.data() : { entries:[], distributions:[], investHistory:[] };

    // Find all initial-invest entries for this worker
    const investEntries = (data.entries||[]).filter(e => e.worker===worker && e.cat==='initial-invest');
    const totalInvest   = investEntries.reduce((s,e) => s+(e.amount||0), 0);

    if(!investEntries.length) return;

    // Archive them in investHistory
    if(!data.investHistory) data.investHistory = [];
    data.investHistory.push({
      id: window.uid ? window.uid() : Date.now().toString(36),
      worker, amountPaid, totalInvest,
      entries: investEntries,
      paidBackAt: new Date().toISOString()
    });

    // Remove from active entries
    data.entries = (data.entries||[]).filter(e => !(e.worker===worker && e.cat==='initial-invest'));

    await setDoc(doc(db, 'atlas', 'payouts'), data);
    setSyncing(false);
    console.log('Investment payback archived for', worker);
  } catch(e) { setSyncing(false); console.error('recordInvestmentPayback error:', e); }
};
