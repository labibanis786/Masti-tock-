/* ==========================================================================
   PingPong Control — Admin website logic.
   ========================================================================== */

const API = ""; // same-origin (served at /admin, API at /api)
let token = localStorage.getItem("pp_admin_token") || null;
let liveTimer = null;
let allUsersCache = [];

function $(id) { return document.getElementById(id); }

function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 2800);
}

async function api(path, method = "GET", body = null) {
  try {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-admin-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { doLogout(); toast("সেশন শেষ হয়ে গেছে, আবার লগইন করো", true); return { success: false }; }
    return await res.json();
  } catch (e) {
    toast("নেটওয়ার্ক সমস্যা", true);
    return { success: false };
  }
}

async function apiUpload(path, formData) {
  try {
    const res = await fetch(API + path, {
      method: "POST",
      body: formData,
      headers: token ? { "x-admin-token": token } : {}
    });
    if (res.status === 401) { doLogout(); toast("সেশন শেষ হয়ে গেছে, আবার লগইন করো", true); return { success: false }; }
    return await res.json();
  } catch (e) {
    toast("আপলোড সমস্যা", true);
    return { success: false };
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

// ===========================================================================
// AUTH
// ===========================================================================
$("btn-login").addEventListener("click", doLogin);
$("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const username = $("login-username").value.trim();
  const password = $("login-password").value.trim();
  const r = await api("/api/admin/login", "POST", { username, password });
  if (r.success) {
    token = r.token;
    localStorage.setItem("pp_admin_token", token);
    enterShell();
  } else {
    $("login-error").textContent = r.message || "ভুল username/password";
    $("login-error").classList.remove("hidden");
  }
}

$("btn-logout").addEventListener("click", async () => {
  if (token) await api("/api/admin/logout", "POST");
  doLogout();
});

function doLogout() {
  token = null;
  localStorage.removeItem("pp_admin_token");
  clearInterval(liveTimer);
  $("app-shell").classList.add("hidden");
  $("view-login").classList.add("active");
  $("login-password").value = "";
}

function enterShell() {
  $("view-login").classList.remove("active");
  $("app-shell").classList.remove("hidden");
  loadDashboard();
  liveTimer = setInterval(loadDashboard, 10000);
}

// ===========================================================================
// SIDEBAR ROUTING
// ===========================================================================
document.querySelectorAll(".side-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".side-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".sec").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    const section = btn.getAttribute("data-section");
    $("sec-" + section).classList.add("active");
    if (section === "users") loadUsers();
    if (section === "rooms") loadRooms();
    if (section === "economy") loadEconomy();
    if (section === "coin-center") loadCoinCenter();
    if (section === "frames") loadFrames();
    if (section === "tags") updateTagPreview();
    if (section === "svip-tags") loadSvipTags();
    if (section === "video-gifts") loadVideoGifts();
    if (section === "agencies") loadAgencies();
    if (section === "chest") loadChestLevels();
    if (section === "ai-core") loadAiCore();
  });
});

// ===========================================================================
// DASHBOARD (live)
// ===========================================================================
async function loadDashboard() {
  const stats = await api("/api/admin/stats");
  if (stats.success) {
    $("dash-users").textContent = stats.stats.totalUsers;
    $("dash-rooms").textContent = stats.stats.totalRooms;
    $("dash-online").textContent = stats.stats.onlineCount;
    $("dash-banned").textContent = stats.stats.bannedCount;
    $("strip-users").textContent = stats.stats.totalUsers;
  }

  const live = await api("/api/admin/live");
  if (live.success) {
    $("strip-online").textContent = live.totalOnline;
    $("strip-rooms").textContent = live.activeRooms.length;

    const wrap = $("live-rooms-list");
    wrap.innerHTML = "";
    $("live-rooms-empty").classList.toggle("hidden", live.activeRooms.length > 0);
    live.activeRooms.forEach((r) => {
      const row = document.createElement("div");
      row.className = "data-row";
      const names = r.onlineUsers.slice(0, 5).map((u) => escapeHtml(u.userName)).join(", ");
      row.innerHTML = `
        <div class="data-row-main"><b>${escapeHtml(r.roomName)}</b><span class="sub">Host: ${escapeHtml(r.hostName)} · ${names}${r.onlineUsers.length > 5 ? " +" + (r.onlineUsers.length - 5) + " more" : ""}</span></div>
        <span class="badge badge-ok">${r.onlineCount} online</span>
      `;
      wrap.appendChild(row);
    });
  }
}

// ===========================================================================
// USERS
// ===========================================================================
$("btn-refresh-users").addEventListener("click", loadUsers);
$("user-search").addEventListener("input", renderUsersTable);

async function loadUsers() {
  const r = await api("/api/admin/users");
  if (r.success) { allUsersCache = r.users; renderUsersTable(); }
}

function renderUsersTable() {
  const q = $("user-search").value.trim().toLowerCase();
  const tbody = $("users-tbody");
  tbody.innerHTML = "";
  const filtered = allUsersCache.filter((u) =>
    !q || u.name.toLowerCase().includes(q) || u.userId.includes(q) || u.mobile.includes(q)
  );
  filtered.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${escapeHtml(u.name)}</b><br><span class="mono">${escapeHtml(u.userId)}</span></td>
      <td class="mono">${escapeHtml(u.mobile)}</td>
      <td class="mono">🪙 ${u.coins}</td>
      <td class="mono">💎 ${u.diamonds}</td>
      <td>VIP ${u.vipLevel}${u.verified ? ' <span class="badge badge-ok">✔ verified</span>' : ""}</td>
      <td>${u.banned ? '<span class="badge badge-danger">Banned</span>' : '<span class="badge badge-ok">Active</span>'}</td>
      <td class="cell-actions">
        <button class="btn btn-sm ${u.banned ? "btn-ghost" : "btn-danger"} act-ban">${u.banned ? "Unban" : "Ban"}</button>
        <button class="btn btn-sm btn-ghost act-verify">${u.verified ? "Unverify" : "Verify"}</button>
        <button class="btn btn-sm btn-warn act-coins">Coins</button>
        <button class="btn btn-sm btn-danger act-delete">Delete</button>
      </td>
    `;
    tr.querySelector(".act-ban").addEventListener("click", async () => {
      const r = await api(`/api/admin/users/${u.mobile}/ban`, "POST", { banned: !u.banned });
      if (r.success) { toast(u.banned ? "Unban করা হয়েছে" : "Ban করা হয়েছে"); loadUsers(); } else toast(r.message, true);
    });
    tr.querySelector(".act-verify").addEventListener("click", async () => {
      const r = await api(`/api/admin/users/${u.mobile}/verify`, "POST", { verified: !u.verified });
      if (r.success) { toast("আপডেট হয়েছে"); loadUsers(); } else toast(r.message, true);
    });
    tr.querySelector(".act-coins").addEventListener("click", async () => {
      const val = prompt("নতুন coin amount:", u.coins);
      if (val === null) return;
      const coins = Number(val);
      if (isNaN(coins) || coins < 0) { toast("সঠিক সংখ্যা দাও", true); return; }
      const r = await api(`/api/admin/users/${u.mobile}/coins`, "POST", { coins });
      if (r.success) { toast("Coins আপডেট হয়েছে"); loadUsers(); } else toast(r.message, true);
    });
    tr.querySelector(".act-delete").addEventListener("click", async () => {
      if (!confirm(`${u.name} (${u.userId})-কে স্থায়ীভাবে ডিলিট করবে?`)) return;
      const r = await api(`/api/admin/users/${u.mobile}`, "DELETE");
      if (r.success) { toast("ইউজার ডিলিট হয়েছে"); loadUsers(); } else toast(r.message, true);
    });
    tbody.appendChild(tr);
  });
}

// ===========================================================================
// ROOMS
// ===========================================================================
$("btn-refresh-rooms").addEventListener("click", loadRooms);

async function loadRooms() {
  const r = await api("/api/admin/rooms");
  const tbody = $("rooms-tbody");
  tbody.innerHTML = "";
  if (!r.success) return;
  r.rooms.forEach((room) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${escapeHtml(room.roomName)}</b><br><span class="mono">${escapeHtml(room.roomId)}</span></td>
      <td>${escapeHtml(room.hostName)}</td>
      <td class="mono">👥 ${room.onlineCount}</td>
      <td>${room.roomLocked ? '<span class="badge badge-danger">Locked</span>' : '<span class="badge badge-ok">Open</span>'}
        ${room.gameEnabled ? '<span class="badge badge-ok">Game On</span>' : '<span class="badge badge-danger">Game Off</span>'}</td>
      <td class="cell-actions">
        <button class="btn btn-sm ${room.roomLocked ? "btn-ghost" : "btn-warn"} act-lock">${room.roomLocked ? "Unlock" : "Lock"}</button>
        <button class="btn btn-sm ${room.gameEnabled ? "btn-warn" : "btn-ghost"} act-game">${room.gameEnabled ? "Game বন্ধ করো" : "Game চালু করো"}</button>
        <button class="btn btn-sm btn-danger act-del">Delete</button>
      </td>
    `;
    tr.querySelector(".act-lock").addEventListener("click", async () => {
      const r2 = await api(`/api/admin/rooms/${room.roomId}/lock`, "POST", { locked: !room.roomLocked });
      if (r2.success) { toast("রুম আপডেট হয়েছে"); loadRooms(); } else toast(r2.message, true);
    });
    tr.querySelector(".act-game").addEventListener("click", async () => {
      const r2 = await api(`/api/admin/rooms/${room.roomId}/game`, "POST", { enabled: !room.gameEnabled });
      if (r2.success) { toast("Game সেটিং আপডেট হয়েছে"); loadRooms(); } else toast(r2.message, true);
    });
    tr.querySelector(".act-del").addEventListener("click", async () => {
      if (!confirm(`"${room.roomName}" ডিলিট করবে?`)) return;
      const r2 = await api(`/api/admin/rooms/${room.roomId}`, "DELETE");
      if (r2.success) { toast("রুম ডিলিট হয়েছে"); loadRooms(); } else toast(r2.message, true);
    });
    tbody.appendChild(tr);
  });
}

// ===========================================================================
// ECONOMY
// ===========================================================================
async function loadEconomy() {
  const ex = await api("/api/admin/exchanges");
  const tbody = $("exchanges-tbody");
  tbody.innerHTML = "";
  if (ex.success) ex.exchanges.forEach((e) => {
    const tr = document.createElement("tr");
    const statusBadge = e.status === "pending" ? '<span class="badge badge-warn">Pending</span>'
      : e.status === "approved" ? '<span class="badge badge-ok">Approved</span>'
      : '<span class="badge badge-danger">Rejected</span>';
    tr.innerHTML = `
      <td><b>${escapeHtml(e.userName)}</b><br><span class="mono">${escapeHtml(e.userId)}</span></td>
      <td class="mono">💎 ${e.diamonds}</td>
      <td>${escapeHtml(e.note || "—")}</td>
      <td>${statusBadge}</td>
      <td class="cell-actions">
        ${e.status === "pending" ? `<button class="btn btn-sm btn-primary act-approve">Approve</button><button class="btn btn-sm btn-danger act-reject">Reject</button>` : ""}
      </td>
    `;
    if (e.status === "pending") {
      tr.querySelector(".act-approve").addEventListener("click", async () => {
        const r = await api(`/api/admin/exchanges/${e.id}/decide`, "POST", { approve: true });
        if (r.success) { toast("Approve হয়েছে"); loadEconomy(); } else toast(r.message, true);
      });
      tr.querySelector(".act-reject").addEventListener("click", async () => {
        const r = await api(`/api/admin/exchanges/${e.id}/decide`, "POST", { approve: false });
        if (r.success) { toast("Reject হয়েছে"); loadEconomy(); } else toast(r.message, true);
      });
    }
    tbody.appendChild(tr);
  });

  const gifts = await api("/api/gifts/history");
  const giftWrap = $("gift-log-list");
  giftWrap.innerHTML = "";
  if (gifts.success) gifts.gifts.slice(0, 30).forEach((g) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main">${escapeHtml(g.fromName)} → ${escapeHtml(g.toName)} <b>${g.gift.emoji} ${escapeHtml(g.gift.name)}</b><span class="sub">${new Date(g.time).toLocaleString()}</span></div>`;
    giftWrap.appendChild(row);
  });
}

// ===========================================================================
// FRAMES
// ===========================================================================
async function loadFrames() {
  const r = await api("/api/frames/catalog");
  const select = $("frame-select");
  select.innerHTML = "";
  const wrap = $("frame-catalog-list");
  wrap.innerHTML = "";
  if (r.success) r.frames.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id; opt.textContent = f.name;
    select.appendChild(opt);

    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(f.name)}</b><span class="sub">${escapeHtml(f.id)}${f.imageUrl ? " · uploaded PNG" : ""}</span></div>${f.vipOnly ? '<span class="badge badge-warn">VIP only</span>' : ""}`;
    wrap.appendChild(row);
  });
}

$("btn-upload-frame").addEventListener("click", async () => {
  const file = $("frame-upload-file").files[0];
  if (!file) { toast("PNG ফাইল বেছে নাও", true); return; }
  const fd = new FormData();
  fd.append("frame", file);
  fd.append("name", $("frame-upload-name").value.trim());
  fd.append("vipOnly", $("frame-upload-vip").checked ? "true" : "false");
  const r = await apiUpload("/api/admin/frames/upload", fd);
  if (r.success) {
    toast("Frame আপলোড হয়েছে");
    $("frame-upload-name").value = "";
    $("frame-upload-file").value = "";
    $("frame-upload-vip").checked = false;
    loadFrames();
  } else toast(r.message || "আপলোড ব্যর্থ হয়েছে", true);
});

// ===========================================================================
// SVIP TAGS (per-level PNG, SVIP1–8)
// ===========================================================================
async function loadSvipTags() {
  const r = await api("/api/svip/tags");
  const wrap = $("svip-tags-list");
  wrap.innerHTML = "";
  if (!r.success) return;
  r.tags.forEach((t) => {
    const row = document.createElement("div");
    row.className = "data-row";
    const preview = t.tag
      ? `<img src="${t.tag}?v=${t.tagVersion}" alt="SVIP${t.level}" style="width:40px;height:40px;object-fit:contain;background:repeating-conic-gradient(#00000022 0% 25%, transparent 0% 50%) 50% / 12px 12px;border-radius:6px;">`
      : `<span class="sub">কোনো ট্যাগ নেই</span>`;
    row.innerHTML = `
      <div class="data-row-main" style="display:flex;align-items:center;gap:12px;">
        ${preview}
        <b>SVIP${t.level}</b>
      </div>
      <div class="form-row" style="margin:0;">
        <input type="file" accept="image/png" class="field" id="svip-tag-file-${t.level}">
        <button class="btn btn-primary" data-svip-upload="${t.level}">আপলোড</button>
        ${t.tag ? `<button class="btn btn-ghost" data-svip-remove="${t.level}">সরাও</button>` : ""}
      </div>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll("[data-svip-upload]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const level = btn.getAttribute("data-svip-upload");
      const file = $(`svip-tag-file-${level}`).files[0];
      if (!file) { toast("PNG ফাইল বেছে নাও", true); return; }
      const fd = new FormData();
      fd.append("tag", file);
      const r = await apiUpload(`/api/admin/svip-tags/${level}/upload`, fd);
      if (r.success) { toast(`SVIP${level} ট্যাগ আপলোড হয়েছে`); loadSvipTags(); }
      else toast(r.message || "আপলোড ব্যর্থ হয়েছে", true);
    });
  });
  wrap.querySelectorAll("[data-svip-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const level = btn.getAttribute("data-svip-remove");
      const r = await api(`/api/admin/svip-tags/${level}`, "DELETE");
      if (r.success) { toast(`SVIP${level} ট্যাগ সরানো হয়েছে`); loadSvipTags(); }
      else toast(r.message || "ব্যর্থ হয়েছে", true);
    });
  });
}

$("btn-send-frame").addEventListener("click", async () => {
  const targetUserId = $("frame-target").value.trim();
  const frameId = $("frame-select").value;
  const expiryDays = $("frame-days").value ? Number($("frame-days").value) : undefined;
  if (!targetUserId || !frameId) { toast("User ID ও Frame বেছে নাও", true); return; }
  const r = await api("/api/admin/frames/send", "POST", { targetUserId, frameId, expiryDays });
  if (r.success) { toast("Frame পাঠানো হয়েছে"); $("frame-target").value = ""; } else toast(r.message, true);
});

// ===========================================================================
// TAGS (admin-assigned coloured badge next to a user's name)
// ===========================================================================
function tagPreviewTextColor(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length !== 6) return "#1c1424";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.55 ? "#1c1424" : "#fbf6ea";
}
function updateTagPreview() {
  const box = $("tag-preview");
  if (!box) return;
  const text = $("tag-text").value.trim();
  const color = $("tag-color").value;
  if (!text) { box.innerHTML = "<span class=\"hint\">প্রিভিউ দেখতে টেক্সট লেখো</span>"; return; }
  box.innerHTML = `<span class="tag-preview-badge" style="background:${color};color:${tagPreviewTextColor(color)}">${escapeHtml(text)}</span>`;
}
$("tag-text").addEventListener("input", updateTagPreview);
$("tag-color").addEventListener("input", updateTagPreview);
$("btn-send-tag").addEventListener("click", async () => {
  const targetUserId = $("tag-target").value.trim();
  const text = $("tag-text").value.trim();
  const color = $("tag-color").value;
  if (!targetUserId || !text) { toast("User ID ও Tag টেক্সট দাও", true); return; }
  const r = await api("/api/admin/tags/send", "POST", { targetUserId, text, color });
  if (r.success) toast("Tag পাঠানো হয়েছে"); else toast(r.message || "ব্যর্থ হয়েছে", true);
});
$("btn-remove-tag").addEventListener("click", async () => {
  const targetUserId = $("tag-target").value.trim();
  if (!targetUserId) { toast("User ID দাও", true); return; }
  const r = await api("/api/admin/tags/send", "POST", { targetUserId, text: "", color: "" });
  if (r.success) toast("Tag সরানো হয়েছে"); else toast(r.message || "ব্যর্থ হয়েছে", true);
});

// ===========================================================================
// VIDEO GIFTS
// ===========================================================================
async function loadVideoGifts() {
  const r = await api("/api/admin/video-gifts");
  const wrap = $("vgift-catalog-list");
  wrap.innerHTML = "";
  if (!r.success) return;
  if (!r.gifts.length) { wrap.innerHTML = '<p class="hint">এখনো কোনো Video Gift যোগ করা হয়নি।</p>'; return; }
  r.gifts.forEach((g) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      ${g.thumbnail ? `<img src="${g.thumbnail}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;">` : ""}
      <div class="data-row-main"><b>${escapeHtml(g.name)}</b><span class="sub">${g.price.toLocaleString()} 🪙 · ${g.duration}s ${g.enabled === false ? "· বন্ধ" : ""}</span></div>
      <button class="btn btn-ghost btn-toggle-vgift" data-id="${g.id}">${g.enabled === false ? "Enable" : "Disable"}</button>
      <button class="btn btn-danger btn-delete-vgift" data-id="${g.id}">মুছে ফেলো</button>
    `;
    wrap.appendChild(row);
  });
}

$("vgift-catalog-list").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest(".btn-toggle-vgift");
  if (toggleBtn) {
    const r = await api(`/api/admin/video-gifts/${toggleBtn.dataset.id}/toggle`, "POST");
    if (r.success) loadVideoGifts(); else toast(r.message || "ব্যর্থ হয়েছে", true);
    return;
  }
  const deleteBtn = e.target.closest(".btn-delete-vgift");
  if (deleteBtn) {
    if (!confirm("এই Video Gift টা মুছে ফেলবে? এটা সব ইউজারের Gift Box থেকেও সরে যাবে।")) return;
    const r = await api(`/api/admin/video-gifts/${deleteBtn.dataset.id}`, "DELETE");
    if (r.success) loadVideoGifts(); else toast(r.message || "ব্যর্থ হয়েছে", true);
  }
});

$("btn-upload-vgift").addEventListener("click", async () => {
  const name = $("vgift-name").value.trim();
  const price = Number($("vgift-price").value);
  const duration = Number($("vgift-duration").value) || 6;
  const videoFile = $("vgift-video-file").files[0];
  const thumbFile = $("vgift-thumb-file").files[0];
  if (!name) { toast("Gift Name দাও", true); return; }
  if (!videoFile) { toast("MP4 ভিডিও ফাইল বেছে নাও", true); return; }
  if (!price || price < 100000) { toast("Coin Price কমপক্ষে 100000 হতে হবে", true); return; }
  if (duration < 6 || duration > 8) { toast("Duration ৬-৮ সেকেন্ডের মধ্যে দাও", true); return; }
  const fd = new FormData();
  fd.append("video", videoFile);
  if (thumbFile) fd.append("thumbnail", thumbFile);
  fd.append("name", name);
  fd.append("price", price);
  fd.append("duration", duration);
  const r = await apiUpload("/api/admin/video-gifts/upload", fd);
  if (r.success) {
    toast("Video Gift আপলোড হয়েছে");
    $("vgift-name").value = ""; $("vgift-price").value = ""; $("vgift-duration").value = "";
    $("vgift-video-file").value = ""; $("vgift-thumb-file").value = "";
    loadVideoGifts();
  } else toast(r.message || "আপলোড ব্যর্থ হয়েছে", true);
});

// ===========================================================================
// AGENCIES
// ===========================================================================
async function loadAgencies() {
  const r = await api("/api/admin/agency/list");
  const wrap = $("agencies-list");
  wrap.innerHTML = "";
  if (r.success) r.agencies.forEach((a) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(a.name)}</b><span class="sub">ID: ${escapeHtml(a.agencyId)} · Owner: ${escapeHtml(a.ownerUserId)} · Hosts: ${a.hostIds.length} · Rate: ${(a.commissionRate * 100).toFixed(0)}%</span></div><span class="badge badge-ok">💎 ${a.earnedDiamonds || 0}</span>`;
    wrap.appendChild(row);
  });
}

$("btn-create-agency").addEventListener("click", async () => {
  const name = $("agency-name").value.trim();
  const ownerUserId = $("agency-owner").value.trim();
  const commissionRate = $("agency-rate").value ? Number($("agency-rate").value) : undefined;
  if (!name || !ownerUserId) { toast("নাম ও Owner ID দাও", true); return; }
  const r = await api("/api/admin/agency/create", "POST", { name, ownerUserId, commissionRate });
  if (r.success) { toast("Agency তৈরি হয়েছে"); $("agency-name").value = ""; $("agency-owner").value = ""; loadAgencies(); } else toast(r.message, true);
});

$("btn-assign-host").addEventListener("click", async () => {
  const agencyId = $("assign-agency-id").value.trim();
  const hostUserId = $("assign-host-id").value.trim();
  if (!agencyId || !hostUserId) { toast("Agency ID ও Host ID দাও", true); return; }
  const r = await api("/api/admin/agency/assign-host", "POST", { agencyId, hostUserId });
  if (r.success) { toast("Host assign হয়েছে"); loadAgencies(); } else toast(r.message, true);
});

// ===========================================================================
// ANNOUNCEMENTS
// ===========================================================================
$("btn-send-announce").addEventListener("click", async () => {
  const text = $("announce-text").value.trim();
  if (!text) return;
  const r = await api("/api/admin/announcements", "POST", { text });
  if (r.success) { toast("Broadcast করা হয়েছে"); $("announce-text").value = ""; } else toast(r.message, true);
});

// ===========================================================================
// TREASURE CHEST
// ===========================================================================
let chestLevelsCache = [];

async function loadChestLevels() {
  const r = await api("/api/chest/config");
  chestLevelsCache = r.success ? r.levels : [];
  renderChestLevelsForm();
}

function renderChestLevelsForm() {
  const wrap = $("chest-levels-form");
  wrap.innerHTML = "";
  chestLevelsCache.forEach((lvl, i) => {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <h3 class="sub-head" style="margin-top:0;">Level ${lvl.level}</h3>
      <div class="form-row">
        <label style="font-size:12px;color:var(--text-dim);">Target diamonds:</label>
        <input type="number" class="field lvl-target" value="${lvl.target}" style="max-width:160px;">
        <button class="btn btn-danger btn-sm lvl-remove">এই Level মুছো</button>
      </div>
      <label class="field-label">Reward pool (JSON array, e.g. [{"type":"coins","amount":500}])</label>
      <textarea class="field lvl-rewards" rows="2" style="width:100%;font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(JSON.stringify(lvl.rewardPool))}</textarea>
    `;
    panel.querySelector(".lvl-target").addEventListener("input", (e) => { chestLevelsCache[i].target = Number(e.target.value) || 0; });
    panel.querySelector(".lvl-rewards").addEventListener("input", (e) => {
      try { chestLevelsCache[i].rewardPool = JSON.parse(e.target.value); } catch (err) { /* wait for valid JSON before saving */ }
    });
    panel.querySelector(".lvl-remove").addEventListener("click", () => {
      chestLevelsCache.splice(i, 1);
      chestLevelsCache.forEach((l, idx) => { l.level = idx + 1; });
      renderChestLevelsForm();
    });
    wrap.appendChild(panel);
  });
}

$("btn-add-chest-level").addEventListener("click", () => {
  const lastTarget = chestLevelsCache.length ? chestLevelsCache[chestLevelsCache.length - 1].target : 0;
  chestLevelsCache.push({ level: chestLevelsCache.length + 1, target: lastTarget + 100000, rewardPool: [{ type: "coins", amount: 500 }] });
  renderChestLevelsForm();
});

$("btn-save-chest-levels").addEventListener("click", async () => {
  const r = await api("/api/admin/chest/config", "POST", { levels: chestLevelsCache });
  if (r.success) { toast("Chest levels সেভ হয়েছে"); chestLevelsCache = r.levels; renderChestLevelsForm(); }
  else toast(r.message || "সমস্যা হয়েছে", true);
});

// ===========================================================================
// COIN CENTER
// ===========================================================================
let ccSelectedUser = null;      // single mode
let ccSelectedUsers = [];       // multi mode — array of {userId, name, coins}
function ccIsMulti() { return $("cc-multi-toggle").checked; }

async function loadCoinCenter() {
  const r = await api("/api/admin/coin-center/balance");
  $("cc-balance").textContent = r.success ? `${r.systemBalance.toLocaleString()} coins` : "—";

  const logWrap = $("cc-log-list");
  logWrap.innerHTML = "";
  const lr = await api("/api/admin/coin-center/log");
  if (lr.success) lr.log.forEach((entry) => {
    if (entry.type === "balance_set") return; // balance top-ups aren't per-user transfers
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(entry.targetName || entry.targetUserId)}</b><span class="sub">+${entry.amount} coins · ${escapeHtml(entry.reason || "কোনো নোট নেই")} · by ${escapeHtml(entry.adminUsername)}</span></div><span class="sub">${new Date(entry.time).toLocaleString()}</span>`;
    logWrap.appendChild(row);
  });
}

$("btn-cc-set-balance").addEventListener("click", async () => {
  const amount = $("cc-balance-input").value;
  if (amount === "") { toast("একটা পরিমাণ দাও", true); return; }
  const r = await api("/api/admin/coin-center/balance", "POST", { amount: Number(amount) });
  if (r.success) { toast("System balance আপডেট হয়েছে"); $("cc-balance-input").value = ""; loadCoinCenter(); }
  else toast(r.message || "সমস্যা হয়েছে", true);
});

$("cc-multi-toggle").addEventListener("change", () => {
  ccSelectedUser = null;
  ccSelectedUsers = [];
  $("cc-user-card").style.display = "none";
  renderCcRecipients();
  $("btn-cc-send").disabled = true;
  $("btn-cc-send").textContent = "Coin Center থেকে পাঠাও";
});

function renderCcRecipients() {
  const wrap = $("cc-recipients-list");
  if (!ccIsMulti() || !ccSelectedUsers.length) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
  wrap.style.display = "flex";
  wrap.innerHTML = "";
  ccSelectedUsers.forEach((u) => {
    const chip = document.createElement("span");
    chip.className = "badge badge-ok";
    chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;padding:6px 10px;";
    chip.innerHTML = `${escapeHtml(u.name)} (${escapeHtml(u.userId)}) <button style="border:none;background:none;color:inherit;cursor:pointer;font-weight:800;">✕</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      ccSelectedUsers = ccSelectedUsers.filter((x) => x.userId !== u.userId);
      renderCcRecipients();
      $("btn-cc-send").disabled = ccSelectedUsers.length === 0;
    });
    wrap.appendChild(chip);
  });
  $("btn-cc-send").textContent = `${ccSelectedUsers.length} জনকে Coin Center থেকে পাঠাও`;
}

$("btn-cc-search").addEventListener("click", async () => {
  const query = $("cc-search").value.trim();
  if (!query) { toast("User ID অথবা Mobile Number দাও", true); return; }
  const r = await api(`/api/admin/coin-center/search?query=${encodeURIComponent(query)}`);
  if (!r.success) {
    if (!ccIsMulti()) { ccSelectedUser = null; $("btn-cc-send").disabled = true; }
    const card = $("cc-user-card");
    card.style.display = "block";
    card.innerHTML = `<span class="sub">${escapeHtml(r.message || "ইউজার পাওয়া যায়নি")}</span>`;
    return;
  }

  if (ccIsMulti()) {
    if (ccSelectedUsers.some((u) => u.userId === r.user.userId)) { toast("এই ইউজার আগেই লিস্টে আছে"); return; }
    ccSelectedUsers.push(r.user);
    $("cc-search").value = "";
    $("cc-user-card").style.display = "none";
    renderCcRecipients();
    $("btn-cc-send").disabled = false;
  } else {
    ccSelectedUser = r.user;
    const card = $("cc-user-card");
    card.style.display = "block";
    card.innerHTML = `<div class="data-row-main"><b>${escapeHtml(r.user.name)}</b><span class="sub">ID: ${escapeHtml(r.user.userId)} · বর্তমান কয়েন: ${r.user.coins.toLocaleString()}</span></div>`;
    $("btn-cc-send").disabled = false;
  }
});

$("btn-cc-send").addEventListener("click", async () => {
  const amount = Number($("cc-amount").value);
  const reason = $("cc-reason").value.trim();
  if (!Number.isInteger(amount) || amount <= 0) { toast("সঠিক (পূর্ণসংখ্যা) কয়েনের পরিমাণ দাও", true); return; }

  const requestId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const btn = $("btn-cc-send");

  if (ccIsMulti()) {
    if (!ccSelectedUsers.length) { toast("আগে অন্তত একজন User খুঁজে যোগ করো", true); return; }
    if (!confirm(`${ccSelectedUsers.length} জন ইউজারকে প্রত্যেককে ${amount} coins করে পাঠাবে?`)) return;
    btn.disabled = true;
    try {
      const targetUserIds = ccSelectedUsers.map((u) => u.userId);
      const r = await api("/api/admin/coin-center/send-bulk", "POST", { targetUserIds, amount, reason, requestId });
      if (r.success) {
        toast(`${r.successCount} জনকে ${amount} coins করে পাঠানো হয়েছে${r.failCount ? ` (${r.failCount} জনের ক্ষেত্রে ব্যর্থ)` : ""}`);
        $("cc-amount").value = "";
        $("cc-reason").value = "";
        ccSelectedUsers = [];
        renderCcRecipients();
        loadCoinCenter();
      } else {
        toast(r.message || "পাঠাতে ব্যর্থ হয়েছে", true);
      }
    } finally {
      btn.disabled = ccSelectedUsers.length === 0;
    }
    return;
  }

  if (!ccSelectedUser) { toast("আগে একজন User খুঁজে বের করো", true); return; }
  if (!confirm(`${ccSelectedUser.name} (${ccSelectedUser.userId})-কে ${amount} coins পাঠাবে?`)) return;

  // requestId is generated once per confirmed click and the button is
  // disabled immediately, so an accidental double-click (or a retried
  // network request carrying the same requestId) can't credit twice —
  // the server's idempotency cache replays the first result instead.
  btn.disabled = true;
  try {
    const r = await api("/api/admin/coin-center/send", "POST", { targetUserId: ccSelectedUser.userId, amount, reason, requestId });
    if (r.success) {
      toast(`${amount} coins পাঠানো হয়েছে`);
      $("cc-amount").value = "";
      $("cc-reason").value = "";
      ccSelectedUser.coins = r.coins;
      $("cc-user-card").querySelector(".sub").textContent = `ID: ${ccSelectedUser.userId} · বর্তমান কয়েন: ${r.coins.toLocaleString()}`;
      loadCoinCenter();
    } else {
      toast(r.message || "পাঠাতে ব্যর্থ হয়েছে", true);
    }
  } finally {
    btn.disabled = false;
  }
});

// ===========================================================================
// AI CORE
// ===========================================================================
let aiCoreTimer = null;

function fmtUptime(sec) {
  if (!sec) return "–";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadAiCore() {
  const [statusR, analyticsR, monitorR, logsR] = await Promise.all([
    api("/api/admin/ai/status"),
    api("/api/admin/ai/analytics"),
    api("/api/admin/ai/monitor/history"),
    api("/api/admin/ai/logs?limit=50"),
  ]);

  if (statusR.success) {
    $("ai-provider").textContent = statusR.provider || "–";
    $("ai-key-warning").classList.toggle("hidden", !!statusR.apiKeyConfigured);
    const badge = $("ai-status-badge");
    const label = { healthy: "Healthy", warning: "Warning", critical: "Critical" }[statusR.status] || "Unknown";
    badge.textContent = label;
    badge.className = "badge " + (statusR.status === "critical" ? "badge-danger" : statusR.status === "warning" ? "badge-warn" : "badge-ok");
  }

  if (analyticsR.success) {
    $("ai-conversations").textContent = analyticsR.stats.totalAiConversations || 0;
    $("ai-replies").textContent = analyticsR.stats.totalAiReplies || 0;
    $("ai-flags").textContent = (analyticsR.stats.totalModerationFlags || 0) + (analyticsR.stats.totalRateLimitHits || 0);
  }

  if (monitorR.success && monitorR.history.length) {
    const last = monitorR.history[monitorR.history.length - 1];
    $("ai-mem").textContent = last.memoryMB ?? "–";
    $("ai-lag").textContent = last.eventLoopLagMs ?? "–";
    $("ai-online").textContent = last.onlineUsers ?? "–";
    $("ai-uptime").textContent = fmtUptime(last.uptimeSec);
  }

  const rows = $("ai-log-rows");
  rows.innerHTML = "";
  const logs = logsR.success ? logsR.logs : [];
  $("ai-log-empty").classList.toggle("hidden", logs.length > 0);
  logs.forEach((l) => {
    const tr = document.createElement("tr");
    const time = new Date(l.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    tr.innerHTML = `<td>${escapeHtml(time)}</td><td>${escapeHtml(l.module || "")}</td><td>${escapeHtml(l.action || "")}</td><td>${escapeHtml(String(l.result || ""))}</td>`;
    rows.appendChild(tr);
  });

  clearInterval(aiCoreTimer);
  aiCoreTimer = setInterval(() => { if ($("sec-ai-core").classList.contains("active")) loadAiCore(); }, 30000);
}

// ===========================================================================
// BOOTSTRAP
// ===========================================================================
if (token) enterShell(); else $("view-login").classList.add("active");
