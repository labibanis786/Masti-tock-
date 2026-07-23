// ai/ai-dashboard.js
// Exports a function that takes the existing requireAdmin middleware (from
// server.js) and returns an Express router — kept REST-only/poll-based to
// match how the rest of the admin panel already works (no socket.io there).
const express = require("express");
const monitor = require("./ai-monitor");
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");
const config = require("./ai-config");

module.exports = function buildAiDashboardRouter(requireAdmin) {
    const router = express.Router();

    router.get("/status", requireAdmin, (req, res) => {
        res.json({
            success: true,
            status: monitor.getStatus(),
            provider: config.AI_PROVIDER,
            model: config.GEMINI_MODEL,
            apiKeyConfigured: !!config.GEMINI_API_KEY,
        });
    });

    router.get("/monitor/history", requireAdmin, (req, res) => {
        res.json({ success: true, history: monitor.getHistory() });
    });

    router.get("/logs", requireAdmin, (req, res) => {
        const limit = Math.min(500, Number(req.query.limit) || 100);
        res.json({ success: true, logs: logger.readRecent(limit) });
    });

    router.get("/analytics", requireAdmin, (req, res) => {
        res.json({ success: true, stats: analytics.getStats() });
    });

    return router;
};
