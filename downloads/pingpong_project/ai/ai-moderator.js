// ai/ai-moderator.js
// Structural spam heuristics — repeated characters, link floods, and
// identical repeated messages. Intentionally does NOT ship a profanity/slur
// word-list (that's a moderation-policy decision for you to own and curate,
// and hardcoding one here would be guesswork). Flags are logged for the
// admin to review; nothing gets auto-deleted or auto-muted since the app
// doesn't have a mute/ban-message system yet — see README for how to wire
// one up if you want the AI to act on these flags automatically later.
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");

const lastMessageByUser = new Map();

function evaluate(userId, message) {
    const flags = [];
    const trimmed = (message || "").trim();

    if (/(.)\1{9,}/.test(trimmed)) flags.push("repeated-characters");
    const linkCount = (trimmed.match(/https?:\/\//g) || []).length;
    if (linkCount >= 3) flags.push("excessive-links");

    const prev = lastMessageByUser.get(userId);
    if (prev && prev === trimmed && trimmed.length > 5) flags.push("duplicate-message");
    lastMessageByUser.set(userId, trimmed);

    if (flags.length) {
        analytics.increment("totalModerationFlags");
        logger.log({ module: "ai-moderator", action: "flag", result: flags.join(","), userId, message: trimmed.slice(0, 200) });
    }
    return flags;
}

module.exports = { evaluate };
