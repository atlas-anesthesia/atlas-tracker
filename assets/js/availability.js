// availability.js — Jordan's availability tab + Nicole's read-only view.
//
// Data: atlas/availability  →  {
//   jordan: {
//     slots: { 'YYYY-MM-DD': [{start:'HH:MM', end:'HH:MM'}, ...] },
//     updatedAt
//   }
// }
//
// Jordan picks specific time windows per day (e.g. 9am-12pm and 2pm-5pm).
// Nicole sees one calendar event per slot and clicks one to book.
// Old data format (just an array of available dates) is auto-migrated to
// a default 9am-5pm slot on each date.

(() => {
  const DOC_PATH = 'availability';
  const OWNER_KEY = 'jordan';

  // _slots: { 'YYYY-MM-DD': [{start:'HH:MM', end:'HH:MM'}, ...] }
  let _slots = {};
  let _viewMonth = new Date().getMonth();
  let _viewYear  = new Date().getFullYear();
  let _loaded = false;
  let _editingDate = null; // for the slot editor modal

  function _$(id) { return document.getElementById(id); }
  function _iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function _fmtTime(hhmm) {
    if(!hhmm) return '';
    try { return new Date('2000-01-01T' + hhmm).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }); }
    catch(e) { return hhmm; }
  }
  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  async function _load() {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', DOC_PATH));
      const data = snap.exists() ? snap.data() : {};
      const owner = data && data[OWNER_KEY];
      if(owner && owner.slots && typeof owner.slots === 'object') {
        _slots = owner.slots;
      } else if(owner && Array.isArray(owner.dates)) {
        // Migrate old format: each date → one full-day slot
        _slots = {};
        owner.dates.forEach(d => { _slots[d] = [{ start: '09:00', end: '17:00' }]; });
      } else {
        _slots = {};
      }
    } catch(e) {
      console.warn('availability load:', e);
      _slots = {};
    }
    _publish();
    _loaded = true;
  }

  function _publish() {
    // Stash on window so getCalEvents (in app.js) can emit one event per slot.
    window._availabilitySlots = _slots;
    // Keep the legacy single-date set populated too for any code still reading it.
    window._availableDates = new Set(Object.keys(_slots).filter(d => (_slots[d]||[]).length));
  }

  async function _save() {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', DOC_PATH));
      const data = snap.exists() ? snap.data() : {};
      data[OWNER_KEY] = { slots: _slots, updatedAt: new Date().toISOString() };
      // Clear any legacy `dates` field to avoid confusion.
      if(data[OWNER_KEY].dates) delete data[OWNER_KEY].dates;
      await window.setDoc(window.doc(window.db, 'atlas', DOC_PATH), data);
      _publish();
      const status = _$('avl-status');
      if(status) {
        const dayCount = Object.keys(_slots).filter(d => (_slots[d]||[]).length).length;
        const slotCount = Object.values(_slots).reduce((n, arr) => n + (arr||[]).length, 0);
        status.textContent = `✓ Saved · ${dayCount} day${dayCount===1?'':'s'}, ${slotCount} slot${slotCount===1?'':'s'}`;
        status.style.color = '#166534';
      }
    } catch(e) {
      console.warn('availability save:', e);
      const status = _$('avl-status');
      if(status) { status.textContent = '✗ Could not save: ' + e.message; status.style.color = '#b91c1c'; }
    }
  }

  function _render() {
    const grid = _$('avl-grid');
    const label = _$('avl-month-label');
    if(!grid) return;
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if(label) label.textContent = `${months[_viewMonth]} ${_viewYear}`;
    grid.innerHTML = '';
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
      const h = document.createElement('div');
      h.style.cssText = 'background:#1d3557;color:#fff;text-align:center;padding:7px 4px;font-size:11px;font-weight:700;letter-spacing:.4px';
      h.textContent = d;
      grid.appendChild(h);
    });
    const firstDay = new Date(_viewYear, _viewMonth, 1).getDay();
    const daysInMonth = new Date(_viewYear, _viewMonth + 1, 0).getDate();
    const todayIso = _iso(new Date());
    for(let i = 0; i < firstDay; i++) {
      const blank = document.createElement('div');
      blank.style.cssText = 'background:var(--surface2);min-height:90px';
      grid.appendChild(blank);
    }
    for(let day = 1; day <= daysInMonth; day++) {
      const iso = `${_viewYear}-${String(_viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const slots = _slots[iso] || [];
      const isPast = iso < todayIso;
      const isToday = iso === todayIso;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.style.cssText = `
        background:${slots.length ? '#dcfce7' : 'var(--surface)'};
        color:${isPast && !slots.length ? 'var(--text-faint)' : 'var(--text)'};
        border:${isToday ? '2px solid #1d3557' : '1px solid transparent'};
        min-height:90px;padding:6px;cursor:${isPast ? 'not-allowed' : 'pointer'};
        font-family:inherit;font-size:13px;text-align:left;display:flex;flex-direction:column;gap:3px;align-items:flex-start;
        ${isPast ? 'opacity:.55' : ''}
      `;
      const slotChips = slots.map(s => `<span style="font-size:10px;font-weight:600;color:#166534;background:#bbf7d0;padding:1px 5px;border-radius:8px;white-space:nowrap">${_esc(_fmtTime(s.start))}–${_esc(_fmtTime(s.end))}</span>`).join('');
      cell.innerHTML = `<span style="font-size:12px;font-weight:${isToday ? '700' : '500'}">${day}</span><div style="display:flex;flex-direction:column;gap:2px;width:100%">${slotChips}${!slots.length && !isPast ? '<span style="font-size:10px;color:var(--text-faint);font-style:italic">+ add slots</span>' : ''}</div>`;
      if(!isPast) cell.onclick = () => _openSlotEditor(iso);
      grid.appendChild(cell);
    }
  }

  function _openSlotEditor(iso) {
    _editingDate = iso;
    const old = document.getElementById('avlSlotEditor');
    if(old) old.remove();
    const dateLabel = new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const wrap = document.createElement('div');
    wrap.id = 'avlSlotEditor';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto';
    wrap.onclick = (e) => { if(e.target === wrap) { wrap.remove(); _editingDate = null; } };
    wrap.innerHTML = `<div style="background:var(--surface);border-radius:var(--radius);width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto">
      <div style="background:#1d3557;color:#fff;padding:16px 20px;border-radius:var(--radius) var(--radius) 0 0;display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#90b8e0;margin-bottom:2px">Available time slots</div><div style="font-size:15px;font-weight:600">${_esc(dateLabel)}</div></div>
        <button onclick="document.getElementById('avlSlotEditor').remove();window._avlEditingDateClear()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:13px">✕</button>
      </div>
      <div style="padding:18px 20px">
        <div id="avl-slot-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px"></div>
        <div style="border-top:1px solid var(--border);padding-top:14px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-faint);letter-spacing:.5px;margin-bottom:8px">Add a slot</div><div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end"><div><label style="margin-top:0;font-size:11px">Start</label><input type="time" id="avl-new-start" value="09:00"></div><div><label style="margin-top:0;font-size:11px">End</label><input type="time" id="avl-new-end" value="12:00"></div><button onclick="window._avlAddSlot()" class="btn btn-primary btn-sm" style="background:#1d3557;border-color:#1d3557">+ Add</button></div></div>
        <div style="display:flex;justify-content:flex-end;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)"><button class="btn btn-ghost" onclick="document.getElementById('avlSlotEditor').remove();window._avlEditingDateClear()">Done</button></div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    _renderSlotList();
  }

  window._avlEditingDateClear = function() { _editingDate = null; _render(); };

  function _renderSlotList() {
    const el = document.getElementById('avl-slot-list');
    if(!el || !_editingDate) return;
    const slots = _slots[_editingDate] || [];
    if(!slots.length) {
      el.innerHTML = '<div style="font-size:13px;color:var(--text-faint);font-style:italic;padding:8px 0">No slots yet — add one below.</div>';
      return;
    }
    el.innerHTML = slots.map((s, i) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px"><div style="font-size:14px;font-weight:600;color:#166534">${_esc(_fmtTime(s.start))} – ${_esc(_fmtTime(s.end))}</div><button onclick="window._avlRemoveSlot(${i})" class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--warn);padding:3px 9px">🗑</button></div>`).join('');
  }

  window._avlAddSlot = async function() {
    if(!_editingDate) return;
    const start = document.getElementById('avl-new-start')?.value;
    const end   = document.getElementById('avl-new-end')?.value;
    if(!start || !end) { alert('Set both a start and end time.'); return; }
    if(end <= start) { alert('End time must be after start time.'); return; }
    if(!_slots[_editingDate]) _slots[_editingDate] = [];
    // Skip exact duplicates
    if(_slots[_editingDate].some(s => s.start === start && s.end === end)) {
      alert('That slot is already added.'); return;
    }
    _slots[_editingDate].push({ start, end });
    _slots[_editingDate].sort((a, b) => a.start.localeCompare(b.start));
    _renderSlotList();
    await _save();
    _render();
  };

  window._avlRemoveSlot = async function(idx) {
    if(!_editingDate || !_slots[_editingDate]) return;
    _slots[_editingDate].splice(idx, 1);
    if(_slots[_editingDate].length === 0) delete _slots[_editingDate];
    _renderSlotList();
    await _save();
    _render();
  };

  window._avlChangeMonth = function(delta) {
    _viewMonth += delta;
    while(_viewMonth < 0)  { _viewMonth += 12; _viewYear -= 1; }
    while(_viewMonth > 11) { _viewMonth -= 12; _viewYear += 1; }
    _render();
  };

  window.openAvailability = async function() {
    if(!_loaded) await _load();
    _render();
  };

  const origShowTab = window.showTab;
  if(typeof origShowTab === 'function') {
    window.showTab = function(name) {
      const ret = origShowTab.apply(this, arguments);
      if(name === 'availability') window.openAvailability();
      return ret;
    };
  }

  setTimeout(async () => {
    if(window.db && !_loaded) await _load();
  }, 1200);
})();
