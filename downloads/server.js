require("dotenv").config();
const APP_NAME = "PingPong";

const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

// ---------- PingPong AI Core ----------
// Modular AI backend (chat support, monitoring, security, moderation,
// analytics, dashboard) — lives entirely under ai/ and never touches wallet
// logic directly. See ai/ai-config.js for how to configure/rotate the
// Gemini API key and README.md for setup notes.
const aiChat = require("./ai/ai-chat");
const aiMonitor = require("./ai/ai-monitor");
const aiSecurity = require("./ai/ai-security");
const aiModerator = require("./ai/ai-moderator");
const aiDashboardRouter = require("./ai/ai-dashboard");
// SVIP Tag Management — image processing is optional at startup, so the
// server still boots on platforms where sharp's prebuilt native binary
// doesn't match the runtime (this was crashing on Android Termux with
// "Could not load the sharp module using the android-arm64 runtime").
// Preference order when actually processing an upload: sharp -> jimp ->
// store the original PNG unresized. See saveSvipTagImage() below.
let sharp = null;
try {
    sharp = require("sharp");
} catch (err) {
    console.warn(`⚠️  'sharp' not available (${err.message}) — SVIP tag uploads will use the jimp fallback, or store PNGs unresized if jimp isn't available either. This does not affect any other feature.`);
}
let jimp = null;
if (!sharp) {
    try {
        jimp = require("jimp");
    } catch (err) {
        console.warn(`⚠️  'jimp' not available either (${err.message}) — SVIP tag PNGs will be saved without auto-resizing.`);
    }
}

// ---------- Admin Config ----------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
let adminSessions = new Map(); // token -> admin username (was a Set; .has()/.delete() behave the same, .add() became .set() at the one login call site)
let socketsByUserId = {}; // userId -> socket.id
let pendingDisconnects = {}; // userId -> { timer, roomId }  (reconnect grace period)

// Fix (updates not showing up): browsers/WebViews aggressively cache static
// .html files by default, so after replacing a file like
// public/foodwheel/index.html the old cached copy can keep loading instead
// of the new one — looking exactly like the fix "didn't apply" even though
// the file on disk is correct. HTML is now served with no-cache so every
// load always re-fetches the current file; JS/CSS/images still cache
// normally since Express's defaults are fine for those.
const staticNoCacheHtml = { setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
} };
app.use(cors());
app.use(express.json());
app.use(express.static("public", staticNoCacheHtml));
app.use("/admin", express.static("admin", staticNoCacheHtml));
app.use("/api/admin/ai", aiDashboardRouter(requireAdmin));

// ---------- Folders ----------
const DATA_FOLDER = path.join(__dirname, "data");
const MUSIC_FOLDER = path.join(__dirname, "uploads/music");
const PHOTO_FOLDER = path.join(__dirname, "uploads/photos");
const BG_FOLDER = path.join(__dirname, "uploads/backgrounds");
const LOGO_FOLDER = path.join(__dirname, "uploads/logos");
const FRAME_FOLDER = path.join(__dirname, "uploads/frames");
// Video Gift System — admin-uploaded MP4 gifts + their thumbnails.
const VIDEO_GIFT_FOLDER = path.join(__dirname, "uploads/video-gifts");
const VIDEO_GIFT_THUMB_FOLDER = path.join(__dirname, "uploads/video-gifts-thumbs");
// SVIP Tag Management — admin-uploaded PNG tag per SVIP level (svip1.png..svip8.png).
const SVIP_TAG_FOLDER = path.join(__dirname, "uploads/svip-tags");

[DATA_FOLDER, MUSIC_FOLDER, PHOTO_FOLDER, BG_FOLDER, FRAME_FOLDER, LOGO_FOLDER, VIDEO_GIFT_FOLDER, VIDEO_GIFT_THUMB_FOLDER, SVIP_TAG_FOLDER].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use("/music", express.static(MUSIC_FOLDER));
app.use("/photos", express.static(PHOTO_FOLDER));
app.use("/backgrounds", express.static(BG_FOLDER));
app.use("/frames", express.static(FRAME_FOLDER));
app.use("/logos", express.static(LOGO_FOLDER));
app.use("/video-gifts", express.static(VIDEO_GIFT_FOLDER));
app.use("/video-gifts-thumbs", express.static(VIDEO_GIFT_THUMB_FOLDER));
app.use("/svip-tags", express.static(SVIP_TAG_FOLDER));

// ---------- File Upload Config ----------
const musicStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MUSIC_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage: musicStorage });

const photoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const uploadPhoto = multer({ storage: photoStorage });

const bgStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, BG_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const uploadBg = multer({ storage: bgStorage });

const frameStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, FRAME_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const uploadFrame = multer({ storage: frameStorage });

const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOGO_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const uploadLogo = multer({ storage: logoStorage });

// SVIP Tag uploads: kept in memory (not written to disk directly) because
// each upload is auto-resized + re-encoded with `sharp` (preserving PNG
// transparency) before being saved as a fixed svip{level}.png filename.
const uploadSvipTag = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB is plenty for a tag icon
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "image/png") return cb(new Error("শুধু PNG ফাইল আপলোড করা যাবে"));
        cb(null, true);
    }
});

// Video Gift uploads: one form submits both the MP4 and its thumbnail image
// together, so the two files need to land in two different folders based on
// which field they came in on (multer's default diskStorage only sees one
// `destination` per instance, so we branch on file.fieldname here).
const videoGiftStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === "thumbnail" ? VIDEO_GIFT_THUMB_FOLDER : VIDEO_GIFT_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const uploadVideoGift = multer({
    storage: videoGiftStorage,
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB — gifts are only 6-8s clips
    fileFilter: (req, file, cb) => {
        if (file.fieldname === "video" && file.mimetype !== "video/mp4") return cb(new Error("শুধু MP4 ভিডিও আপলোড করা যাবে"));
        cb(null, true);
    }
});

// ---------- Data Files ----------
const USERS_FILE = path.join(DATA_FOLDER, "users.json");
const ROOMS_FILE = path.join(DATA_FOLDER, "rooms.json");
const MESSAGES_FILE = path.join(DATA_FOLDER, "messages.json");
const TRANSACTIONS_FILE = path.join(DATA_FOLDER, "transactions.json");
const EXCHANGES_FILE = path.join(DATA_FOLDER, "exchanges.json");
const GIFTLOG_FILE = path.join(DATA_FOLDER, "gift_log.json");
const FRAME_CATALOG_FILE = path.join(DATA_FOLDER, "frame_catalog.json");
const VIDEO_GIFTS_FILE = path.join(DATA_FOLDER, "video_gifts.json");
const AGENCIES_FILE = path.join(DATA_FOLDER, "agencies.json");
const ANNOUNCEMENTS_FILE = path.join(DATA_FOLDER, "announcements.json");

// Fix (data corruption on crash mid-write): writing straight to the target
// file means a crash/power-loss while the write is in flight can leave
// users.json/rooms.json as truncated, corrupt JSON — which fails to parse
// on the next startup and silently falls back to an empty dataset (i.e.
// "all users disappeared"). Writing to a temp file then renaming into place
// is atomic on POSIX filesystems: the file is always either the old
// complete version or the new complete version, never a half-written one.
function safeWrite(file, data) {
    const tmpFile = file + ".tmp";
    try {
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
        fs.renameSync(tmpFile, file);
    } catch (err) {
        console.error(`❌ Failed to write ${file}:`, err.message);
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    }
}
function safeRead(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        console.error(`❌ Failed to read ${file}, using fallback:`, err.message);
    }
    return fallback;
}

function saveUsers() { safeWrite(USERS_FILE, users); }
function saveMessages() { safeWrite(MESSAGES_FILE, privateMessages); }
function saveRoomsToDisk() {
    const persistable = {};
    Object.values(rooms).forEach((r) => {
        persistable[r.roomId] = {
            roomId: r.roomId,
            roomName: r.roomName,
            hostId: r.hostId,
            hostName: r.hostName,
            adminIds: r.adminIds || [],
            background: r.background || null,
            logo: r.logo || null,
            agencyId: r.agencyId || null,
            gameEnabled: r.gameEnabled !== false
        };
    });
    safeWrite(ROOMS_FILE, persistable);
}

let otpStore = {};

let users = safeRead(USERS_FILE, {});
console.log(`📂 Loaded ${Object.keys(users).length} user(s) from ${USERS_FILE}`);
Object.values(users).forEach((u) => {
    if (!Array.isArray(u.followersList)) u.followersList = [];
    if (!Array.isArray(u.followingList)) u.followingList = [];
    if (typeof u.diamonds !== "number") u.diamonds = 0;
    if (typeof u.banned !== "boolean") u.banned = false;
    if (typeof u.verified !== "boolean") u.verified = false;
    if (typeof u.visitors !== "number") u.visitors = 0;
    if (typeof u.vipLevel !== "number") u.vipLevel = 0;
    if (typeof u.agencyId !== "string" && u.agencyId !== null) u.agencyId = null;
    if (typeof u.isHost !== "boolean") u.isHost = false;
    if (!u.activeFrame) u.activeFrame = null; // { frameId, name, imageUrl, expiresAt }
    if (u.customTag === undefined) u.customTag = null; // { text, color } — admin-assigned coloured tag (e.g. VIP), shown next to the username
    if (!u.lastDailyRewardAt) u.lastDailyRewardAt = null;
    if (!u.lastWeeklyRewardAt) u.lastWeeklyRewardAt = null;
    // SVIP Privilege System (svip.js) — separate wealth-level fields, added
    // here so existing accounts get sane defaults the same way other fields
    // above do. See svip.js for what these mean.
    if (typeof u.svipWealth !== "number") u.svipWealth = 0;
    if (typeof u.svipLevel !== "number") u.svipLevel = 0;
    if (u.svipMembershipType === undefined) u.svipMembershipType = "permanent";
    if (u.svipExpireAt === undefined) u.svipExpireAt = null;
    if (u.svipExpiryWarned === undefined) u.svipExpiryWarned = false;
});

function generateUniqueUserId() {
    let id;
    const existingIds = new Set(Object.values(users).map((u) => u.userId));
    do {
        id = String(Math.floor(10000000 + Math.random() * 90000000)); // random 8-digit
    } while (existingIds.has(id));
    return id;
}

function findUserByUserId(userId) {
    const mobile = Object.keys(users).find((m) => users[m].userId === userId);
    if (!mobile) return null;
    return { mobile, user: users[mobile] };
}

// ---------- SVIP Privilege System (additive module, see svip.js) ----------
const { initSvip } = require("./svip.js");
const svip = initSvip({ DATA_FOLDER, safeRead, safeWrite, io, socketsByUserId, findUserByUserId, saveUsers, users });

// ---------- Private Messages ----------
let privateMessages = safeRead(MESSAGES_FILE, {});
function conversationKey(a, b) { return [a, b].sort().join("_"); }

// ---------- Gift Catalog ----------
const GIFT_CATALOG = [
    { id: "rose", name: "Rose", emoji: "🌹", price: 10, tier: "normal" },
    { id: "heart", name: "Heart", emoji: "❤️", price: 20, tier: "normal" },
    { id: "crown", name: "Crown", emoji: "👑", price: 100, tier: "vip" },
    { id: "car", name: "Sports Car", emoji: "🏎️", price: 500, tier: "vip" },
    { id: "rocket", name: "Rocket", emoji: "🚀", price: 1000, tier: "legend" },
    { id: "ring", name: "Diamond Ring", emoji: "💍", price: 300, tier: "vip" },
    { id: "phoenix", name: "Legend Phoenix", emoji: "🔥", price: 2000, tier: "legend" }
];

function levelFromCoins(coins) {
    return Math.max(1, Math.floor(coins / 200) + 1);
}
function vipLevelFromDiamonds(diamonds) {
    if (diamonds >= 5000) return 5;
    if (diamonds >= 2000) return 4;
    if (diamonds >= 800) return 3;
    if (diamonds >= 300) return 2;
    if (diamonds >= 50) return 1;
    return 0;
}
// Every brand-new account starts with this many diamonds as a welcome bonus.
const NEW_USER_STARTING_DIAMONDS = 100000;

// ---------- Gift Log ----------
let giftLog = safeRead(GIFTLOG_FILE, []);
function logGift(entry) {
    giftLog.push(entry);
    if (giftLog.length > 5000) giftLog = giftLog.slice(-5000);
    safeWrite(GIFTLOG_FILE, giftLog);
}

// ---------- Wallet Transactions ----------
let transactions = safeRead(TRANSACTIONS_FILE, []);
function logTransaction(userId, currency, amount, note) {
    transactions.push({ userId, currency, amount, note, time: new Date().toISOString() });
    if (transactions.length > 10000) transactions = transactions.slice(-10000);
    safeWrite(TRANSACTIONS_FILE, transactions);
}

// ---------- Diamond -> Coin Exchange Requests ----------
let exchanges = safeRead(EXCHANGES_FILE, []);

// ---------- Frame Catalog ----------
let frameCatalog = safeRead(FRAME_CATALOG_FILE, [
    { id: "gold-classic", name: "Gold Classic", vipOnly: false, imageUrl: null },
    { id: "royal-flame", name: "Royal Flame", vipOnly: true, imageUrl: null }
]);
function saveFrameCatalog() { safeWrite(FRAME_CATALOG_FILE, frameCatalog); }

// ---------- Video Gift Catalog (admin-controlled, global, real-time) ----------
const MIN_VIDEO_GIFT_PRICE = 100000; // coins
let videoGiftCatalog = safeRead(VIDEO_GIFTS_FILE, []);
function saveVideoGiftCatalog() { safeWrite(VIDEO_GIFTS_FILE, videoGiftCatalog); }
// Only what regular users' Gift Box should ever see — never the disabled ones.
function publicVideoGiftCatalog() { return videoGiftCatalog.filter((g) => g.enabled !== false); }
// Broadcast to every connected socket app-wide (not just one room) so every
// user's Gift Box "Custom" tab updates instantly without a refresh.
function broadcastVideoGiftCatalog() { io.emit("video-gift-catalog", publicVideoGiftCatalog()); }

// ---------- Agencies ----------
let agencies = safeRead(AGENCIES_FILE, {});
function saveAgencies() { safeWrite(AGENCIES_FILE, agencies); }

// ---------- Announcements ----------
let announcements = safeRead(ANNOUNCEMENTS_FILE, []);

// ==================================================
// LIVE ROOM TREASURE CHEST
// ==================================================
const CHEST_CONFIG_FILE = path.join(DATA_FOLDER, "chest_config.json");

let chestLevels = safeRead(CHEST_CONFIG_FILE, [
    { level: 1, target: 100000, rewardPool: [ { type: "coins", amount: 500 }, { type: "coins", amount: 1000 }, { type: "diamonds", amount: 200 } ] },
    { level: 2, target: 300000, rewardPool: [ { type: "coins", amount: 2000 }, { type: "diamonds", amount: 500 }, { type: "diamonds", amount: 800 } ] },
    { level: 3, target: 800000, rewardPool: [ { type: "diamonds", amount: 1500 }, { type: "diamonds", amount: 3000 }, { type: "coins", amount: 5000 } ] }
]);
function saveChestLevels() { safeWrite(CHEST_CONFIG_FILE, chestLevels); }

const CHEST_DAY_MS = 24 * 60 * 60 * 1000;

function freshChestState() {
    return { level: 1, contributed: 0, openedLevels: [], contributors: {}, resetAt: new Date(Date.now() + CHEST_DAY_MS).toISOString() };
}

function ensureChestFresh(room) {
    if (!room.treasureChest) room.treasureChest = freshChestState();
    if (new Date(room.treasureChest.resetAt).getTime() <= Date.now()) {
        room.treasureChest = freshChestState();
    }
    return room.treasureChest;
}

function contributeToChest(room, userId, userName, diamondAmount) {
    if (!room || diamondAmount <= 0) return null;
    const chest = ensureChestFresh(room);
    chest.contributed += diamondAmount;
    chest.contributors[userId] = (chest.contributors[userId] || 0) + diamondAmount;

    const openedNow = [];
    while (chest.level <= chestLevels.length) {
        const cfg = chestLevels[chest.level - 1];
        if (!cfg || chest.contributed < cfg.target) break;
        const reward = cfg.rewardPool[crypto.randomInt(0, cfg.rewardPool.length)];
        chest.openedLevels.push(cfg.level);
        openedNow.push({ level: cfg.level, reward });
        chest.level += 1;
    }
    return openedNow.length ? openedNow : null;
}

function topChestContributors(chest, n) {
    return Object.entries(chest.contributors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([userId, amount]) => {
            const found = findUserByUserId(userId);
            return { userId, name: found ? found.user.name : "User", amount };
        });
}

function applyChestReward(userId, reward) {
    const found = findUserByUserId(userId);
    if (!found) return;
    if (reward.type === "coins") {
        found.user.coins += reward.amount;
        found.user.level = levelFromCoins(found.user.coins);
        logTransaction(userId, "coins", reward.amount, "Treasure Chest reward");
    } else if (reward.type === "diamonds") {
        found.user.diamonds += reward.amount;
        found.user.vipLevel = vipLevelFromDiamonds(found.user.diamonds);
        logTransaction(userId, "diamonds", reward.amount, "Treasure Chest reward");
    }
    saveUsers();
}

// Push the user's current coins/diamonds/level/vipLevel to their own socket
// only (never broadcast to the room) — this is what makes every wallet-
// touching action (gifts, chest rewards, admin edits, exchanges) show up
// instantly everywhere the balance is displayed, with no refresh needed.
function pushWalletUpdate(userId) {
    const found = findUserByUserId(userId);
    if (!found) return;
    const sid = socketsByUserId[userId];
    if (!sid) return;
    io.to(sid).emit("wallet-update", {
        coins: found.user.coins,
        diamonds: found.user.diamonds,
        level: found.user.level,
        vipLevel: found.user.vipLevel
    });
}

// ---------- Admin Coin Center (additive module, see coinCenter.js) ----------
const { initCoinCenter } = require("./coinCenter.js");
const coinCenter = initCoinCenter({ DATA_FOLDER, safeRead, safeWrite, io, socketsByUserId, findUserByUserId, saveUsers, users, logTransaction, pushWalletUpdate, levelFromCoins });

app.get("/api/chest/config", (req, res) => {
    res.json({ success: true, levels: chestLevels });
});

app.post("/api/admin/chest/config", requireAdmin, (req, res) => {
    const { levels } = req.body;
    if (!Array.isArray(levels) || !levels.length) {
        return res.json({ success: false, message: "সঠিক levels array দাও" });
    }
    chestLevels = levels;
    saveChestLevels();
    console.log(`🎁 Chest levels updated by admin: ${levels.map((l) => l.target).join(", ")}`);
    res.json({ success: true, levels: chestLevels });
});

// ---------- Room role helpers ----------
function roleForUser(room, userId) {
    if (!room || !userId) return "member";
    if (room.hostId === userId) return "owner";
    if ((room.adminIds || []).includes(userId)) return "admin";
    return "member";
}
function isOwnerOrAdmin(room, userId) {
    return !!room && (room.hostId === userId || (room.adminIds || []).includes(userId));
}

function syncProfileToRoom(userId) {
    const sid = socketsByUserId[userId];
    if (!sid) return;
    const s = io.sockets.sockets.get(sid);
    if (!s || !s.currentRoom) return;
    const room = rooms[s.currentRoom];
    if (!room) return;
    const found = findUserByUserId(userId);
    if (!found) return;
    const { name, photo } = found.user;
    room.onlineUsers.forEach((u) => { if (u.userId === userId) { u.userName = name; u.userPhoto = photo; } });
    room.seats.forEach((seat) => { if (seat && seat.userId === userId) { seat.userName = name; seat.userPhoto = photo; } });
    io.to(s.currentRoom).emit("room-state", publicRoom(room));
}

// ==================================================
// AUTH: Mobile + OTP
// ==================================================
// Fix (one phone number should always open exactly one account): mobile
// numbers were used as the raw, un-normalized object key everywhere. If the
// same person ever typed their number slightly differently between logins
// (leading "+91", a stray space, a dash from copy-pasting) they'd land on a
// *different* key in `users`, which looks exactly like "my account keeps
// getting logged out / replaced" even though nothing was actually deleted —
// they'd just quietly created a second account. Normalizing to the last 10
// digits before every lookup/store guarantees one number = one account.
function normalizeMobile(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "");
    return digits.slice(-10);
}

app.post("/api/auth/send-otp", (req, res) => {
    try {
        const mobile = normalizeMobile(req.body.mobile);
        if (!mobile || mobile.length !== 10) {
            return res.json({ success: false, message: "10 digit mobile number দাও" });
        }
        const otp = Math.floor(100000 + Math.random() * 900000);
        otpStore[mobile] = otp;
        console.log(`\n========== ${APP_NAME} OTP ==========`);
        console.log(`Mobile: +91${mobile}`);
        console.log(`OTP: ${otp}`);
        console.log(`======================================\n`);
        res.json({ success: true, message: "OTP পাঠানো হয়েছে।" });
    } catch (err) {
        console.error("send-otp error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

app.post("/api/auth/verify-otp", (req, res) => {
    try {
        const mobile = normalizeMobile(req.body.mobile);
        const { otp } = req.body;
        if (!otpStore[mobile] || otpStore[mobile] != otp) {
            return res.json({ success: false, message: "ভুল OTP" });
        }
        delete otpStore[mobile];
        if (users[mobile]) {
            if (users[mobile].banned) {
                console.log(`⛔ Login blocked (banned): ${users[mobile].name} (ID: ${users[mobile].userId})`);
                return res.json({ success: false, message: "তোমার অ্যাকাউন্ট ব্যান করা হয়েছে" });
            }
            console.log(`✅ Login: ${users[mobile].name} (ID: ${users[mobile].userId}), mobile ${mobile}`);
            svip.onUserLoaded(users[mobile]);
            return res.json({ success: true, user: users[mobile] });
        }
        const userId = generateUniqueUserId();
        const newUser = {
            userId,
            name: `User_${userId}`,
            mobile,
            photo: "",
            followers: 0,
            following: 0,
            followersList: [],
            followingList: [],
            visitors: 0,
            coins: 100,
            diamonds: NEW_USER_STARTING_DIAMONDS,
            level: 1,
            vipLevel: vipLevelFromDiamonds(NEW_USER_STARTING_DIAMONDS),
            banned: false,
            verified: false,
            agencyId: null,
            isHost: false,
            activeFrame: null,
            customTag: null,
            lastDailyRewardAt: null,
            lastWeeklyRewardAt: null
        };
        users[mobile] = newUser;
        svip.ensureUserSvipFields(newUser);
        saveUsers();
        console.log(`✅ New User Created: ${newUser.name} (ID: ${newUser.userId}), Mobile: ${mobile}`);
        res.json({ success: true, user: newUser });
    } catch (err) {
        console.error("verify-otp error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

// ---------- Password login (alternative to OTP) ----------
// Hashing uses Node's built-in crypto.scrypt (no new dependency). Stored as
// "salt:hash" hex in users[mobile].passwordHash.
function hashPassword(password, salt) {
    salt = salt || crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
    if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
    const [salt, hash] = stored.split(":");
    const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
    try { return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex")); }
    catch (err) { return false; }
}

// Set/create a password for a mobile number. No OTP needed — entering the
// number + a password sets it immediately. This only works the *first*
// time (i.e. that number has no password yet); once a password is set for
// a number, this same endpoint won't silently overwrite it, so someone
// else can't hijack an existing password-protected account just by knowing
// the number. Creates the account if it doesn't exist yet, same as
// verify-otp.
app.post("/api/auth/set-password", (req, res) => {
    try {
        const mobile = normalizeMobile(req.body.mobile);
        const { password } = req.body;
        if (!mobile || mobile.length !== 10) return res.json({ success: false, message: "10 digit mobile number দাও" });
        if (!password || String(password).length < 4) return res.json({ success: false, message: "কমপক্ষে ৪ ডিজিট/অক্ষরের পাসওয়ার্ড দাও" });

        if (!users[mobile]) {
            const userId = generateUniqueUserId();
            users[mobile] = {
                userId, name: `User_${userId}`, mobile, photo: "",
                followers: 0, following: 0, followersList: [], followingList: [],
                visitors: 0, coins: 100, diamonds: NEW_USER_STARTING_DIAMONDS, level: 1, vipLevel: vipLevelFromDiamonds(NEW_USER_STARTING_DIAMONDS),
                banned: false, verified: false, agencyId: null, isHost: false,
                activeFrame: null, customTag: null, lastDailyRewardAt: null, lastWeeklyRewardAt: null
            };
            console.log(`✅ New User Created (password signup): ${users[mobile].name} (ID: ${users[mobile].userId}), Mobile: ${mobile}`);
            svip.ensureUserSvipFields(users[mobile]);
        }
        if (users[mobile].banned) return res.json({ success: false, message: "তোমার অ্যাকাউন্ট ব্যান করা হয়েছে" });
        if (users[mobile].passwordHash) return res.json({ success: false, message: "এই নম্বরে আগে থেকেই পাসওয়ার্ড সেট করা আছে — পাসওয়ার্ড দিয়ে লগইন করো" });

        users[mobile].passwordHash = hashPassword(password);
        saveUsers();
        res.json({ success: true, user: { ...users[mobile], passwordHash: undefined } });
    } catch (err) {
        console.error("set-password error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

// Log in with mobile number + password (the permanent ID). Falls back to
// OTP login (existing endpoints) if no password has been set yet.
app.post("/api/auth/login-password", (req, res) => {
    try {
        const mobile = normalizeMobile(req.body.mobile);
        const { password } = req.body;
        const user = users[mobile];
        if (!user || !user.passwordHash) return res.json({ success: false, message: "এই নম্বরে কোনো পাসওয়ার্ড সেট করা নেই — OTP দিয়ে লগইন করো অথবা পাসওয়ার্ড তৈরি করো" });
        if (user.banned) return res.json({ success: false, message: "তোমার অ্যাকাউন্ট ব্যান করা হয়েছে" });
        if (!verifyPassword(password, user.passwordHash)) return res.json({ success: false, message: "ভুল পাসওয়ার্ড" });
        console.log(`✅ Login (password): ${user.name} (ID: ${user.userId}), mobile ${mobile}`);
        svip.onUserLoaded(user);
        res.json({ success: true, user: { ...user, passwordHash: undefined } });
    } catch (err) {
        console.error("login-password error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

app.post("/api/user/upload-photo", uploadPhoto.single("photo"), (req, res) => {
    try {
        const { mobile } = req.body;
        if (!req.file) return res.json({ success: false, message: "কোনো ছবি পাওয়া যায়নি" });
        if (!mobile || !users[mobile]) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
        const url = "/photos/" + req.file.filename;
        users[mobile].photo = url;
        saveUsers();
        console.log(`✅ Photo updated for ${users[mobile].name}`);
        syncProfileToRoom(users[mobile].userId);
        res.json({ success: true, url });
    } catch (err) {
        console.error("upload-photo error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

app.post("/api/user/update-profile", (req, res) => {
    try {
        const { mobile, name, bio } = req.body;
        if (!mobile || !users[mobile]) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
        if (name && name.trim()) users[mobile].name = name.trim();
        if (bio !== undefined) users[mobile].bio = bio;
        saveUsers();
        syncProfileToRoom(users[mobile].userId);
        res.json({ success: true, user: users[mobile] });
    } catch (err) {
        console.error("update-profile error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

app.get("/api/user/:mobile", (req, res) => {
    const u = users[req.params.mobile];
    if (!u) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    res.json({ success: true, user: u });
});

app.get("/api/user/by-id/:userId", (req, res) => {
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const viewerId = req.query.viewerId;
    if (viewerId && viewerId !== found.user.userId) {
        found.user.visitors = (found.user.visitors || 0) + 1;
        saveUsers();
    }
    res.json({ success: true, user: found.user });
});

// ==================================================
// FOLLOW SYSTEM
// ==================================================
app.post("/api/user/follow", (req, res) => {
    try {
        const { mobile, targetUserId } = req.body;
        const me = users[mobile];
        if (!me) return res.json({ success: false, message: "লগইন তথ্য পাওয়া যায়নি" });
        const target = findUserByUserId(targetUserId);
        if (!target) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
        if (target.user.userId === me.userId) {
            return res.json({ success: false, message: "নিজেকে ফলো করা যাবে না" });
        }
        if (!me.followingList.includes(targetUserId)) {
            me.followingList.push(targetUserId);
            me.following = me.followingList.length;
        }
        if (!target.user.followersList.includes(me.userId)) {
            target.user.followersList.push(me.userId);
            target.user.followers = target.user.followersList.length;
        }
        saveUsers();
        res.json({ success: true, user: me });
    } catch (err) {
        console.error("follow error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

app.post("/api/user/unfollow", (req, res) => {
    try {
        const { mobile, targetUserId } = req.body;
        const me = users[mobile];
        if (!me) return res.json({ success: false, message: "লগইন তথ্য পাওয়া যায়নি" });
        const target = findUserByUserId(targetUserId);
        me.followingList = me.followingList.filter((id) => id !== targetUserId);
        me.following = me.followingList.length;
        if (target) {
            target.user.followersList = target.user.followersList.filter((id) => id !== me.userId);
            target.user.followers = target.user.followersList.length;
        }
        saveUsers();
        res.json({ success: true, user: me });
    } catch (err) {
        console.error("unfollow error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

app.get("/api/user/:mobile/following", (req, res) => {
    const me = users[req.params.mobile];
    if (!me) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const list = me.followingList.map((id) => findUserByUserId(id)).filter(Boolean)
        .map((f) => ({ userId: f.user.userId, name: f.user.name, photo: f.user.photo }));
    res.json({ success: true, following: list });
});

app.get("/api/user/:mobile/followers", (req, res) => {
    const me = users[req.params.mobile];
    if (!me) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const list = me.followersList.map((id) => findUserByUserId(id)).filter(Boolean)
        .map((f) => ({ userId: f.user.userId, name: f.user.name, photo: f.user.photo }));
    res.json({ success: true, followers: list });
});

// ==================================================
// GIFT SYSTEM
// ==================================================
app.get("/api/gifts/catalog", (req, res) => {
    res.json({ success: true, gifts: GIFT_CATALOG });
});

app.get("/api/gifts/history", (req, res) => {
    const { roomId } = req.query;
    let list = giftLog.slice().reverse();
    if (roomId) list = list.filter((g) => g.roomId === roomId);
    res.json({ success: true, gifts: list });
});

app.post("/api/gifts/send", (req, res) => {
    try {
        const { mobile, targetUserId, giftId, roomId } = req.body;
        const sender = users[mobile];
        if (!sender) return res.json({ success: false, message: "লগইন তথ্য পাওয়া যায়নি" });
        const gift = GIFT_CATALOG.find((g) => g.id === giftId);
        if (!gift) return res.json({ success: false, message: "গিফট পাওয়া যায়নি" });
        if (sender.coins < gift.price) {
            return res.json({ success: false, message: "পর্যাপ্ত কয়েন নেই" });
        }
        const target = findUserByUserId(targetUserId);
        if (!target) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
        sender.coins -= gift.price;
        sender.level = levelFromCoins(sender.coins);
        // Changed on request: gift recipients now earn coins, not diamonds.
        target.user.coins = (target.user.coins || 0) + gift.price;
        target.user.level = levelFromCoins(target.user.coins);
        saveUsers();
        logTransaction(sender.userId, "coins", -gift.price, `Sent ${gift.name} to ${target.user.name}`);
        logTransaction(target.user.userId, "coins", gift.price, `Received ${gift.name} from ${sender.name}`);
        logGift({ fromUserId: sender.userId, fromName: sender.name, toUserId: target.user.userId, toName: target.user.name, gift, roomId: roomId || null, time: new Date().toISOString() });
        svip.addWealth(sender.userId, gift.price, `gift:${gift.id}:${Date.now()}`, "gift_sent");
        // Bug fix: this REST route only ever returned the sender's fresh coin
        // total in the HTTP response. The recipient (and, below, any chest
        // reward winners) never got a "wallet-update" push, so their coin
        // balance sat stale everywhere on screen until their next manual
        // reload — unlike the socket-based send-gift handler, which already
        // pushes both sides in real time. Mirror that here.
        pushWalletUpdate(sender.userId);
        pushWalletUpdate(target.user.userId);

        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            io.to(roomId).emit("gift-received", { fromUserId: sender.userId, fromName: sender.name, toUserId: target.user.userId, gift });
            const opened = contributeToChest(room, sender.userId, sender.name, gift.price);
            io.to(roomId).emit("room-state", publicRoom(room));
            if (opened) {
                opened.forEach((o) => {
                    const top = topChestContributors(room.treasureChest, 3);
                    const recipients = new Set([room.hostId, ...top.map((c) => c.userId)]);
                    recipients.forEach((uid) => applyChestReward(uid, o.reward));
                    recipients.forEach((uid) => pushWalletUpdate(uid));
                    io.to(roomId).emit("chest-opened", { level: o.level, reward: o.reward, topContributors: top });
                });
            }
        }
        res.json({ success: true, sender, targetCoins: target.user.coins });
    } catch (err) {
        console.error("gift send error:", err);
        res.status(500).json({ success: false, message: "সার্ভার এরর" });
    }
});

// ==================================================
// ROOMS (in-memory, with lightweight meta persistence)
// ==================================================
let rooms = {};
(function loadRooms() {
    const meta = safeRead(ROOMS_FILE, {});
    Object.values(meta).forEach((m) => {
        rooms[m.roomId] = {
            roomId: m.roomId,
            roomName: m.roomName,
            hostId: m.hostId,
            hostName: m.hostName,
            adminIds: m.adminIds || [],
            background: m.background || null,
            logo: m.logo || null,
            agencyId: m.agencyId || null,
            seats: Array(8).fill(null),
            onlineUsers: [],
            messages: [],
            music: { url: null, name: null, playing: false },
            lockedSeats: [],
            roomLocked: false,
            gameEnabled: m.gameEnabled !== false,
            treasureChest: freshChestState(),
            createdAt: new Date().toISOString()
        };
    });
})();

function publicRoom(room) {
    const seats = room.seats.map((seat) => {
        if (!seat) return null;
        const found = findUserByUserId(seat.userId);
        return {
            ...seat,
            role: roleForUser(room, seat.userId),
            // Always read live from the user record so a frame/VIP change
            // shows up on the seat instantly, without needing a manual sync call.
            activeFrame: found ? found.user.activeFrame || null : (seat.activeFrame || null),
            vipLevel: found ? (found.user.vipLevel || 0) : (seat.vipLevel || 0),
            customTag: found ? (found.user.customTag || null) : (seat.customTag || null)
        };
    });
    return { ...room, seats };
}
function roomListPublic() {
    return Object.values(rooms)
        .map((r) => ({ roomId: r.roomId, roomName: r.roomName, hostName: r.hostName, onlineCount: r.onlineUsers.length, roomLocked: !!r.roomLocked, logo: r.logo || null }))
        .sort((a, b) => b.onlineCount - a.onlineCount);
}

app.get("/api/room/list", (req, res) => {
    res.json({ success: true, rooms: roomListPublic() });
});

app.post("/api/room/create", (req, res) => {
    const { roomName, userId, userName } = req.body;
    if (!roomName || !roomName.trim()) return res.json({ success: false, message: "Room নাম দাও" });
    const existing = Object.values(rooms).find((r) => r.hostId === userId);
    if (existing) return res.json({ success: false, message: "তোমার আগে থেকেই একটা রুম আছে।", existingRoomId: existing.roomId });
    const roomId = crypto.randomBytes(5).toString("hex");
    const room = {
        roomId, roomName: roomName.trim(), hostId: userId, hostName: userName,
        adminIds: [], seats: Array(8).fill(null), onlineUsers: [], messages: [],
        music: { url: null, name: null, playing: false }, background: null, logo: null, lockedSeats: [],
        agencyId: null, roomLocked: false, gameEnabled: true, treasureChest: freshChestState(), createdAt: new Date().toISOString()
    };
    rooms[roomId] = room;
    saveRoomsToDisk();
    const found = findUserByUserId(userId);
    if (found && !found.user.isHost) { found.user.isHost = true; saveUsers(); }
    io.emit("room-list", roomListPublic());
    res.json({ success: true, room: publicRoom(room) });
});

// ---------- Music upload ----------
app.post("/api/music/upload", upload.single("music"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "ফাইল পাওয়া যায়নি" });
    res.json({ success: true, url: "/music/" + req.file.filename, name: req.file.originalname });
});

// ---------- Room background upload ----------
app.post("/api/room/background/upload", uploadBg.single("background"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "ফাইল পাওয়া যায়নি" });
    res.json({ success: true, url: "/backgrounds/" + req.file.filename });
});

// ---------- Room logo upload ----------
app.post("/api/room/logo/upload", uploadLogo.single("logo"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "ফাইল পাওয়া যায়নি" });
    res.json({ success: true, url: "/logos/" + req.file.filename });
});

// ==================================================
// WALLET
// ==================================================
// ---------- SVIP Privilege System — read-only endpoints (Backend Core phase) ----------
app.get("/api/svip/status/:userId", (req, res) => {
    const status = svip.statusFor(req.params.userId);
    if (!status) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    res.json({ success: true, ...status });
});
app.get("/api/svip/config", (req, res) => {
    res.json({ success: true, levels: svip.getConfig().levels, resources: svip.getResourceMap() });
});
app.get("/api/svip/leaderboard", (req, res) => {
    const period = ["daily", "weekly", "monthly", "all"].includes(req.query.period) ? req.query.period : "all";
    res.json({ success: true, period, leaderboard: svip.getLeaderboard(period, 20) });
});

// ---------- SVIP Tag Management (PNG upload per level, SVIP1–8) ----------
// Public: what the app/admin panel reads to show each level's tag image.
app.get("/api/svip/tags", (req, res) => {
    res.json({ success: true, tags: svip.listTags() });
});

// Admin: upload/replace the PNG tag for a given level. The file is
// auto-resized (max 256px on the longest side, aspect ratio preserved) and
// re-encoded through sharp's PNG output, which keeps the alpha/transparency
// channel intact and never touches the background — sharp just decodes and
// re-encodes the existing pixels, it doesn't flatten or recolor anything.
// Saved as a fixed uploads/svip-tags/svip{level}.png so re-uploading always
// replaces the previous tag; a tagVersion timestamp is stored separately
// for cache-busting on the client.
// Resize+save a SVIP tag PNG using whichever image engine is available.
// Tries sharp first (best quality/speed), falls back to jimp (pure JS, no
// native binary — works everywhere including Termux), and as a last
// resort just stores the original PNG unresized so the feature never
// hard-fails the request just because neither library could load.
async function saveSvipTagImage(buffer, outPath) {
    if (sharp) {
        await sharp(buffer)
            .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
            .png()
            .toFile(outPath);
        return "sharp";
    }
    if (jimp) {
        const Jimp = jimp.Jimp || jimp; // support both jimp v0.x (default export) and v1.x (named export)
        const image = await Jimp.read(buffer);
        if (typeof image.scaleToFit === "function") image.scaleToFit(256, 256);
        else if (typeof image.scaleToFit === "object" && Jimp.scaleToFit) await image.scaleToFit({ w: 256, h: 256 }); // v1.x fallback shape
        if (typeof image.writeAsync === "function") await image.writeAsync(outPath);
        else await image.write(outPath);
        return "jimp";
    }
    fs.writeFileSync(outPath, buffer);
    return "original-unresized";
}

app.post("/api/admin/svip-tags/:level/upload", requireAdmin, uploadSvipTag.single("tag"), async (req, res) => {
    try {
        const level = Number(req.params.level);
        if (!Number.isInteger(level) || level < 1 || level > 8) {
            return res.json({ success: false, message: "SVIP level 1 থেকে 8 এর মধ্যে হতে হবে" });
        }
        if (!req.file) return res.json({ success: false, message: "PNG ফাইল পাওয়া যায়নি" });

        const filename = `svip${level}.png`;
        const outPath = path.join(SVIP_TAG_FOLDER, filename);
        const engine = await saveSvipTagImage(req.file.buffer, outPath);

        const asset = svip.setTagAsset(level, `/svip-tags/${filename}`);
        res.json({ success: true, level, tag: asset.tag, tagVersion: asset.tagVersion, resizedWith: engine });
    } catch (err) {
        console.error("svip tag upload error:", err);
        res.status(500).json({ success: false, message: "ছবি প্রসেস করতে ব্যর্থ — শুধু বৈধ PNG আপলোড করো" });
    }
});

// Admin: remove a level's tag (keeps the record clean; a later re-upload
// simply overwrites svip{level}.png again).
app.delete("/api/admin/svip-tags/:level", requireAdmin, (req, res) => {
    const level = Number(req.params.level);
    if (!Number.isInteger(level) || level < 1 || level > 8) {
        return res.json({ success: false, message: "SVIP level 1 থেকে 8 এর মধ্যে হতে হবে" });
    }
    const filePath = path.join(SVIP_TAG_FOLDER, `svip${level}.png`);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
    svip.clearTagAsset(level);
    res.json({ success: true, level });
});

app.get("/api/wallet/:userId", (req, res) => {
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    res.json({ success: true, coins: found.user.coins, diamonds: found.user.diamonds });
});
app.get("/api/wallet/:userId/transactions", (req, res) => {
    const list = transactions.filter((t) => t.userId === req.params.userId).slice().reverse().slice(0, 50);
    res.json({ success: true, transactions: list });
});
app.get("/api/wallet/:userId/exchanges", (req, res) => {
    const list = exchanges.filter((e) => e.userId === req.params.userId).slice().reverse();
    res.json({ success: true, exchanges: list });
});
app.post("/api/wallet/exchange/request", (req, res) => {
    const { userId, diamonds, note } = req.body;
    const found = findUserByUserId(userId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const amount = Number(diamonds);
    if (!amount || amount <= 0 || found.user.diamonds < amount) return res.json({ success: false, message: "পর্যাপ্ত Diamond নেই" });
    const id = crypto.randomBytes(6).toString("hex");
    exchanges.push({ id, userId, userName: found.user.name, diamonds: amount, note: note || "", status: "pending", time: new Date().toISOString() });
    safeWrite(EXCHANGES_FILE, exchanges);
    res.json({ success: true });
});

// ==================================================
// TREASURE BOX (daily/weekly)
// ==================================================
app.get("/api/treasure/status/:userId", (req, res) => {
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const now = Date.now();
    const dailyReady = !found.user.lastDailyRewardAt || (now - new Date(found.user.lastDailyRewardAt).getTime()) >= 24 * 60 * 60 * 1000;
    const weeklyReady = !found.user.lastWeeklyRewardAt || (now - new Date(found.user.lastWeeklyRewardAt).getTime()) >= 7 * 24 * 60 * 60 * 1000;
    res.json({ success: true, dailyReady, weeklyReady });
});
app.post("/api/treasure/claim-daily", (req, res) => {
    const found = findUserByUserId(req.body.userId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const now = Date.now();
    if (found.user.lastDailyRewardAt && (now - new Date(found.user.lastDailyRewardAt).getTime()) < 24 * 60 * 60 * 1000) {
        return res.json({ success: false, message: "আজকেরটা নেওয়া হয়ে গেছে" });
    }
    const reward = 50 + crypto.randomInt(0, 151);
    found.user.coins += reward;
    found.user.level = levelFromCoins(found.user.coins);
    found.user.lastDailyRewardAt = new Date().toISOString();
    saveUsers();
    logTransaction(found.user.userId, "coins", reward, "Daily reward");
    res.json({ success: true, reward, coins: found.user.coins });
});
app.post("/api/treasure/claim-weekly", (req, res) => {
    const found = findUserByUserId(req.body.userId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const now = Date.now();
    if (found.user.lastWeeklyRewardAt && (now - new Date(found.user.lastWeeklyRewardAt).getTime()) < 7 * 24 * 60 * 60 * 1000) {
        return res.json({ success: false, message: "এই সপ্তাহেরটা নেওয়া হয়ে গেছে" });
    }
    const reward = 300 + crypto.randomInt(0, 501);
    found.user.coins += reward;
    found.user.level = levelFromCoins(found.user.coins);
    found.user.lastWeeklyRewardAt = new Date().toISOString();
    saveUsers();
    logTransaction(found.user.userId, "coins", reward, "Weekly reward");
    res.json({ success: true, reward, coins: found.user.coins });
});

// ==================================================
// FRAMES
// ==================================================
app.get("/api/frames/catalog", (req, res) => {
    res.json({ success: true, frames: frameCatalog });
});
app.get("/api/frames/mine/:userId", (req, res) => {
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    let af = found.user.activeFrame;
    if (af && af.expiresAt && new Date(af.expiresAt).getTime() < Date.now()) {
        af = null; found.user.activeFrame = null; saveUsers();
    }
    res.json({ success: true, activeFrame: af });
});
app.post("/api/admin/frames/send", requireAdmin, (req, res) => {
    const { targetUserId, frameId, expiryDays } = req.body;
    const found = findUserByUserId(targetUserId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const frame = frameCatalog.find((f) => f.id === frameId);
    if (!frame) return res.json({ success: false, message: "Frame পাওয়া যায়নি" });
    const expiresAt = expiryDays ? new Date(Date.now() + Number(expiryDays) * 86400000).toISOString() : null;
    found.user.activeFrame = { frameId, name: frame.name, imageUrl: frame.imageUrl, expiresAt };
    saveUsers();
    syncProfileToRoom(targetUserId);
    const sid = socketsByUserId[targetUserId];
    if (sid) io.to(sid).emit("frame-updated", found.user.activeFrame);
    res.json({ success: true });
});
// Admin-assigned coloured text tag (e.g. "VIP") shown next to a user's name
// in chat, on their seat, and on their profile. Send with an empty/blank
// text to remove an existing tag from that user.
app.post("/api/admin/tags/send", requireAdmin, (req, res) => {
    const { targetUserId, text, color } = req.body;
    const found = findUserByUserId(targetUserId);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    const cleanText = (text || "").trim().slice(0, 12);
    found.user.customTag = cleanText ? { text: cleanText, color: (color || "#F4C463").slice(0, 20) } : null;
    saveUsers();
    syncProfileToRoom(targetUserId);
    const sid = socketsByUserId[targetUserId];
    if (sid) io.to(sid).emit("tag-updated", found.user.customTag);
    res.json({ success: true, customTag: found.user.customTag });
});
app.post("/api/admin/frames/upload", requireAdmin, uploadFrame.single("frame"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "ফাইল পাওয়া যায়নি" });
    const { name, vipOnly } = req.body;
    const id = "frame_" + Date.now();
    const frame = { id, name: (name && name.trim()) || req.file.originalname, vipOnly: vipOnly === "true" || vipOnly === true, imageUrl: "/frames/" + req.file.filename };
    frameCatalog.push(frame);
    saveFrameCatalog();
    res.json({ success: true, frame });
});

// ==================================================
// VIDEO GIFTS (Global Video Gift System — admin controlled)
// ==================================================
// Public: what the app's Gift Box "Custom" tab loads (enabled gifts only).
app.get("/api/video-gifts/catalog", (req, res) => {
    res.json({ success: true, gifts: publicVideoGiftCatalog() });
});
// Admin: full list including disabled ones, for the management screen.
app.get("/api/admin/video-gifts", requireAdmin, (req, res) => {
    res.json({ success: true, gifts: videoGiftCatalog });
});
app.post("/api/admin/video-gifts/upload", requireAdmin, uploadVideoGift.fields([
    { name: "video", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 }
]), (req, res) => {
    const videoFile = req.files && req.files.video && req.files.video[0];
    const thumbFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
    if (!videoFile) return res.json({ success: false, message: "MP4 ভিডিও দাও" });
    const name = (req.body.name || "").trim();
    if (!name) return res.json({ success: false, message: "Gift Name দাও" });
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < MIN_VIDEO_GIFT_PRICE) {
        return res.json({ success: false, message: `Coin Price কমপক্ষে ${MIN_VIDEO_GIFT_PRICE} হতে হবে` });
    }
    let duration = Number(req.body.duration);
    if (!Number.isFinite(duration)) duration = 6;
    duration = Math.min(8, Math.max(6, duration));
    const gift = {
        id: "vgift_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
        name,
        price,
        duration,
        videoUrl: "/video-gifts/" + videoFile.filename,
        thumbnail: thumbFile ? ("/video-gifts-thumbs/" + thumbFile.filename) : null,
        enabled: true,
        createdAt: new Date().toISOString()
    };
    videoGiftCatalog.push(gift);
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    res.json({ success: true, gift });
});
app.post("/api/admin/video-gifts/:id/update", requireAdmin, (req, res) => {
    const gift = videoGiftCatalog.find((g) => g.id === req.params.id);
    if (!gift) return res.json({ success: false, message: "Gift পাওয়া যায়নি" });
    const { name, price, duration, enabled } = req.body;
    if (name !== undefined && String(name).trim()) gift.name = String(name).trim();
    if (price !== undefined) {
        const p = Number(price);
        if (!Number.isFinite(p) || p < MIN_VIDEO_GIFT_PRICE) {
            return res.json({ success: false, message: `Coin Price কমপক্ষে ${MIN_VIDEO_GIFT_PRICE} হতে হবে` });
        }
        gift.price = p;
    }
    if (duration !== undefined) {
        let d = Number(duration);
        if (Number.isFinite(d)) gift.duration = Math.min(8, Math.max(6, d));
    }
    if (enabled !== undefined) gift.enabled = enabled === true || enabled === "true";
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    res.json({ success: true, gift });
});
app.post("/api/admin/video-gifts/:id/toggle", requireAdmin, (req, res) => {
    const gift = videoGiftCatalog.find((g) => g.id === req.params.id);
    if (!gift) return res.json({ success: false, message: "Gift পাওয়া যায়নি" });
    gift.enabled = !(gift.enabled !== false);
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    res.json({ success: true, gift });
});
app.delete("/api/admin/video-gifts/:id", requireAdmin, (req, res) => {
    const idx = videoGiftCatalog.findIndex((g) => g.id === req.params.id);
    if (idx === -1) return res.json({ success: false, message: "Gift পাওয়া যায়নি" });
    const [removed] = videoGiftCatalog.splice(idx, 1);
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    // Best-effort cleanup of the stored files — never let this block the response.
    try { if (removed.videoUrl) fs.unlinkSync(path.join(__dirname, removed.videoUrl)); } catch (_) {}
    try { if (removed.thumbnail) fs.unlinkSync(path.join(__dirname, removed.thumbnail)); } catch (_) {}
    res.json({ success: true });
});
// Scoped just to these routes: turns multer errors (wrong file type, over the
// size limit) into a normal JSON response instead of an HTML crash page.
app.use("/api/admin/video-gifts", (err, req, res, next) => {
    if (err) return res.status(400).json({ success: false, message: err.message || "আপলোড ব্যর্থ হয়েছে" });
    next();
});

// ==================================================
// AGENCY CENTER
// ==================================================
app.get("/api/agency/mine/:userId", (req, res) => {
    const uid = req.params.userId;
    const owned = Object.values(agencies).find((a) => a.ownerUserId === uid);
    if (owned) {
        const hosts = owned.hostIds.map((hid) => findUserByUserId(hid)).filter(Boolean)
            .map((h) => ({ userId: h.user.userId, name: h.user.name, coins: h.user.coins, diamonds: h.user.diamonds }));
        return res.json({ success: true, agency: { ...owned, isOwner: true, hosts } });
    }
    const asHost = Object.values(agencies).find((a) => a.hostIds.includes(uid));
    if (asHost) return res.json({ success: true, agency: { ...asHost, isOwner: false } });
    res.json({ success: true, agency: null });
});
app.get("/api/admin/agency/list", requireAdmin, (req, res) => {
    res.json({ success: true, agencies: Object.values(agencies) });
});
app.post("/api/admin/agency/create", requireAdmin, (req, res) => {
    const { name, ownerUserId, commissionRate } = req.body;
    const found = findUserByUserId(ownerUserId);
    if (!name || !found) return res.json({ success: false, message: "নাম ও সঠিক Owner ID দাও" });
    const agencyId = "ag_" + crypto.randomBytes(4).toString("hex");
    agencies[agencyId] = { agencyId, name, ownerUserId, hostIds: [], commissionRate: commissionRate ? Number(commissionRate) : 0.3, earnedDiamonds: 0 };
    found.user.agencyId = agencyId;
    saveUsers();
    saveAgencies();
    res.json({ success: true, agency: agencies[agencyId] });
});
app.post("/api/admin/agency/assign-host", requireAdmin, (req, res) => {
    const { agencyId, hostUserId } = req.body;
    const agency = agencies[agencyId];
    const found = findUserByUserId(hostUserId);
    if (!agency || !found) return res.json({ success: false, message: "সঠিক Agency ID ও Host ID দাও" });
    if (!agency.hostIds.includes(hostUserId)) agency.hostIds.push(hostUserId);
    found.user.agencyId = agencyId;
    found.user.isHost = true;
    saveUsers();
    saveAgencies();
    res.json({ success: true });
});

// ==================================================
// ANNOUNCEMENTS
// ==================================================
app.get("/api/announcements", (req, res) => {
    res.json({ success: true, announcements: announcements.slice().reverse() });
});
app.post("/api/admin/announcements", requireAdmin, (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.json({ success: false, message: "টেক্সট দাও" });
    const entry = { text: text.trim(), time: new Date().toISOString() };
    announcements.push(entry);
    safeWrite(ANNOUNCEMENTS_FILE, announcements);
    io.emit("announcement", entry);
    res.json({ success: true });
});

// ==================================================
// PRIVATE MESSAGES
// ==================================================
app.get("/api/messages/inbox/:userId", (req, res) => {
    const uid = req.params.userId;
    const convos = [];
    Object.keys(privateMessages).forEach((key) => {
        const parts = key.split("_");
        if (!parts.includes(uid)) return;
        const otherId = parts[0] === uid ? parts[1] : parts[0];
        const otherFound = findUserByUserId(otherId);
        const msgs = privateMessages[key];
        if (!msgs.length) return;
        const last = msgs[msgs.length - 1];
        convos.push({ otherUserId: otherId, otherName: otherFound ? otherFound.user.name : "User", otherPhoto: otherFound ? otherFound.user.photo : "", lastMessage: last.message, time: last.time });
    });
    // PingPong Help always appears in every user's inbox, even before the
    // first message is ever sent. If there's no conversation yet, it's
    // shown with the welcome text as a preview and sinks to the bottom
    // (epoch time) rather than jumping above genuinely recent chats.
    const aiKey = conversationKey(uid, aiChat.AI_USER_ID);
    const aiMsgs = privateMessages[aiKey];
    const aiLast = aiMsgs && aiMsgs.length ? aiMsgs[aiMsgs.length - 1] : null;
    convos.push({
        otherUserId: aiChat.AI_USER_ID, otherName: aiChat.AI_NAME, otherPhoto: "", isAi: true, verified: true,
        lastMessage: aiLast ? aiLast.message : aiChat.welcomeMessage(),
        time: aiLast ? aiLast.time : new Date(0).toISOString(),
    });
    convos.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json({ success: true, conversations: convos });
});
app.get("/api/messages/thread/:userId1/:userId2", (req, res) => {
    const key = conversationKey(req.params.userId1, req.params.userId2);
    // Seed the AI thread with its welcome message the first time either
    // side opens it, so it never shows up empty.
    if ([req.params.userId1, req.params.userId2].includes(aiChat.AI_USER_ID) && !privateMessages[key]) {
        const otherId = req.params.userId1 === aiChat.AI_USER_ID ? req.params.userId2 : req.params.userId1;
        privateMessages[key] = [{ from: aiChat.AI_USER_ID, to: otherId, message: aiChat.welcomeMessage(), time: new Date().toISOString(), ai: true }];
        saveMessages();
    }
    res.json({ success: true, messages: privateMessages[key] || [] });
});
app.post("/api/messages/send", async (req, res) => {
    const { fromUserId, toUserId, message } = req.body;
    if (!message || !message.trim()) return res.json({ success: false, message: "মেসেজ লেখো" });
    const key = conversationKey(fromUserId, toUserId);
    if (!privateMessages[key]) privateMessages[key] = [];
    const msg = { from: fromUserId, to: toUserId, message: message.trim().slice(0, 1000), time: new Date().toISOString() };
    privateMessages[key].push(msg);
    saveMessages();
    const targetSocket = socketsByUserId[toUserId];
    if (targetSocket) io.to(targetSocket).emit("new-private-message", msg);

    // If this message is going to PingPong Help, generate and store its
    // reply right here so the sender gets it back in the same response —
    // plus push it over their socket too, in case they've already
    // navigated away from the thread by the time it lands.
    if (toUserId === aiChat.AI_USER_ID) {
        if (aiSecurity.isRateLimited(`ai-chat:${fromUserId}`, { windowMs: 30000, max: 10 })) {
            const limitMsg = { from: aiChat.AI_USER_ID, to: fromUserId, message: "একটু ধীরে — কয়েক সেকেন্ড পর আবার চেষ্টা করো।", time: new Date().toISOString(), ai: true };
            privateMessages[key].push(limitMsg);
            saveMessages();
            return res.json({ success: true, message: msg, aiReply: limitMsg });
        }
        const replyText = await aiChat.reply(fromUserId, msg.message);
        const replyMsg = { from: aiChat.AI_USER_ID, to: fromUserId, message: replyText, time: new Date().toISOString(), ai: true };
        privateMessages[key].push(replyMsg);
        saveMessages();
        const senderSocket = socketsByUserId[fromUserId];
        if (senderSocket) io.to(senderSocket).emit("new-private-message", replyMsg);
        return res.json({ success: true, message: msg, aiReply: replyMsg });
    }

    res.json({ success: true, message: msg });
});

// ==================================================
// ADMIN AUTH + ADMIN ROUTES
// ==================================================
function requireAdmin(req, res, next) {
    const token = req.headers["x-admin-token"];
    if (!token || !adminSessions.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    next();
}
function adminUsernameFromReq(req) {
    return adminSessions.get(req.headers["x-admin-token"]) || "admin";
}

app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(24).toString("hex");
        adminSessions.set(token, username);
        return res.json({ success: true, token });
    }
    res.json({ success: false, message: "ভুল Username অথবা Password" });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => {
    adminSessions.delete(req.headers["x-admin-token"]);
    res.json({ success: true });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
    res.json({
        success: true,
        stats: {
            totalUsers: Object.keys(users).length,
            totalRooms: Object.keys(rooms).length,
            onlineCount: Object.keys(socketsByUserId).length,
            bannedCount: Object.values(users).filter((u) => u.banned).length
        }
    });
});
app.get("/api/admin/live", requireAdmin, (req, res) => {
    const activeRooms = Object.values(rooms).filter((r) => r.onlineUsers.length > 0)
        .map((r) => ({ roomName: r.roomName, hostName: r.hostName, onlineUsers: r.onlineUsers, onlineCount: r.onlineUsers.length }));
    res.json({ success: true, totalOnline: Object.keys(socketsByUserId).length, activeRooms });
});
app.get("/api/admin/users", requireAdmin, (req, res) => {
    const list = Object.values(users).map((u) => ({ name: u.name, userId: u.userId, mobile: u.mobile, coins: u.coins, diamonds: u.diamonds, vipLevel: u.vipLevel, verified: !!u.verified, banned: u.banned, customTag: u.customTag || null }));
    res.json({ success: true, users: list });
});
app.post("/api/admin/users/:mobile/ban", requireAdmin, (req, res) => {
    const u = users[req.params.mobile];
    if (!u) return res.json({ success: false, message: "পাওয়া যায়নি" });
    u.banned = !!req.body.banned;
    saveUsers();
    if (u.banned) {
        const sid = socketsByUserId[u.userId];
        if (sid) io.to(sid).emit("kicked", { message: "তোমার অ্যাকাউন্ট ব্যান করা হয়েছে", forceLogout: true });
    }
    res.json({ success: true });
});
app.post("/api/admin/users/:mobile/verify", requireAdmin, (req, res) => {
    const u = users[req.params.mobile];
    if (!u) return res.json({ success: false, message: "পাওয়া যায়নি" });
    u.verified = !!req.body.verified;
    saveUsers();
    res.json({ success: true });
});
app.post("/api/admin/users/:mobile/coins", requireAdmin, (req, res) => {
    const u = users[req.params.mobile];
    if (!u) return res.json({ success: false, message: "পাওয়া যায়নি" });
    const coins = Number(req.body.coins);
    if (isNaN(coins) || coins < 0) return res.json({ success: false, message: "সঠিক সংখ্যা দাও" });
    const diff = coins - u.coins;
    u.coins = coins;
    u.level = levelFromCoins(u.coins);
    saveUsers();
    logTransaction(u.userId, "coins", diff, "Admin adjustment");
    pushWalletUpdate(u.userId);
    res.json({ success: true });
});

// ---------- Admin Coin Center ----------
// A separate feature from the coin-set endpoint above: this *adds* coins
// from a tracked system pool (rather than overwriting a user's balance),
// always shows as "Coin Center" in the user's own transaction history
// (never an admin username), and is idempotent via requestId.
app.get("/api/admin/coin-center/balance", requireAdmin, (req, res) => {
    res.json({ success: true, systemBalance: coinCenter.getSystemBalance() });
});
app.post("/api/admin/coin-center/balance", requireAdmin, (req, res) => {
    const result = coinCenter.setSystemBalance(req.body.amount, adminUsernameFromReq(req));
    res.json(result);
});
app.get("/api/admin/coin-center/search", requireAdmin, (req, res) => {
    const found = coinCenter.findUserByIdOrMobile(req.query.query);
    if (!found) return res.json({ success: false, message: "ইউজার পাওয়া যায়নি" });
    res.json({ success: true, user: { userId: found.user.userId, name: found.user.name, mobile: found.mobile, coins: found.user.coins, photo: found.user.photo || "" } });
});
app.post("/api/admin/coin-center/send", requireAdmin, (req, res) => {
    const { targetUserId, amount, reason, requestId } = req.body;
    if (!targetUserId) return res.json({ success: false, message: "Target User ID দাও" });
    const result = coinCenter.sendCoins({ targetUserId, amount, reason, requestId, adminUsername: adminUsernameFromReq(req) });
    res.json(result);
});
app.post("/api/admin/coin-center/send-bulk", requireAdmin, (req, res) => {
    const { targetUserIds, amount, reason, requestId } = req.body;
    if (!Array.isArray(targetUserIds) || !targetUserIds.length) return res.json({ success: false, message: "অন্তত একজন ইউজার সিলেক্ট করো" });
    const result = coinCenter.sendCoinsBulk({ targetUserIds, amount, reason, requestId, adminUsername: adminUsernameFromReq(req) });
    res.json(result);
});
app.get("/api/admin/coin-center/log", requireAdmin, (req, res) => {
    res.json({ success: true, log: coinCenter.getLog(100) });
});


app.delete("/api/admin/users/:mobile", requireAdmin, (req, res) => {
    const u = users[req.params.mobile];
    if (!u) return res.json({ success: false, message: "পাওয়া যায়নি" });
    const sid = socketsByUserId[u.userId];
    if (sid) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.currentRoom) handleUserLeaveRoom(s.currentRoom, u.userId, s);
        io.to(sid).emit("kicked", { message: "তোমার অ্যাকাউন্ট মুছে ফেলা হয়েছে", forceLogout: true });
    }
    delete users[req.params.mobile];
    saveUsers();
    res.json({ success: true });
});

app.get("/api/admin/rooms", requireAdmin, (req, res) => {
    const list = Object.values(rooms).map((r) => ({ roomId: r.roomId, roomName: r.roomName, hostName: r.hostName, onlineCount: r.onlineUsers.length, roomLocked: !!r.roomLocked, gameEnabled: r.gameEnabled !== false }));
    res.json({ success: true, rooms: list });
});
app.post("/api/admin/rooms/:roomId/lock", requireAdmin, (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.json({ success: false, message: "পাওয়া যায়নি" });
    room.roomLocked = !!req.body.locked;
    res.json({ success: true });
});
app.post("/api/admin/rooms/:roomId/game", requireAdmin, (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.json({ success: false, message: "পাওয়া যায়নি" });
    room.gameEnabled = !!req.body.enabled;
    saveRoomsToDisk();
    // Push the change live so anyone already in the room sees the game
    // button appear/disappear immediately, no refresh needed.
    io.to(room.roomId).emit("room-state", publicRoom(room));
    console.log(`🎮 Game ${room.gameEnabled ? "enabled" : "disabled"} for room "${room.roomName}" (by admin)`);
    res.json({ success: true, gameEnabled: room.gameEnabled });
});
app.delete("/api/admin/rooms/:roomId", requireAdmin, (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.json({ success: false, message: "পাওয়া যায়নি" });
    io.to(room.roomId).emit("kicked", { message: "Room বন্ধ করা হয়েছে (admin)" });
    delete rooms[req.params.roomId];
    saveRoomsToDisk();
    io.emit("room-list", roomListPublic());
    res.json({ success: true });
});

app.get("/api/admin/exchanges", requireAdmin, (req, res) => {
    res.json({ success: true, exchanges: exchanges.slice().reverse() });
});
app.post("/api/admin/exchanges/:id/decide", requireAdmin, (req, res) => {
    const ex = exchanges.find((e) => e.id === req.params.id);
    if (!ex) return res.json({ success: false, message: "পাওয়া যায়নি" });
    if (ex.status !== "pending") return res.json({ success: false, message: "ইতিমধ্যে সিদ্ধান্ত হয়ে গেছে" });
    const { approve } = req.body;
    const found = findUserByUserId(ex.userId);
    if (approve) {
        if (!found || found.user.diamonds < ex.diamonds) {
            ex.status = "rejected";
            safeWrite(EXCHANGES_FILE, exchanges);
            return res.json({ success: false, message: "পর্যাপ্ত diamond নেই, reject করা হলো" });
        }
        found.user.diamonds -= ex.diamonds;
        const coinsGained = ex.diamonds * 10;
        found.user.coins += coinsGained;
        found.user.level = levelFromCoins(found.user.coins);
        saveUsers();
        logTransaction(ex.userId, "diamonds", -ex.diamonds, "Exchange approved");
        logTransaction(ex.userId, "coins", coinsGained, "Exchange approved");
        ex.status = "approved";
        pushWalletUpdate(ex.userId);
    } else {
        ex.status = "rejected";
    }
    safeWrite(EXCHANGES_FILE, exchanges);
    res.json({ success: true });
});

// ==================================================
// SOCKET.IO — real-time rooms, voice signaling, chat, gifts, games
// ==================================================
function handleUserLeaveRoom(roomId, userId, socket) {
    const room = rooms[roomId];
    if (!room) return;
    let seatNumber = null;
    room.seats.forEach((s, i) => { if (s && s.userId === userId) { seatNumber = i + 1; room.seats[i] = null; } });
    room.onlineUsers = room.onlineUsers.filter((u) => u.userId !== userId);
    if (seatNumber) io.to(roomId).emit("seat-update", { action: "leave", seatNumber, userId });
    io.to(roomId).emit("user-count", { count: room.onlineUsers.length });
    io.to(roomId).emit("room-state", publicRoom(room));
    if (socketsByUserId[userId] && (!socket || socketsByUserId[userId] === socket.id)) delete socketsByUserId[userId];
    // Fix (couldn't actually leave a room): this function updated the room's
    // data and told everyone else, but never removed the leaving socket
    // from the Socket.IO room itself — so their connection quietly stayed
    // subscribed to the old room's broadcasts (chat/gifts/room-state), and
    // joining a second room afterwards left them double-subscribed to both.
    if (socket) {
        socket.leave(roomId);
        if (socket.currentRoom === roomId) socket.currentRoom = null;
    }
    console.log(`🚶 User ${userId} left room ${roomId}${seatNumber ? ` (freed seat ${seatNumber})` : ""}`);
    io.emit("room-list", roomListPublic());
}

io.on("connection", (socket) => {
    socket.userId = null;
    socket.currentRoom = null;
    socket.emit("room-list", roomListPublic());
    socket.emit("video-gift-catalog", publicVideoGiftCatalog());

    socket.on("join-room", ({ roomId, userId, userName, userPhoto }) => {
        const room = rooms[roomId];
        if (!room) { socket.emit("room-error", { message: "রুম পাওয়া যায়নি" }); return; }
        // Fix (banned users could still act in rooms): banned status was only
        // checked at OTP login, not when actually joining a room over a socket
        // (e.g. a session opened before the ban, or an old cached session).
        const foundForBan = findUserByUserId(userId);
        if (foundForBan && foundForBan.user.banned) {
            socket.emit("kicked", { message: "তোমার অ্যাকাউন্ট ব্যান করা হয়েছে", forceLogout: true });
            return;
        }
        if (room.roomLocked && room.hostId !== userId && !(room.adminIds || []).includes(userId)) {
            socket.emit("room-error", { message: "রুম লক করা আছে" });
            return;
        }
        if (pendingDisconnects[userId]) {
            console.log(`↩️  User ${userId} reconnected before grace period expired — cancelling scheduled leave`);
            clearTimeout(pendingDisconnects[userId].timer);
            delete pendingDisconnects[userId];
        }
        socket.userId = userId;
        socket.currentRoom = roomId;
        socketsByUserId[userId] = socket.id;
        socket.join(roomId);
        if (foundForBan) svip.checkExpiry(userId);
        console.log(`🚪 join-room: user ${userId} (${userName || "?"}) joined room ${roomId} (socket ${socket.id})`);

        const existingIdx = room.onlineUsers.findIndex((u) => u.userId === userId);
        const entry = { userId, userName, userPhoto, socketId: socket.id };
        if (existingIdx >= 0) room.onlineUsers[existingIdx] = entry; else room.onlineUsers.push(entry);
        room.seats.forEach((seat) => { if (seat && seat.userId === userId) seat.socketId = socket.id; });

        io.to(roomId).emit("room-state", publicRoom(room));
        io.to(roomId).emit("user-count", { count: room.onlineUsers.length });
        io.emit("room-list", roomListPublic());
    });

    socket.on("leave-room", ({ roomId, userId }) => handleUserLeaveRoom(roomId, userId, socket));

    socket.on("take-seat", ({ roomId, seatNumber }) => {
        const room = rooms[roomId];
        if (!room || !socket.userId) return;
        if (seatNumber < 1 || seatNumber > 8) return;
        if (room.seats[seatNumber - 1]) { socket.emit("room-error", { message: "সিট আগে থেকেই দখল করা" }); return; }
        if ((room.lockedSeats || []).includes(seatNumber) && !isOwnerOrAdmin(room, socket.userId)) {
            socket.emit("room-error", { message: "সিট লক করা আছে" });
            return;
        }
        const found = findUserByUserId(socket.userId);
        if (!found) return;
        let oldSeatNumber = null;
        room.seats.forEach((s, i) => { if (s && s.userId === socket.userId) { oldSeatNumber = i + 1; room.seats[i] = null; } });
        room.seats[seatNumber - 1] = { userId: found.user.userId, socketId: socket.id, userName: found.user.name, userPhoto: found.user.photo || "", activeFrame: found.user.activeFrame || null, vipLevel: found.user.vipLevel || 0, customTag: found.user.customTag || null };
        io.to(roomId).emit("seat-update", {
            action: "take", seatNumber, oldSeatNumber,
            userId: found.user.userId, socketId: socket.id,
            userName: found.user.name, userPhoto: found.user.photo || "",
            activeFrame: found.user.activeFrame || null, vipLevel: found.user.vipLevel || 0,
            customTag: found.user.customTag || null,
            role: roleForUser(room, found.user.userId)
        });
    });

    socket.on("send-message", ({ roomId, message }) => {
        const room = rooms[roomId];
        if (!room || !message || !message.trim() || !socket.userId) return;
        const found = findUserByUserId(socket.userId);
        if (!found) return;
        // AI Security + Moderator: only acts on abuse patterns (message
        // flood, repeated-character spam, link floods, duplicate spam) —
        // normal chat is completely unaffected and nothing is logged for it.
        if (aiSecurity.isRateLimited(`chat:${socket.userId}`, { windowMs: 10000, max: 12 })) return;
        aiModerator.evaluate(socket.userId, message);
        const msg = { userId: found.user.userId, userName: found.user.name, customTag: found.user.customTag || null, message: message.trim().slice(0, 500), time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) };
        room.messages.push(msg);
        if (room.messages.length > 200) room.messages.shift();
        io.to(roomId).emit("new-message", msg);
    });

    socket.on("send-gift", ({ roomId, targetUserId, giftId }) => {
        const room = rooms[roomId];
        if (!room || !socket.userId) return;
        const senderFound = findUserByUserId(socket.userId);
        if (!senderFound) return;
        const gift = GIFT_CATALOG.find((g) => g.id === giftId);
        if (!gift) { socket.emit("room-error", { message: "গিফট পাওয়া যায়নি" }); return; }
        if (senderFound.user.coins < gift.price) { socket.emit("room-error", { message: "পর্যাপ্ত কয়েন নেই" }); return; }
        const targetFound = findUserByUserId(targetUserId);
        if (!targetFound) { socket.emit("room-error", { message: "ইউজার পাওয়া যায়নি" }); return; }

        senderFound.user.coins -= gift.price;
        senderFound.user.level = levelFromCoins(senderFound.user.coins);
        // Changed on request: gift recipients now earn coins, not diamonds.
        targetFound.user.coins = (targetFound.user.coins || 0) + gift.price;
        targetFound.user.level = levelFromCoins(targetFound.user.coins);
        saveUsers();
        pushWalletUpdate(senderFound.user.userId);
        pushWalletUpdate(targetFound.user.userId);
        logTransaction(senderFound.user.userId, "coins", -gift.price, `Sent ${gift.name} to ${targetFound.user.name}`);
        logTransaction(targetFound.user.userId, "coins", gift.price, `Received ${gift.name} from ${senderFound.user.name}`);
        logGift({ fromUserId: senderFound.user.userId, fromName: senderFound.user.name, toUserId: targetFound.user.userId, toName: targetFound.user.name, gift, roomId, time: new Date().toISOString() });
        svip.addWealth(senderFound.user.userId, gift.price, `gift:${gift.id}:${Date.now()}`, "gift_sent");

        io.to(roomId).emit("gift-received", { fromUserId: senderFound.user.userId, fromName: senderFound.user.name, toUserId: targetFound.user.userId, gift });

        const opened = contributeToChest(room, senderFound.user.userId, senderFound.user.name, gift.price);
        io.to(roomId).emit("room-state", publicRoom(room));
        if (opened) {
            opened.forEach((o) => {
                const top = topChestContributors(room.treasureChest, 3);
                const recipients = new Set([room.hostId, ...top.map((c) => c.userId)]);
                recipients.forEach((uid) => applyChestReward(uid, o.reward));
                recipients.forEach((uid) => pushWalletUpdate(uid));
                io.to(roomId).emit("chest-opened", { level: o.level, reward: o.reward, topContributors: top });
            });
        }
    });

    // Video Gift System — spends Coins (changed from Diamonds on request)
    // and, only once the spend succeeds, broadcasts the full-screen video to
    // everyone currently in the room. Broadcasting only on success means a
    // failed/insufficient send never triggers playback for anyone.
    socket.on("send-video-gift", ({ roomId, targetUserId, videoGiftId }) => {
        const room = rooms[roomId];
        if (!room || !socket.userId) return;
        const senderFound = findUserByUserId(socket.userId);
        if (!senderFound) return;
        const gift = videoGiftCatalog.find((g) => g.id === videoGiftId && g.enabled !== false);
        if (!gift) { socket.emit("room-error", { message: "গিফট পাওয়া যায়নি" }); return; }
        if ((senderFound.user.coins || 0) < gift.price) { socket.emit("room-error", { message: "পর্যাপ্ত কয়েন নেই" }); return; }
        const targetFound = targetUserId ? findUserByUserId(targetUserId) : null;

        senderFound.user.coins -= gift.price;
        senderFound.user.level = levelFromCoins(senderFound.user.coins);
        saveUsers();
        pushWalletUpdate(senderFound.user.userId);
        logTransaction(senderFound.user.userId, "coins", -gift.price, `Sent video gift ${gift.name}${targetFound ? ` to ${targetFound.user.name}` : ""}`);
        svip.addWealth(senderFound.user.userId, gift.price, `videogift:${gift.id}:${Date.now()}`, "video_gift_sent");
        logGift({
            fromUserId: senderFound.user.userId, fromName: senderFound.user.name,
            toUserId: targetFound ? targetFound.user.userId : null, toName: targetFound ? targetFound.user.name : null,
            gift: { id: gift.id, name: gift.name, price: gift.price, videoGift: true }, roomId, time: new Date().toISOString()
        });

        // Everyone currently in the room plays it at the same moment; anyone
        // who joins later simply never receives this past event.
        io.to(roomId).emit("video-gift-play", {
            fromUserId: senderFound.user.userId, fromName: senderFound.user.name,
            toUserId: targetFound ? targetFound.user.userId : null, toName: targetFound ? targetFound.user.name : null,
            gift: { id: gift.id, name: gift.name, price: gift.price, videoUrl: gift.videoUrl, thumbnail: gift.thumbnail, duration: gift.duration }
        });

        // Bug fix: video/custom gifts spent coins but, unlike the regular
        // send-gift handler, never called contributeToChest — so this spend
        // never "counted" toward the room's treasure chest / wealth level or
        // the top-contributor ranking. Mirror the same logic used elsewhere.
        const opened = contributeToChest(room, senderFound.user.userId, senderFound.user.name, gift.price);
        io.to(roomId).emit("room-state", publicRoom(room));
        if (opened) {
            opened.forEach((o) => {
                const top = topChestContributors(room.treasureChest, 3);
                const recipients = new Set([room.hostId, ...top.map((c) => c.userId)]);
                recipients.forEach((uid) => applyChestReward(uid, o.reward));
                recipients.forEach((uid) => pushWalletUpdate(uid));
                io.to(roomId).emit("chest-opened", { level: o.level, reward: o.reward, topContributors: top });
            });
        }
    });

    socket.on("music-update", ({ roomId, url, name, playing }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.music = { url, name, playing };
        io.to(roomId).emit("music-update", room.music);
    });

    socket.on("lock-seat", ({ roomId, seatNumber, locked }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.lockedSeats = room.lockedSeats || [];
        if (locked) { if (!room.lockedSeats.includes(seatNumber)) room.lockedSeats.push(seatNumber); }
        else room.lockedSeats = room.lockedSeats.filter((n) => n !== seatNumber);
        io.to(roomId).emit("seat-lock-update", { seatNumber, locked });
    });

    socket.on("update-room-background", ({ roomId, url }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.background = url;
        saveRoomsToDisk();
        io.to(roomId).emit("room-background-update", { url });
    });

    socket.on("update-room-logo", ({ roomId, url }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.logo = url;
        saveRoomsToDisk();
        io.to(roomId).emit("room-logo-update", { url });
        io.emit("room-list", roomListPublic());
    });

    socket.on("clear-chat", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.messages = [];
        const found = findUserByUserId(socket.userId);
        io.to(roomId).emit("chat-cleared", { by: found ? found.user.name : "Admin" });
    });

    socket.on("close-room", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.userId) return;
        io.to(roomId).emit("kicked", { message: "Room বন্ধ করা হয়েছে" });
        const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
        if (socketsInRoom) socketsInRoom.forEach((sid) => { const s = io.sockets.sockets.get(sid); if (s) { s.leave(roomId); s.currentRoom = null; } });
        delete rooms[roomId];
        saveRoomsToDisk();
        io.emit("room-list", roomListPublic());
    });

    socket.on("kick-user", ({ roomId, targetUserId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId) || targetUserId === room.hostId) return;
        const targetSocketId = socketsByUserId[targetUserId];
        handleUserLeaveRoom(roomId, targetUserId, null);
        if (targetSocketId) {
            io.to(targetSocketId).emit("kicked", { message: "তোমাকে রুম থেকে বের করে দেওয়া হয়েছে" });
            const s = io.sockets.sockets.get(targetSocketId);
            if (s) { s.leave(roomId); s.currentRoom = null; }
        }
    });

    socket.on("set-admin", ({ roomId, targetUserId, isAdmin }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.userId) return;
        room.adminIds = room.adminIds || [];
        if (isAdmin) { if (!room.adminIds.includes(targetUserId)) room.adminIds.push(targetUserId); }
        else room.adminIds = room.adminIds.filter((id) => id !== targetUserId);
        saveRoomsToDisk();
        io.to(roomId).emit("room-state", publicRoom(room));
    });

    // ---- Seat-8 room games: sync client-side game balance back to the real wallet ----
    // NOTE: both Food Wheel and Teen Patti resolve their bets in the browser, so this
    // delta is client-reported. We clamp it to a sane range per sync so a single call
    // can't mint unlimited coins; for a hardened production setup the bet/spin/hand
    // outcome should be resolved server-side instead.
    socket.on("game-wheel-sync", ({ roomId, balance, game }) => {
        const found = findUserByUserId(socket.userId);
        if (!found) return;
        balance = Math.max(0, Math.floor(Number(balance) || 0));
        const before = found.user.coins;
        // Cap set above the largest possible single-round win (max chip
        // 1,00,000 x max multiplier 45 = 45,00,000) so a real win is never
        // silently truncated, while still bounding a single sync call.
        const MAX_GAIN_PER_SYNC = 5000000;
        const delta = Math.min(Math.max(balance - before, -before), MAX_GAIN_PER_SYNC);
        found.user.coins = before + delta;
        found.user.level = levelFromCoins(found.user.coins);
        if (delta !== 0) logTransaction(found.user.userId, "coins", delta, `${game || "Food Wheel"} game`);
        saveUsers();
        socket.emit("game-wheel-sync-result", { coins: found.user.coins });
    });

    // ---- Room game (Food Wheel / Teen Patti): opening/closing it is now
    // local to whoever tapped the button only — it no longer broadcasts to
    // (and force-opens on) everyone else's screen in the room. ----
    socket.on("game-toggle", ({ roomId, open, game }) => {
        if (!socket.currentRoom || socket.currentRoom !== roomId || !socket.userId) return;
        // Intentionally not relayed to the rest of the room.
    });

    // ---- Real-time voice activity relay (drives the speaking-ring UI) ----
    socket.on("voice-activity", ({ roomId, speaking }) => {
        if (!socket.currentRoom || socket.currentRoom !== roomId || !socket.userId) return;
        socket.to(roomId).emit("voice-activity", { userId: socket.userId, speaking: !!speaking });
    });

    // ---- WebRTC signaling relay ----
    socket.on("voice-offer", ({ target, offer }) => { io.to(target).emit("voice-offer", { from: socket.id, offer }); });
    socket.on("voice-answer", ({ target, answer }) => { io.to(target).emit("voice-answer", { from: socket.id, answer }); });
    socket.on("voice-candidate", ({ target, candidate }) => { io.to(target).emit("voice-candidate", { from: socket.id, candidate }); });

    socket.on("disconnect", () => {
        if (socket.currentRoom && socket.userId) {
            const uid = socket.userId, rid = socket.currentRoom;
            console.log(`🔌 Disconnect: user ${uid} from room ${rid} (socket ${socket.id}) — starting grace period`);
            pendingDisconnects[uid] = {
                roomId: rid,
                socketId: socket.id,
                timer: setTimeout(() => {
                    // Fix (random logout / room desync): this timer was scheduled by
                    // THIS socket's disconnect. If the user has since reconnected
                    // (e.g. page refresh, brief network drop + auto-reconnect) their
                    // new socket already registered itself in socketsByUserId and
                    // cleared this entry via join-room. If that entry now points at
                    // a *different* socket id, the reconnect simply hasn't reached
                    // the server yet in time to cancel this particular timer (rare
                    // but possible under load) — either way, only actually remove
                    // the user from the room if no newer connection has taken over.
                    if (socketsByUserId[uid] && socketsByUserId[uid] !== socket.id) {
                        console.log(`↩️  Skipping stale leave for user ${uid} — already reconnected on a new socket`);
                        delete pendingDisconnects[uid];
                        return;
                    }
                    console.log(`🚪 Grace period expired: removing user ${uid} from room ${rid}`);
                    handleUserLeaveRoom(rid, uid, socket);
                    delete pendingDisconnects[uid];
                }, 8000) // grace period so a brief network drop doesn't yank the seat
            };
        }
    });
});

// Keep every room's daily chest timer honest even when nobody is gifting.
setInterval(() => {
    Object.values(rooms).forEach((room) => {
        if (!room.treasureChest) return;
        const before = room.treasureChest.resetAt;
        ensureChestFresh(room);
        if (room.treasureChest.resetAt !== before) {
            io.to(room.roomId).emit("room-state", publicRoom(room));
        }
    });
}, 60 * 1000);

// ==================================================
// START SERVER
// ==================================================
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🏓 ${APP_NAME} server running on port ${PORT}`);
    console.log(`   Mobile app:  http://localhost:${PORT}/`);
    console.log(`   Admin panel: http://localhost:${PORT}/admin/`);
    console.log(`   Admin login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
    aiMonitor.start(() => ({
        onlineUsers: Object.keys(socketsByUserId).length,
        activeRooms: Object.keys(rooms).length,
    }));
});
