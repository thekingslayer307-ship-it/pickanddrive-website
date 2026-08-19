/* Pick&Drive customer + driver app — talks to the real Laravel API.
   Same account system as the admin console: phone OTP login, role (customer/driver)
   decides which screens render. This is what the Android WebView wraps. */

const API_BASE = 'https://api.pickanddrive.pk/api/v1';
const KEY = 'pickanddrive-app-v1';
const GOOGLE_CLIENT_ID = ''; // TODO: fill in once a Google Cloud OAuth client exists

const CAT_ICONS = { bike: '🏍', economy: '🚗', city: '🚘', premium: '🚙', family: '🚐', school: '🏫' };
let CATS = [
  { id: 'bike', icon: '🏍', name: 'Bike' },
  { id: 'economy', icon: '🚗', name: 'Economy' },
  { id: 'city', icon: '🚘', name: 'City' },
  { id: 'premium', icon: '🚙', name: 'Premium' },
  { id: 'family', icon: '🚐', name: 'Family' },
  { id: 'school', icon: '🏫', name: 'School' },
]; // overwritten by loadCategories() with the admin-configured list once logged in
async function loadCategories() {
  try {
    const cats = await apiRequest('/categories');
    if (cats && cats.length) CATS = cats.map(c => ({ id: c.category, icon: CAT_ICONS[c.category] || '🚗', name: c.label || c.category }));
  } catch (e) { /* keep fallback list */ }
}
let safetyContactNumber = '1122';
async function loadSafetyContact() {
  try { const res = await apiRequest('/safety-contact'); if (res && res.number) safetyContactNumber = res.number; } catch (e) {}
}

function seedState() {
  return {
    token: null, role: null, user: null,
    screen: 'login',
    phone: '', otp: ['', '', '', ''], otpTimer: 0,
    pickup: null, drop: null, dropQuery: '', dropResults: [],
    category: 'city', fareEstimate: null, paymentMethod: 'cash', pickerTarget: null,
    activeRide: null, rideHistory: [], complaints: [], complaintRideId: null,
    driverTab: 'home', driverOnline: false, incomingRide: null, earnings: null, wallet: null, documents: [],
    rating: 0,
    chatOpen: false, chatMessages: [],
  };
}
let liveMap = null, liveMapMarker = null, liveMapRideId = null;
let locationWatchId = null, lastLocationSentAt = 0;
let chatPollTimer = null;
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

async function apiUpload(path, formData) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { Accept: 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: formData,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired — please sign in again'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

async function geocodeSearch(query, near) {
  let url = `https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=pk&accept-language=en&q=${encodeURIComponent(query)}`;
  if (near && near.lat && near.lng) {
    // Soft bias toward the user's current area (a ~0.9° box, ~100km) — ranks nearby matches
    // first without excluding real matches elsewhere, which is what was scattering results
    // "from all over Pakistan" for anyone typing a common place/street name.
    const d = 0.45;
    url += `&viewbox=${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}&bounded=0`;
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  return res.json();
}
async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&accept-language=en&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

/* ---- Auth ---- */
function normalizedPhone(raw) {
  const digits = (raw || '').replace(/[^0-9]/g, '');
  return digits.length >= 10 ? '0' + digits.replace(/^0+/, '') : null;
}
async function sendOtpFor(phone) {
  state.phone = phone;
  const res = await apiRequest('/auth/otp/request', { method: 'POST', body: { phone } });
  toast(res.debug_code ? `OTP: ${res.debug_code}` : `OTP sent to ${phone}`);
  state.otp = ['', '', '', '']; state.otpTimer = 30;
  goto('otp');
  tickOtpTimer();
}
async function requestOtp() {
  const phone = normalizedPhone($('phoneInput') && $('phoneInput').value);
  if (!phone) return toast('Enter a valid mobile number');
  try { await sendOtpFor(phone); } catch (e) { toast(e.message); }
}
async function registerDriver() {
  const name = ($('signupName') && $('signupName').value || '').trim();
  const phone = normalizedPhone($('signupPhone') && $('signupPhone').value);
  const vehicle_model = ($('signupVehicle') && $('signupVehicle').value || '').trim();
  const plate_number = ($('signupPlate') && $('signupPlate').value || '').trim();
  const category = $('signupCategory') && $('signupCategory').value;
  if (!name || !phone || !vehicle_model || !plate_number) return toast('Fill in all fields');
  try {
    await apiRequest('/auth/driver/register', { method: 'POST', body: { name, phone, vehicle_model, plate_number, category } });
    toast('Application submitted — verify your number to continue');
    await sendOtpFor(phone);
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
    finishLogin(res);
  } catch (e) { toast(e.message); render(); }
}
function finishLogin(res) {
  state.token = res.token; state.user = res.user; state.role = res.user.role;
  persist();
  toast(`Welcome, ${res.user.name}`);
  loadCategories(); loadSafetyContact();
  if (state.role === 'driver') { goto('driverHome'); startPolling(); }
  else { goto('customerHome'); startPolling(); }
}
async function submitGoogleIdToken(idToken) {
  try {
    const res = await apiRequest('/auth/google', { method: 'POST', body: { id_token: idToken } });
    finishLogin(res);
  } catch (e) { toast(e.message); }
}
async function handleGoogleCredential(response) { submitGoogleIdToken(response.credential); }

/* The Android app wraps this page in a WebView, and Google blocks OAuth sign-in from inside
   embedded WebViews (403: disallowed_useragent) — so inside the app, native Android code handles
   the actual sign-in (via Credential Manager) and hands the resulting ID token back here through
   this bridge, reusing the same /auth/google backend call as the web GSI button. */
const inNativeApp = typeof AndroidBridge !== 'undefined' && !!AndroidBridge.hasNativeGoogleSignIn && AndroidBridge.hasNativeGoogleSignIn();
window.onNativeGoogleToken = function (idToken) { submitGoogleIdToken(idToken); };
window.onNativeGoogleError = function (message) { toast(message || 'Google sign-in failed'); };

if (!inNativeApp && GOOGLE_CLIENT_ID && window.google) {
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
}
function mountGoogleButton() {
  if (inNativeApp && $('googleBtn')) {
    $('googleBtn').innerHTML = `<button class="btn outline" style="width:100%" onclick="AndroidBridge.signInWithGoogle()">Sign in with Google</button>`;
  } else if (GOOGLE_CLIENT_ID && window.google && $('googleBtn')) {
    google.accounts.id.renderButton($('googleBtn'), { theme: 'outline', size: 'large', width: 320 });
  }
}
function logout() {
  stopPolling();
  stopChatPolling();
  stopLocationBroadcast();
  if (liveMap) { liveMap.remove(); liveMap = null; liveMapMarker = null; liveMapRideId = null; }
  teardownPickerMap();
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
      if (!ride || !ride.id) {
        if (state.activeRide && wasTracking) {
          state.activeRide = null; state.pickup = null; state.drop = null; state.fareEstimate = null;
          teardownLiveMap();
          toast('Your ride was cancelled');
          goto('customerHome');
        }
        return;
      }
      const statusChanged = !state.activeRide || state.activeRide.status !== ride.status;
      state.activeRide = ride;
      if (ride.status === 'completed') { goto('rate'); return; }
      if (['pending_dispatch', 'dispatched'].includes(ride.status) && !['confirm', 'rate'].includes(state.screen)) state.screen = 'waiting';
      if (['accepted', 'arriving', 'arrived', 'in_progress'].includes(ride.status)) state.screen = 'tracking';
      if (statusChanged) {
        render();
      } else if (state.screen === 'tracking' && !state.chatOpen) {
        updateLiveMapMarker(ride);
      }
    } else if (state.role === 'driver') {
      if (state.driverOnline && !state.incomingRide && (!state.activeRide || ['completed'].includes(state.activeRide.status))) {
        const ride = await apiRequest('/driver/incoming');
        if (ride && ride.id) { state.incomingRide = ride; render(); }
      }
    }
  } catch (e) { /* silent on poll errors */ }
}

/* ---- Customer: booking flow ---- */
function goto(screen) { state.screen = screen; render(); }

/* ---- Interactive map picker (pickup + drop-off) ---- */
let pickerMap = null;
let pickerMapMoveEndHandler = null;
let suppressNextMoveEnd = false;
let pickerGeoWatchDone = false;

function enterSearchScreen() {
  if (!state.pickerTarget) state.pickerTarget = state.pickup ? 'drop' : 'pickup';
  goto('search');
  setTimeout(() => initPickerMap(), 0);
}
function leaveSearchScreen(nextScreen) {
  teardownPickerMap();
  if (nextScreen === 'route') {
    state.fareEstimate = null;
    goto('route');
    if (state.pickup) selectCategory(state.category);
  } else {
    goto(nextScreen);
  }
}
function teardownPickerMap() {
  if (pickerMap) { pickerMap.remove(); pickerMap = null; }
}
function initPickerMap() {
  const el = $('pickerMapEl');
  if (!el || !window.L || pickerMap) return;
  const known = state.pickup || state.drop;
  const start = known || { lat: 31.5204, lng: 74.3656 }; // Lahore, used only until we get a real GPS fix
  pickerMap = L.map('pickerMapEl', { zoomControl: false, attributionControl: false }).setView([start.lat, start.lng], known ? 15 : 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(pickerMap);
  pickerMapMoveEndHandler = () => onPickerMapMoveEnd();
  pickerMap.on('moveend', pickerMapMoveEndHandler);
  if (!known && navigator.geolocation) {
    pickerGeoWatchDone = false;
    navigator.geolocation.getCurrentPosition((pos) => {
      pickerGeoWatchDone = true;
      if (pickerMap) pickerMap.setView([pos.coords.latitude, pos.coords.longitude], 16);
    }, () => { pickerGeoWatchDone = true; }, { enableHighAccuracy: true, timeout: 8000 });
  } else {
    onPickerMapMoveEnd(); // resolve an address for the initial center right away
  }
}
async function onPickerMapMoveEnd() {
  if (suppressNextMoveEnd) { suppressNextMoveEnd = false; return; }
  if (!pickerMap) return;
  const c = pickerMap.getCenter();
  const target = state.pickerTarget;
  try {
    const r = await reverseGeocode(c.lat, c.lng);
    const address = r && r.display_name ? r.display_name.split(',').slice(0, 3).join(',') : `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    state[target] = { address, lat: c.lat, lng: c.lng };
  } catch (e) {
    state[target] = { address: `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`, lat: c.lat, lng: c.lng };
  }
  patchPickerHeader();
}
function setPickerTarget(target) {
  if (state.pickerTarget === target) return;
  state.pickerTarget = target;
  patchPickerHeader();
  const loc = state[target];
  if (loc && pickerMap) { suppressNextMoveEnd = false; pickerMap.setView([loc.lat, loc.lng], Math.max(pickerMap.getZoom(), 15)); }
}
function centerMapOnMyLocation() {
  if (!navigator.geolocation) return toast('Location not available on this device');
  toast('Getting your location…');
  navigator.geolocation.getCurrentPosition((pos) => {
    if (pickerMap) pickerMap.setView([pos.coords.latitude, pos.coords.longitude], 16);
  }, () => toast('Could not get your location — enable GPS and try again'), { enableHighAccuracy: true, timeout: 10000 });
}
function renderPickerFields() {
  return `
    <div class="picker-field ${state.pickerTarget === 'pickup' ? 'active' : ''}" onclick="setPickerTarget('pickup')">
      <span class="dot g"></span><span class="txt">${state.pickup ? state.pickup.address : 'Set pickup point'}</span>
      ${state.pickerTarget === 'pickup' ? '<span class="tag">● on map</span>' : ''}
    </div>
    <div class="picker-field ${state.pickerTarget === 'drop' ? 'active' : ''}" onclick="setPickerTarget('drop')">
      <span class="dot k"></span><span class="txt">${state.drop ? state.drop.address : 'Set drop-off point'}</span>
      ${state.pickerTarget === 'drop' ? '<span class="tag">● on map</span>' : ''}
    </div>`;
}
function patchPickerHeader() {
  const el = $('pickerHeaderFields');
  if (el) el.innerHTML = renderPickerFields();
  const btn = $('pickerFooterBtn');
  if (btn) btn.disabled = !(state.pickup && state.drop);
}

let dropDebounce = null;
function renderDropSuggestionsInPlace() {
  const el = $('dropSuggestions');
  if (el) el.innerHTML = renderDropSuggestions();
}
function onDropInput(v) {
  state.dropQuery = v;
  clearTimeout(dropDebounce);
  if (v.trim().length < 3) { state.dropResults = []; renderDropSuggestionsInPlace(); return; }
  dropDebounce = setTimeout(async () => {
    try {
      const near = state.pickup || state.drop || (pickerMap ? pickerMap.getCenter() : null);
      const results = await geocodeSearch(v, near);
      state.dropResults = results.map(r => ({ label: r.display_name, lat: +r.lat, lng: +r.lon }));
    } catch (e) { state.dropResults = []; }
    renderDropSuggestionsInPlace();
  }, 550);
}
function pickDrop(i) {
  const r = state.dropResults[i];
  const address = r.label.split(',').slice(0, 3).join(',');
  state[state.pickerTarget] = { address, lat: r.lat, lng: r.lng };
  state.dropQuery = ''; state.dropResults = [];
  const input = $('dropInput'); if (input) input.value = '';
  renderDropSuggestionsInPlace();
  patchPickerHeader();
  if (pickerMap) { suppressNextMoveEnd = true; pickerMap.setView([r.lat, r.lng], 16); }
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
        payment_method: state.paymentMethod,
      },
    });
    state.activeRide = ride;
    goto('waiting');
  } catch (e) { toast(e.message); }
}
function teardownLiveMap() {
  if (liveMap) { liveMap.remove(); liveMap = null; liveMapMarker = null; liveMapRideId = null; }
}
async function cancelActiveRide() {
  if (!state.activeRide) return;
  try {
    await apiRequest(`/rides/${state.activeRide.id}/cancel`, { method: 'POST' });
    state.activeRide = null; state.pickup = null; state.drop = null; state.fareEstimate = null;
    teardownLiveMap();
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
    teardownLiveMap();
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
function startLocationBroadcast() {
  stopLocationBroadcast();
  if (!navigator.geolocation) return;
  locationWatchId = navigator.geolocation.watchPosition((pos) => {
    const now = Date.now();
    if (now - lastLocationSentAt < 8000) return;
    lastLocationSentAt = now;
    apiRequest('/driver/location', { method: 'POST', body: { lat: pos.coords.latitude, lng: pos.coords.longitude } }).catch(() => {});
  }, () => {}, { enableHighAccuracy: true });
}
function stopLocationBroadcast() {
  if (locationWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId = null;
}
async function acceptIncoming() {
  try {
    const ride = await apiRequest(`/driver/rides/${state.incomingRide.id}/accept`, { method: 'POST' });
    state.activeRide = ride; state.incomingRide = null;
    startLocationBroadcast();
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
    if (ride.status === 'completed') { stopLocationBroadcast(); toast('Trip completed'); state.activeRide = null; state.driverTab = 'home'; goto('driverHome'); }
    else refresh();
  } catch (e) { toast(e.message); }
}
async function loadDriverTab(tab) {
  state.driverTab = tab;
  try {
    if (tab === 'earnings') { state.earnings = await apiRequest('/driver/earnings'); state.wallet = await apiRequest('/driver/wallet'); }
    if (tab === 'documents') { state.documents = await apiRequest('/driver/documents'); }
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

/* ---- Driver documents ---- */
const DOC_TYPES = [
  { id: 'cnic_front', label: 'CNIC — Front' },
  { id: 'cnic_back', label: 'CNIC — Back' },
  { id: 'license', label: 'Driving License' },
  { id: 'vehicle_reg', label: 'Vehicle Registration' },
  { id: 'selfie', label: 'Selfie' },
];
function pickDocument(type) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  if (type === 'selfie') input.capture = 'user'; // forces the front camera directly, no gallery chooser
  input.onchange = () => { if (input.files[0]) uploadDocument(type, input.files[0]); };
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 1000);
}
async function uploadDocument(type, file) {
  if (file.size > 9.5 * 1024 * 1024) return toast('That photo is too large (max 10MB) — try again, some cameras save smaller sizes automatically');
  try {
    const fd = new FormData();
    fd.append('type', type);
    fd.append('file', file);
    await apiUpload('/driver/documents', fd);
    toast('Uploaded — pending review');
    loadDriverTab('documents');
  } catch (e) {
    toast(e.message === 'Failed to fetch' ? 'Upload failed — check your connection and try again' : e.message);
  }
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
    ${(inNativeApp || GOOGLE_CLIENT_ID) ? `<div class="p-sub" style="text-align:center;margin:14px 0 2px">or</div><div id="googleBtn" style="display:flex;justify-content:center"></div>` : ''}
    <div class="link" onclick="goto('driverSignup')">Drive with us — register as a driver</div>
    <div class="spacer"></div>
  </div>`;
}
function scDriverSignup() {
  return `<div class="p-pad">
    <div class="back" onclick="goto('login')">← Back</div>
    <div class="p-title">Become a driver</div>
    <div class="p-sub">Submit your details — our team reviews every application before you can go online.</div>
    <div class="field-label">Full name</div>
    <input class="field-input" id="signupName" placeholder="Your full name">
    <div class="field-label">Mobile number</div>
    <input class="field-input" id="signupPhone" type="tel" inputmode="numeric" placeholder="0300 1234567" maxlength="11">
    <div class="field-label">Vehicle</div>
    <input class="field-input" id="signupVehicle" placeholder="e.g. Honda City 2024">
    <div class="field-label">Plate number</div>
    <input class="field-input" id="signupPlate" placeholder="e.g. LEA-1234">
    <div class="field-label">Category</div>
    <select class="field-input" id="signupCategory">${CATS.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('')}</select>
    <button class="btn" style="margin-top:6px" onclick="registerDriver()">Submit application</button>
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
    <div class="field" onclick="enterSearchScreen()"><span class="dot k"></span><span class="txt muted">Where to?</span><span>🔍</span></div>
    <div class="field-label">Ride category</div>
    <div class="cat-row">${CATS.map(c => `<div class="cat-item ${state.category === c.id ? 'sel' : ''}" onclick="selectCategory('${c.id}')"><div class="cat-icon">${c.icon}</div><div class="cat-name">${c.name}</div></div>`).join('')}</div>
    <div class="spacer"></div>
    <button class="btn" onclick="enterSearchScreen()">Book a ride</button>
    <div class="btn-row">
      <button class="btn outline" style="flex:1" onclick="openHistory()">🕒 Ride history</button>
      <button class="btn outline" style="flex:1" onclick="openSupport()">🎧 Support</button>
    </div>
  </div>`;
}
function renderDropSuggestions() {
  return state.dropResults.map((r, i) => `<div class="sugg" onclick="pickDrop(${i})"><span class="ico">📍</span><div><div class="t">${r.label.split(',')[0]}</div><div class="s">${r.label.split(',').slice(1, 3).join(',')}</div></div></div>`).join('');
}
function scSearch() {
  return `<div class="picker-screen">
    <div class="picker-header">
      <div class="back" onclick="leaveSearchScreen('customerHome')">← Set your route</div>
      <div id="pickerHeaderFields">${renderPickerFields()}</div>
      <div class="picker-search-wrap">
        <input class="field-input" id="dropInput" placeholder="Search for a place or address…" value="${state.dropQuery}" oninput="onDropInput(this.value)">
        <div class="picker-suggestions" id="dropSuggestions">${renderDropSuggestions()}</div>
      </div>
    </div>
    <div class="picker-map-area">
      <div id="pickerMapEl" style="position:absolute;inset:0"></div>
      <div class="center-pin-wrap"><div class="pin-icon">📍</div><div class="pin-shadow"></div></div>
      <button class="locate-fab" onclick="centerMapOnMyLocation()" aria-label="Use my location">🎯</button>
    </div>
    <div class="picker-footer">
      <button class="btn" id="pickerFooterBtn" ${(state.pickup && state.drop) ? '' : 'disabled'} onclick="leaveSearchScreen('route')">Continue</button>
    </div>
  </div>`;
}
function scRoute() {
  const est = state.fareEstimate;
  return `<div class="p-pad">
    <div class="back" onclick="enterSearchScreen()">← Route &amp; fare</div>
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
        </div>` : state.pickup ? `<div class="spin"></div>` : `<p class="p-sub">Set your pickup point first — go back and tap the location field.</p>`}
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
    <div class="field-label">Payment method</div>
    <div class="btn-row">
      <button class="btn ${state.paymentMethod === 'cash' ? '' : 'outline'}" style="flex:1" onclick="setPaymentMethod('cash')">💵 Cash</button>
      <button class="btn ${state.paymentMethod === 'online' ? '' : 'outline'}" style="flex:1" onclick="setPaymentMethod('online')">💳 Online</button>
    </div>
    <p class="p-sub">Your booking goes to our dispatch team, who assign the closest available driver — this usually takes under a minute.</p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px"><span class="p-sub">Fare</span><span class="p-title" style="font-size:22px">PKR ${est.calculated_fare}</span></div>
    <button class="btn" onclick="bookRide()">Confirm booking</button>
  </div>`;
}
function setPaymentMethod(m) { state.paymentMethod = m; refresh(); }
/* ---- Live map (Leaflet + OSM tiles) ---- */
function initLiveMap(ride) {
  const el = $('liveMapEl');
  if (!el || !window.L) return;
  if (liveMap && liveMapRideId === ride.id) { updateLiveMapMarker(ride); return; }
  if (liveMap) { liveMap.remove(); liveMap = null; liveMapMarker = null; }
  liveMapRideId = ride.id;
  const pickup = [+ride.pickup_lat, +ride.pickup_lng];
  const drop = [+ride.drop_lat, +ride.drop_lng];
  liveMap = L.map('liveMapEl', { zoomControl: false, attributionControl: false }).fitBounds([pickup, drop], { padding: [30, 30] });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(liveMap);
  L.marker(pickup, { icon: L.divIcon({ className: '', html: '<div class="pin-marker pickup"></div>', iconSize: [14, 14] }) }).addTo(liveMap);
  L.marker(drop, { icon: L.divIcon({ className: '', html: '<div class="pin-marker drop"></div>', iconSize: [14, 14] }) }).addTo(liveMap);
  const dp = ride.driver && ride.driver.driver_profile;
  if (dp && dp.last_lat && dp.last_lng) {
    liveMapMarker = L.marker([+dp.last_lat, +dp.last_lng], { icon: L.divIcon({ className: '', html: '<div class="driver-marker">🚗</div>', iconSize: [26, 26] }) }).addTo(liveMap);
  }
}
function updateLiveMapMarker(ride) {
  if (!liveMap) return;
  const dp = ride.driver && ride.driver.driver_profile;
  if (!dp || !dp.last_lat || !dp.last_lng) return;
  const pos = [+dp.last_lat, +dp.last_lng];
  if (liveMapMarker) liveMapMarker.setLatLng(pos);
  else liveMapMarker = L.marker(pos, { icon: L.divIcon({ className: '', html: '<div class="driver-marker">🚗</div>', iconSize: [26, 26] }) }).addTo(liveMap);
}

/* ---- Chat ---- */
function openChat() { state.chatOpen = true; render(); loadChatMessages(); startChatPolling(); }
function closeChat() { state.chatOpen = false; stopChatPolling(); render(); }
async function loadChatMessages() {
  if (!state.activeRide) return;
  try {
    state.chatMessages = await apiRequest(`/rides/${state.activeRide.id}/messages`);
    const body = $('chatBody');
    if (state.chatOpen && body) { body.innerHTML = renderChatMessages(); body.scrollTop = body.scrollHeight; }
  } catch (e) { /* silent on poll */ }
}
function renderChatMessages() {
  return state.chatMessages.map(m => {
    const mine = m.sender && state.user && m.sender.id === state.user.id;
    return `<div class="chat-msg ${mine ? 'mine' : 'theirs'}">${m.message}<time>${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>`;
  }).join('') || '<div class="chat-empty">No messages yet — say hello.</div>';
}
function startChatPolling() { stopChatPolling(); chatPollTimer = setInterval(loadChatMessages, 4000); }
function stopChatPolling() { if (chatPollTimer) clearInterval(chatPollTimer); chatPollTimer = null; }
async function sendChatMessage() {
  const input = $('chatInput');
  const text = (input && input.value || '').trim();
  if (!text || !state.activeRide) return;
  input.value = '';
  try {
    await apiRequest(`/rides/${state.activeRide.id}/messages`, { method: 'POST', body: { message: text } });
    loadChatMessages();
  } catch (e) { toast(e.message); }
}
function chatOverlay() {
  const ride = state.activeRide;
  const otherName = state.role === 'driver' ? (ride.customer ? ride.customer.name : 'Rider') : (ride.driver ? ride.driver.name : 'Driver');
  return `<div class="chat-overlay">
    <div class="chat-head"><div class="back" onclick="closeChat()">← ${otherName}</div></div>
    <div class="chat-body" id="chatBody">${renderChatMessages()}</div>
    <div class="chat-input-row">
      <input id="chatInput" placeholder="Type a message…" onkeydown="if(event.key==='Enter')sendChatMessage()">
      <button onclick="sendChatMessage()">➤</button>
    </div>
  </div>`;
}

/* ---- Safety: share trip + SOS ---- */
function shareTrip() {
  const ride = state.activeRide;
  if (!ride) return;
  const text = `I'm on a Pick&Drive trip: ${ride.pickup_address} → ${ride.drop_address}. Driver: ${ride.driver ? ride.driver.name : 'assigned soon'}${ride.driver ? ', plate ' + (ride.driver.driver_profile ? ride.driver.driver_profile.plate_number : '') : ''}.`;
  if (navigator.share) {
    navigator.share({ title: 'My Pick&Drive trip', text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('Trip details copied — paste to share'));
  } else {
    toast(text);
  }
}
function triggerSos() {
  const ride = state.activeRide;
  if (!ride) return;
  const ok = confirm(
    `This will call ${safetyContactNumber}.\n\n` +
    `Pick&Drive does not monitor rides live — for a real emergency, this call is the fastest way to get help. ` +
    `We will also flag this trip to our team afterward.`
  );
  if (!ok) return;
  apiRequest(`/rides/${ride.id}/sos`, { method: 'POST' }).catch(() => {}); // best-effort trip flag, not the safety response itself
  window.location.href = 'tel:' + safetyContactNumber;
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
  if (!ride || !ride.id) return `<div class="p-pad"><div class="spacer"></div><div class="spin" style="margin:0 auto"></div><div class="spacer"></div></div>`;
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
  if (!ride || !ride.id) return scWaiting();
  const driver = ride.driver || {};
  return `<div class="p-pad" style="gap:12px">
    <div class="back" onclick="goto('waiting')">Trip status</div>
    <div id="liveMapEl" class="live-map"></div>
    <div id="stepListWrap" style="width:100%;text-align:left;background:var(--fill);border-radius:14px;padding:6px 12px">${rideStatusSteps(ride.status)}</div>
    <div class="driver-card">
      <div class="driver-row2"><div class="avatar">${(driver.name || 'D').slice(0, 1)}</div><div class="driver-info"><div class="t">${driver.name || 'Your driver'}</div><div class="s">★ ${driver.rating || '—'}</div></div>
      <button class="pill" style="margin-left:auto;border:0;cursor:pointer" onclick="openChat()">💬 Chat</button></div>
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="p-sub">Fare</span><span class="p-title" style="font-size:16px">PKR ${ride.calculated_fare}</span></div>
    </div>
    <div class="safety-row">
      <button onclick="shareTrip()">📍 Share trip</button>
      <button class="sos" onclick="triggerSos()">🆘 SOS</button>
    </div>
    <p class="p-sub" style="text-align:center;font-size:10.5px">SOS calls ${safetyContactNumber} directly — not a monitored live safety line.</p>
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

/* ---- Ride history ---- */
async function openHistory() {
  goto('history');
  try {
    const page = await apiRequest('/rides/mine/history');
    state.rideHistory = page.data || page;
  } catch (e) { toast(e.message); }
  refresh();
}
function scHistory() {
  const statusLabel = { completed: 'Completed', rated: 'Completed', cancelled: 'Cancelled' };
  const rows = state.rideHistory.map(r => `<div class="card2" style="margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:13px">${r.pickup_address.split(',')[0]} → ${r.drop_address.split(',')[0]}</b><span class="pill">${statusLabel[r.status] || r.status}</span></div>
    <div class="p-sub" style="margin-top:6px">${new Date(r.created_at).toLocaleDateString()} · PKR ${r.final_fare || r.calculated_fare} · ${r.payment_method}</div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn outline" style="flex:1;padding:9px;font-size:11px" onclick="openComplaintForRide(${r.id})">Report an issue</button>
      ${r.payment_method === 'online' && r.payment_status === 'paid' ? `<button class="btn outline" style="flex:1;padding:9px;font-size:11px" onclick="requestRideRefund(${r.id})">Request refund</button>` : ''}
    </div>
  </div>`).join('') || '<div class="empty2"><h2>No past rides yet</h2><p>Your completed and cancelled rides will show up here.</p></div>';
  return `<div class="p-pad">
    <div class="back" onclick="goto('customerHome')">← Ride history</div>
    <div style="overflow-y:auto">${rows}</div>
  </div>`;
}
async function requestRideRefund(rideId) {
  try {
    await apiRequest(`/rides/${rideId}/refund-request`, { method: 'POST' });
    toast('Refund requested — our team will review it');
    openHistory();
  } catch (e) { toast(e.message); }
}

/* ---- Support / complaints ---- */
function openComplaintForRide(rideId) { state.complaintRideId = rideId; goto('support'); }
async function openSupport() {
  state.complaintRideId = null;
  goto('support');
  try { state.complaints = await apiRequest('/complaints/mine'); } catch (e) {}
  refresh();
}
async function submitComplaint() {
  const subject = ($('complaintSubject') && $('complaintSubject').value || '').trim();
  const message = ($('complaintMessage') && $('complaintMessage').value || '').trim();
  if (!subject || !message) return toast('Enter a subject and message');
  try {
    await apiRequest('/complaints', { method: 'POST', body: { subject, message, ride_id: state.complaintRideId } });
    toast('Sent — our team will get back to you');
    state.complaintRideId = null;
    openSupport();
  } catch (e) { toast(e.message); }
}
function scSupport() {
  const statusLabel = { open: 'Open', resolved: 'Resolved' };
  const list = state.complaints.map(c => `<div class="card2" style="margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:13px">${c.subject}</b><span class="pill">${statusLabel[c.status]}</span></div>
    <p class="p-sub" style="margin-top:6px">${c.message}</p>
    ${c.admin_note ? `<p class="p-sub" style="margin-top:6px;color:var(--ink)"><b>Our reply:</b> ${c.admin_note}</p>` : ''}
  </div>`).join('') || '<p class="p-sub">No previous messages.</p>';
  return `<div class="p-pad">
    <div class="back" onclick="goto('customerHome')">← Support</div>
    ${state.complaintRideId ? `<p class="p-sub">Reporting an issue for ride #${state.complaintRideId}</p>` : ''}
    <div class="field-label">Subject</div>
    <input class="field-input" id="complaintSubject" placeholder="What's this about?">
    <div class="field-label">Message</div>
    <input class="field-input" id="complaintMessage" placeholder="Tell us what happened">
    <button class="btn" onclick="submitComplaint()">Send to our team</button>
    <div class="field-label" style="margin-top:14px">Previous messages</div>
    ${list}
  </div>`;
}

/* ---- Screens: driver ---- */
function scDriverHome() {
  const ride = state.incomingRide;
  const active = state.activeRide;
  const pending = state.user && state.user.status === 'pending_approval';
  return `<div class="p-pad" style="gap:14px">
    <div class="topbar2"><span class="brandmark">🔑 Pick&amp;Drive</span><span class="link" onclick="logout()">Sign out</span></div>
    ${pending
      ? `<div class="card2"><b>Application under review</b><div class="p-sub">We're reviewing your documents and details. You'll be able to go online once approved.</div></div>`
      : `<div class="card2" style="display:flex;justify-content:space-between;align-items:center">
      <div><b>${state.driverOnline ? 'You are online' : 'You are offline'}</b><div class="p-sub">${state.driverOnline ? 'Waiting for ride requests' : 'Go online to start receiving rides'}</div></div>
      <div class="switch ${state.driverOnline ? 'on' : ''}" onclick="toggleOnline()"><div class="knob"></div></div>
    </div>`}
    ${active ? driverActiveCard(active) : ''}
    ${ride && !active ? `<div class="card2">
        <span class="pill">NEW RIDE REQUEST</span>
        <div class="p-title" style="margin-top:8px;font-size:16px">PKR ${ride.calculated_fare} · ${ride.category}</div>
        <div class="p-sub">${ride.pickup_address} → ${ride.drop_address} · ${ride.distance_km} km</div>
        <div class="btn-row" style="margin-top:10px"><button class="btn" style="flex:1" onclick="acceptIncoming()">Accept</button><button class="btn outline" style="flex:1" onclick="rejectIncoming()">Decline</button></div>
      </div>` : ''}
    ${!ride && !active && !pending ? `<div class="empty2"><h2>${state.driverOnline ? 'Waiting for a ride…' : 'You are offline'}</h2><p>${state.driverOnline ? 'New requests will appear here automatically.' : 'Flip the switch above to start receiving rides.'}</p></div>` : ''}
    <div class="spacer"></div>
  </div>`;
}
function driverActiveCard(ride) {
  const nextLabel = { accepted: 'Mark arriving', arriving: 'Mark arrived', arrived: 'Start trip', in_progress: 'Complete trip' };
  return `<div class="card2">
    <div style="display:flex;align-items:center;justify-content:space-between"><span class="pill">ACTIVE TRIP</span><button class="pill" style="border:0;cursor:pointer" onclick="openChat()">💬 ${ride.customer ? ride.customer.name : 'Rider'}</button></div>
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

function scDriverDocuments() {
  const statusLabel = { pending: 'Pending review', verified: 'Verified', rejected: 'Rejected — re-upload' };
  return `<div class="p-pad" style="gap:14px">
    <div class="p-title">Documents</div>
    <p class="p-sub">Upload clear photos of each document. Our team reviews them before you can go online.</p>
    ${DOC_TYPES.map(dt => {
      const doc = state.documents.find(d => d.type === dt.id);
      const badge = doc ? statusLabel[doc.status] || doc.status : 'Not uploaded';
      const badgeColor = doc && doc.status === 'verified' ? 'var(--green-ink)' : doc && doc.status === 'rejected' ? 'var(--red-ink)' : 'var(--muted)';
      return `<div class="card2" style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${dt.label}</b><div class="p-sub" style="color:${badgeColor}">${badge}</div></div>
        <button class="btn outline" style="width:auto;padding:9px 14px" onclick="pickDocument('${dt.id}')">${doc ? 'Re-upload' : 'Upload'}</button>
      </div>`;
    }).join('')}
  </div>`;
}

/* ---- Android hardware/gesture back button ----
   The app never does real URL navigation (it's a single innerHTML SPA), so
   WebView.canGoBack() is always false. MainActivity calls this instead so
   back steps through in-app screens rather than exiting the app. */
function screenBack() {
  if (state.chatOpen) { closeChat(); return true; }
  if (state.screen === 'search') { leaveSearchScreen('customerHome'); return true; }
  if (state.screen === 'route') { enterSearchScreen(); return true; }
  const map = { otp: 'login', driverSignup: 'login', confirm: 'route', history: 'customerHome', support: 'customerHome' };
  if (map[state.screen]) { goto(map[state.screen]); return true; }
  if (state.role === 'driver' && state.driverTab !== 'home') { loadDriverTab('home'); return true; }
  return false;
}
window.screenBack = screenBack;

/* ---- Root render ---- */
function tabContent() {
  if (state.driverTab === 'earnings') return scDriverEarnings();
  if (state.driverTab === 'documents') return scDriverDocuments();
  return scDriverHome();
}
function driverShell() {
  return `${tabContent()}
  <div class="bottom-nav">
    <button class="${state.driverTab === 'home' ? 'active' : ''}" onclick="loadDriverTab('home')">🚦<span>Home</span></button>
    <button class="${state.driverTab === 'documents' ? 'active' : ''}" onclick="loadDriverTab('documents')">📄<span>Documents</span></button>
    <button class="${state.driverTab === 'earnings' ? 'active' : ''}" onclick="loadDriverTab('earnings')">💰<span>Earnings</span></button>
  </div>`;
}
const SCREENS = {
  login: scLogin, otp: scOtp, driverSignup: scDriverSignup,
  customerHome: scCustomerHome, search: scSearch, route: scRoute, confirm: scConfirm,
  waiting: scWaiting, tracking: scTracking, rate: scRate,
  history: scHistory, support: scSupport,
};
function render() {
  const root = $('root');
  if (state.role === 'driver' && state.token) {
    root.innerHTML = driverShell() + (state.chatOpen && state.activeRide ? chatOverlay() : '');
    scrollChatToBottom();
    return;
  }
  if (state.token && state.screen === 'login') state.screen = 'customerHome';
  root.innerHTML = (SCREENS[state.screen] || scLogin)() + (state.chatOpen && state.activeRide ? chatOverlay() : '');
  if (state.screen === 'otp') { const f = $('otp0'); if (f) f.focus(); }
  if (state.screen === 'login') mountGoogleButton();
  if (state.screen === 'tracking' && state.activeRide) setTimeout(() => initLiveMap(state.activeRide), 0);
  if (state.screen === 'search') setTimeout(() => initPickerMap(), 0);
  scrollChatToBottom();
}
function scrollChatToBottom() {
  const body = $('chatBody');
  if (body) body.scrollTop = body.scrollHeight;
}
function refresh() { render(); }

if (state.token) {
  state.screen = state.role === 'driver' ? 'driverHome' : 'customerHome';
  render();
  startPolling();
  loadCategories(); loadSafetyContact();
} else {
  render();
}
