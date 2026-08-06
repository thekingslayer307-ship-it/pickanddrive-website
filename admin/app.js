/* Pick&Drive Admin Console — standalone back-office web app.
   Currently backed by localStorage demo data. Swap AdminApi's methods for
   real fetch() calls once the Laravel backend exists — every screen below
   only reads/writes through AdminApi, so that's the one place to change. */

const KEY = 'pickanddrive-admin-v1';

function seedState() {
  return {
    loggedIn: false,
    adminName: 'Dispatch Admin',
    tab: 'dispatch',
    commissionRate: 0.15,
    totalCommissionCollected: 48250,
    surge: 1,
    pendingRide: {
      id: 'ride-8841',
      fare: 600,
      rider: 'Maya Ahmed',
      riderRating: 4.96,
      pickup: 'Gulberg III, Lahore',
      drop: 'DHA Phase 5, Lahore',
      distanceKm: 8.4,
      status: 'pending_dispatch', // pending_dispatch | dispatched | none
      assignedDriverId: null,
    },
    drivers: [
      { id: 'aisha', name: 'Aisha Khan', rating: 4.98, trips: 1240, vehicle: 'Honda City 2024', plate: 'LEB 829', photo: 'https://i.pravatar.cc/100?img=47', online: true, acceptance: 92, cancellation: 3, strikes: 0 },
      { id: 'amir', name: 'Amir Raza', rating: 4.91, trips: 860, vehicle: 'Toyota Corolla', plate: 'LEA-2210', photo: 'https://i.pravatar.cc/100?img=12', online: true, acceptance: 89, cancellation: 4, strikes: 0 },
      { id: 'sameer', name: 'Sameer Khan', rating: 4.95, trips: 1510, vehicle: 'Honda Civic', plate: 'LEC-7741', photo: 'https://i.pravatar.cc/100?img=33', online: false, acceptance: 95, cancellation: 2, strikes: 1 },
    ],
    customers: [
      { key: 'maya-ahmed', name: 'Maya Ahmed', rides: 8, rating: 4.96, blocked: false },
      { key: 'hamza-k', name: 'Hamza K.', rides: 22, rating: 4.7, blocked: false },
      { key: 'sana-r', name: 'Sana R.', rides: 3, rating: 3.9, blocked: true },
    ],
    coupons: [
      { code: 'LAHORE25', discount: 25, type: 'percent', active: true },
      { code: 'AIRPORT100', discount: 100, type: 'flat', active: true },
      { code: 'WELCOME50', discount: 50, type: 'flat', active: false },
    ],
    announcements: [
      { title: 'Eid week fare adjustment', body: 'Surge caps raised to 1.8x for Eid week, effective immediately.', time: '2 days ago' },
      { title: 'New driver documents policy', body: 'CNIC and license re-verification required every 12 months.', time: '1 week ago' },
    ],
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

/* ---- Data layer: the only place that should change when a real backend exists ---- */
const AdminApi = {
  login(email, password) {
    // TODO: replace with POST /api/v1/admin/auth/login
    return Promise.resolve({ ok: true, name: 'Dispatch Admin' });
  },
  assignDriver(driverId) {
    // TODO: replace with POST /api/v1/admin/rides/:id/assign
    const d = state.drivers.find((x) => x.id === driverId);
    if (!d) return;
    state.pendingRide.status = 'dispatched';
    state.pendingRide.assignedDriverId = driverId;
    save();
  },
  reassign() {
    state.pendingRide.status = 'pending_dispatch';
    state.pendingRide.assignedDriverId = null;
    save();
  },
  cancelRide() {
    state.pendingRide.status = 'none';
    save();
  },
  toggleDriverOnline(id) {
    const d = state.drivers.find((x) => x.id === id);
    if (d) { d.online = !d.online; save(); }
  },
  issuePenalty(id) {
    const d = state.drivers.find((x) => x.id === id);
    if (d) { d.strikes += 1; save(); }
  },
  toggleBlacklist(key) {
    const c = state.customers.find((x) => x.key === key);
    if (c) { c.blocked = !c.blocked; save(); }
  },
  toggleCoupon(code) {
    const c = state.coupons.find((x) => x.code === code);
    if (c) { c.active = !c.active; save(); }
  },
  createCoupon(code, discount, type) {
    if (state.coupons.some((c) => c.code === code)) return false;
    state.coupons.unshift({ code, discount, type, active: true });
    save();
    return true;
  },
  deleteCoupon(code) {
    state.coupons = state.coupons.filter((c) => c.code !== code);
    save();
  },
  broadcastAnnouncement(title, body) {
    state.announcements.unshift({ title, body, time: 'Just now' });
    save();
  },
  setCommission(delta) {
    state.commissionRate = Math.max(0, Math.min(0.4, +(state.commissionRate + delta).toFixed(2)));
    save();
  },
  setSurge(delta) {
    state.surge = Math.max(1, Math.min(2.5, +(state.surge + delta).toFixed(1)));
    save();
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
};
function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

/* ---- Auth screen ---- */
function authScreen() {
  return `<div class="auth-screen"><div class="auth-box">
    <div class="brand-row"><img src="assets/app-icon.svg" alt=""><b>Pick&amp;Drive</b></div>
    <h1>Admin Console</h1>
    <p class="sub">Sign in to manage dispatch, drivers, coupons and commission.</p>
    <div class="field"><label>ADMIN EMAIL</label><input id="loginEmail" value="dispatch@pickanddrive.pk"></div>
    <div class="field"><label>PASSWORD</label><input id="loginPassword" type="password" value="admin1234"></div>
    <button class="btn-primary" onclick="doLogin()">Sign in</button>
    <p class="auth-note">Demo login — connects to AdminApi.login(), ready to wire to the real backend.</p>
  </div></div>`;
}
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  if (!email || !password) return notify('Enter an email and password');
  const res = await AdminApi.login(email, password);
  if (res.ok) {
    state.loggedIn = true;
    state.adminName = res.name;
    save();
    render();
  }
}
function doLogout() {
  state.loggedIn = false;
  save();
  render();
}

/* ---- App shell ---- */
const TABS = [
  ['dispatch', 'Dispatch', 'dispatch'],
  ['drivers', 'Drivers', 'drivers'],
  ['customers', 'Customers', 'customers'],
  ['coupons', 'Coupons', 'coupons'],
  ['announcements', 'Announcements', 'announcements'],
  ['commission', 'Commission & surge', 'commission'],
];
function setTab(tab) { state.tab = tab; save(); render(); }

function shell() {
  const hasPending = state.pendingRide.status !== 'none';
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
  </div>`;
}
function topbar() {
  const titles = { dispatch: ['Dispatch queue', 'Assign drivers to incoming ride requests'], drivers: ['Drivers', 'Monitor performance and manage penalties'], customers: ['Customers', 'Manage rider accounts and the blacklist'], coupons: ['Coupons', 'Create and manage promo codes'], announcements: ['Announcements', 'Broadcast messages to every rider and driver'], commission: ['Commission & surge', 'Platform fee and demand pricing controls'] };
  const [title, sub] = titles[state.tab] || ['', ''];
  return `<div class="topbar"><div><h1>${title}</h1><p>${sub}</p></div><div class="topbar-actions"><span class="pill-btn">PKR ${state.totalCommissionCollected.toLocaleString()} collected</span></div></div>`;
}
function tabContent() {
  return { dispatch: dispatchTab, drivers: driversTab, customers: customersTab, coupons: couponsTab, announcements: announcementsTab, commission: commissionTab }[state.tab]();
}

/* ---- Dispatch tab ---- */
function dispatchTab() {
  const r = state.pendingRide;
  if (r.status === 'pending_dispatch') {
    const online = state.drivers.filter((d) => d.online);
    return `<div class="card dispatch-request">
      <span class="status-pill">NEW REQUEST · AWAITING DISPATCH</span>
      <h2>PKR ${r.fare} offer</h2>
      <p class="muted">${r.rider} · ${r.riderRating} ★ · Verified rider<br>${r.pickup} → ${r.drop} · ${r.distanceKm} km</p>
      <h3 style="margin:18px 0 10px;font-size:11px;letter-spacing:.5px;color:var(--muted);text-transform:uppercase">Assign a driver</h3>
      ${online.map((d) => `<div class="driver-row"><img src="${d.photo}" alt=""><div class="info"><b>${d.name}</b><small>★ ${d.rating} · ${d.vehicle} · online</small></div><button class="btn-sm" onclick="assignDriver('${d.id}')">Assign</button></div>`).join('') || '<p class="muted">No drivers are online right now.</p>'}
      <button class="pill-btn" style="margin-top:10px" onclick="cancelDispatchRide()">Cancel this request</button>
    </div>`;
  }
  if (r.status === 'dispatched') {
    const d = state.drivers.find((x) => x.id === r.assignedDriverId);
    return `<div class="card dispatch-request">
      <span class="status-pill">WAITING ON DRIVER RESPONSE</span>
      <h2>Dispatched to ${d ? d.name : 'driver'}</h2>
      <p class="muted">${r.pickup} → ${r.drop} · PKR ${r.fare}</p>
      ${d ? `<div class="driver-row"><img src="${d.photo}" alt=""><div class="info"><b>${d.name}</b><small>★ ${d.rating} · ${d.vehicle}</small></div></div>` : ''}
      <button class="pill-btn" onclick="reassignRide()">Reassign to a different driver</button>
    </div>`;
  }
  return `<div class="empty-state"><h2>No rides waiting on dispatch</h2><p>New requests from the rider app will appear here once the backend is connected.</p></div>`;
}
function assignDriver(id) { AdminApi.assignDriver(id); notify('Driver assigned'); render(); }
function reassignRide() { AdminApi.reassign(); notify('Ride returned to the queue'); render(); }
function cancelDispatchRide() { AdminApi.cancelRide(); notify('Request cancelled'); render(); }

/* ---- Drivers tab ---- */
function driversTab() {
  return `<div class="card"><table class="data-table"><thead><tr><th>Driver</th><th>Status</th><th>Rating</th><th>Acceptance</th><th>Cancellation</th><th>Strikes</th><th></th></tr></thead><tbody>
    ${state.drivers.map((d) => `<tr>
      <td><div class="table-driver"><img src="${d.photo}" alt=""><div><b>${d.name}</b><br><small style="color:var(--muted)">${d.vehicle} · ${d.plate}</small></div></div></td>
      <td><span class="badge ${d.online ? 'on' : 'off'}" style="cursor:pointer" onclick="toggleDriverOnline('${d.id}')">${d.online ? 'Online' : 'Offline'}</span></td>
      <td>${d.rating} ★</td>
      <td>${d.acceptance}%</td>
      <td>${d.cancellation}%</td>
      <td>${d.strikes}</td>
      <td><button class="link-btn" onclick="issuePenalty('${d.id}')">Issue penalty</button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
function toggleDriverOnline(id) { AdminApi.toggleDriverOnline(id); render(); }
function issuePenalty(id) { AdminApi.issuePenalty(id); notify('Penalty logged'); render(); }

/* ---- Customers tab ---- */
function customersTab() {
  return `<div class="card"><table class="data-table"><thead><tr><th>Customer</th><th>Rides</th><th>Rating</th><th>Status</th><th></th></tr></thead><tbody>
    ${state.customers.map((c) => `<tr>
      <td><b>${c.name}</b></td>
      <td>${c.rides}</td>
      <td>${c.rating} ★</td>
      <td><span class="badge ${c.blocked ? 'off' : 'on'}">${c.blocked ? 'Blocked' : 'Active'}</span></td>
      <td><button class="link-btn ${c.blocked ? '' : 'danger'}" onclick="toggleBlacklist('${c.key}')">${c.blocked ? 'Unblock' : 'Block'}</button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
function toggleBlacklist(key) { AdminApi.toggleBlacklist(key); render(); }

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
      ${state.coupons.map((c) => `<div class="coupon-row"><div><b>${c.code}</b><small>${c.type === 'percent' ? c.discount + '% off' : 'PKR ' + c.discount + ' off'}</small></div><div><button class="link-btn" onclick="toggleCoupon('${c.code}')">${c.active ? 'Disable' : 'Enable'}</button><button class="link-btn danger" onclick="deleteCoupon('${c.code}')">Delete</button></div></div>`).join('')}
    </div>
  </div>`;
}
function createCoupon() {
  const code = document.getElementById('newCouponCode').value.trim().toUpperCase();
  const discount = Math.max(1, +document.getElementById('newCouponDiscount').value || 10);
  const type = document.getElementById('newCouponType').value;
  if (!code) return notify('Enter a coupon code');
  if (!AdminApi.createCoupon(code, discount, type)) return notify('That code already exists');
  notify(`Coupon ${code} created`);
  render();
}
function toggleCoupon(code) { AdminApi.toggleCoupon(code); render(); }
function deleteCoupon(code) { AdminApi.deleteCoupon(code); render(); }

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
      ${state.announcements.map((a) => `<div class="announcement-row"><b>${a.title}</b><p>${a.body}</p><time>${a.time}</time></div>`).join('')}
    </div>
  </div>`;
}
function broadcastAnnouncement() {
  const title = document.getElementById('annTitle').value.trim();
  const body = document.getElementById('annBody').value.trim();
  if (!title) return notify('Enter a title');
  AdminApi.broadcastAnnouncement(title, body);
  notify('Announcement broadcast to all riders and drivers');
  render();
}

/* ---- Commission tab ---- */
function commissionTab() {
  return `<div class="grid grid-3">
    <div class="card commission-hero"><small>PLATFORM COMMISSION</small><h2>${Math.round(state.commissionRate * 100)}%</h2><div class="stepper-row"><button onclick="setCommission(-0.01)">−1%</button><button onclick="setCommission(0.01)">+1%</button></div></div>
    <div class="card commission-hero"><small>SURGE MULTIPLIER</small><h2>${state.surge}×</h2><div class="stepper-row"><button onclick="setSurge(-0.1)">−0.1</button><button onclick="setSurge(0.1)">+0.1</button></div></div>
    <div class="card stat-card"><small>TOTAL COMMISSION COLLECTED</small><b>PKR ${state.totalCommissionCollected.toLocaleString()}</b><span>Across all completed rides</span></div>
  </div>
  <div class="card" style="margin-top:14px"><p class="muted">Commission is applied automatically to every completed ride before it's added to the driver's wallet. Surge is shown to riders as a badge and folded into the suggested fare above 1×.</p></div>`;
}
function setCommission(delta) { AdminApi.setCommission(delta); render(); }
function setSurge(delta) { AdminApi.setSurge(delta); render(); }

/* ---- Root render ---- */
function render() {
  document.getElementById('root').innerHTML = state.loggedIn ? shell() : authScreen();
}
render();
