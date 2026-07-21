/* ==========================================================================
   PingPong frontend — talks to server.js exactly as written.
   ========================================================================== */

const API = ""; // same-origin
const GIFT_CATALOG_CACHE = { gifts: [] };

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let me = null;
let socket = null;
let currentRoom = null;
let currentRoomId = null;
let mySeatNumber = null;
let seatMap = {};
let localStream = null;
let micEnabled = false;
const peerConnections = {};
const remoteAudioEls = {};
// Fix (voice stability): ICE candidates that arrive before setRemoteDescription
// has finished are queued here instead of being silently dropped/failed.
const pendingCandidates = {};
const speakingUsers = new Set(); // userIds currently detected as speaking (real-time)

let followListMode = "followers";
let threadPeerId = null;
let threadPeerName = null;

// ---------------------------------------------------------------------------
// Fix (pinch/double-tap zoom bug): some mobile browsers/WebViews still let
// people zoom the page even with user-scalable=no and touch-action set —
// which breaks every fixed-position overlay (room TV screen, modals, the
// bottom toolbar). This is a hard JS-level safety net on top of those:
// block any multi-finger touch move, any native pinch gesture, and any
// double-tap that's fast enough to be a zoom tap rather than two real taps.
document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());
let __lastTouchEndTs = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - __lastTouchEndTs <= 300) e.preventDefault();
  __lastTouchEndTs = now;
}, { passive: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(id).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(`.nav-btn[data-nav="${navKeyFor(id)}"]`).forEach((b) => b.classList.add("active"));
}
function navKeyFor(viewId) {
  return { "view-home": "home", "view-inbox": "inbox", "view-profile": "profile" }[viewId] || "";
}

async function api(path, method = "GET", body = null, headers = {}) {
  try {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return await res.json();
  } catch (err) {
    toast("নেটওয়ার্ক সমস্যা হয়েছে");
    return { success: false, message: "network error" };
  }
}

async function apiUpload(path, formData, headers = {}) {
  try {
    const res = await fetch(API + path, { method: "POST", body: formData, headers });
    return await res.json();
  } catch (err) {
    toast("আপলোড সমস্যা হয়েছে");
    return { success: false, message: "network error" };
  }
}

function vipClass(level) { return "vip-" + Math.max(0, Math.min(5, Number(level) || 0)); }
function applyVipBadge(el, level) {
  el.className = "vip-badge " + vipClass(level);
  el.textContent = "VIP " + (Number(level) || 0);
}
function applyFrameRing(wrapEl, level) {
  wrapEl.className = wrapEl.className.replace(/\bvip-\d\b/g, "").trim();
  wrapEl.classList.add(vipClass(level));
}
// Admin-issued custom PNG frame overlay — decorates the avatar without
// ever resizing it (absolutely positioned, own layer, see CSS).
function applyCustomFrame(wrapEl, activeFrame) {
  if (!wrapEl) return;
  const existing = wrapEl.querySelector(".custom-frame-img");
  if (activeFrame && activeFrame.imageUrl) {
    wrapEl.classList.add("has-custom-frame");
    if (existing) existing.src = activeFrame.imageUrl;
    else {
      const img = document.createElement("img");
      img.className = "custom-frame-img";
      img.src = activeFrame.imageUrl;
      img.alt = "";
      wrapEl.appendChild(img);
    }
  } else {
    wrapEl.classList.remove("has-custom-frame");
    if (existing) existing.remove();
  }
}

function saveSession() { localStorage.setItem("pp_user", JSON.stringify(me)); }
function loadSession() {
  const raw = localStorage.getItem("pp_user");
  if (raw) { try { me = JSON.parse(raw); } catch (e) { me = null; } }
}

// Fix (session/room loss on refresh): currentRoomId previously lived only
// in a JS variable, so refreshing the page while inside a voice room reset
// it to null — the user landed back on the home screen even though their
// login session was completely fine, which read as "got logged out". We
// now persist which room the user was in and rejoin it automatically once
// the socket reconnects (see connectSocket()'s "connect" handler below).
function saveActiveRoom(roomId) {
  if (roomId) localStorage.setItem("pp_room", roomId);
  else localStorage.removeItem("pp_room");
}
function loadActiveRoom() { return localStorage.getItem("pp_room"); }

// ===========================================================================
// AUTH
// ===========================================================================
$("btn-send-otp").addEventListener("click", async () => {
  const mobile = $("mobile-input").value.trim();
  if (mobile.length !== 10) { toast("সঠিক ১০ ডিজিট নম্বর দাও"); return; }
  const r = await api("/api/auth/send-otp", "POST", { mobile });
  if (r.success) {
    $("otp-mobile-display").textContent = mobile;
    $("step-mobile").classList.add("hidden");
    $("step-otp").classList.remove("hidden");
  } else toast(r.message || "সমস্যা হয়েছে");
});

$("btn-back-mobile").addEventListener("click", () => {
  $("step-otp").classList.add("hidden");
  $("step-mobile").classList.remove("hidden");
});

$("btn-verify-otp").addEventListener("click", async () => {
  const mobile = $("mobile-input").value.trim();
  const otp = $("otp-input").value.trim();
  if (!otp) { toast("OTP দাও"); return; }
  const r = await api("/api/auth/verify-otp", "POST", { mobile, otp });
  if (r.success) {
    me = r.user;
    saveSession();
    connectSocket();
    enterApp();
  } else toast(r.message || "লগইন ব্যর্থ হয়েছে");
});

// ===========================================================================
// SCREEN WAKE LOCK
// ===========================================================================
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) { /* not supported / denied — fail silently */ }
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && me) await requestWakeLock();
});

function enterApp() {
  fillHomeProfile();
  loadRoomList();
  loadAnnouncements();
  requestWakeLock();
  showView("view-home");
}

// ===========================================================================
// SOCKET.IO
// ===========================================================================
function connectSocket() {
  if (socket) return;
  socket = io();

  socket.on("connect", () => { if (currentRoomId) rejoinRoom(); });

  socket.on("room-list", renderRoomList);

  socket.on("room-state", async (room) => {
    currentRoom = room;
    hydrateSeatMap(room.seats);
    renderSeats(room.seats);
    // Fix (voice goes silent after reconnect/refresh): seat data is hydrated
    // above, but that alone doesn't re-establish WebRTC audio to peers who
    // were already seated before we (re)connected — previously you'd see
    // them on their seat but hear nothing until they happened to re-take a
    // seat. If we're seated ourselves, (re)connect to every other occupied
    // seat's current socket, and drop any peer connection that's stale
    // (pointing at a socket id that's no longer actually seated here).
    //
    // Fix (one side hears nothing): the mic used to be requested *after*
    // this reconnect loop ran, so the very first peer connections could be
    // created with no outgoing audio track at all — the other person would
    // see us on our seat but never hear us. Mic is awaited first now, and
    // connectToPeer() is itself deduped (see below) so this repeated call
    // on every room-state broadcast can no longer create duplicate/competing
    // connections to the same peer.
    if (mySeatNumber !== null) {
      await initMicIfNeeded();
      const liveSocketIds = new Set(
        room.seats.filter((s) => s && s.userId !== me.userId).map((s) => s.socketId)
      );
      Object.keys(peerConnections).forEach((sid) => { if (!liveSocketIds.has(sid)) closePeer(sid); });
      liveSocketIds.forEach((sid) => { if (sid) connectToPeer(sid); });
    }
    renderChatLog(room.messages || []);
    $("room-name-display").textContent = room.roomName;
    $("room-host-display").textContent = "Host: " + room.hostName;
    if (room.music && room.music.url) setMusicUI(room.music);
    $("stage-wrap").style.backgroundImage = room.background ? `url(${room.background})` : "";
    setRoomLogo(room.logo);
    const canModerate = room.hostId === me.userId || (room.adminIds || []).includes(me.userId);
    $("btn-room-mod").classList.toggle("hidden", !canModerate);
    if (room.treasureChest) renderChest(room.treasureChest);
    initMicIfNeeded();

    // Fix: the game overlay's toggle button is only shown when an admin has
    // actually enabled games for this room (see Admin Panel → Rooms). If an
    // admin turns it off while someone has it open, close it for them too.
    const gameAllowed = room.gameEnabled !== false;
    $("btn-toggle-game").classList.toggle("hidden", !gameAllowed);
    if (!gameAllowed) closeRoomGame();
  });

  socket.on("user-count", (data) => { $("room-online-count").textContent = "👥 " + data.count; });

  socket.on("seat-update", (data) => {
    if (data.action === "take") {
      if (data.oldSeatNumber && seatMap[data.oldSeatNumber]) delete seatMap[data.oldSeatNumber];
      seatMap[data.seatNumber] = { userId: data.userId, socketId: data.socketId, userName: data.userName, userPhoto: data.userPhoto, role: data.role, activeFrame: data.activeFrame || null, vipLevel: data.vipLevel || 0 };
      if (data.userId === me.userId) {
        mySeatNumber = data.seatNumber;
      } else if (mySeatNumber !== null) {
        connectToPeer(data.socketId);
      }
    } else if (data.action === "leave") {
      const entry = seatMap[data.seatNumber];
      if (entry) {
        if (entry.userId === me.userId) { mySeatNumber = null; }
        closePeer(entry.socketId);
        speakingUsers.delete(entry.userId);
        delete seatMap[data.seatNumber];
      }
    }
    if (currentRoom) renderSeats(seatsFromMap());
  });

  // Real-time voice activity from other participants — drives the speaking
  // ring/waveform on the correct seat, independent of who's just "seated".
  socket.on("voice-activity", (data) => {
    if (data.speaking) speakingUsers.add(data.userId); else speakingUsers.delete(data.userId);
    if (currentRoom) renderSeats(seatsFromMap());
  });

  socket.on("new-message", (msg) => appendChatMsg(msg));

  socket.on("gift-received", (data) => {
    appendChatMsg({
      userId: data.fromUserId, userName: data.fromName,
      message: `${data.gift.emoji} ${data.gift.name} পাঠিয়েছে`,
      time: "", system: true
    });
    pushGiftBanner(`${data.fromName} sent ${data.gift.emoji} ${data.gift.name}`);
    spawnGiftFly(data.gift, data.fromUserId, data.toUserId);
    playGiftSound(data.gift.tier);
    flashSeatReceive(data.toUserId);
    toast(`🎁 ${data.fromName} sent ${data.gift.emoji} ${data.gift.name}`);
    if (data.toUserId === me.userId) {
      me.diamonds += data.gift.price;
      me.vipLevel = vipLevelFromDiamondsClient(me.diamonds);
      saveSession(); fillHomeProfile();
    }
  });

  socket.on("music-update", (music) => setMusicUI(music));

  // Fix (game coins vs wallet coins looked like two separate balances):
  // wallet-update only fired for gifts/chest/admin changes, while the
  // Food Wheel / Teen Patti sync result only patched me.coins + the home
  // screen. Both now go through the same function so every place coins are
  // shown (home, menu, wallet modal, gift modal, an open game) updates
  // together, in real time, from a single source of truth.
  function applyWalletUpdate(data) {
    if (typeof data.coins === "number") me.coins = data.coins;
    if (typeof data.diamonds === "number") me.diamonds = data.diamonds;
    if (typeof data.level === "number") me.level = data.level;
    if (typeof data.vipLevel === "number") me.vipLevel = data.vipLevel;
    saveSession(); fillHomeProfile();
    const menuCoins = $("menu-wallet-coins"), menuDiamonds = $("menu-wallet-diamonds");
    if (menuCoins) menuCoins.textContent = me.coins;
    if (menuDiamonds) menuDiamonds.textContent = me.diamonds;
    const walletCoins = $("wallet-coins"), walletDiamonds = $("wallet-diamonds");
    if (walletCoins) walletCoins.textContent = me.coins;
    if (walletDiamonds) walletDiamonds.textContent = me.diamonds;
    const pill = $("gift-modal-coins");
    if (pill && !$("modal-gift").classList.contains("hidden")) pill.textContent = me.coins;

    // Coins can change for any reason while a room game is open (a gift
    // sent/received, a reward, an admin adjustment) — not just from
    // playing. Push the fresh real balance straight into whichever game is
    // currently loaded so its on-screen wallet always matches the account,
    // in real time, not just at open.
    if ($("room-tv-screen").classList.contains("tv-open") && $("room-tv-frame").src) {
      const gameType = roomTvActiveGame === "teenpatti" ? "TEENPATTI_INIT" : "FOODWHEEL_INIT";
      try { $("room-tv-frame").contentWindow.postMessage({ type: gameType, balance: me.coins || 0 }, "*"); } catch (e) {}
    }
  }

  socket.on("wallet-update", applyWalletUpdate);
  socket.on("game-wheel-sync-result", applyWalletUpdate);

  // Someone else in the room opened/closed the game — mirror it here so
  // everyone sees the same full-screen game at the same time.
  socket.on("game-toggle", (data) => {
    if (!data) return;
    if (data.open) openRoomGame(data.game, true);
    else closeRoomGame(true);
  });

  socket.on("room-error", (data) => {
    toast(data.message || "রুমে সমস্যা হয়েছে");
    // The room we tried to (re)join is gone/locked — don't keep retrying it
    // on every future refresh/reconnect.
    if (currentRoomId && (!currentRoom || currentRoom.roomId !== currentRoomId)) {
      currentRoomId = null; currentRoom = null;
      saveActiveRoom(null);
      showView("view-home"); loadRoomList();
    }
  });

  socket.on("announcement", (entry) => {
    const banner = $("announce-banner");
    banner.textContent = "📢 " + entry.text;
    banner.classList.remove("hidden");
    setTimeout(() => banner.classList.add("hidden"), 6000);
    toast("📢 " + entry.text);
  });

  socket.on("seat-lock-update", (data) => {
    if (!currentRoom) return;
    currentRoom.lockedSeats = currentRoom.lockedSeats || [];
    if (data.locked) {
      if (!currentRoom.lockedSeats.includes(data.seatNumber)) currentRoom.lockedSeats.push(data.seatNumber);
    } else {
      currentRoom.lockedSeats = currentRoom.lockedSeats.filter(n => n !== data.seatNumber);
    }
    renderSeats(seatsFromMap());
  });

  socket.on("room-background-update", (data) => {
    $("stage-wrap").style.backgroundImage = data.url ? `url(${data.url})` : "";
    if (currentRoom) currentRoom.background = data.url;
  });

  socket.on("room-logo-update", (data) => {
    setRoomLogo(data.url);
    if (currentRoom) currentRoom.logo = data.url;
  });

  socket.on("chat-cleared", (data) => {
    $("chat-log").innerHTML = "";
    appendChatMsg({ system: true, message: `${data.by} chat clear করেছে` });
  });

  socket.on("kicked", (data) => {
    toast(data.message || "তোমাকে রুম থেকে বের করে দেওয়া হয়েছে");
    teardownVoice();
    closeRoomGame();
    currentRoomId = null; currentRoom = null;
    saveActiveRoom(null);
    showView("view-home"); loadRoomList();
  });

  socket.on("chest-opened", (data) => {
    const amRecipient = (currentRoom && currentRoom.hostId === me.userId) ||
      (data.topContributors || []).some((c) => c.userId === me.userId);
    if (amRecipient) {
      if (data.reward.type === "coins") me.coins += data.reward.amount;
      else me.diamonds += data.reward.amount;
      saveSession(); fillHomeProfile();
    }
    playChestOpenAnimation(data);
  });

  socket.on("new-private-message", (msg) => {
    if (threadPeerId && (msg.from === threadPeerId || msg.to === threadPeerId)) {
      appendThreadMsg(msg);
    } else {
      toast("নতুন মেসেজ এসেছে");
    }
  });

  // Admin sent (or removed) a profile frame while we're online.
  socket.on("frame-updated", (frame) => {
    me.activeFrame = frame;
    saveSession();
    fillHomeProfile();
    toast(frame ? "🖼️ তুমি নতুন frame পেয়েছো!" : "Frame সরানো হয়েছে");
  });

  socket.on("voice-offer", async (data) => {
    try {
      const pc = getOrCreatePeer(data.from);
      // Fix (glare / broken one-way audio): if we already have a local
      // offer pending (we're mid-negotiation ourselves) and we're the
      // designated offerer for this pair, our own offer wins — ignore the
      // incoming one and let our offer complete instead of corrupting the
      // connection with setRemoteDescription() in the wrong state.
      if (pc.signalingState === "have-local-offer" && isLocalOfferer(data.from)) return;
      if (pc.signalingState === "have-local-offer") {
        // We're the polite side — drop our own pending offer and accept theirs.
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      await flushPendingCandidates(data.from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("voice-answer", { target: data.from, answer });
    } catch (e) { /* stale/raced offer — the next reconnect pass will recover */ }
  });

  socket.on("voice-answer", async (data) => {
    const pc = peerConnections[data.from];
    if (!pc) return;
    try {
      if (pc.signalingState !== "have-local-offer") return; // stale answer, ignore
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      await flushPendingCandidates(data.from);
    } catch (e) { /* ignore — recovery loop will retry if this leaves us disconnected */ }
  });

  socket.on("voice-candidate", async (data) => {
    const pc = peerConnections[data.from];
    if (!pc || !data.candidate) return;
    // Fix ("connected but no audio"): candidates that arrive before the
    // remote description is applied used to just fail silently and get
    // dropped — queue them and flush once setRemoteDescription completes.
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      (pendingCandidates[data.from] || (pendingCandidates[data.from] = [])).push(data.candidate);
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
  });

  async function flushPendingCandidates(remoteSocketId) {
    const queued = pendingCandidates[remoteSocketId];
    if (!queued || !queued.length) return;
    pendingCandidates[remoteSocketId] = [];
    const pc = peerConnections[remoteSocketId];
    if (!pc) return;
    for (const candidate of queued) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  }
}

function rejoinRoom() {
  $("chat-log").innerHTML = "";
  setRoomLogo(null);
  socket.emit("join-room", { roomId: currentRoomId, userId: me.userId, userName: me.name, userPhoto: me.photo || "" });
  loadGiftBanner(currentRoomId);
  showView("view-room");
}

// ===========================================================================
// HOME / ROOM LIST
// ===========================================================================
function fillHomeProfile() {
  $("home-avatar").src = me.photo || placeholderAvatar(me.name);
  $("home-username").textContent = me.name;
  $("home-coins").textContent = me.coins;
  $("home-diamonds").textContent = me.diamonds;
  applyVipBadge($("home-vip-badge"), me.vipLevel);
  applyFrameRing($("home-avatar-frame"), me.vipLevel);
  applyCustomFrame($("home-avatar-frame"), me.activeFrame);
  checkAgencyMenu();
}

async function loadAnnouncements() {
  const r = await api("/api/announcements");
  if (r.success && r.announcements.length) {
    const box = $("home-announcements");
    box.classList.remove("hidden");
    box.textContent = "📢 " + r.announcements[0].text;
  }
}

async function checkAgencyMenu() {
  const r = await api("/api/agency/mine/" + me.userId);
  $("menu-agency").classList.toggle("hidden", !(r.success && r.agency));
}
function placeholderAvatar(name) {
  const initial = (name || "U").trim().charAt(0).toUpperCase();
  return "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#34244C"/><text x="50" y="62" font-size="40" fill="#F0A868" text-anchor="middle" font-family="sans-serif">${initial}</text></svg>`
  );
}

async function loadRoomList() {
  const r = await api("/api/room/list");
  if (r.success) renderRoomList(r.rooms);
}

function renderRoomList(rooms) {
  const wrap = $("room-list");
  wrap.innerHTML = "";
  $("room-empty").classList.toggle("hidden", rooms.length > 0);
  rooms.forEach((room) => {
    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `
      <div class="room-card-icon">${room.logo ? `<img src="${escapeHtml(room.logo)}" alt="">` : "🎙️"}</div>
      <div class="room-card-body">
        <h3>${escapeHtml(room.roomName)}</h3>
        <span class="sub">Host: ${escapeHtml(room.hostName)} · 👥 ${room.onlineCount}</span>
      </div>
      <button class="btn btn-primary btn-sm join-btn">Join</button>
    `;
    card.querySelector(".join-btn").addEventListener("click", () => joinRoom(room.roomId));
    wrap.appendChild(card);
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

// Shows/hides the room logo in the room header — used on join and whenever
// the owner/admin changes it live.
function setRoomLogo(url) {
  const img = $("room-logo-display");
  if (!img) return;
  if (url) { img.src = url; img.classList.remove("hidden"); }
  else { img.src = ""; img.classList.add("hidden"); }
}

$("btn-create-room").addEventListener("click", () => {
  $("create-room-name").value = "";
  $("modal-create-room").classList.remove("hidden");
});
$("btn-cancel-create-room").addEventListener("click", () => $("modal-create-room").classList.add("hidden"));
$("btn-confirm-create-room").addEventListener("click", async () => {
  const roomName = $("create-room-name").value.trim();
  const r = await api("/api/room/create", "POST", { roomName, userId: me.userId, userName: me.name });
  $("modal-create-room").classList.add("hidden");
  if (r.success) { joinRoom(r.room.roomId); return; }
  if (r.existingRoomId) {
    if (confirm(r.message + "\n\nআগের রুমে যেতে চাও?")) joinRoom(r.existingRoomId);
  } else toast(r.message || "Room তৈরি করা যায়নি");
});

document.querySelectorAll('.nav-btn[data-nav="home"]').forEach((b) => b.addEventListener("click", () => { loadRoomList(); showView("view-home"); }));
document.querySelectorAll('.nav-btn[data-nav="profile"]').forEach((b) => b.addEventListener("click", openOwnProfile));
document.querySelectorAll('.nav-btn[data-nav="inbox"]').forEach((b) => b.addEventListener("click", openInbox));

// ===========================================================================
// VOICE ROOM
// ===========================================================================
function joinRoom(roomId) {
  currentRoomId = roomId;
  saveActiveRoom(roomId);
  mySeatNumber = null;
  closeRoomGame();
  seatMap = {};
  speakingUsers.clear();
  $("chat-log").innerHTML = "";
  $("btn-room-mod").classList.add("hidden");
  setRoomLogo(null);
  socket.emit("join-room", { roomId, userId: me.userId, userName: me.name, userPhoto: me.photo || "" });
  loadGiftBanner(roomId);
  showView("view-room");
}

$("btn-leave-room").addEventListener("click", () => {
  if (currentRoomId) socket.emit("leave-room", { roomId: currentRoomId, userId: me.userId });
  teardownVoice();
  stopChestCountdown();
  closeRoomGame();
  currentRoomId = null;
  currentRoom = null;
  saveActiveRoom(null);
  showView("view-home");
  loadRoomList();
});

function hydrateSeatMap(seats) {
  seatMap = {};
  seats.forEach((seat, i) => {
    if (seat) {
      seatMap[i + 1] = { userId: seat.userId, socketId: seat.socketId, userName: seat.userName, userPhoto: seat.userPhoto, role: seat.role, activeFrame: seat.activeFrame || null, vipLevel: seat.vipLevel || 0 };
      if (seat.userId === me.userId) mySeatNumber = i + 1;
    }
  });
}
function seatsFromMap() {
  const seats = Array(8).fill(null);
  Object.keys(seatMap).forEach((num) => {
    const entry = seatMap[num];
    seats[num - 1] = {
      userId: entry.userId,
      userName: entry.userName || currentRoom?.onlineUsers?.find(u => u.userId === entry.userId)?.userName || "User",
      userPhoto: entry.userPhoto || "",
      socketId: entry.socketId,
      role: entry.role,
      activeFrame: entry.activeFrame || null,
      vipLevel: entry.vipLevel || 0
    };
  });
  return seats;
}

function renderSeats(seats) {
  const grid = $("seat-grid");
  grid.innerHTML = "";
  const locked = (currentRoom && currentRoom.lockedSeats) || [];
  seats.forEach((seat, i) => {
    const seatNumber = i + 1;
    const isLocked = locked.includes(seatNumber);
    const div = document.createElement("div");
    div.className = "seat" + (seat ? " occupied" : "") + (isLocked ? " locked" : "") +
      (seat && speakingUsers.has(seat.userId) ? " speaking" : "");
    if (seat) div.dataset.userId = seat.userId;
    const circle = document.createElement("div");
    circle.className = "seat-circle";
    if (seat) {
      const photoWrap = document.createElement("div");
      photoWrap.className = "seat-avatar-photo";
      const img = document.createElement("img");
      img.src = seat.userPhoto || placeholderAvatar(seat.userName);
      photoWrap.appendChild(img);
      circle.appendChild(photoWrap);
      if (seat.vipLevel > 0) applyFrameRing(circle, seat.vipLevel);
      applyCustomFrame(circle, seat.activeFrame);
      if (seat.role === "owner" || seat.role === "admin") {
        const badge = document.createElement("span");
        badge.className = "seat-role";
        badge.textContent = seat.role === "owner" ? "👑" : "🛡️";
        div.style.position = "relative";
        div.appendChild(badge);
      }
    } else {
      circle.textContent = "＋";
    }
    div.appendChild(circle);
    const nameEl = document.createElement("span");
    nameEl.className = "seat-name";
    nameEl.textContent = seat ? seat.userName : ("No." + seatNumber);
    div.appendChild(nameEl);

    div.addEventListener("click", () => {
      if (!seat) {
        socket.emit("take-seat", { roomId: currentRoomId, seatNumber });
      } else if (seat.userId !== me.userId) {
        openOtherProfile(seat.userId);
      }
    });
    grid.appendChild(div);
  });
}

// ---------------- Chat ----------------
function renderChatLog(messages) {
  const log = $("chat-log");
  log.innerHTML = "";
  messages.forEach(appendChatMsg);
}
function appendChatMsg(msg) {
  const log = $("chat-log");
  const div = document.createElement("div");
  div.className = "chat-msg" + (msg.system ? " system" : "");
  div.innerHTML = msg.system
    ? escapeHtml(msg.message)
    : `<span class="who">${escapeHtml(msg.userName)}</span>${escapeHtml(msg.message)}<span class="when">${escapeHtml(msg.time || "")}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
$("btn-send-chat").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
function sendChat() {
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message) return;
  socket.emit("send-message", { roomId: currentRoomId, message });
  input.value = "";
}

function vipLevelFromDiamondsClient(diamonds) {
  if (diamonds >= 5000) return 5;
  if (diamonds >= 2000) return 4;
  if (diamonds >= 800) return 3;
  if (diamonds >= 300) return 2;
  if (diamonds >= 50) return 1;
  return 0;
}

function pushGiftBanner(text) {
  const banner = $("gift-banner");
  const item = document.createElement("div");
  item.className = "gift-banner-item";
  item.textContent = "🎁 " + text;
  banner.prepend(item);
  while (banner.children.length > 3) banner.removeChild(banner.lastChild);
  setTimeout(() => item.remove(), 8000);
}

// Floating gift animation across the stage — its own absolute layer,
// never touches seat-grid layout/dimensions. Flies from the sender's seat
// to the receiver's seat when both are seated, otherwise falls back to a
// simple center float so it never breaks for un-seated senders/receivers.
function seatCircleRect(userId) {
  const el = document.querySelector(`#seat-grid [data-user-id="${userId}"] .seat-circle`);
  if (!el) return null;
  return el.getBoundingClientRect();
}
function spawnGiftFly(gift, fromUserId, toUserId) {
  const layer = $("gift-fly-layer");
  if (!layer) return;
  const tier = gift.tier || "normal";
  const layerRect = layer.getBoundingClientRect();
  const fromRect = seatCircleRect(fromUserId);
  const toRect = seatCircleRect(toUserId);

  const pct = (rect, fallbackX, fallbackY) => {
    if (!rect || !layerRect.width || !layerRect.height) return { x: fallbackX, y: fallbackY };
    const cx = rect.left + rect.width / 2 - layerRect.left;
    const cy = rect.top + rect.height / 2 - layerRect.top;
    return { x: (cx / layerRect.width) * 100, y: (cy / layerRect.height) * 100 };
  };
  const start = pct(fromRect, 50, 92);
  const end = pct(toRect, 50, 10);

  const trailCount = tier === "legend" ? 4 : tier === "vip" ? 3 : 1;
  const duration = tier === "legend" ? 3.0 : tier === "vip" ? 2.4 : 1.8;

  for (let i = 0; i < trailCount; i++) {
    const el = document.createElement("div");
    el.className = "gift-fly-item tier-" + tier + (i > 0 ? " gift-fly-trail" : "");
    el.textContent = gift.emoji;
    el.style.setProperty("--start-x", start.x + "%");
    el.style.setProperty("--start-y", start.y + "%");
    el.style.setProperty("--end-x", end.x + "%");
    el.style.setProperty("--end-y", end.y + "%");
    el.style.animationDuration = duration + "s";
    el.style.animationDelay = (i * 0.08) + "s";
    if (i > 0) el.style.opacity = String(0.5 - i * 0.1);
    layer.appendChild(el);
    setTimeout(() => el.remove(), (duration + 0.5) * 1000);
  }

  if (tier === "legend") spawnLegendBurst(gift);
}

// Full-screen celebration for the highest gift tier — its own fixed overlay,
// completely separate from the room layout so it never resizes anything.
let legendBurstTimer = null;
function spawnLegendBurst(gift) {
  const overlay = $("legend-gift-overlay");
  if (!overlay) return;
  $("legend-gift-emoji").textContent = gift.emoji;
  $("legend-gift-text").textContent = `${gift.name} 🔥`;
  overlay.classList.remove("hidden");
  overlay.classList.add("show");
  clearTimeout(legendBurstTimer);
  legendBurstTimer = setTimeout(() => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.classList.add("hidden"), 300);
  }, 2400);
}

// Brief glow pulse on the receiver's seat the instant a gift lands.
function flashSeatReceive(userId) {
  const el = document.querySelector(`#seat-grid [data-user-id="${userId}"] .seat-circle`);
  if (!el) return;
  el.classList.add("gift-hit");
  setTimeout(() => el.classList.remove("gift-hit"), 900);
}

// Small synthesized chime per gift tier — no audio files needed, and it
// only ever plays in response to a gift a user already triggered/received.
let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
function playGiftSound(tier) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const freqsByTier = { normal: [660], vip: [660, 880], legend: [660, 880, 1100, 1320] };
  const freqs = freqsByTier[tier] || freqsByTier.normal;
  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    const t0 = now + i * 0.09;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.42);
  });
}

async function loadGiftBanner(roomId) {
  const r = await api("/api/gifts/history?roomId=" + roomId);
  $("gift-banner").innerHTML = "";
  if (r.success) r.gifts.slice(0, 3).reverse().forEach(g => pushGiftBanner(`${g.fromName} sent ${g.gift.emoji} ${g.gift.name}`));
}

// ---------------- Gifts ----------------
let activeGiftTier = "normal";
function renderGiftGrid() {
  const grid = $("gift-catalog");
  grid.innerHTML = "";
  GIFT_CATALOG_CACHE.gifts.filter(g => (g.tier || "normal") === activeGiftTier).forEach((g) => {
    const item = document.createElement("div");
    item.className = "gift-item tier-" + (g.tier || "normal");
    item.innerHTML = `<span class="emoji">${g.emoji}</span><span class="gift-name">${escapeHtml(g.name)}</span><span class="price">${g.price} 🪙</span>`;
    item.addEventListener("mouseenter", () => showGiftPreview(g));
    item.addEventListener("touchstart", () => showGiftPreview(g), { passive: true });
    item.addEventListener("click", () => {
      item.classList.add("gift-item-pressed");
      setTimeout(() => item.classList.remove("gift-item-pressed"), 220);
      sendGift(g.id);
    });
    grid.appendChild(item);
  });
}
function showGiftPreview(g) {
  const box = $("gift-preview");
  $("gift-preview-emoji").textContent = g.emoji;
  $("gift-preview-name").textContent = g.name;
  $("gift-preview-price").textContent = g.price + " 🪙 · " + (g.tier || "normal").toUpperCase();
  box.classList.remove("hidden");
}
$("gift-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".gift-tab");
  if (!btn) return;
  activeGiftTier = btn.dataset.tier;
  $("gift-tabs").querySelectorAll(".gift-tab").forEach(b => b.classList.toggle("active", b === btn));
  renderGiftGrid();
});
$("btn-open-gift").addEventListener("click", async () => {
  if (!GIFT_CATALOG_CACHE.gifts.length) {
    const r = await api("/api/gifts/catalog");
    if (r.success) GIFT_CATALOG_CACHE.gifts = r.gifts;
  }
  const select = $("gift-target-select");
  select.innerHTML = "";
  (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId).forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.userId; opt.textContent = u.userName;
    select.appendChild(opt);
  });
  $("gift-modal-coins").textContent = me.coins || 0;
  $("gift-preview").classList.add("hidden");
  renderGiftGrid();
  const modal = $("modal-gift");
  modal.classList.remove("hidden");
  modal.querySelector(".gift-modal-card").classList.remove("gift-modal-open");
  requestAnimationFrame(() => modal.querySelector(".gift-modal-card").classList.add("gift-modal-open"));
});
$("btn-close-gift").addEventListener("click", () => $("modal-gift").classList.add("hidden"));
function sendGift(giftId) {
  const targetUserId = $("gift-target-select").value;
  if (!targetUserId) { toast("কাউকে বেছে নাও"); return; }
  if (!me.coins) { toast("পর্যাপ্ত কয়েন নেই, Wallet থেকে দেখো"); return; }
  socket.emit("send-gift", { roomId: currentRoomId, targetUserId, giftId });
  $("modal-gift").classList.add("hidden");
}

// ---------------- Music ----------------
$("btn-open-music").addEventListener("click", () => $("modal-music").classList.remove("hidden"));
$("btn-close-music").addEventListener("click", () => $("modal-music").classList.add("hidden"));
$("music-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("music", file);
  const r = await apiUpload("/api/music/upload", fd);
  if (r.success) {
    socket.emit("music-update", { roomId: currentRoomId, url: r.url, name: r.name, playing: true });
  } else toast(r.message || "আপলোড ব্যর্থ হয়েছে");
});
$("btn-music-playpause").addEventListener("click", () => {
  if (!currentRoom?.music || !currentRoom.music.url) { toast("কোনো মিউজিক লোড করা নেই"); return; }
  // Fix (music can't be turned off): this used to decide the new state from
  // the local <audio> element's own `paused` flag. But browsers can silently
  // block audio.play() (autoplay policy) for anyone other than the person
  // who uploaded it, so that element's `paused` stayed stuck at `true` even
  // while the room considered music "playing" — every click then computed
  // "turn it ON" instead of OFF, so it could never actually be stopped. The
  // toggle now flips the shared room state itself, which every client
  // (including this one) is kept in sync with via setMusicUI() below.
  const playing = !currentRoom.music.playing;
  socket.emit("music-update", { roomId: currentRoomId, url: currentRoom.music.url, name: currentRoom.music.name, playing });
});
function setMusicUI(music) {
  currentRoom = currentRoom || {};
  currentRoom.music = music;
  const audio = $("room-audio");
  $("music-now-playing").textContent = music.name ? ("🎵 " + music.name) : "কোনো গান চলছে না";
  if (music.url && audio.src !== location.origin + music.url) audio.src = music.url;
  if (music.playing) {
    audio.play().catch(() => {
      // Autoplay blocked — retry once the page has any interaction, so OFF→ON
      // still actually starts playback instead of silently doing nothing.
      document.addEventListener("click", () => { if (currentRoom?.music?.playing) audio.play().catch(() => {}); }, { once: true });
    });
  } else {
    // OFF must fully stop it — not just pause — so it can't keep running
    // silently in the background and resuming from the middle next time.
    audio.pause();
    audio.currentTime = 0;
  }
  $("btn-open-music").classList.toggle("active", !!music.playing);
}

// ===========================================================================
// WEBRTC VOICE — stream, real-time speaking detection, auto-reconnect
// ===========================================================================
const ICE_SERVERS = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function initMicIfNeeded() {
  if (localStream || !mySeatNumber) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    startVoiceActivityDetection();
    // Fix (one side hears nothing): any peer connection that was already
    // created before the mic was ready (e.g. we answered an incoming offer
    // first) has no outgoing audio track yet — attach it now and renegotiate.
    attachLocalTrackToAllPeers();
  } catch (e) {
    toast("মাইক্রোফোন পারমিশন দরকার");
  }
}

$("btn-mic-toggle").addEventListener("click", async () => {
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startVoiceActivityDetection();
      attachLocalTrackToAllPeers();
    } catch (e) { toast("মাইক্রোফোন পারমিশন দরকার"); return; }
  }
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  $("btn-mic-toggle").classList.toggle("active", micEnabled);
});

// --- Real-time mic-level analysis: turns actual speaking (not just being
//     seated) into the "speaking" ring, and broadcasts it to the room. ---
let voiceCtx = null, voiceAnalyser = null, voiceDataArray = null, voiceRafId = null;
let lastSpeakingState = false, loudSince = 0, quietSince = 0;

function startVoiceActivityDetection() {
  if (voiceAnalyser || !localStream) return;
  try {
    voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = voiceCtx.createMediaStreamSource(localStream);
    voiceAnalyser = voiceCtx.createAnalyser();
    voiceAnalyser.fftSize = 512;
    source.connect(voiceAnalyser);
    voiceDataArray = new Uint8Array(voiceAnalyser.frequencyBinCount);
    tickVoiceActivity();
  } catch (e) { /* Web Audio unsupported — seat ring just won't be mic-driven */ }
}
function tickVoiceActivity() {
  if (!voiceAnalyser) return;
  voiceAnalyser.getByteFrequencyData(voiceDataArray);
  let sum = 0;
  for (let i = 0; i < voiceDataArray.length; i++) sum += voiceDataArray[i];
  const avg = sum / voiceDataArray.length;
  const now = Date.now();
  const isLoud = micEnabled && avg > 12;
  if (isLoud) { quietSince = 0; if (!loudSince) loudSince = now; }
  else { loudSince = 0; if (!quietSince) quietSince = now; }
  const shouldSpeak = isLoud && loudSince && (now - loudSince > 80);
  const shouldStop = !isLoud && quietSince && (now - quietSince > 350);
  if (shouldSpeak && !lastSpeakingState) {
    lastSpeakingState = true;
    if (mySeatNumber && currentRoomId) socket.emit("voice-activity", { roomId: currentRoomId, speaking: true });
    speakingUsers.add(me.userId);
    if (currentRoom) renderSeats(seatsFromMap());
  } else if (shouldStop && lastSpeakingState) {
    lastSpeakingState = false;
    if (mySeatNumber && currentRoomId) socket.emit("voice-activity", { roomId: currentRoomId, speaking: false });
    speakingUsers.delete(me.userId);
    if (currentRoom) renderSeats(seatsFromMap());
  }
  voiceRafId = requestAnimationFrame(tickVoiceActivity);
}
function stopVoiceActivityDetection() {
  if (voiceRafId) cancelAnimationFrame(voiceRafId);
  voiceRafId = null; voiceAnalyser = null; lastSpeakingState = false;
  loudSince = 0; quietSince = 0;
  if (voiceCtx) { voiceCtx.close().catch(() => {}); voiceCtx = null; }
}

// Fix (duplicate/competing connections): whether every seated peer connects
// automatically (room-state broadcasts, seat takes, ICE-failure recovery) —
// several different places in the app try to (re)connect to the same peer.
// Without a rule for who's allowed to send the actual offer, two sides could
// both send one at the same time ("glare"), which used to leave one leg of
// the connection broken — the classic "I can hear them, they can't hear me"
// symptom. This picks the same single offerer for a given pair on both ends,
// deterministically, with no extra signaling needed.
function isLocalOfferer(remoteSocketId) {
  return socket.id > remoteSocketId;
}

function getOrCreatePeer(remoteSocketId) {
  if (peerConnections[remoteSocketId]) return peerConnections[remoteSocketId];
  const pc = new RTCPeerConnection(ICE_SERVERS);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("voice-candidate", { target: remoteSocketId, candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    let audioEl = remoteAudioEls[remoteSocketId];
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      document.body.appendChild(audioEl);
      remoteAudioEls[remoteSocketId] = audioEl;
    }
    audioEl.srcObject = e.streams[0];
    // Fix ("connected but no audio"): autoplay can be silently blocked by
    // the browser even though the connection itself is fine. Retry once the
    // page has any user interaction, which is virtually guaranteed here
    // since joining a seat/room is itself a click.
    const tryPlay = () => audioEl.play().catch(() => {
      document.addEventListener("click", () => audioEl.play().catch(() => {}), { once: true });
    });
    tryPlay();
  };
  // Auto-recover from a dropped/failed ICE path without leaving the seat
  // or the room — this is what makes seat switches / brief network blips
  // not require a manual rejoin.
  const scheduleRecovery = () => {
    setTimeout(() => {
      if (peerConnections[remoteSocketId] === pc &&
          (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected")) {
        closePeer(remoteSocketId);
        if (mySeatNumber !== null) connectToPeer(remoteSocketId);
      }
    }, 1800);
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") scheduleRecovery();
  };
  // Some browsers report the drop via connectionState instead of/ahead of
  // iceConnectionState — watch both so recovery isn't missed either way.
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") scheduleRecovery();
  };
  peerConnections[remoteSocketId] = pc;
  pendingCandidates[remoteSocketId] = [];
  return pc;
}

// Fix ("Audio Drop" / silent peer): a connection formed before the mic was
// ready has no outgoing track. When the mic becomes available, give every
// existing peer connection its track and — only if we're the offerer for
// that pair — renegotiate so the remote side actually starts receiving it.
function attachLocalTrackToAllPeers() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  Object.keys(peerConnections).forEach(async (remoteSocketId) => {
    const pc = peerConnections[remoteSocketId];
    const hasAudioSender = pc.getSenders().some(s => s.track && s.track.kind === "audio");
    if (hasAudioSender) return;
    try {
      pc.addTrack(track, localStream);
      if (isLocalOfferer(remoteSocketId)) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("voice-offer", { target: remoteSocketId, offer });
      }
    } catch (e) { /* peer may have closed mid-flight — safe to ignore */ }
  });
}

async function connectToPeer(remoteSocketId) {
  if (!remoteSocketId || remoteSocketId === socket.id) return;
  if (peerConnections[remoteSocketId]) return; // already connected/connecting — never open a second one
  if (!isLocalOfferer(remoteSocketId)) return; // the other side is responsible for sending the offer to us
  const pc = getOrCreatePeer(remoteSocketId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("voice-offer", { target: remoteSocketId, offer });
  } catch (e) {
    closePeer(remoteSocketId);
  }
}

function closePeer(remoteSocketId) {
  const pc = peerConnections[remoteSocketId];
  if (pc) {
    pc.onicecandidate = null; pc.ontrack = null;
    pc.oniceconnectionstatechange = null; pc.onconnectionstatechange = null;
    pc.close();
    delete peerConnections[remoteSocketId];
  }
  delete pendingCandidates[remoteSocketId];
  const audioEl = remoteAudioEls[remoteSocketId];
  if (audioEl) { audioEl.srcObject = null; audioEl.remove(); delete remoteAudioEls[remoteSocketId]; }
}

function teardownVoice() {
  Object.keys(peerConnections).forEach(closePeer);
  stopVoiceActivityDetection();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  micEnabled = false;
  mySeatNumber = null;
  speakingUsers.clear();
}

// ===========================================================================
// PROFILE
// ===========================================================================
async function openOwnProfile() {
  const r = await api("/api/user/" + me.mobile);
  if (r.success) { me = r.user; saveSession(); }
  $("profile-avatar").src = me.photo || placeholderAvatar(me.name);
  $("profile-name-display").textContent = me.name;
  $("profile-name-input").value = me.name;
  $("profile-bio-input").value = me.bio || "";
  $("profile-userid").textContent = me.userId;
  $("profile-visitors").textContent = me.visitors || 0;
  $("profile-followers").textContent = me.followers;
  $("profile-following").textContent = me.following;
  $("profile-level-chip").textContent = "Lv." + me.level;
  $("menu-wallet-coins").textContent = me.coins;
  $("menu-wallet-diamonds").textContent = me.diamonds;
  applyVipBadge($("profile-vip-badge"), me.vipLevel);
  applyFrameRing($("profile-avatar-frame"), me.vipLevel);
  applyCustomFrame($("profile-avatar-frame"), me.activeFrame);
  $("profile-edit-panel").classList.add("hidden");
  checkAgencyMenu();
  showView("view-profile");
}

$("btn-copy-id").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(me.userId);
    const btn = $("btn-copy-id");
    btn.classList.add("copied");
    toast("ID কপি হয়েছে");
    setTimeout(() => btn.classList.remove("copied"), 1500);
  } catch (e) { toast("কপি করা যায়নি"); }
});

$("menu-edit-profile").addEventListener("click", () => {
  $("profile-edit-panel").classList.toggle("hidden");
});

$("btn-save-profile").addEventListener("click", async () => {
  const name = $("profile-name-input").value.trim();
  const bio = $("profile-bio-input").value.trim();
  const r = await api("/api/user/update-profile", "POST", { mobile: me.mobile, name, bio });
  if (r.success) {
    me = r.user; saveSession(); fillHomeProfile();
    toast("Profile আপডেট হয়েছে");
  } else toast(r.message || "সমস্যা হয়েছে");
});

$("profile-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("photo", file);
  fd.append("mobile", me.mobile);
  const r = await apiUpload("/api/user/upload-photo", fd);
  if (r.success) {
    me.photo = r.url; saveSession();
    $("profile-avatar").src = r.url;
    fillHomeProfile();
  } else toast(r.message || "আপলোড ব্যর্থ হয়েছে");
});

document.querySelectorAll("[data-follow-list]").forEach((btn) => {
  btn.addEventListener("click", () => openFollowList(btn.getAttribute("data-follow-list")));
});

async function openFollowList(mode) {
  followListMode = mode;
  $("follow-list-title").textContent = mode === "followers" ? "Followers" : "Following";
  const r = await api(`/api/user/${me.mobile}/${mode}`);
  const list = r.success ? (r[mode] || []) : [];
  const wrap = $("follow-list-items");
  wrap.innerHTML = "";
  $("follow-list-empty").classList.toggle("hidden", list.length > 0);
  list.forEach((u) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <img class="avatar avatar-sm" src="${u.photo || placeholderAvatar(u.name)}">
      <div class="user-row-body"><span class="name">${escapeHtml(u.name)}</span><span class="sub">ID: ${escapeHtml(u.userId)}</span></div>
    `;
    row.addEventListener("click", () => openOtherProfile(u.userId));
    wrap.appendChild(row);
  });
  showView("view-follow-list");
}
$("btn-back-follow-list").addEventListener("click", openOwnProfile);

let otherProfileUser = null;
async function openOtherProfile(userId) {
  const r = await api("/api/user/by-id/" + userId);
  if (!r.success) { toast(r.message || "ইউজার পাওয়া যায়নি"); return; }
  otherProfileUser = r.user;
  $("other-avatar").src = otherProfileUser.photo || placeholderAvatar(otherProfileUser.name);
  $("other-name").textContent = otherProfileUser.name;
  $("other-userid").textContent = otherProfileUser.userId;
  $("other-followers").textContent = otherProfileUser.followers;
  $("other-following").textContent = otherProfileUser.following;
  applyVipBadge($("other-vip-badge"), otherProfileUser.vipLevel);
  applyFrameRing($("other-avatar-frame"), otherProfileUser.vipLevel);
  applyCustomFrame($("other-avatar-frame"), otherProfileUser.activeFrame);
  const amFollowing = (me.followingList || []).includes(otherProfileUser.userId);
  $("btn-follow-toggle").textContent = amFollowing ? "Unfollow" : "Follow";
  showView("view-other-profile");
}
$("btn-back-other-profile").addEventListener("click", () => showView("view-home"));

$("btn-follow-toggle").addEventListener("click", async () => {
  if (!otherProfileUser) return;
  const amFollowing = (me.followingList || []).includes(otherProfileUser.userId);
  const endpoint = amFollowing ? "/api/user/unfollow" : "/api/user/follow";
  const r = await api(endpoint, "POST", { mobile: me.mobile, targetUserId: otherProfileUser.userId });
  if (r.success) {
    me = r.user; saveSession();
    $("btn-follow-toggle").textContent = (me.followingList || []).includes(otherProfileUser.userId) ? "Unfollow" : "Follow";
  } else toast(r.message || "সমস্যা হয়েছে");
});

$("btn-message-user").addEventListener("click", () => {
  if (!otherProfileUser) return;
  openThread(otherProfileUser.userId, otherProfileUser.name);
});

// ===========================================================================
// PRIVATE MESSAGES
// ===========================================================================
async function openInbox() {
  const r = await api("/api/messages/inbox/" + me.userId);
  const conversations = r.success ? r.conversations : [];
  const wrap = $("inbox-list");
  wrap.innerHTML = "";
  $("inbox-empty").classList.toggle("hidden", conversations.length > 0);
  conversations.forEach((c) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <img class="avatar avatar-sm" src="${c.otherPhoto || placeholderAvatar(c.otherName)}">
      <div class="user-row-body"><span class="name">${escapeHtml(c.otherName)}</span><span class="sub">${escapeHtml(c.lastMessage)}</span></div>
    `;
    row.addEventListener("click", () => openThread(c.otherUserId, c.otherName));
    wrap.appendChild(row);
  });
  showView("view-inbox");
}

async function openThread(userId, userName) {
  threadPeerId = userId;
  threadPeerName = userName;
  $("thread-title").textContent = userName;
  const r = await api(`/api/messages/thread/${me.userId}/${userId}`);
  const log = $("thread-log");
  log.innerHTML = "";
  if (r.success) r.messages.forEach(appendThreadMsg);
  showView("view-thread");
}
$("btn-back-thread").addEventListener("click", openInbox);
$("btn-thread-send").addEventListener("click", sendThreadMsg);
$("thread-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendThreadMsg(); });
async function sendThreadMsg() {
  const input = $("thread-input");
  const message = input.value.trim();
  if (!message || !threadPeerId) return;
  const r = await api("/api/messages/send", "POST", { fromUserId: me.userId, toUserId: threadPeerId, message });
  if (r.success) { appendThreadMsg(r.message); input.value = ""; }
}
function appendThreadMsg(msg) {
  const log = $("thread-log");
  const div = document.createElement("div");
  const out = msg.from === me.userId;
  div.className = "thread-msg " + (out ? "out" : "in");
  div.textContent = msg.message;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ===========================================================================
// GENERIC BACK BUTTONS + MENU NAVIGATION
// ===========================================================================
document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.getAttribute("data-back")));
});

$("menu-wallet").addEventListener("click", openWallet);
$("menu-treasure").addEventListener("click", openTreasure);
$("menu-frames").addEventListener("click", openFrames);
$("menu-agency").addEventListener("click", openAgency);

// ===========================================================================
// WALLET
// ===========================================================================
async function openWallet() {
  const w = await api("/api/wallet/" + me.userId);
  if (w.success) { $("wallet-coins").textContent = w.coins; $("wallet-diamonds").textContent = w.diamonds; }

  const hist = await api(`/api/wallet/${me.userId}/exchanges`);
  const histWrap = $("exchange-history");
  histWrap.innerHTML = "";
  if (hist.success) hist.exchanges.forEach((e) => {
    const row = document.createElement("div");
    row.className = "user-row";
    const statusText = e.status === "pending" ? "⏳ Pending" : (e.status === "approved" ? "✅ Approved" : "❌ Rejected");
    row.innerHTML = `<div class="user-row-body"><span class="name">💎 ${e.diamonds} exchange</span><span class="sub">${statusText}${e.note ? " · " + escapeHtml(e.note) : ""}</span></div>`;
    histWrap.appendChild(row);
  });

  const tx = await api(`/api/wallet/${me.userId}/transactions`);
  const txWrap = $("wallet-transactions");
  txWrap.innerHTML = "";
  if (tx.success) tx.transactions.forEach((t) => {
    const row = document.createElement("div");
    row.className = "user-row";
    const sign = t.amount >= 0 ? "+" : "";
    row.innerHTML = `<div class="user-row-body"><span class="name">${sign}${t.amount} ${t.currency === "coins" ? "🪙" : "💎"}</span><span class="sub">${escapeHtml(t.note)}</span></div>`;
    txWrap.appendChild(row);
  });

  showView("view-wallet");
}

$("btn-request-exchange").addEventListener("click", async () => {
  const diamonds = Number($("exchange-amount").value);
  const note = $("exchange-note").value.trim();
  if (!diamonds || diamonds <= 0) { toast("সঠিক Diamond পরিমাণ দাও"); return; }
  const r = await api("/api/wallet/exchange/request", "POST", { userId: me.userId, diamonds, note });
  if (r.success) { toast("Request পাঠানো হয়েছে"); $("exchange-amount").value = ""; $("exchange-note").value = ""; openWallet(); }
  else toast(r.message || "সমস্যা হয়েছে");
});

// ===========================================================================
// TREASURE BOX
// ===========================================================================
async function openTreasure() {
  const r = await api("/api/treasure/status/" + me.userId);
  $("btn-claim-daily").disabled = !(r.success && r.dailyReady);
  $("btn-claim-weekly").disabled = !(r.success && r.weeklyReady);
  $("btn-claim-daily").textContent = (r.success && r.dailyReady) ? "খোলো" : "আজকেরটা নেওয়া হয়ে গেছে";
  $("btn-claim-weekly").textContent = (r.success && r.weeklyReady) ? "খোলো" : "এই সপ্তাহেরটা নেওয়া হয়ে গেছে";
  showView("view-treasure");
}
$("btn-claim-daily").addEventListener("click", async () => {
  const r = await api("/api/treasure/claim-daily", "POST", { userId: me.userId });
  if (r.success) { toast(`🎁 তুমি পেলে ${r.reward} coins!`); me.coins = r.coins; saveSession(); fillHomeProfile(); openTreasure(); }
  else toast(r.message || "সমস্যা হয়েছে");
});
$("btn-claim-weekly").addEventListener("click", async () => {
  const r = await api("/api/treasure/claim-weekly", "POST", { userId: me.userId });
  if (r.success) { toast(`🏆 তুমি পেলে ${r.reward} coins!`); me.coins = r.coins; saveSession(); fillHomeProfile(); openTreasure(); }
  else toast(r.message || "সমস্যা হয়েছে");
});

// ===========================================================================
// FRAMES
// ===========================================================================
async function openFrames() {
  const activeRes = await api("/api/frames/mine/" + me.userId);
  const activeBox = $("active-frame-box");
  if (activeRes.success && activeRes.activeFrame) {
    me.activeFrame = activeRes.activeFrame; saveSession();
    activeBox.innerHTML = `<p class="field-label">তোমার Active Frame</p><p>${escapeHtml(activeRes.activeFrame.name || activeRes.activeFrame.frameId)}</p><p class="hint">${activeRes.activeFrame.expiresAt ? "মেয়াদ শেষ: " + new Date(activeRes.activeFrame.expiresAt).toLocaleDateString() : "Permanent"}</p>`;
  } else {
    activeBox.innerHTML = `<p class="hint">তোমার কোনো active frame নেই।</p>`;
  }

  const catRes = await api("/api/frames/catalog");
  const catWrap = $("frame-catalog-list");
  catWrap.innerHTML = "";
  if (catRes.success) catRes.frames.forEach((f) => {
    const item = document.createElement("div");
    item.className = "gift-item";
    item.innerHTML = `<span class="emoji">🖼️</span><span class="price">${escapeHtml(f.name)}</span>${f.vipOnly ? '<span class="frame-vip-tag">VIP only</span>' : ""}`;
    catWrap.appendChild(item);
  });

  showView("view-frames");
}

// ===========================================================================
// AGENCY CENTER
// ===========================================================================
async function openAgency() {
  const r = await api("/api/agency/mine/" + me.userId);
  const body = $("agency-body");
  if (!r.success || !r.agency) {
    body.innerHTML = `<div class="empty-state"><p>তোমার কোনো Agency নেই।</p></div>`;
    showView("view-agency");
    return;
  }
  const a = r.agency;
  let html = `
    <div class="auth-card">
      <h3>${escapeHtml(a.name)}</h3>
      <p class="hint">Commission rate: ${(a.commissionRate * 100).toFixed(0)}%</p>
      <p class="hint">মোট অর্জিত: 💎 ${a.earnedDiamonds || 0}</p>
    </div>`;
  if (a.isOwner && a.hosts) {
    html += `<div class="section-head"><h2>Hosts</h2></div><div class="user-list">`;
    a.hosts.forEach((h) => {
      html += `<div class="user-row"><div class="user-row-body"><span class="name">${escapeHtml(h.name)}</span><span class="sub">🪙 ${h.coins} · 💎 ${h.diamonds}</span></div></div>`;
    });
    html += `</div>`;
  }
  body.innerHTML = html;
  showView("view-agency");
}

// ===========================================================================
// ROOM TV SCREEN — Food Wheel / Teen Patti, opened on demand as a bottom-
// sheet overlay (see the room-tv-screen CSS fix note for why it's no longer
// a permanently-visible in-flow block).
// ===========================================================================
const ROOM_TV_GAMES = {
  foodwheel: "/foodwheel/index.html",
  teenpatti: "/teenpatti/index.html"
};
let roomTvActiveGame = "foodwheel";
let roomTvSyncTimer = null;

function setRoomTvGame(key) {
  if (!ROOM_TV_GAMES[key]) return;
  roomTvActiveGame = key;
  $("room-tv-frame").src = ROOM_TV_GAMES[key];
  document.querySelectorAll(".room-tv-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.game === key);
  });
}

document.querySelectorAll(".room-tv-tab").forEach((tab) => {
  tab.addEventListener("click", () => setRoomTvGame(tab.dataset.game));
});

// Synced — when the host (whoever taps 🎮) opens or closes the game, a
// "game-toggle" event is broadcast to everyone else in the room so it opens
// full-screen on every participant's screen at the same time. The
// `fromRemote` flag on open/close is set only when we're reacting to that
// broadcast, so we don't re-emit it and cause a loop.
$("btn-toggle-game").addEventListener("click", () => openRoomGame());
$("btn-room-tv-close").addEventListener("click", () => closeRoomGame());

let roomMusicWasPlayingBeforeGame = false;

function openRoomGame(game, fromRemote) {
  document.body.classList.add("game-locked");
  $("room-tv-screen").classList.add("tv-open");
  // Fix (sluggish app / stuck UI after playing): always load a fresh
  // instance of the game on open rather than trusting a stale `.src` check.
  // Combined with the teardown in closeRoomGame() below, this guarantees
  // the game is never silently running in the background when the panel
  // is closed.
  setRoomTvGame(game || roomTvActiveGame);

  // Fix (audio bug): the room's background music used to keep playing
  // underneath the game. Pause it locally while the game is open (each
  // user's own playback only — this doesn't touch the shared music state
  // for others) and remember whether it was playing so we can resume it
  // on close instead of guessing.
  const musicEl = $("room-audio");
  if (musicEl) {
    roomMusicWasPlayingBeforeGame = !musicEl.paused;
    musicEl.pause();
  }

  if (!fromRemote && currentRoomId) {
    socket.emit("game-toggle", { roomId: currentRoomId, open: true, game: game || roomTvActiveGame });
  }
}
function closeRoomGame(fromRemote) {
  document.body.classList.remove("game-locked");
  $("room-tv-screen").classList.remove("tv-open");

  // Fix (app feels stuck / leave-room unresponsive after playing): the
  // game iframe used to keep running forever in the background even once
  // "closed" here (only visually hidden via CSS), so all its timers —
  // Teen Patti's bot betting/dealing loops, Food Wheel's spin simulation —
  // kept firing and competing for the main thread the whole time you stayed
  // in the room, which is what made the rest of the UI (leave button, room
  // settings, chat) feel sluggish or unresponsive. Unloading the iframe
  // fully stops all of that; setRoomTvGame() loads a fresh instance again
  // next time the panel is opened.
  $("room-tv-frame").src = "about:blank";

  const musicEl = $("room-audio");
  if (musicEl && roomMusicWasPlayingBeforeGame) {
    musicEl.play().catch(() => {});
  }
  roomMusicWasPlayingBeforeGame = false;

  if (!fromRemote && currentRoomId) {
    socket.emit("game-toggle", { roomId: currentRoomId, open: false });
  }
}

// Someone else in the room opened/closed the game — mirror it here so
// everyone sees the same full-screen game at the same time.
// Bridge messages coming from whichever game iframe is currently loaded on the TV screen
window.addEventListener("message", (ev) => {
  const data = ev && ev.data;
  if (!data) return;

  if (data.type === "FOODWHEEL_CLOSE") {
    // The in-game ✕ button now behaves exactly like the overlay's own close button.
    closeRoomGame();
  }

  if (data.type === "FOODWHEEL_READY") {
    // Hand the player's real wallet balance to the game on load
    $("room-tv-frame").contentWindow.postMessage({ type: "FOODWHEEL_INIT", balance: me.coins || 0 }, "*");
  }

  if (data.type === "FOODWHEEL_BALANCE") {
    // Game balance changed (bet placed or win) — debounce a sync to the server
    // so the real wallet stays authoritative.
    if (roomTvSyncTimer) clearTimeout(roomTvSyncTimer);
    roomTvSyncTimer = setTimeout(() => {
      socket.emit("game-wheel-sync", { roomId: currentRoomId, balance: Math.max(0, Math.floor(data.balance)), game: "Food Wheel" });
    }, 600);
  }

  if (data.type === "TEENPATTI_READY") {
    // Same bridge as Food Wheel: hand the player's real wallet balance to
    // Teen Patti on load so it always starts with the same coins as the ID.
    $("room-tv-frame").contentWindow.postMessage({ type: "TEENPATTI_INIT", balance: me.coins || 0 }, "*");
  }

  if (data.type === "TEENPATTI_BALANCE") {
    // Table wallet changed (bet placed or win) — debounce a sync to the
    // server so the real wallet stays authoritative, same as Food Wheel.
    if (roomTvSyncTimer) clearTimeout(roomTvSyncTimer);
    roomTvSyncTimer = setTimeout(() => {
      socket.emit("game-wheel-sync", { roomId: currentRoomId, balance: Math.max(0, Math.floor(data.balance)), game: "Teen Patti" });
    }, 600);
  }

  if (data.type === "FOODWHEEL_BUY_COINS") {
    // The in-game "+" button opens the real wallet instead of granting free coins
    openWallet();
  }
});

// ===========================================================================
// TREASURE CHEST
// ===========================================================================
let chestConfigCache = null;
let chestCountdownTimer = null;
let chestResetAtMs = null;

async function loadChestConfig() {
  if (chestConfigCache) return chestConfigCache;
  const r = await api("/api/chest/config");
  if (r.success) chestConfigCache = r.levels;
  return chestConfigCache;
}

async function renderChest(chest) {
  await loadChestConfig();
  const idx = Math.min(chest.level - 1, (chestConfigCache || []).length - 1);
  const cfg = chestConfigCache && chestConfigCache[idx];
  const target = cfg ? cfg.target : chest.contributed || 1;
  const finished = chest.level > (chestConfigCache || []).length;

  $("chest-level").textContent = finished ? (chestConfigCache || []).length : chest.level;
  $("chest-contributed").textContent = Math.min(chest.contributed, target);
  $("chest-target").textContent = finished ? chest.contributed : target;
  const pct = finished ? 100 : Math.min(100, (chest.contributed / target) * 100);
  $("chest-progress-fill").style.width = pct + "%";

  chestResetAtMs = new Date(chest.resetAt).getTime();
  startChestCountdown();
}

function startChestCountdown() {
  clearInterval(chestCountdownTimer);
  chestCountdownTimer = setInterval(() => {
    if (!chestResetAtMs) return;
    const diff = Math.max(0, chestResetAtMs - Date.now());
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    $("chest-countdown").textContent = `${h}:${m}:${s}`;
  }, 1000);
}
function stopChestCountdown() { clearInterval(chestCountdownTimer); }

$("btn-chest-info").addEventListener("click", async () => {
  await loadChestConfig();
  const wrap = $("chest-level-list");
  wrap.innerHTML = "";
  (chestConfigCache || []).forEach((cfg) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `<div class="user-row-body"><span class="name">Level ${cfg.level}</span><span class="sub">${cfg.target.toLocaleString()} 💎 জমা হলে খুলবে</span></div>`;
    wrap.appendChild(row);
  });
  $("modal-chest-info").classList.remove("hidden");
});
$("btn-close-chest-info").addEventListener("click", () => $("modal-chest-info").classList.add("hidden"));

function playChestOpenAnimation(data) {
  const box = $("chest-box");
  box.classList.add("opening");
  setTimeout(() => {
    box.classList.remove("opening");
    box.classList.add("opened");
    showChestReward(data);
    setTimeout(() => box.classList.remove("opened"), 2500);
  }, 1600);
}

function showChestReward(data) {
  $("chest-reward-level").textContent = data.level;
  const emoji = data.reward.type === "coins" ? "🪙" : "💎";
  $("chest-reward-card-visual").textContent = "🎁";
  $("chest-reward-amount").textContent = `+${data.reward.amount} ${emoji}`;
  const topWrap = $("chest-reward-top");
  topWrap.innerHTML = "";
  const owner = currentRoom ? { name: currentRoom.hostName, tag: "Room Owner" } : null;
  if (owner) {
    const row = document.createElement("div");
    row.className = "chest-reward-top-row";
    row.innerHTML = `<span>👑 ${escapeHtml(owner.name)}</span><span>${owner.tag}</span>`;
    topWrap.appendChild(row);
  }
  (data.topContributors || []).forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "chest-reward-top-row";
    row.innerHTML = `<span>#${i + 1} ${escapeHtml(c.name)}</span><span>💎 ${c.amount}</span>`;
    topWrap.appendChild(row);
  });
  $("modal-chest-reward").classList.remove("hidden");
}
$("btn-close-chest-reward").addEventListener("click", () => $("modal-chest-reward").classList.add("hidden"));

// ===========================================================================
// ROOM MODERATION
// ===========================================================================
let seatLockButtons = [];
(function buildSeatLockRow() {
  const row = $("seat-lock-row");
  for (let n = 1; n <= 8; n++) {
    const b = document.createElement("button");
    b.className = "pick-btn";
    b.textContent = n;
    b.addEventListener("click", () => {
      const isLocked = (currentRoom?.lockedSeats || []).includes(n);
      socket.emit("lock-seat", { roomId: currentRoomId, seatNumber: n, locked: !isLocked });
    });
    row.appendChild(b);
    seatLockButtons.push(b);
  }
})();

$("btn-room-mod").addEventListener("click", () => {
  if (!currentRoom) return;
  const others = (currentRoom.onlineUsers || []).filter(u => u.userId !== me.userId);
  const kickSelect = $("mod-kick-select");
  kickSelect.innerHTML = "";
  others.filter(u => u.userId !== currentRoom.hostId).forEach(u => {
    const opt = document.createElement("option"); opt.value = u.userId; opt.textContent = u.userName; kickSelect.appendChild(opt);
  });
  const adminSelect = $("mod-admin-select");
  adminSelect.innerHTML = "";
  others.forEach(u => {
    const opt = document.createElement("option"); opt.value = u.userId; opt.textContent = u.userName; adminSelect.appendChild(opt);
  });
  seatLockButtons.forEach((b, idx) => {
    const n = idx + 1;
    b.classList.toggle("locked", (currentRoom.lockedSeats || []).includes(n));
  });
  $("modal-room-mod").classList.remove("hidden");
});
$("btn-close-mod").addEventListener("click", () => $("modal-room-mod").classList.add("hidden"));

$("btn-mod-kick").addEventListener("click", () => {
  const targetUserId = $("mod-kick-select").value;
  if (!targetUserId) return;
  socket.emit("kick-user", { roomId: currentRoomId, targetUserId });
  $("modal-room-mod").classList.add("hidden");
});
$("btn-mod-make-admin").addEventListener("click", () => {
  const targetUserId = $("mod-admin-select").value;
  if (!targetUserId) return;
  socket.emit("set-admin", { roomId: currentRoomId, targetUserId, isAdmin: true });
  toast("Admin করা হয়েছে");
});
$("btn-mod-remove-admin").addEventListener("click", () => {
  const targetUserId = $("mod-admin-select").value;
  if (!targetUserId) return;
  socket.emit("set-admin", { roomId: currentRoomId, targetUserId, isAdmin: false });
  toast("Admin বাদ দেওয়া হয়েছে");
});
$("mod-logo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("logo", file);
  const r = await apiUpload("/api/room/logo/upload", fd);
  if (r.success) socket.emit("update-room-logo", { roomId: currentRoomId, url: r.url });
  else toast(r.message || "আপলোড ব্যর্থ হয়েছে");
});
$("mod-bg-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("background", file);
  const r = await apiUpload("/api/room/background/upload", fd);
  if (r.success) socket.emit("update-room-background", { roomId: currentRoomId, url: r.url });
  else toast(r.message || "আপলোড ব্যর্থ হয়েছে");
});
$("btn-mod-clear-chat").addEventListener("click", () => {
  socket.emit("clear-chat", { roomId: currentRoomId });
  $("modal-room-mod").classList.add("hidden");
});
$("btn-mod-close-room").addEventListener("click", () => {
  if (!confirm("এই room বন্ধ করবে? সবাই বের হয়ে যাবে।")) return;
  socket.emit("close-room", { roomId: currentRoomId });
  $("modal-room-mod").classList.add("hidden");
  closeRoomGame();
  currentRoomId = null; currentRoom = null;
  saveActiveRoom(null);
  showView("view-home"); loadRoomList();
});

// ===========================================================================
// BOOTSTRAP
// ===========================================================================
// Fix (stale/incorrect session survives refresh): previously the cached
// profile in localStorage was trusted forever and used as-is — a ban, a
// deleted account, or just stale coins/diamonds would only be corrected the
// next time the user happened to open their profile screen. Now we
// re-validate against the server once on load; if the account is gone or
// banned we clear the local session and send them back to login instead of
// letting them sit in a broken half-logged-in state.
async function bootstrap() {
  loadSession();
  if (!me || !me.mobile) { showView("view-login"); return; }

  const r = await api("/api/user/" + me.mobile);
  if (!r.success) {
    // Network hiccup during boot — don't force a logout over a transient
    // error, just proceed with the cached copy.
    currentRoomId = loadActiveRoom();
    connectSocket();
    enterApp();
    return;
  }
  if (r.user.banned) {
    localStorage.removeItem("pp_user");
    saveActiveRoom(null);
    me = null;
    showView("view-login");
    toast("তোমার অ্যাকাউন্ট ব্যান করা হয়েছে");
    return;
  }
  me = r.user;
  saveSession();
  currentRoomId = loadActiveRoom();
  connectSocket();
  enterApp();
}
bootstrap();
