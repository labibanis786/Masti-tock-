// ai/ai-analytics.js
// Simple counters other ai/ modules bump. Resets on server restart — if you
// want these to survive restarts, swap the in-memory object for a read/write
// through ai-logger's DATA_FOLDER the same way server.js persists users.json.
let stats = {
    totalAiConversations: 0,
    totalAiReplies: 0,
    totalModerationFlags: 0,
    totalRateLimitHits: 0,
};

function increment(key, by = 1) {
    stats[key] = (stats[key] || 0) + by;
}

function getStats() {
    return { ...stats };
}

module.exports = { increment, getStats };
