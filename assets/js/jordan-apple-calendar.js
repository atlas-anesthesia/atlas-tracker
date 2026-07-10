// jordan-apple-calendar.js — "Subscribe in Apple Calendar" button on the
// Calendar tab. Jordan-only.
//
// Each click ensures Jordan has a long-random token recorded in
//   atlas/calendar_subscribers.tokens[]
// and then opens a webcal:// URL pointing at the worker's /calendar.ics
// endpoint with ?token=<token>. Apple Calendar (iPhone, iPad, Mac) picks
// that up and adds a live-syncing subscription that refreshes about every
// 15 minutes — so any new pre-op call Nicole schedules with Jordan
// automatically appears on his phone without him doing anything.

(() => {
  const WORKER_BASE = 'atlas-reminder.blue-disk-9b10.workers.dev';
  const HTTPS_BASE  = 'https://' + WORKER_BASE;
  const WEBCAL_BASE = 'webcal://' + WORKER_BASE;
  const SUBS_PATH   = 'calendar_subscribers';

  const $ = id => document.getElementById(id);
  function uidLong() {
    // 32 random hex chars — same entropy as the inbox forward secret.
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  function ensureUI() {
    if(window._userRole !== 'assistant') {
      $('jcal-subscribe-btn')?.remove();
      return;
    }
    if($('jcal-subscribe-btn')) return;
    // Anchor: the action bar inside #tab-calendar. Only inject once it exists.
    const actionBar = document.querySelector('#tab-calendar .action-bar > div:last-child');
    if(!actionBar) return;
    const btn = document.createElement('button');
    btn.id = 'jcal-subscribe-btn';
    btn.className = 'btn btn-ghost btn-sm';
    btn.style.cssText = 'background:#0f172a;color:#fff;border:none;font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;font-family:inherit';
    btn.innerHTML = '📲 Subscribe in Apple Calendar';
    btn.title = 'Add a live-syncing feed of patient calls to your iPhone / Mac Calendar';
    btn.addEventListener('click', onSubscribeClick);
    actionBar.appendChild(btn);
  }
  setInterval(ensureUI, 1000);
  document.addEventListener('DOMContentLoaded', ensureUI);

  async function getOrCreateToken() {
    if(!window.db) throw new Error('Database not ready — try again in a moment.');
    const docRef = window.doc(window.db, 'atlas', SUBS_PATH);
    const snap   = await window.getDoc(docRef);
    const data   = snap.exists() ? (snap.data() || {}) : {};
    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    // Each token entry is { token, owner, issuedAt }. Look up an existing
    // one for Jordan first so re-subscribing doesn't pile up duplicates.
    const ownerEmail = (window.currentUser?.email) || 'jordan';
    const existing = tokens.find(t => t && t.owner === ownerEmail);
    if(existing) return existing.token;
    const token = uidLong();
    tokens.push({ token, owner: ownerEmail, issuedAt: new Date().toISOString(), label: 'Jordan — Apple Calendar' });
    await window.setDoc(docRef, { tokens });
    return token;
  }

  async function onSubscribeClick() {
    const btn = $('jcal-subscribe-btn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = 'Preparing…';
    let token;
    try { token = await getOrCreateToken(); }
    catch(e) {
      alert('Could not set up the calendar feed: ' + (e.message || e));
      btn.disabled = false; btn.innerHTML = orig;
      return;
    }
    btn.disabled = false; btn.innerHTML = orig;
    openSubscribeModal(token);
  }

  function openSubscribeModal(token) {
    const webcalUrl = WEBCAL_BASE + '/calendar.ics?token=' + encodeURIComponent(token);
    const httpsUrl  = HTTPS_BASE  + '/calendar.ics?token=' + encodeURIComponent(token);
    const prior = $('jcalSubscribeModal');
    if(prior) prior.remove();
    const wrap = document.createElement('div');
    wrap.id = 'jcalSubscribeModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
    wrap.onclick = e => { if(e.target === wrap) wrap.remove(); };
    wrap.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden">
      <div style="background:#0f172a;color:#fff;padding:18px 22px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8">Calendar Sync</div>
          <div style="font-size:17px;font-weight:700;margin-top:2px">Add patient calls to your Apple Calendar</div>
        </div>
        <button onclick="document.getElementById('jcalSubscribeModal').remove()" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:14px;font-family:inherit">✕</button>
      </div>
      <div style="padding:22px 24px;font-size:14px;line-height:1.55;color:#0f172a">
        <p style="margin:0 0 12px 0">Tap the button below on your iPhone, iPad, or Mac. iOS/macOS will ask permission to subscribe to a new calendar called <strong>Atlas — Jordan Pre-Op Calls</strong>. It refreshes every ~15 minutes, so any new patient Shannon schedules with you appears automatically.</p>
        <a href="${webcalUrl}" style="display:block;background:#166534;color:#fff;text-decoration:none;text-align:center;padding:14px 18px;border-radius:10px;font-size:15px;font-weight:700;margin:14px 0">📲 Add to Apple Calendar</a>
        <div style="font-size:12px;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-top:14px">
          <div style="font-weight:600;margin-bottom:4px">Manual setup (other calendar apps)</div>
          <div style="margin-bottom:6px">Paste this URL into your calendar app as a subscription:</div>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="jcal-url" type="text" readonly value="${httpsUrl}" style="flex:1;font-size:12px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-family:'DM Mono',monospace;background:#fff">
            <button onclick="(async()=>{try{await navigator.clipboard.writeText(document.getElementById('jcal-url').value);this.textContent='✓ Copied';setTimeout(()=>{this.textContent='Copy'},1500);}catch(_){document.getElementById('jcal-url').select();document.execCommand('copy');this.textContent='✓ Copied';setTimeout(()=>{this.textContent='Copy'},1500);}})()" style="background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit">Copy</button>
          </div>
        </div>
        <div style="margin-top:14px;font-size:12px;color:#64748b">⚠ Treat this link like a password — anyone who has it can see your patient calls. If you ever need to revoke it, ask Oliver to remove your token from <code style="background:#f1f5f9;padding:1px 4px;border-radius:4px">atlas/calendar_subscribers</code>.</div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
  }
})();
