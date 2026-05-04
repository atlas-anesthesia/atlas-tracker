// ─────────────────────────────────────────────────────────────────────────────
// inventory-order.js — Vendor-specific order sheet builder.
//
// Opens a modal with three vendor tabs (Henry Schein, Smith Pharmacy, Toad
// Airway). Each tab shows every inventory item where the supplier field
// matches that vendor (case-insensitive substring). For each item the user
// can type an Order Qty. Click "Generate PDF" to download a vendor-scoped
// order sheet listing just the items where qty > 0.
//
// Quantities persist when switching between vendor tabs, so you can fill
// out all three in one session without losing your work.
//
// Triggered by the "📋 Vendor Order" button in the inventory tab.
// Exposed: window.openVendorOrderModal()
// ─────────────────────────────────────────────────────────────────────────────

(function() {
  'use strict';

  // Match definition: `match` is what we substring-search the supplier field
  // for (case-insensitive). Keeps "Toad" and "Toad Airway" both matching.
  const VENDORS = [
    { key: 'henry-schein',    label: 'Henry Schein',    match: 'henry schein' },
    { key: 'smith-pharmacy',  label: 'Smith Pharmacy',  match: 'smith pharmacy' },
    { key: 'toad',            label: 'Toad Airway',     match: 'toad' }
  ];

  let _activeVendor = 'henry-schein';
  // Per-vendor scratch state so switching tabs doesn't blow away typed qtys.
  // Shape: { 'henry-schein': { itemId: qty }, ... }
  const _orderQtys = {};

  function _truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function _itemMatchesVendor(item, vendor) {
    const supplier = (item && item.supplier || '').toLowerCase();
    return supplier.indexOf(vendor.match) !== -1;
  }

  // Resolve the inventory context the user is currently viewing — this is
  // the same tab they have selected on the Inventory page (Devarsh / Josh /
  // Combined). Mirroring that context keeps modal numbers aligned with the
  // inventory list right above. Defaults to 'dev' if the tab state isn't set.
  function _activeWorker() {
    return window.currentInvTab || 'dev';
  }
  function _stockFor(item, w) {
    if(w === 'combined') return (item.stockDev || 0) + (item.stockJosh || 0);
    if(w === 'josh')     return  item.stockJosh || 0;
    return item.stockDev || 0;
  }
  function _isLowStock(item, w) {
    // Combined uses 2x the per-kit alert (matches Inventory's combined check)
    const alert = item.alert || 0;
    if(w === 'combined') return _stockFor(item, w) <= alert * 2;
    return _stockFor(item, w) <= alert;
  }
  function _workerLabel(w) {
    if(w === 'josh')     return 'Josh';
    if(w === 'combined') return 'Combined';
    return 'Devarsh';
  }

  function _itemsForVendor(vendorKey) {
    const vendor = VENDORS.find(function(v) { return v.key === vendorKey; });
    if(!vendor) return [];
    const w = _activeWorker();
    return (window.items || [])
      .filter(function(i) { return i && _itemMatchesVendor(i, vendor); })
      .sort(function(a, b) {
        // Items where THIS view's stock is at or below alert (red) at the
        // top, then by ascending stock, then alphabetical.
        const redA   = _isLowStock(a, w) ? 1 : 0;
        const redB   = _isLowStock(b, w) ? 1 : 0;
        if(redA !== redB) return redB - redA;
        const stockA = _stockFor(a, w);
        const stockB = _stockFor(b, w);
        if(stockA !== stockB) return stockA - stockB;
        return (a.generic || '').localeCompare(b.generic || '');
      });
  }

  function _captureCurrentQtys() {
    if(!_orderQtys[_activeVendor]) _orderQtys[_activeVendor] = {};
    const map = _orderQtys[_activeVendor];
    document.querySelectorAll('#vom-items input[data-itemid]').forEach(function(input) {
      const id = input.dataset.itemid;
      const v = parseFloat(input.value);
      if(v > 0) map[id] = v;
      else delete map[id];
    });
  }

  function _renderItems() {
    const container = document.getElementById('vom-items');
    if(!container) return;
    const items = _itemsForVendor(_activeVendor);
    const qtys  = _orderQtys[_activeVendor] || {};

    if(!items.length) {
      container.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#999;font-style:italic">No inventory items found with this vendor as supplier.<br><span style="font-size:12px">Check that items have the supplier field set correctly in inventory.</span></div>';
      _updateOrderCount();
      return;
    }

    const myWorker = _activeWorker();
    const stockHeader = myWorker === 'combined'
      ? 'Stock (D + J)'
      : _workerLabel(myWorker) + '\'s Stock';
    let html = '<div style="position:sticky;top:0;background:#fff;display:grid;grid-template-columns:90px 1fr 80px 80px 60px 90px;gap:10px;padding:10px 4px;border-bottom:2px solid #ccc;font-size:10px;font-weight:700;text-transform:uppercase;color:#666;letter-spacing:.5px;z-index:1">'
      + '<div>Code</div>'
      + '<div>Item</div>'
      + '<div>Unit Size</div>'
      + '<div style="text-align:center">' + stockHeader + '</div>'
      + '<div style="text-align:center">Alert</div>'
      + '<div style="text-align:center">Order Qty</div>'
      + '</div>';

    items.forEach(function(item) {
      const myStock  = _stockFor(item, myWorker);
      const alert    = item.alert || 0;
      const lowStock = _isLowStock(item, myWorker);
      const qty      = qtys[item.id] || '';
      const hasDesc  = item.name && item.name !== item.generic;
      const stockTitle = (myWorker === 'combined')
        ? 'Devarsh: ' + (item.stockDev || 0) + ' · Josh: ' + (item.stockJosh || 0) + ' · alert at ' + alert + ' per kit'
        : _workerLabel(myWorker) + ': ' + myStock + ' · alert at ' + alert;
      html += '<div style="display:grid;grid-template-columns:90px 1fr 80px 80px 60px 90px;gap:10px;padding:9px 4px;border-bottom:1px solid #eee;font-size:13px;align-items:center">'
        + '<div style="font-family:DM Mono,monospace;font-size:11px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (item.code || item.id) + '</div>'
        + '<div style="min-width:0">'
          + '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (item.generic || '—') + '</div>'
          + (hasDesc ? '<div style="font-size:11px;color:#999;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + item.name + '</div>' : '')
        + '</div>'
        + '<div style="font-size:11px;color:#666;font-family:DM Mono,monospace">' + (item.unitSize || '—') + '</div>'
        + '<div title="' + stockTitle + '" style="text-align:center;color:' + (lowStock ? '#dc2626' : '#333') + ';font-weight:' + (lowStock ? '700' : 'normal') + ';font-family:DM Mono,monospace">' + myStock + '</div>'
        + '<div style="text-align:center;color:#999;font-family:DM Mono,monospace">' + alert + '</div>'
        + '<div><input type="number" min="0" step="1" data-itemid="' + item.id + '" value="' + qty + '" placeholder="0" oninput="window._vomCountChange()" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #ccc;border-radius:4px;text-align:center;font-family:DM Mono,monospace;box-sizing:border-box"></div>'
      + '</div>';
    });

    container.innerHTML = html;
    _updateOrderCount();
  }

  // Live count of how many items currently have a qty > 0 in the visible
  // tab. Surfaced in the Generate button label so the user has feedback
  // before clicking.
  window._vomCountChange = function() {
    _updateOrderCount();
  };

  function _updateOrderCount() {
    let count = 0;
    document.querySelectorAll('#vom-items input[data-itemid]').forEach(function(input) {
      if(parseFloat(input.value) > 0) count++;
    });
    const btn = document.getElementById('vom-generate');
    if(btn) {
      btn.textContent = count > 0
        ? '📄 Generate PDF (' + count + ' item' + (count === 1 ? '' : 's') + ')'
        : '📄 Generate PDF';
      btn.disabled = (count === 0);
      btn.style.opacity = (count === 0) ? '0.5' : '1';
      btn.style.cursor  = (count === 0) ? 'not-allowed' : 'pointer';
    }
  }

  function _switchVendor(key) {
    _captureCurrentQtys();
    _activeVendor = key;
    VENDORS.forEach(function(v) {
      const tab = document.getElementById('vom-tab-' + v.key);
      if(tab) {
        const isActive = v.key === _activeVendor;
        tab.style.background = isActive ? '#1d3557' : 'transparent';
        tab.style.color      = isActive ? '#fff'    : '#1d3557';
      }
    });
    _renderItems();
  }

  window.openVendorOrderModal = function() {
    const old = document.getElementById('vendor-order-modal');
    if(old) old.remove();
    if(!window.items || !window.items.length) {
      alert('Inventory is empty or still loading.');
      return;
    }

    const modal = document.createElement('div');
    modal.id = 'vendor-order-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;font-family:inherit';

    let tabsHTML = '';
    VENDORS.forEach(function(v) {
      const isActive  = v.key === _activeVendor;
      const itemCount = _itemsForVendor(v.key).length;
      tabsHTML += '<button id="vom-tab-' + v.key + '" data-vendor="' + v.key + '" style="background:' + (isActive ? '#1d3557' : 'transparent') + ';color:' + (isActive ? '#fff' : '#1d3557') + ';border:1px solid #1d3557;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;display:inline-flex;align-items:center;gap:8px"><span>' + v.label + '</span><span style="font-size:10px;background:rgba(255,255,255,.2);' + (isActive ? '' : 'background:rgba(29,53,87,.1);') + 'padding:1px 7px;border-radius:10px">' + itemCount + '</span></button>';
    });

    modal.innerHTML =
      '<div style="background:#fff;border-radius:12px;width:100%;max-width:860px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden">'
        + '<div style="background:#1d3557;padding:16px 24px;display:flex;justify-content:space-between;align-items:center">'
          + '<div style="color:#fff;font-size:15px;font-weight:600">📋 Vendor Order Sheet</div>'
          + '<button id="vom-close" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;font-family:inherit">✕</button>'
        + '</div>'
        + '<div style="padding:14px 24px;background:#f5f4f0;display:flex;gap:8px;border-bottom:1px solid #ddd;flex-wrap:wrap">' + tabsHTML + '</div>'
        + '<div style="padding:8px 24px;background:#fafafa;border-bottom:1px solid #eee;font-size:11px;color:#666;font-style:italic">'
          + 'Showing <strong style="color:#1d3557">' + _workerLabel(_activeWorker()) + '</strong>\'s view (matches your inventory tab). Enter the quantity you want to order for each item. Leave blank or 0 to skip. Switch vendor tabs to fill out multiple at once — your numbers are remembered.'
        + '</div>'
        + '<div id="vom-items" style="flex:1;overflow-y:auto;padding:0 20px;background:#fff"></div>'
        + '<div style="padding:14px 24px;background:#f5f4f0;border-top:1px solid #ddd;display:flex;justify-content:space-between;align-items:center;gap:10px">'
          + '<button id="vom-cancel" style="background:transparent;border:1px solid #999;color:#666;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px;font-family:inherit">Cancel</button>'
          + '<button id="vom-generate" style="background:#1d3557;color:#fff;border:none;border-radius:6px;padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">📄 Generate PDF</button>'
        + '</div>'
      + '</div>';

    document.body.appendChild(modal);

    document.getElementById('vom-close').onclick  = function() { modal.remove(); };
    document.getElementById('vom-cancel').onclick = function() { modal.remove(); };
    modal.addEventListener('click', function(e) { if(e.target === modal) modal.remove(); });
    document.addEventListener('keydown', function escClose(e) {
      if(e.key === 'Escape' && document.getElementById('vendor-order-modal')) {
        modal.remove();
        document.removeEventListener('keydown', escClose);
      }
    });

    VENDORS.forEach(function(v) {
      const tab = document.getElementById('vom-tab-' + v.key);
      if(tab) tab.onclick = function() { _switchVendor(v.key); };
    });

    document.getElementById('vom-generate').onclick = function() {
      _captureCurrentQtys();
      const qtys = _orderQtys[_activeVendor] || {};
      const hasAny = Object.keys(qtys).some(function(id) { return qtys[id] > 0; });
      if(!hasAny) {
        alert('Please enter at least one order quantity before generating the PDF.');
        return;
      }
      _generateVendorPDF(_activeVendor);
    };

    _renderItems();
  };

  function _generateVendorPDF(vendorKey) {
    if(!window.jspdf || !window.jspdf.jsPDF) {
      alert('PDF library not loaded yet. Please refresh and try again.');
      return;
    }
    const vendor = VENDORS.find(function(v) { return v.key === vendorKey; });
    if(!vendor) return;
    const allItems     = _itemsForVendor(vendorKey);
    const qtys         = _orderQtys[vendorKey] || {};
    const itemsToOrder = allItems.filter(function(i) { return qtys[i.id] > 0; });
    if(!itemsToOrder.length) return;

    const { jsPDF } = window.jspdf;
    const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
    const W    = 215.9;
    const navy = [29, 53, 87];
    const gray = [107, 104, 96];
    const black= [26, 25, 22];
    const supplierBg = [232, 238, 245];

    // ── Header ────────────────────────────────────────────────────────────────
    doc.setFillColor.apply(doc, navy);
    doc.rect(0, 0, W, 32, 'F');

    // Logo (matches the existing inventory-order PDF style)
    doc.setFillColor(255, 255, 255);
    doc.circle(20, 16, 10, 'F');
    const logoEl = document.querySelector('img[style*="border-radius:50%"]');
    if(logoEl) {
      try { doc.addImage(logoEl.src, 'PNG', 11, 7, 18, 18); } catch(e) {}
    }

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('ATLAS ANESTHESIA', 36, 14);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text('Mobile Anesthesia Services', 36, 19);

    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('VENDOR ORDER SHEET', W - 14, 14, { align: 'right' });
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(vendor.label + ' · ' + _workerLabel(_activeWorker()) + '\'s Kit', W - 14, 19, { align: 'right' });
    doc.setFontSize(8);
    doc.text(
      'Generated: ' + new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }),
      W - 14, 24, { align: 'right' }
    );

    let y = 42;

    // ── Vendor banner ─────────────────────────────────────────────────────────
    doc.setFillColor.apply(doc, supplierBg);
    doc.rect(14, y, W - 28, 10, 'F');
    doc.setTextColor.apply(doc, navy);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(vendor.label.toUpperCase(), 18, y + 6.5);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(itemsToOrder.length + ' item' + (itemsToOrder.length === 1 ? '' : 's') + ' to order',
      W - 18, y + 6.5, { align: 'right' });
    y += 14;

    // ── Column headers ────────────────────────────────────────────────────────
    doc.setTextColor.apply(doc, gray);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.text('CODE',         18,  y);
    doc.text('ITEM',         48,  y);
    doc.text('UNIT SIZE',    128, y);
    doc.text('STOCK',        158, y, { align: 'center' });
    doc.text('ORDER QTY',    192, y, { align: 'center' });
    y += 2.5;
    doc.setDrawColor(180, 180, 180);
    doc.line(14, y, W - 14, y);
    y += 5;

    // ── Item rows ─────────────────────────────────────────────────────────────
    const myWorker = _activeWorker();
    let totalUnits = 0;
    itemsToOrder.forEach(function(item) {
      if(y > 263) { doc.addPage(); y = 20; }
      const myStock   = _stockFor(item, myWorker);
      const stockStr  = String(myStock);
      const orderQty  = qtys[item.id];
      const hasDesc   = item.name && item.name !== item.generic;
      totalUnits += orderQty;

      doc.setTextColor.apply(doc, black);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.text(_truncate(item.code || item.id, 14), 18, y);

      doc.setFont('helvetica', 'bold');
      doc.text(_truncate(item.generic, 32), 48, y);
      if(hasDesc) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor.apply(doc, gray);
        doc.text(_truncate(item.name, 50), 48, y + 3);
        doc.setFontSize(8.5);
        doc.setTextColor.apply(doc, black);
      }

      doc.setFont('helvetica', 'normal');
      doc.text(_truncate(item.unitSize || '—', 14), 128, y);
      doc.text(stockStr, 158, y, { align: 'center' });

      // Order qty highlighted — that's the whole point of this sheet
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor.apply(doc, navy);
      doc.text(String(orderQty), 192, y, { align: 'center' });
      doc.setFontSize(8.5);
      doc.setTextColor.apply(doc, black);

      y += hasDesc ? 7 : 5.5;
    });

    // ── Total row ─────────────────────────────────────────────────────────────
    y += 3;
    doc.setDrawColor(150, 150, 150);
    doc.line(14, y, W - 14, y);
    y += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, navy);
    doc.text('TOTAL UNITS TO ORDER', 48, y);
    doc.setFontSize(11);
    doc.text(String(totalUnits), 192, y, { align: 'center' });

    // ── Footer ────────────────────────────────────────────────────────────────
    const totalPages = doc.internal.getNumberOfPages();
    for(let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setTextColor.apply(doc, gray);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.text('Atlas Anesthesia · ' + vendor.label + ' Order Sheet · Page ' + p + ' of ' + totalPages,
        W/2, 282, { align: 'center' });
    }

    const dateStr  = new Date().toISOString().split('T')[0];
    const safeName = vendor.label.replace(/\s/g, '-');
    const safeWho  = _workerLabel(_activeWorker());
    doc.save('Atlas-Order-' + safeName + '-' + safeWho + '-' + dateStr + '.pdf');
  }

})();
