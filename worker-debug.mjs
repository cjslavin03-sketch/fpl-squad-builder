import worker from "./worker.mjs";
import { detectIntent } from "./ball-knowledge.mjs";

const nativeFetch = globalThis.fetch.bind(globalThis);
const apiCache = new Map();
const apiInflight = new Map();
let apiQueue = Promise.resolve();
let lastApiStartedAt = 0;
let rateLimitUntil = 0;
let minIntervalMs = 1000;
let cooldownMs = 90000;
const metrics = { attempted: 0, upstream: 0, cacheHits: 0, coalesced: 0, synthetic: 0, rateLimited: 0 };

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
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isApiFootball(url) {
    try { return new URL(url instanceof Request ? url.url : String(url)).hostname === "v3.football.api-sports.io"; }
    catch { return false; }
}
function apiTtl(url) {
    const u = new URL(url instanceof Request ? url.url : String(url));
    if (u.pathname === "/transfers") return 6 * 60 * 60 * 1000;
    if (u.pathname === "/injuries") return 45 * 60 * 1000;
    if (u.pathname === "/players" && u.searchParams.has("id") && u.searchParams.has("season")) return 30 * 24 * 60 * 60 * 1000;
    if (u.pathname === "/players" && u.searchParams.has("search")) return 7 * 24 * 60 * 60 * 1000;
    return 30 * 60 * 1000;
}
function snapshotResponse(response, bodyText) {
    return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], bodyText };
}
function restoreResponse(snapshot) {
    return new Response(snapshot.bodyText, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers });
}
function structuredRateLimit(bodyText) {
    try {
        const body = JSON.parse(bodyText);
        const errors = body?.errors;
        if (!errors) return false;
        const signal = JSON.stringify(errors).toLowerCase();
        return /ratelimit|rate.?limit|too many requests|quota|request limit/.test(signal);
    } catch { return false; }
}
function syntheticSeasonResponse() {
    const now = new Date();
    const current = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    const body = JSON.stringify({ get: "players/seasons", parameters: {}, errors: [], results: 2, paging: { current: 1, total: 1 }, response: [current - 1, current - 2] });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}
async function queuedNativeFetch(input, init) {
    const run = async () => {
        const wait = Math.max(0, minIntervalMs - (Date.now() - lastApiStartedAt));
        if (wait) await sleep(wait);
        lastApiStartedAt = Date.now();
        metrics.upstream += 1;
        const response = await nativeFetch(input, init);
        const bodyText = await response.clone().text();
        if (response.status === 429 || structuredRateLimit(bodyText)) {
            rateLimitUntil = Date.now() + cooldownMs;
            metrics.rateLimited += 1;
        }
        return { response, bodyText };
    };
    const result = apiQueue.then(run, run);
    apiQueue = result.then(() => undefined, () => undefined);
    return result;
}
async function freeTierFetch(input, init) {
    if (!isApiFootball(input)) return nativeFetch(input, init);
    metrics.attempted += 1;
    const u = new URL(input instanceof Request ? input.url : String(input));

    // The normal history path only needs the recent completed seasons. Avoid spending
    // one API call just to discover them on every cold player query.
    if (u.pathname === "/players/seasons") {
        metrics.synthetic += 1;
        return syntheticSeasonResponse();
    }

    const key = `${(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()} ${u.toString()}`;
    const cached = apiCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
        metrics.cacheHits += 1;
        return restoreResponse(cached.snapshot);
    }
    if (apiInflight.has(key)) {
        metrics.coalesced += 1;
        const snap = await apiInflight.get(key);
        return restoreResponse(snap);
    }
    if (Date.now() < rateLimitUntil) {
        metrics.rateLimited += 1;
        return new Response(JSON.stringify({ errors: { ratelimit: "API-Football cooldown active; retry shortly" }, response: [] }),
            { status: 200, headers: { "content-type": "application/json" } });
    }

    const promise = (async () => {
        const { response, bodyText } = await queuedNativeFetch(input, init);
        const snap = snapshotResponse(response, bodyText);
        if (response.ok && !structuredRateLimit(bodyText)) {
            try {
                const body = JSON.parse(bodyText);
                const hasErrors = body?.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length);
                if (!hasErrors) apiCache.set(key, { expiresAt: Date.now() + apiTtl(input), snapshot: snap });
            } catch {}
        }
        return snap;
    })();
    apiInflight.set(key, promise);
    try { return restoreResponse(await promise); }
    finally { apiInflight.delete(key); }
}

// Provider modules use the global fetch at request time, so this transparently adds
// free-tier scheduling/caching without changing the projection or optimizer code.
globalThis.fetch = freeTierFetch;

function metricSnapshot() { return { ...metrics }; }
function metricDelta(before) {
    const out = {}; for (const key of Object.keys(metrics)) out[key] = metrics[key] - (before[key] || 0); return out;
}

function debugBlock(question, payload, env = {}, delta = {}) {
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
        `failures: ${(Array.isArray(payload.failures) && payload.failures.length) ? payload.failures.map(value => safe(value)).join(", ") : "none"}`,
        "", "Free-tier API metrics:",
        `API calls requested: ${delta.attempted || 0}`,
        `actual upstream calls: ${delta.upstream || 0}`,
        `cache hits: ${delta.cacheHits || 0}`,
        `coalesced calls: ${delta.coalesced || 0}`,
        `season-list calls avoided: ${delta.synthetic || 0}`,
        `rate-limited/cooldown calls: ${delta.rateLimited || 0}`,
        `minimum spacing ms: ${minIntervalMs}`,
        `cooldown active: ${yesNo(Date.now() < rateLimitUntil)}`);
    return lines.join("\n");
}

export default {
    async fetch(request, env, ctx) {
        minIntervalMs = Math.max(250, Number(env?.FOOTBALL_API_MIN_INTERVAL_MS) || 1000);
        cooldownMs = Math.max(30000, Number(env?.FOOTBALL_API_RATE_LIMIT_COOLDOWN_MS) || 90000);
        const before = metricSnapshot();
        const url = new URL(request.url);
        const logging = env?.BALL_KNOWLEDGE_LOGGING === "true";
        if (url.pathname !== "/api/ball-knowledge" || request.method !== "POST" || !logging) {
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

        payload.answer += `\n\n${debugBlock(question, payload, env, metricDelta(before))}`;
        const headers = new Headers(response.headers);
        headers.set("content-type", "application/json; charset=utf-8");
        headers.set("cache-control", "no-store");
        return new Response(JSON.stringify(payload), { status: response.status, headers });
    }
};
