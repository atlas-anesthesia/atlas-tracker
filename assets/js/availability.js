// availability.js — Jordan's availability tab + Nicole's read-only view.
//
// Data: atlas/availability  →  { jordan: { dates: [yyyy-mm-dd, ...], updatedAt } }
//
// Jordan toggles whole days. Default state is unavailable; he explicitly
// marks the days he can do pre-op clearance visits. Nicole's calendar reads
// from the same doc and renders those days as bookable.

(() => {
  const DOC_PATH = 'availability';
  // The "owner" of the availability — for now we only track Jordan. If we ever
  // add another non-CRNA, we'd just add another key under this doc.
  const OWNER_KEY = 'jordan';

  let _dates = new Set(); // available dates (YYYY-MM-DD)
  let _viewMonth = new Date().getMonth();
  let _viewYear  = new Date().getFullYear();
  let _loaded = false;

  function _$(id) { return document.getElementById(id); }
  function _iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  async function _load() {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', DOC_PATH));
      const data = snap.exists() ? snap.data() : {};
      const arr = (data && data[OWNER_KEY] && Array.isArray(data[OWNER_KEY].dates)) ? data[OWNER_KEY].dates : [];
      _dates = new Set(arr);
      // Stash for other modules (calendar render reads this).
      window._availableDates = _dates;
    } catch(e) {
      console.warn('availability load:', e);
      _dates = new Set();
      window._availableDates = _dates;
    }
    _loaded = true;
  }

  async function _save() {
    try {
      const snap = await window.getDoc(window.doc(window.db, 'atlas', DOC_PATH));
      const data = snap.exists() ? snap.data() : {};
      data[OWNER_KEY] = { dates: Array.from(_dates).sort(), updatedAt: new Date().toISOString() };
      await window.setDoc(window.doc(window.db, 'atlas', DOC_PATH), data);
      window._availableDates = _dates;
      const status = _$('avl-status');
      if(status) {
        status.textContent = '✓ Saved · ' + _dates.size + ' day' + (_dates.size === 1 ? '' : 's') + ' marked available';
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
    // Day-of-week headers
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
      const h = document.createElement('div');
      h.style.cssText = 'background:#1d3557;color:#fff;text-align:center;padding:7px 4px;font-size:11px;font-weight:700;letter-spacing:.4px';
      h.textContent = d;
      grid.appendChild(h);
    });
    const firstDay = new Date(_viewYear, _viewMonth, 1).getDay();
    const daysInMonth = new Date(_viewYear, _viewMonth + 1, 0).getDate();
    const todayIso = _iso(new Date());
    // Leading blanks
    for(let i = 0; i < firstDay; i++) {
      const blank = document.createElement('div');
      blank.style.cssText = 'background:var(--surface2);min-height:60px';
      grid.appendChild(blank);
    }
    for(let day = 1; day <= daysInMonth; day++) {
      const iso = `${_viewYear}-${String(_viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const isAvail = _dates.has(iso);
      const isPast  = iso < todayIso;
      const isToday = iso === todayIso;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.dataset.date = iso;
      cell.style.cssText = `
        background:${isAvail ? '#dcfce7' : 'var(--surface)'};
        color:${isPast && !isAvail ? 'var(--text-faint)' : 'var(--text)'};
        border:${isToday ? '2px solid #1d3557' : '1px solid transparent'};
        min-height:60px;padding:6px;cursor:${isPast ? 'not-allowed' : 'pointer'};
        font-family:inherit;font-size:13px;text-align:left;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;
        ${isPast ? 'opacity:.55' : ''}
      `;
      cell.innerHTML = `<span style="font-size:12px;font-weight:${isToday ? '700' : '500'}">${day}</span>${isAvail ? '<span style="font-size:10px;color:#166534;font-weight:700;margin-top:4px">✓ available</span>' : ''}`;
      if(!isPast) cell.onclick = () => _toggle(iso);
      grid.appendChild(cell);
    }
  }

  async function _toggle(iso) {
    if(_dates.has(iso)) _dates.delete(iso);
    else _dates.add(iso);
    _render();
    await _save();
  }

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

  // Hook into showTab so we render fresh when Jordan opens the tab.
  const origShowTab = window.showTab;
  if(typeof origShowTab === 'function') {
    window.showTab = function(name, pushState) {
      const ret = origShowTab.apply(this, arguments);
      if(name === 'availability') window.openAvailability();
      return ret;
    };
  }

  // Auto-load on first page open so window._availableDates is populated for
  // Nicole's calendar render even before she opens the tab herself.
  setTimeout(async () => {
    if(window.db && !_loaded) await _load();
  }, 1200);
})();
