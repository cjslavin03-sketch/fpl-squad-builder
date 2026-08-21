import assert from "node:assert/strict";
import { apiFootballHistory, apiFootballRecent, detectConflicts, fetchHistorical, fetchRecent,
    matchProviderIdentity, newsApiContext, newsRelevance, ProviderError, providerSelection,
    sanitizeProviderMessage, seasonStartYear } from "./football-providers.mjs";
import { buildEvidence, clearKnowledgeCache, normalizeHistorical, retrieveKnowledge } from "./ball-knowledge.mjs";

const tzolis = { id: 1, code: 101, first_name: "Christos", second_name: "Tzolis",
    club: "Arsenal", nationality: "Greece", position: "MID", date_of_birth: "2002-01-30" };
const env = { FOOTBALL_DATA_PROVIDER: "api-football", FOOTBALL_CONTEXT_PROVIDER: "api-football",
    FOOTBALL_DATA_API_KEY: "server-secret", FOOTBALL_CURRENT_SEASON: "2026", FOOTBALL_HISTORY_SEASONS: "2",
    FOOTBALL_API_MIN_INTERVAL_MS: "0", FOOTBALL_API_RATE_LIMIT_COOLDOWN_MS: "1000" };
const now = Date.parse("2026-08-20T00:00:00Z");

assert.deepEqual(providerSelection({}, "historical"), { name: "api-football", configured: false });
assert.equal(providerSelection(env, "historical").configured, true);
assert.equal(providerSelection({ FOOTBALL_DATA_URL: "https://adapter.test" }, "historical").name, "custom");
assert.equal(seasonStartYear(new Date("2026-08-20T00:00:00Z")), 2026, "2026/27 uses season start 2026");
assert.equal(seasonStartYear(new Date("2027-05-20T00:00:00Z")), 2026);

const candidates = [{ player: { id: 9, name: "Christos Tzolis", firstname: "Christos", lastname: "Tzolis",
    birth: { date: "2002-01-30" }, nationality: "Greece" }, statistics: [{ team: { name: "Arsenal" }, games: { position: "Midfielder" } }] }];
const identity = matchProviderIdentity(candidates, tzolis);
assert.equal(identity.status, "matched"); assert.equal(identity.confidence, "High");
const common = matchProviderIdentity([
    { player: { id: 1, name: "Alex Smith" }, statistics: [] },
    { player: { id: 2, name: "Alex Smith" }, statistics: [] }
], { first_name: "Alex", second_name: "Smith" });
assert.equal(common.status, "ambiguous", "common names are never silently attached");
assert.doesNotMatch(sanitizeProviderMessage("Invalid API key SUPER_SECRET_PROVIDER_TOKEN", ["SUPER_SECRET_PROVIDER_TOKEN"]),
    /SUPER_SECRET_PROVIDER_TOKEN/);

const originalFetch = globalThis.fetch;
let calls = [];
const playerRecord = { player: candidates[0].player, statistics: candidates[0].statistics };
globalThis.fetch = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(options.headers["x-apisports-key"], "server-secret", "key remains in server-side header");
    if (url.pathname.endsWith("/players/seasons")) return Response.json({ response: [2024, 2025] });
    if (url.pathname.endsWith("/players") && url.searchParams.has("search")) return Response.json({ response: [playerRecord] });
    if (url.pathname.endsWith("/players")) {
        const season = url.searchParams.get("season");
        return Response.json({ response: [{ ...playerRecord, statistics: [{ team: { name: season === "2025" ? "Club Brugge" : "Fortuna Düsseldorf" },
            league: { name: season === "2025" ? "First Division A" : "2. Bundesliga", type: "League", country: season === "2025" ? "Belgium" : "Germany" },
            games: { appearences: 30, lineups: 27, minutes: 2400, position: "Midfielder", rating: "7.10" },
            goals: { total: 14, assists: 8, saves: null, conceded: null }, shots: { total: 80, on: 38 },
            passes: { total: 850, key: 49, accuracy: 81 }, tackles: { total: 21, blocks: 2, interceptions: 9 },
            duels: { total: 250, won: 122 }, dribbles: { attempts: 110, success: 57 }, cards: { yellow: 3, red: 0 }
        }] }] });
    }
    if (url.pathname.endsWith("/transfers")) return Response.json({ response: [{ transfers: [{ date: "2026-07-01",
        type: "Permanent", teams: { out: { name: "Club Brugge" }, in: { name: "Arsenal" } } }] }] });
    if (url.pathname.endsWith("/injuries")) {
        assert.equal(url.searchParams.get("season"), "2026", "injury contract requires the current season");
        return Response.json({ response: [] });
    }
    return new Response("missing", { status: 404 });
};

try {
    const history = await apiFootballHistory(tzolis, env);
    assert.equal(history.seasons.length, 2); assert.equal(history.seasons[0].country, "Belgium");
    assert.equal(history.seasons[0].shotsOnTarget, 38); assert.equal(history.seasons[0].xG, null);
    assert.equal(history.identity.confidence, "High"); assert.ok(history.sources[0].supports.includes("career"));
    const recent = await apiFootballRecent(tzolis, env, Date.parse("2026-08-20T00:00:00Z"));
    assert.match(recent.items[0].summary, /Club Brugge to Arsenal/); assert.equal(recent.items[0].date, "2026-07-01");
    const normalized = normalizeHistorical(history);
    const evidence = buildEvidence({ player: tzolis, model: { overall: 64, projectedPoints: 3.4 },
        scout: { rating: 78, confidence: "Medium", disagreement: "positive" },
        knowledge: { historical: normalized, recent: { ...recent, stale: false }, failures: [] } });
    assert.equal(evidence.modelView.overall, 64); assert.equal(evidence.recentSeasons.length, 2);
    assert.ok(evidence.competitionContext.some(value => value.includes("Belgium")));
    assert.ok(evidence.sources[0].supports.includes("season-statistics"));
} finally { globalThis.fetch = originalFetch; }

clearKnowledgeCache();
globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === "newsapi.org") return new Response("quota", { status: 429 });
    if (url.pathname.endsWith("/players")) return Response.json({ response: [playerRecord] });
    if (url.pathname.endsWith("/transfers")) return Response.json({ response: [] });
    if (url.pathname.endsWith("/injuries")) return Response.json({ response: [] });
    return new Response("missing", { status: 404 });
};
try {
    const partial = await fetchRecent(tzolis, { ...env, FOOTBALL_CONTEXT_API_KEY: "news-key" }, now);
    assert.deepEqual(partial.providerFailures, ["news:rate_limit"], "NewsAPI failure preserves structured recent data");
    assert.equal(partial.provider, "api-football");
} finally { globalThis.fetch = originalFetch; }

assert.equal(detectConflicts([{ kind: "injury", summary: "Player is out" },
    { kind: "availability", summary: "Player returned and is fit" }]).length, 1);

const defenderEvidence = buildEvidence({ player: { name: "Established Defender", position: "DEF" }, model: {}, scout: { confidence: "Low" },
    knowledge: { historical: normalizeHistorical({ identity: { confidence: "High" }, seasons: [{ season: "2025",
        club: "A", competition: "Premier League", minutes: 3000, tackles: 65, interceptions: 42, shots: 18 }] }), recent: null, failures: [] } });
assert.equal(defenderEvidence.advancedStats[0].tackles, 65);
const goalkeeperEvidence = buildEvidence({ player: { name: "Established Goalkeeper", position: "GK" }, model: {}, scout: { confidence: "Low" },
    knowledge: { historical: normalizeHistorical({ identity: { confidence: "High" }, seasons: [{ season: "2025",
        club: "B", competition: "Premier League", minutes: 3240, saves: 112, savePercentage: 73.2, postShotXG: null }] }), recent: null, failures: [] } });
assert.equal(goalkeeperEvidence.advancedStats[0].saves, 112); assert.equal(goalkeeperEvidence.advancedStats[0].postShotXG, null);
const obscureEvidence = buildEvidence({ player: { name: "Budget Player", position: "MID" }, model: { overall: 42 },
    scout: { rating: null, confidence: "Low", disagreement: "unknown" }, knowledge: { historical: null, recent: null, failures: ["historical:identity_not_found"] } });
assert.equal(obscureEvidence.confidence.historicalAvailable, false); assert.equal(obscureEvidence.modelView.overall, 42);

const relevantArticle = { title: "Christos Tzolis discusses Arsenal starting role", description: "The winger featured in preseason football",
    url: "https://www.arsenal.com/news/tzolis-role", publishedAt: "2026-08-19T10:00:00Z", source: { name: "Arsenal" } };
const seoArticle = { title: "Tzolis facts and net worth", description: "Celebrity profile",
    url: "https://seo.invalid/tzolis", publishedAt: "2026-08-19T10:00:00Z", source: { name: "SEO" } };
assert.ok(newsRelevance(relevantArticle, tzolis, now) >= 45); assert.ok(newsRelevance(seoArticle, tzolis, now) < 45);
globalThis.fetch = async input => {
    const url = new URL(input); assert.match(url.searchParams.get("q"), /Arsenal OR football/);
    assert.equal(url.searchParams.get("from"), "2026-07-21");
    return Response.json({ articles: [relevantArticle, { ...relevantArticle }, seoArticle] });
};
try {
    const news = await newsApiContext(tzolis, { FOOTBALL_CONTEXT_API_KEY: "news-secret" }, now);
    assert.equal(news.items.length, 1, "news is relevant, trusted and deduplicated");
    assert.equal(news.sources[0].url, relevantArticle.url); assert.ok(news.items[0].relevance >= 45);
} finally { globalThis.fetch = originalFetch; }

for (const [status, kind] of [[401, "auth"], [429, "rate_limit"]]) {
    clearKnowledgeCache();
    globalThis.fetch = async () => new Response("", { status });
    try { await assert.rejects(() => fetchHistorical(tzolis, env), error => error instanceof ProviderError && error.kind === kind); }
    finally { globalThis.fetch = originalFetch; }
}

for (const [errors, kind, key] of [
    [{ token: "Invalid API key" }, "auth", "token"],
    [{ requests: "Request limit reached" }, "rate_limit", "requests"],
    [{ season: "The season is not available" }, "season", "season"],
    [{ plan: "This endpoint is not available on your plan" }, "plan", "plan"],
    [{ search: "The player search parameter is invalid" }, "request", "search"],
    [{ mystery: "Provider had an unknown problem" }, "upstream", "mystery"]
]) {
    clearKnowledgeCache(); globalThis.fetch = async () => Response.json({ errors });
    try {
        await assert.rejects(() => apiFootballHistory(tzolis, env), error => error instanceof ProviderError &&
            error.kind === kind && error.providerErrorKeys.includes(key) && error.providerMessage.length <= 160 &&
            error.stage === "identity_lookup" && error.identityLookupCompleted === false);
    } finally { globalThis.fetch = originalFetch; }
}

globalThis.fetch = async () => Response.json({ unexpected: [] });
try { await assert.rejects(() => apiFootballHistory(tzolis, env), error => error.kind === "malformed"); }
finally { globalThis.fetch = originalFetch; }

let modelOnlyCalls = 0; globalThis.fetch = async () => { modelOnlyCalls += 1; throw new Error("must not fetch"); };
try {
    clearKnowledgeCache();
    const modelOnly = await retrieveKnowledge(tzolis, { historical: false, recent: false }, env);
    assert.equal(modelOnlyCalls, 0); assert.equal(modelOnly.historical, null); assert.equal(modelOnly.recent, null);
    assert.deepEqual(modelOnly.cache, { historical: "skipped", recent: "skipped" });
    assert.equal(modelOnly.attempts.historical.state, "skipped_by_intent");
    assert.equal(modelOnly.attempts.recent.providerSelectionAttempted, false);
} finally { globalThis.fetch = originalFetch; }

console.log("football provider tests passed");
