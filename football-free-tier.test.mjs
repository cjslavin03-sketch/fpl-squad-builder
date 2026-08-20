import assert from "node:assert/strict";
import { apiFootballHistory, apiFootballRecent, clearProviderCache } from "./football-providers.mjs";
import { clearKnowledgeCache, detectIntent, retrieveKnowledge } from "./ball-knowledge.mjs";

const player = { id: 1, code: 101, first_name: "Christos", second_name: "Tzolis",
    club: "Arsenal", nationality: "Greece", position: "MID", date_of_birth: "2002-01-30" };
const env = { FOOTBALL_DATA_API_KEY: "secret", FOOTBALL_CURRENT_SEASON: "2026",
    FOOTBALL_API_MIN_INTERVAL_MS: "0", FOOTBALL_API_RATE_LIMIT_COOLDOWN_MS: "1000" };
const record = { player: { id: 9, name: "Christos Tzolis", firstname: "Christos", lastname: "Tzolis",
    birth: { date: "2002-01-30" }, nationality: "Greece" },
statistics: [{ team: { name: "Arsenal" }, games: { position: "Midfielder" } }] };

function seasonResponse(season) {
    return { response: [{ ...record, statistics: [{ team: { name: `Club ${season}` },
        league: { name: "Test League", type: "League", country: "Test" },
        games: { appearences: 25, lineups: 20, minutes: 1800, position: "Midfielder" },
        goals: { total: 8, assists: 5 }, shots: {}, passes: {}, tackles: {}, duels: {}, dribbles: {}, cards: {} }] }] };
}

function providerFetch(counter, rateLimitAt = Infinity) {
    return async input => {
        const url = new URL(input); counter.push(url);
        if (counter.length === rateLimitAt) return Response.json({ errors: { requests: "Request limit reached" } });
        if (url.pathname.endsWith("/players") && url.searchParams.has("search")) return Response.json({ response: [record] });
        if (url.pathname.endsWith("/players")) return Response.json(seasonResponse(url.searchParams.get("season")));
        if (url.pathname.endsWith("/transfers")) return Response.json({ response: [] });
        if (url.pathname.endsWith("/injuries")) return Response.json({ response: [] });
        if (url.pathname.endsWith("/players/seasons")) return Response.json({ response: [2025, 2024, 2023, 2022] });
        return new Response("missing", { status: 404 });
    };
}

const originalFetch = globalThis.fetch;
try {
    let calls = []; clearProviderCache(); globalThis.fetch = providerFetch(calls);
    const lastSeason = await apiFootballHistory(player, env, { depth: 1 });
    assert.equal(calls.length, 2, "last season costs one identity and one season request");
    assert.equal(lastSeason.historySeasonsReturned[0], "2025");
    assert.equal(calls.some(url => url.pathname.endsWith("/players/seasons")), false);

    calls = []; clearProviderCache(); globalThis.fetch = providerFetch(calls);
    const general = await apiFootballHistory(player, env, { depth: 2 });
    assert.equal(calls.length, 3, "general history costs one identity and two season requests");
    const beforeRepeat = calls.length;
    const repeated = await apiFootballHistory(player, env, { depth: 2 });
    assert.equal(calls.length, beforeRepeat, "repeated history is fully provider-cached");
    assert.equal(repeated.metrics.callsFromCache, 3);
    assert.equal(general.partial, false);

    calls = []; clearProviderCache(); globalThis.fetch = providerFetch(calls);
    const [history, recent] = await Promise.all([
        apiFootballHistory(player, env, { depth: 1 }),
        apiFootballRecent(player, env, Date.parse("2026-08-20"), { transfers: false, injuries: true })
    ]);
    assert.equal(calls.filter(url => url.pathname.endsWith("/players") && url.searchParams.has("search")).length, 1,
        "concurrent history/current layers coalesce identity resolution");
    assert.equal(history.metrics.callsCoalesced + recent.metrics.callsCoalesced, 1);

    calls = []; clearProviderCache(); globalThis.fetch = providerFetch(calls);
    await apiFootballRecent(player, env, Date.parse("2026-08-20"), { transfers: true, injuries: false });
    assert.equal(calls.length, 2, "transfer intent costs identity plus transfers only");
    assert.equal(calls.some(url => url.pathname.endsWith("/injuries")), false);

    calls = []; clearProviderCache(); globalThis.fetch = providerFetch(calls);
    await apiFootballRecent(player, env, Date.parse("2026-08-20"), { transfers: false, injuries: true });
    assert.equal(calls.length, 2, "injury intent costs identity plus injuries only");
    assert.equal(calls.some(url => url.pathname.endsWith("/transfers")), false);

    calls = []; clearProviderCache(); globalThis.fetch = providerFetch(calls, 4);
    const partial = await apiFootballHistory(player, env, { depth: 3 });
    assert.equal(calls.length, 4, "rate limiting stops progressive season retrieval immediately");
    assert.equal(partial.seasons.length, 2); assert.equal(partial.partial, true);
    assert.deepEqual(partial.providerFailures, ["history:rate_limit"]);
    assert.equal(partial.metrics.callsRateLimited, 1);

    for (const [question, expectedCalls] of [
        ["What's Haaland's Overall?", 0],
        ["What did Tzolis do last season?", 2],
        ["Tell me about Tzolis.", 3],
        ["Why is Tzolis rated so low?", 3]
    ]) {
        calls = []; clearKnowledgeCache(); globalThis.fetch = providerFetch(calls);
        await retrieveKnowledge(player, detectIntent(question), env, Date.parse("2026-08-20"));
        assert.equal(calls.length, expectedCalls, `${question} free-tier call budget`);
    }
    calls = []; clearKnowledgeCache(); globalThis.fetch = providerFetch(calls);
    const repeatedIntent = detectIntent("Tell me about Tzolis.");
    await retrieveKnowledge(player, repeatedIntent, env, Date.parse("2026-08-20"));
    const firstCount = calls.length;
    await retrieveKnowledge(player, repeatedIntent, env, Date.parse("2026-08-20"));
    assert.equal(calls.length, firstCount, "second identical research request makes zero provider calls");
} finally { globalThis.fetch = originalFetch; clearProviderCache(); }

console.log("free-tier provider tests passed");
