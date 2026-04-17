// -- payments.js — Payments tab, invoice modal, saved PDFs ------------------
// Depends on: app.js (db, window.cases, surgeryCenters, window.currentWorker, uid, setSyncing)

let _paymentRows = [];
let _invoiceModalRowIdx = null;

// ════════════════════════════════════════════════════════════════════
// PAYMENTS TAB — complete implementation
// ════════════════════════════════════════════════════════════════════

// -- Daily backup -----------------------------------------------------
async function runDailyPaymentBackup() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const metaSnap = await window.getDoc(window.doc(window.db,'atlas','payments_meta'));
    if(metaSnap.exists() && metaSnap.data().lastBackup === today) return;
    const snap = await window.getDoc(window.doc(window.db,'atlas','payments'));
    if(snap.exists()) {
      await window.setDoc(window.doc(window.db,'atlas','payments_backup_'+today), { rows: snap.data().rows||[], backedUpAt: new Date().toISOString() });
      await window.setDoc(window.doc(window.db,'atlas','payments_meta'), { lastBackup: today });
      console.log('✓ Daily payment backup:', today);
    }
  } catch(e) { console.warn('Backup failed:', e); }
}

// -- Sync from window.cases/preop ---------------------------------------------
function syncPaymentRowsFromCases() {
  const finalized = (window.cases||[]).filter(c => !c.draft);
  let changed = false;
  finalized.forEach(c => {
    const rowIdx = _paymentRows.findIndex(r => r.caseId === c.caseId);
    if(rowIdx !== -1) {
      if(_paymentRows[rowIdx].caseDate !== c.date) { _paymentRows[rowIdx].caseDate = c.date||''; changed=true; }
      if(_paymentRows[rowIdx].worker !== c.worker) { _paymentRows[rowIdx].worker = c.worker; changed=true; }
      if(c.total && _paymentRows[rowIdx].caseCost !== c.total) { _paymentRows[rowIdx].caseCost = c.total; changed=true; }
    } else {
      const preop = (window._rawPreopRecords||[]).find(r => r['po-caseId']===c.caseId);
      const sc = preop?.['po-surgery-center']||'';
      const center = (window.surgeryCenters||[]).find(x=>x.id===sc);
      _paymentRows.push({ id:window.uid(), caseId:c.caseId, name:c.caseId||'', worker:c.worker||'josh',
        caseDate:c.date||preop?.['po-surgeryDate']||'',
        callDate:preop?.['po-callDateTime']?.split('T')[0]||'',
        depositDate:'', paidDate:'', dep500Paid:false, paid:false, invoiceSent:false,
        invoicedAmount:0, projOverride:null, caseCost:c.total||0,
        estHrs:parseFloat(preop?.['po-est-hours'])||0,
        surgeryCenter:sc, surgeryCenterName:center?.name||'' });
      changed=true;
    }
  });
  (window._rawPreopRecords||[]).forEach(r => {
    const rowIdx = _paymentRows.findIndex(pr => pr.caseId===r['po-caseId']);
    if(rowIdx===-1) return;
    const callDate = r['po-callDateTime']?.split('T')[0]||'';
    const estHrs = parseFloat(r['po-est-hours'])||0;
    const sc = r['po-surgery-center']||'';
    const center = (window.surgeryCenters||[]).find(x=>x.id===sc);
    const caseDate = r['po-surgeryDate']||'';
    if(_paymentRows[rowIdx].callDate!==callDate){_paymentRows[rowIdx].callDate=callDate;changed=true;}
    if(_paymentRows[rowIdx].estHrs!==estHrs){_paymentRows[rowIdx].estHrs=estHrs;changed=true;}
    if(_paymentRows[rowIdx].surgeryCenter!==sc){_paymentRows[rowIdx].surgeryCenter=sc;_paymentRows[rowIdx].surgeryCenterName=center?.name||'';changed=true;}
    if(caseDate&&_paymentRows[rowIdx].caseDate!==caseDate){_paymentRows[rowIdx].caseDate=caseDate;changed=true;}
  });
  if(changed) {
    window.setDoc(window.doc(window.db,'atlas','payments'),{rows:_paymentRows}).catch(()=>{});
    if(document.getElementById('tab-payments')?.classList.contains('active')) renderPaymentRows();
  }
}

// -- Load -------------------------------------------------------------
window.loadPaymentRows = async function loadPaymentRows() {
  try {
  runDailyPaymentBackup();
  await _loadPIFormula();
  const [paymentsSnap, casesSnap, preopSnap, scSnap] = await Promise.all([
    window.getDoc(window.doc(window.db,'atlas','payments')),
    window.getDoc(window.doc(window.db,'atlas','cases')),
    window.getDoc(window.doc(window.db,'atlas','preop')),
    window.getDoc(window.doc(window.db,'atlas','surgerycenters'))
  ]);
  _paymentRows = paymentsSnap.exists() ? (paymentsSnap.data().rows||[]) : [];
  const freshCases = casesSnap.exists() ? (casesSnap.data().cases||[]) : (window.cases||[]);
  const freshPreop = preopSnap.exists() ? (preopSnap.data().records||[]) : [];
  const freshCenters = scSnap.exists() ? (scSnap.data().centers||[]) : (window.surgeryCenters||[]);
  window._rawPreopRecords = freshPreop;
  if(freshCenters.length) window.surgeryCenters = freshCenters;
  const finalized = freshCases.filter(c=>!c.draft);
  finalized.forEach(c => {
    const preop = freshPreop.find(r=>r['po-caseId']===c.caseId);
    const sc = preop?.['po-surgery-center']||'';
    const center = freshCenters.find(x=>x.id===sc);
    const callDate = preop?.['po-callDateTime']?.split('T')[0]||'';
    const caseDate = preop?.['po-surgeryDate']||c.date||'';
    const estHrs = parseFloat(preop?.['po-est-hours'])||0;
    const existIdx = _paymentRows.findIndex(r=>r.caseId===c.caseId);
    if(existIdx===-1) {
      _paymentRows.push({ id:window.uid(), caseId:c.caseId, name:c.caseId||'', worker:c.worker||'josh',
        caseDate, callDate, depositDate:'', paidDate:'', dep500Paid:false, paid:false,
        invoiceSent:false, invoicedAmount:0, projOverride:null, caseCost:c.total||0,
        estHrs, surgeryCenter:sc, surgeryCenterName:center?.name||'' });
    } else {
      _paymentRows[existIdx] = { ..._paymentRows[existIdx],
        name: c.caseId||_paymentRows[existIdx].name,
        worker: c.worker||_paymentRows[existIdx].worker,
        caseDate: caseDate||_paymentRows[existIdx].caseDate,
        callDate: callDate||_paymentRows[existIdx].callDate,
        caseCost: c.total||_paymentRows[existIdx].caseCost,
        estHrs: estHrs||_paymentRows[existIdx].estHrs,
        surgeryCenter: sc||_paymentRows[existIdx].surgeryCenter,
        surgeryCenterName: center?.name||_paymentRows[existIdx].surgeryCenterName||'' };
    }
  });
  _paymentRows.sort((a,b)=>(a.caseDate||'9999').localeCompare(b.caseDate||'9999'));
  renderPaymentRows();
  renderPaymentSummary();
  // Auto-sync all invoiced rows to Expenses & Distributions on every load
  _syncAllInvoicedToPayouts(_paymentRows).catch(()=>{});
  } catch(e) { console.error('loadPaymentRows error:', e); const body=document.getElementById('payments-table-body'); if(body) body.innerHTML='<div style="padding:32px;color:red;font-size:13px">Error loading payments: '+e.message+'<br><small>'+e.stack+'</small></div>'; }
}

// -- Save (only editable fields) ---------------------------------------
window.savePaymentRows = async function() {
  _paymentRows = _paymentRows.map((row,i) => ({
    ...row,
    depositDate: document.getElementById('pr-depositDate'+i)?.value||row.depositDate||'',
    paidDate:    document.getElementById('pr-paidDate'+i)?.value||row.paidDate||'',
    dep500Paid:  document.getElementById('pr-dep500'+i)?.checked??row.dep500Paid??false,
    paid:        document.getElementById('pr-paid'+i)?.checked??row.paid,
    invoiceSent: document.getElementById('pr-inv'+i)?.checked??row.invoiceSent,
  }));
  // Sync all invoiced rows to Expenses & Distributions in one batch write
  _syncAllInvoicedToPayouts(_paymentRows).catch(()=>{});
  try {
    window.setSyncing(true);
    await window.setDoc(window.doc(window.db,'atlas','payments'),{rows:_paymentRows});
    window.setSyncing(false);
    renderPaymentSummary();
    const btn = document.querySelector('[onclick="savePaymentRows()"]');
    if(btn){const o=btn.textContent;btn.textContent='✓ Saved';setTimeout(()=>btn.textContent=o,1500);}
  } catch(e){window.setSyncing(false);alert('Error: '+e.message);}
};

// -- Auto-save (debounced) ---------------------------------------------
let _paymentSaveTimer = null;
function autoSavePayments() {
  clearTimeout(_paymentSaveTimer);
  _paymentSaveTimer = setTimeout(()=>window.savePaymentRows().catch(()=>{}), 900);
}

// -- Delete ------------------------------------------------------------
window.deletePaymentRow = async function(idx) {
  if(!confirm('Delete this payment row?\n\nThis cannot be undone.')) return;
  _paymentRows.splice(idx,1);
  window.setSyncing(true);
  await window.setDoc(window.doc(window.db,'atlas','payments'),{rows:_paymentRows});
  window.setSyncing(false);
  renderPaymentRows();
};

// -- Sort --------------------------------------------------------------
window.sortPaymentRows = function() {
  const mode = document.getElementById('pm-sort')?.value||'date-asc';
  _paymentRows.sort((a,b)=>{
    if(mode==='date-asc')  return (a.caseDate||'9999').localeCompare(b.caseDate||'9999');
    if(mode==='date-desc') return (b.caseDate||'').localeCompare(a.caseDate||'');
    if(mode==='who')       return (a.worker||'').localeCompare(b.worker||'');
    if(mode==='center')    return (a.surgeryCenterName||'').localeCompare(b.surgeryCenterName||'');
    if(mode==='inv')       return (b.invoiceSent?1:0)-(a.invoiceSent?1:0);
    return 0;
  });
  renderPaymentRows();
};

// -- Summary -----------------------------------------------------------
function renderPaymentSummary() {
  let invTotal=0;
  _paymentRows.forEach(r=>{ invTotal += r.invoicedAmount||0; });
  const fmt = n=>'$'+(n||0).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});
  const el = id=>document.getElementById(id);
  if(el('pm-invoiced')) el('pm-invoiced').textContent = fmt(invTotal);
  // Render personal income + projected cards
  if(typeof _renderPICards === 'function') _renderPICards();
}

// -- Render rows -------------------------------------------------------
function renderPaymentRows() {
  const body = document.getElementById('payments-table-body');
  if(!body) return;
  if(!_paymentRows.length) {
    body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-faint);font-size:13px">No window.cases yet — save a Pre-Op record to auto-populate window.cases here</div>';
    renderPaymentSummary(); return;
  }

  const dateInp = (id,val) => {
    const empty=!val;
    const bdr=empty?'1px solid #fca5a5':'1px solid var(--border)';
    const bgc=empty?'rgba(239,68,68,0.06)':'var(--bg)';
    return `<input type="date" id="${id}" value="${val||''}" style="width:100%;padding:4px 3px;font-size:11px;border:${bdr};border-radius:4px;background:${bgc};color:var(--text);font-family:inherit" onchange="renderPaymentSummary();autoSavePayments()">`;
  };
  const ro = (val,color)=>`<span style="font-size:11px;color:${color||'var(--text-muted)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${val||'<span style="color:#fca5a5;font-size:10px">—</span>'}</span>`;
  const wcolor = w=>w==='dev'?'var(--dev)':'var(--josh)';
  const COLS = '160px 50px 1fr 44px 68px 88px 88px 86px 32px 86px 38px 76px 38px 46px 30px';

  body.innerHTML = _paymentRows.map((r,i)=>{
    const complete = r.depositDate&&r.paidDate&&r.dep500Paid&&r.paid&&r.invoiceSent;
    const bg = complete?'rgba(45,106,79,0.08)':i%2===0?'var(--bg)':'var(--surface2)';
    const bl = complete?'3px solid var(--accent)':'3px solid transparent';
    const proj = r.projOverride!=null ? '$'+Number(r.projOverride).toFixed(0) : r.estHrs>0?'$'+(r.estHrs*600).toFixed(0):'—';
    const projColor = r.projOverride!=null?'var(--info)':'var(--accent)';
    const center = (window.surgeryCenters||[]).find(c=>c.id===r.surgeryCenter);
    const scName = center?.name||r.surgeryCenterName||'';
    const centerPays = center ? center.billingType === 'center' : false;
    const greyCell = 'background:rgba(0,0,0,0.06);border-radius:4px;opacity:0.4;pointer-events:none;user-select:none;display:flex;align-items:center;justify-content:center;height:32px';
    const caseFmt = r.caseDate?new Date(r.caseDate+'T12:00:00Z').toLocaleDateString('en-US',{month:'2-digit',day:'2-digit',year:'2-digit'}):'';
    const callFmt = r.callDate?new Date(r.callDate+'T12:00:00Z').toLocaleDateString('en-US',{month:'2-digit',day:'2-digit',year:'2-digit'}):'';
    const invAmt = r.invoicedAmount>0?`<span style="font-size:11px;font-weight:600;font-family:DM Mono,monospace;color:var(--info)">$${Number(r.invoicedAmount).toFixed(2)}</span><button onclick="editPaymentField('invamt',${i})" style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint);padding:0 2px" title="Edit">✏</button>`:`<span style="color:var(--text-faint);font-size:11px">—</span><button onclick="editPaymentField('invamt',${i})" style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint);padding:0 2px" title="Edit">✏</button>`;
    const projCell = `<span style="font-size:11px;font-weight:600;color:${projColor};font-family:DM Mono,monospace">${proj}</span><button onclick="editPaymentField('proj',${i})" style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint);padding:0 2px" title="Edit">✏</button>`;
    return `<div style="display:grid;grid-template-columns:${COLS};gap:0;background:${bg};border-bottom:1px solid var(--border);border-left:${bl};align-items:center;min-height:40px">
      <div style="padding:4px 8px;font-size:11px;font-weight:600;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name||''}">${r.name||'—'}</div>
      <div style="padding:4px 3px;font-size:11px;font-weight:600;color:${wcolor(r.worker)}">${r.worker==='dev'?'Dev':'Josh'}</div>
      <div style="padding:4px 3px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${scName}">${scName||'<span style="color:#fca5a5;font-size:10px">—</span>'}</div>
      <div style="padding:4px 3px;font-size:11px;font-weight:600;color:var(--accent);text-align:right">${r.estHrs>0?r.estHrs+'h':'<span style="color:#fca5a5;font-size:10px">—</span>'}</div>
      <div style="padding:4px 3px;display:flex;align-items:center;justify-content:flex-end;gap:2px">${projCell}</div>
      <div style="padding:4px 3px">${ro(caseFmt)}</div>
      <div style="padding:4px 3px">${ro(callFmt)}</div>
      <div style="padding:4px 3px">${centerPays ? `<div style="${greyCell}"><span style="font-size:10px;color:var(--text-faint)">N/A</span></div>` : dateInp('pr-depositDate'+i,r.depositDate)}</div>
      ${centerPays ? `<div style="${greyCell}"><span style="font-size:10px;color:var(--text-faint)">—</span></div>` : `<div style="padding:4px 2px;display:flex;align-items:center;justify-content:center"><input type="checkbox" id="pr-dep500${i}" ${r.dep500Paid?'checked':''} style="width:14px;height:14px;cursor:pointer" onchange="renderPaymentSummary();autoSavePayments()"></div>`}
      <div style="padding:4px 3px">${centerPays ? `<div style="${greyCell}"><span style="font-size:10px;color:var(--text-faint)">N/A</span></div>` : dateInp('pr-paidDate'+i,r.paidDate)}</div>
      ${centerPays ? `<div style="${greyCell}"><span style="font-size:10px;color:var(--text-faint)">—</span></div>` : `<div style="padding:4px 2px;display:flex;align-items:center;justify-content:center"><input type="checkbox" id="pr-paid${i}" ${r.paid?'checked':''} style="width:14px;height:14px;cursor:pointer" onchange="renderPaymentSummary();autoSavePayments()"></div>`}
      <div style="padding:4px 3px;display:flex;align-items:center;justify-content:flex-end;gap:2px">${invAmt}</div>
      <div style="padding:4px 2px;display:flex;align-items:center;justify-content:center"><input type="checkbox" id="pr-inv${i}" ${r.invoiceSent?'checked':''} style="width:14px;height:14px;cursor:pointer" onchange="renderPaymentSummary();autoSavePayments()"></div>
      <div style="padding:4px 3px"><button onclick="openInvoiceModal(${i})" style="width:100%;background:var(--info);color:#fff;border:none;border-radius:4px;padding:4px 0;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">📄</button></div>
      <div style="padding:4px 8px;display:flex;align-items:center;justify-content:flex-end"><button onclick="deletePaymentRow(${i})" style="background:none;border:none;cursor:pointer;font-size:13px;color:#d1d5db;transition:color .15s" onmouseover="this.style.color='#ef4444'" onmouseout="this.style.color='#d1d5db'" title="Delete">🗑</button></div>
    </div>`;
  }).join('');
  renderPaymentSummary();
}

// -- Edit popup (proj / invamt) -----------------------------------------
window.editPaymentField = function(field, rowIdx) {
  const old = document.getElementById('payment-edit-popup');
  if(old) old.remove();
  const isProj = field==='proj';
  const currentVal = isProj
    ? (_paymentRows[rowIdx]?.projOverride!=null?_paymentRows[rowIdx].projOverride:(_paymentRows[rowIdx]?.estHrs||0)*600)
    : (_paymentRows[rowIdx]?.invoicedAmount||0);
  const overlay = document.createElement('div');
  overlay.id = 'payment-edit-popup';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface);border-radius:12px;padding:28px 32px;width:320px;box-shadow:0 20px 60px rgba(0,0,0,.35);text-align:center';
  box.innerHTML = `<div style="font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Edit ${isProj?'Projected Income':'Invoiced Amount'}</div>
    <div style="font-size:11px;color:var(--text-faint);margin-bottom:16px">${isProj?'Overrides Hrs × $600':'Overrides invoice modal amount'}</div>`;
  const inp = document.createElement('input');
  inp.type='number'; inp.step='0.01'; inp.min='0'; inp.value=currentVal.toFixed(2);
  inp.style.cssText='width:100%;padding:12px 14px;font-size:22px;font-weight:700;font-family:DM Mono,monospace;border:2px solid var(--info);border-radius:8px;background:var(--bg);color:var(--text);text-align:center;outline:none;box-sizing:border-box';
  const btns = document.createElement('div');
  btns.style.cssText='display:flex;gap:10px;margin-top:18px';
  const cancel=document.createElement('button'); cancel.textContent='Cancel';
  cancel.style.cssText='flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit';
  const save=document.createElement('button'); save.textContent='Save Amount';
  save.style.cssText='flex:2;padding:10px;border:none;border-radius:8px;background:var(--info);color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit';
  const doSave=()=>{commitPaymentField(field,rowIdx,parseFloat(inp.value)||0);overlay.remove();};
  const doCancel=()=>overlay.remove();
  save.onclick=doSave; cancel.onclick=doCancel;
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')doSave();if(e.key==='Escape')doCancel();});
  overlay.addEventListener('click',e=>{if(e.target===overlay)doCancel();});
  btns.appendChild(cancel); btns.appendChild(save);
  box.appendChild(inp); box.appendChild(btns);
  overlay.appendChild(box); document.body.appendChild(overlay);
  requestAnimationFrame(()=>{inp.focus();inp.select();});
};

window.commitPaymentField = function(field, idx, val) {
  if(field==='proj') { _paymentRows[idx].projOverride=val; }
  else { _paymentRows[idx].invoicedAmount=val;
    if(val > 0 && _paymentRows[idx].invoiceSent) {
      _syncInvoiceToPayouts(_paymentRows[idx], parseFloat(val)||0).catch(()=>{});
    }
  }
  window.setDoc(window.doc(window.db,'atlas','payments'),{rows:_paymentRows}).catch(()=>{});
  renderPaymentRows(); renderPaymentSummary();
};

// -- Saved PDFs ---------------------------------------------------------
let _savedPDFs = [];

window.loadSavedPDFs = async function loadSavedPDFs() {
  try {
    const snap = await window.getDoc(window.doc(window.db,'atlas','saved_pdfs'));
    _savedPDFs = snap.exists()?(snap.data().pdfs||[]):[];
  } catch(e){_savedPDFs=[];}
  renderSavedPDFs();
}
async function savePDFRecord(record) {
  try {
    const snap = await window.getDoc(window.doc(window.db,'atlas','saved_pdfs'));
    const existing = snap.exists()?(snap.data().pdfs||[]):[];
    existing.unshift(record);
    await window.setDoc(window.doc(window.db,'atlas','saved_pdfs'),{pdfs:existing});
    _savedPDFs = existing; renderSavedPDFs();
  } catch(e){console.error('savePDFRecord error:',e);}
}
function renderSavedPDFs() {
  const el = document.getElementById('saved-pdfs-list');
  if(!el) return;
  if(!_savedPDFs.length){el.innerHTML='<div class="empty-state" style="font-size:13px">No saved invoices yet</div>';return;}
  el.innerHTML = _savedPDFs.map(p=>{
    const pill = p.worker==='dev'?'pill-dev':'pill-josh';
    const wname = p.worker==='dev'?'Dev':'Josh';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
      <div><div style="font-size:13px;font-weight:500">${p.invoiceNum||'Invoice'}</div>
      <div style="font-size:11px;color:var(--text-faint)">${p.date||''} · ${p.location||''} · <span class="worker-pill ${pill}">${wname}</span></div></div>
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:16px;font-weight:600;font-family:DM Mono,monospace;color:var(--info)">$${Number(p.total||0).toFixed(2)}</span>
        ${p.emailed?'<span style="font-size:10px;background:var(--accent-light);color:var(--accent);padding:2px 8px;border-radius:10px;font-weight:600">📧 Sent</span>':''}
      </div></div>`;
  }).join('');
}

// -- Invoice modal -----------------------------------------------------
window.openInvoiceModal = function(rowIdx) {
  _invoiceModalRowIdx = rowIdx!==undefined?rowIdx:null;
  const r = rowIdx!==undefined?_paymentRows[rowIdx]:null;
  const caseEl=document.getElementById('inv-modal-case');
  if(caseEl) caseEl.value=r?.caseId||'';
  ['inv-modal-provider','inv-modal-email','inv-modal-fhr','inv-modal-p15'].forEach(id=>{
    const el=document.getElementById(id);if(el){el.value='';el.readOnly=false;el.style.background='';el.style.color='';}
  });
  ['inv-modal-date','inv-modal-start','inv-modal-end','inv-modal-location'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.value='';
  });
  const locInput=document.getElementById('inv-modal-location');
  if(locInput)locInput.style.display='none';
  if(typeof setInvModalBilling==='function')setInvModalBilling('hourly');
  populateInvModalCenterDropdown(r?.surgeryCenter||'');
  if(r?.caseDate){const dt=document.getElementById('inv-modal-date');if(dt)dt.value=r.caseDate;}
  const prov=document.getElementById('inv-modal-provider');
  if(prov)prov.value=(r?.worker||window.currentWorker||'josh')==='dev'?'Dr. Dev Murthy':'Josh Condado';
  if(r?.surgeryCenter){
    onInvModalCenterChange();
    const scSel=document.getElementById('inv-modal-sc-select');
    if(scSel){scSel.disabled=true;scSel.style.background='var(--surface2)';scSel.style.color='var(--text-muted)';scSel.title='Linked from Pre-Op';}
  }
  document.getElementById('invoiceModal').style.display='flex';
  calcInvModal();
};

window.closeInvoiceModal = function() {
  const scSel=document.getElementById('inv-modal-sc-select');
  if(scSel){scSel.disabled=false;scSel.style.background='';scSel.style.color='';scSel.title='';}
  document.getElementById('invoiceModal').style.display='none';
  _invoiceModalRowIdx=null;
};

function populateInvModalCenterDropdown(preselect) {
  const sel=document.getElementById('inv-modal-sc-select');
  if(!sel)return;
  const centers=window.surgeryCenters||[];
  sel.innerHTML='<option value="">— Select surgery center —</option>'
    +centers.map(c=>`<option value="${c.id}" ${c.id===preselect?'selected':''}>${c.name}</option>`).join('')
    +'<option value="__custom__">✏ Custom...</option>';
  if(preselect)onInvModalCenterChange();
}

window.onInvModalCenterChange = function() {
  const sel=document.getElementById('inv-modal-sc-select');
  const locInput=document.getElementById('inv-modal-location');
  const fhr=document.getElementById('inv-modal-fhr');
  const p15=document.getElementById('inv-modal-p15');
  const emailEl=document.getElementById('inv-modal-email');
  const val=sel?.value;
  if(emailEl){emailEl.readOnly=false;emailEl.style.background='';emailEl.style.color='';emailEl.removeAttribute('title');}
  if(val==='__custom__'){
    if(locInput){locInput.style.display='';locInput.value='';locInput.focus();}
    return;
  }
  if(!val){if(locInput){locInput.style.display='none';locInput.value='';}return;}
  const center=(window.surgeryCenters||[]).find(c=>c.id===val);
  if(!center)return;
  if(locInput){locInput.style.display='none';locInput.value=center.name||'';}
  if(fhr)fhr.value=center.firstHour!=null?Number(center.firstHour).toFixed(2):'';
  if(p15)p15.value=center.per15!=null?Number(center.per15).toFixed(2):'';
  if(emailEl&&center.invoiceEmail){
    emailEl.value=center.invoiceEmail;emailEl.readOnly=true;
    emailEl.style.background='var(--surface2)';emailEl.style.color='var(--text-muted)';
    emailEl.title='From Surgery Centers tab';
  }
  const frs=center.flatRates||[];
  const procSel=document.getElementById('inv-modal-flat-proc-select');
  if(procSel){
    procSel.innerHTML='<option value="">— Select procedure —</option>'
      +frs.map(fr=>`<option value="${fr.id}" data-amount="${fr.amount}">${fr.procedure} — $${Number(fr.amount).toFixed(2)}</option>`).join('')
      +'<option value="__custom__">✏ Custom procedure...</option>';
  }
  calcInvModal();
};

window.onInvModalFlatProcSelect = function() {
  const sel=document.getElementById('inv-modal-flat-proc-select');
  const customInput=document.getElementById('inv-modal-flat-proc');
  const amtInput=document.getElementById('inv-modal-flat-amt');
  const val=sel?.value;
  if(val==='__custom__'){
    if(customInput){customInput.style.display='';customInput.value='';customInput.focus();}
    if(amtInput)amtInput.value='';
  } else if(val) {
    const opt=sel.options[sel.selectedIndex];
    const amount=parseFloat(opt?.getAttribute('data-amount'))||0;
    if(customInput)customInput.style.display='none';
    if(amtInput&&amount>0){amtInput.value=amount.toFixed(2);calcInvModalFlat();}
  } else {
    if(customInput)customInput.style.display='none';
    if(amtInput)amtInput.value='';
  }
};

window.setInvModalBilling = function(type) {
  document.getElementById('inv-modal-billing-type').value=type;
  const btnH=document.getElementById('inv-modal-btn-hourly');
  const btnF=document.getElementById('inv-modal-btn-flat');
  const ACTIVE='2px solid var(--info)', IDLE='2px solid var(--border)';
  if(type==='flat'){
    if(btnH){btnH.style.border=IDLE;btnH.style.background='var(--surface)';btnH.style.color='var(--text-muted)';btnH.style.fontWeight='500';}
    if(btnF){btnF.style.border=ACTIVE;btnF.style.background='var(--info-light)';btnF.style.color='var(--info)';btnF.style.fontWeight='600';}
    document.getElementById('inv-modal-hourly-fields').style.display='none';
    document.getElementById('inv-modal-flat-fields').style.display='';
    document.getElementById('inv-modal-flat-amt-wrap').style.display='';
    onInvModalCenterChange();
    calcInvModalFlat();
  } else {
    if(btnH){btnH.style.border=ACTIVE;btnH.style.background='var(--info-light)';btnH.style.color='var(--info)';btnH.style.fontWeight='600';}
    if(btnF){btnF.style.border=IDLE;btnF.style.background='var(--surface)';btnF.style.color='var(--text-muted)';btnF.style.fontWeight='500';}
    document.getElementById('inv-modal-hourly-fields').style.display='contents';
    document.getElementById('inv-modal-flat-fields').style.display='none';
    document.getElementById('inv-modal-flat-amt-wrap').style.display='none';
  }
};

window.calcInvModal = function() {
  if(document.getElementById('inv-modal-billing-type')?.value==='flat'){calcInvModalFlat();return window._invModalCalc||null;}
  const start=document.getElementById('inv-modal-start')?.value;
  const end=document.getElementById('inv-modal-end')?.value;
  const fhr=parseFloat(document.getElementById('inv-modal-fhr')?.value)||0;
  const p15=parseFloat(document.getElementById('inv-modal-p15')?.value)||0;
  const summEl=document.getElementById('inv-modal-summary');
  const totEl=document.getElementById('inv-modal-total');
  if(!start||!end||!fhr){if(totEl)totEl.textContent='$0.00';return null;}
  const [sh,sm]=start.split(':').map(Number);
  const [eh,em]=end.split(':').map(Number);
  const totalMins=(eh*60+em)-(sh*60+sm);
  if(totalMins<=0){if(totEl)totEl.textContent='$0.00';return null;}
  const roundedMins=totalMins<=60?60:60+Math.ceil((totalMins-60)/15)*15;
  let total=fhr;
  if(roundedMins>60)total+=((roundedMins-60)/15)*p15;
  const billedStr=`${Math.floor(roundedMins/60)}h${roundedMins%60>0?' '+roundedMins%60+'m':''}`;
  if(summEl)summEl.textContent=`Billed: ${billedStr}`;
  if(totEl)totEl.textContent='$'+total.toFixed(2);
  window._invModalCalc={total,roundedMins,billedStr,start,end,fhr,p15,flat:false};
  return window._invModalCalc;
};

window.calcInvModalFlat = function() {
  const procSel=document.getElementById('inv-modal-flat-proc-select');
  const procCustom=document.getElementById('inv-modal-flat-proc');
  const proc=(procSel?.value==='__custom__'||!procSel?.value)?(procCustom?.value?.trim()||'')
    :procSel.options[procSel.selectedIndex]?.text.split(' — ')[0]||'';
  const amt=parseFloat(document.getElementById('inv-modal-flat-amt')?.value)||0;
  const summEl=document.getElementById('inv-modal-summary');
  const totEl=document.getElementById('inv-modal-total');
  if(amt>0){
    if(summEl)summEl.textContent=(proc?proc+' — ':'')+'Flat Rate';
    if(totEl)totEl.textContent='$'+amt.toFixed(2);
    window._invModalCalc={total:amt,billedStr:'Flat Rate',flat:true,proc};
  } else {
    if(summEl)summEl.textContent='Enter flat rate amount';
    if(totEl)totEl.textContent='$0.00';
    window._invModalCalc=null;
  }
};

function _getInvoiceHeader() {
  const w=(typeof window.currentWorker!=='undefined'?window.currentWorker:'josh');
  const provider=document.getElementById('inv-modal-provider')?.value||(w==='josh'?'Josh Condado':'Dr. Dev Murthy');
  const phone=w==='josh'?'715-499-6858':'262-573-9095';
  const scSel=document.getElementById('inv-modal-sc-select');
  const center=(window.surgeryCenters||[]).find(c=>c.id===scSel?.value);
  const locInput=document.getElementById('inv-modal-location');
  const location=(scSel?.value==='__custom__'||!center)?(locInput?.value||'—'):(center?.name||'—');
  const date=document.getElementById('inv-modal-date')?.value||'';
  const formattedDate=date?new Date(date+'T12:00:00').toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}):'—';
  const invoiceNum='ATL-INV-'+(date||new Date().toISOString().split('T')[0]).replace(/-/g,'')+'-'+String(Math.floor(Math.random()*900)+100);
  window._currentInvoiceNum=invoiceNum;
  return {provider,phone,location,date,formattedDate,invoiceNum,w};
}

function buildInvoiceModalHTML() {
  return document.getElementById('inv-modal-billing-type')?.value==='flat'?buildFlatRateInvoiceHTML():buildHourlyInvoiceHTML();
}

function buildHourlyInvoiceHTML() {
  const {provider,phone,location,formattedDate,invoiceNum}=_getInvoiceHeader();
  const calc=window._invModalCalc||{};
  const total=calc.total||0;
  const fmt12=t=>{if(!t)return '—';const[h,m]=t.split(':').map(Number);return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;};
  return `<div style="font-family:Arial,sans-serif;font-size:12px;color:#000;line-height:1.5">
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px"><tr>
      <td style="vertical-align:top"><div style="font-size:17px;font-weight:bold;color:#1d3557">Atlas Anesthesia</div>
      <div style="font-size:10px;color:#444">${provider} | CRNA, Anesthesiology · ${phone}</div></td>
      <td style="text-align:right;vertical-align:top"><div style="font-size:20px;font-weight:bold;color:#1d3557">INVOICE</div>
      <div style="font-size:9px;color:#666">${invoiceNum}</div><div style="font-size:9px;color:#666">${formattedDate}</div></td>
    </tr></table>
    <hr style="border:none;border-top:2px solid #1d3557;margin:4px 0 10px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:10px;font-size:11px">
      <tr><td style="padding:4px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;width:110px">BILLED TO:</td><td style="padding:4px 8px;border:1px solid #bbb;font-weight:500">${location}</td></tr>
      <tr><td style="padding:4px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">FROM:</td><td style="padding:4px 8px;border:1px solid #bbb">${provider} — Atlas Anesthesia</td></tr>
      <tr><td style="padding:4px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">TIME:</td><td style="padding:4px 8px;border:1px solid #bbb">${fmt12(calc.start)} → ${fmt12(calc.end)} · Billed: ${calc.billedStr||'—'}</td></tr>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px">
      <tr style="background:#1d3557;color:#fff"><td style="padding:5px 8px;font-weight:bold">Description</td><td style="padding:5px 8px;font-weight:bold;text-align:center">Time</td><td style="padding:5px 8px;font-weight:bold;text-align:right">Amount</td></tr>
      <tr style="background:#f0efe9"><td style="padding:5px 8px;border:1px solid #bbb">Anesthesia Services — First Hour</td><td style="padding:5px 8px;border:1px solid #bbb;text-align:center">60 min</td><td style="padding:5px 8px;border:1px solid #bbb;text-align:right;font-family:monospace">$${(calc.fhr||0).toFixed(2)}</td></tr>
      ${(calc.roundedMins||0)>60?`<tr><td style="padding:5px 8px;border:1px solid #bbb">Additional Time</td><td style="padding:5px 8px;border:1px solid #bbb;text-align:center">${(calc.roundedMins||0)-60} min</td><td style="padding:5px 8px;border:1px solid #bbb;text-align:right;font-family:monospace">$${(((calc.roundedMins||0)-60)/15*(calc.p15||0)).toFixed(2)}</td></tr>`:''}
      <tr style="background:#1d3557;color:#fff"><td style="padding:6px 8px;font-weight:bold;font-size:13px" colspan="2">TOTAL DUE</td><td style="padding:6px 8px;font-weight:bold;font-size:15px;text-align:right;font-family:monospace">$${total.toFixed(2)}</td></tr>
    </table>
    <div style="font-size:9px;color:#888;text-align:center;border-top:1px solid #ccc;padding-top:6px">Thank you for choosing Atlas Anesthesia · Mobile Anesthesia Services</div></div>`;
}

function buildFlatRateInvoiceHTML() {
  const {provider,phone,location,formattedDate,invoiceNum}=_getInvoiceHeader();
  const procSel=document.getElementById('inv-modal-flat-proc-select');
  const procCustom=document.getElementById('inv-modal-flat-proc');
  const proc=(procSel?.value==='__custom__'||!procSel?.value)?(procCustom?.value||'Anesthesia Services')
    :procSel.options[procSel.selectedIndex]?.text.split(' — ')[0]||'Anesthesia Services';
  const amt=parseFloat(document.getElementById('inv-modal-flat-amt')?.value)||0;
  return `<div style="font-family:Arial,sans-serif;font-size:12px;color:#000;line-height:1.5">
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px"><tr>
      <td style="vertical-align:top"><div style="font-size:17px;font-weight:bold;color:#1d3557">Atlas Anesthesia</div>
      <div style="font-size:10px;color:#444">${provider} | CRNA, Anesthesiology · ${phone}</div></td>
      <td style="text-align:right;vertical-align:top"><div style="font-size:20px;font-weight:bold;color:#1d3557">INVOICE</div>
      <div style="font-size:9px;color:#666">${invoiceNum}</div><div style="font-size:9px;color:#666">${formattedDate}</div></td>
    </tr></table>
    <hr style="border:none;border-top:2px solid #1d3557;margin:4px 0 10px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:10px;font-size:11px">
      <tr><td style="padding:4px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold;width:110px">BILLED TO:</td><td style="padding:4px 8px;border:1px solid #bbb;font-weight:500">${location}</td></tr>
      <tr><td style="padding:4px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">FROM:</td><td style="padding:4px 8px;border:1px solid #bbb">${provider} — Atlas Anesthesia</td></tr>
      <tr><td style="padding:4px 8px;border:1px solid #bbb;background:#f0f0f0;font-weight:bold">TYPE:</td><td style="padding:4px 8px;border:1px solid #bbb">Flat Rate Procedure</td></tr>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px">
      <tr style="background:#1d3557;color:#fff"><td style="padding:5px 8px;font-weight:bold">Procedure</td><td style="padding:5px 8px;font-weight:bold;text-align:right">Flat Rate Amount</td></tr>
      <tr style="background:#f0efe9"><td style="padding:8px 8px;border:1px solid #bbb;font-size:13px;font-weight:500">${proc}</td><td style="padding:8px 8px;border:1px solid #bbb;text-align:right;font-family:monospace;font-size:13px;font-weight:600">$${amt.toFixed(2)}</td></tr>
      <tr style="background:#1d3557;color:#fff"><td style="padding:6px 8px;font-weight:bold;font-size:13px">TOTAL DUE</td><td style="padding:6px 8px;font-weight:bold;font-size:15px;text-align:right;font-family:monospace">$${amt.toFixed(2)}</td></tr>
    </table>
    <div style="font-size:9px;color:#888;text-align:center;border-top:1px solid #ccc;padding-top:6px">Thank you for choosing Atlas Anesthesia · Mobile Anesthesia Services</div></div>`;
}

window.previewInvoiceModal = function() {
  calcInvModal();
  const preview=document.getElementById('inv-modal-preview');
  if(preview)preview.innerHTML=buildInvoiceModalHTML();
};

window.downloadInvoiceModal = async function() {
  const caseId=document.getElementById('inv-modal-case')?.value;
  if(!caseId){alert('Please select a case first.');return;}
  const scSel=document.getElementById('inv-modal-sc-select');
  const center=(window.surgeryCenters||[]).find(c=>c.id===scSel?.value);
  const locInput=document.getElementById('inv-modal-location');
  const location=(scSel?.value==='__custom__'||!center)?(locInput?.value||''):(center?.name||'');
  const date=document.getElementById('inv-modal-date')?.value||'';
  const billingType=document.getElementById('inv-modal-billing-type')?.value||'hourly';
  const invoiceNum='ATL-INV-'+(date||new Date().toISOString().split('T')[0]).replace(/-/g,'')+'-'+String(Math.floor(Math.random()*900)+100);
  if(!location||!date){alert('Please fill in surgery center and date.');return;}
  if(billingType==='flat'){
    const amt=parseFloat(document.getElementById('inv-modal-flat-amt')?.value)||0;
    if(amt<=0){alert('Please enter a flat rate amount.');return;}
    const proc=document.getElementById('inv-modal-flat-proc-select')?.value==='__custom__'
      ?(document.getElementById('inv-modal-flat-proc')?.value||'Anesthesia Services')
      :(document.getElementById('inv-modal-flat-proc-select')?.options[document.getElementById('inv-modal-flat-proc-select')?.selectedIndex]?.text.split(' — ')[0]||'Anesthesia Services');
    window._invModalCalc={total:amt,billedStr:'Flat Rate',flat:true,proc};
    window._generateFlatRateInvoicePDF(location,date,document.getElementById('inv-modal-provider')?.value||'',proc,amt);
    await savePDFRecord({id:window.uid(),invoiceNum,location,date,provider:document.getElementById('inv-modal-provider')?.value||'',total:amt,caseId,worker:window.currentWorker,emailed:false,savedAt:new Date().toISOString()});
    if(_invoiceModalRowIdx!==null&&_paymentRows[_invoiceModalRowIdx]){_paymentRows[_invoiceModalRowIdx].invoicedAmount=amt;renderPaymentRows();}
  } else {
    const calc=calcInvModal();
    if(!calc){alert('Please fill in times and rates.');return;}
    window._generateFlatRateInvoicePDF(location,date,document.getElementById('inv-modal-provider')?.value||'','Anesthesia Services',calc.total);
    await savePDFRecord({id:window.uid(),invoiceNum,location,date,provider:document.getElementById('inv-modal-provider')?.value||'',total:calc.total,caseId,worker:window.currentWorker,emailed:false,savedAt:new Date().toISOString()});
    if(_invoiceModalRowIdx!==null&&_paymentRows[_invoiceModalRowIdx]){_paymentRows[_invoiceModalRowIdx].invoicedAmount=calc.total;renderPaymentRows();}
  }
};

// Backfill: sync all already-invoiced cases to Expenses & Distributions
window._manualSyncToPayouts = async function() {
  try {
    const btn = document.querySelector('[onclick="window._manualSyncToPayouts()"]');
    if(btn) { btn.textContent = 'Syncing...'; btn.disabled = true; }
    // First refresh _paymentRows from Firestore to get latest
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'payments'));
    const rows = snap.exists() ? (snap.data().rows || []) : [];
    const invoiced = rows.filter(r => r.invoiceSent && (r.invoicedAmount||0) > 0);
    console.log('Manual sync: found', invoiced.length, 'invoiced rows:', invoiced.map(r => r.caseId + ' $' + r.invoicedAmount));
    if(!invoiced.length) {
      alert('No invoiced rows found with an amount. Make sure the Invoice ✓ checkbox is checked AND the invoice amount is filled in.');
      if(btn) { btn.textContent = '↺ Sync to Expenses & Distributions'; btn.disabled = false; }
      return;
    }
    await _syncAllInvoicedToPayouts(rows);
    if(btn) { btn.textContent = '✓ Synced!'; btn.disabled = false; setTimeout(()=>{ btn.textContent='↺ Sync to Expenses & Distributions'; }, 2000); }
    alert('✓ Synced ' + invoiced.length + ' invoiced case(s) to Expenses & Distributions!\n\n' + invoiced.map(r => r.caseId + ': $' + r.invoicedAmount).join('\n'));
  } catch(e) {
    console.error('Manual sync error:', e);
    alert('Error: ' + e.message);
  }
};

// ── PERSONAL INCOME FORMULA ──────────────────────────────────────────────────
// Stored in Firestore: atlas/personal_income_formula
// Structure per worker: { centers: [ { id, name, type:'hourly'|'flat', rate } ] }

let _piFormula = { centers: [] }; // shared formula for both workers

async function _loadPIFormula() {
  try {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'personal_income_formula'));
    if(snap.exists()) {
      const d = snap.data();
      // Migrate old per-worker format if needed
      _piFormula = d.centers ? d : { centers: d.josh?.centers || [] };
    }
  } catch(e) {}
}

async function _savePIFormula() {
  await window.setDoc(window.doc(window.db, 'atlas', 'personal_income_formula'), _piFormula);
}

function _calcPersonalIncome(worker) {
  const formula = _piFormula; // shared formula
  const finalized = (window.cases || []).filter(c => !c.draft && c.worker === worker);
  let total = 0;
  finalized.forEach(c => {
    const preop = (window._rawPreopRecords || []).find(r => r['po-caseId'] === c.caseId);
    const centerId = preop?.['po-surgery-center'] || c.surgeryCenter || '';
    const rule = formula.centers.find(f => f.id === centerId);
    if(rule) {
      if(rule.type === 'flat') {
        total += parseFloat(rule.rate) || 0;
      } else if(rule.type === 'hourly') {
        const hrs = c.endTime && c.startTime
          ? (function() {
              const [sh,sm] = c.startTime.split(':').map(Number);
              const [eh,em] = c.endTime.split(':').map(Number);
              return Math.max(0, ((eh*60+em)-(sh*60+sm))/60);
            })()
          : (parseFloat(preop?.['po-est-hours']) || 0);
        total += hrs * (parseFloat(rule.rate) || 0);
      }
    }
  });
  return total;
}

function _calcProjectedPersonalIncome(worker) {
  // Projected = PI formula applied to not-yet-finalized cases (drafts + preop-only)
  const formula = _piFormula;
  const pending = (_paymentRows || []).filter(r => r.worker === worker && !(r.invoiceSent));
  let total = 0;
  pending.forEach(r => {
    const rule = formula.centers.find(f => f.id === r.surgeryCenter);
    if(rule) {
      if(rule.type === 'flat') {
        total += parseFloat(rule.rate) || 0;
      } else if(rule.type === 'hourly') {
        const hrs = parseFloat(r.estHrs) || 0;
        total += hrs * (parseFloat(rule.rate) || 0);
      }
    }
  });
  return total;
}

function _renderPICards() {
  const fmt = n => '$' + Number(n||0).toLocaleString('en-US', {minimumFractionDigits:0,maximumFractionDigits:0});
  const jInc  = _calcPersonalIncome('josh');
  const dInc  = _calcPersonalIncome('dev');
  const jProj = _calcProjectedPersonalIncome('josh');
  const dProj = _calcProjectedPersonalIncome('dev');
  const el = id => document.getElementById(id);
  if(el('pm-income-josh'))  el('pm-income-josh').textContent  = fmt(jInc);
  if(el('pm-income-dev'))   el('pm-income-dev').textContent   = fmt(dInc);
  if(el('pm-proj-josh'))    el('pm-proj-josh').textContent    = fmt(jProj);
  if(el('pm-proj-dev'))     el('pm-proj-dev').textContent     = fmt(dProj);
}

window.openPersonalIncomeModal = async function() {
  await _loadPIFormula();
  const centers = window.surgeryCenters || [];
  const modal = document.createElement('div');
  modal.id = 'pi-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';



  function buildRows() {
    return centers.map(c => {
      const rule = _piFormula.centers.find(f => f.id === c.id) || { id: c.id, type: 'none', rate: 0 };
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:9px 12px;font-size:13px;font-weight:500">${c.name}</td>
        <td style="padding:9px 12px">
          <select data-center="${c.id}" data-field="type"
            style="font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
            <option value="none" ${rule.type==='none'?'selected':''}>Not Used</option>
            <option value="hourly" ${rule.type==='hourly'?'selected':''}>Hourly Rate</option>
            <option value="flat" ${rule.type==='flat'?'selected':''}>Flat Rate / Day</option>
          </select>
        </td>
        <td style="padding:9px 12px">
          <div style="display:flex;align-items:center;gap:4px">
            <span style="font-size:13px;color:var(--text-muted)">$</span>
            <input type="number" min="0" step="1" value="${rule.rate||''}"
              data-center="${c.id}" data-field="rate"
              placeholder="0" style="width:80px;padding:4px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
            <span style="font-size:11px;color:var(--text-faint)" id="pi-unit-${c.id}">${rule.type==='hourly'?'/hr':rule.type==='flat'?'/day':''}</span>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:12px;width:100%;max-width:600px;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="background:#1d3557;padding:18px 24px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1">
        <div>
          <div style="font-size:16px;font-weight:600;color:#fff">⚙️ Personal Income Formula</div>
          <div style="font-size:12px;color:rgba(255,255,255,.65);margin-top:2px">Shared rates apply to both Josh and Dev</div>
        </div>
        <button id="pi-close" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px">✕ Close</button>
      </div>
      <div style="padding:20px 24px">
        ${centers.length ? `
        <table style="width:100%;border-collapse:collapse;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <thead><tr style="background:var(--surface2)">
            <th style="padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);text-align:left">Surgery Center</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);text-align:left">Billing Type</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);text-align:left">Rate</th>
          </tr></thead>
          <tbody id="pi-rows">${buildRows()}</tbody>
        </table>` : '<div style="font-size:13px;color:var(--text-faint);padding:12px 0">No surgery centers found. Add them in Surgery Centers tab first.</div>'}
        <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:16px;border-top:1px solid var(--border);margin-top:16px">
          <button id="pi-save" style="background:#1d3557;color:#fff;border:none;border-radius:6px;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer">✓ Save Formula</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  // Live unit label update
  modal.addEventListener('change', e => {
    const el = e.target;
    if(el.dataset.field === 'type') {
      const unitEl = document.getElementById(`pi-unit-${el.dataset.center}`);
      if(unitEl) unitEl.textContent = el.value==='hourly'?'/hr':el.value==='flat'?'/day':'';
    }
  });

  document.getElementById('pi-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });

  document.getElementById('pi-save').addEventListener('click', async () => {
    _piFormula = { centers: [] };
    modal.querySelectorAll('select[data-field="type"]').forEach(sel => {
      const centerId = sel.dataset.center;
      const type = sel.value;
      if(type === 'none') return;
      const rateEl = modal.querySelector(`input[data-center="${centerId}"][data-field="rate"]`);
      const rate = parseFloat(rateEl?.value) || 0;
      _piFormula.centers.push({ id: centerId, type, rate });
    });
    await _savePIFormula();
    // Sync to both global stores
    window._atlasFormulaData = _piFormula;
    window._piFormula_get = () => _piFormula;
    if(typeof _renderPICards === 'function') _renderPICards();
    if(typeof renderPayoutTab === 'function') renderPayoutTab();
    modal.remove();
    alert('✓ Personal income formula saved!');
  });
};

// Expose _calcPersonalIncome globally for E&D tab
window._calcPersonalIncome = _calcPersonalIncome;
window._piFormula_get = () => _piFormula;

async function _backfillInvoicesToPayouts() {
  await _syncAllInvoicedToPayouts(_paymentRows);
}

// Auto-sync invoiced payment → Income entry in Expenses & Distributions
async function _syncAllInvoicedToPayouts(paymentRows) {
  try {
    const invoiced = paymentRows.filter(r => r.invoiceSent && (r.invoicedAmount||0) > 0);
    if(!invoiced.length) return;
    const snap = await window.getDoc(window.doc(window.db, 'atlas', 'payouts'));
    const data = snap.exists() ? snap.data() : { entries: [], distributions: [] };
    if(!data.entries) data.entries = [];
    // Upsert each invoiced row as a case-income entry
    invoiced.forEach(row => {
      const existingIdx = data.entries.findIndex(e => e.cat === 'case-income' && e.caseId === row.caseId);
      const entry = {
        id:        existingIdx !== -1 ? data.entries[existingIdx].id : (window.uid ? window.uid() : Date.now().toString(36) + Math.random().toString(36).slice(2,5)),
        worker:    row.worker || 'josh',
        cat:       'case-income',
        name:      row.caseId || 'Unknown Case',
        amount:    parseFloat(row.invoicedAmount) || 0,
        date:      row.caseDate || null,
        notes:     (row.surgeryCenterName||row.surgeryCenter) ? 'Center: ' + (row.surgeryCenterName||row.surgeryCenter) : '',
        caseId:    row.caseId,
        createdAt: existingIdx !== -1 ? data.entries[existingIdx].createdAt : new Date().toISOString()
      };
      if(existingIdx !== -1) data.entries[existingIdx] = entry;
      else data.entries.push(entry);
    });
    // Remove case-income entries for rows that are no longer invoiced
    const invoicedIds = new Set(invoiced.map(r => r.caseId));
    data.entries = data.entries.filter(e => e.cat !== 'case-income' || invoicedIds.has(e.caseId));
    await window.setDoc(window.doc(window.db, 'atlas', 'payouts'), data);
    console.log('Synced', invoiced.length, 'invoice income entries to Expenses & Distributions');
  } catch(e) {
    console.warn('Could not sync invoices to payouts:', e);
  }
}

window.sendInvoiceEmail = async function() {
  const email=document.getElementById('inv-modal-email')?.value?.trim();
  const caseId=document.getElementById('inv-modal-case')?.value;
  const scSel=document.getElementById('inv-modal-sc-select');
  const center=(window.surgeryCenters||[]).find(c=>c.id===scSel?.value);
  const locInput=document.getElementById('inv-modal-location');
  const location=(scSel?.value==='__custom__'||!center)?(locInput?.value||''):(center?.name||'');
  const date=document.getElementById('inv-modal-date')?.value||'';
  const billingType=document.getElementById('inv-modal-billing-type')?.value||'hourly';
  if(!email){alert('Please enter a recipient email.');return;}
  if(!caseId){alert('Please select an associated case.');return;}
  if(!location||!date){alert('Please fill in surgery center and date.');return;}
  let total=0;
  if(billingType==='flat'){
    total=parseFloat(document.getElementById('inv-modal-flat-amt')?.value)||0;
    if(total<=0){alert('Please enter a flat rate amount.');return;}
    const proc=document.getElementById('inv-modal-flat-proc-select')?.value==='__custom__'
      ?(document.getElementById('inv-modal-flat-proc')?.value||'Anesthesia Services')
      :(document.getElementById('inv-modal-flat-proc-select')?.options[document.getElementById('inv-modal-flat-proc-select')?.selectedIndex]?.text.split(' — ')[0]||'Anesthesia Services');
    window._invModalCalc={total,billedStr:'Flat Rate',flat:true,proc};
  } else {
    const calc=calcInvModal();
    if(!calc){alert('Please fill in times and rates.');return;}
    total=calc.total;
  }
  const btn=document.getElementById('inv-modal-send-btn');
  btn.textContent='Sending...';btn.disabled=true;
  previewInvoiceModal();
  const invoiceHTML=buildInvoiceModalHTML();
  const invoiceNum=window._currentInvoiceNum||'ATL-INV';
  const provider=document.getElementById('inv-modal-provider')?.value||'';
  try {
    const res=await fetch('https://atlas-reminder.blue-disk-9b10.workers.dev/invoice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:email,location,date,provider,total,invoiceNum,worker:window.currentWorker||'josh',html:invoiceHTML})});
    const data=await res.json().catch(()=>({}));
    if(res.ok&&data.success){
      // Send confirmation to the logged-in provider
      const providerEmail = window.currentWorker==='dev' ? 'murthy.devarsh@gmail.com' : 'jxcondado@gmail.com';
      const providerName  = window.currentWorker==='dev' ? 'Dev' : 'Josh';
      const sentAt = new Date().toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'});
      const confirmHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <tr><td style="background:#1d3557;padding:24px 32px;">
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:6px;">Atlas Anesthesia &middot; Invoice Confirmation</div>
    <div style="font-size:22px;font-weight:700;color:#fff;">Invoice Sent Successfully</div>
    <div style="font-size:14px;color:#a8c4e0;margin-top:4px;">${sentAt}</div>
  </td></tr>
  <tr><td style="padding:24px 32px;">
    <p style="font-size:15px;color:#1e293b;margin:0 0 20px">Hi ${providerName}, your invoice was sent successfully.</p>
    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <tr style="background:#f8fafc"><td style="padding:10px 16px;font-size:12px;font-weight:700;text-transform:uppercase;color:#64748b;width:140px">Invoice #</td><td style="padding:10px 16px;font-size:14px;color:#1e293b;font-family:monospace">${invoiceNum||'—'}</td></tr>
      <tr style="border-top:1px solid #e2e8f0"><td style="padding:10px 16px;font-size:12px;font-weight:700;text-transform:uppercase;color:#64748b">Sent To</td><td style="padding:10px 16px;font-size:14px;color:#1e293b;font-family:monospace">${email}</td></tr>
      <tr style="border-top:1px solid #e2e8f0"><td style="padding:10px 16px;font-size:12px;font-weight:700;text-transform:uppercase;color:#64748b">Case</td><td style="padding:10px 16px;font-size:14px;color:#1e293b;font-family:monospace">${caseId||'—'}</td></tr>
      <tr style="border-top:1px solid #e2e8f0"><td style="padding:10px 16px;font-size:12px;font-weight:700;text-transform:uppercase;color:#64748b">Status</td><td style="padding:10px 16px"><span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;background:#dcfce7;color:#166534">SENT</span></td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
    <div style="font-size:12px;color:#94a3b8;text-align:center;">Atlas Anesthesia &middot; Invoice sent via Resend</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
      fetch('https://atlas-reminder.blue-disk-9b10.workers.dev/invoice',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({to:providerEmail, invoiceNum:'Confirmation — '+invoiceNum, html:confirmHtml})
      }).catch(()=>{});
      alert('Invoice sent to '+email+'!');
    }
    else{window.open('mailto:'+email+'?subject='+encodeURIComponent('Atlas Anesthesia Invoice '+invoiceNum));alert('Email client opened.');}
    await savePDFRecord({id:window.uid(),invoiceNum,location,date,provider,total,caseId,worker:window.currentWorker,emailed:true,savedAt:new Date().toISOString()});
    if(_invoiceModalRowIdx!==null&&_paymentRows[_invoiceModalRowIdx]){
      _paymentRows[_invoiceModalRowIdx].invoiceSent=true;
      _paymentRows[_invoiceModalRowIdx].invoicedAmount=total;
      // Auto-sync to Expenses & Distributions
      _syncInvoiceToPayouts(_paymentRows[_invoiceModalRowIdx], total).catch(()=>{});
    }
    renderPaymentRows();
    closeInvoiceModal();
  } catch(e){
    window.open('mailto:'+email+'?subject='+encodeURIComponent('Atlas Anesthesia Invoice'));
    await savePDFRecord({id:window.uid(),invoiceNum,location,date,provider,total,caseId,worker:window.currentWorker,emailed:false,savedAt:new Date().toISOString()}).catch(()=>{});
  } finally {
    btn.textContent='Send Invoice Email';btn.disabled=false;
  }
};

// -- showTab hook — triggers load when tab is opened -------------------------
// Use a safe wrapper that defers _orig lookup until call time
(function() {
  const _origRef = { fn: null };
  const _wrapShowTab = function(tab, pushState) {
    if(pushState === undefined) pushState = true;
    // Look up the real showTab at call time (not at parse time)
    if(!_origRef.fn) {
      // Find the original — walk the chain to find one that isn't ours
      _origRef.fn = window._appShowTab || null;
    }
    if(_origRef.fn) _origRef.fn(tab, pushState);
    if(tab === 'payments')   window.loadPaymentRows();
    if(tab === 'saved-pdfs') window.loadSavedPDFs();
  };
  // Wait until app.js has set showTab, then wrap it
  const _install = function() {
    if(window.showTab && window.showTab !== _wrapShowTab) {
      window._appShowTab = window.showTab;
      window.showTab = _wrapShowTab;
    } else if(!window.showTab) {
      setTimeout(_install, 50);
    }
  };
  setTimeout(_install, 0);
})();
