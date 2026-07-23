// ai/ai-config.js
// Single place every other ai/ module reads settings from. Nothing outside
// this file should ever read process.env directly for AI settings — that's
// what keeps "swap the provider later" a one-file change (see ai-service.js).
require("dotenv").config();

module.exports = {
    // Identity of the built-in support account. Reserved userId that can
    // never collide with a real mobile-number-based user account.
    AI_USER_ID: "pingpong_ai_help",
    AI_NAME: "PingPong Help",

    // Which provider file (under ai/providers/) to use. To move off Gemini
    // later: add ai/providers/<name>-provider.js exporting the same
    // `generate(messages, systemPrompt)` function, then just change this
    // env var — no other code changes needed anywhere in the app.
    AI_PROVIDER: process.env.AI_PROVIDER || "gemini",

    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-2.0-flash",

    // How many back-and-forth turns of chat history to keep per user session
    // (in memory only — resets on server restart, matching "session-based
    // memory" from the spec, not permanent chat-log memory).
    MAX_HISTORY_TURNS: Number(process.env.AI_MAX_HISTORY_TURNS) || 12,

    // How often the monitoring engine takes a snapshot.
    MONITOR_INTERVAL_MS: Number(process.env.AI_MONITOR_INTERVAL_MS) || 30000,
};
