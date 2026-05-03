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
