// outreach.js — Cold-outreach CRM for surgery centers.
//
// Data layout in Firestore:
//   atlas/outreach                       — { entries: [Lead, ...] }
//   atlas/outreach_materials_index       — { items: [{id,name,description,filename,sizeBytes,contentType,addedAt}, ...] }
//   atlas/outreach_materials_<id>        — { name, description, filename, contentType, sizeBytes, base64, addedAt }
//
// Lead shape:
//   { id, centerName, contactName, contactEmail, phone, address, status,
//     notes, lastContactAt, lastContactType, nextFollowupAt, worker,
//     history: [{at, by, type, summary}], createdAt }
//
// Status values:
//   'not-contacted' | 'contacted' | 'awaiting-response' | 'responded' |
//   'meeting-scheduled' | 'converted' | 'not-interested'
//
// Depends on: app.js (db, getDoc, setDoc, doc, uid, currentWorker, logAudit,
// setSyncing, FAX_WORKER_URL is duplicated locally here as OUTREACH_WORKER_URL).

(() => {
  const WORKER_BASE = 'https://atlas-reminder.blue-disk-9b10.workers.dev';
  const OUTREACH_DOC = 'outreach';
  const MATERIALS_INDEX_DOC = 'outreach_materials_index';
  const MATERIALS_PREFIX = 'outreach_materials_';
  const FIRESTORE_LIMIT = 1048576; // 1MB per doc
  const MAX_MATERIAL_BYTES = 700 * 1024; // leave headroom for metadata + base64 overhead

  // ── Local state ──────────────────────────────────────────────────────────────
  let _leads = [];
  let _materialsIndex = []; // [{id,name,description,filename,sizeBytes,contentType}]
  let _filter = 'all';
  let _loaded = false;

  // ── Status metadata ──────────────────────────────────────────────────────────
  const STATUSES = [
    { id: 'not-contacted',     label: 'Not contacted',     bg: '#f1f5f9', fg: '#475569' },
    { id: 'contacted',         label: 'Contacted',         bg: '#dbeafe', fg: '#1e40af' },
    { id: 'awaiting-response', label: 'Awaiting response', bg: '#fef3c7', fg: '#92400e' },
    { id: 'responded',         label: 'Responded',         bg: '#e0e7ff', fg: '#3730a3' },
    { id: 'meeting-scheduled', label: 'Meeting scheduled', bg: '#cffafe', fg: '#155e75' },
    { id: 'converted',         label: 'Converted',         bg: '#dcfce7', fg: '#166534' },
    { id: 'not-interested',    label: 'Not interested',    bg: '#fee2e2', fg: '#991b1b' }
  ];
  const statusMeta = (s) => STATUSES.find(x => x.id === s) || STATUSES[0];

  // ── Email templates ──────────────────────────────────────────────────────────
  const TEMPLATES = [
    {
      id: 'cold',
      label: 'Cold outreach',
      subject: 'Atlas Anesthesia — Mobile Dental Anesthesia Services',
      body:
`Hi {{contactName}},

I'm reaching out from Atlas Anesthesia, a CRNA-led mobile dental anesthesia practice serving Wisconsin. We provide same-day in-office anesthesia for pediatric and adult dental procedures, so your patients never have to travel to a hospital or surgery center.

A few quick reasons {{centerName}} might find this useful:

  • Full anesthesia coverage at your office — sedation through general anesthesia
  • Board-certified CRNAs on site, equipment and monitoring included
  • Streamlined consent, NPO, and recovery handoffs
  • Patient billing handled directly when you prefer

I've attached a quick overview of our services. If you'd like to talk through a fit for your center, I'm happy to drop in or hop on a call whenever works for you.

Thanks for your time,
{{providerName}}
Atlas Anesthesia`
    },
    {
      id: 'thanks-call',
      label: 'Thanks — after call',
      subject: 'Great connecting today, {{contactName}} — Atlas Anesthesia info',
      body:
`Hi {{contactName}},

Thanks so much for taking the time to chat today. Following up with the Atlas Anesthesia info I mentioned — attached. Let me know if any questions come up or if you'd like to schedule a deeper conversation with your team.

Looking forward to working together.

— {{providerName}}
Atlas Anesthesia`
    },
    {
      id: 'follow-up',
      label: 'Follow-up bump',
      subject: 'Quick follow-up — Atlas Anesthesia',
      body:
`Hi {{contactName}},

Just bumping this back to the top of your inbox in case it got buried. Happy to answer any questions about how Atlas Anesthesia could fit into {{centerName}}'s workflow whenever you have a few minutes.

Thanks,
{{providerName}}
Atlas Anesthesia`
    }
  ];

  function _fillTemplate(text, lead, providerName) {
    return String(text)
      .replace(/\{\{contactName\}\}/g, (lead.contactName||'there').split(' ')[0] || 'there')
      .replace(/\{\{centerName\}\}/g,  lead.centerName || 'your center')
      .replace(/\{\{providerName\}\}/g, providerName || 'Atlas Anesthesia');
  }

  function _htmlBodyFromText(text) {
    const escape = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return escape(text).split('\n').map(line => line.trim() ? `<p style="margin:0 0 12px;line-height:1.55;color:#1e293b">${line}</p>` : '<br>').join('');
  }

  // ── Firestore helpers ────────────────────────────────────────────────────────
  async function _loadLeads() {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', OUTREACH_DOC));
      _leads = snap.exists() ? (snap.data().entries || []) : [];
    } catch(e) { _leads = []; }
  }
  async function _saveLeads() {
    window.setSyncing && window.setSyncing(true);
    try {
      await window.setDoc(window.doc(window.db, 'atlas', OUTREACH_DOC), { entries: _leads });
    } finally { window.setSyncing && window.setSyncing(false); }
  }
  async function _loadMaterialsIndex() {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', MATERIALS_INDEX_DOC));
      _materialsIndex = snap.exists() ? (snap.data().items || []) : [];
    } catch(e) { _materialsIndex = []; }
  }
  async function _saveMaterialsIndex() {
    await window.setDoc(window.doc(window.db, 'atlas', MATERIALS_INDEX_DOC), { items: _materialsIndex });
  }
  async function _loadMaterial(id) {
    const snap = await window.getDoc(window.doc(window.db, 'atlas', MATERIALS_PREFIX + id));
    return snap.exists() ? snap.data() : null;
  }
  async function _saveMaterial(id, payload) {
    await window.setDoc(window.doc(window.db, 'atlas', MATERIALS_PREFIX + id), payload);
  }

  // ── Public load entry ────────────────────────────────────────────────────────
  window.loadOutreach = async function() {
    if(!window.db) { setTimeout(window.loadOutreach, 500); return; }
    await Promise.all([_loadLeads(), _loadMaterialsIndex()]);
    _loaded = true;
    renderOutreach();
  };

  // ── Render leads list ────────────────────────────────────────────────────────
  function _daysAgo(iso) {
    if(!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }
  function _isOverdue(lead) {
    if(!lead.nextFollowupAt) return false;
    const today = new Date().toISOString().split('T')[0];
    return lead.nextFollowupAt < today;
  }

  function _renderFilterBar() {
    const bar = document.getElementById('outreach-filter-bar');
    if(!bar) return;
    const counts = { all: _leads.length };
    STATUSES.forEach(s => { counts[s.id] = _leads.filter(l => l.status === s.id).length; });
    const overdueCount = _leads.filter(_isOverdue).length;
    const chips = [{ id:'all', label:'All', n: counts.all }, { id:'overdue', label:'⏰ Overdue follow-up', n: overdueCount }]
      .concat(STATUSES.map(s => ({ id: s.id, label: s.label, n: counts[s.id]||0 })));
    bar.innerHTML = chips.map(c => `<button onclick="_outreachSetFilter('${c.id}')" class="${_filter===c.id?'active':''}" style="background:${_filter===c.id?'#1d3557':'#fff'};color:${_filter===c.id?'#fff':'var(--text-muted)'};border:1px solid var(--border);padding:5px 11px;border-radius:14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap">${c.label} <span style="opacity:.7;margin-left:3px">${c.n}</span></button>`).join('');
  }

  window._outreachSetFilter = function(f) { _filter = f; renderOutreach(); };

  function _filteredLeads() {
    let arr = _leads.slice();
    if(_filter === 'overdue') arr = arr.filter(_isOverdue);
    else if(_filter !== 'all') arr = arr.filter(l => l.status === _filter);
    arr.sort((a, b) => {
      const aOver = _isOverdue(a), bOver = _isOverdue(b);
      if(aOver !== bOver) return aOver ? -1 : 1;
      const aNext = a.nextFollowupAt || '9999-12-31';
      const bNext = b.nextFollowupAt || '9999-12-31';
      return aNext.localeCompare(bNext);
    });
    return arr;
  }

  function renderOutreach() {
    const body = document.getElementById('outreach-list-body');
    if(!body) return;
    _renderFilterBar();
    const rows = _filteredLeads();
    if(!rows.length) {
      body.innerHTML = '<div class="empty-state" style="margin:0;padding:30px 20px"><span class="empty-state-icon">📞</span><div class="empty-state-title">No leads match this filter</div><div class="empty-state-sub">Try "All" or add a new lead.</div></div>';
      return;
    }
    const COLS = '1fr 1fr 130px 110px 120px 220px';
    let html = `<div style="display:grid;grid-template-columns:${COLS};gap:10px;padding:12px 16px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-faint)">
      <span>Center</span><span>Contact</span><span>Status</span><span>Last Contact</span><span>Next Follow-Up</span><span style="text-align:right">Actions</span>
    </div>`;
    rows.forEach(l => {
      const meta = statusMeta(l.status);
      const lastDays = _daysAgo(l.lastContactAt);
      const lastTxt = l.lastContactAt ? (lastDays === 0 ? 'today' : (lastDays === 1 ? 'yesterday' : lastDays + 'd ago')) : '—';
      const nextTxt = l.nextFollowupAt ? new Date(l.nextFollowupAt + 'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—';
      const overdue = _isOverdue(l);
      html += `<div style="display:grid;grid-template-columns:${COLS};gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);align-items:center;background:${overdue?'rgba(239,68,68,0.04)':''}">
        <div><div style="font-size:14px;font-weight:600;color:var(--text)">${_esc(l.centerName||'—')}</div>${l.address?`<div style="font-size:11px;color:var(--text-faint);margin-top:2px">📍 ${_esc(l.address)}</div>`:''}</div>
        <div><div style="font-size:13px;color:var(--text)">${_esc(l.contactName||'—')}</div>${l.contactEmail?`<div style="font-size:11px;color:var(--text-faint);font-family:monospace">${_esc(l.contactEmail)}</div>`:''}</div>
        <div><span style="display:inline-block;padding:3px 9px;border-radius:11px;background:${meta.bg};color:${meta.fg};font-size:11px;font-weight:700">${meta.label}</span></div>
        <div style="font-size:12px;color:var(--text-muted)">${lastTxt}</div>
        <div style="font-size:12px;color:${overdue?'#dc2626':'var(--text-muted)'};font-weight:${overdue?'600':'400'}">${overdue?'⏰ ':''}${nextTxt}</div>
        <div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
          <button onclick="openOutreachSendEmail('${l.id}')" class="btn btn-primary btn-sm" style="font-size:11px;padding:5px 10px">📧 Email</button>
          <button onclick="openOutreachLeadForm('${l.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;padding:5px 10px">✏</button>
          <button onclick="_outreachMarkResponded('${l.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;padding:5px 10px;color:#166534;border-color:#86efac" title="Mark responded">✓</button>
          <button onclick="_outreachDelete('${l.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;padding:5px 10px;color:var(--warn)">🗑</button>
        </div>
      </div>`;
    });
    body.innerHTML = html;
  }
  window.renderOutreach = renderOutreach;

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _escAttr(s) { return String(s||'').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }

  // ── Add / Edit Lead modal ────────────────────────────────────────────────────
  window.openOutreachLeadForm = function(id) {
    const lead = id ? _leads.find(l => l.id === id) : null;
    const v = (k, fallback) => _escAttr(lead?.[k] ?? fallback ?? '');
    const sel = (k) => (lead?.status === k) ? ' selected' : '';
    const wrap = document.createElement('div');
    wrap.id = 'outreachLeadModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };
    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:680px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">Outreach</div><div style="font-size:16px;font-weight:600">${lead?'Edit Lead':'Add New Lead'}</div></div><button onclick="document.getElementById('outreachLeadModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button></div>
      <div style="padding:20px 22px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">Surgery Center / Practice <span style="color:var(--warn)">*</span></label><input type="text" id="ol-center" value="${v('centerName')}" placeholder="e.g. Fox Valley Pediatric Dentistry"></div>
          <div><label style="margin-top:0">Status</label><select id="ol-status">${STATUSES.map(s => `<option value="${s.id}"${sel(s.id)}>${s.label}</option>`).join('')}</select></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">Contact name</label><input type="text" id="ol-contact" value="${v('contactName')}" placeholder="First Last"></div>
          <div><label style="margin-top:0">Contact email</label><input type="email" id="ol-email" value="${v('contactEmail')}" placeholder="contact@center.com"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div><label style="margin-top:0">Phone</label><input type="tel" id="ol-phone" value="${v('phone')}" placeholder="(555) 555-5555"></div>
          <div><label style="margin-top:0">Address</label><input type="text" id="ol-address" value="${v('address')}" placeholder="City, ST"></div>
        </div>
        <div style="margin-bottom:14px"><label style="margin-top:0">Next follow-up date</label><input type="date" id="ol-next" value="${v('nextFollowupAt')}"></div>
        <div style="margin-bottom:14px"><label style="margin-top:0">Notes</label><textarea id="ol-notes" placeholder="Open-text journal — who you talked to, what they care about, etc." style="width:100%;min-height:100px;padding:10px 12px;font-family:inherit;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);outline:none;resize:vertical">${_esc(lead?.notes||'')}</textarea></div>
        ${lead && lead.history && lead.history.length ? `<div style="margin-bottom:14px"><label style="margin-top:0">History</label><div style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px 12px;background:#fafafa">${lead.history.slice().reverse().map(h => `<div style="font-size:12px;color:var(--text-muted);padding:4px 0;border-bottom:1px dashed #eee"><strong>${new Date(h.at).toLocaleDateString('en-US')}</strong> — ${_esc(h.type||'')}${h.by?' · '+_esc(h.by):''}: ${_esc(h.summary||'')}</div>`).join('')}</div></div>` : ''}
        <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--border)">
          ${lead?`<button onclick="_outreachDelete('${lead.id}',true)" class="btn btn-ghost" style="color:var(--warn);margin-right:auto">🗑 Delete</button>`:''}
          <button class="btn btn-ghost" onclick="document.getElementById('outreachLeadModal').remove()">Cancel</button>
          <button class="btn btn-primary" onclick="_outreachSaveLead('${lead?lead.id:''}')" style="background:#1d3557;border-color:#1d3557">✓ Save</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    setTimeout(() => document.getElementById('ol-center')?.focus(), 60);
  };

  window._outreachSaveLead = async function(existingId) {
    const $ = id => document.getElementById(id);
    const centerName = $('ol-center')?.value.trim();
    if(!centerName) { alert('Please enter a Surgery Center / Practice name.'); return; }
    const status = $('ol-status')?.value || 'not-contacted';
    const lead = existingId ? _leads.find(l => l.id === existingId) : null;
    const data = {
      id: lead?.id || (window.uid ? window.uid() : Math.random().toString(36).slice(2,11)),
      centerName,
      contactName:  $('ol-contact')?.value.trim() || '',
      contactEmail: $('ol-email')?.value.trim() || '',
      phone:        $('ol-phone')?.value.trim() || '',
      address:      $('ol-address')?.value.trim() || '',
      nextFollowupAt: $('ol-next')?.value || '',
      notes:        $('ol-notes')?.value || '',
      status,
      worker:       lead?.worker || window.currentWorker || 'dev',
      createdAt:    lead?.createdAt || new Date().toISOString(),
      lastContactAt: lead?.lastContactAt || null,
      lastContactType: lead?.lastContactType || null,
      history:      lead?.history || []
    };
    if(lead) {
      const idx = _leads.findIndex(l => l.id === lead.id);
      if(idx !== -1) _leads[idx] = data;
    } else {
      _leads.unshift(data);
    }
    await _saveLeads();
    try { window.logAudit && window.logAudit(lead?'outreach-edit':'outreach-add', data.id, centerName); } catch(e){}
    document.getElementById('outreachLeadModal')?.remove();
    renderOutreach();
  };

  window._outreachDelete = async function(id, fromModal) {
    const lead = _leads.find(l => l.id === id);
    if(!lead) return;
    if(!confirm(`Delete lead "${lead.centerName}"?`)) return;
    _leads = _leads.filter(l => l.id !== id);
    await _saveLeads();
    try { window.logAudit && window.logAudit('outreach-delete', id, lead.centerName); } catch(e){}
    if(fromModal) document.getElementById('outreachLeadModal')?.remove();
    renderOutreach();
  };

  window._outreachMarkResponded = async function(id) {
    const lead = _leads.find(l => l.id === id);
    if(!lead) return;
    const summary = prompt('Quick note about the response (optional):', '');
    lead.status = 'responded';
    lead.lastContactAt = new Date().toISOString();
    lead.lastContactType = 'response';
    lead.history = lead.history || [];
    lead.history.push({ at: new Date().toISOString(), by: window.currentWorker || 'unknown', type: 'response', summary: summary || '' });
    await _saveLeads();
    try { window.logAudit && window.logAudit('outreach-responded', id, lead.centerName); } catch(e){}
    renderOutreach();
  };

  // ── Materials Modal ──────────────────────────────────────────────────────────
  window.openOutreachMaterialsModal = async function() {
    await _loadMaterialsIndex();
    const wrap = document.createElement('div');
    wrap.id = 'outreachMatModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };
    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:720px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">Outreach</div><div style="font-size:16px;font-weight:600">📎 Marketing Materials</div></div><button onclick="document.getElementById('outreachMatModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button></div>
      <div style="padding:20px 22px">
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e40af;line-height:1.5">Upload PDFs (or images) you want available to attach to outreach emails. Max ~700 KB per file. Files are stored in Firestore.</div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;padding:14px;border:2px dashed var(--border);border-radius:8px;background:#fafafa">
          <input type="file" id="om-file" accept=".pdf,.png,.jpg,.jpeg" style="flex:1">
          <input type="text" id="om-name" placeholder="Short display name (e.g. Atlas Overview)" style="flex:1.5;padding:8px 11px;font-family:inherit;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm)">
          <button onclick="_outreachUploadMaterial()" class="btn btn-primary btn-sm" id="om-upload-btn">⬆ Upload</button>
        </div>
        <div id="om-list"></div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    _renderMaterialsList();
  };

  function _renderMaterialsList() {
    const el = document.getElementById('om-list');
    if(!el) return;
    if(!_materialsIndex.length) {
      el.innerHTML = '<div class="empty-state" style="margin:0;padding:24px 16px"><span class="empty-state-icon">📄</span><div class="empty-state-title">No materials yet</div><div class="empty-state-sub">Upload your first PDF above.</div></div>';
      return;
    }
    el.innerHTML = _materialsIndex.map(m => `<div style="display:grid;grid-template-columns:1fr 110px 90px;gap:12px;padding:11px 14px;border-bottom:1px solid var(--border);align-items:center">
      <div><div style="font-size:13px;font-weight:600">${_esc(m.name||m.filename)}</div><div style="font-size:11px;color:var(--text-faint);font-family:monospace">${_esc(m.filename||'')}</div></div>
      <div style="font-size:12px;color:var(--text-muted);font-family:monospace">${_fmtBytes(m.sizeBytes||0)}</div>
      <div style="text-align:right"><button onclick="_outreachDeleteMaterial('${m.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn)">🗑</button></div>
    </div>`).join('');
  }

  function _fmtBytes(n) {
    if(n < 1024) return n + ' B';
    if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/1024/1024).toFixed(2) + ' MB';
  }

  window._outreachUploadMaterial = async function() {
    const fileEl = document.getElementById('om-file');
    const nameEl = document.getElementById('om-name');
    const btn = document.getElementById('om-upload-btn');
    const file = fileEl?.files?.[0];
    const name = (nameEl?.value || '').trim() || (file?.name || '');
    if(!file) { alert('Pick a file first.'); return; }
    if(file.size > MAX_MATERIAL_BYTES) {
      alert(`File is too big (${_fmtBytes(file.size)}). Max ~700 KB so it fits in Firestore. Try a smaller PDF.`);
      return;
    }
    btn.disabled = true; btn.textContent = 'Uploading...';
    try {
      const base64 = await _fileToBase64(file);
      const id = window.uid ? window.uid() : Math.random().toString(36).slice(2,11);
      await _saveMaterial(id, {
        name, description: '', filename: file.name, contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size, base64, addedAt: new Date().toISOString()
      });
      _materialsIndex.unshift({ id, name, filename: file.name, sizeBytes: file.size, contentType: file.type || 'application/octet-stream' });
      await _saveMaterialsIndex();
      try { window.logAudit && window.logAudit('outreach-material-add', id, name); } catch(e){}
      if(fileEl) fileEl.value = '';
      if(nameEl) nameEl.value = '';
      _renderMaterialsList();
    } catch(e) {
      alert('Upload failed: ' + (e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = '⬆ Upload';
    }
  };

  function _fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || '';
        const idx = result.indexOf('base64,');
        resolve(idx >= 0 ? result.slice(idx + 7) : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  window._outreachDeleteMaterial = async function(id) {
    const m = _materialsIndex.find(x => x.id === id);
    if(!m) return;
    if(!confirm(`Delete "${m.name}"? This removes it from future emails.`)) return;
    _materialsIndex = _materialsIndex.filter(x => x.id !== id);
    await _saveMaterialsIndex();
    // Best-effort delete the body doc too
    try { await window.setDoc(window.doc(window.db, 'atlas', MATERIALS_PREFIX + id), {}); } catch(e){}
    try { window.logAudit && window.logAudit('outreach-material-delete', id, m.name); } catch(e){}
    _renderMaterialsList();
  };

  // ── Send Email modal ─────────────────────────────────────────────────────────
  window.openOutreachSendEmail = async function(leadId) {
    const lead = _leads.find(l => l.id === leadId);
    if(!lead) return;
    if(!lead.contactEmail) { alert('No contact email on file for this lead. Edit the lead and add one first.'); return; }
    await _loadMaterialsIndex();
    const providerName = (lead.worker === 'dev' || window.currentWorker === 'dev') ? 'Devarsh Murthy, CRNA' : 'Joshua Condado, CRNA';
    const wrap = document.createElement('div');
    wrap.id = 'outreachSendModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (e) => { if(e.target === wrap) wrap.remove(); };
    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:760px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:18px 22px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:3px">Send Outreach</div><div style="font-size:16px;font-weight:600">${_esc(lead.centerName)} · ${_esc(lead.contactEmail)}</div></div><button onclick="document.getElementById('outreachSendModal').remove()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">✕</button></div>
      <div style="padding:20px 22px">
        <div style="margin-bottom:14px"><label style="margin-top:0">Template</label><select id="os-tpl" onchange="_outreachApplyTemplate()">${TEMPLATES.map(t => `<option value="${t.id}">${t.label}</option>`).join('')}</select></div>
        <div style="margin-bottom:14px"><label style="margin-top:0">Subject</label><input type="text" id="os-subject"></div>
        <div style="margin-bottom:14px"><label style="margin-top:0">Message</label><textarea id="os-body" style="width:100%;min-height:240px;padding:12px;font-family:inherit;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;color:var(--text);outline:none;resize:vertical;line-height:1.55"></textarea><div style="font-size:11px;color:var(--text-faint);margin-top:4px">Placeholders auto-replace on send: <code>{{contactName}}</code> · <code>{{centerName}}</code> · <code>{{providerName}}</code></div></div>
        <div style="margin-bottom:14px"><label style="margin-top:0">Attach materials</label><div id="os-materials" style="border:1px solid var(--border);border-radius:6px;padding:10px;background:#fafafa;max-height:170px;overflow-y:auto">${_materialsIndex.length ? _materialsIndex.map(m => `<label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;cursor:pointer"><input type="checkbox" class="os-mat" data-id="${m.id}" data-filename="${_escAttr(m.filename||'')}" data-name="${_escAttr(m.name||'')}" data-type="${_escAttr(m.contentType||'application/octet-stream')}"> <span>${_esc(m.name||m.filename)} <span style="color:var(--text-faint);font-size:11px">· ${_fmtBytes(m.sizeBytes||0)}</span></span></label>`).join('') : '<div style="font-size:12px;color:var(--text-faint);font-style:italic;padding:6px">No materials uploaded yet. Click 📎 Marketing Materials at the top of the Outreach tab to add some.</div>'}</div></div>
        <div id="os-status" style="font-size:13px;padding:6px 0;min-height:20px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--border)">
          <button class="btn btn-ghost" onclick="document.getElementById('outreachSendModal').remove()">Cancel</button>
          <button id="os-send-btn" class="btn btn-primary" onclick="_outreachSend('${lead.id}','${_escAttr(providerName)}')" style="background:#1d3557;border-color:#1d3557">📧 Send Email</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    window._outreachActiveLead = lead;
    window._outreachActiveProvider = providerName;
    _outreachApplyTemplate();
  };

  window._outreachApplyTemplate = function() {
    const tplId = document.getElementById('os-tpl')?.value;
    const tpl = TEMPLATES.find(t => t.id === tplId) || TEMPLATES[0];
    const lead = window._outreachActiveLead;
    const provider = window._outreachActiveProvider || 'Atlas Anesthesia';
    if(!lead) return;
    const subjEl = document.getElementById('os-subject');
    const bodyEl = document.getElementById('os-body');
    if(subjEl) subjEl.value = _fillTemplate(tpl.subject, lead, provider);
    if(bodyEl) bodyEl.value = _fillTemplate(tpl.body, lead, provider);
  };

  window._outreachSend = async function(leadId, providerName) {
    const lead = _leads.find(l => l.id === leadId);
    if(!lead) return;
    const subjEl = document.getElementById('os-subject');
    const bodyEl = document.getElementById('os-body');
    const statusEl = document.getElementById('os-status');
    const btn = document.getElementById('os-send-btn');
    const subject = (subjEl?.value || '').trim();
    const body = (bodyEl?.value || '').trim();
    if(!subject || !body) { alert('Subject and message are required.'); return; }

    // Resolve materials
    const checks = Array.from(document.querySelectorAll('.os-mat:checked'));
    btn.disabled = true; btn.textContent = 'Sending...';
    if(statusEl) statusEl.textContent = checks.length ? 'Loading attachments...' : 'Sending...';
    try {
      const attachments = [];
      for(const cb of checks) {
        const id = cb.getAttribute('data-id');
        const mat = await _loadMaterial(id);
        if(!mat || !mat.base64) continue;
        attachments.push({
          filename: mat.filename || (mat.name + '.pdf'),
          contentType: mat.contentType || 'application/pdf',
          base64: mat.base64
        });
      }
      if(statusEl) statusEl.textContent = 'Sending...';
      // Build full HTML body
      const filled = {
        subject: _fillTemplate(subject, lead, providerName),
        body: _fillTemplate(body, lead, providerName)
      };
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px"><tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
          <tr><td style="background:#1d3557;padding:20px 28px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#90b8e0;margin-bottom:4px">Atlas Anesthesia</div><div style="font-size:18px;font-weight:700;color:#fff">${_esc(filled.subject)}</div></td></tr>
          <tr><td style="padding:24px 28px;font-size:14px;color:#1e293b;line-height:1.55">${_htmlBodyFromText(filled.body)}</td></tr>
        </table></td></tr></table></body></html>`;

      const res = await fetch(WORKER_BASE + '/outreach-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: lead.contactEmail, subject: filled.subject, html, attachments })
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok || !data.success) throw new Error(data.error || 'Send failed');

      // Update lead state
      const now = new Date().toISOString();
      lead.lastContactAt = now;
      lead.lastContactType = 'email';
      const tplId = document.getElementById('os-tpl')?.value || 'cold';
      if(lead.status === 'not-contacted') lead.status = 'contacted';
      else if(lead.status === 'contacted') lead.status = 'awaiting-response';
      lead.history = lead.history || [];
      lead.history.push({ at: now, by: window.currentWorker || 'unknown', type: 'email', summary: `${tplId} → ${filled.subject}${attachments.length?` (+${attachments.length} attachment${attachments.length===1?'':'s'})`:''}` });
      // Set default next follow-up to +7 days if none
      if(!lead.nextFollowupAt) {
        const d = new Date(); d.setDate(d.getDate()+7);
        lead.nextFollowupAt = d.toISOString().split('T')[0];
      }
      await _saveLeads();
      try { window.logAudit && window.logAudit('outreach-email-sent', lead.id, lead.centerName + ' → ' + lead.contactEmail); } catch(e){}
      if(statusEl) { statusEl.textContent = `✓ Sent to ${lead.contactEmail}${attachments.length?` with ${attachments.length} attachment${attachments.length===1?'':'s'}`:''}.`; statusEl.style.color = '#166534'; }
      setTimeout(() => { document.getElementById('outreachSendModal')?.remove(); renderOutreach(); }, 1100);
    } catch(e) {
      if(statusEl) { statusEl.textContent = '✗ ' + (e.message || e); statusEl.style.color = '#b91c1c'; }
      btn.disabled = false; btn.textContent = '📧 Send Email';
    }
  };

  // Init when tab is shown
  const origShowTab = window.showTab;
  if(typeof origShowTab === 'function') {
    window.showTab = function(tab, push) {
      const r = origShowTab.apply(this, arguments);
      if(tab === 'outreach' && !_loaded) window.loadOutreach();
      else if(tab === 'outreach') renderOutreach();
      return r;
    };
  }
})();
