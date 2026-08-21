const FPL_BASE = "https://fantasy.premierleague.com/api";
const HISTORY_BASE =
    "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";
const CACHE_SECONDS = 6 * 60 * 60;
import {
    answerWithProvider, dedupeSources, detectIntent, resolvePlayers, retrieveKnowledge,
    scoutAssessment
} from "./ball-knowledge.mjs";

function seasonFor(date = new Date()) {
    const year = date.getUTCFullYear();
    const start = date.getUTCMonth() >= 6 ? year : year - 1;
    return `${start}-${String(start + 1).slice(-2)}`;
}

function previousSeason(season) {
    const start = Number(season.slice(0, 4)) - 1;
    return `${start}-${String(start + 1).slice(-2)}`;
}

function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"' && quoted && text[index + 1] === '"') {
            field += '"'; index += 1;
        } else if (character === '"') quoted = !quoted;
        else if (character === "," && !quoted) { row.push(field); field = ""; }
        else if ((character === "\n" || character === "\r") && !quoted) {
            if (character === "\r" && text[index + 1] === "\n") index += 1;
            row.push(field); field = "";
            if (row.some(value => value !== "")) rows.push(row);
            row = [];
        } else field += character;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const headers = rows.shift() || [];
    return rows.map(values => Object.fromEntries(headers.map((header, index) =>
        [header.replace(/^\uFEFF/, ""), values[index] ?? ""]
    )));
}

function normalizedName(player) {
    return [player.first_name, player.second_name].filter(Boolean).join(" ")
        .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

// Keep this list explicit so the browser receives only stable, projection or
// backtest-relevant history rather than an accidental copy of the whole CSV.
// The prefix fallbacks preserve newly-added official assist/defensive fields
// without requiring the worker to deploy in lockstep with an FPL schema change.
const HISTORICAL_SCORING_FIELDS = [
    "total_points", "points_per_game", "bonus", "bps", "goals_scored",
    "assists", "clean_sheets", "goals_conceded", "yellow_cards", "red_cards",
    "own_goals", "penalties_missed", "penalties_saved", "saves",
    "defensive_contribution", "clearances_blocks_interceptions", "recoveries", "tackles"
];

function historicalScoringFields(player) {
    const fields = {};
    Object.keys(player).forEach(field => {
        if (HISTORICAL_SCORING_FIELDS.includes(field) ||
            field.startsWith("defensive_") ||
            (field.includes("assist") && field !== "expected_assists")) {
            fields[field] = finiteNumber(player[field]);
        }
    });
    return fields;
}

function matchHistoricalPlayers(currentPlayers, historicalPlayers) {
    const byCode = new Map();
    const byId = new Map();
    const byName = new Map();
    historicalPlayers.forEach(player => {
        if (player.code) byCode.set(String(player.code), player);
        if (player.id) byId.set(String(player.id), player);
        const name = normalizedName(player);
        if (name) byName.set(name, byName.has(name) ? null : player);
    });

    return currentPlayers.flatMap(current => {
        let historical = current.code && byCode.get(String(current.code));
        let matchMethod = historical ? "code" : null;
        if (!historical && current.id) {
            const idCandidate = byId.get(String(current.id));
            historical = idCandidate && normalizedName(idCandidate) === normalizedName(current)
                ? idCandidate : null;
            matchMethod = historical ? "id" : null;
        }
        if (!historical) {
            historical = byName.get(normalizedName(current));
            matchMethod = historical ? "name" : null;
        }
        if (!historical || finiteNumber(historical.minutes) <= 0) return [];
        const appearances = finiteNumber(historical.appearances || historical.matches);
        if (appearances <= 0) return [];
        return [{
            id: current.id,
            code: current.code,
            historical_id: finiteNumber(historical.id),
            first_name: historical.first_name || current.first_name || "",
            second_name: historical.second_name || current.second_name || "",
            web_name: historical.web_name || current.web_name || "",
            minutes: finiteNumber(historical.minutes),
            starts: finiteNumber(historical.starts),
            expected_goals: finiteNumber(historical.expected_goals),
            expected_assists: finiteNumber(historical.expected_assists),
            saves: finiteNumber(historical.saves),
            ...historicalScoringFields(historical),
            matches: appearances,
            appearances,
            match_method: matchMethod
        }];
    });
}

function addAppearances(historicalPlayers, gameweeks) {
    const counts = new Map();
    gameweeks.forEach(row => {
        if (finiteNumber(row.minutes) <= 0) return;
        const id = String(row.element || row.id || "");
        if (id) counts.set(id, (counts.get(id) || 0) + 1);
    });
    return historicalPlayers.map(player => ({
        ...player,
        appearances: finiteNumber(player.appearances || player.matches) ||
            (counts.get(String(player.id)) || 0)
    }));
}

async function fetchChecked(url) {
    const response = await fetch(url, { headers: { Accept: "application/json,text/csv" } });
    if (!response.ok) throw new Error(`Upstream ${response.status}: ${url}`);
    return response;
}

async function playerPayload(date = new Date()) {
    const season = seasonFor(date);
    const historySeason = previousSeason(season);
    const bootstrapResponse = await fetchChecked(`${FPL_BASE}/bootstrap-static/`);
    const bootstrap = await bootstrapResponse.json();
    let previousSeasonElements = [];
    let historyError = null;
    try {
        const [historyResponse, gameweekResponse] = await Promise.all([
            fetchChecked(`${HISTORY_BASE}/${historySeason}/players_raw.csv`),
            fetchChecked(`${HISTORY_BASE}/${historySeason}/gws/merged_gw.csv`)
        ]);
        const history = addAppearances(parseCsv(await historyResponse.text()),
            parseCsv(await gameweekResponse.text()));
        previousSeasonElements = matchHistoricalPlayers(bootstrap.elements || [], history);
    } catch (error) {
        // Historical availability must never take down live prices, injuries,
        // transfers or player data. Unmatched players retain the model's
        // documented no-history fallback.
        historyError = error.message;
    }
    return {
        ...bootstrap,
        previous_season_elements: previousSeasonElements,
        previous_season_metadata: {
            season: historySeason,
            matched: previousSeasonElements.length,
            fallback: Math.max(0, (bootstrap.elements || []).length - previousSeasonElements.length),
            error: historyError
        }
    };
}

function jsonResponse(payload, status = 200, cacheControl = `public, max-age=${CACHE_SECONDS}`) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": cacheControl,
            "access-control-allow-origin": "*"
        }
    });
}

function chatPlayer(player, teams) {
    const team = teams.find(item => Number(item.id) === Number(player.team));
    return { id: player.id, code: player.code, first_name: String(player.first_name || ""),
        second_name: String(player.second_name || ""), web_name: String(player.web_name || ""),
        team: player.team, club: team?.name || player.club || "Unknown", element_type: player.element_type,
        date_of_birth: player.date_of_birth || null, nationality: player.nationality || null,
        position: player.position || null };
}

function cleanModel(model = {}) {
    const numeric = key => model[key] !== null && model[key] !== undefined && model[key] !== "" &&
        Number.isFinite(Number(model[key])) ? Number(model[key]) : null;
    return { price: numeric("price"), overall: numeric("overall"), value: numeric("value"),
        projectedPoints: numeric("projectedPoints"), expectedMinutes: numeric("expectedMinutes"),
        availability: String(model.availability || "unknown").slice(0, 200),
        fixture: String(model.fixture || "unavailable").slice(0, 200) };
}

const SAFE_FAILURES = new Set(["none", "configuration", "identity_not_found", "identity_ambiguous",
    "auth", "rate_limit", "season", "request", "plan", "malformed", "upstream",
    "partial_provider_failure", "language_provider"]);
function safeFailure(value) {
    const category = String(value || "none").split(":").at(-1);
    return SAFE_FAILURES.has(category) ? category : "upstream";
}
function yesNo(value) { return value === null || value === undefined ? "unknown" : value ? "yes" : "no"; }
function safeProvider(value) { return ["api-football", "custom", "none"].includes(value) ? value : "unavailable"; }
function safeState(value) {
    return ["success", "empty", "failed", "skipped_by_intent", "provider_not_configured", "provider_attempted"]
        .includes(value) ? value : "unavailable";
}
function safeId(value) { return value === null || value === undefined ? "unavailable" :
    String(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unavailable"; }
function safeErrorKeys(values) { return (Array.isArray(values) ? values : []).map(value =>
    String(value).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40)).filter(Boolean).slice(0, 8); }
function safeProviderMessage(value) { return value ? String(value).replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/((?:bearer|authorization))\s*[:=]?\s*[^\s,;]+/gi, "$1 [redacted]")
    .replace(/((?:api[-_ ]?key|token))\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 160) : "unavailable"; }

function debugBlock(diagnostics, answerMode, failures) {
    const lines = ["--- DEBUG ---"];
    diagnostics.forEach((item, index) => {
        const historical = item.providerAttempts?.historical || {};
        const recent = item.providerAttempts?.recent || {};
        lines.push(`Player ${index + 1}: ${safeId(item.playerId)}`,
            "Detected intent:", `- model: ${yesNo(item.intent?.model)}`,
            `- historical: ${yesNo(item.intent?.historical)}`, `- recent: ${yesNo(item.intent?.recent)}`,
            "Historical retrieval:", `- requested: ${yesNo(historical.requested)}`,
            `- cache: ${["hit", "miss", "skipped", "not_configured"].includes(item.cache?.historical) ? item.cache.historical : "unknown"}`,
            `- provider selection attempted: ${yesNo(historical.providerSelectionAttempted)}`,
            `- provider: ${safeProvider(historical.provider)}`, `- provider configured: ${yesNo(historical.providerConfigured)}`,
            `- identity lookup attempted: ${yesNo(historical.identityLookupAttempted)}`,
            `- identity lookup request completed: ${yesNo(historical.identityLookupRequestCompleted)}`,
            `- identity matched: ${yesNo(item.historicalIdentityMatched)}`,
            `- provider player ID: ${safeId(item.historicalProviderPlayerId)}`,
            `- identity confidence: ${["High", "Medium", "Low", "Unavailable"].includes(item.identityConfidence) ? item.identityConfidence : "Unavailable"}`,
            `- historical rows returned: ${Number.isInteger(item.historicalRows) ? item.historicalRows : 0}`,
            `- history depth requested: ${Number.isInteger(item.historyDepthRequested) ? item.historyDepthRequested : 0}`,
            `- history seasons successfully returned: ${Array.isArray(item.historySeasonsReturned) ? item.historySeasonsReturned.join(", ") || "none" : "none"}`,
            `- partial result: ${yesNo(item.historicalPartial)}`,
            `- status: ${safeState(historical.state)}`,
            `- failure category: ${historical.failureCategory ? safeFailure(historical.failureCategory) : "none"}`,
            `- provider error keys: ${safeErrorKeys(historical.providerErrorKeys).join(", ") || "none"}`,
            `- provider message: ${safeProviderMessage(historical.providerMessage)}`,
            "Recent retrieval:", `- requested: ${yesNo(recent.requested)}`,
            `- cache: ${["hit", "miss", "skipped", "not_configured"].includes(item.cache?.recent) ? item.cache.recent : "unknown"}`,
            `- provider selection attempted: ${yesNo(recent.providerSelectionAttempted)}`,
            `- provider: ${safeProvider(recent.provider)}`, `- provider configured: ${yesNo(recent.providerConfigured)}`,
            `- identity lookup attempted: ${yesNo(recent.identityLookupAttempted)}`,
            `- identity lookup request completed: ${yesNo(recent.identityLookupRequestCompleted)}`,
            `- identity matched: ${yesNo(item.recentIdentityMatched)}`,
            `- provider player ID: ${safeId(item.recentProviderPlayerId)}`,
            `- items returned: ${Number.isInteger(item.currentItems) ? item.currentItems : 0}`,
            `- stale: ${yesNo(item.currentStale)}`, `- status: ${safeState(recent.state)}`,
            `- failure category: ${recent.failureCategory ? safeFailure(recent.failureCategory) : "none"}`,
            `- provider error keys: ${safeErrorKeys(recent.providerErrorKeys).join(", ") || "none"}`,
            `- provider message: ${safeProviderMessage(recent.providerMessage)}`);
        lines.push("API-Football request metrics:",
            `- total calls attempted: ${item.providerMetrics?.callsAttempted || 0}`,
            `- calls served from cache: ${item.providerMetrics?.callsFromCache || 0}`,
            `- calls coalesced: ${item.providerMetrics?.callsCoalesced || 0}`,
            `- calls rate-limited: ${item.providerMetrics?.callsRateLimited || 0}`);
    });
    const safeFailures = [...new Set((failures || []).map(safeFailure).filter(value => value !== "none"))];
    lines.push("Answer mode:", `- ${answerMode === "llm" ? "LLM" : "fallback"}`,
        `Total safe failure categories: ${safeFailures.length}${safeFailures.length ? ` (${safeFailures.join(", ")})` : ""}`,
        "--- END DEBUG ---");
    return lines.join("\n");
}

async function handleChat(request, env) {
    const startedAt = Date.now();
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    const question = String(body.question || "").trim().slice(0, 1000);
    const livePlayers = Array.isArray(body.players) ? body.players.slice(0, 750) : [];
    const teams = Array.isArray(body.teams) ? body.teams : [];
    if (!question || !livePlayers.length) return jsonResponse({ error: "Question and live player context are required" }, 400);
    const result = resolvePlayers(question, livePlayers, Array.isArray(body.contextPlayerIds) ? body.contextPlayerIds : []);
    if (result.status === "not_found") return jsonResponse({ error: "Player not found", code: "PLAYER_NOT_FOUND" }, 404);
    if (result.status === "ambiguous") return jsonResponse({ error: "Which player did you mean?", code: "AMBIGUOUS_PLAYER",
        candidates: result.players.map(player => `${player.first_name} ${player.second_name}`) }, 409);
    const intent = detectIntent(question);
    const contexts = [];
    for (const raw of result.players) {
        const player = chatPlayer(raw, teams);
        const model = cleanModel(body.modelById?.[raw.id]);
        const knowledge = await retrieveKnowledge(player, intent, env || {});
        const scout = scoutAssessment(model, knowledge.historical, knowledge.recent);
        contexts.push({ player: { ...player, name: `${player.first_name} ${player.second_name}`.trim(),
            position: { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" }[player.element_type] || "Unknown" },
        model, knowledge, scout });
    }
    let answer;
    let answerMode = env?.LLM_API_URL && env?.LLM_API_KEY ? "llm" : "fallback";
    try { answer = await answerWithProvider(question, contexts, env || {}); }
    catch { answer = await answerWithProvider(question, contexts, {}); answerMode = "fallback"; contexts[0].knowledge.failures.push("language_provider"); }
    const sources = dedupeSources(contexts.flatMap(context => [
        ...(context.knowledge.historical?.sources || []), ...(context.knowledge.recent?.sources || [])
    ]));
    const diagnostics = contexts.map(context => {
        const metrics = [context.knowledge.historical?.metrics, context.knowledge.recent?.metrics,
            context.knowledge.attempts?.historical?.providerMetrics,
            context.knowledge.attempts?.recent?.providerMetrics].filter(Boolean);
        const providerMetrics = metrics.reduce((total, item) => ({ callsAttempted: total.callsAttempted + (item.callsAttempted || 0),
            callsFromCache: total.callsFromCache + (item.callsFromCache || 0),
            callsCoalesced: total.callsCoalesced + (item.callsCoalesced || 0),
            callsRateLimited: total.callsRateLimited + (item.callsRateLimited || 0) }),
        { callsAttempted: 0, callsFromCache: 0, callsCoalesced: 0, callsRateLimited: 0 });
        return { playerId: context.player.id, intent,
        providerPlayerId: context.knowledge.historical?.providerPlayerId || context.knowledge.recent?.identity?.providerPlayerId || null,
        historicalProviderPlayerId: context.knowledge.historical?.providerPlayerId || null,
        recentProviderPlayerId: context.knowledge.recent?.identity?.providerPlayerId || null,
        historicalIdentityMatched: context.knowledge.historical?.identity?.status === "matched",
        recentIdentityMatched: Boolean(context.knowledge.recent?.identity?.providerPlayerId),
        identityConfidence: context.knowledge.historical?.identity?.confidence || context.knowledge.recent?.identity?.confidence || "Unavailable",
        historicalRows: context.knowledge.historical?.seasons?.length || 0,
        historyDepthRequested: context.knowledge.historical?.historyDepthRequested || intent.historyDepth || 0,
        historySeasonsReturned: context.knowledge.historical?.historySeasonsReturned || [],
        historicalPartial: context.knowledge.historical?.partial || false,
        currentItems: context.knowledge.recent?.items?.length || 0, currentAsOf: context.knowledge.recent?.asOf || null,
        currentStale: context.knowledge.recent?.stale ?? null, cache: context.knowledge.cache,
        providerAttempts: context.knowledge.attempts, providerMetrics };
    });
    if (env?.BALL_KNOWLEDGE_LOGGING === "true") console.info("ball-knowledge", JSON.stringify({
        players: diagnostics.map(item => ({ playerId: item.playerId, providerPlayerId: item.providerPlayerId,
            identityConfidence: item.identityConfidence, intent: item.intent, cache: item.cache,
            providerAttempts: item.providerAttempts })), answerMode,
        failures: contexts.flatMap(c => c.knowledge.failures), latencyMs: Date.now() - startedAt }));
    const safeFailures = contexts.flatMap(c => c.knowledge.failures);
    if (env?.BALL_KNOWLEDGE_LOGGING === "true") answer += `\n\n${debugBlock(diagnostics, answerMode, safeFailures)}`;
    return jsonResponse({ answer, answerMode, players: contexts.map(context => ({ id: context.player.id,
        name: context.player.name, model: context.model, scout: context.scout })), diagnostics, sources,
        failures: safeFailures }, 200, "no-store");
}

async function handleRequest(request, env = {}) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "GET, POST, OPTIONS",
                "access-control-allow-headers": "content-type"
            }
        });
    }
    if (url.pathname === "/api/ball-knowledge" && request.method === "POST") return handleChat(request, env);
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    if (url.pathname === "/api/fixtures") {
        const response = await fetchChecked(`${FPL_BASE}/fixtures/`);
        return jsonResponse(await response.json());
    }
    if (url.pathname !== "/api/players") return jsonResponse({ error: "Not found" }, 404);

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(url.toString(), request);
    const cached = cache && await cache.match(cacheKey);
    if (cached) return cached;
    try {
        const response = jsonResponse(await playerPayload());
        if (cache) await cache.put(cacheKey, response.clone());
        return response;
    } catch (error) {
        return jsonResponse({ error: "Player data unavailable", detail: error.message }, 502);
    }
}

export default { fetch: handleRequest };
export { addAppearances, cleanModel, debugBlock, handleRequest, matchHistoricalPlayers, parseCsv, playerPayload, previousSeason, seasonFor };
