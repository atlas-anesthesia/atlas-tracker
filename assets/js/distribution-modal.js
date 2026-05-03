// distribution-modal.js
// ─────────────────────────────────────────────────────────────────────────────
// Distribution Sheet Builder Modal
//
// A modal that lets the worker (Josh / Dev) compose an itemized distribution
// sheet from log entries (case PI, expenses, initial-investment payback) plus
// custom line items not in the log, preview the result, and download a PDF.
//
// Replaces the inline "Record Distribution" form previously in app.js and the
// payout-pdf.js generator.
//
// Public API:
//   window.openDistributionModal(worker)       — open the builder
//   window.redownloadDistributionPDF(dist, w)  — regenerate PDF from saved record
//
// Depends on globals exposed by app.js: db, doc, setDoc, getDoc, uid, setSyncing.
// Uses jsPDF from window.jspdf (already loaded by index.html).
// ─────────────────────────────────────────────────────────────────────────────

(function() {
  'use strict';

  // ── State (per-modal-session) ──────────────────────────────────────────────
  let _worker      = 'josh';
  let _data        = null;         // raw atlas/payouts doc
  let _entries     = [];           // entries filtered to _worker
  let _selectedIds = new Set();    // entry IDs included in this distribution
  let _customItems = [];           // [{name, invoiced, actual, type}]
  let _meta        = { date: '', refNum: '', notes: '' };
  let _previewMode = false;
  let _distributedIds = new Set(); // entries already included in any past distribution

  // View-mode state — populated when openDistributionPreview() is called to
  // view an already-saved distribution. _viewingSaved short-circuits all
  // edit/build logic so the modal renders the saved record directly.
  let _viewingSaved = false;
  let _viewItems    = [];
  let _viewTotals   = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const _fmt = function(n) {
    return '$' + Number(n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  };
  const _today  = function() { return new Date().toISOString().slice(0,10); };
  const _fmtD   = function(d) {
    if(!d) return '';
    return new Date(d+'T12:00:00').toLocaleDateString('en-US', {year:'numeric', month:'long', day:'numeric'});
  };
  const _uidFn  = function() {
    return (window.uid ? window.uid() : Date.now().toString(36) + Math.random().toString(36).slice(2,7));
  };
  const _name   = function(w) { return w === 'josh' ? 'Josh Condado' : 'Dr. Dev Murthy'; };
  const _esc    = function(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  };
  // Recursively strip `undefined` values from a payload before handing it to
  // Firestore's setDoc, which rejects undefined with "Unsupported field value".
  // Keeps nulls, zeroes, empty strings, empty arrays/objects — only undefined
  // is removed. Used as a safety net around the distribution save.
  function _scrubUndefined(v) {
    if(Array.isArray(v)) return v.map(_scrubUndefined);
    if(v && typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach(function(k) {
        if(v[k] !== undefined) out[k] = _scrubUndefined(v[k]);
      });
      return out;
    }
    return v;
  }

  // ── PUBLIC: openDistributionModal ──────────────────────────────────────────
  window.openDistributionModal = async function(worker) {
    _worker      = worker || 'josh';
    _selectedIds = new Set();
    _customItems = [];
    _meta = {
      date: _today(),
      refNum: 'DIST-' + _uidFn().toUpperCase().slice(0, 8),
      notes: ''
    };
    _previewMode  = false;
    _viewingSaved = false;
    _viewItems    = [];
    _viewTotals   = null;

    try {
      window.setSyncing && window.setSyncing(true);
      const snap = await window.getDoc(window.doc(window.db, 'atlas', 'payouts'));
      _data = snap.exists() ? snap.data() : { entries: [], distributions: [] };
      window.setSyncing && window.setSyncing(false);
    } catch(e) {
      console.error('openDistributionModal load failed:', e);
      _data = { entries: [], distributions: [] };
      window.setSyncing && window.setSyncing(false);
    }

    _entries = (_data.entries || []).filter(function(e) { return e.worker === _worker; });

    // Set of entry IDs that already appear in some prior distribution for this
    // worker — used to render a "DISTRIBUTED" tag on those rows so the user
    // doesn't unwittingly include an item that's already been paid out.
    _distributedIds = new Set();
    (_data.distributions || []).forEach(function(d) {
      if(d.worker !== _worker) return;
      (d.lineItems || []).forEach(function(li) {
        if(li.sourceId) _distributedIds.add(li.sourceId);
      });
    });

    _renderModal();
  };

  // ── PUBLIC: openDistributionPreview ────────────────────────────────────────
  // Opens the modal directly into preview mode showing a previously-saved
  // distribution record. No build view, no "Back to Edit" button — just
  // the rendered sheet plus Close + Download PDF in the footer.
  // Distributions saved before lineItems support (legacy) get redirected to
  // the simple PDF re-download since there's nothing itemized to preview.
  window.openDistributionPreview = function(dist, worker) {
    if(!dist || !dist.lineItems || !dist.lineItems.length) {
      // Legacy distribution — no itemized data to preview, just regen the PDF
      if(typeof window.redownloadDistributionPDF === 'function') {
        window.redownloadDistributionPDF(dist, worker);
      }
      return;
    }
    _worker = worker || 'josh';
    _meta = {
      date:   dist.date   || '',
      refNum: dist.refNum || '',
      notes:  dist.notes  || ''
    };
    _viewItems    = dist.lineItems;
    _viewTotals   = dist.totals || _totalsFromLineItems(dist.lineItems);
    _viewingSaved = true;
    _previewMode  = true;       // enter directly in preview
    _selectedIds  = new Set();  // unused in view mode but reset for cleanliness
    _customItems  = [];

    _renderModal();
  };

  // ── Modal lifecycle ────────────────────────────────────────────────────────
  function _renderModal() {
    const existing = document.getElementById('dist-modal-overlay');
    if(existing) existing.remove();

    if(!document.getElementById('dist-modal-keyframes')) {
      const style = document.createElement('style');
      style.id = 'dist-modal-keyframes';
      style.textContent =
        '@keyframes distFadeIn { from{opacity:0} to{opacity:1} }' +
        '@keyframes distSlideUp { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }';
      document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.id = 'dist-modal-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;' +
      'display:flex;align-items:flex-start;justify-content:center;' +
      'padding:30px 20px;overflow-y:auto;animation:distFadeIn .15s ease-out';
    overlay.addEventListener('click', function(e) { if(e.target === overlay) _close(); });

    const modal = document.createElement('div');
    modal.id = 'dist-modal';
    modal.style.cssText =
      'background:var(--bg, #fff);width:100%;max-width:780px;border-radius:12px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,0.3);display:flex;flex-direction:column;' +
      'max-height:calc(100vh - 60px);overflow:hidden;animation:distSlideUp .2s ease-out';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    _renderInner();
  }

  function _close() {
    const ov = document.getElementById('dist-modal-overlay');
    if(ov) ov.remove();
  }

  function _renderInner() {
    const modal = document.getElementById('dist-modal');
    if(!modal) return;
    modal.innerHTML = _previewMode ? _previewHTML() : _builderHTML();
    _wireAll();
  }

  // ── Builder view ───────────────────────────────────────────────────────────
  function _builderHTML() {
    return _headerHTML('Build Distribution Sheet — ' + _name(_worker)) +
      '<div style="flex:1;overflow-y:auto;padding:20px 24px">' +
        '<div id="dist-meta-wrap">'   + _metaInner()   + '</div>' +
        '<div id="dist-items-wrap">'  + _itemsInner()  + '</div>' +
        '<div id="dist-custom-wrap">' + _customInner() + '</div>' +
        '<div id="dist-totals-wrap">' + _totalsInner() + '</div>' +
      '</div>' +
      _footerHTML([
        { id:'dist-cancel-btn',   label:'Cancel',                kind:'ghost'     },
        { id:'dist-preview-btn',  label:'👁  Preview',           kind:'secondary' },
        { id:'dist-download-btn', label:'💾  Save & Download PDF', kind:'primary' }
      ]);
  }

  function _headerHTML(title) {
    return '<div style="padding:18px 24px;border-bottom:1px solid var(--border);' +
      'display:flex;justify-content:space-between;align-items:center;flex-shrink:0">' +
      '<h2 style="margin:0;font-size:16px;font-weight:700;color:var(--text);letter-spacing:-.2px">' +
        _esc(title) + '</h2>' +
      '<button id="dist-close-btn" style="background:none;border:none;cursor:pointer;font-size:18px;' +
        'color:var(--text-faint);padding:4px 9px;border-radius:5px;line-height:1" title="Close">✕</button>' +
      '</div>';
  }

  function _footerHTML(buttons) {
    const styles = {
      primary:   'background:var(--info);color:white;border:1px solid var(--info)',
      secondary: 'background:white;color:var(--info);border:1px solid var(--info)',
      ghost:     'background:none;color:var(--text-muted);border:1px solid var(--border)'
    };
    const btns = buttons.map(function(b) {
      return '<button id="' + b.id + '" style="' + (styles[b.kind] || styles.ghost) +
        ';padding:9px 16px;border-radius:6px;font-size:13px;font-weight:600;' +
        'cursor:pointer;font-family:inherit;letter-spacing:.1px">' + b.label + '</button>';
    }).join('');
    return '<div style="padding:14px 24px;border-top:1px solid var(--border);' +
      'display:flex;justify-content:flex-end;gap:8px;background:var(--surface,#f9f9f9);' +
      'flex-shrink:0">' + btns + '</div>';
  }

  // ── Section: Meta info ─────────────────────────────────────────────────────
  function _metaInner() {
    return '<div style="margin-bottom:22px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);' +
        'letter-spacing:.5px;margin-bottom:8px">Distribution Info</div>' +
      '<div style="display:grid;grid-template-columns:140px 200px 1fr;gap:10px">' +
        _fieldHTML('Date',      'date',  'dist-meta-date',  _meta.date,    '', false) +
        _fieldHTML('Reference', 'text',  'dist-meta-ref',   _meta.refNum,  '', true) +
        _fieldHTML('Notes (optional)', 'text', 'dist-meta-notes', _meta.notes, 'e.g., May payout', false) +
      '</div></div>';
  }

  function _fieldHTML(label, type, id, value, placeholder, monospace) {
    return '<div>' +
      '<label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;font-weight:500">' + _esc(label) + '</label>' +
      '<input type="' + type + '" id="' + id + '" value="' + _esc(value) + '"' +
        (placeholder ? ' placeholder="' + _esc(placeholder) + '"' : '') +
        ' style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:5px;' +
        'font-size:12px;background:var(--bg);color:var(--text);box-sizing:border-box;' +
        'font-family:' + (monospace ? 'DM Mono,monospace' : 'inherit') + '">' +
      '</div>';
  }

  // ── Section: Available items from log ─────────────────────────────────────
  function _itemsInner() {
    if(!_entries.length) {
      return '<div style="margin-bottom:22px">' +
        '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);' +
        'letter-spacing:.5px;margin-bottom:8px">Available Items from Log</div>' +
        '<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12px;' +
        'background:var(--surface);border-radius:8px;border:1px dashed var(--border)">' +
        'No log entries available for this worker — add custom items below or visit Expenses & Distributions.' +
        '</div></div>';
    }

    const groups = [
      { key:'case-income',   icon:'📋', label:'Case Invoices',           filter: function(e) { return e.cat === 'case-income'; } },
      { key:'other-income',  icon:'💼', label:'Other Income',            filter: function(e) { return e.cat === 'other-income'; } },
      { key:'expense-group', icon:'🧾', label:'Expenses & Supplies',     filter: function(e) { return e.cat === 'supplies' || e.cat === 'expense'; } },
      { key:'initial-invest', icon:'🏦', label:'Initial Investment Payback', filter: function(e) { return e.cat === 'initial-invest'; } }
    ];

    let html = '<div style="margin-bottom:22px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);' +
      'letter-spacing:.5px;margin-bottom:8px">Available Items from Log</div>';

    groups.forEach(function(g) {
      const items = _entries.filter(g.filter);
      if(items.length) html += _groupHTML(g, items);
    });

    html += '</div>';
    return html;
  }

  function _groupHTML(group, items) {
    const eligibleIds = items
      .filter(function(it) { return !_isFutureCase(it); })
      .map(function(it) { return it.id; });
    const allSelected = eligibleIds.length > 0 &&
      eligibleIds.every(function(id) { return _selectedIds.has(id); });
    const toggleLabel = allSelected ? 'Deselect All' : 'Select All';

    let body = items.map(function(it) { return _itemRowHTML(it, group); }).join('');

    return '<div style="margin-bottom:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 14px;' +
        'background:var(--surface);border-bottom:1px solid var(--border)">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:13px">' + group.icon + '</span>' +
          '<span style="font-size:12px;font-weight:700;color:var(--text)">' + _esc(group.label) + '</span>' +
          '<span style="font-size:11px;color:var(--text-faint)">(' + items.length + ')</span>' +
        '</div>' +
        (eligibleIds.length > 0 ?
          '<button data-group="' + group.key + '" class="dist-toggle-all" ' +
          'style="font-size:10px;background:none;border:1px solid var(--border);' +
          'border-radius:4px;padding:3px 9px;color:var(--info);cursor:pointer;font-weight:600">' +
          toggleLabel + '</button>' : '') +
      '</div>' +
      '<div>' + body + '</div>' +
    '</div>';
  }

  function _isFutureCase(e) {
    return e.cat === 'case-income' && e.date && e.date > _today();
  }

  function _itemRowHTML(it, group) {
    const future  = _isFutureCase(it);
    const checked = _selectedIds.has(it.id);
    const isCase  = it.cat === 'case-income';

    // Right-side amount
    let rightCol;
    if(isCase) {
      if(future) {
        rightCol =
          '<div style="text-align:right;flex-shrink:0">' +
            '<div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.5px">PENDING</div>' +
            '<div style="font-size:10px;color:var(--text-faint);font-family:DM Mono,monospace;margin-top:2px">' +
            _fmt(it.amount) + ' invoice</div>' +
          '</div>';
      } else {
        rightCol =
          '<div style="text-align:right;flex-shrink:0">' +
            '<div style="font-size:13px;font-weight:700;color:#0369a1;font-family:DM Mono,monospace;line-height:1.2">+' +
            _fmt(it.personalIncome || 0) + '</div>' +
            '<div style="font-size:10px;color:var(--text-faint);font-family:DM Mono,monospace;margin-top:2px">of ' +
            _fmt(it.amount) + ' inv.</div>' +
          '</div>';
      }
    } else {
      const isExp = it.cat === 'supplies' || it.cat === 'expense';
      const sign  = isExp ? '−' : '+';
      const color = isExp ? '#b91c1c' : (it.cat === 'initial-invest' ? '#1d3557' : '#2d6a4f');
      rightCol =
        '<div style="text-align:right;flex-shrink:0">' +
          '<div style="font-size:13px;font-weight:700;color:' + color + ';' +
          'font-family:DM Mono,monospace;line-height:1.2">' + sign + _fmt(it.amount) + '</div>' +
        '</div>';
    }

    // Meta line
    const parts = [];
    if(it.date) parts.push(new Date(it.date+'T12:00:00').toLocaleDateString('en-US'));
    if(it.supplier) parts.push(it.supplier);
    let notes = it.notes || '';
    if(isCase && notes.indexOf('Center: ') === 0) notes = notes.slice(8);
    if(notes) parts.push(notes);
    const metaLine = parts.length
      ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px;line-height:1.4">' +
        parts.map(_esc).join('<span style="margin:0 6px;opacity:.5">·</span>') + '</div>'
      : '';

    const bgStyle = future ? 'opacity:.5;cursor:not-allowed'
                  : (checked ? 'background:rgba(29,83,198,0.05);cursor:pointer' : 'cursor:pointer');

    const distTag = _distributedIds.has(it.id)
      ? '<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:.4px;background:rgba(45,106,79,0.12);color:#2d6a4f;margin-left:7px;vertical-align:middle">✓ DISTRIBUTED</span>'
      : '';

    return '<label style="display:flex;align-items:flex-start;gap:11px;padding:10px 14px;' +
      'border-bottom:1px solid var(--border);transition:background .12s;' + bgStyle + '">' +
      '<input type="checkbox" data-id="' + _esc(it.id) + '" class="dist-item-cb"' +
        (checked ? ' checked' : '') + (future ? ' disabled' : '') +
        ' style="margin-top:2px;flex-shrink:0;cursor:' + (future ? 'not-allowed' : 'pointer') + '">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text);line-height:1.3;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _esc(it.name||'-') + distTag + '</div>' +
        metaLine +
      '</div>' +
      rightCol +
    '</label>';
  }

  // ── Section: Custom items ──────────────────────────────────────────────────
  // Custom rows have two numeric inputs:
  //   - "Invoiced": optional, contextual (rendered alongside actual on the
  //     PDF/preview as a second column, mirroring how case-income shows
  //     Invoice + PI). Doesn't affect totals.
  //   - "Actual Pay": the amount that contributes to the distribution total.
  //     Sign comes from `type` (income/+, expense/−, invest-payback/+).
  // Columns: name | invoiced | actual | type | delete
  // Grid template: 1fr 92px 92px 132px 30px = name flex + 4 fixed columns.
  function _customInner() {
    const colTemplate = '1fr 92px 92px 132px 30px';

    let rows;
    if(_customItems.length === 0) {
      rows = '<div style="padding:18px;text-align:center;color:var(--text-faint);font-size:12px">' +
        'No custom items yet — click <strong>+ Add Custom</strong> to add line items not in the log' +
      '</div>';
    } else {
      // Column-label header row — only shown when there's at least one item
      const headerRow =
        '<div style="display:grid;grid-template-columns:' + colTemplate + ';gap:8px;' +
          'padding:8px 14px;background:var(--surface);border-bottom:1px solid var(--border);' +
          'font-size:9px;font-weight:700;text-transform:uppercase;color:var(--text-faint);letter-spacing:.5px">' +
          '<div>Description</div>' +
          '<div style="text-align:right">Invoiced</div>' +
          '<div style="text-align:right">Actual Pay</div>' +
          '<div>Type</div>' +
          '<div></div>' +
        '</div>';

      const itemRows = _customItems.map(function(c, idx) {
        return '<div style="display:grid;grid-template-columns:' + colTemplate + ';gap:8px;' +
          'padding:9px 14px;border-bottom:1px solid var(--border);align-items:center">' +
          '<input type="text" class="dist-cu-name" data-idx="' + idx + '" value="' + _esc(c.name) + '" ' +
            'placeholder="Description" style="padding:7px 10px;border:1px solid var(--border);' +
            'border-radius:5px;font-size:12px;background:var(--bg);color:var(--text);font-family:inherit;box-sizing:border-box">' +
          '<input type="number" step="0.01" class="dist-cu-invoiced" data-idx="' + idx + '" value="' + _esc(c.invoiced) + '" ' +
            'placeholder="0.00" title="Invoiced amount (optional, contextual)" ' +
            'style="padding:7px 10px;border:1px solid var(--border);border-radius:5px;font-size:12px;' +
            'background:var(--bg);color:var(--text-muted);font-family:DM Mono,monospace;text-align:right;box-sizing:border-box">' +
          '<input type="number" step="0.01" class="dist-cu-actual" data-idx="' + idx + '" value="' + _esc(c.actual) + '" ' +
            'placeholder="0.00" title="Actual amount applied to total" ' +
            'style="padding:7px 10px;border:1px solid var(--border);border-radius:5px;font-size:12px;' +
            'background:var(--bg);color:var(--text);font-family:DM Mono,monospace;text-align:right;box-sizing:border-box;font-weight:600">' +
          '<select class="dist-cu-type" data-idx="' + idx + '" ' +
            'style="padding:7px 8px;border:1px solid var(--border);border-radius:5px;' +
            'font-size:12px;background:var(--bg);color:var(--text);font-family:inherit;box-sizing:border-box">' +
            '<option value="income"' +         (c.type==='income'         ? ' selected' : '') + '>Income (+)</option>' +
            '<option value="expense"' +        (c.type==='expense'        ? ' selected' : '') + '>Expense (−)</option>' +
            '<option value="invest-payback"' + (c.type==='invest-payback' ? ' selected' : '') + '>Invest. Payback (+)</option>' +
          '</select>' +
          '<button data-idx="' + idx + '" class="dist-cu-del" title="Remove" ' +
            'style="background:none;border:none;color:var(--warn,#b91c1c);cursor:pointer;' +
            'font-size:14px;padding:4px 8px;border-radius:4px;line-height:1">✕</button>' +
        '</div>';
      }).join('');

      rows = headerRow + itemRows;
    }

    return '<div style="margin-bottom:22px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);letter-spacing:.5px">' +
        'Custom Items</div>' +
        '<button id="dist-add-custom" style="font-size:11px;background:none;border:1px solid var(--info);' +
        'border-radius:5px;padding:4px 11px;color:var(--info);cursor:pointer;font-weight:600">+ Add Custom</button>' +
      '</div>' +
      '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">' + rows + '</div>' +
    '</div>';
  }

  // ── Section: Totals ────────────────────────────────────────────────────────
  function _totalsInner() {
    const t    = _calcTotals();
    const rows = [
      ['Personal Income',    t.pi,            '#0369a1'],
      ['Other Income',       t.otherIncome,   '#2d6a4f'],
      ['Expenses',          -t.expenses,      '#b91c1c'],
      ['Investment Payback', t.investPaid,    '#1d3557'],
      ['Custom',             t.custom,        '#525252']
    ].filter(function(r) { return r[1] !== 0; });

    let inner = '';
    if(rows.length === 0) {
      inner = '<div style="text-align:center;color:var(--text-faint);font-size:12px;padding:6px">' +
        'Select items above or add custom items to build the distribution</div>';
    } else {
      inner = rows.map(function(r) {
        const sign = r[1] < 0 ? '−' : '+';
        const abs  = Math.abs(r[1]);
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:13px">' +
          '<span style="color:var(--text-muted)">' + _esc(r[0]) + '</span>' +
          '<span style="font-weight:700;color:' + r[2] + ';font-family:DM Mono,monospace">' +
            sign + _fmt(abs) + '</span>' +
        '</div>';
      }).join('');
    }

    inner += '<div style="border-top:2px solid var(--border);margin-top:8px;padding-top:10px;' +
      'display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text)">' +
        'Total Distribution</span>' +
      '<span style="font-size:22px;font-weight:700;color:#2d6a4f;font-family:DM Mono,monospace">' +
        _fmt(t.total) + '</span>' +
    '</div>';

    return '<div style="margin-bottom:8px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-faint);letter-spacing:.5px;margin-bottom:8px">' +
        'Distribution Total</div>' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px">' +
        inner +
      '</div>' +
    '</div>';
  }

  // ── Calculations ───────────────────────────────────────────────────────────
  function _calcTotals() {
    let pi = 0, otherIncome = 0, expenses = 0, investPaid = 0, custom = 0;

    _entries.forEach(function(e) {
      if(!_selectedIds.has(e.id)) return;
      switch(e.cat) {
        case 'case-income':    pi          += (e.personalIncome || 0); break;
        case 'other-income':   otherIncome += (e.amount || 0);          break;
        case 'supplies':
        case 'expense':        expenses    += (e.amount || 0);          break;
        case 'initial-invest': investPaid  += (e.amount || 0);          break;
      }
    });

    _customItems.forEach(function(c) {
      // Contribution comes from the "actual pay" field; "invoiced" is contextual only.
      const actual = parseFloat(c.actual) || 0;
      if(c.type === 'expense')       custom -= actual;
      else                            custom += actual;
    });

    const total = pi + otherIncome - expenses + investPaid + custom;
    return { pi:pi, otherIncome:otherIncome, expenses:expenses, investPaid:investPaid, custom:custom, total:total };
  }

  // Build line items array for save + PDF
  function _buildLineItems() {
    const items = [];
    _entries.forEach(function(e) {
      if(!_selectedIds.has(e.id)) return;
      const item = {
        type:     e.cat,
        name:     e.name || '',
        date:     e.date || '',
        supplier: e.supplier || '',
        notes:    e.notes || '',
        amount:   e.amount || 0,
        sourceId: e.id
      };
      if(e.cat === 'case-income') {
        item.invoiceAmount  = e.amount || 0;
        item.personalIncome = e.personalIncome || 0;
        item.contribution   = e.personalIncome || 0;
      } else if(e.cat === 'supplies' || e.cat === 'expense') {
        item.contribution   = -(e.amount || 0);
      } else {
        item.contribution   = e.amount || 0;
      }
      items.push(item);
    });
    _customItems.forEach(function(c) {
      const invoiced = parseFloat(c.invoiced) || 0;
      const actual   = parseFloat(c.actual)   || 0;
      if(actual === 0 && invoiced === 0 && !(c.name||'').trim()) return; // skip empty
      const sign = c.type === 'expense' ? -1 : 1;
      items.push({
        type:         'custom',
        customType:   c.type,
        name:         c.name || 'Custom item',
        invoiced:     invoiced,
        actual:       actual,
        amount:       actual,            // legacy compat — older readers use `amount`
        contribution: actual * sign
      });
    });
    return items;
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  function _wireAll() {
    // Header / footer buttons
    const close    = document.getElementById('dist-close-btn');
    const cancel   = document.getElementById('dist-cancel-btn');
    const back     = document.getElementById('dist-back-btn');
    const preview  = document.getElementById('dist-preview-btn');
    const download = document.getElementById('dist-download-btn');

    if(close)    close.addEventListener('click', _close);
    if(cancel)   cancel.addEventListener('click', _close);
    if(back)     back.addEventListener('click', function() { _previewMode = false; _renderInner(); });
    if(preview)  preview.addEventListener('click', _onPreview);
    if(download) download.addEventListener('click', _onDownload);

    if(!_previewMode) {
      // Meta inputs
      _wireInput('dist-meta-date',  function(v) { _meta.date = v; });
      _wireInput('dist-meta-ref',   function(v) { _meta.refNum = v; });
      _wireInput('dist-meta-notes', function(v) { _meta.notes = v; });

      _wireItems();
      _wireCustom();
    }
  }

  function _wireInput(id, setter) {
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('input',  function(e) { setter(e.target.value); });
    el.addEventListener('change', function(e) { setter(e.target.value); });
  }

  function _wireItems() {
    document.querySelectorAll('.dist-item-cb').forEach(function(cb) {
      cb.addEventListener('change', function(e) {
        const id = e.target.getAttribute('data-id');
        if(e.target.checked) _selectedIds.add(id);
        else                 _selectedIds.delete(id);
        // Toggle label background without full re-render (preserves scroll)
        const label = e.target.closest('label');
        if(label) label.style.background = e.target.checked ? 'rgba(29,83,198,0.05)' : '';
        _refreshTotals();
      });
    });

    document.querySelectorAll('.dist-toggle-all').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        const groupKey = e.target.getAttribute('data-group');
        const cats = (groupKey === 'expense-group') ? ['supplies','expense'] : [groupKey];
        const items = _entries.filter(function(it) {
          return cats.indexOf(it.cat) >= 0 && !_isFutureCase(it);
        });
        const allSelected = items.length > 0 && items.every(function(it) { return _selectedIds.has(it.id); });
        if(allSelected) items.forEach(function(it) { _selectedIds.delete(it.id); });
        else            items.forEach(function(it) { _selectedIds.add(it.id); });
        _refreshItems();
        _refreshTotals();
      });
    });
  }

  function _wireCustom() {
    const addBtn = document.getElementById('dist-add-custom');
    if(addBtn) addBtn.addEventListener('click', function() {
      _customItems.push({ name:'', invoiced:'', actual:'', type:'income' });
      _refreshCustom();
      // focus the new row's name input
      const idx = _customItems.length - 1;
      const newInput = document.querySelector('.dist-cu-name[data-idx="' + idx + '"]');
      if(newInput) newInput.focus();
    });

    document.querySelectorAll('.dist-cu-del').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'));
        _customItems.splice(idx, 1);
        _refreshCustom();
        _refreshTotals();
      });
    });

    document.querySelectorAll('.dist-cu-name').forEach(function(inp) {
      inp.addEventListener('input', function(e) {
        const idx = parseInt(e.target.getAttribute('data-idx'));
        if(_customItems[idx]) _customItems[idx].name = e.target.value;
      });
    });

    document.querySelectorAll('.dist-cu-invoiced').forEach(function(inp) {
      inp.addEventListener('input', function(e) {
        const idx = parseInt(e.target.getAttribute('data-idx'));
        if(_customItems[idx]) {
          _customItems[idx].invoiced = e.target.value;
          // Invoiced is contextual only — doesn't change totals
        }
      });
    });

    document.querySelectorAll('.dist-cu-actual').forEach(function(inp) {
      inp.addEventListener('input', function(e) {
        const idx = parseInt(e.target.getAttribute('data-idx'));
        if(_customItems[idx]) {
          _customItems[idx].actual = e.target.value;
          _refreshTotals();
        }
      });
    });

    document.querySelectorAll('.dist-cu-type').forEach(function(sel) {
      sel.addEventListener('change', function(e) {
        const idx = parseInt(e.target.getAttribute('data-idx'));
        if(_customItems[idx]) {
          _customItems[idx].type = e.target.value;
          _refreshTotals();
        }
      });
    });
  }

  // Targeted re-renders (preserve scroll + focus where possible)
  function _refreshTotals() {
    const wrap = document.getElementById('dist-totals-wrap');
    if(wrap) wrap.innerHTML = _totalsInner();
  }
  function _refreshItems() {
    const wrap = document.getElementById('dist-items-wrap');
    if(wrap) { wrap.innerHTML = _itemsInner(); _wireItems(); }
  }
  function _refreshCustom() {
    const wrap = document.getElementById('dist-custom-wrap');
    if(wrap) { wrap.innerHTML = _customInner(); _wireCustom(); }
  }

  // ── Preview view ───────────────────────────────────────────────────────────
  function _onPreview() {
    const totals = _calcTotals();
    if(totals.total === 0 && _buildLineItems().length === 0) {
      alert('Select at least one item or add a custom item before previewing.');
      return;
    }
    _previewMode = true;
    _renderInner();
    // Scroll preview to top
    const inner = document.querySelector('#dist-modal > div[style*="overflow-y:auto"]');
    if(inner) inner.scrollTop = 0;
  }

  function _previewHTML() {
    // When viewing a saved distribution, source from the saved snapshot;
    // otherwise compute live from the current builder state.
    const items  = _viewingSaved ? _viewItems  : _buildLineItems();
    const totals = _viewingSaved ? _viewTotals : _calcTotals();
    const title  = _viewingSaved
      ? 'Distribution Sheet — ' + _name(_worker) + (_meta.refNum ? ' · ' + _meta.refNum : '')
      : 'Preview — Distribution Sheet';
    const footerButtons = _viewingSaved
      ? [
          { id:'dist-cancel-btn',   label:'Close',             kind:'ghost'   },
          { id:'dist-download-btn', label:'💾  Download PDF',  kind:'primary' }
        ]
      : [
          { id:'dist-back-btn',     label:'← Back to Edit',          kind:'ghost'   },
          { id:'dist-download-btn', label:'💾  Save & Download PDF', kind:'primary' }
        ];

    return _headerHTML(title) +
      '<div style="flex:1;overflow-y:auto;padding:30px;background:#ececeb">' +
        '<div style="background:white;max-width:680px;margin:0 auto;border-radius:6px;' +
          'box-shadow:0 4px 12px rgba(0,0,0,0.08);overflow:hidden">' +
          _previewBody(items, totals) +
        '</div>' +
      '</div>' +
      _footerHTML(footerButtons);
  }

  function _previewBody(items, totals) {
    let html = '';

    // Navy header bar
    html += '<div style="background:rgb(29,53,87);color:white;padding:22px 36px;' +
      'display:flex;justify-content:space-between;align-items:flex-start">' +
      '<div>' +
        '<div style="font-size:18px;font-weight:700;letter-spacing:-.3px">Atlas Anesthesia</div>' +
        '<div style="font-size:11px;opacity:.85;margin-top:3px">Distribution Sheet</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:11px;font-family:DM Mono,monospace">' + _esc(_meta.refNum) + '</div>' +
        '<div style="font-size:10px;opacity:.85;margin-top:3px">' + _esc(_fmtD(_meta.date)) + '</div>' +
      '</div>' +
    '</div>';

    // Body
    html += '<div style="padding:26px 36px 30px;color:#222">';

    html += '<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px">Distribution To</div>' +
      '<div style="font-size:14px;font-weight:600;margin-top:3px;color:#222">' + _esc(_name(_worker)) + '</div>' +
      '<div style="font-size:11px;color:#888;margin-top:1px">Atlas Anesthesia</div>';

    html += '<div style="height:1px;background:#e5e5e5;margin:20px 0"></div>';

    // Itemized sections
    const sections = [
      { title:'Case Invoices',              filter: function(it) { return it.type === 'case-income'; }, color:'#0369a1', isCases:true },
      { title:'Other Income',               filter: function(it) { return it.type === 'other-income'; }, color:'#2d6a4f' },
      { title:'Expenses & Supplies',        filter: function(it) { return it.type === 'supplies' || it.type === 'expense'; }, color:'#b91c1c' },
      { title:'Initial Investment Payback', filter: function(it) { return it.type === 'initial-invest'; }, color:'#1d3557' },
      { title:'Custom Items',               filter: function(it) { return it.type === 'custom'; }, color:'#525252', isCustom:true }
    ];

    sections.forEach(function(sec) {
      const secItems = items.filter(sec.filter);
      if(!secItems.length) return;

      // Two-column layout fires for case-income (always) and for the custom
      // section when at least one item has an invoiced amount entered.
      const customHasInvoiced = sec.isCustom && secItems.some(function(it) { return (it.invoiced || 0) > 0; });
      const isTwoCol  = sec.isCases || customHasInvoiced;
      const leftLbl   = sec.isCases ? 'Invoice' : 'Invoiced';
      const rightLbl  = sec.isCases ? 'Personal Income' : 'Actual Pay';

      // Section title — for two-column sections we add right-aligned column labels
      if(isTwoCol) {
        html += '<div style="margin-bottom:18px">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid #ececec">' +
            '<div style="font-size:10px;font-weight:700;color:' + sec.color + ';text-transform:uppercase;letter-spacing:.7px">' + _esc(sec.title) + '</div>' +
            '<div style="display:flex;flex-shrink:0">' +
              '<div style="font-size:9px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.5px;width:100px;text-align:right">' + leftLbl + '</div>' +
              '<div style="font-size:9px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.5px;width:120px;text-align:right;padding-left:10px">' + rightLbl + '</div>' +
            '</div>' +
          '</div>';
      } else {
        html += '<div style="margin-bottom:18px">' +
          '<div style="font-size:10px;font-weight:700;color:' + sec.color + ';' +
          'text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px;padding-bottom:5px;' +
          'border-bottom:1px solid #ececec">' + _esc(sec.title) + '</div>';
      }

      secItems.forEach(function(it) {
        // Decide layout: case rows always two-col, custom rows two-col when
        // either the item itself OR a sibling custom item has invoiced filled
        // (so the columns align across the whole custom section).
        const itemIsTwoCol = sec.isCases || (sec.isCustom && customHasInvoiced);

        if(itemIsTwoCol) {
          let leftAmt, rightAmt, rightSign, rightColor;
          let subParts = [];
          if(sec.isCases) {
            leftAmt    = it.invoiceAmount || it.amount || 0;
            rightAmt   = it.personalIncome || 0;
            rightSign  = '+';
            rightColor = '#0369a1';
            if(it.supplier) subParts.push(it.supplier);
            let n = it.notes || '';
            if(n.indexOf('Center: ') === 0) n = n.slice(8);
            if(n) subParts.push(n);
          } else {
            // Custom item in two-col mode
            leftAmt    = it.invoiced || 0;
            rightAmt   = it.actual || 0;
            const isExp = it.customType === 'expense';
            rightSign  = isExp ? '−' : '+';
            rightColor = isExp ? '#b91c1c' : (it.customType === 'invest-payback' ? '#1d3557' : '#2d6a4f');
            const t = it.customType === 'expense' ? 'Expense'
                    : it.customType === 'invest-payback' ? 'Investment Payback' : 'Income';
            subParts.push(t);
          }
          // Only render the left amount cell text if there's something to show
          const leftCell = leftAmt > 0
            ? _fmt(leftAmt)
            : '<span style="color:#ccc">—</span>';

          html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0">' +
            '<div style="flex:1;min-width:0;padding-right:14px">' +
              '<div style="font-size:12px;color:#222;font-weight:500">' + _esc(it.name) + '</div>' +
              (subParts.length ? '<div style="font-size:10px;color:#888;margin-top:2px">' +
                subParts.map(_esc).join(' · ') + '</div>' : '') +
            '</div>' +
            '<div style="font-size:12px;font-weight:500;color:#666;font-family:DM Mono,monospace;flex-shrink:0;width:100px;text-align:right">' +
              leftCell + '</div>' +
            '<div style="font-size:12px;font-weight:700;color:' + rightColor + ';font-family:DM Mono,monospace;flex-shrink:0;width:120px;text-align:right;padding-left:10px">' +
              (rightAmt !== 0 ? rightSign + _fmt(Math.abs(rightAmt)) : '<span style="color:#ccc">—</span>') + '</div>' +
          '</div>';
        } else {
          // Standard single-amount row (other-income / expenses / invest / no-invoiced custom)
          const c    = it.contribution;
          const sign = c >= 0 ? '+' : '−';
          const col  = c >= 0 ? sec.color : '#b91c1c';
          const subParts = [];
          if(it.supplier) subParts.push(it.supplier);
          let n = it.notes || '';
          if(n) subParts.push(n);
          if(it.type === 'custom') {
            const t = it.customType === 'expense' ? 'Expense'
                    : it.customType === 'invest-payback' ? 'Investment Payback' : 'Income';
            subParts.push(t);
          }

          html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0">' +
            '<div style="flex:1;min-width:0;padding-right:14px">' +
              '<div style="font-size:12px;color:#222;font-weight:500">' + _esc(it.name) + '</div>' +
              (subParts.length ? '<div style="font-size:10px;color:#888;margin-top:2px">' +
                subParts.map(_esc).join(' · ') + '</div>' : '') +
            '</div>' +
            '<div style="font-size:12px;font-weight:700;color:' + col + ';font-family:DM Mono,monospace;flex-shrink:0">' +
              sign + _fmt(Math.abs(c)) + '</div>' +
          '</div>';
        }
      });

      html += '</div>';
    });

    if(items.length === 0) {
      html += '<div style="padding:20px;text-align:center;color:#999;font-size:12px;font-style:italic">No items selected</div>';
    }

    // Totals breakdown
    html += '<div style="height:1px;background:#ddd;margin:14px 0 16px"></div>';
    const trows = [
      ['Personal Income',     totals.pi,           '#0369a1'],
      ['Other Income',        totals.otherIncome,  '#2d6a4f'],
      ['Expenses',           -totals.expenses,     '#b91c1c'],
      ['Investment Payback',  totals.investPaid,   '#1d3557'],
      ['Custom',              totals.custom,       '#525252']
    ].filter(function(r) { return r[1] !== 0; });

    trows.forEach(function(r) {
      const sign = r[1] < 0 ? '−' : '+';
      html += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0">' +
        '<span style="color:#666">' + _esc(r[0]) + '</span>' +
        '<span style="font-weight:600;color:' + r[2] + ';font-family:DM Mono,monospace">' +
          sign + _fmt(Math.abs(r[1])) + '</span>' +
      '</div>';
    });

    // Total box
    html += '<div style="margin-top:18px;padding:16px 20px;background:#f0f7f0;' +
      'border:1.5px solid #2d6a4f;border-radius:6px;display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:11px;font-weight:700;color:#444;text-transform:uppercase;letter-spacing:.7px">Total Distribution</span>' +
      '<span style="font-size:22px;font-weight:700;color:#2d6a4f;font-family:DM Mono,monospace">' + _fmt(totals.total) + '</span>' +
    '</div>';

    if(_meta.notes) {
      html += '<div style="margin-top:18px;padding-top:14px;border-top:1px solid #ececec">' +
        '<div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Notes</div>' +
        '<div style="font-size:11px;color:#444;line-height:1.5">' + _esc(_meta.notes) + '</div>' +
      '</div>';
    }

    // Footer
    html += '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #ececec;text-align:center;font-size:9px;color:#aaa">' +
      'Atlas Anesthesia · Distribution Record · ' + _esc(_meta.refNum) + ' · ' + _esc(_fmtD(_meta.date)) +
    '</div>';

    html += '</div>';
    return html;
  }

  // ── Save + Download ────────────────────────────────────────────────────────
  async function _onDownload() {
    // View-only mode: just regenerate the PDF from the loaded snapshot,
    // no Firestore write. The user is looking at an already-saved record.
    if(_viewingSaved) {
      try {
        _generatePDF({
          worker:    _worker,
          meta:      { date: _meta.date, refNum: _meta.refNum, notes: _meta.notes },
          lineItems: _viewItems,
          totals:    _viewTotals
        });
      } catch(e) {
        console.error('PDF regen failed:', e);
        alert('PDF generation failed: ' + (e.message || e));
      }
      return;
    }

    const lineItems = _buildLineItems();
    const totals    = _calcTotals();

    if(lineItems.length === 0) {
      alert('Select at least one item or add a custom item before saving.');
      return;
    }
    if(totals.total <= 0) {
      const ok = confirm('The total distribution is ' + _fmt(totals.total) +
        '. Save this anyway? (Distributions are usually positive.)');
      if(!ok) return;
    }
    if(!_meta.date) { alert('Please pick a date.'); return; }

    // Build distribution record. We build the object without any undefined
    // fields up-front (Firestore rejects undefined) and then run the entire
    // payload through _scrubUndefined() before setDoc as a safety net for any
    // stray undefined that snuck in from older legacy data in the doc.
    const distId  = _uidFn();
    const refNum  = (_meta.refNum || '').trim() || ('DIST-' + distId.toUpperCase().slice(0,8));
    const distRec = {
      id: distId,
      refNum: refNum,
      worker: _worker,
      date:   _meta.date || '',
      notes:  (_meta.notes || '').trim(),
      amount: totals.total,                  // top-line total — read by app.js _totals
      lineItems: lineItems,
      totals: totals,
      createdAt: new Date().toISOString()
    };
    if(totals.investPaid > 0) distRec.investPaid = totals.investPaid;  // read by _totals when paying back

    // Save to Firestore
    try {
      window.setSyncing && window.setSyncing(true);
      const snap = await window.getDoc(window.doc(window.db, 'atlas', 'payouts'));
      const data = snap.exists() ? snap.data() : { entries:[], distributions:[] };
      if(!data.distributions) data.distributions = [];
      data.distributions.push(distRec);

      // Investment archival: if cumulative investPaid covers totalInvest, archive
      const investEntries = (data.entries||[]).filter(function(e) {
        return e.worker === _worker && e.cat === 'initial-invest';
      });
      const totalInvest = investEntries.reduce(function(s,e) { return s + (e.amount||0); }, 0);
      const totalInvestPaid = (data.distributions||[])
        .filter(function(d) { return d.worker === _worker; })
        .reduce(function(s,d) { return s + (d.investPaid||0); }, 0);

      if(totalInvest > 0 && totalInvestPaid >= totalInvest) {
        if(!data.investHistory) data.investHistory = [];
        data.investHistory.push({
          id: _uidFn(), worker: _worker,
          amountPaid: totalInvestPaid, totalInvest: totalInvest,
          entries: investEntries, paidBackAt: new Date().toISOString()
        });
        data.entries = (data.entries||[]).filter(function(e) {
          return !(e.worker === _worker && e.cat === 'initial-invest');
        });
      }

      await window.setDoc(window.doc(window.db, 'atlas', 'payouts'), _scrubUndefined(data));
      window.setSyncing && window.setSyncing(false);
    } catch(e) {
      console.error('Distribution save failed:', e);
      window.setSyncing && window.setSyncing(false);
      alert('Save failed: ' + (e.message || e));
      return;
    }

    // Generate PDF
    try {
      _generatePDF({
        worker:    _worker,
        meta:      { date: _meta.date, refNum: refNum, notes: _meta.notes },
        lineItems: lineItems,
        totals:    totals
      });
    } catch(e) {
      console.error('PDF generation failed:', e);
      alert('Saved, but PDF generation failed: ' + (e.message || e));
    }

    _close();
    if(typeof window.renderPayoutTab === 'function') window.renderPayoutTab();
  }

  // ── PDF generation (jsPDF) ─────────────────────────────────────────────────
  function _generatePDF(payload) {
    if(!window.jspdf || !window.jspdf.jsPDF) {
      alert('PDF library not loaded yet. Try again in a moment.');
      return;
    }
    const jsPDF = window.jspdf.jsPDF;
    const doc   = new jsPDF({ orientation:'portrait', unit:'pt', format:'letter' });
    const W = 612, M = 50;
    const worker    = payload.worker;
    const meta      = payload.meta || {};
    const items     = payload.lineItems || [];
    const totals    = payload.totals    || { pi:0, otherIncome:0, expenses:0, investPaid:0, custom:0, total:0 };
    const refNum    = meta.refNum || ('DIST-' + Date.now().toString(36).toUpperCase().slice(0,8));
    const dateStr   = _fmtD(meta.date) || _fmtD(_today());
    const fmt       = function(n) { return _fmt(n); };

    // ── Header (navy bar) ────────────────────────────────────────────────────
    doc.setFillColor(29, 53, 87);
    doc.rect(0, 0, W, 70, 'F');
    doc.setFont('Helvetica','bold');
    doc.setFontSize(18); doc.setTextColor(255,255,255);
    doc.text('Atlas Anesthesia', M, 30);
    doc.setFontSize(10); doc.setFont('Helvetica','normal');
    doc.text('Distribution Sheet', M, 46);
    doc.setFontSize(9);
    doc.text(refNum, W-M, 30, {align:'right'});
    doc.text(dateStr, W-M, 46, {align:'right'});

    let y = 95;

    // ── Recipient ────────────────────────────────────────────────────────────
    doc.setTextColor(120,120,120);
    doc.setFont('Helvetica','bold'); doc.setFontSize(8);
    doc.text('DISTRIBUTION TO', M, y); y += 13;
    doc.setTextColor(40,40,40);
    doc.setFont('Helvetica','bold'); doc.setFontSize(13);
    doc.text(_name(worker), M, y); y += 14;
    doc.setFont('Helvetica','normal'); doc.setFontSize(9);
    doc.setTextColor(140,140,140);
    doc.text('Atlas Anesthesia', M, y); y += 22;

    // Divider
    doc.setDrawColor(220,220,220); doc.setLineWidth(0.5);
    doc.line(M, y, W-M, y); y += 18;

    // ── Itemized sections ────────────────────────────────────────────────────
    const sections = [
      { title:'Case Invoices',              filter: function(it){return it.type==='case-income';},   color:[3,105,161],   isCases:true },
      { title:'Other Income',               filter: function(it){return it.type==='other-income';},  color:[45,106,79]   },
      { title:'Expenses & Supplies',        filter: function(it){return it.type==='supplies' || it.type==='expense';}, color:[185,28,28] },
      { title:'Initial Investment Payback', filter: function(it){return it.type==='initial-invest';}, color:[29,53,87]   },
      { title:'Custom Items',               filter: function(it){return it.type==='custom';},        color:[82,82,82],    isCustom:true }
    ];

    // Column anchors for the two-column layout (right-aligned x positions)
    const COL_INVOICE = W - M - 130;   // right edge of left amount column
    const COL_PI      = W - M;          // right edge of right amount column

    sections.forEach(function(sec) {
      const secItems = items.filter(sec.filter);
      if(!secItems.length) return;

      if(y > 700) { doc.addPage(); y = 50; }

      const customHasInvoiced = sec.isCustom && secItems.some(function(it) { return (it.invoiced || 0) > 0; });
      const isTwoCol  = sec.isCases || customHasInvoiced;
      const leftLbl   = sec.isCases ? 'INVOICE' : 'INVOICED';
      const rightLbl  = sec.isCases ? 'PERSONAL INCOME' : 'ACTUAL PAY';

      // Section title — two-column sections also get right-aligned column labels
      doc.setFont('Helvetica','bold'); doc.setFontSize(9);
      doc.setTextColor(sec.color[0], sec.color[1], sec.color[2]);
      doc.text(sec.title.toUpperCase(), M, y);
      if(isTwoCol) {
        doc.setFont('Helvetica','bold'); doc.setFontSize(7);
        doc.setTextColor(150,150,150);
        doc.text(leftLbl,  COL_INVOICE, y, {align:'right'});
        doc.text(rightLbl, COL_PI,      y, {align:'right'});
      }
      y += 4;
      doc.setDrawColor(230,230,230);
      doc.line(M, y, W-M, y); y += 12;

      secItems.forEach(function(it) {
        if(y > 730) { doc.addPage(); y = 50; }

        if(isTwoCol) {
          // Two-column row used by case-income and (when invoiced is filled) custom items
          let leftAmt, rightAmt, rightSign, rightColor;
          let subParts = [];
          if(sec.isCases) {
            leftAmt    = it.invoiceAmount || it.amount || 0;
            rightAmt   = it.personalIncome || 0;
            rightSign  = '+';
            rightColor = [3, 105, 161];
            if(it.supplier) subParts.push(it.supplier);
            let n = it.notes || '';
            if(n.indexOf('Center: ') === 0) n = n.slice(8);
            if(n) subParts.push(n);
          } else {
            leftAmt    = it.invoiced || 0;
            rightAmt   = it.actual   || 0;
            const isExp = it.customType === 'expense';
            rightSign  = isExp ? '-' : '+';
            rightColor = isExp ? [185,28,28] : (it.customType === 'invest-payback' ? [29,53,87] : [45,106,79]);
            const t = it.customType === 'expense' ? 'Expense'
                    : it.customType === 'invest-payback' ? 'Investment Payback' : 'Income';
            subParts.push(t);
          }

          const nameWidth = COL_INVOICE - M - 110;
          const nameLines = doc.splitTextToSize(it.name || '-', nameWidth);
          doc.setFont('Helvetica','normal'); doc.setFontSize(10);
          doc.setTextColor(40,40,40);
          doc.text(nameLines[0], M, y);

          // Left amount (subdued gray), or em-dash if blank
          doc.setFont('Helvetica','normal');
          doc.setTextColor(110,110,110);
          doc.text(leftAmt > 0 ? fmt(leftAmt) : '\u2014', COL_INVOICE, y, {align:'right'});

          // Right amount (bold colored), or em-dash if zero
          doc.setFont('Helvetica','bold');
          doc.setTextColor(rightColor[0], rightColor[1], rightColor[2]);
          doc.text(rightAmt !== 0 ? rightSign + fmt(Math.abs(rightAmt)) : '\u2014', COL_PI, y, {align:'right'});
          y += 13;

          if(subParts.length) {
            doc.setFont('Helvetica','normal'); doc.setFontSize(8);
            doc.setTextColor(140,140,140);
            const subLines = doc.splitTextToSize(subParts.join('  \u00B7  '), nameWidth);
            doc.text(subLines[0], M+10, y); y += 10;
          }
        } else {
          // Standard single-amount row (other-income / expenses / invest / no-invoiced custom)
          const nameWidth = W - M - M - 110;
          const nameLines = doc.splitTextToSize(it.name || '-', nameWidth);
          doc.setFont('Helvetica','normal'); doc.setFontSize(10);
          doc.setTextColor(40,40,40);
          doc.text(nameLines[0], M, y);

          const c    = it.contribution || 0;
          const sign = c >= 0 ? '+' : '-';
          const col  = c >= 0 ? sec.color : [185,28,28];
          doc.setFont('Helvetica','bold');
          doc.setTextColor(col[0], col[1], col[2]);
          doc.text(sign + fmt(Math.abs(c)), W-M, y, {align:'right'});
          y += 13;

          const subParts = [];
          if(it.supplier) subParts.push(it.supplier);
          let n = it.notes || '';
          if(n) subParts.push(n);
          if(it.type === 'custom') {
            const t = it.customType === 'expense' ? 'Expense'
                    : it.customType === 'invest-payback' ? 'Investment Payback' : 'Income';
            subParts.push(t);
          }
          if(subParts.length) {
            doc.setFont('Helvetica','normal'); doc.setFontSize(8);
            doc.setTextColor(140,140,140);
            const subLines = doc.splitTextToSize(subParts.join('  \u00B7  '), nameWidth);
            doc.text(subLines[0], M+10, y); y += 10;
          }
        }
        y += 3;
      });
      y += 6;
    });

    // ── Totals breakdown ─────────────────────────────────────────────────────
    if(y > 600) { doc.addPage(); y = 50; }
    doc.setDrawColor(180,180,180); doc.setLineWidth(0.5);
    doc.line(M, y, W-M, y); y += 14;

    const trows = [
      ['Personal Income',     totals.pi,            [3,105,161]],
      ['Other Income',        totals.otherIncome,   [45,106,79]],
      ['Expenses',           -totals.expenses,      [185,28,28]],
      ['Investment Payback',  totals.investPaid,    [29,53,87]],
      ['Custom',              totals.custom,        [82,82,82]]
    ].filter(function(r) { return r[1] !== 0; });

    trows.forEach(function(r) {
      doc.setFont('Helvetica','normal'); doc.setFontSize(10);
      doc.setTextColor(80,80,80);
      doc.text(r[0], M, y);
      const sign = r[1] < 0 ? '-' : '+';
      doc.setFont('Helvetica','bold');
      doc.setTextColor(r[2][0], r[2][1], r[2][2]);
      doc.text(sign + fmt(Math.abs(r[1])), W-M, y, {align:'right'});
      y += 14;
    });

    y += 4;

    // ── Total box ────────────────────────────────────────────────────────────
    if(y > 680) { doc.addPage(); y = 50; }
    doc.setFillColor(240,247,240);
    doc.setDrawColor(45,106,79); doc.setLineWidth(1);
    doc.roundedRect(M, y, W-2*M, 50, 5, 5, 'FD');
    doc.setFont('Helvetica','bold'); doc.setFontSize(10);
    doc.setTextColor(80,80,80);
    doc.text('TOTAL DISTRIBUTION', W/2, y+18, {align:'center'});
    doc.setFontSize(22); doc.setTextColor(45,106,79);
    doc.text(fmt(totals.total), W/2, y+40, {align:'center'});
    y += 68;

    // ── Notes ────────────────────────────────────────────────────────────────
    if(meta.notes) {
      if(y > 700) { doc.addPage(); y = 50; }
      doc.setFont('Helvetica','bold'); doc.setFontSize(9);
      doc.setTextColor(100,100,100);
      doc.text('Notes', M, y); y += 12;
      doc.setFont('Helvetica','normal'); doc.setFontSize(9);
      doc.setTextColor(60,60,60);
      const noteLines = doc.splitTextToSize(meta.notes, W-2*M);
      noteLines.forEach(function(l) { doc.text(l, M, y); y += 11; });
      y += 6;
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    doc.setFont('Helvetica','normal'); doc.setFontSize(8);
    doc.setTextColor(160,160,160);
    doc.text('Atlas Anesthesia  \u00B7  Distribution Record  \u00B7  ' + refNum + '  \u00B7  ' + dateStr,
      W/2, 760, {align:'center'});

    doc.save('Distribution_' + _name(worker).replace(/ /g,'_') + '_' + refNum + '.pdf');
  }

  // ── PUBLIC: redownload (legacy + new format) ───────────────────────────────
  window.redownloadDistributionPDF = function(dist, worker) {
    if(!window.jspdf || !window.jspdf.jsPDF) {
      alert('PDF library not loaded yet. Try again in a moment.');
      return;
    }
    if(dist.lineItems && dist.lineItems.length) {
      // New format — full itemized regen
      _generatePDF({
        worker: worker,
        meta:   { date: dist.date, refNum: dist.refNum, notes: dist.notes },
        lineItems: dist.lineItems,
        totals:    dist.totals || _totalsFromLineItems(dist.lineItems)
      });
    } else {
      // Legacy format — minimal summary regen using just the saved fields
      _generateLegacyPDF(dist, worker);
    }
  };

  function _totalsFromLineItems(items) {
    const t = { pi:0, otherIncome:0, expenses:0, investPaid:0, custom:0, total:0 };
    items.forEach(function(it) {
      switch(it.type) {
        case 'case-income':    t.pi          += (it.personalIncome || 0); break;
        case 'other-income':   t.otherIncome += (it.amount || 0);          break;
        case 'supplies':
        case 'expense':        t.expenses    += (it.amount || 0);          break;
        case 'initial-invest': t.investPaid  += (it.amount || 0);          break;
        case 'custom':
          if(it.customType === 'expense') t.custom -= (it.amount || 0);
          else                            t.custom += (it.amount || 0);
          break;
      }
    });
    t.total = t.pi + t.otherIncome - t.expenses + t.investPaid + t.custom;
    return t;
  }

  function _generateLegacyPDF(dist, worker) {
    const jsPDF = window.jspdf.jsPDF;
    const doc   = new jsPDF({ orientation:'portrait', unit:'pt', format:'letter' });
    const W = 612, M = 50;
    const refNum  = dist.refNum || ('DIST-' + (dist.id || '').toUpperCase().slice(0,8));
    const dateStr = _fmtD(dist.date) || _fmtD(_today());

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
    doc.setTextColor(40,40,40);
    doc.setFont('Helvetica','bold'); doc.setFontSize(11);
    doc.text('Distribution To: ' + _name(worker), M, y); y += 24;

    doc.setDrawColor(220,220,220); doc.line(M, y, W-M, y); y += 22;

    doc.setFillColor(240,247,240);
    doc.setDrawColor(45,106,79); doc.setLineWidth(1);
    doc.roundedRect(M, y, W-2*M, 50, 5, 5, 'FD');
    doc.setFont('Helvetica','bold'); doc.setFontSize(10);
    doc.setTextColor(80,80,80);
    doc.text('AMOUNT DISTRIBUTED', W/2, y+18, {align:'center'});
    doc.setFontSize(22); doc.setTextColor(45,106,79);
    doc.text(_fmt(dist.amount || 0), W/2, y+40, {align:'center'});
    y += 70;

    if(dist.investPaid > 0) {
      doc.setFont('Helvetica','normal'); doc.setFontSize(9);
      doc.setTextColor(29,83,198);
      doc.text('Initial Investment Repayment: ' + _fmt(dist.investPaid), M, y);
      y += 18;
    }

    if(dist.notes) {
      doc.setFont('Helvetica','bold'); doc.setFontSize(9);
      doc.setTextColor(100,100,100);
      doc.text('Notes', M, y); y += 12;
      doc.setFont('Helvetica','normal'); doc.setTextColor(60,60,60);
      doc.splitTextToSize(dist.notes, W-2*M).forEach(function(l) { doc.text(l, M, y); y += 11; });
    }

    doc.setFontSize(8); doc.setTextColor(160,160,160);
    doc.text('Atlas Anesthesia  \u00B7  Distribution Record  \u00B7  ' + refNum + '  \u00B7  ' + dateStr,
      W/2, 760, {align:'center'});

    doc.save('Distribution_' + _name(worker).replace(/ /g,'_') + '_' + refNum + '.pdf');
  }

})();
