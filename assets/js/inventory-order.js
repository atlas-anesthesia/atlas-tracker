// ─────────────────────────────────────────────────────────────────────────────
// inventory-order.js — Generate a printable PDF order sheet for items below
// the restock alert level. Groups by supplier (so each supplier's items can
// be torn off and sent / phoned in separately).
//
// Behavior:
//   • If the inventory tab is "Devarsh" or "Josh" → single-worker sheet
//   • If the inventory tab is "Combined" → both workers, each on its own page
//
// Depends on app.js for:
//   window.items           — inventory array
//   window.currentInvTab   — 'dev' | 'josh' | 'combined'
//   window.jspdf           — jsPDF library (loaded via CDN script tag)
// ─────────────────────────────────────────────────────────────────────────────

(function() {
  'use strict';

  const WORKER_LABEL = { dev: 'Devarsh', josh: 'Josh' };

  function getStock(item, w) {
    return w === 'dev' ? (item.stockDev || 0) : (item.stockJosh || 0);
  }

  function getLowItems(items, worker) {
    return (items || []).filter(i =>
      i &&
      typeof i.alert === 'number' &&
      getStock(i, worker) <= i.alert
    );
  }

  function groupBySupplier(items) {
    const groups = {};
    items.forEach(i => {
      const supplier = (i.supplier || '').trim() || '(No Supplier Listed)';
      if(!groups[supplier]) groups[supplier] = [];
      groups[supplier].push(i);
    });
    return groups;
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // Renders a single-worker section (header + supplier groups + items)
  function renderWorkerSection(doc, items, worker, startY) {
    const W = 215.9; // letter width in mm
    const navy = [29, 53, 87];
    const gray = [107, 104, 96];
    const black = [26, 25, 22];
    const supplierBg = [232, 238, 245];
    const critRed = [220, 38, 38];

    let y = startY;
    const wname = WORKER_LABEL[worker] || worker;
    const lowItems = getLowItems(items, worker);
    const supplierGroups = groupBySupplier(lowItems);

    // Worker section banner
    doc.setFillColor(...navy);
    doc.rect(14, y, W - 28, 11, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(`${wname.toUpperCase()}'S ORDER  —  ${lowItems.length} item${lowItems.length !== 1 ? 's' : ''} below alert level`, W/2, y + 7, { align: 'center' });
    y += 14;

    if(!lowItems.length) {
      doc.setTextColor(...gray);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'italic');
      doc.text(`✓ All ${wname} items above alert level. Nothing to restock.`, 18, y);
      return y + 8;
    }

    const sortedSuppliers = Object.keys(supplierGroups).sort();
    sortedSuppliers.forEach(supplier => {
      const supplierItems = supplierGroups[supplier].sort((a, b) =>
        (a.generic || '').localeCompare(b.generic || '')
      );

      // Page break if supplier header would land too low
      if(y > 250) { doc.addPage(); y = 20; }

      // Supplier header
      doc.setFillColor(...supplierBg);
      doc.rect(14, y, W - 28, 8, 'F');
      doc.setTextColor(...navy);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(supplier, 18, y + 5.5);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(`${supplierItems.length} item${supplierItems.length !== 1 ? 's' : ''}`, W - 18, y + 5.5, { align: 'right' });
      y += 11;

      // Column headers
      doc.setTextColor(...gray);
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'bold');
      doc.text('CODE',         18,  y);
      doc.text('ITEM',         48,  y);
      doc.text('UNIT SIZE',    128, y);
      doc.text('STOCK',        158, y, { align: 'center' });
      doc.text('ALERT',        173, y, { align: 'center' });
      doc.text('ORDER QTY',    192, y, { align: 'center' });
      y += 2.5;
      doc.setDrawColor(200, 200, 200);
      doc.line(14, y, W - 14, y);
      y += 4;

      // Item rows
      supplierItems.forEach(item => {
        if(y > 263) { doc.addPage(); y = 20; }
        const stock = getStock(item, worker);
        const isCritical = stock === 0;
        const hasDescription = item.name && item.name !== item.generic;

        // CODE
        doc.setTextColor(...black);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.text(truncate(item.code || item.id, 14), 18, y);

        // ITEM (generic + smaller description below)
        doc.setFont('helvetica', 'bold');
        doc.text(truncate(item.generic, 32), 48, y);
        if(hasDescription) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(...gray);
          doc.text(truncate(item.name, 50), 48, y + 3);
          doc.setFontSize(8.5);
          doc.setTextColor(...black);
        }

        // UNIT SIZE
        doc.setFont('helvetica', 'normal');
        doc.text(truncate(item.unitSize || '—', 14), 128, y);

        // STOCK (red+bold if zero)
        if(isCritical) {
          doc.setTextColor(...critRed);
          doc.setFont('helvetica', 'bold');
        }
        doc.text(String(stock), 158, y, { align: 'center' });
        doc.setTextColor(...black);
        doc.setFont('helvetica', 'normal');

        // ALERT
        doc.text(String(item.alert), 173, y, { align: 'center' });

        // ORDER QTY box (blank for handwriting)
        doc.setDrawColor(180, 180, 180);
        doc.rect(184, y - 4, 16, 5.5);

        y += hasDescription ? 7 : 5.5;
      });
      y += 4;
    });

    return y;
  }

  window.generateInventoryOrderPDF = function() {
    if(!window.jspdf || !window.jspdf.jsPDF) {
      alert('PDF library not loaded yet. Please refresh the page and try again.');
      return;
    }
    const items = window.items || [];
    if(!items.length) {
      alert('Inventory is empty or still loading.');
      return;
    }
    const tab = window.currentInvTab || 'dev';
    const workersToInclude = tab === 'combined' ? ['dev', 'josh'] : [tab];

    // Sanity check: anything to actually order?
    const totalLow = workersToInclude.reduce((sum, w) => sum + getLowItems(items, w).length, 0);
    if(!totalLow) {
      alert('🎉 No items below alert level — nothing needs restocking right now!');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
    const W = 215.9;
    const navy = [29, 53, 87];
    const white = [255, 255, 255];
    const gray = [107, 104, 96];

    // ── HEADER ────────────────────────────────────────────────────────────────
    doc.setFillColor(...navy);
    doc.rect(0, 0, W, 32, 'F');

    // Logo (white circle with logo image if available)
    doc.setFillColor(255, 255, 255);
    doc.circle(20, 16, 10, 'F');
    const logoEl = document.querySelector('img[style*="border-radius:50%"]');
    if(logoEl) {
      try { doc.addImage(logoEl.src, 'PNG', 11, 7, 18, 18); } catch(e) {}
    }

    doc.setTextColor(...white);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('ATLAS ANESTHESIA', 36, 14);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text('Mobile Anesthesia Services', 36, 19);

    // Right side
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('INVENTORY ORDER SHEET', W - 14, 14, { align: 'right' });
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    const scopeText = tab === 'combined'
      ? 'Combined — Devarsh & Josh'
      : `${WORKER_LABEL[tab] || tab}'s Inventory`;
    doc.text(scopeText, W - 14, 19, { align: 'right' });
    doc.text(
      `Generated: ${new Date().toLocaleDateString('en-US', {year:'numeric', month:'long', day:'numeric'})}`,
      W - 14, 24, { align: 'right' }
    );

    let y = 42;

    // ── SUMMARY BANNER ────────────────────────────────────────────────────────
    const summary = workersToInclude.map(w => {
      const low = getLowItems(items, w);
      return { worker: w, count: low.length };
    });

    const banH = 8 + summary.length * 4.5;
    doc.setFillColor(245, 244, 240);
    doc.roundedRect(14, y, W - 28, banH, 1.5, 1.5, 'F');
    doc.setTextColor(...navy);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Summary', W/2, y + 6, { align: 'center' });
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    summary.forEach((s, idx) => {
      const wname = WORKER_LABEL[s.worker] || s.worker;
      const line = `${wname}: ${s.count} item${s.count !== 1 ? 's' : ''} below alert level`;
      doc.text(line, W/2, y + 11 + (idx * 4.5), { align: 'center' });
    });
    y += banH + 5;

    // ── INSTRUCTIONS BLURB ────────────────────────────────────────────────────
    doc.setTextColor(...gray);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'italic');
    doc.text(
      'Items are grouped by supplier. Fill in the Order Qty box for each item you want to order, then send / call in by supplier.',
      W/2, y, { align: 'center' }
    );
    y += 6;

    // ── WORKER SECTIONS ───────────────────────────────────────────────────────
    workersToInclude.forEach((worker, idx) => {
      if(idx > 0) { doc.addPage(); y = 20; }
      y = renderWorkerSection(doc, items, worker, y);
      y += 5;
    });

    // ── FOOTER ON EVERY PAGE ──────────────────────────────────────────────────
    const totalPages = doc.internal.getNumberOfPages();
    for(let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setTextColor(...gray);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.text(`Atlas Anesthesia · Inventory Order Sheet · Page ${p} of ${totalPages}`, W/2, 282, { align: 'center' });
    }

    // ── SAVE ──────────────────────────────────────────────────────────────────
    const dateStr = new Date().toISOString().split('T')[0];
    const scopeStr = tab === 'combined' ? 'Combined' : (WORKER_LABEL[tab] || tab);
    doc.save(`Atlas-Order-Sheet-${scopeStr}-${dateStr}.pdf`);
  };

})();


// ─────────────────────────────────────────────────────────────────────────────
// VENDOR ORDER MODAL — interactive per-vendor order sheet builder.
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
// Exposed:  window.openVendorOrderModal()
// Auto-injects a "📋 Vendor Order" button next to "Order Sheet PDF" in the
// inventory tab when the DOM is ready.
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

  function _itemsForVendor(vendorKey) {
    const vendor = VENDORS.find(function(v) { return v.key === vendorKey; });
    if(!vendor) return [];
    return (window.items || [])
      .filter(function(i) { return i && _itemMatchesVendor(i, vendor); })
      .sort(function(a, b) { return (a.generic || '').localeCompare(b.generic || ''); });
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

    let html = '<div style="position:sticky;top:0;background:#fff;display:grid;grid-template-columns:90px 1fr 80px 60px 60px 90px;gap:10px;padding:10px 4px;border-bottom:2px solid #ccc;font-size:10px;font-weight:700;text-transform:uppercase;color:#666;letter-spacing:.5px;z-index:1">'
      + '<div>Code</div>'
      + '<div>Item</div>'
      + '<div>Unit Size</div>'
      + '<div style="text-align:center">Stock</div>'
      + '<div style="text-align:center">Alert</div>'
      + '<div style="text-align:center">Order Qty</div>'
      + '</div>';

    items.forEach(function(item) {
      const stock     = (item.stockDev || 0) + (item.stockJosh || 0);
      const lowStock  = stock <= (item.alert || 0);
      const qty       = qtys[item.id] || '';
      const hasDesc   = item.name && item.name !== item.generic;
      html += '<div style="display:grid;grid-template-columns:90px 1fr 80px 60px 60px 90px;gap:10px;padding:9px 4px;border-bottom:1px solid #eee;font-size:13px;align-items:center">'
        + '<div style="font-family:DM Mono,monospace;font-size:11px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (item.code || item.id) + '</div>'
        + '<div style="min-width:0">'
          + '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (item.generic || '—') + '</div>'
          + (hasDesc ? '<div style="font-size:11px;color:#999;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + item.name + '</div>' : '')
        + '</div>'
        + '<div style="font-size:11px;color:#666;font-family:DM Mono,monospace">' + (item.unitSize || '—') + '</div>'
        + '<div style="text-align:center;color:' + (lowStock ? '#dc2626' : '#333') + ';font-weight:' + (lowStock ? '700' : 'normal') + ';font-family:DM Mono,monospace">' + stock + '</div>'
        + '<div style="text-align:center;color:#999;font-family:DM Mono,monospace">' + (item.alert || 0) + '</div>'
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
          + 'Enter the quantity you want to order for each item. Leave blank or 0 to skip. Switch vendor tabs to fill out multiple at once — your numbers are remembered.'
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
    doc.text(vendor.label, W - 14, 19, { align: 'right' });
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
    let totalUnits = 0;
    itemsToOrder.forEach(function(item) {
      if(y > 263) { doc.addPage(); y = 20; }
      const stock     = (item.stockDev || 0) + (item.stockJosh || 0);
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
      doc.text(String(stock), 158, y, { align: 'center' });

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
    doc.save('Atlas-Order-' + safeName + '-' + dateStr + '.pdf');
  }

  // ── Auto-inject "Vendor Order" button next to "Order Sheet PDF" ─────────────
  function _injectVendorOrderButton() {
    if(document.getElementById('vom-trigger-btn')) return; // already injected
    const buttons = Array.from(document.querySelectorAll('button'));
    const orderBtn = buttons.find(function(b) {
      const txt = (b.textContent || '').trim();
      return /Order\s*Sheet\s*PDF/i.test(txt);
    });
    if(!orderBtn) return;
    const newBtn = document.createElement('button');
    newBtn.id = 'vom-trigger-btn';
    newBtn.className   = orderBtn.className;
    newBtn.style.cssText = orderBtn.style.cssText;
    newBtn.textContent = '📋 Vendor Order';
    newBtn.onclick = function() { window.openVendorOrderModal(); };
    orderBtn.parentNode.insertBefore(newBtn, orderBtn.nextSibling);
  }

  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _injectVendorOrderButton);
  } else {
    _injectVendorOrderButton();
  }
  // Re-check periodically — the inventory tab buttons may render after this
  // script loads (for example when user switches tabs the first time).
  setInterval(_injectVendorOrderButton, 1500);

})();
