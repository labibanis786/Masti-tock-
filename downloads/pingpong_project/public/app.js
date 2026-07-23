/* ==========================================================================
   PingPong frontend — talks to server.js exactly as written.
   ========================================================================== */

const API = ""; // same-origin
const GIFT_CATALOG_CACHE = { gifts: [] };
const VIDEO_GIFT_CATALOG_CACHE = { gifts: [] };
// Full-screen video gift playback queue — if several arrive at once, they
// play one after another instead of overlapping.
const videoGiftQueue = [];
let videoGiftPlaying = false;

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
    return { success: false, message: "network error", networkError: true };
  }
}

async function apiUpload(path, formData, headers = {}) {
  try {
    const res = await fetch(API + path, { method: "POST", body: formData, headers });
    return await res.json();
  } catch (err) {
    toast("আপলোড সমস্যা হয়েছে");
    return { success: false, message: "network error", networkError: true };
  }
}

function vipClass(level) { return "vip-" + Math.max(0, Math.min(5, Number(level) || 0)); }
function applyVipBadge(el, level) {
  el.className = "vip-badge " + vipClass(level);
  el.textContent = "VIP " + (Number(level) || 0);
}
// Admin-assigned coloured tag (e.g. "VIP") shown next to a username.
// `small` renders the compact inline variant used in chat/seats instead of
// the full pill used on profile screens.
function tagTextColor(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length !== 6) return "#1c1424";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#1c1424" : "#fbf6ea";
}
function applyCustomTag(el, tag, small) {
  if (!el) return;
  el.className = "tag-badge" + (small ? " tag-badge-sm" : "");
  if (tag && tag.text) {
    el.textContent = tag.text;
    el.style.background = tag.color || "#F4C463";
    el.style.color = tagTextColor(tag.color);
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
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
// AUTH — password login (mobile number + permanent password)
// ===========================================================================
function showAuthCard(id) {
  ["step-password-login", "step-create-password", "step-mobile", "step-otp"].forEach((cid) => {
    $(cid).classList.toggle("hidden", cid !== id);
  });
}

$("btn-goto-otp-login").addEventListener("click", () => showAuthCard("step-mobile"));
$("btn-goto-password-login").addEventListener("click", () => showAuthCard("step-password-login"));
$("btn-goto-create-password").addEventListener("click", () => showAuthCard("step-create-password"));
$("btn-back-password-login").addEventListener("click", () => showAuthCard("step-password-login"));

$("btn-password-login").addEventListener("click", async () => {
  const mobile = $("pw-login-mobile").value.trim();
  const password = $("pw-login-password").value;
  if (mobile.length !== 10) { toast("সঠিক ১০ ডিজিট নম্বর দাও"); return; }
  if (!password) { toast("পাসওয়ার্ড দাও"); return; }
  const r = await api("/api/auth/login-password", "POST", { mobile, password });
  if (r.success) {
    me = r.user;
    saveSession();
    connectSocket();
    enterApp();
  } else toast(r.message || "লগইন ব্যর্থ হয়েছে");
});

$("btn-create-password").addEventListener("click", async () => {
  const mobile = $("cp-mobile").value.trim();
  const password = $("cp-password").value;
  if (mobile.length !== 10) { toast("সঠিক ১০ ডিজিট নম্বর দাও"); return; }
  if (!password || password.length < 4) { toast("কমপক্ষে ৪ অক্ষরের পাসওয়ার্ড দাও"); return; }
  const r = await api("/api/auth/set-password", "POST", { mobile, password });
  if (r.success) {
    me = r.user;
    saveSession();
    connectSocket();
    enterApp();
  } else toast(r.message || "সমস্যা হয়েছে");
});

// ===========================================================================
// AUTH — OTP login (existing, unchanged)
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

  // Real winner feed for Food Wheel / Teen Patti (replaces the old fake
  // demo names/tickers with actual players and actual amounts won,
  // sourced from real game-wheel-sync coin gains on the server).
  socket.on("real-win", (entry) => {
    recentWins.unshift(entry);
    if (recentWins.length > 30) recentWins = recentWins.slice(0, 30);
    sendRealWinsToGame();
  });

  socket.on("room-list", renderRoomList);

  socket.on("room-state", (room) => {
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
    if (mySeatNumber !== null) {
      const liveSocketIds = new Set(
        room.seats.filter((s) => s && s.userId !== me.userId).map((s) => s.socketId)
      );
      Object.keys(peerConnections).forEach((sid) => { if (!liveSocketIds.has(sid)) closePeer(sid); });
      liveSocketIds.forEach((sid) => { if (sid && !peerConnections[sid]) connectToPeer(sid); });
    }
    renderChatLog(room.messages || []);
    $("room-name-display").textContent = room.roomName;
    $("room-host-display").textContent = "Host: " + room.hostName;
    if (room.music && room.music.url) setMusicUI(room.music);
    $("view-room").style.backgroundImage = room.background ? `url(${room.background})` : "";
    setRoomLogo(room.logo);
    const canModerate = room.hostId === me.userId || (room.adminIds || []).includes(me.userId);
    $("btn-room-mod").classList.toggle("hidden", !canModerate);
    if (room.treasureChest) renderChest(room.treasureChest);
    initMicIfNeeded().then(ensureLocalTracksSent);

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
        // BUG FIX: this used to only set mySeatNumber and stop — the mic
        // (getUserMedia) never got requested here, only inside the
        // "room-state" handler. take-seat only ever emits "seat-update", so
        // a freshly-seated user's mic stayed uninitialized (localStream ===
        // null) until some unrelated room-state broadcast happened to fire
        // later. Meanwhile every other seated user immediately tries to
        // connectToPeer() them (see the `else` branch below) — their side
        // answers with zero audio tracks, so nobody hears the new seat even
        // though the connection itself "succeeds". Requesting the mic here,
        // then pushing tracks into any peer connections that already exist
        // (see ensureLocalTracksSent), closes that gap.
        mySeatNumber = data.seatNumber;
        initMicIfNeeded().then(ensureLocalTracksSent);
        // Also proactively connect to everyone already sitting, instead of
        // only ever waiting to be connected to — makes voice come up
        // immediately even if the other side's connectToPeer() call for us
        // fires first and loses a race with our getUserMedia() prompt.
        Object.values(seatMap).forEach((s) => {
          if (s && s.userId !== me.userId && s.socketId) connectToPeer(s.socketId);
        });
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
      // Was incorrectly bumping me.diamonds here — server now credits the
      // recipient in coins (see send-gift on the server), so this local
      // optimistic update has to match or it visibly shows the wrong
      // currency going up for a moment before the next wallet-update
      // correction arrives.
      me.coins += data.gift.price;
      saveSession(); fillHomeProfile();
    }
  });

  socket.on("music-update", (music) => setMusicUI(music));

  // Video Gift catalog changes app-wide (any admin Add/Update/Delete) —
  // refresh the cache and, if the Custom tab happens to be open, re-render
  // it immediately. No refresh needed on the user's end.
  socket.on("video-gift-catalog", (gifts) => {
    VIDEO_GIFT_CATALOG_CACHE.gifts = gifts;
    if (!$("modal-gift").classList.contains("hidden") && activeGiftTier === "custom") renderGiftGrid();
  });

  // Full-screen Video Gift playback — queued so simultaneous sends never
  // overlap; deducting Coins already happened server-side before this
  // event was broadcast, so by the time it arrives it's guaranteed valid.
  socket.on("video-gift-play", (data) => {
    if (data.fromUserId === me.userId && data.gift.price) {
      me.coins -= data.gift.price;
      saveSession(); fillHomeProfile();
    }
    videoGiftQueue.push(data);
    playNextVideoGift();
  });

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

  // ---- Fruit Wheel: the server decides the round phase/result and the
  // real winners, this just relays those broadcasts into whichever game
  // iframe is currently open so it can play the matching animation. ----
  socket.on("fruitwheel-round", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_ROUND", ...data }, "*");
    }
  });
  socket.on("fruitwheel-winners", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_WINNERS", ...data }, "*");
    }
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
    $("view-room").style.backgroundImage = data.url ? `url(${data.url})` : "";
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
    if (data.forceLogout) {
      // Account-level action (ban/delete) — the session itself is no
      // longer valid, not just the current room, so fully log out rather
      // than leaving the person on the home screen still "signed in" as
      // an account that can no longer act.
      localStorage.removeItem("pp_user");
      me = null;
      if (socket) { socket.disconnect(); socket = null; }
      showView("view-login");
      return;
    }
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

  // Admin assigned (or removed) a coloured tag while we're online.
  socket.on("tag-updated", (tag) => {
    me.customTag = tag;
    saveSession();
    fillHomeProfile();
    applyCustomTag($("profile-tag-badge"), me.customTag);
    toast(tag ? `🏷️ তুমি "${tag.text}" ট্যাগ পেয়েছো!` : "Tag সরানো হয়েছে");
  });

  socket.on("voice-offer", async (data) => {
    const pc = getOrCreatePeer(data.from);
    // Perfect-negotiation-style collision handling: if we're also in the
    // middle of sending our own offer to this same peer, the "polite" side
    // rolls its offer back and accepts theirs instead; the "impolite" side
    // ignores the incoming one and lets its own offer win. Without this,
    // whichever side's setRemoteDescription(offer) landed second used to
    // throw (wrong signalingState) and silently kill that pair's audio.
    const collision = pc.makingOffer || pc.signalingState !== "stable";
    if (collision && !pc.polite) return; // impolite side: ignore, our offer wins
    try {
      if (collision) {
        await Promise.all([
          pc.setLocalDescription({ type: "rollback" }),
          pc.setRemoteDescription(new RTCSessionDescription(data.offer))
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("voice-answer", { target: data.from, answer: pc.localDescription });
    } catch (e) { /* stale/duplicate offer arrived after peer was already torn down */ }
  });

  socket.on("voice-answer", async (data) => {
    const pc = peerConnections[data.from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  });

  socket.on("voice-candidate", async (data) => {
    const pc = peerConnections[data.from];
    if (pc && data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
    }
  });
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
  applyCustomTag($("home-tag-badge"), me.customTag);
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
      seatMap[i + 1] = { userId: seat.userId, socketId: seat.socketId, userName: seat.userName, userPhoto: seat.userPhoto, role: seat.role, activeFrame: seat.activeFrame || null, vipLevel: seat.vipLevel || 0, customTag: seat.customTag || null, modLabel: seat.modLabel || null, micMuted: !!seat.micMuted };
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
      vipLevel: entry.vipLevel || 0,
      customTag: entry.customTag || null,
      modLabel: entry.modLabel || null,
      micMuted: !!entry.micMuted
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
      if (seat.micMuted) {
        const muteBadge = document.createElement("span");
        muteBadge.className = "seat-mic-muted";
        muteBadge.textContent = "🔇";
        div.style.position = "relative";
        div.appendChild(muteBadge);
      }
    } else {
      circle.textContent = "＋";
    }
    div.appendChild(circle);
    const nameEl = document.createElement("span");
    nameEl.className = "seat-name";
    nameEl.textContent = seat ? seat.userName : ("No." + seatNumber);
    div.appendChild(nameEl);
    if (seat && seat.customTag && seat.customTag.text) {
      const tagEl = document.createElement("span");
      applyCustomTag(tagEl, seat.customTag, true);
      div.appendChild(tagEl);
    }
    if (seat && seat.modLabel && seat.modLabel.text) {
      const labelEl = document.createElement("span");
      labelEl.className = "tag-badge tag-badge-sm";
      labelEl.style.background = seat.modLabel.color || "#F4C463";
      labelEl.style.color = tagTextColor(seat.modLabel.color);
      labelEl.textContent = seat.modLabel.text;
      div.appendChild(labelEl);
    }

    div.addEventListener("click", () => {
      if (!seat) {
        socket.emit("take-seat", { roomId: currentRoomId, seatNumber });
      } else if (seat.userId !== me.userId) {
        openOtherProfile(seat.userId);
      } else {
        openOwnProfile();
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
  const tagHtml = (!msg.system && msg.customTag && msg.customTag.text)
    ? `<span class="tag-badge tag-badge-sm" style="background:${escapeHtml(msg.customTag.color || "#F4C463")};color:${tagTextColor(msg.customTag.color)}">${escapeHtml(msg.customTag.text)}</span>`
    : "";
  div.innerHTML = msg.system
    ? escapeHtml(msg.message)
    : `<span class="who">${escapeHtml(msg.userName)}</span>${tagHtml}${escapeHtml(msg.message)}<span class="when">${escapeHtml(msg.time || "")}</span>`;
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
  if (activeGiftTier === "custom") { renderVideoGiftGrid(grid); return; }
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
// Custom tab — admin-uploaded Video Gifts. Thumbnail instead of emoji,
// price in Coins (changed from Diamonds on request), sent through sendVideoGift().
function renderVideoGiftGrid(grid) {
  if (!VIDEO_GIFT_CATALOG_CACHE.gifts.length) {
    grid.innerHTML = '<p class="hint" style="grid-column:1/-1;">এখনো কোনো Video Gift নেই।</p>';
    return;
  }
  VIDEO_GIFT_CATALOG_CACHE.gifts.forEach((g) => {
    const item = document.createElement("div");
    item.className = "gift-item tier-legend";
    item.innerHTML = `${g.thumbnail ? `<img src="${g.thumbnail}" class="emoji" style="width:32px;height:32px;object-fit:cover;border-radius:6px;">` : `<span class="emoji">🎬</span>`}<span class="gift-name">${escapeHtml(g.name)}</span><span class="price">${g.price.toLocaleString()} 🪙</span>`;
    item.addEventListener("mouseenter", () => showGiftPreview(g, true));
    item.addEventListener("touchstart", () => showGiftPreview(g, true), { passive: true });
    item.addEventListener("click", () => {
      item.classList.add("gift-item-pressed");
      setTimeout(() => item.classList.remove("gift-item-pressed"), 220);
      sendVideoGift(g.id);
    });
    grid.appendChild(item);
  });
}
function showGiftPreview(g, isVideo) {
  const box = $("gift-preview");
  $("gift-preview-emoji").textContent = isVideo ? "🎬" : g.emoji;
  $("gift-preview-name").textContent = g.name;
  $("gift-preview-price").textContent = isVideo ? (g.price.toLocaleString() + " 🪙") : (g.price + " 🪙 · " + (g.tier || "normal").toUpperCase());
  box.classList.remove("hidden");
}
$("gift-tabs").addEventListener("click", async (e) => {
  const btn = e.target.closest(".gift-tab");
  if (!btn) return;
  activeGiftTier = btn.dataset.tier;
  $("gift-tabs").querySelectorAll(".gift-tab").forEach(b => b.classList.toggle("active", b === btn));
  if (activeGiftTier === "custom" && !VIDEO_GIFT_CATALOG_CACHE.gifts.length) {
    const r = await api("/api/video-gifts/catalog");
    if (r.success) VIDEO_GIFT_CATALOG_CACHE.gifts = r.gifts;
  }
  renderGiftGrid();
});
// Multi-recipient gift targeting + repeat-send quantity (1 / 7 / 77 / 777).
// selectedGiftTargets holds the userIds currently checked in the modal's
// target list; giftSendQty is the multiplier applied on send (each selected
// recipient receives the gift giftSendQty times).
let selectedGiftTargets = new Set();
let giftSendQty = 1;

function renderGiftTargetList() {
  const list = $("gift-target-list");
  list.innerHTML = "";
  const users = (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId);
  if (!users.length) {
    list.innerHTML = '<div class="gift-target-empty">রুমে আর কেউ নেই</div>';
    $("gift-target-select-all").checked = false;
    $("gift-target-select-all").disabled = true;
    return;
  }
  $("gift-target-select-all").disabled = false;
  users.forEach((u) => {
    const row = document.createElement("label");
    row.className = "gift-target-row";
    const checked = selectedGiftTargets.has(u.userId) ? "checked" : "";
    row.innerHTML = `<input type="checkbox" data-userid="${u.userId}" ${checked}><span>${escapeHtml(u.userName)}</span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selectedGiftTargets.add(u.userId);
      else selectedGiftTargets.delete(u.userId);
      syncGiftSelectAllCheckbox(users);
    });
    list.appendChild(row);
  });
  syncGiftSelectAllCheckbox(users);
}
function syncGiftSelectAllCheckbox(users) {
  const all = users.length > 0 && users.every(u => selectedGiftTargets.has(u.userId));
  $("gift-target-select-all").checked = all;
}
$("gift-target-select-all").addEventListener("change", (e) => {
  const users = (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId);
  if (e.target.checked) users.forEach(u => selectedGiftTargets.add(u.userId));
  else selectedGiftTargets.clear();
  renderGiftTargetList();
});
$("gift-qty-row").addEventListener("click", (e) => {
  const btn = e.target.closest(".gift-qty-btn");
  if (!btn) return;
  giftSendQty = parseInt(btn.dataset.qty, 10) || 1;
  $("gift-qty-row").querySelectorAll(".gift-qty-btn").forEach(b => b.classList.toggle("active", b === btn));
});

$("btn-open-gift").addEventListener("click", async () => {
  if (!GIFT_CATALOG_CACHE.gifts.length) {
    const r = await api("/api/gifts/catalog");
    if (r.success) GIFT_CATALOG_CACHE.gifts = r.gifts;
  }
  selectedGiftTargets = new Set();
  giftSendQty = 1;
  $("gift-qty-row").querySelectorAll(".gift-qty-btn").forEach(b => b.classList.toggle("active", b.dataset.qty === "1"));
  renderGiftTargetList();
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
  const targetUserIds = Array.from(selectedGiftTargets);
  if (!targetUserIds.length) { toast("কাউকে বেছে নাও"); return; }
  if (!me.coins) { toast("পর্যাপ্ত কয়েন নেই, Wallet থেকে দেখো"); return; }
  socket.emit("send-gift", { roomId: currentRoomId, targetUserIds, giftId, quantity: giftSendQty });
  $("modal-gift").classList.add("hidden");
}
// Video Gift send — spends Coins (changed from Diamonds on request), requires
// at least 100,000. Server has the final say; this is just a snappy
// client-side pre-check.
function sendVideoGift(videoGiftId) {
  const targetUserIds = Array.from(selectedGiftTargets);
  if (!targetUserIds.length) { toast("কাউকে বেছে নাও"); return; }
  const gift = VIDEO_GIFT_CATALOG_CACHE.gifts.find(g => g.id === videoGiftId);
  if (gift && (me.coins || 0) < gift.price * giftSendQty * targetUserIds.length) { toast("পর্যাপ্ত কয়েন নেই"); return; }
  socket.emit("send-video-gift", { roomId: currentRoomId, targetUserIds, videoGiftId, quantity: giftSendQty });
  $("modal-gift").classList.add("hidden");
}

// Plays the full-screen Video Gift queue one clip at a time. Each clip:
// shows the overlay, plays the video (with its own audio), then hides
// itself and moves to the next queued gift the moment it ends — so a late
// joiner who never received the original event simply never sees it, and
// a burst of gifts never plays two clips on top of each other.
function playNextVideoGift() {
  if (videoGiftPlaying || !videoGiftQueue.length) return;
  videoGiftPlaying = true;
  const data = videoGiftQueue.shift();
  const overlay = $("video-gift-overlay");
  const video = $("video-gift-player");
  let finished = false;
  const finishClip = () => {
    if (finished) return;
    finished = true;
    overlay.classList.add("hidden");
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.onended = null;
    videoGiftPlaying = false;
    playNextVideoGift();
  };
  video.onended = finishClip;
  // Safety net: if playback stalls or "ended" never fires for some reason,
  // never let the overlay get stuck — clear it after the gift's own duration.
  setTimeout(finishClip, ((data.gift.duration || 8) * 1000) + 800);
  overlay.classList.remove("hidden");
  video.src = data.gift.videoUrl;
  video.currentTime = 0;
  video.muted = false;
  video.play().catch(() => {
    // Autoplay-with-sound blocked (rare once the user has already
    // interacted with the page this session) — fall back to muted so the
    // clip still plays rather than silently failing.
    video.muted = true;
    video.play().catch(() => finishClip());
  });
  toast(`🎬 ${data.fromName} sent ${data.gift.name}`);
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
  const audio = $("room-audio");
  const turningOff = !audio.paused;
  if (currentRoom?.music) {
    if (turningOff) {
      // Off = fully remove the track from the room, not just pause it.
      socket.emit("music-update", { roomId: currentRoomId, url: "", name: "", playing: false });
    } else {
      socket.emit("music-update", { roomId: currentRoomId, url: currentRoom.music.url, name: currentRoom.music.name, playing: true });
    }
  }
});
function setMusicUI(music) {
  currentRoom = currentRoom || {};
  currentRoom.music = music;
  const audio = $("room-audio");
  $("music-now-playing").textContent = music.name ? ("🎵 " + music.name) : "কোনো গান চলছে না";
  if (!music.url) {
    // Fully remove — stop and unload, don't just pause.
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } else {
    if (audio.src !== location.origin + music.url) audio.src = music.url;
    if (music.playing) audio.play().catch(() => {}); else audio.pause();
  }
  $("btn-open-music").classList.toggle("active", !!music.playing);
}

// ===========================================================================
// WEBRTC VOICE — stream, real-time speaking detection, auto-reconnect
// ===========================================================================
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Fallback TURN relay — STUN alone can't traverse symmetric / carrier-grade
    // NAT (common on mobile data), which is what makes voice sound "far"/choppy
    // or fail to connect for some users. A TURN relay gives those connections
    // an actual path instead of silently failing. For production scale, swap
    // this public relay for a dedicated TURN service (see README).
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
  ]
};

async function initMicIfNeeded() {
  if (localStream || !mySeatNumber) return;
  // IMPORTANT: getUserMedia is only allowed in a "secure context" — https://,
  // or http://localhost specifically. Opening the app on a phone via
  // http://192.168.x.x:3000 (a plain LAN IP, as the README's basic testing
  // instructions describe) is NOT secure, so the browser blocks microphone
  // access outright before any of our code even runs — often with no
  // visible error, or navigator.mediaDevices being undefined entirely. This
  // silently produces exactly "voice doesn't work, nobody can hear anyone"
  // on every real phone, regardless of any signaling fix. Use ngrok /
  // Cloudflare Tunnel (both already mentioned in the README) or deploy
  // behind real HTTPS to test across devices.
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("[voice] blocked: not a secure context (need https:// or http://localhost). Current origin:", location.origin);
    toast("ভয়েসের জন্য HTTPS দরকার — http://IP:3000 দিয়ে ফোনে মাইক কাজ করবে না, ngrok/Cloudflare Tunnel ব্যবহার করো");
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    startVoiceActivityDetection();
  } catch (e) {
    console.error("[voice] getUserMedia failed:", e.name, e.message);
    toast("মাইক্রোফোন পারমিশন দরকার");
  }
}

// Safety net for the seat/mic race: a peer connection can end up created
// (e.g. because we just received an incoming offer) before our own
// getUserMedia() resolves, so it goes out with zero local audio tracks —
// the other side gets silence from us even though the connection looks
// "connected". Whenever localStream becomes available/changes, walk every
// existing peer connection and, if it has no outgoing audio track yet, add
// one and renegotiate.
function ensureLocalTracksSent() {
  if (!localStream) return;
  Object.entries(peerConnections).forEach(([sid, pc]) => {
    const hasAudioSender = pc.getSenders().some(s => s.track && s.track.kind === "audio");
    if (!hasAudioSender) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      connectToPeer(sid);
    }
  });
}

$("btn-mic-toggle").addEventListener("click", async () => {
  if (!localStream) {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("[voice] blocked: not a secure context. Current origin:", location.origin);
      toast("ভয়েসের জন্য HTTPS দরকার — http://IP:3000 দিয়ে ফোনে মাইক কাজ করবে না, ngrok/Cloudflare Tunnel ব্যবহার করো");
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startVoiceActivityDetection();
      ensureLocalTracksSent();
    } catch (e) { console.error("[voice] getUserMedia failed:", e.name, e.message); toast("মাইক্রোফোন পারমিশন দরকার"); return; }
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

function getOrCreatePeer(remoteSocketId) {
  if (peerConnections[remoteSocketId]) return peerConnections[remoteSocketId];
  const pc = new RTCPeerConnection(ICE_SERVERS);
  // BUG FIX (glare / "can't hear each other"): both sides could end up
  // calling connectToPeer() on each other at close to the same moment (e.g.
  // two people take seats around the same time, or the seat-take fix above
  // now has the new seat *and* the existing seats both connecting to one
  // another). Without a tie-breaker, both sides send an "offer" into the
  // same RTCPeerConnection back-to-back — setRemoteDescription(offer) then
  // throws on whichever side is mid-negotiation, that promise rejection was
  // unhandled, and the connection was left half-negotiated: it can look
  // "connected" at the ICE layer while no audio ever actually flows.
  // `polite` gives every pair a consistent, deterministic winner (compare
  // socket ids) so exactly one side backs off (rolls back its own offer)
  // instead of both throwing.
  pc.polite = socket.id > remoteSocketId;
  pc.makingOffer = false;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("voice-candidate", { target: remoteSocketId, candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    let audioEl = remoteAudioEls[remoteSocketId];
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      remoteAudioEls[remoteSocketId] = audioEl;
    }
    audioEl.srcObject = e.streams[0];
  };
  // Auto-recover from a dropped/failed ICE path without leaving the seat
  // or the room — this is what makes seat switches / brief network blips
  // not require a manual rejoin. First try a real ICE restart (renegotiate
  // the same connection — fast, no audio-element/track churn); only tear
  // the whole peer connection down and rebuild it if that doesn't recover.
  let iceRestartTried = false;
  pc.oniceconnectionstatechange = () => {
    console.log("[voice]", remoteSocketId, "ice state:", pc.iceConnectionState);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      iceRestartTried = false;
      return;
    }
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      if (!iceRestartTried && pc.iceConnectionState === "failed") {
        iceRestartTried = true;
        connectToPeer(remoteSocketId, true);
        return;
      }
      setTimeout(() => {
        if (peerConnections[remoteSocketId] === pc &&
            (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected")) {
          closePeer(remoteSocketId);
          if (mySeatNumber !== null) connectToPeer(remoteSocketId);
        }
      }, 900);
    }
  };
  peerConnections[remoteSocketId] = pc;
  return pc;
}

async function connectToPeer(remoteSocketId, iceRestart) {
  if (!remoteSocketId || remoteSocketId === socket.id) return;
  const pc = getOrCreatePeer(remoteSocketId);
  // Don't stack a second offer on top of one we're already sending, and
  // don't offer mid-negotiation unless this is a forced ICE restart.
  if (pc.makingOffer || (pc.signalingState !== "stable" && !iceRestart)) return;
  try {
    pc.makingOffer = true;
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    socket.emit("voice-offer", { target: remoteSocketId, offer: pc.localDescription });
  } finally {
    pc.makingOffer = false;
  }
}

function closePeer(remoteSocketId) {
  const pc = peerConnections[remoteSocketId];
  if (pc) { pc.onicecandidate = null; pc.ontrack = null; pc.oniceconnectionstatechange = null; pc.close(); delete peerConnections[remoteSocketId]; }
  const audioEl = remoteAudioEls[remoteSocketId];
  if (audioEl) { audioEl.remove(); delete remoteAudioEls[remoteSocketId]; }
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
  applyCustomTag($("profile-tag-badge"), me.customTag);
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

$("btn-logout").addEventListener("click", () => {
  if (!confirm("লগ আউট করবে?")) return;
  if (currentRoomId) socket?.emit("leave-room", { roomId: currentRoomId, userId: me.userId });
  teardownVoice();
  closeRoomGame();
  currentRoomId = null;
  currentRoom = null;
  saveActiveRoom(null);
  localStorage.removeItem("pp_user");
  me = null;
  if (socket) { socket.disconnect(); socket = null; }
  $("profile-edit-panel").classList.add("hidden");
  showAuthCard("step-password-login");
  showView("view-login");
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
  $("other-level").textContent = otherProfileUser.level || 1;
  applyVipBadge($("other-vip-badge"), otherProfileUser.vipLevel);
  applyCustomTag($("other-tag-badge"), otherProfileUser.customTag);
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
    const badge = c.isAi ? ` <span title="Verified · Always Online" style="color:#3ba9ff;">✔️ Online</span>` : "";
    row.innerHTML = `
      <img class="avatar avatar-sm" src="${c.otherPhoto || placeholderAvatar(c.otherName)}">
      <div class="user-row-body"><span class="name">${escapeHtml(c.otherName)}${badge}</span><span class="sub">${escapeHtml(c.lastMessage)}</span></div>
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

// Real winner feed cache (see socket.on("real-win", ...) above) — kept here
// so it survives between game opens without re-fetching every time.
let recentWins = [];
let recentWinsLoaded = false;
function sendRealWinsToGame() {
  const frame = $("room-tv-frame");
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: "REAL_WINS", wins: recentWins }, "*");
  }
}
async function ensureRecentWinsLoaded() {
  if (recentWinsLoaded) return;
  recentWinsLoaded = true;
  try {
    const r = await api("/api/games/recent-wins");
    if (r.success && Array.isArray(r.wins)) recentWins = r.wins;
  } catch (e) {}
}

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

// Local only — opening/closing the game affects just the person who tapped
// the button, not the rest of the room.
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
  if (currentRoomId) socket.emit("fruitwheel-leave", { roomId: currentRoomId });

  const musicEl = $("room-audio");
  if (musicEl && roomMusicWasPlayingBeforeGame) {
    musicEl.play().catch(() => {});
  }
  roomMusicWasPlayingBeforeGame = false;

  if (!fromRemote && currentRoomId) {
    socket.emit("game-toggle", { roomId: currentRoomId, open: false });
  }
}

// Bridge messages coming from whichever game iframe is currently loaded on the TV screen
window.addEventListener("message", async (ev) => {
  const data = ev && ev.data;
  if (!data) return;

  if (data.type === "FOODWHEEL_CLOSE") {
    // The in-game ✕ button now behaves exactly like the overlay's own close button.
    closeRoomGame();
  }

  if (data.type === "FOODWHEEL_READY") {
    // Hand the player's real wallet balance to the game on load — fetch it
    // fresh from the server (the single source of truth for coins) rather
    // than trusting the local cache, so the game never starts from a
    // slightly-stale number.
    const w = await api("/api/wallet/" + me.userId);
    if (w.success) { me.coins = w.coins; saveSession(); fillHomeProfile(); }
    $("room-tv-frame").contentWindow.postMessage({ type: "FOODWHEEL_INIT", balance: me.coins || 0 }, "*");
    await ensureRecentWinsLoaded();
    sendRealWinsToGame();
    // Fruit Wheel's round/result/payout all live on the server now — join
    // that room's round so this tab starts receiving real broadcasts.
    if (currentRoomId) socket.emit("fruitwheel-join", { roomId: currentRoomId });
  }

  if (data.type === "FOODWHEEL_BET") {
    // The bet itself is sent to the server for validation and real-money
    // deduction; the game only plays the tap animation locally. The server
    // pushes back a wallet-update (handled above) with the true balance.
    if (currentRoomId) {
      socket.emit("fruitwheel-bet", { roomId: currentRoomId, foodId: data.foodId, amount: data.amount });
    }
  }

  if (data.type === "FOODWHEEL_BALANCE") {
    // The game reports its locally-displayed balance here purely so the
    // rest of the UI (home screen, other open tabs) can reflect it right
    // away. It is never trusted as-is: the server's own wallet-update,
    // driven only by real bets/payouts it resolved itself, always arrives
    // right after and overwrites this with the authoritative number.
    me.coins = Math.max(0, Math.floor(data.balance));
    saveSession(); fillHomeProfile();
  }

  if (data.type === "TEENPATTI_READY") {
    // Same bridge as Food Wheel: fetch the true current balance from the
    // server before handing it to Teen Patti on load.
    const w = await api("/api/wallet/" + me.userId);
    if (w.success) { me.coins = w.coins; saveSession(); fillHomeProfile(); }
    $("room-tv-frame").contentWindow.postMessage({ type: "TEENPATTI_INIT", balance: me.coins || 0 }, "*");
    await ensureRecentWinsLoaded();
    sendRealWinsToGame();
  }

  if (data.type === "TEENPATTI_BALANCE") {
    // Table wallet changed (bet placed or win) — same immediate local
    // update + fast real-time sync as Food Wheel.
    me.coins = Math.max(0, Math.floor(data.balance));
    saveSession(); fillHomeProfile();
    if (roomTvSyncTimer) clearTimeout(roomTvSyncTimer);
    roomTvSyncTimer = setTimeout(() => {
      socket.emit("game-wheel-sync", { roomId: currentRoomId, balance: Math.max(0, Math.floor(data.balance)), game: "Teen Patti" });
    }, 20);
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

// Counts a number up from `from` to `to` inside `el`, calling `format` to
// render each intermediate value (e.g. to keep a fixed prefix/suffix).
function animateCountUp(el, from, to, duration, format) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const value = Math.round(from + (to - from) * eased);
    el.textContent = format(value);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function showChestReward(data) {
  $("chest-reward-level").textContent = data.level;
  const emoji = data.reward.type === "coins" ? "🪙" : "💎";
  $("chest-reward-card-visual").textContent = "🎁";

  // Suspense: show the mystery ("?") box first, then after a short beat flip
  // it away to reveal the gift + count the reward amount up from 0.
  const mysteryImg = $("chest-reward-mystery-img");
  const revealVisual = $("chest-reward-card-visual");
  const amountEl = $("chest-reward-amount");
  mysteryImg.classList.remove("reveal-out");
  revealVisual.classList.remove("reveal-in");
  revealVisual.classList.add("hidden");
  amountEl.classList.add("counting");
  amountEl.textContent = `+0 ${emoji}`;

  setTimeout(() => {
    mysteryImg.classList.add("reveal-out");
    revealVisual.classList.remove("hidden");
    requestAnimationFrame(() => revealVisual.classList.add("reveal-in"));
    animateCountUp(amountEl, 0, data.reward.amount, 900, (v) => `+${v} ${emoji}`);
    setTimeout(() => amountEl.classList.remove("counting"), 900);
  }, 700);

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
  renderModBulkList(others);
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

// ---- Bulk moderation: multi-select users, then mute/invite/move/tag/announce ----
let selectedModTargets = new Set();
function renderModBulkList(users) {
  const list = $("mod-bulk-list");
  list.innerHTML = "";
  if (!users.length) {
    list.innerHTML = '<div class="gift-target-empty">রুমে আর কেউ নেই</div>';
    $("mod-bulk-select-all").checked = false;
    $("mod-bulk-select-all").disabled = true;
    return;
  }
  $("mod-bulk-select-all").disabled = false;
  users.forEach((u) => {
    const row = document.createElement("label");
    row.className = "gift-target-row";
    const checked = selectedModTargets.has(u.userId) ? "checked" : "";
    row.innerHTML = `<input type="checkbox" data-userid="${u.userId}" ${checked}><span>${escapeHtml(u.userName)}</span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selectedModTargets.add(u.userId);
      else selectedModTargets.delete(u.userId);
      $("mod-bulk-select-all").checked = users.every(x => selectedModTargets.has(x.userId));
    });
    list.appendChild(row);
  });
  $("mod-bulk-select-all").checked = users.every(u => selectedModTargets.has(u.userId));
}
$("mod-bulk-select-all").addEventListener("change", (e) => {
  const others = (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId);
  if (e.target.checked) others.forEach(u => selectedModTargets.add(u.userId));
  else selectedModTargets.clear();
  renderModBulkList(others);
});
function requireModSelection() {
  const ids = Array.from(selectedModTargets);
  if (!ids.length) toast("আগে ইউজার সিলেক্ট করো");
  return ids;
}
$("btn-mod-bulk-mute").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  const minutes = parseInt($("mod-bulk-mute-minutes").value, 10) || 0;
  socket.emit("mod-mute-users", { roomId: currentRoomId, targetUserIds: ids, minutes });
  toast(minutes > 0 ? `${ids.length} জনকে মিউট করা হয়েছে` : `${ids.length} জনকে আনমিউট করা হয়েছে`);
});
$("btn-mod-bulk-invite").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  socket.emit("mod-invite-to-seat", { roomId: currentRoomId, targetUserIds: ids });
  toast("সিটে ইনভাইট পাঠানো হয়েছে");
});
$("btn-mod-bulk-audience").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  socket.emit("mod-move-to-audience", { roomId: currentRoomId, targetUserIds: ids });
  toast("Audience-এ পাঠানো হয়েছে");
});
$("btn-mod-bulk-label").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  const text = $("mod-bulk-label-text").value;
  socket.emit("mod-label-users", { roomId: currentRoomId, targetUserIds: ids, text, color: "#F4C463" });
  $("mod-bulk-label-text").value = "";
  toast(text.trim() ? "Tag বসানো হয়েছে" : "Tag মুছে ফেলা হয়েছে");
});
$("btn-mod-bulk-announce").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  const message = $("mod-bulk-announce-text").value.trim();
  if (!message) { toast("বার্তা লেখো"); return; }
  socket.emit("mod-announce-users", { roomId: currentRoomId, targetUserIds: ids, message });
  $("mod-bulk-announce-text").value = "";
  toast("বার্তা পাঠানো হয়েছে");
});

// Someone with permission invited me to a seat — accepting just runs the
// normal take-seat flow for the suggested seat number.
socket.on("seat-invite", ({ seatNumber, fromName }) => {
  if (!currentRoomId) return;
  if (confirm(`${fromName} তোমাকে সিট ${seatNumber}-এ আসতে বলেছে। আসবে?`)) {
    socket.emit("take-seat", { roomId: currentRoomId, seatNumber });
  }
});
// Host/admin muted or unmuted me — enforce locally by forcing the mic off
// and disabling the toggle for the duration.
let hostMutedUntil = 0;
socket.on("mod-mute-update", ({ targetUserIds, mutedUntil }) => {
  if (!targetUserIds.includes(me.userId)) return;
  hostMutedUntil = mutedUntil || 0;
  if (hostMutedUntil) {
    micEnabled = false;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
    $("btn-mic-toggle").classList.remove("active");
    $("btn-mic-toggle").disabled = true;
    toast("Host তোমার মাইক মিউট করেছে");
  } else {
    $("btn-mic-toggle").disabled = false;
    toast("তোমার মাইক আনমিউট করা হয়েছে");
  }
});
socket.on("mod-announcement", ({ fromName, message }) => {
  toast(`${fromName}: ${message}`);
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

  let r = await api("/api/user/" + me.mobile);
  if (!r.success && !r.networkError) {
    // Bug fix: a single miss here used to be treated as "account deleted"
    // and forced an immediate logout. That's too trigger-happy for a check
    // that runs on every page refresh — a brief mismatch right after
    // signup/a server restart isn't the same as the account actually being
    // gone. Retry once after a short pause before concluding the account
    // is really gone.
    await new Promise((resolve) => setTimeout(resolve, 800));
    r = await api("/api/user/" + me.mobile);
  }
  if (!r.success) {
    if (r.networkError) {
      // Network hiccup during boot — don't force a logout over a transient
      // error, just proceed with the cached copy.
      currentRoomId = loadActiveRoom();
      connectSocket();
      enterApp();
      return;
    }
    // The server responded (twice) and confirmed this account no longer
    // exists (e.g. an admin deleted it) — don't let a deleted account keep
    // riding on stale cached session data, log it out for real.
    localStorage.removeItem("pp_user");
    saveActiveRoom(null);
    me = null;
    showView("view-login");
    toast("তোমার অ্যাকাউন্ট আর পাওয়া যাচ্ছে না, আবার লগইন করো");
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
