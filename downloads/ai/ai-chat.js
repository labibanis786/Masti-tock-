// ai/ai-chat.js
// Owns the "PingPong Help" support account: per-user session memory (in
// memory only, resets on server restart — this is intentionally NOT a
// permanent chat log), the system prompt, and the first-open welcome message.
const config = require("./ai-config");
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");
const aiService = require("./ai-service");

const sessions = new Map(); // userId -> [{role:"user"|"assistant", content}]

const SYSTEM_PROMPT = `তুমি "PingPong Help" — PingPong ভয়েস চ্যাট অ্যাপের অফিসিয়াল সাপোর্ট AI অ্যাসিস্ট্যান্ট।

নিয়ম:
- বাংলা, ইংরেজি এবং হিন্দি — তিনটা ভাষাতেই স্বাভাবিকভাবে কথা বলতে পারো। ইউজার যে ভাষায় লেখে, সেই ভাষাতেই জবাব দাও।
- মানুষ সাপোর্ট এজিকিউটিভের মতো স্বাভাবিক, বন্ধুত্বপূর্ণ ভাষায় কথা বলো — রোবটিক/ফরমাল টেমপ্লেট জবাব দেবে না।
- Account, Login, OTP, Password, Wallet, Coins, Diamonds, Recharge, Withdrawal, VIP, Frames, Levels, Rooms, Voice Chat, PK Battle, Gifts, Events, Reports, Community Guidelines, টেকনিক্যাল সমস্যা নিয়ে সাহায্য করবে।
- তুমি কখনোই কারো ওয়ালেট ব্যালেন্স পরিবর্তন করতে পারবে না, কয়েন/ডায়মন্ড ট্রান্সফার করতে পারবে না, কাউকে ব্যান/আনব্যান/ডিলিট করতে পারবে না। এই ধরনের অনুরোধ এলে বলবে যে এটার জন্য অ্যাডমিনের অনুমোদন লাগবে এবং তাদের রিপোর্ট করতে বলবে।
- কারো নির্দিষ্ট ব্যালেন্স, ট্রানজেকশন হিস্ট্রি বা অন্য কোনো ইউজারের ব্যক্তিগত তথ্য তোমার কাছে নেই — অনুমান করে বলবে না, বরং ইউজারকে অ্যাপের Wallet/History সেকশন চেক করতে বলবে।
- উত্তর সংক্ষিপ্ত ও স্পষ্ট রাখবে।`;

function welcomeMessage() {
    return "👋 PingPong-এ স্বাগতম!\nআমি PingPong AI। আমি ২৪/৭ তোমাকে সাহায্য করতে প্রস্তুত।\nAccount, Wallet, Gift, Diamond, Coin, Room, PK Battle, Recharge, Report এবং টেকনিক্যাল সমস্যা নিয়ে আমি সাহায্য করতে পারি।\nআজকে কীভাবে সাহায্য করতে পারি?";
}

function isFirstOpen(userId) {
    return !sessions.has(userId);
}

async function reply(userId, userMessage) {
    if (!sessions.has(userId)) {
        sessions.set(userId, []);
        analytics.increment("totalAiConversations");
    }
    const history = sessions.get(userId);
    history.push({ role: "user", content: userMessage });
    while (history.length > config.MAX_HISTORY_TURNS * 2) history.shift();

    let text;
    try {
        text = await aiService.generateReply(history, SYSTEM_PROMPT);
        analytics.increment("totalAiReplies");
    } catch (err) {
        logger.log({ module: "ai-chat", action: "reply", result: "error", userId, error: err.message });
        text = "দুঃখিত, এই মুহূর্তে আমি সাড়া দিতে পারছি না। একটু পর আবার চেষ্টা করো, অথবা সরাসরি অ্যাডমিনকে রিপোর্ট করো।";
    }
    history.push({ role: "assistant", content: text });
    return text;
}

module.exports = {
    reply,
    welcomeMessage,
    isFirstOpen,
    AI_USER_ID: config.AI_USER_ID,
    AI_NAME: config.AI_NAME,
};
