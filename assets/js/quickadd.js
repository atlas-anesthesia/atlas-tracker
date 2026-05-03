// ─────────────────────────────────────────────────────────────────────────────
// quickadd.js — Quick Add modals + Bundles for Finalize Case
//
// Adds two modals that let the user fill in many supplies / CS entries at once
// instead of select-then-add-then-edit-qty for each item.
//
//   • 📦 Quick Add Supplies — full grouped inventory grid with qty inputs.
//                              Bundles bar at top for one-click presets.
//   • 📋 Quick Add CS       — all controlled substances on one screen.
//
// Bundles are saved in Firestore under atlas/bundles and shared across users.
//
// Depends on app.js for:
//   window.db, window.doc, window.setDoc, window.getDoc, window.onSnapshot
//   window.uid, window.setSyncing, window.currentWorker
//   window.items (inventory), window.caseItems, window.csEntries
//   window.getStock, window.isCSItem, window.linkCSInvIds
//   window.CS_DRUGS, window.getCostPerMG
//   window.renderCaseSupplies, window.renderCSEntries, window.refreshItemSelect
// ─────────────────────────────────────────────────────────────────────────────

(function() {
  'use strict';

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  // ── BUNDLES STATE & FIRESTORE SYNC ──────────────────────────────────────────
  let bundles = [];
  let _bundleListenerStarted = false;

  function initBundles(retries) {
    retries = retries || 0;
    if(_bundleListenerStarted) return;
    if(retries > 50) { console.warn('quickadd: gave up waiting for window.db'); return; }
    if(!window.db || !window.onSnapshot || !window.doc) {
      setTimeout(() => initBundles(retries + 1), 100);
      return;
    }
    _bundleListenerStarted = true;
    try {
      window.onSnapshot(window.doc(window.db, 'atlas', 'bundles'), (snap) => {
        const raw = snap.exists() ? (snap.data().bundles || []) : [];
        bundles = raw.map(normalizeBundle).filter(Boolean);
        const modal = document.getElementById('suppliesQuickAddModal');
        if(modal && modal.style.display === 'flex') renderBundlesBar();
        // If an active bundle was deleted on another tab, deactivate locally
        if(_activeBundleId && !bundles.find(b => b.id === _activeBundleId)) {
          _activeBundleId = null;
          if(modal && modal.style.display === 'flex') renderSuppliesQuickAddModal();
        }
        // If the bundle manager is open, refresh its list
        const mgr = document.getElementById('bundleManagerModal');
        if(mgr && mgr.style.display === 'flex' &&
           document.getElementById('bundleManagerListView')?.style.display !== 'none') {
          renderBundleManagerList();
        }
      });
    } catch(e) { console.warn('quickadd: bundles init failed:', e); }
  }
  initBundles();

  async function saveBundles() {
    if(!window.db || !window.setDoc || !window.doc) {
      alert('Storage not ready — please refresh the page.');
      return false;
    }
    try {
      window.setSyncing && window.setSyncing(true);
      await window.setDoc(window.doc(window.db, 'atlas', 'bundles'), { bundles });
      window.setSyncing && window.setSyncing(false);
      return true;
    } catch(e) {
      window.setSyncing && window.setSyncing(false);
      console.error('quickadd: saveBundles error:', e);
      alert('Could not save bundle: ' + e.message);
      return false;
    }
  }

  // ── BUNDLES UI ──────────────────────────────────────────────────────────────
  // A bundle is a saved list of item IDs. Selecting one in the supplies modal
  // pins those items at the top of the list — quantities are still entered per
  // case in the modal. Manage / create / edit happens in a dedicated modal.

  let _activeBundleId = null;       // the bundle whose items are currently pinned (or null)
  let _editingBundleId = null;      // bundle being edited in manager modal (null = creating new)
  let _editCheckedIds = null;       // Set<itemId> for the in-progress edit form

  // Migrate old-format bundles ({items:[{itemId,qty}], itemsOnly}) to {itemIds:[]}
  function normalizeBundle(b) {
    if(!b || typeof b !== 'object') return null;
    if(Array.isArray(b.itemIds)) return b;
    if(Array.isArray(b.items)) {
      const itemIds = b.items
        .map(i => typeof i === 'string' ? i : (i && i.itemId))
        .filter(Boolean);
      const cleaned = { ...b, itemIds };
      delete cleaned.items;
      delete cleaned.itemsOnly;
      return cleaned;
    }
    return { ...b, itemIds: [] };
  }

  function getBundleById(id) { return bundles.find(b => b.id === id); }
  function getActiveBundle() { return _activeBundleId ? getBundleById(_activeBundleId) : null; }

  function renderBundlesBar() {
    const bar = document.getElementById('quickAddBundlesBar');
    if(!bar) return;
    let html = '';
    if(!bundles.length) {
      html = '<div style="font-size:12px;color:var(--text-faint);font-style:italic;padding:4px 0;flex:1">No bundles yet — click "Manage Bundles" to create one.</div>';
    } else {
      bundles.forEach(b => {
        const itemCount = (b.itemIds || []).length;
        const isActive = b.id === _activeBundleId;
        const bg = isActive ? 'var(--info)' : 'var(--info-light)';
        const fg = isActive ? '#fff' : 'var(--info)';
        html += `<button onclick="window.qa_toggleBundleActive('${b.id}')" title="${isActive ? 'Selected — click to deselect' : 'Click to pin these items at the top'}" style="display:inline-flex;align-items:center;gap:6px;background:${bg};border:1px solid var(--info);color:${fg};border-radius:20px;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">
          ${isActive ? '<span style="font-size:11px;line-height:1">✓</span>' : ''}
          <span>${escapeHtml(b.name)}</span>
          <span style="font-size:10px;opacity:.75;font-weight:500">(${itemCount})</span>
        </button>`;
      });
    }
    html += `<button onclick="window.qa_openBundleManager()" class="btn btn-ghost btn-sm" title="Create, edit, or delete bundles" style="font-size:11px;padding:4px 10px;margin-left:auto">✏ Manage Bundles</button>`;
    bar.innerHTML = html;
  }

  // Capture qty values typed into supplies-modal inputs back into _qaInitial
  // so re-renders (e.g., toggling a bundle pin) preserve user input.
  function captureCurrentInputs() {
    if(!window._qaInitial) window._qaInitial = {};
    document.querySelectorAll('#suppliesQuickAddModal .qa-qty-input').forEach(input => {
      const id = input.dataset.itemId;
      if(!id) return;
      const v = parseFloat(input.value);
      if(v > 0) window._qaInitial[id] = v;
      else delete window._qaInitial[id];
    });
  }

  window.qa_toggleBundleActive = function(bundleId) {
    captureCurrentInputs();
    _activeBundleId = (_activeBundleId === bundleId) ? null : bundleId;
    renderSuppliesQuickAddModal();
  };

  // ── BUNDLE MANAGER MODAL ────────────────────────────────────────────────────
  window.qa_openBundleManager = function() {
    const modal = document.getElementById('bundleManagerModal');
    if(!modal) return;
    if(!window.items || !window.items.length) {
      alert('Inventory is still loading. Try again in a moment.');
      return;
    }
    modal.style.display = 'flex';
    qa_showBundleList();
  };

  window.qa_closeBundleManager = function() {
    const modal = document.getElementById('bundleManagerModal');
    if(modal) modal.style.display = 'none';
    _editingBundleId = null;
    _editCheckedIds = null;
  };

  function qa_showBundleList() {
    const lv = document.getElementById('bundleManagerListView');
    const ev = document.getElementById('bundleManagerEditView');
    const lf = document.getElementById('bundleManagerListFooter');
    if(lv) lv.style.display = 'block';
    if(ev) ev.style.display = 'none';
    if(lf) lf.style.display = 'flex';
    renderBundleManagerList();
  }

  function renderBundleManagerList() {
    const container = document.getElementById('bundleManagerList');
    if(!container) return;
    if(!bundles.length) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-faint);padding:24px;font-size:13px;font-style:italic">No bundles yet. Click "+ Create New Bundle" below to make your first one.</div>';
      return;
    }
    container.innerHTML = bundles.map(b => {
      const count = (b.itemIds || []).length;
      return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:8px;gap:10px">
        <div style="min-width:0;flex:1">
          <div style="font-size:14px;font-weight:600">${escapeHtml(b.name)}</div>
          <div style="font-size:11px;color:var(--text-faint)">${count} item${count !== 1 ? 's' : ''}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button onclick="window.qa_editBundle('${b.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--info);border-color:var(--info)">✏ Edit</button>
          <button onclick="window.qa_deleteBundleFromManager('${b.id}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn);border-color:var(--warn)">🗑 Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  window.qa_startNewBundle = function() {
    _editingBundleId = null;
    _editCheckedIds = new Set();
    const titleEl = document.getElementById('bundleEditTitle');
    if(titleEl) titleEl.textContent = '+ Create New Bundle';
    const nameEl = document.getElementById('bundleEditName');
    if(nameEl) nameEl.value = '';
    const searchEl = document.getElementById('bundleEditSearch');
    if(searchEl) searchEl.value = '';
    document.getElementById('bundleManagerListView').style.display = 'none';
    document.getElementById('bundleManagerEditView').style.display = 'flex';
    const lf = document.getElementById('bundleManagerListFooter');
    if(lf) lf.style.display = 'none';
    renderBundleEditItems();
    setTimeout(() => nameEl?.focus(), 50);
  };

  window.qa_editBundle = function(bundleId) {
    const b = getBundleById(bundleId);
    if(!b) return;
    _editingBundleId = bundleId;
    _editCheckedIds = new Set(b.itemIds || []);
    const titleEl = document.getElementById('bundleEditTitle');
    if(titleEl) titleEl.textContent = `✏ Edit: ${b.name}`;
    document.getElementById('bundleEditName').value = b.name;
    document.getElementById('bundleEditSearch').value = '';
    document.getElementById('bundleManagerListView').style.display = 'none';
    document.getElementById('bundleManagerEditView').style.display = 'flex';
    const lf = document.getElementById('bundleManagerListFooter');
    if(lf) lf.style.display = 'none';
    renderBundleEditItems();
  };

  window.qa_cancelBundleEdit = function() {
    _editingBundleId = null;
    _editCheckedIds = null;
    qa_showBundleList();
  };

  window.renderBundleEditItems = function() {
    const container = document.getElementById('bundleEditItems');
    if(!container) return;
    const allItems = window.items || [];
    if(typeof window.linkCSInvIds === 'function') window.linkCSInvIds();
    const isCS = window.isCSItem || (() => false);
    const filterText = (document.getElementById('bundleEditSearch')?.value || '').toLowerCase().trim();
    let validItems = allItems.filter(i => i && !isCS(i));
    if(filterText) {
      validItems = validItems.filter(i =>
        ((i.generic||'') + ' ' + (i.name||'') + ' ' + (i.code||'') + ' ' + (i.category||''))
          .toLowerCase().includes(filterText)
      );
    }
    const byCategory = {};
    validItems.forEach(item => {
      const cat = item.category || 'Other';
      if(!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    });
    const sortedCats = Object.keys(byCategory).sort();
    const checkedIds = _editCheckedIds || new Set();
    let html = '';
    if(!sortedCats.length) {
      html = '<div style="text-align:center;color:var(--text-faint);padding:20px;font-size:13px">No matching items.</div>';
    } else {
      sortedCats.forEach(cat => {
        html += `<div style="margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--info);padding:5px 0;border-bottom:1px solid var(--border)">${escapeHtml(cat)}</div>`;
        byCategory[cat]
          .sort((a,b) => (a.generic||'').localeCompare(b.generic||''))
          .forEach(item => {
            const checked = checkedIds.has(item.id);
            html += `<label style="display:flex;align-items:center;gap:10px;padding:7px 4px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--surface2)">
              <input type="checkbox" ${checked?'checked':''} onchange="window.qa_toggleBundleEditItem('${escapeHtml(item.id)}', this.checked)" style="width:16px;height:16px;flex-shrink:0;cursor:pointer">
              <div style="flex:1;min-width:0">
                <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.generic||item.name||'?')}</div>
                <div style="font-size:11px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.name||'')}</div>
              </div>
            </label>`;
          });
        html += `</div>`;
      });
    }
    container.innerHTML = html;
    updateBundleEditCount();
  };

  window.qa_toggleBundleEditItem = function(itemId, checked) {
    if(!_editCheckedIds) _editCheckedIds = new Set();
    if(checked) _editCheckedIds.add(itemId);
    else _editCheckedIds.delete(itemId);
    updateBundleEditCount();
  };

  function updateBundleEditCount() {
    const el = document.getElementById('bundleEditCount');
    if(el) {
      const n = _editCheckedIds ? _editCheckedIds.size : 0;
      el.textContent = `${n} item${n !== 1 ? 's' : ''} selected`;
    }
  }

  window.qa_saveBundleFromManager = async function() {
    const nameInput = document.getElementById('bundleEditName');
    const name = (nameInput?.value || '').trim();
    if(!name) {
      alert('Please enter a bundle name.');
      nameInput?.focus();
      return;
    }
    const itemIds = [...(_editCheckedIds || [])];
    if(!itemIds.length) {
      alert('Please check at least one item to include in the bundle.');
      return;
    }
    if(_editingBundleId) {
      const b = getBundleById(_editingBundleId);
      if(b) {
        b.name = name;
        b.itemIds = itemIds;
        b.savedAt = new Date().toISOString();
      }
    } else {
      bundles.push({
        id: window.uid ? window.uid() : (Date.now().toString(36)),
        name,
        itemIds,
        createdAt: new Date().toISOString(),
        savedAt: new Date().toISOString()
      });
    }
    if(await saveBundles()) {
      _editingBundleId = null;
      _editCheckedIds = null;
      qa_showBundleList();
      renderBundlesBar();
    }
  };

  window.qa_deleteBundleFromManager = async function(bundleId) {
    const b = getBundleById(bundleId);
    if(!b) return;
    if(!confirm(`Delete bundle "${b.name}"? This cannot be undone.`)) return;
    bundles = bundles.filter(x => x.id !== bundleId);
    if(_activeBundleId === bundleId) _activeBundleId = null;
    if(await saveBundles()) {
      renderBundleManagerList();
      renderBundlesBar();
    }
  };

  // ── QUICK ADD SUPPLIES MODAL ────────────────────────────────────────────────
  window.openSuppliesQuickAddModal = function() {
    const modal = document.getElementById('suppliesQuickAddModal');
    if(!modal) return;
    if(!window.items || !window.items.length) {
      alert('Inventory is still loading. Try again in a moment.');
      return;
    }
    modal.style.display = 'flex';
    // Pre-fill modal from any existing caseItems already in the form
    window._qaInitial = {};
    (window.caseItems || []).forEach(ci => { window._qaInitial[ci.id] = ci.qty; });
    renderSuppliesQuickAddModal();
    setTimeout(() => document.getElementById('quickAddSearch')?.focus(), 50);
  };

  window.closeSuppliesQuickAddModal = function() {
    const modal = document.getElementById('suppliesQuickAddModal');
    if(modal) modal.style.display = 'none';
  };

  window.renderSuppliesQuickAddModal = function() {
    const body = document.getElementById('quickAddBody');
    if(!body) return;
    const allItems = window.items || [];
    if(typeof window.linkCSInvIds === 'function') window.linkCSInvIds();
    const filterText = (document.getElementById('quickAddSearch')?.value || '').toLowerCase().trim();
    const isCS = window.isCSItem || (() => false);
    let validItems = allItems.filter(i => i && !isCS(i));
    if(filterText) {
      validItems = validItems.filter(i =>
        ((i.generic||'') + ' ' + (i.name||'') + ' ' + (i.code||'') + ' ' + (i.category||''))
          .toLowerCase().includes(filterText)
      );
    }
    const worker = window.currentWorker || 'dev';
    const getStock = window.getStock || (() => 0);

    // If a bundle is active, split items into pinned vs. remaining
    const activeBundle = getActiveBundle();
    const pinnedIds = activeBundle ? new Set(activeBundle.itemIds || []) : null;
    const pinnedItems = activeBundle
      ? (activeBundle.itemIds || [])
          .map(id => validItems.find(i => i.id === id))
          .filter(Boolean)
      : [];
    const remainingItems = pinnedIds
      ? validItems.filter(i => !pinnedIds.has(i.id))
      : validItems;

    // Group remaining items by category
    const byCategory = {};
    remainingItems.forEach(item => {
      const cat = item.category || 'Other';
      if(!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    });
    const sortedCats = Object.keys(byCategory).sort();

    function renderItemRow(item) {
      const stock = getStock(item, worker);
      const initialQty = (window._qaInitial && window._qaInitial[item.id]) || 0;
      const lowStock = stock <= (item.alert || 0);
      const cost = item.costPerUnit || 0;
      return `<div style="display:grid;grid-template-columns:1fr 70px 50px 80px;gap:10px;align-items:center;padding:8px 4px;border-bottom:1px solid var(--surface2);font-size:13px">
        <div style="min-width:0">
          <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.generic||item.name||'?')}</div>
          <div style="font-size:11px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.name||'')}</div>
        </div>
        <div style="font-family:'DM Mono',monospace;color:var(--text-muted);font-size:12px;text-align:right">$${cost.toFixed(2)}</div>
        <div style="text-align:center"><span class="stock-badge ${lowStock?'stock-low':'stock-ok'}" style="font-size:10px">${stock}</span></div>
        <input type="number" min="0" step="0.5" value="${initialQty || ''}" placeholder="0"
          data-item-id="${escapeHtml(item.id)}" class="qa-qty-input"
          oninput="window.qa_updateTotal()"
          style="width:100%;padding:6px 8px;text-align:center;font-size:14px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg)">
      </div>`;
    }

    let html = '';

    // 1. Pinned bundle section (if a bundle is active)
    if(activeBundle) {
      if(pinnedItems.length) {
        html += `<div style="margin-bottom:18px;background:var(--info-light);border:1px solid var(--info);border-radius:var(--radius-sm);padding:10px 12px">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--info);padding:0 0 8px 0;border-bottom:1px solid rgba(29,53,87,.2);margin-bottom:6px">
            <span>📌 ${escapeHtml(activeBundle.name)}</span>
            <span style="font-size:10px;font-weight:500;text-transform:none;letter-spacing:0;opacity:.75">${pinnedItems.length} pinned · enter quantities below</span>
          </div>`;
        pinnedItems.forEach(item => { html += renderItemRow(item); });
        html += `</div>`;
      } else {
        html += `<div style="margin-bottom:14px;background:var(--info-light);border:1px solid var(--info);border-radius:var(--radius-sm);padding:14px;font-size:13px;color:var(--info)">
          📌 <strong>${escapeHtml(activeBundle.name)}</strong> is selected, but its items don't match your current search.
        </div>`;
      }
    }

    // 2. Remaining items grouped by category
    if(!sortedCats.length && !pinnedItems.length) {
      html += '<div style="text-align:center;color:var(--text-faint);padding:30px;font-size:14px">No matching items.</div>';
    } else {
      sortedCats.forEach(cat => {
        html += `<div style="margin-bottom:14px">
          <div style="position:sticky;top:0;background:var(--surface);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--info);padding:6px 0;border-bottom:1px solid var(--border);z-index:1">${escapeHtml(cat)}</div>`;
        byCategory[cat]
          .sort((a,b) => (a.generic||'').localeCompare(b.generic||''))
          .forEach(item => { html += renderItemRow(item); });
        html += `</div>`;
      });
    }
    body.innerHTML = html;
    renderBundlesBar();
    updateQuickAddTotal();
  };

  function readQuickAddItemQuantities() {
    const result = [];
    document.querySelectorAll('#suppliesQuickAddModal .qa-qty-input').forEach(input => {
      const itemId = input.dataset.itemId;
      const qty = parseFloat(input.value) || 0;
      if(qty > 0 && itemId) result.push({ itemId, qty });
    });
    return result;
  }

  window.qa_updateTotal = updateQuickAddTotal;
  function updateQuickAddTotal() {
    const allItems = window.items || [];
    let total = 0, count = 0;
    document.querySelectorAll('#suppliesQuickAddModal .qa-qty-input').forEach(input => {
      const qty = parseFloat(input.value) || 0;
      if(qty > 0) {
        const item = allItems.find(i => i.id === input.dataset.itemId);
        if(item) {
          total += (item.costPerUnit || 0) * qty;
          count++;
        }
      }
    });
    const totalEl = document.getElementById('quickAddTotal');
    const countEl = document.getElementById('quickAddCount');
    if(totalEl) totalEl.textContent = '$' + total.toFixed(2);
    if(countEl) countEl.textContent = count + ' item' + (count !== 1 ? 's' : '');
  }

  window.qa_clearAll = function() {
    if(!confirm('Clear all quantities in this modal? (Does not affect saved case until you click Apply.)')) return;
    document.querySelectorAll('#suppliesQuickAddModal .qa-qty-input').forEach(input => { input.value = ''; });
    updateQuickAddTotal();
  };

  window.applyQuickAddSupplies = function() {
    const selected = readQuickAddItemQuantities();
    const allItems = window.items || [];
    const worker = window.currentWorker || 'dev';
    const getStock = window.getStock || (() => 0);
    if(!selected.length) {
      if(!confirm('No quantities are set. Apply anyway? This will clear any supplies already on the case.')) return;
    }
    const newCaseItems = selected.map(({itemId, qty}) => {
      const inv = allItems.find(i => i.id === itemId);
      if(!inv) return null;
      return {
        id: inv.id,
        generic: inv.generic,
        name: inv.name,
        cost: inv.costPerUnit || 0,
        qty,
        stock: getStock(inv, worker)
      };
    }).filter(Boolean);
    window.caseItems = newCaseItems;
    window.closeSuppliesQuickAddModal();
    if(typeof window.renderCaseSupplies === 'function') window.renderCaseSupplies();
    if(typeof window.refreshItemSelect === 'function') window.refreshItemSelect();
  };

  // ── QUICK ADD CONTROLLED SUBSTANCES MODAL ───────────────────────────────────
  // Temp store for signatures captured DURING the QA modal session, before Apply.
  // Keyed by drug: { ephedrine: { witness: 'data:...', provider: 'data:...' }, ... }
  let _qaSigs = {};
  // Active sig-target while a canvas signature modal is open from inside the QA modal.
  // null when canvas modal was opened from a real csEntries row instead.
  let _qaSigTarget = null; // { drug: 'ephedrine', kind: 'witness' | 'provider' }

  // Wrap the existing save handlers so that signatures drawn while the QA modal is open
  // are routed into _qaSigs instead of (or in addition to) csEntries.
  // The wrappers must be installed AFTER app.js has set them on window — we install on first use.
  let _wrappersInstalled = false;
  function installSigWrappersOnce() {
    if(_wrappersInstalled) return;
    if(typeof window.saveWitnessSignature !== 'function' || typeof window.saveCSProviderSig !== 'function') return;
    _wrappersInstalled = true;

    const _origSaveWitness = window.saveWitnessSignature;
    window.saveWitnessSignature = function() {
      if(_qaSigTarget && _qaSigTarget.kind === 'witness') {
        const canvas = document.getElementById('witnessCanvas');
        if(canvas) {
          const sigData = canvas.toDataURL('image/png');
          const drug = _qaSigTarget.drug;
          if(!_qaSigs[drug]) _qaSigs[drug] = {};
          _qaSigs[drug].witness = sigData;
        }
        _qaSigTarget = null;
        if(typeof window.closeWitnessModal === 'function') window.closeWitnessModal();
        // Re-render the QA modal so the new sig thumbnail appears
        rerenderCSQuickAddPreservingInputs();
        return;
      }
      return _origSaveWitness.apply(this, arguments);
    };

    const _origSaveProvider = window.saveCSProviderSig;
    window.saveCSProviderSig = function() {
      if(_qaSigTarget && _qaSigTarget.kind === 'provider') {
        const canvas = document.getElementById('csProviderCanvas');
        if(canvas) {
          const sigData = canvas.toDataURL('image/png');
          const drug = _qaSigTarget.drug;
          if(!_qaSigs[drug]) _qaSigs[drug] = {};
          _qaSigs[drug].provider = sigData;
        }
        _qaSigTarget = null;
        if(typeof window.closeCSProviderModal === 'function') window.closeCSProviderModal();
        rerenderCSQuickAddPreservingInputs();
        return;
      }
      return _origSaveProvider.apply(this, arguments);
    };

    // If user closes the canvas modal without signing while in QA mode, clear the target.
    const _origCloseWitness = window.closeWitnessModal;
    window.closeWitnessModal = function() {
      if(_qaSigTarget && _qaSigTarget.kind === 'witness') _qaSigTarget = null;
      if(_origCloseWitness) return _origCloseWitness.apply(this, arguments);
    };
    const _origCloseProvider = window.closeCSProviderModal;
    window.closeCSProviderModal = function() {
      if(_qaSigTarget && _qaSigTarget.kind === 'provider') _qaSigTarget = null;
      if(_origCloseProvider) return _origCloseProvider.apply(this, arguments);
    };
  }

  // Re-render CS QA modal but preserve any in-progress input values the user has typed
  function rerenderCSQuickAddPreservingInputs() {
    const drugMap = {};
    document.querySelectorAll('#csQuickAddModal .csqa-input').forEach(input => {
      const drug = input.dataset.drug, field = input.dataset.field;
      if(!drug || !field) return;
      if(!drugMap[drug]) drugMap[drug] = {};
      drugMap[drug][field] = input.type === 'checkbox' ? input.checked : input.value;
    });
    // Merge with existing csEntries data
    const existing = {};
    (window.csEntries || []).forEach(e => { if(e.drug && !existing[e.drug]) existing[e.drug] = {...e}; });
    Object.entries(drugMap).forEach(([drug, fields]) => {
      if(!existing[drug]) existing[drug] = { drug };
      Object.assign(existing[drug], fields);
    });
    renderCSQuickAddModal(existing);
  }

  window.qa_openWitnessSig = function(drug) {
    installSigWrappersOnce();
    if(typeof window.openWitnessModal !== 'function') {
      alert('Signature modal not ready. Please try again.');
      return;
    }
    _qaSigTarget = { drug, kind: 'witness' };
    // Bump z-index so canvas modal sits above the QA modal
    const wm = document.getElementById('witnessModal');
    if(wm) wm.style.zIndex = '10001';
    window.openWitnessModal(-1); // -1 sentinel: existing handler will be intercepted by our wrapper
  };

  window.qa_openProviderSig = function(drug) {
    installSigWrappersOnce();
    if(typeof window.openCSProviderModal !== 'function') {
      alert('Signature modal not ready. Please try again.');
      return;
    }
    _qaSigTarget = { drug, kind: 'provider' };
    const pm = document.getElementById('csProviderModal');
    if(pm) pm.style.zIndex = '10001';
    window.openCSProviderModal(-1);
  };

  window.qa_clearWitnessSig = function(drug) {
    if(_qaSigs[drug]) delete _qaSigs[drug].witness;
    rerenderCSQuickAddPreservingInputs();
  };
  window.qa_clearProviderSig = function(drug) {
    if(_qaSigs[drug]) delete _qaSigs[drug].provider;
    rerenderCSQuickAddPreservingInputs();
  };

  window.openCSQuickAddModal = function() {
    const modal = document.getElementById('csQuickAddModal');
    if(!modal) return;
    if(!window.CS_DRUGS) {
      alert('CS data still loading. Try again in a moment.');
      return;
    }
    installSigWrappersOnce();
    // Reset temp sigs each time the modal opens — we always start from the live csEntries state
    _qaSigs = {};
    _qaSigTarget = null;
    const existing = {};
    (window.csEntries || []).forEach(e => {
      if(e.drug && !existing[e.drug]) existing[e.drug] = e;
    });
    modal.style.display = 'flex';
    renderCSQuickAddModal(existing);
  };

  window.closeCSQuickAddModal = function() {
    const modal = document.getElementById('csQuickAddModal');
    if(modal) modal.style.display = 'none';
    _qaSigTarget = null;
  };

  function renderCSQuickAddModal(existingByDrug) {
    const body = document.getElementById('csQuickAddBody');
    if(!body) return;
    const drugs = window.CS_DRUGS || {};
    const drugKeys = Object.keys(drugs);
    if(!drugKeys.length) {
      body.innerHTML = '<div class="empty-state">No CS drugs configured.</div>';
      return;
    }
    let html = '';
    drugKeys.forEach(key => {
      const drug = drugs[key];
      const ex = (existingByDrug && existingByDrug[key]) || {};
      const cpm = (window.getCostPerMG && window.getCostPerMG(key)) || 0;
      // Resolve sigs: temp QA sigs (just drawn) override saved ones from existing csEntries
      const temp = _qaSigs[key] || {};
      const witnessSig = temp.witness || ex.witnessSignature || '';
      const providerSig = temp.provider || ex.providerSignature || '';
      const sigCount = (witnessSig ? 1 : 0) + (providerSig ? 1 : 0);
      html += `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;gap:10px">
          <div style="font-size:14px;font-weight:600">${escapeHtml(drug.label || key)}</div>
          <div style="font-size:11px;color:var(--text-faint)">
            ${cpm > 0 ? '$'+cpm.toFixed(4)+'/mg' : ''}
            ${sigCount === 2 ? ' &middot; <span style="color:var(--accent)">✓ both signed</span>' : sigCount === 1 ? ' &middot; <span style="color:var(--warn)">1 of 2 signed</span>' : ''}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <label style="font-size:10px;text-transform:uppercase;color:var(--text-faint);font-weight:600;margin-bottom:4px;display:block;letter-spacing:.5px">Amount Given (mg)</label>
            <input type="number" min="0" step="0.1" value="${ex.amountGiven||''}" placeholder="0"
              class="csqa-input" data-drug="${escapeHtml(key)}" data-field="amountGiven"
              style="width:100%;padding:8px 10px;text-align:center;font-size:14px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg)">
          </div>
          <div>
            <label style="font-size:10px;text-transform:uppercase;color:var(--text-faint);font-weight:600;margin-bottom:4px;display:block;letter-spacing:.5px">Left in Vial (mg)</label>
            <input type="number" min="0" step="0.1" value="${ex.leftInVial||''}" placeholder="0"
              class="csqa-input" data-drug="${escapeHtml(key)}" data-field="leftInVial"
              style="width:100%;padding:8px 10px;text-align:center;font-size:14px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg)">
          </div>
          <div>
            <label style="font-size:10px;text-transform:uppercase;color:var(--text-faint);font-weight:600;margin-bottom:4px;display:block;letter-spacing:.5px">Wasted (mg)</label>
            <input type="number" min="0" step="0.1" value="${ex.wastedAmt||''}" placeholder="0"
              class="csqa-input" data-drug="${escapeHtml(key)}" data-field="wastedAmt"
              style="width:100%;padding:8px 10px;text-align:center;font-size:14px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg)">
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0 0 12px 0;font-weight:400">
          <input type="checkbox" class="csqa-input" data-drug="${escapeHtml(key)}" data-field="newBottle" ${ex.newBottle?'checked':''} style="width:16px;height:16px">
          New Bottle Opened
        </label>
        <div style="display:flex;flex-wrap:wrap;gap:14px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Witness:</span>
            ${witnessSig
              ? `<img src="${witnessSig}" style="height:30px;border:1px solid var(--border);border-radius:4px;background:#fff;padding:2px">
                 <button onclick="window.qa_openWitnessSig('${escapeHtml(key)}')" class="btn btn-ghost btn-sm" style="font-size:11px">Re-sign</button>
                 <button onclick="window.qa_clearWitnessSig('${escapeHtml(key)}')" title="Clear signature" style="background:none;border:none;cursor:pointer;color:var(--text-faint);font-size:16px;line-height:1;padding:0 2px">×</button>`
              : `<button onclick="window.qa_openWitnessSig('${escapeHtml(key)}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn);border-color:var(--warn)">✍ Witness Sign</button>`
            }
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Provider:</span>
            ${providerSig
              ? `<img src="${providerSig}" style="height:30px;border:1px solid var(--border);border-radius:4px;background:#fff;padding:2px">
                 <button onclick="window.qa_openProviderSig('${escapeHtml(key)}')" class="btn btn-ghost btn-sm" style="font-size:11px">Re-sign</button>
                 <button onclick="window.qa_clearProviderSig('${escapeHtml(key)}')" title="Clear signature" style="background:none;border:none;cursor:pointer;color:var(--text-faint);font-size:16px;line-height:1;padding:0 2px">×</button>`
              : `<button onclick="window.qa_openProviderSig('${escapeHtml(key)}')" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--info);border-color:var(--info)">✍ Provider Sign</button>`
            }
          </div>
        </div>
      </div>`;
    });
    html += `<div style="font-size:12px;color:var(--text-faint);font-style:italic;margin-top:6px">Tip: leave a drug blank to skip it. Signatures are saved to the case when you click Apply.</div>`;
    body.innerHTML = html;
  }

  window.applyCSQuickAdd = function() {
    const drugMap = {};
    document.querySelectorAll('#csQuickAddModal .csqa-input').forEach(input => {
      const drug = input.dataset.drug;
      const field = input.dataset.field;
      if(!drug || !field) return;
      if(!drugMap[drug]) drugMap[drug] = {};
      drugMap[drug][field] = input.type === 'checkbox' ? input.checked : input.value;
    });
    // Preserve existing IDs and signatures by drug (from any previously-saved csEntries)
    const oldByDrug = {};
    (window.csEntries || []).forEach(e => { if(!oldByDrug[e.drug]) oldByDrug[e.drug] = e; });
    const newEntries = [];
    // Include any drug that has either amounts OR a freshly-drawn signature
    const allDrugs = new Set([...Object.keys(drugMap), ...Object.keys(_qaSigs)]);
    allDrugs.forEach(drug => {
      const fields = drugMap[drug] || {};
      const tempSig = _qaSigs[drug] || {};
      const old = oldByDrug[drug];
      const hasAmount = (parseFloat(fields.amountGiven) || 0) > 0
                     || (parseFloat(fields.leftInVial) || 0) > 0
                     || (parseFloat(fields.wastedAmt) || 0) > 0
                     || !!fields.newBottle;
      // Skip drugs with no amounts AND no signatures (truly empty)
      if(!hasAmount && !tempSig.witness && !tempSig.provider && !old) return;
      newEntries.push({
        id: (old && old.id) || (window.uid ? window.uid() : Date.now().toString(36)),
        drug,
        amountGiven: fields.amountGiven || '',
        leftInVial: fields.leftInVial || '',
        wasted: false,
        wastedAmt: fields.wastedAmt || '',
        newBottle: !!fields.newBottle,
        // Freshly-drawn sigs override saved ones; otherwise keep saved
        witnessSignature: tempSig.witness || (old && old.witnessSignature) || '',
        providerSignature: tempSig.provider || (old && old.providerSignature) || ''
      });
    });
    window.csEntries = newEntries;
    _qaSigs = {};
    window.closeCSQuickAddModal();
    if(typeof window.renderCSEntries === 'function') window.renderCSEntries();
    if(typeof window.renderCaseSupplies === 'function') window.renderCaseSupplies();
  };

  // Close modals on outside click
  document.addEventListener('click', (e) => {
    const sup = document.getElementById('suppliesQuickAddModal');
    const cs  = document.getElementById('csQuickAddModal');
    if(sup && e.target === sup) window.closeSuppliesQuickAddModal();
    if(cs  && e.target === cs)  window.closeCSQuickAddModal();
  });

})();
