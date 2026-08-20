import worker from "./worker.mjs";
import { detectIntent } from "./ball-knowledge.mjs";

function yesNo(value) { return value ? "yes" : "no"; }
function safe(value, fallback = "unavailable") {
    if (value === null || value === undefined || value === "") return fallback;
    return String(value).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
}

function debugBlock(question, payload, env = {}) {
    const intent = detectIntent(question || "");
    const lines = ["--- DEBUG ---", "Intent:",
        `model: ${yesNo(intent.model !== false)}`,
        `historical: ${yesNo(intent.historical)}`,
        `recent: ${yesNo(intent.recent)}`];

    for (const item of payload.diagnostics || []) {
        lines.push("", `Player ${safe(item.playerId)}`,
            `providerPlayerId: ${safe(item.providerPlayerId)}`,
            `identityConfidence: ${safe(item.identityConfidence)}`,
            `historical cache: ${safe(item.cache?.historical, "unknown")}`,
            `historical rows: ${Number.isFinite(Number(item.historicalRows)) ? Number(item.historicalRows) : 0}`,
            `recent cache: ${safe(item.cache?.recent, "unknown")}`,
            `recent items: ${Number.isFinite(Number(item.currentItems)) ? Number(item.currentItems) : 0}`,
            `recent stale: ${item.currentStale === null || item.currentStale === undefined ? "unknown" : yesNo(item.currentStale)}`);
    }

    lines.push("",
        `FOOTBALL_DATA_PROVIDER configured: ${yesNo(Boolean(env.FOOTBALL_DATA_PROVIDER))}`,
        `FOOTBALL_DATA_API_KEY configured: ${yesNo(Boolean(env.FOOTBALL_DATA_API_KEY || env.API_FOOTBALL_KEY))}`,
        `FOOTBALL_CONTEXT_PROVIDER configured: ${yesNo(Boolean(env.FOOTBALL_CONTEXT_PROVIDER))}`,
        `answer mode: ${safe(payload.answerMode, "unknown")}`,
        `failures: ${(Array.isArray(payload.failures) && payload.failures.length) ? payload.failures.map(value => safe(value)).join(", ") : "none"}`);
    return lines.join("\n");
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname !== "/api/ball-knowledge" || request.method !== "POST" || env?.BALL_KNOWLEDGE_LOGGING !== "true") {
            return worker.fetch(request, env, ctx);
        }

        let question = "";
        try {
            const body = await request.clone().json();
            question = String(body?.question || "").slice(0, 1000);
        } catch {}

        const response = await worker.fetch(request, env, ctx);
        if (!response.ok) return response;
        const type = response.headers.get("content-type") || "";
        if (!type.includes("application/json")) return response;

        let payload;
        try { payload = await response.clone().json(); } catch { return response; }
        if (!payload || typeof payload !== "object" || typeof payload.answer !== "string") return response;

        payload.answer += `\n\n${debugBlock(question, payload, env)}`;
        const headers = new Headers(response.headers);
        headers.set("content-type", "application/json; charset=utf-8");
        headers.set("cache-control", "no-store");
        return new Response(JSON.stringify(payload), { status: response.status, headers });
    }
};
