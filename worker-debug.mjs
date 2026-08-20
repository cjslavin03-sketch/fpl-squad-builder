import worker from "./worker.mjs";
import { detectIntent } from "./ball-knowledge.mjs";

function yesNo(value) { return value ? "yes" : "no"; }
function safe(value, fallback = "unavailable") {
    if (value === null || value === undefined || value === "") return fallback;
    return String(value).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
}
function sanitizeMessage(value) {
    return String(value || "")
        .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer_[redacted]")
        .replace(/(api[_ -]?key|token|authorization)\s*[:=]\s*\S+/gi, "$1_[redacted]")
        .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 160);
}
function classifyProviderErrors(errors) {
    const entries = Array.isArray(errors)
        ? errors.map((value, index) => [String(index), value])
        : Object.entries(errors || {});
    const keys = entries.map(([key]) => safe(String(key).toLowerCase(), "unknown")).slice(0, 8);
    const message = sanitizeMessage(entries.map(([, value]) => typeof value === "string" ? value : JSON.stringify(value)).join(" | "));
    const signal = `${keys.join(" ")} ${message}`.toLowerCase();
    let category = "upstream";
    if (/token|api.?key|auth|unauthor/.test(signal)) category = "auth";
    else if (/requests?|rate.?limit|quota|too.?many/.test(signal)) category = "rate_limit";
    else if (/season/.test(signal)) category = "season";
    else if (/plan|subscription|permission|access/.test(signal)) category = "plan";
    else if (/player|search|parameter|invalid.?request/.test(signal)) category = "request";
    return { category, keys, message: message || "unavailable" };
}

async function providerProbe(env = {}) {
    const key = env.FOOTBALL_DATA_API_KEY || env.API_FOOTBALL_KEY;
    if (!key) return { attempted: false, category: "configuration", status: null, keys: [], message: "API key unavailable" };
    try {
        const url = new URL("https://v3.football.api-sports.io/players");
        url.searchParams.set("search", "Christos Tzolis");
        url.searchParams.set("season", "2026");
        const response = await fetch(url, { headers: { Accept: "application/json", "x-apisports-key": key } });
        let body = null;
        try { body = await response.json(); } catch {}
        if (!response.ok) {
            const category = response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate_limit" : "upstream";
            return { attempted: true, category, status: response.status, keys: [], message: `HTTP ${response.status}` };
        }
        if (body?.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length)) {
            const classified = classifyProviderErrors(body.errors);
            return { attempted: true, status: response.status, ...classified };
        }
        if (!body || !Array.isArray(body.response)) return { attempted: true, category: "malformed", status: response.status, keys: [], message: "Missing response array" };
        return { attempted: true, category: body.response.length ? "success" : "empty", status: response.status, keys: [], message: `${body.response.length} player matches` };
    } catch (error) {
        return { attempted: true, category: "network", status: null, keys: [], message: sanitizeMessage(error?.message || "fetch failed") };
    }
}

function debugBlock(question, payload, env = {}, probe = null) {
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
    if (probe) {
        lines.push("", "Direct API-Football probe:",
            `attempted: ${yesNo(probe.attempted)}`,
            `status: ${probe.status ?? "unavailable"}`,
            `category: ${safe(probe.category, "unknown")}`,
            `error keys: ${probe.keys?.length ? probe.keys.map(value => safe(value)).join(",") : "none"}`,
            `message: ${sanitizeMessage(probe.message) || "unavailable"}`);
    }
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

        const hasUpstreamFailure = Array.isArray(payload.failures) && payload.failures.some(value => /upstream/.test(String(value)));
        const probe = hasUpstreamFailure ? await providerProbe(env) : null;
        payload.answer += `\n\n${debugBlock(question, payload, env, probe)}`;
        const headers = new Headers(response.headers);
        headers.set("content-type", "application/json; charset=utf-8");
        headers.set("cache-control", "no-store");
        return new Response(JSON.stringify(payload), { status: response.status, headers });
    }
};
