import assert from "node:assert/strict";
import {
    addAppearances, cleanModel, handleRequest, matchHistoricalPlayers, parseCsv, playerPayload,
    previousSeason, seasonFor
} from "./worker.mjs";
import { clearKnowledgeCache } from "./ball-knowledge.mjs";

assert.equal(seasonFor(new Date("2026-08-19T00:00:00Z")), "2026-27");
assert.equal(previousSeason("2026-27"), "2025-26");

const history = addAppearances(parseCsv(`id,code,first_name,second_name,web_name,minutes,starts,expected_goals,expected_assists,saves,bonus,bps,goals_scored,assists,clean_sheets,goals_conceded,yellow_cards,red_cards,own_goals,penalties_missed,penalties_saved,defensive_contribution,official_assists
10,1001,Erling,Haaland,Haaland,2775,31,25.1,4.2,0,31,760,27,5,12,25,3,0,0,1,0,8,5
20,1002,Bruno,Fernandes,B.Fernandes,3050,34,8.3,13.1,0,28,690,10,14,10,30,6,0,0,0,0,42,14
30,9999,Duplicate,Name,Duplicate,100,1,0,0,0
31,9998,Duplicate,Name,Duplicate,200,2,0,0,0
`), parseCsv(`element,minutes
10,90
10,88
20,90
20,72
30,10
31,20
`));
const current = [
    { id: 101, code: 1001, first_name: "Erling", second_name: "Haaland", web_name: "Haaland" },
    { id: 102, code: 1002, first_name: "Bruno", second_name: "Fernandes", web_name: "B.Fernandes" },
    { id: 103, code: 2001, first_name: "New", second_name: "Signing", web_name: "Signing" },
    { id: 104, code: 2002, first_name: "Duplicate", second_name: "Name", web_name: "Duplicate" }
];
const priors = matchHistoricalPlayers(current, history);

assert.equal(priors.length, 2, "only players with genuine, unambiguous PL history are included");
assert.deepEqual(priors.map(player => player.web_name), ["Haaland", "B.Fernandes"]);
assert.ok(priors.every(player => player.match_method === "code"));
assert.ok(priors.every(player => player.minutes > 2700));
assert.ok(priors.every(player => player.starts >= 31));
assert.ok(priors.every(player => player.matches === 2));
assert.equal(priors[0].id, 101, "snapshot records use the current id for browser fallback matching");
assert.equal(priors[0].historical_id, 10);
assert.equal(priors[0].bonus, 31);
assert.equal(priors[0].bps, 760);
assert.equal(priors[0].goals_scored, 27);
assert.equal(priors[0].penalties_missed, 1);
assert.equal(priors[0].defensive_contribution, 8);
assert.equal(priors[0].official_assists, 5);
assert.equal(priors.some(player => player.web_name === "Signing"), false);

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
    if (url.endsWith("/bootstrap-static/")) {
        return new Response(JSON.stringify({
            elements: current,
            teams: [{ id: 1, name: "Live team data" }],
            element_stats: [{ name: "transfers_in" }]
        }), { status: 200 });
    }
    if (url.endsWith("/players_raw.csv")) {
        return new Response(`id,code,first_name,second_name,web_name,minutes,starts,expected_goals,expected_assists,saves,bonus,bps,yellow_cards
10,1001,Erling,Haaland,Haaland,2775,31,25.1,4.2,0,31,760,3
20,1002,Bruno,Fernandes,B.Fernandes,3050,34,8.3,13.1,0,28,690,6
`, { status: 200 });
    }
    if (url.endsWith("/merged_gw.csv")) {
        return new Response("element,minutes\n10,90\n20,90\n", { status: 200 });
    }
    return new Response("missing", { status: 404 });
};
try {
    const payload = await playerPayload(new Date("2026-08-19T00:00:00Z"));
    assert.equal(payload.previous_season_metadata.matched, 2);
    assert.equal(payload.previous_season_metadata.fallback, 2);
    assert.deepEqual(payload.previous_season_elements.map(player => player.web_name),
        ["Haaland", "B.Fernandes"]);
    assert.deepEqual(payload.teams, [{ id: 1, name: "Live team data" }]);
    assert.deepEqual(payload.element_stats, [{ name: "transfers_in" }]);
} finally {
    globalThis.fetch = originalFetch;
}

assert.deepEqual(cleanModel({ price: 7.5, overall: 74, value: 61, projectedPoints: 4.3,
    expectedMinutes: 68, availability: "available", ignored: "not passed" }), {
    price: 7.5, overall: 74, value: 61, projectedPoints: 4.3, expectedMinutes: 68,
    availability: "available", fixture: "unavailable"
}, "only authoritative model fields enter chat context");
assert.equal(cleanModel({ overall: null }).overall, null, "unavailable Model View values never become zero");

const chatResponse = await handleRequest(new Request("https://worker.test/api/ball-knowledge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        question: "What is Haaland's Overall?", players: current, teams: [{ id: 1, name: "City" }],
        modelById: { 101: { price: 14, overall: 91, value: 70, projectedPoints: 7.2, expectedMinutes: 84 } }
    })
}), { BALL_KNOWLEDGE_LOGGING: "true", FOOTBALL_DATA_API_KEY: "MODEL_ONLY_SECRET" });
assert.equal(chatResponse.status, 200);
const chat = await chatResponse.json();
assert.match(chat.answer, /Overall: 91/);
assert.match(chat.answer, /projected points: 7.2/);
assert.equal(chat.players[0].scout.rating, null, "no fabricated Scout Rating without history");
assert.match(chat.answer, /--- DEBUG ---/); assert.match(chat.answer, /status: skipped_by_intent/);
assert.doesNotMatch(chat.answer, /MODEL_ONLY_SECRET|authorization/i);

const missingResponse = await handleRequest(new Request("https://worker.test/api/ball-knowledge", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "Tell me about Nobody", players: current })
}));
assert.equal(missingResponse.status, 404);

let researchCalls = [];
globalThis.fetch = async url => {
    researchCalls.push(String(url));
    if (String(url).includes("/history")) return Response.json({ provider: "fixture", identity: { confidence: "High" },
        seasons: [{ season: "2025-26", club: "Club Brugge", competition: "First Division A",
            country: "Belgium", appearances: 30, starts: 27, minutes: 2400, goals: 14, assists: 8 }],
        sources: [{ title: "Stats provider", url: "https://stats.example/tzolis", category: "career", supports: ["2025-26 season"] }] });
    if (String(url).includes("/recent")) return Response.json({ asOf: new Date().toISOString(),
        items: [{ kind: "transfer", date: "2026-07-01", summary: "Club Brugge to Arsenal" }],
        sources: [{ title: "Club announcement", url: "https://club.example/tzolis", category: "transfer", supports: ["transfer"] }] });
    throw new Error("unexpected request");
};
try {
    const researchPlayer = { id: 501, code: 9001, first_name: "Christos", second_name: "Tzolis",
        web_name: "Tzolis", team: 1, element_type: 3 };
    clearKnowledgeCache();
    const deep = await handleRequest(new Request("https://worker.test/api/ball-knowledge", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({
            question: "Tell me about Tzolis career history", players: [researchPlayer],
            teams: [{ id: 1, name: "Arsenal" }], modelById: { 501: { price: 6.5, overall: 64,
                value: 58, projectedPoints: 3.4, expectedMinutes: 61 } } }) }),
        { FOOTBALL_DATA_URL: "https://adapter.test", FOOTBALL_CONTEXT_URL: "https://context.test",
            FOOTBALL_DATA_API_KEY: "HISTORICAL_SECRET", FOOTBALL_CONTEXT_API_KEY: "RECENT_SECRET",
            LLM_API_KEY: "LLM_SECRET", BALL_KNOWLEDGE_LOGGING: "true" });
    assert.equal(deep.status, 200); const deepBody = await deep.json();
    assert.match(deepBody.answer, /Club Brugge, First Division A/); assert.equal(deepBody.sources[0].category, "career");
    assert.equal(deepBody.diagnostics[0].cache.historical, "miss"); assert.equal(deepBody.answerMode, "fallback");
    assert.equal(researchCalls.filter(url => url.includes("/history")).length, 1);
    assert.equal(researchCalls.some(url => url.includes("/recent")), false, "career-only intent avoids news retrieval");

    const cachedDeep = await handleRequest(new Request("https://worker.test/api/ball-knowledge", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({
            question: "Tell me about Tzolis career", players: [researchPlayer], teams: [{ id: 1, name: "Arsenal" }],
            modelById: { 501: { overall: 64 } } }) }), { FOOTBALL_DATA_URL: "https://adapter.test" });
    const cachedBody = await cachedDeep.json(); assert.equal(cachedBody.diagnostics[0].cache.historical, "hit");
    assert.equal(researchCalls.filter(url => url.includes("/history")).length, 1, "history cache prevents repeated provider calls");

    const currentRole = await handleRequest(new Request("https://worker.test/api/ball-knowledge", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "What is Tzolis current role?",
            players: [researchPlayer], teams: [{ id: 1, name: "Arsenal" }], modelById: { 501: { overall: 64 } } }) }),
        { FOOTBALL_DATA_URL: "https://adapter.test", FOOTBALL_CONTEXT_URL: "https://context.test",
            FOOTBALL_DATA_API_KEY: "HISTORICAL_SECRET", FOOTBALL_CONTEXT_API_KEY: "RECENT_SECRET",
            LLM_API_KEY: "LLM_SECRET", BALL_KNOWLEDGE_LOGGING: "true" });
    assert.equal(currentRole.status, 200); const roleBody = await currentRole.json();
    assert.match(roleBody.answer, /Club Brugge to Arsenal/); assert.equal(roleBody.sources[0].category, "transfer");

    clearKnowledgeCache(); researchCalls = [];
    const productionQuery = await handleRequest(new Request("https://worker.test/api/ball-knowledge", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({
            question: "Tell me about Tzolis and why the builder might underrate him.", players: [researchPlayer],
            teams: [{ id: 1, name: "Arsenal" }], modelById: { 501: { overall: 64 } } }) }),
        { FOOTBALL_DATA_URL: "https://adapter.test", FOOTBALL_CONTEXT_URL: "https://context.test",
            FOOTBALL_DATA_API_KEY: "HISTORICAL_SECRET", FOOTBALL_CONTEXT_API_KEY: "RECENT_SECRET",
            LLM_API_KEY: "LLM_SECRET", BALL_KNOWLEDGE_LOGGING: "true" });
    const productionBody = await productionQuery.json();
    assert.deepEqual({ model: productionBody.diagnostics[0].intent.model,
        historical: productionBody.diagnostics[0].intent.historical,
        recent: productionBody.diagnostics[0].intent.recent }, { model: true, historical: true, recent: true });
    assert.equal(productionBody.diagnostics[0].providerAttempts.historical.state, "success");
    assert.equal(productionBody.diagnostics[0].providerAttempts.recent.state, "success");
    assert.match(productionBody.answer, /--- DEBUG ---/);
    assert.match(productionBody.answer, /historical: yes/); assert.match(productionBody.answer, /recent: yes/);
    assert.match(productionBody.answer, /provider selection attempted: yes/);
    assert.match(productionBody.answer, /API-Football request metrics:/);
    assert.match(productionBody.answer, /history depth requested: 2/);
    assert.match(productionBody.answer, /partial result: no/);
    assert.doesNotMatch(productionBody.answer, /HISTORICAL_SECRET|RECENT_SECRET|LLM_SECRET|authorization/i);
    assert.equal(researchCalls.filter(url => url.includes("/history")).length, 1);
    assert.equal(researchCalls.filter(url => url.includes("/recent")).length, 1);

    clearKnowledgeCache();
    globalThis.fetch = async () => Response.json({ errors: { token: "Invalid API key LIVE_PROVIDER_SECRET_123456789" } });
    const rejectedProvider = await handleRequest(new Request("https://worker.test/api/ball-knowledge", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({
            question: "Tell me about Tzolis and why the builder might underrate him.", players: [researchPlayer],
            teams: [{ id: 1, name: "Arsenal" }], modelById: { 501: { overall: 64 } } }) }),
        { FOOTBALL_DATA_API_KEY: "LIVE_PROVIDER_SECRET_123456789", BALL_KNOWLEDGE_LOGGING: "true" });
    const rejectedBody = await rejectedProvider.json();
    assert.match(rejectedBody.answer, /failure category: auth/);
    assert.match(rejectedBody.answer, /provider error keys: token/);
    assert.match(rejectedBody.answer, /provider message: Invalid API key \[redacted\]/);
    assert.match(rejectedBody.answer, /identity lookup request completed: no/);
    assert.match(rejectedBody.answer, /cache: miss/);
    assert.doesNotMatch(rejectedBody.answer, /LIVE_PROVIDER_SECRET_123456789|authorization/i);
} finally { globalThis.fetch = originalFetch; }

console.log(`worker tests passed: ${priors.length} matched, ${current.length - priors.length} fallback`);
