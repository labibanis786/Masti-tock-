// ai/ai-service.js
// Provider-agnostic layer. ai-chat.js only ever calls generateReply() from
// here — it never talks to Gemini (or any future provider) directly.
const config = require("./ai-config");
const logger = require("./ai-logger");

const providers = {
    gemini: require("./providers/gemini-provider"),
    // Add more providers here later, e.g.: openai: require("./providers/openai-provider"),
};

async function generateReply(messages, systemPrompt) {
    const provider = providers[config.AI_PROVIDER];
    if (!provider) throw new Error(`Unknown AI_PROVIDER "${config.AI_PROVIDER}" — check ai/providers/`);

    const started = Date.now();
    try {
        const text = await provider.generate(messages, systemPrompt);
        logger.log({ module: "ai-service", action: "generate", provider: config.AI_PROVIDER, result: "success", durationMs: Date.now() - started });
        return text;
    } catch (err) {
        logger.log({ module: "ai-service", action: "generate", provider: config.AI_PROVIDER, result: "error", error: err.message, durationMs: Date.now() - started });
        throw err;
    }
}

module.exports = { generateReply };
