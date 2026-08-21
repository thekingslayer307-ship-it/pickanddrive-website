/* Pick&Drive Admin Console — standalone back-office web app, talking to the
   real Laravel API on the VPS. Every screen only reads/writes through AdminApi. */

const API_BASE = 'https://api.pickanddrive.pk/api/v1';
const GOOGLE_CLIENT_ID = ''; // TODO: fill in once a Google Cloud OAuth client exists
const KEY = 'pickanddrive-admin-v1';

function seedState() {
  return {
    loggedIn: false,
    adminName: '',
    token: null,
    tab: 'dispatch',
    dispatch: { pending: [], dispatched: [] },
    drivers: [],
    expandedDriver: null,
    detail: null,
    customers: [],
    coupons: [],
    announcements: [],
    settings: { commission_rate: 0.15, surge_multiplier: 1, total_commission_collected: 0, fare_settings: [] },
    notifications: [], notifPanelOpen: false,
    withdrawals: [], complaints: [],
    liveMapRides: [], liveMapOnlineDrivers: [],
    reportRides: { data: [] }, revenueReport: null, reportFilters: { status: '', category: '', from: '', to: '' },
  };
}

let state = JSON.parse(localStorage.getItem(KEY) || 'null') || seedState();
const save = () => localStorage.setItem(KEY, JSON.stringify(state));
const notify = (msg) => {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(notify._t);
  notify._t = setTimeout(() => t.classList.remove('show'), 2400);
};

/* ---- Data layer: every network call to the real backend lives here ---- */
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
  if (res.status === 401) {
    state.loggedIn = false;
    state.token = null;
    save();
    render();
    throw new Error('Session expired — please sign in again');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

const AdminApi = {
  async loginPassword(email, password) {
    const data = await apiRequest('/auth/admin/login', { method: 'POST', body: { email, password } });
    return { token: data.token, name: data.user.name };
  },
  async loginGoogle(idToken) {
    const data = await apiRequest('/auth/google', { method: 'POST', body: { id_token: idToken } });
    return { token: data.token, name: data.user.name };
  },
  /** Refresh only the slices an action actually invalidated. Every action used to await a full
   *  8-endpoint reload before the UI moved at all, which is what made the console feel like it
   *  hung for a moment after every click. */
  async refresh(...keys) {
    const SLICES = {
      dispatch: ['/admin/dispatch/queue', (v) => { state.dispatch = v; }],
      drivers: ['/admin/drivers', (v) => { state.drivers = v; }],
      customers: ['/admin/customers', (v) => { state.customers = v; }],
      coupons: ['/admin/coupons', (v) => { state.coupons = v; }],
      announcements: ['/admin/announcements', (v) => { state.announcements = v; }],
      settings: ['/admin/settings', (v) => { state.settings = v; }],
      withdrawals: ['/admin/withdrawals', (v) => { state.withdrawals = v; }],
      complaints: ['/admin/complaints', (v) => { state.complaints = v; }],
    };
    const wanted = keys.length ? keys : Object.keys(SLICES);
    await Promise.all(wanted.map(async (k) => {
      const slice = SLICES[k];
      if (!slice) return;
      slice[1](await apiRequest(slice[0]));
    }));
    save();
  },
  async refreshAll() {
    await AdminApi.refresh();
  },
  async createCategory(body) {
    await apiRequest('/admin/settings/fare', { method: 'POST', body });
    await AdminApi.refresh('settings');
  },
  async updateCategory(id, body) {
    await apiRequest(`/admin/settings/fare/${id}`, { method: 'PATCH', body });
    await AdminApi.refresh('settings');
  },
  async deleteCategory(id) {
    await apiRequest(`/admin/settings/fare/${id}`, { method: 'DELETE' });
    await AdminApi.refresh('settings');
  },
  async approveWithdrawal(id) {
    await apiRequest(`/admin/withdrawals/${id}/approve`, { method: 'POST' });
    await AdminApi.refresh('withdrawals', 'drivers');
  },
  async rejectWithdrawal(id) {
    await apiRequest(`/admin/withdrawals/${id}/reject`, { method: 'POST' });
    await AdminApi.refresh('withdrawals', 'drivers');
  },
  async resolveComplaint(id, adminNote) {
    await apiRequest(`/admin/complaints/${id}/resolve`, { method: 'POST', body: { admin_note: adminNote } });
    await AdminApi.refresh('complaints');
  },
  async loadReportRides() {
    const f = state.reportFilters;
    const params = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    state.reportRides = await apiRequest(`/admin/rides${params ? '?' + params : ''}`);
    save();
  },
  async loadRevenueReport() {
    state.revenueReport = await apiRequest('/admin/reports/revenue');
    save();
  },
  async loadLiveMap() {
    const res = await apiRequest('/admin/live-map');
    state.liveMapRides = res.rides || [];
    state.liveMapOnlineDrivers = res.online_drivers || [];
    save();
  },
  async assignDriver(rideId, driverId) {
    await apiRequest(`/admin/rides/${rideId}/assign`, { method: 'POST', body: { driver_id: driverId } });
    await AdminApi.refresh('dispatch', 'drivers');
  },
  async reassign(rideId) {
    await apiRequest(`/admin/rides/${rideId}/reassign`, { method: 'POST' });
    await AdminApi.refresh('dispatch', 'drivers');
  },
  async cancelRide(rideId) {
    await apiRequest(`/admin/rides/${rideId}/cancel`, { method: 'POST' });
    await AdminApi.refresh('dispatch');
  },
  async toggleDriverOnline(id) {
    const d = state.drivers.find((x) => x.id === id);
    const online = !(d && d.driver_profile && d.driver_profile.online);
    // Admin can't directly flip a driver's own toggle server-side (that's the driver's own action);
    // this stays a no-op call placeholder until a real "force offline" admin endpoint is added.
    notify('Drivers control their own online status — this view is read-only for now');
  },
  async issuePenalty(id) {
    await apiRequest(`/admin/drivers/${id}/penalty`, { method: 'POST', body: { reason: 'Penalty issued from admin console' } });
    await AdminApi.refresh('drivers');
  },
  async approveDriver(id) {
    await apiRequest(`/admin/drivers/${id}/approve`, { method: 'POST' });
    await AdminApi.refresh('drivers');
  },
  async suspendDriver(id) {
    await apiRequest(`/admin/drivers/${id}/suspend`, { method: 'POST' });
    await AdminApi.refresh('drivers');
  },
  async verifyDocument(docId, status) {
    await apiRequest(`/admin/documents/${docId}/verify`, { method: 'POST', body: { status } });
    await AdminApi.refresh('drivers');
  },
  async toggleBlacklist(key, blocked) {
    await apiRequest(`/admin/customers/${key}/${blocked ? 'unblock' : 'block'}`, { method: 'POST' });
    await AdminApi.refresh('customers');
  },
  async updateCustomer(id, body) {
    await apiRequest(`/admin/customers/${id}`, { method: 'PATCH', body });
    await AdminApi.refresh('customers');
  },
  async updateDriver(id, body) {
    await apiRequest(`/admin/drivers/${id}`, { method: 'PATCH', body });
    await AdminApi.refresh('drivers');
  },
  async loadEntityRides(type, id) {
    const res = await apiRequest(`/admin/rides?${type}_id=${id}`);
    return res.data || [];
  },
  async toggleCoupon(code) {
    const c = state.coupons.find((x) => x.code === code);
    if (!c) return;
    await apiRequest(`/admin/coupons/${c.id}/toggle`, { method: 'POST' });
    await AdminApi.refresh('coupons');
  },
  async createCoupon(code, discount, type) {
    if (state.coupons.some((c) => c.code === code)) return false;
    await apiRequest('/admin/coupons', { method: 'POST', body: { code, discount, type } });
    await AdminApi.refresh('coupons');
    return true;
  },
  async deleteCoupon(code) {
    const c = state.coupons.find((x) => x.code === code);
    if (!c) return;
    await apiRequest(`/admin/coupons/${c.id}`, { method: 'DELETE' });
    await AdminApi.refresh('coupons');
  },
  async broadcastAnnouncement(title, body) {
    await apiRequest('/admin/announcements', { method: 'POST', body: { title, body } });
    await AdminApi.refresh('announcements');
  },
  async setCommission(delta) {
    const next = Math.max(0, Math.min(0.4, +(state.settings.commission_rate + delta).toFixed(2)));
    await apiRequest('/admin/settings', { method: 'PATCH', body: { commission_rate: next } });
    await AdminApi.refresh('settings');
  },
  async setSurge(delta) {
    const next = Math.max(1, Math.min(2.5, +(state.settings.surge_multiplier + delta).toFixed(1)));
    await apiRequest('/admin/settings', { method: 'PATCH', body: { surge_multiplier: next } });
    await AdminApi.refresh('settings');
  },
  async setSafetyContact(number) {
    await apiRequest('/admin/settings', { method: 'PATCH', body: { safety_contact_number: number } });
    await AdminApi.refresh('settings');
  },
};

/* ---- Icons (inline, no external deps) ---- */
const ICONS = {
  dispatch: '<path d="M12 2 4 5v6c0 5 3.4 9 8 11 4.6-2 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-5"/>',
  drivers: '<circle cx="12" cy="8" r="4"/><path d="M5 21c.6-4.3 3-7 7-7s6.4 2.7 7 7"/>',
  customers: '<circle cx="9" cy="8" r="3"/><path d="M2 20c.5-3.5 2.5-6 7-6s6.5 2.5 7 6"/><circle cx="18" cy="9" r="2.4"/><path d="M15.5 20c.4-2.6 1.6-4.2 4-4.6"/>',
  coupons: '<path d="M20 13 13 20 3 10V3h7l10 10Z"/><circle cx="7" cy="7" r="1"/>',
  announcements: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  commission: '<path d="M4 6h15a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13"/><path d="M16 10h5v4h-5a2 2 0 0 1 0-4Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  categories: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><circle cx="17" cy="15" r="1.4"/>',
  complaints: '<path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4A9 9 0 0 1 4 20l-1 1 1-4A8.4 8.4 0 1 1 21 11.5Z"/>',
  reports: '<path d="M4 20V10M12 20V4M20 20v-7"/>',
  map: '<path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/>',
  inbox: '<path d="m22 12-4 0-2 3h-8l-2-3-4 0"/><path d="M5.5 5.5h13l3.5 6.5v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7l3.5-6.5Z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};
function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}
const AVATAR_HUES = ['#e3b24c', '#7fa5d3', '#7fd39a', '#d38a7f', '#b491d3', '#6bc4c4'];
function avatarChip(name, id, size = 38) {
  const initials = (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const hue = AVATAR_HUES[Math.abs(Number(id) || initials.charCodeAt(0)) % AVATAR_HUES.length];
  return `<div class="avatar-chip" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.34)}px;background:${hue}">${initials}</div>`;
}

/* ---- Auth screen ---- */
function authScreen() {
  return `<div class="auth-screen"><div class="auth-box">
    <div class="brand-row"><img src="assets/app-icon.svg" alt=""><b>Pick&amp;Drive</b></div>
    <h1>Admin Console</h1>
    <p class="sub">Sign in to manage dispatch, drivers, coupons and commission.</p>
    <div class="field"><label>ADMIN EMAIL</label><input id="loginEmail" value="dispatch@pickanddrive.pk"></div>
    <div class="field"><label>PASSWORD</label><input id="loginPassword" type="password"></div>
    <button class="btn-primary" onclick="doLogin()">Sign in</button>
    ${GOOGLE_CLIENT_ID ? '<div id="googleBtn" style="margin-top:14px;display:flex;justify-content:center"></div>' : ''}
    <p class="auth-note">Connected to the live Pick&amp;Drive API.</p>
  </div></div>`;
}
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  if (!email || !password) return notify('Enter an email and password');
  try {
    const res = await AdminApi.loginPassword(email, password);
    await finishLogin(res);
  } catch (e) {
    notify(e.message);
  }
}
async function handleGoogleCredential(response) {
  try {
    const res = await AdminApi.loginGoogle(response.credential);
    await finishLogin(res);
  } catch (e) {
    notify(e.message);
  }
}
async function finishLogin(res) {
  state.loggedIn = true;
  state.token = res.token;
  state.adminName = res.name;
  save();
  try {
    await AdminApi.refreshAll();
  } catch (e) {
    notify(e.message);
  }
  render();
  startPolling();
}
function doLogout() {
  state.loggedIn = false;
  state.token = null;
  save();
  stopPolling();
  render();
}
if (GOOGLE_CLIENT_ID && window.google) {
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
}
function mountGoogleButton() {
  if (GOOGLE_CLIENT_ID && window.google && document.getElementById('googleBtn')) {
    google.accounts.id.renderButton(document.getElementById('googleBtn'), { theme: 'outline', size: 'large', width: 320 });
  }
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!state.loggedIn) return;
    apiRequest('/admin/dispatch/queue').then((q) => { state.dispatch = q; save(); if (state.tab === 'dispatch') render(); }).catch(() => {});
    // Drivers go online/offline in real time — the dispatch tab's "Assign a driver" list is
    // built from this same state.drivers snapshot, so it needs refreshing too, not just the queue.
    apiRequest('/admin/drivers').then((d) => { state.drivers = d; save(); if (state.tab === 'dispatch' || state.tab === 'drivers') render(); }).catch(() => {});
    apiRequest('/notifications').then((n) => { state.notifications = n; save(); if (state.notifPanelOpen) render(); else renderBellBadge(); }).catch(() => {});
  }, 8000);
}
function renderBellBadge() {
  const el = document.getElementById('notifBadge');
  const count = state.notifications.filter((n) => !n.read).length;
  if (el) { el.style.display = count ? 'flex' : 'none'; el.textContent = count > 9 ? '9+' : String(count); }
}
async function toggleNotifPanel() {
  state.notifPanelOpen = !state.notifPanelOpen;
  if (state.notifPanelOpen) {
    try { state.notifications = await apiRequest('/notifications'); } catch (e) {}
    apiRequest('/notifications/read', { method: 'POST' }).then(() => {
      state.notifications = state.notifications.map((n) => ({ ...n, read: true }));
      save();
    }).catch(() => {});
  }
  render();
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ---- App shell ---- */
const TABS = [
  ['dispatch', 'Dispatch', 'dispatch'],
  ['livemap', 'Live Map', 'map'],
  ['drivers', 'Drivers', 'drivers'],
  ['customers', 'Customers', 'customers'],
  ['categories', 'Ride Categories', 'categories'],
  ['coupons', 'Coupons', 'coupons'],
  ['withdrawals', 'Withdrawals', 'wallet'],
  ['complaints', 'Complaints', 'complaints'],
  ['reports', 'Reports', 'reports'],
  ['announcements', 'Announcements', 'announcements'],
  ['commission', 'Commission & surge', 'commission'],
];
function setTab(tab) {
  state.tab = tab; save(); render();
  if (tab === 'livemap') AdminApi.loadLiveMap().then(render).catch(() => {});
  if (tab === 'reports') { AdminApi.loadReportRides().then(render).catch(() => {}); AdminApi.loadRevenueReport().then(render).catch(() => {}); }
}

function shell() {
  const hasPending = state.dispatch.pending.length > 0;
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand-row"><img src="assets/app-icon.svg" alt=""><div><b>Pick&amp;Drive</b><small>ADMIN CONSOLE</small></div></div>
      <nav>${TABS.map(([id, label, ic]) => `<button class="nav-link ${state.tab === id ? 'active' : ''}" onclick="setTab('${id}')">${icon(ic)}<span>${label}</span>${id === 'dispatch' && hasPending ? '<span class="dot"></span>' : ''}</button>`).join('')}</nav>
      <div class="sidebar-foot">
        <div class="sidebar-user"><div class="avatar">${(state.adminName || 'A').slice(0, 1)}</div><div><b>${state.adminName}</b><small>Dispatcher</small></div></div>
        <button class="signout-btn" onclick="doLogout()">${icon('logout', 14)} Sign out</button>
      </div>
    </aside>
    <main class="main">
      ${topbar()}
      <div class="content">${tabContent()}</div>
    </main>
    ${detailModal()}
  </div>`;
}
function topbar() {
  const titles = { dispatch: ['Dispatch queue', 'Assign drivers to incoming ride requests'], livemap: ['Live map', 'All rides currently in progress'], drivers: ['Drivers', 'Monitor performance and manage penalties'], customers: ['Customers', 'Manage rider accounts and the blacklist'], categories: ['Ride categories', 'Configure the categories riders can book'], coupons: ['Coupons', 'Create and manage promo codes'], withdrawals: ['Withdrawals', 'Review driver wallet withdrawal requests'], complaints: ['Complaints', 'Support messages from riders and drivers'], reports: ['Reports', 'Ride history and revenue reporting'], announcements: ['Announcements', 'Broadcast messages to every rider and driver'], commission: ['Commission & surge', 'Platform fee and demand pricing controls'] };
  const [title, sub] = titles[state.tab] || ['', ''];
  const unread = state.notifications.filter((n) => !n.read).length;
  return `<div class="topbar"><div><h1>${title}</h1><p>${sub}</p></div><div class="topbar-actions">
    <span class="pill-btn">${icon('wallet', 13)} PKR ${(state.settings.total_commission_collected || 0).toLocaleString()} collected</span>
    <button class="bell-btn" onclick="toggleNotifPanel()" aria-label="Notifications">${icon('bell', 15)}<span id="notifBadge" class="bell-badge" style="display:${unread ? 'flex' : 'none'}">${unread > 9 ? '9+' : unread}</span></button>
    <button class="topbar-signout" onclick="doLogout()" aria-label="Sign out">${icon('logout', 16)}</button>
  </div></div>${state.notifPanelOpen ? notifPanel() : ''}`;
}
function notifPanel() {
  const rows = state.notifications.map((n) => {
    const urgent = /SOS/i.test(n.title);
    return `<div class="notif-row ${urgent ? 'urgent' : ''}"><b>${n.title}</b><p>${n.body || ''}</p><time>${new Date(n.created_at).toLocaleString()}</time></div>`;
  }).join('') || '<p class="muted" style="padding:16px">No notifications yet.</p>';
  return `<div class="notif-panel"><div class="notif-panel-head"><b>Notifications</b><button class="link-btn" onclick="toggleNotifPanel()">Close</button></div><div class="notif-panel-body">${rows}</div></div>`;
}
function tabContent() {
  return {
    dispatch: dispatchTab, drivers: driversTab, customers: customersTab, coupons: couponsTab,
    announcements: announcementsTab, commission: commissionTab,
    livemap: liveMapTab, categories: categoriesTab, withdrawals: withdrawalsTab, complaints: complaintsTab, reports: reportsTab,
  }[state.tab]();
}

/* ---- Dispatch tab ---- */
function dispatchTab() {
  const pending = state.dispatch.pending || [];
  const dispatched = state.dispatch.dispatched || [];
  const online = state.drivers.filter((d) => d.driver_profile && d.driver_profile.online);

  if (!pending.length && !dispatched.length) {
    return `<div class="empty-state">${icon('dispatch', 40)}<h2>No rides waiting on dispatch</h2><p>New requests from the rider app will appear here the moment a customer books.</p></div>`;
  }

  return [
    ...pending.map((r) => `<div class="card dispatch-request">
      <span class="status-pill">NEW REQUEST · AWAITING DISPATCH</span>
      <h2>PKR ${r.calculated_fare} · ${r.category}</h2>
      <p class="muted">${r.customer ? r.customer.name : 'Rider'} · ${r.pickup_address} → ${r.drop_address} · ${r.distance_km} km</p>
      <h3 style="margin:18px 0 10px;font-size:11px;letter-spacing:.5px;color:var(--muted);text-transform:uppercase">Assign a driver</h3>
      ${online.map((d) => `<div class="driver-row">${avatarChip(d.name, d.id, 44)}<div class="info"><b>${d.name}</b><small>★ ${d.rating} · ${d.driver_profile.vehicle_model || 'Vehicle'} · online</small></div><button class="btn-sm" onclick="assignDriver(${r.id},${d.id})">Assign</button></div>`).join('') || '<p class="muted">No drivers are online right now.</p>'}
      <button class="pill-btn" style="margin-top:10px" onclick="cancelDispatchRide(${r.id})">Cancel this request</button>
    </div>`),
    ...dispatched.map((r) => `<div class="card dispatch-request">
      <span class="status-pill">WAITING ON DRIVER RESPONSE</span>
      <h2>Dispatched to ${r.driver ? r.driver.name : 'driver'}</h2>
      <p class="muted">${r.pickup_address} → ${r.drop_address} · PKR ${r.calculated_fare}</p>
      <button class="pill-btn" onclick="reassignRide(${r.id})">Reassign to a different driver</button>
    </div>`),
  ].join('');
}
async function assignDriver(rideId, driverId) { try { await AdminApi.assignDriver(rideId, driverId); notify('Driver assigned'); render(); } catch (e) { notify(e.message); } }
async function reassignRide(rideId) { try { await AdminApi.reassign(rideId); notify('Ride returned to the queue'); render(); } catch (e) { notify(e.message); } }
async function cancelDispatchRide(rideId) { try { await AdminApi.cancelRide(rideId); notify('Request cancelled'); render(); } catch (e) { notify(e.message); } }

/* ---- Drivers tab ---- */
const DOC_LABELS = { cnic_front: 'CNIC — Front', cnic_back: 'CNIC — Back', license: 'Driving License', vehicle_reg: 'Vehicle Registration', selfie: 'Selfie' };
function driversTab() {
  if (!state.drivers.length) return `<div class="empty-state">${icon('drivers', 40)}<h2>No drivers yet</h2><p>Driver accounts will appear here once they sign up.</p></div>`;
  return `<div class="card"><table class="data-table"><thead><tr><th>Driver</th><th>Account</th><th>Online</th><th>Rating</th><th>Strikes</th><th></th></tr></thead><tbody>
    ${state.drivers.map((d) => { const p = d.driver_profile || {}; const docs = d.driver_documents || [];
      const accountBadge = d.status === 'active' ? '<span class="badge on">Active</span>' : d.status === 'suspended' ? '<span class="badge off">Suspended</span>' : '<span class="badge warn">Pending approval</span>';
      return `<tr class="clickable" onclick="openDetail('driver',${d.id})">
      <td data-label="Driver"><div class="table-driver">${avatarChip(d.name, d.id)}<div><b>${d.name}</b><small style="color:var(--muted)">${p.vehicle_model || '—'} · ${p.plate_number || '—'} · ${p.category || '—'}</small></div></div></td>
      <td data-label="Account">${accountBadge}</td>
      <td data-label="Online"><span class="badge ${p.online ? 'on' : 'off'}">${p.online ? 'Online' : 'Offline'}</span></td>
      <td data-label="Rating">${d.rating} ★</td>
      <td data-label="Strikes">${p.strikes ?? 0}</td>
      <td data-label="">
        <div class="action-group">
        <button class="link-btn" onclick="event.stopPropagation();toggleDriverDocs(${d.id})">${icon('image', 12)} ${state.expandedDriver === d.id ? 'Hide' : 'Docs'} (${docs.length}/5)</button>
        ${d.status === 'pending_approval' ? `<button class="link-btn primary" onclick="event.stopPropagation();approveDriver(${d.id})">${icon('check', 12)} Approve</button>` : ''}
        ${d.status !== 'suspended' ? `<button class="link-btn danger" onclick="event.stopPropagation();suspendDriver(${d.id})">${icon('pause', 12)} Suspend</button>` : `<button class="link-btn primary" onclick="event.stopPropagation();approveDriver(${d.id})">${icon('check', 12)} Reactivate</button>`}
        <button class="link-btn" onclick="event.stopPropagation();issuePenalty(${d.id})">${icon('alert', 12)} Penalty</button>
        </div>
      </td>
    </tr>
    ${state.expandedDriver === d.id ? `<tr><td colspan="6" class="docs-row" style="padding:0 0 16px 2px"><div class="grid grid-3" style="gap:10px">
      ${Object.keys(DOC_LABELS).map((type) => {
        const doc = docs.find((x) => x.type === type);
        if (!doc) return `<div class="doc-card empty">${icon('image', 26)}<span>Not uploaded</span></div>`;
        const statusClass = doc.status === 'verified' ? 'on' : doc.status === 'rejected' ? '' : 'warn';
        const statusColor = doc.status === 'verified' ? '#7fd39a' : doc.status === 'rejected' ? '#e08a7d' : 'var(--accent)';
        return `<div class="doc-card">
          <b>${DOC_LABELS[type]}</b>
          <a class="doc-thumb-wrap" href="https://api.pickanddrive.pk/storage/${doc.file_path}" target="_blank"><img src="https://api.pickanddrive.pk/storage/${doc.file_path}" alt=""></a>
          <p class="doc-status" style="color:${statusColor}">${doc.status}</p>
          <div class="doc-actions">
            <button class="link-btn primary" onclick="verifyDoc(${doc.id},'verified')">${icon('check', 12)} Verify</button>
            <button class="link-btn danger" onclick="verifyDoc(${doc.id},'rejected')">${icon('x', 12)} Reject</button>
          </div>
        </div>`;
      }).join('')}
    </div></td></tr>` : ''}`; }).join('')}
  </tbody></table></div>`;
}
function toggleDriverDocs(id) { state.expandedDriver = state.expandedDriver === id ? null : id; render(); }
async function approveDriver(id) { try { await AdminApi.approveDriver(id); notify('Driver approved'); render(); } catch (e) { notify(e.message); } }
async function suspendDriver(id) { try { await AdminApi.suspendDriver(id); notify('Driver suspended'); render(); } catch (e) { notify(e.message); } }
async function verifyDoc(docId, status) { try { await AdminApi.verifyDocument(docId, status); notify(status === 'verified' ? 'Document verified' : 'Document rejected'); render(); } catch (e) { notify(e.message); } }
async function issuePenalty(id) { try { await AdminApi.issuePenalty(id); notify('Penalty logged'); render(); } catch (e) { notify(e.message); } }

/* ---- Customers tab ---- */
function customersTab() {
  if (!state.customers.length) return `<div class="empty-state">${icon('customers', 40)}<h2>No customers yet</h2><p>Rider accounts will appear here once they sign up.</p></div>`;
  return `<div class="card"><table class="data-table"><thead><tr><th>Customer</th><th>Rides</th><th>Rating</th><th>Status</th><th></th></tr></thead><tbody>
    ${state.customers.map((c) => `<tr class="clickable" onclick="openDetail('customer',${c.id})">
      <td data-label="Customer"><div class="table-driver">${avatarChip(c.name, c.id)}<b>${c.name}</b></div></td>
      <td data-label="Rides">${c.rides}</td>
      <td data-label="Rating">${c.rating} ★</td>
      <td data-label="Status"><span class="badge ${c.blocked ? 'off' : 'on'}">${c.blocked ? 'Blocked' : 'Active'}</span></td>
      <td data-label=""><div class="action-group"><button class="link-btn ${c.blocked ? 'primary' : 'danger'}" onclick="event.stopPropagation();toggleBlacklist(${c.id},${c.blocked})">${icon(c.blocked ? 'check' : 'pause', 12)} ${c.blocked ? 'Unblock' : 'Block'}</button></div></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
async function toggleBlacklist(id, blocked) { try { await AdminApi.toggleBlacklist(id, blocked); render(); } catch (e) { notify(e.message); } }

/* ---- Detail modal: click a customer/driver row to see and edit everything ---- */
async function openDetail(type, id) {
  state.detail = { type, id, rides: null, editing: false };
  render();
  try {
    state.detail.rides = await AdminApi.loadEntityRides(type, id);
  } catch (e) { state.detail.rides = []; }
  if (state.detail && state.detail.id === id) render();
}
function closeDetail() { state.detail = null; render(); }
function startEditDetail() { if (state.detail) { state.detail.editing = true; render(); } }
async function saveDetail() {
  const d = state.detail;
  if (!d) return;
  const name = ($('detailName') && $('detailName').value || '').trim();
  const phone = ($('detailPhone') && $('detailPhone').value || '').trim();
  if (!name) return notify('Name cannot be empty');
  try {
    if (d.type === 'customer') {
      await AdminApi.updateCustomer(d.id, { name, phone });
    } else {
      const vehicle_model = ($('detailVehicle') && $('detailVehicle').value || '').trim();
      const plate_number = ($('detailPlate') && $('detailPlate').value || '').trim();
      await AdminApi.updateDriver(d.id, { name, phone, vehicle_model, plate_number });
    }
    d.editing = false;
    notify('Saved');
    render();
  } catch (e) { notify(e.message); }
}
function rideMiniRow(r) {
  const statusColor = ['completed', 'rated'].includes(r.status) ? '#7fd39a' : r.status === 'cancelled' ? '#e08a7d' : 'var(--accent)';
  return `<div class="ride-mini-row">
    <div class="route">${r.pickup_address} → ${r.drop_address}</div>
    <div class="meta"><span style="color:${statusColor};text-transform:capitalize">${r.status}</span><span>PKR ${r.final_fare || r.calculated_fare} · ${new Date(r.created_at).toLocaleDateString()}</span></div>
  </div>`;
}
function detailModal() {
  const d = state.detail;
  if (!d) return '';
  if (d.type === 'customer') {
    const c = state.customers.find((x) => x.id === d.id);
    if (!c) return '';
    return `<div class="modal-backdrop" onclick="if(event.target===this)closeDetail()"><div class="modal-panel">
      <div class="modal-head">${avatarChip(c.name, c.id, 46)}<div><h2>${c.name}</h2><small>${c.phone || 'No phone on file'}</small></div><button class="modal-close" onclick="closeDetail()">${icon('x', 16)}</button></div>
      <div class="modal-body">
        <div class="modal-stat-row">
          <div class="stat-box"><small>Rides</small><b>${c.rides}</b></div>
          <div class="stat-box"><small>Rating</small><b>${c.rating} ★</b></div>
          <div class="stat-box"><small>Status</small><b style="color:${c.blocked ? '#e08a7d' : '#7fd39a'}">${c.blocked ? 'Blocked' : 'Active'}</b></div>
        </div>
        <div class="modal-section">
          <h4>Profile</h4>
          ${d.editing ? `
            <div class="field"><label>NAME</label><input id="detailName" value="${c.name}"></div>
            <div class="field"><label>PHONE</label><input id="detailPhone" value="${c.phone || ''}"></div>
            <button class="btn-primary" onclick="saveDetail()">Save changes</button>
          ` : `<button class="link-btn" onclick="startEditDetail()">${icon('edit', 12)} Edit name &amp; phone</button>`}
        </div>
        <div class="modal-section">
          <h4>Ride history</h4>
          ${d.rides === null ? '<p class="muted">Loading…</p>' : (d.rides.length ? d.rides.map(rideMiniRow).join('') : '<p class="muted">No rides yet.</p>')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="link-btn ${c.blocked ? 'primary' : 'danger'}" style="flex:1" onclick="toggleBlacklist(${c.id},${c.blocked})">${icon(c.blocked ? 'check' : 'pause', 12)} ${c.blocked ? 'Unblock customer' : 'Block customer'}</button>
      </div>
    </div></div>`;
  }
  const dr = state.drivers.find((x) => x.id === d.id);
  if (!dr) return '';
  const p = dr.driver_profile || {};
  const docs = dr.driver_documents || [];
  return `<div class="modal-backdrop" onclick="if(event.target===this)closeDetail()"><div class="modal-panel">
    <div class="modal-head">${avatarChip(dr.name, dr.id, 46)}<div><h2>${dr.name}</h2><small>${dr.phone || 'No phone on file'} · ${p.vehicle_model || 'No vehicle'}</small></div><button class="modal-close" onclick="closeDetail()">${icon('x', 16)}</button></div>
    <div class="modal-body">
      <div class="modal-stat-row">
        <div class="stat-box"><small>Rating</small><b>${dr.rating} ★</b></div>
        <div class="stat-box"><small>Wallet</small><b>PKR ${p.wallet_balance ?? 0}</b></div>
        <div class="stat-box"><small>Strikes</small><b>${p.strikes ?? 0}</b></div>
      </div>
      <div class="modal-section">
        <h4>Profile</h4>
        ${d.editing ? `
          <div class="field"><label>NAME</label><input id="detailName" value="${dr.name}"></div>
          <div class="field"><label>PHONE</label><input id="detailPhone" value="${dr.phone || ''}"></div>
          <div class="grid grid-2">
            <div class="field"><label>VEHICLE</label><input id="detailVehicle" value="${p.vehicle_model || ''}"></div>
            <div class="field"><label>PLATE</label><input id="detailPlate" value="${p.plate_number || ''}"></div>
          </div>
          <button class="btn-primary" onclick="saveDetail()">Save changes</button>
        ` : `<button class="link-btn" onclick="startEditDetail()">${icon('edit', 12)} Edit profile</button>`}
      </div>
      <div class="modal-section">
        <h4>Documents</h4>
        <div class="grid grid-2" style="gap:10px">
          ${Object.keys(DOC_LABELS).map((type) => {
            const doc = docs.find((x) => x.type === type);
            if (!doc) return `<div class="doc-card empty">${icon('image', 22)}<span>${DOC_LABELS[type]}</span></div>`;
            const statusColor = doc.status === 'verified' ? '#7fd39a' : doc.status === 'rejected' ? '#e08a7d' : 'var(--accent)';
            return `<div class="doc-card">
              <b>${DOC_LABELS[type]}</b>
              <a class="doc-thumb-wrap" href="https://api.pickanddrive.pk/storage/${doc.file_path}" target="_blank"><img src="https://api.pickanddrive.pk/storage/${doc.file_path}" alt=""></a>
              <p class="doc-status" style="color:${statusColor}">${doc.status}</p>
              <div class="doc-actions">
                <button class="link-btn primary" onclick="verifyDoc(${doc.id},'verified')">${icon('check', 12)} Verify</button>
                <button class="link-btn danger" onclick="verifyDoc(${doc.id},'rejected')">${icon('x', 12)} Reject</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="modal-section">
        <h4>Ride history</h4>
        ${d.rides === null ? '<p class="muted">Loading…</p>' : (d.rides.length ? d.rides.map(rideMiniRow).join('') : '<p class="muted">No rides yet.</p>')}
      </div>
    </div>
    <div class="modal-actions">
      ${dr.status === 'pending_approval' ? `<button class="link-btn primary" style="flex:1" onclick="approveDriver(${dr.id})">${icon('check', 12)} Approve</button>` : ''}
      ${dr.status !== 'suspended' ? `<button class="link-btn danger" style="flex:1" onclick="suspendDriver(${dr.id})">${icon('pause', 12)} Suspend</button>` : `<button class="link-btn primary" style="flex:1" onclick="approveDriver(${dr.id})">${icon('check', 12)} Reactivate</button>`}
      <button class="link-btn" style="flex:1" onclick="issuePenalty(${dr.id})">${icon('alert', 12)} Penalty</button>
    </div>
  </div></div>`;
}

/* ---- Coupons tab ---- */
function couponsTab() {
  return `<div class="grid grid-2">
    <div class="card">
      <h3>Create a coupon</h3>
      <div class="field"><label>CODE</label><input id="newCouponCode" placeholder="LAHORE30"></div>
      <div class="grid grid-2">
        <div class="field"><label>DISCOUNT</label><input id="newCouponDiscount" type="number" value="20"></div>
        <div class="field"><label>TYPE</label><select id="newCouponType"><option value="percent">% off</option><option value="flat">PKR flat</option></select></div>
      </div>
      <button class="btn-primary" onclick="createCoupon()">Create coupon</button>
    </div>
    <div class="card"><h3>Active &amp; disabled codes</h3>
      ${state.coupons.map((c) => `<div class="coupon-row"><div><b>${c.code}</b><small>${c.type === 'percent' ? c.discount + '% off' : 'PKR ' + c.discount + ' off'}</small></div><div class="action-group"><button class="link-btn ${c.active ? '' : 'primary'}" onclick="toggleCoupon('${c.code}')">${c.active ? icon('pause', 12) : icon('check', 12)} ${c.active ? 'Disable' : 'Enable'}</button><button class="link-btn danger" onclick="deleteCoupon('${c.code}')">${icon('x', 12)} Delete</button></div></div>`).join('') || '<p class="muted">No coupons yet.</p>'}
    </div>
  </div>`;
}
async function createCoupon() {
  const code = document.getElementById('newCouponCode').value.trim().toUpperCase();
  const discount = Math.max(1, +document.getElementById('newCouponDiscount').value || 10);
  const type = document.getElementById('newCouponType').value;
  if (!code) return notify('Enter a coupon code');
  try {
    if (!(await AdminApi.createCoupon(code, discount, type))) return notify('That code already exists');
    notify(`Coupon ${code} created`);
    render();
  } catch (e) { notify(e.message); }
}
async function toggleCoupon(code) { try { await AdminApi.toggleCoupon(code); render(); } catch (e) { notify(e.message); } }
async function deleteCoupon(code) { try { await AdminApi.deleteCoupon(code); render(); } catch (e) { notify(e.message); } }

/* ---- Announcements tab ---- */
function announcementsTab() {
  return `<div class="grid grid-2">
    <div class="card">
      <h3>Broadcast an announcement</h3>
      <div class="field"><label>TITLE</label><input id="annTitle" placeholder="Fare update for Eid week"></div>
      <div class="field"><label>MESSAGE</label><input id="annBody" placeholder="Short message shown to every rider and driver"></div>
      <button class="btn-primary" onclick="broadcastAnnouncement()">Send to everyone</button>
    </div>
    <div class="card"><h3>Recent announcements</h3>
      ${state.announcements.map((a) => `<div class="announcement-row"><b>${a.title}</b><p>${a.body || ''}</p><time>${new Date(a.created_at).toLocaleString()}</time></div>`).join('') || '<p class="muted">No announcements yet.</p>'}
    </div>
  </div>`;
}
async function broadcastAnnouncement() {
  const title = document.getElementById('annTitle').value.trim();
  const body = document.getElementById('annBody').value.trim();
  if (!title) return notify('Enter a title');
  try {
    await AdminApi.broadcastAnnouncement(title, body);
    notify('Announcement broadcast to all riders and drivers');
    render();
  } catch (e) { notify(e.message); }
}

/* ---- Commission tab ---- */
function commissionTab() {
  return `<div class="grid grid-3">
    <div class="card commission-hero"><small>PLATFORM COMMISSION</small><h2>${Math.round(state.settings.commission_rate * 100)}%</h2><div class="stepper-row"><button onclick="setCommission(-0.01)">−1%</button><button onclick="setCommission(0.01)">+1%</button></div></div>
    <div class="card commission-hero"><small>SURGE MULTIPLIER</small><h2>${state.settings.surge_multiplier}×</h2><div class="stepper-row"><button onclick="setSurge(-0.1)">−0.1</button><button onclick="setSurge(0.1)">+0.1</button></div></div>
    <div class="card stat-card"><small>TOTAL COMMISSION COLLECTED</small><b>PKR ${(state.settings.total_commission_collected || 0).toLocaleString()}</b><span>Across all completed rides</span></div>
  </div>
  <div class="card" style="margin-top:14px"><p class="muted">Commission is applied automatically to every completed ride before it's added to the driver's wallet. Surge is shown to riders as a badge and folded into the suggested fare above 1×.</p></div>
  <div class="card" style="margin-top:14px">
    <h3>SOS safety contact number</h3>
    <p class="muted">The number a rider's SOS button dials directly. This is a phone shortcut, not a monitored live emergency line — defaults to Pakistan's national emergency number (1122) unless changed.</p>
    <div class="field" style="max-width:240px"><label>NUMBER</label><input id="safetyContactInput" value="${state.settings.safety_contact_number || '1122'}"></div>
    <button class="pill-btn gold" onclick="saveSafetyContact()">Save</button>
  </div>`;
}
async function setCommission(delta) { try { await AdminApi.setCommission(delta); render(); } catch (e) { notify(e.message); } }
async function setSurge(delta) { try { await AdminApi.setSurge(delta); render(); } catch (e) { notify(e.message); } }
async function saveSafetyContact() {
  const number = (document.getElementById('safetyContactInput').value || '').trim();
  if (!number) return notify('Enter a phone number');
  try { await AdminApi.setSafetyContact(number); notify('Safety contact number updated'); render(); } catch (e) { notify(e.message); }
}

/* ---- Live map tab ---- */
let adminLiveMap = null;
const adminLiveMapMarkers = {};
function liveMapTab() {
  setTimeout(initAdminLiveMap, 0);
  if (!state.liveMapRides.length && !state.liveMapOnlineDrivers.length) {
    return '<div class="card" style="height:60vh;display:flex;align-items:center;justify-content:center"><div class="empty-state"><h2>No drivers online</h2><p>Online drivers and active rides will appear here on the map.</p></div></div>';
  }
  return `<div class="card" style="padding:0;overflow:hidden"><div id="adminLiveMapEl" style="height:70vh"></div></div>`;
}
function initAdminLiveMap() {
  const el = document.getElementById('adminLiveMapEl');
  if (!el || !window.L) return;
  if (!adminLiveMap) {
    adminLiveMap = L.map('adminLiveMapEl');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(adminLiveMap);
  }
  Object.values(adminLiveMapMarkers).forEach((m) => adminLiveMap.removeLayer(m));
  Object.keys(adminLiveMapMarkers).forEach((k) => delete adminLiveMapMarkers[k]);
  const bounds = [];
  state.liveMapRides.forEach((r) => {
    const dp = r.driver && r.driver.driver_profile;
    if (dp && dp.last_lat && dp.last_lng) {
      const pos = [+dp.last_lat, +dp.last_lng];
      adminLiveMapMarkers['d' + r.id] = L.marker(pos, { icon: L.divIcon({ className: '', html: `<div style="width:26px;height:26px;border-radius:50%;background:#e3b24c;border:3px solid #2a1305;display:flex;align-items:center;justify-content:center;font-size:13px">🚗</div>`, iconSize: [26, 26] }) })
        .addTo(adminLiveMap).bindPopup(`<b>${r.driver.name}</b><br>${r.customer ? r.customer.name : ''}<br>${r.pickup_address} → ${r.drop_address}<br>Status: ${r.status}`);
      bounds.push(pos);
    }
    if (r.pickup_lat && r.pickup_lng) bounds.push([+r.pickup_lat, +r.pickup_lng]);
  });
  // Idle online drivers — not on a ride, but need to be visible so dispatch can pick
  // the nearest one when a new fare comes in. Green pin distinguishes "available" from
  // the gold "busy" car icon above.
  state.liveMapOnlineDrivers.forEach((d) => {
    const dp = d.driver_profile;
    if (dp && dp.last_lat && dp.last_lng) {
      const pos = [+dp.last_lat, +dp.last_lng];
      adminLiveMapMarkers['o' + d.id] = L.marker(pos, { icon: L.divIcon({ className: '', html: `<div style="width:22px;height:22px;border-radius:50%;background:#4c8b5d;border:3px solid #1f3d26;display:flex;align-items:center;justify-content:center;font-size:11px">🟢</div>`, iconSize: [22, 22] }) })
        .addTo(adminLiveMap).bindPopup(`<b>${d.name}</b><br>Online — available<br>${dp.vehicle_model || ''} ${dp.plate_number || ''}`);
      bounds.push(pos);
    }
  });
  if (bounds.length) adminLiveMap.fitBounds(bounds, { padding: [40, 40] });
  else adminLiveMap.setView([31.5204, 74.3587], 12);
}

/* ---- Categories tab ---- */
function categoriesTab() {
  const cats = state.settings.fare_settings || [];
  return `<div class="grid grid-2">
    <div class="card">
      <h3>Add a category</h3>
      <div class="field"><label>CATEGORY KEY</label><input id="newCatKey" placeholder="e.g. bike"></div>
      <div class="field"><label>LABEL</label><input id="newCatLabel" placeholder="e.g. Bike Delivery"></div>
      <div class="grid grid-3">
        <div class="field"><label>BASE FARE</label><input id="newCatBase" type="number" value="80"></div>
        <div class="field"><label>PER KM</label><input id="newCatPerKm" type="number" value="20"></div>
        <div class="field"><label>ETA (MIN)</label><input id="newCatEta" type="number" value="5"></div>
      </div>
      <button class="btn-primary" onclick="createCategory()">Add category</button>
    </div>
    <div class="card"><h3>Existing categories</h3><table class="data-table"><thead><tr><th>Category</th><th>Base</th><th>Per km</th><th>Status</th><th></th></tr></thead><tbody>
      ${cats.map((c) => `<tr>
        <td data-label="Category"><b>${c.label}</b><br><small style="color:var(--muted)">${c.category}</small></td>
        <td data-label="Base">PKR ${c.base_fare}</td>
        <td data-label="Per km">PKR ${c.per_km_rate}</td>
        <td data-label="Status"><span class="badge ${c.active ? 'on' : 'off'}">${c.active ? 'Active' : 'Disabled'}</span></td>
        <td data-label=""><div class="action-group"><button class="link-btn ${c.active ? '' : 'primary'}" onclick="toggleCategoryActive(${c.id},${c.active})">${c.active ? icon('pause', 12) : icon('check', 12)} ${c.active ? 'Disable' : 'Enable'}</button><button class="link-btn danger" onclick="deleteCategory(${c.id})">${icon('x', 12)} Delete</button></div></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted" style="padding:16px">No categories yet.</td></tr>'}
    </tbody></table></div>
  </div>`;
}
async function createCategory() {
  const category = ($('newCatKey').value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const label = ($('newCatLabel').value || '').trim();
  const base_fare = +$('newCatBase').value || 0;
  const per_km_rate = +$('newCatPerKm').value || 0;
  const eta_minutes = +$('newCatEta').value || 5;
  if (!category || !label) return notify('Enter a category key and label');
  try {
    await AdminApi.createCategory({ category, label, base_fare, per_km_rate, eta_minutes });
    notify(`${label} added`);
    render();
  } catch (e) { notify(e.message); }
}
async function toggleCategoryActive(id, active) {
  try { await AdminApi.updateCategory(id, { active: !active }); render(); } catch (e) { notify(e.message); }
}
async function deleteCategory(id) {
  try { await AdminApi.deleteCategory(id); notify('Category removed'); render(); } catch (e) { notify(e.message); }
}
function $(id) { return document.getElementById(id); }

/* ---- Withdrawals tab ---- */
function withdrawalsTab() {
  if (!state.withdrawals.length) return `<div class="empty-state">${icon('wallet', 40)}<h2>No withdrawal requests</h2><p>Driver withdrawal requests will appear here.</p></div>`;
  return `<div class="card"><table class="data-table"><thead><tr><th>Driver</th><th>Amount</th><th>Status</th><th>Requested</th><th></th></tr></thead><tbody>
    ${state.withdrawals.map((w) => `<tr>
      <td data-label="Driver"><div class="table-driver">${avatarChip(w.driver ? w.driver.name : '?', w.driver ? w.driver.id : 0)}<div><b>${w.driver ? w.driver.name : '—'}</b><small style="color:var(--muted)">${w.driver ? w.driver.phone : ''}</small></div></div></td>
      <td data-label="Amount">PKR ${w.amount.toLocaleString()}</td>
      <td data-label="Status"><span class="badge ${w.status === 'approved' ? 'on' : w.status === 'rejected' ? 'off' : 'warn'}">${w.status}</span></td>
      <td data-label="Requested">${new Date(w.created_at).toLocaleString()}</td>
      <td data-label="">${w.status === 'pending' ? `<div class="action-group"><button class="link-btn primary" onclick="approveWithdrawal(${w.id})">${icon('check', 12)} Approve</button><button class="link-btn danger" onclick="rejectWithdrawal(${w.id})">${icon('x', 12)} Reject</button></div>` : ''}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
async function approveWithdrawal(id) { try { await AdminApi.approveWithdrawal(id); notify('Withdrawal approved'); render(); } catch (e) { notify(e.message); } }
async function rejectWithdrawal(id) { try { await AdminApi.rejectWithdrawal(id); notify('Withdrawal rejected and refunded to wallet'); render(); } catch (e) { notify(e.message); } }

/* ---- Complaints tab ---- */
function complaintsTab() {
  if (!state.complaints.length) return `<div class="empty-state">${icon('complaints', 40)}<h2>No complaints</h2><p>Support messages from riders and drivers will appear here.</p></div>`;
  return state.complaints.map((c) => `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div><b style="font-size:14px">${c.subject}</b><br><small style="color:var(--muted)">${c.user ? c.user.name : ''} (${c.user ? c.user.role : ''})${c.ride ? ' · ' + c.ride.pickup_address + ' → ' + c.ride.drop_address : ''}</small></div>
      <span class="badge ${c.status === 'resolved' ? 'on' : 'warn'}" style="flex-shrink:0">${c.status}</span>
    </div>
    <p class="muted" style="margin:10px 0">${c.message}</p>
    ${c.admin_note ? `<p style="font-size:12px;color:var(--ink)"><b>Reply:</b> ${c.admin_note}</p>` : ''}
    ${c.status === 'open' ? `<div class="action-group" style="justify-content:flex-start"><button class="link-btn primary" onclick="resolveComplaintPrompt(${c.id})">${icon('check', 12)} Reply &amp; resolve</button></div>` : ''}
  </div>`).join('');
}
async function resolveComplaintPrompt(id) {
  const note = prompt('Reply to this complaint (sent to the user, marks it resolved):');
  if (note === null) return;
  try { await AdminApi.resolveComplaint(id, note); notify('Complaint resolved'); render(); } catch (e) { notify(e.message); }
}

/* ---- Reports tab ---- */
function reportsTab() {
  const rev = state.revenueReport;
  const rides = (state.reportRides && state.reportRides.data) || [];
  const f = state.reportFilters;
  return `<div class="grid grid-3">
    <div class="card stat-card"><small>COMPLETED RIDES</small><b>${rev ? rev.total_rides : '—'}</b></div>
    <div class="card stat-card"><small>TOTAL FARE COLLECTED</small><b>PKR ${rev ? rev.total_fare_collected.toLocaleString() : '—'}</b></div>
    <div class="card stat-card"><small>PLATFORM COMMISSION</small><b>PKR ${rev ? rev.total_commission.toLocaleString() : '—'}</b></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h3>Filter ride history</h3>
    <div class="grid grid-3">
      <div class="field"><label>STATUS</label><select id="repStatus" onchange="setReportFilter('status',this.value)">
        <option value="">Any</option>
        ${['pending_dispatch', 'dispatched', 'accepted', 'arriving', 'arrived', 'in_progress', 'completed', 'rated', 'cancelled'].map((s) => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></div>
      <div class="field"><label>FROM</label><input type="date" id="repFrom" value="${f.from}" onchange="setReportFilter('from',this.value)"></div>
      <div class="field"><label>TO</label><input type="date" id="repTo" value="${f.to}" onchange="setReportFilter('to',this.value)"></div>
    </div>
    <table class="data-table"><thead><tr><th>Route</th><th>Category</th><th>Fare</th><th>Status</th><th>Date</th></tr></thead><tbody>
      ${rides.map((r) => `<tr>
        <td data-label="Route">${r.pickup_address} → ${r.drop_address}</td>
        <td data-label="Category">${r.category}</td>
        <td data-label="Fare">PKR ${r.final_fare || r.calculated_fare}</td>
        <td data-label="Status"><span class="badge ${['completed', 'rated'].includes(r.status) ? 'on' : 'off'}">${r.status}</span></td>
        <td data-label="Date">${new Date(r.created_at).toLocaleDateString()}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted" style="padding:16px">No rides match these filters.</td></tr>'}
    </tbody></table>
  </div>`;
}
function setReportFilter(key, value) { state.reportFilters[key] = value; save(); AdminApi.loadReportRides().then(render).catch((e) => notify(e.message)); }

/* ---- Root render ---- */
function render() {
  document.getElementById('root').innerHTML = state.loggedIn ? shell() : authScreen();
  if (!state.loggedIn) mountGoogleButton();
}
if (state.loggedIn) {
  AdminApi.refreshAll().then(render).catch(() => { state.loggedIn = false; render(); });
  startPolling();
} else {
  render();
}
