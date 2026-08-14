/* Pick&Drive customer + driver app — talks to the real Laravel API.
   Same account system as the admin console: phone OTP login, role (customer/driver)
   decides which screens render. This is what the Android WebView wraps. */

const API_BASE = 'https://api.pickanddrive.pk/api/v1';
const KEY = 'pickanddrive-app-v1';

const CATS = [
  { id: 'bike', icon: '🏍', name: 'Bike' },
  { id: 'economy', icon: '🚗', name: 'Economy' },
  { id: 'city', icon: '🚘', name: 'City' },
  { id: 'premium', icon: '🚙', name: 'Premium' },
  { id: 'family', icon: '🚐', name: 'Family' },
  { id: 'school', icon: '🏫', name: 'School' },
];

function seedState() {
  return {
    token: null, role: null, user: null,
    screen: 'login',
    phone: '', otp: ['', '', '', ''], otpTimer: 0,
    pickup: null, drop: null, dropQuery: '', dropResults: [],
    category: 'city', fareEstimate: null,
    activeRide: null,
    driverTab: 'home', driverOnline: false, incomingRide: null, earnings: null, wallet: null,
    rating: 0,
  };
}
let state = JSON.parse(localStorage.getItem(KEY) || 'null') || seedState();
function persist() {
  const { token, role, user, driverOnline } = state;
  localStorage.setItem(KEY, JSON.stringify({ ...seedState(), token, role, user, driverOnline }));
}
function $(id) { return document.getElementById(id); }
function toast(msg) {
  const old = document.querySelector('.toast'); if (old) old.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 260); }, 2200);
}

/* ---- API layer ---- */
async function apiRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired — please sign in again'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

async function geocodeSearch(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=pk&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  return res.json();
}
async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

/* ---- Auth ---- */
async function requestOtp() {
  const raw = ($('phoneInput') && $('phoneInput').value || '').replace(/[^0-9]/g, '');
  if (raw.length < 10) return toast('Enter a valid mobile number');
  const phone = '0' + raw.replace(/^0+/, '');
  state.phone = phone;
  try {
    const res = await apiRequest('/auth/otp/request', { method: 'POST', body: { phone } });
    toast(res.debug_code ? `OTP: ${res.debug_code}` : `OTP sent to ${phone}`);
    state.otp = ['', '', '', '']; state.otpTimer = 30;
    goto('otp');
    tickOtpTimer();
  } catch (e) { toast(e.message); }
}
function tickOtpTimer() {
  clearInterval(tickOtpTimer._h);
  tickOtpTimer._h = setInterval(() => {
    state.otpTimer = Math.max(0, state.otpTimer - 1);
    const line = $('otpTimerLine');
    if (line) line.innerHTML = state.otpTimer > 0
      ? `Resend code in <b>00:${String(state.otpTimer).padStart(2, '0')}</b>`
      : `<span class="link" style="display:inline" onclick="requestOtp()">Resend code</span>`;
    if (state.otpTimer === 0) clearInterval(tickOtpTimer._h);
  }, 1000);
}
async function verifyOtp() {
  const code = state.otp.join('');
  if (code.length !== 4) return;
  try {
    const res = await apiRequest('/auth/otp/verify', { method: 'POST', body: { phone: state.phone, code } });
    state.token = res.token; state.user = res.user; state.role = res.user.role;
    persist();
    toast(`Welcome, ${res.user.name}`);
    if (state.role === 'driver') { goto('driverHome'); startPolling(); }
    else { goto('customerHome'); startPolling(); }
  } catch (e) { toast(e.message); render(); }
}
function logout() {
  stopPolling();
  state = seedState();
  persist();
  render();
}

/* ---- Polling ---- */
let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollTick, 3000);
  pollTick();
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
async function pollTick() {
  if (!state.token) return;
  try {
    if (state.role === 'customer') {
      const ride = await apiRequest('/rides/mine/active');
      const wasTracking = ['waiting', 'tracking'].includes(state.screen);
      if (!ride) {
        if (state.activeRide && wasTracking) {
          state.activeRide = null; state.pickup = null; state.drop = null; state.fareEstimate = null;
          toast('Your ride was cancelled');
          goto('customerHome');
        }
        return;
      }
      state.activeRide = ride;
      if (ride.status === 'completed') { goto('rate'); return; }
      if (['pending_dispatch', 'dispatched'].includes(ride.status) && !['confirm', 'rate'].includes(state.screen)) state.screen = 'waiting';
      if (['accepted', 'arriving', 'arrived', 'in_progress'].includes(ride.status)) state.screen = 'tracking';
      render();
    } else if (state.role === 'driver') {
      if (state.driverOnline && !state.incomingRide && (!state.activeRide || ['completed'].includes(state.activeRide.status))) {
        const ride = await apiRequest('/driver/incoming');
        if (ride) { state.incomingRide = ride; render(); }
      }
    }
  } catch (e) { /* silent on poll errors */ }
}

/* ---- Customer: booking flow ---- */
function goto(screen) { state.screen = screen; render(); }

async function useCurrentLocation() {
  if (!navigator.geolocation) return toast('Location not available on this device');
  toast('Getting your location…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    let label = 'Current location';
    try {
      const r = await reverseGeocode(latitude, longitude);
      if (r && r.display_name) label = r.display_name.split(',').slice(0, 2).join(',');
    } catch (e) {}
    state.pickup = { address: label, lat: latitude, lng: longitude };
    render();
  }, () => toast('Could not get your location — enable GPS and try again'), { enableHighAccuracy: true, timeout: 10000 });
}

let dropDebounce = null;
function onDropInput(v) {
  state.dropQuery = v;
  clearTimeout(dropDebounce);
  if (v.trim().length < 3) { state.dropResults = []; refresh(); return; }
  dropDebounce = setTimeout(async () => {
    try {
      const results = await geocodeSearch(v);
      state.dropResults = results.map(r => ({ label: r.display_name, lat: +r.lat, lng: +r.lon }));
    } catch (e) { state.dropResults = []; }
    refresh();
  }, 550);
}
function pickDrop(i) {
  const r = state.dropResults[i];
  state.drop = { address: r.label.split(',').slice(0, 3).join(','), lat: r.lat, lng: r.lng };
  state.dropResults = [];
  goto('route');
}

async function selectCategory(id) {
  state.category = id;
  refresh();
  if (state.pickup && state.drop) {
    try {
      state.fareEstimate = await apiRequest('/rides/fare-estimate', {
        method: 'POST',
        body: { category: id, pickup_lat: state.pickup.lat, pickup_lng: state.pickup.lng, drop_lat: state.drop.lat, drop_lng: state.drop.lng },
      });
    } catch (e) { toast(e.message); }
    refresh();
  }
}

async function bookRide() {
  if (!state.pickup || !state.drop) return toast('Set pickup and drop-off first');
  try {
    const ride = await apiRequest('/rides', {
      method: 'POST',
      body: {
        category: state.category,
        pickup_address: state.pickup.address, pickup_lat: state.pickup.lat, pickup_lng: state.pickup.lng,
        drop_address: state.drop.address, drop_lat: state.drop.lat, drop_lng: state.drop.lng,
      },
    });
    state.activeRide = ride;
    goto('waiting');
  } catch (e) { toast(e.message); }
}
async function cancelActiveRide() {
  if (!state.activeRide) return;
  try {
    await apiRequest(`/rides/${state.activeRide.id}/cancel`, { method: 'POST' });
    state.activeRide = null; state.pickup = null; state.drop = null; state.fareEstimate = null;
    toast('Ride cancelled');
    goto('customerHome');
  } catch (e) { toast(e.message); }
}
function rateRide(n) { state.rating = n; refresh(); }
async function submitRating() {
  try {
    await apiRequest(`/rides/${state.activeRide.id}/rate`, { method: 'POST', body: { rating: state.rating || 5 } });
    toast('Thanks for rating your ride');
    state.activeRide = null; state.pickup = null; state.drop = null; state.fareEstimate = null; state.rating = 0;
    goto('customerHome');
  } catch (e) { toast(e.message); }
}

/* ---- Driver flow ---- */
async function toggleOnline() {
  try {
    const p = await apiRequest('/driver/status', { method: 'POST', body: { online: !state.driverOnline } });
    state.driverOnline = !!p.online;
    persist();
    refresh();
  } catch (e) { toast(e.message); }
}
async function acceptIncoming() {
  try {
    const ride = await apiRequest(`/driver/rides/${state.incomingRide.id}/accept`, { method: 'POST' });
    state.activeRide = ride; state.incomingRide = null;
    goto('driverActive');
  } catch (e) { toast(e.message); }
}
async function rejectIncoming() {
  try {
    await apiRequest(`/driver/rides/${state.incomingRide.id}/reject`, { method: 'POST' });
    state.incomingRide = null;
    toast('Declined — sent back to dispatch');
    refresh();
  } catch (e) { toast(e.message); }
}
async function advanceRideStatus() {
  try {
    const ride = await apiRequest(`/driver/rides/${state.activeRide.id}/status`, { method: 'PATCH' });
    state.activeRide = ride;
    if (ride.status === 'completed') { toast('Trip completed'); state.activeRide = null; state.driverTab = 'home'; goto('driverHome'); }
    else refresh();
  } catch (e) { toast(e.message); }
}
async function loadDriverTab(tab) {
  state.driverTab = tab;
  try {
    if (tab === 'earnings') { state.earnings = await apiRequest('/driver/earnings'); state.wallet = await apiRequest('/driver/wallet'); }
  } catch (e) { toast(e.message); }
  refresh();
}
async function requestWithdrawal() {
  const amount = +($('withdrawAmt') && $('withdrawAmt').value || 0);
  if (!amount || amount < 1) return toast('Enter a valid amount');
  try {
    await apiRequest('/driver/wallet/withdraw', { method: 'POST', body: { amount } });
    toast('Withdrawal requested');
    loadDriverTab('earnings');
  } catch (e) { toast(e.message); }
}

/* ---- OTP input handling ---- */
function otpInput(i, v) {
  v = v.replace(/[^0-9]/g, '').slice(0, 1);
  state.otp[i] = v;
  const box = $('otp' + i); if (box) box.value = v;
  if (v && i < 3) { const nxt = $('otp' + (i + 1)); if (nxt) nxt.focus(); }
  if (state.otp.every(d => d.length === 1)) setTimeout(verifyOtp, 200);
}
function otpKey(i, ev) {
  if (ev.key === 'Backspace' && !state.otp[i] && i > 0) { const prev = $('otp' + (i - 1)); if (prev) prev.focus(); }
}

/* ---- Screens: shared ---- */
function scLogin() {
  return `<div class="p-pad">
    <div class="spacer"></div>
    <div class="brandmark">🔑 Pick&amp;Drive</div>
    <div class="p-title">Welcome</div>
    <div class="p-sub">Enter your mobile number to continue</div>
    <div><div class="field-label">Mobile Number</div>
    <input class="field-input" id="phoneInput" type="tel" inputmode="numeric" placeholder="0300 1234567" maxlength="11"></div>
    <button class="btn" onclick="requestOtp()">Send OTP</button>
    <div class="spacer"></div>
  </div>`;
}
function scOtp() {
  const boxes = state.otp.map((v, i) => `<input id="otp${i}" inputmode="numeric" maxlength="1" value="${v}" oninput="otpInput(${i},this.value)" onkeydown="otpKey(${i},event)">`).join('');
  return `<div class="p-pad">
    <div class="back" onclick="goto('login')">← Back</div>
    <div class="p-title">Verification Code</div>
    <div class="p-sub">We sent a 4-digit code to <b>${state.phone}</b></div>
    <div class="otp-boxes">${boxes}</div>
    <div class="p-sub" id="otpTimerLine" style="text-align:center">Resend code in <b>00:${String(state.otpTimer).padStart(2, '0')}</b></div>
    <div class="spacer"></div>
    <button class="btn" onclick="verifyOtp()">Verify</button>
  </div>`;
}

/* ---- Screens: customer ---- */
function scCustomerHome() {
  return `<div class="p-pad" style="gap:14px">
    <div class="topbar2"><span class="brandmark">🔑 Pick&amp;Drive</span><span class="link" onclick="logout()">Sign out</span></div>
    <div class="field" onclick="goto('search')"><span class="dot k"></span><span class="txt muted">Where to?</span><span>🔍</span></div>
    <div class="field-label">Ride category</div>
    <div class="cat-row">${CATS.map(c => `<div class="cat-item ${state.category === c.id ? 'sel' : ''}" onclick="selectCategory('${c.id}')"><div class="cat-icon">${c.icon}</div><div class="cat-name">${c.name}</div></div>`).join('')}</div>
    <div class="spacer"></div>
    <button class="btn" onclick="goto('search')">Book a ride</button>
  </div>`;
}
function scSearch() {
  const sugg = state.dropResults.map((r, i) => `<div class="sugg" onclick="pickDrop(${i})"><span class="ico">📍</span><div><div class="t">${r.label.split(',')[0]}</div><div class="s">${r.label.split(',').slice(1, 3).join(',')}</div></div></div>`).join('');
  return `<div class="p-pad">
    <div class="back" onclick="goto('customerHome')">← Set your route</div>
    <div class="field" onclick="useCurrentLocation()"><span class="dot g"></span><span class="txt">${state.pickup ? state.pickup.address : 'Use current location'}</span></div>
    <input class="field-input" id="dropInput" placeholder="Search drop-off address…" value="${state.dropQuery}" oninput="onDropInput(this.value)">
    <div>${sugg}</div>
    ${!state.pickup ? '<p class="p-sub">Tap the location field above to set your pickup point.</p>' : ''}
  </div>`;
}
function scRoute() {
  const est = state.fareEstimate;
  return `<div class="p-pad">
    <div class="back" onclick="goto('search')">← Route &amp; fare</div>
    <div class="field"><span class="dot g"></span><span class="txt">${state.pickup ? state.pickup.address : '—'}</span></div>
    <div class="field"><span class="dot k"></span><span class="txt">${state.drop ? state.drop.address : '—'}</span></div>
    <div class="field-label">Vehicle</div>
    <div class="cat-row">${CATS.map(c => `<div class="cat-item ${state.category === c.id ? 'sel' : ''}" onclick="selectCategory('${c.id}')"><div class="cat-icon">${c.icon}</div><div class="cat-name">${c.name}</div></div>`).join('')}</div>
    <div class="fare-box">
      ${est ? `<div class="fare-amt"><small>PKR</small>${est.calculated_fare}</div>
        <div class="fare-lines">
          <div class="row"><span>Base fare</span><b>PKR ${est.base_fare}</b></div>
          <div class="row"><span>Distance</span><b>${est.distance_km} km</b></div>
          <div class="row"><span>ETA</span><b>${est.duration_min} min</b></div>
          ${est.night_surcharge ? `<div class="row"><span>Night surcharge</span><b>PKR ${est.night_surcharge}</b></div>` : ''}
          ${est.surge_multiplier > 1 ? `<div class="row"><span>Surge</span><b>${est.surge_multiplier}×</b></div>` : ''}
        </div>` : `<div class="spin"></div>`}
    </div>
    <div class="spacer"></div>
    <button class="btn" ${est ? '' : 'disabled'} onclick="goto('confirm')">Continue</button>
  </div>`;
}
function scConfirm() {
  const est = state.fareEstimate;
  return `<div class="p-pad">
    <div class="back" onclick="goto('route')">← Confirm booking</div>
    <div class="field"><span class="dot g"></span><span class="txt">${state.pickup.address}</span></div>
    <div class="field"><span class="dot k"></span><span class="txt">${state.drop.address}</span></div>
    <p class="p-sub">Your booking goes to our dispatch team, who assign the closest available driver — this usually takes under a minute.</p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px"><span class="p-sub">Fare</span><span class="p-title" style="font-size:22px">PKR ${est.calculated_fare}</span></div>
    <button class="btn" onclick="bookRide()">Confirm booking</button>
  </div>`;
}
function rideStatusSteps(status) {
  const order = ['pending_dispatch', 'dispatched', 'accepted', 'arriving', 'arrived', 'in_progress'];
  const labels = { pending_dispatch: 'Finding a driver', dispatched: 'Driver notified', accepted: 'Driver on the way', arriving: 'Driver arriving', arrived: 'Driver has arrived', in_progress: 'Trip in progress' };
  const idx = order.indexOf(status);
  return order.map((s, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'active' : 'todo';
    const icon = i < idx ? '✓' : i === idx ? '●' : '○';
    return `<div class="step-row"><div class="step-dot ${cls}">${icon}</div><div class="step-t ${cls === 'todo' ? 'todo' : ''}">${labels[s]}</div></div>`;
  }).join('');
}
function scWaiting() {
  const ride = state.activeRide;
  if (!ride) return `<div class="p-pad"><div class="spacer"></div><div class="spin" style="margin:0 auto"></div><div class="spacer"></div></div>`;
  return `<div class="p-pad" style="align-items:center;text-align:center;gap:14px">
    <div class="spacer"></div>
    <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--gold-deep));display:flex;align-items:center;justify-content:center;font-size:24px">🚦</div>
    <div class="p-title">Your ride request is being processed</div>
    <div class="p-sub">${ride.pickup_address} → ${ride.drop_address} · PKR ${ride.calculated_fare}</div>
    <div id="stepListWrap" style="width:100%;text-align:left;background:var(--fill);border-radius:14px;padding:6px 12px">${rideStatusSteps(ride.status)}</div>
    <div class="spacer"></div>
    <div class="link" onclick="cancelActiveRide()">Cancel request</div>
  </div>`;
}
function scTracking() {
  const ride = state.activeRide;
  if (!ride) return scWaiting();
  const driver = ride.driver || {};
  return `<div class="p-pad" style="gap:12px">
    <div class="back" onclick="goto('waiting')">Trip status</div>
    <div id="stepListWrap" style="width:100%;text-align:left;background:var(--fill);border-radius:14px;padding:6px 12px">${rideStatusSteps(ride.status)}</div>
    <div class="driver-card">
      <div class="driver-row2"><div class="avatar">${(driver.name || 'D').slice(0, 1)}</div><div class="driver-info"><div class="t">${driver.name || 'Your driver'}</div><div class="s">★ ${driver.rating || '—'}</div></div></div>
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="p-sub">Fare</span><span class="p-title" style="font-size:16px">PKR ${ride.calculated_fare}</span></div>
    </div>
    <div class="spacer"></div>
    <div class="link" onclick="cancelActiveRide()">Cancel trip</div>
  </div>`;
}
function scRate() {
  const stars = [1, 2, 3, 4, 5].map(n => `<span class="${state.rating >= n ? 'on' : ''}" onclick="rateRide(${n})">★</span>`).join('');
  return `<div class="p-pad" style="align-items:center;text-align:center;gap:12px">
    <div class="spacer"></div>
    <div class="checkmark-circle">✓</div>
    <div class="p-title">Trip completed</div>
    <div class="p-sub">Rate your driver</div>
    <div class="stars">${stars}</div>
    <div class="spacer"></div>
    <button class="btn" style="width:100%" onclick="submitRating()">Submit</button>
  </div>`;
}

/* ---- Screens: driver ---- */
function scDriverHome() {
  const ride = state.incomingRide;
  const active = state.activeRide;
  return `<div class="p-pad" style="gap:14px">
    <div class="topbar2"><span class="brandmark">🔑 Pick&amp;Drive</span><span class="link" onclick="logout()">Sign out</span></div>
    <div class="card2" style="display:flex;justify-content:space-between;align-items:center">
      <div><b>${state.driverOnline ? 'You are online' : 'You are offline'}</b><div class="p-sub">${state.driverOnline ? 'Waiting for ride requests' : 'Go online to start receiving rides'}</div></div>
      <div class="switch ${state.driverOnline ? 'on' : ''}" onclick="toggleOnline()"><div class="knob"></div></div>
    </div>
    ${active ? driverActiveCard(active) : ''}
    ${ride && !active ? `<div class="card2">
        <span class="pill">NEW RIDE REQUEST</span>
        <div class="p-title" style="margin-top:8px;font-size:16px">PKR ${ride.calculated_fare} · ${ride.category}</div>
        <div class="p-sub">${ride.pickup_address} → ${ride.drop_address} · ${ride.distance_km} km</div>
        <div class="btn-row" style="margin-top:10px"><button class="btn" style="flex:1" onclick="acceptIncoming()">Accept</button><button class="btn outline" style="flex:1" onclick="rejectIncoming()">Decline</button></div>
      </div>` : ''}
    ${!ride && !active ? `<div class="empty2"><h2>${state.driverOnline ? 'Waiting for a ride…' : 'You are offline'}</h2><p>${state.driverOnline ? 'New requests will appear here automatically.' : 'Flip the switch above to start receiving rides.'}</p></div>` : ''}
    <div class="spacer"></div>
  </div>`;
}
function driverActiveCard(ride) {
  const nextLabel = { accepted: 'Mark arriving', arriving: 'Mark arrived', arrived: 'Start trip', in_progress: 'Complete trip' };
  return `<div class="card2">
    <span class="pill">ACTIVE TRIP</span>
    <div class="p-title" style="margin-top:8px;font-size:16px">PKR ${ride.calculated_fare} · ${ride.status.replace('_', ' ')}</div>
    <div class="p-sub">${ride.pickup_address} → ${ride.drop_address}</div>
    <button class="btn" style="margin-top:10px" onclick="advanceRideStatus()">${nextLabel[ride.status] || 'Update status'}</button>
  </div>`;
}
function scDriverEarnings() {
  const e = state.earnings || {}; const w = state.wallet || { balance: 0, withdrawals: [] };
  return `<div class="p-pad" style="gap:14px">
    <div class="p-title">Earnings &amp; wallet</div>
    <div class="stat-grid">
      <div class="stat-box"><small>Today</small><b>PKR ${e.today || 0}</b></div>
      <div class="stat-box"><small>This week</small><b>PKR ${e.week || 0}</b></div>
      <div class="stat-box"><small>This month</small><b>PKR ${e.month || 0}</b></div>
      <div class="stat-box"><small>Trips today</small><b>${e.trips_today || 0}</b></div>
    </div>
    <div class="card2"><div class="p-sub">Wallet balance</div><div class="p-title" style="font-size:22px">PKR ${w.balance}</div>
      <div class="field-label" style="margin-top:10px">Withdraw amount</div>
      <input class="field-input" id="withdrawAmt" type="number" placeholder="1000">
      <button class="btn" style="margin-top:8px" onclick="requestWithdrawal()">Request withdrawal</button>
    </div>
  </div>`;
}

/* ---- Root render ---- */
function tabContent() {
  if (state.driverTab === 'earnings') return scDriverEarnings();
  return scDriverHome();
}
function driverShell() {
  return `${tabContent()}
  <div class="bottom-nav">
    <button class="${state.driverTab === 'home' ? 'active' : ''}" onclick="loadDriverTab('home')">🚦<span>Home</span></button>
    <button class="${state.driverTab === 'earnings' ? 'active' : ''}" onclick="loadDriverTab('earnings')">💰<span>Earnings</span></button>
  </div>`;
}
const SCREENS = {
  login: scLogin, otp: scOtp,
  customerHome: scCustomerHome, search: scSearch, route: scRoute, confirm: scConfirm,
  waiting: scWaiting, tracking: scTracking, rate: scRate,
};
function render() {
  const root = $('root');
  if (state.role === 'driver' && state.token) { root.innerHTML = driverShell(); return; }
  if (state.token && state.screen === 'login') state.screen = 'customerHome';
  root.innerHTML = (SCREENS[state.screen] || scLogin)();
  if (state.screen === 'otp') { const f = $('otp0'); if (f) f.focus(); }
}
function refresh() { render(); }

if (state.token) {
  state.screen = state.role === 'driver' ? 'driverHome' : 'customerHome';
  render();
  startPolling();
} else {
  render();
}
