// ==================================================
// Admin Coin Center — Backend Core (additive module)
// ==================================================
// Self-contained, like svip.js — does not modify any existing wallet/gift
// logic. server.js wires this in by calling initCoinCenter({...}) once and
// exposing a few new /api/admin/coin-center/* routes.
//
// Covers the spec:
//   - System coin balance (a virtual pool admins draw from)
//   - Send coins directly to a user, with reason/note
//   - Every transfer logged (own audit log + reuses existing logTransaction
//     so it also shows up in the user's normal wallet history)
//   - User's transaction history shows "Coin Center", never an admin name
//   - Real-time wallet push (reuses existing pushWalletUpdate) + a
//     dedicated real-time notification event
//   - Validation: amount must be a positive integer; rejects if system
//     balance is insufficient
//   - Idempotency: a request with a requestId that was already processed
//     returns the original result instead of crediting twice

const path = require("path");

function initCoinCenter({ DATA_FOLDER, safeRead, safeWrite, io, socketsByUserId, findUserByUserId, saveUsers, users, logTransaction, pushWalletUpdate, levelFromCoins }) {
    const STATE_FILE = path.join(DATA_FOLDER, "coin_center.json");

    const DEFAULT_STATE = {
        systemBalance: 100000000, // placeholder starting pool — adjust via setSystemBalance()
        log: [], // audit log of every send + balance-set admin action
        processedRequests: {} // requestId -> { result, time }  (idempotency cache)
    };

    let state = safeRead(STATE_FILE, DEFAULT_STATE);
    if (typeof state.systemBalance !== "number") state.systemBalance = DEFAULT_STATE.systemBalance;
    if (!Array.isArray(state.log)) state.log = [];
    if (!state.processedRequests || typeof state.processedRequests !== "object") state.processedRequests = {};
    safeWrite(STATE_FILE, state);

    function save() {
        // Idempotency cache doesn't need to grow forever — keep the most
        // recent 2000 entries, which is far more than enough for retry
        // windows in practice.
        const entries = Object.entries(state.processedRequests);
        if (entries.length > 2000) {
            entries.sort((a, b) => new Date(a[1].time) - new Date(b[1].time));
            state.processedRequests = Object.fromEntries(entries.slice(entries.length - 2000));
        }
        if (state.log.length > 10000) state.log = state.log.slice(-10000);
        safeWrite(STATE_FILE, state);
    }

    function getSystemBalance() { return state.systemBalance; }

    function setSystemBalance(amount, adminUsername) {
        const n = Number(amount);
        if (!Number.isFinite(n) || n < 0) return { success: false, message: "সঠিক পরিমাণ দাও" };
        const prev = state.systemBalance;
        state.systemBalance = Math.floor(n);
        state.log.push({ type: "balance_set", adminUsername, prevBalance: prev, newBalance: state.systemBalance, time: new Date().toISOString() });
        save();
        return { success: true, systemBalance: state.systemBalance };
    }

    function findUserByIdOrMobile(query) {
        if (!query) return null;
        const byId = findUserByUserId(String(query).trim());
        if (byId) return byId;
        const mobile = String(query).trim();
        if (users[mobile]) return { mobile, user: users[mobile] };
        return null;
    }

    function emitToUser(userId, event, payload) {
        const sid = socketsByUserId[userId];
        if (sid) io.to(sid).emit(event, payload);
    }

    // Core action: send `amount` coins from the system pool to targetUserId.
    function sendCoins({ targetUserId, amount, reason, adminUsername, requestId }) {
        // ---- Idempotency: replay a previously-processed request instead of
        // crediting twice (covers double-clicks / retried network calls
        // that resend the same requestId). ----
        if (requestId && state.processedRequests[requestId]) {
            return Object.assign({}, state.processedRequests[requestId].result, { replayed: true });
        }

        const n = Number(amount);
        if (!Number.isInteger(n) || n <= 0) {
            const result = { success: false, message: "সঠিক (পূর্ণসংখ্যা, ধনাত্মক) পরিমাণ দাও" };
            if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
            return result;
        }

        const found = findUserByUserId(targetUserId);
        if (!found) {
            const result = { success: false, message: "ইউজার পাওয়া যায়নি" };
            if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
            return result;
        }

        if (state.systemBalance < n) {
            const result = { success: false, message: "System balance অপর্যাপ্ত" };
            if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
            return result;
        }

        // ---- Apply the credit ----
        found.user.coins = (found.user.coins || 0) + n;
        if (typeof levelFromCoins === "function") found.user.level = levelFromCoins(found.user.coins);
        state.systemBalance -= n;
        saveUsers();

        const cleanReason = (reason || "").toString().trim().slice(0, 200);
        // Reuses the existing wallet-transactions mechanism so this shows up
        // in the user's normal transaction history exactly like any other
        // entry — with the source shown as "Coin Center", never the admin's
        // own name/username.
        logTransaction(targetUserId, "coins", n, cleanReason ? `Coin Center: ${cleanReason}` : "Coin Center");

        const entry = {
            id: "cc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            requestId: requestId || null,
            targetUserId,
            targetName: found.user.name,
            amount: n,
            reason: cleanReason,
            adminUsername: adminUsername || "admin",
            systemBalanceAfter: state.systemBalance,
            time: new Date().toISOString()
        };
        state.log.push(entry);

        const result = { success: true, coins: found.user.coins, systemBalance: state.systemBalance, entry };
        if (requestId) state.processedRequests[requestId] = { result, time: new Date().toISOString() };
        save();

        // ---- Real-time push: balance (reuses the app's existing wallet-
        // update mechanism) + a dedicated Coin Center notification. ----
        if (typeof pushWalletUpdate === "function") pushWalletUpdate(targetUserId);
        emitToUser(targetUserId, "coin-center-notification", {
            amount: n,
            reason: cleanReason || null,
            time: entry.time,
            newBalance: found.user.coins
        });

        return result;
    }

    function getLog(limit = 100) {
        return state.log.slice().reverse().slice(0, limit);
    }

    return {
        getSystemBalance,
        setSystemBalance,
        findUserByIdOrMobile,
        sendCoins,
        getLog
    };
}

module.exports = { initCoinCenter };
