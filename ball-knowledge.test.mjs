import assert from "node:assert/strict";
import { answerWithProvider, buildPrompt, cached, clearKnowledgeCache, dedupeSources, detectIntent, foldName, normalizeHistorical,
    resolvePlayers, retrieveKnowledge, scoutAssessment } from "./ball-knowledge.mjs";

const players = [
    { id: 1, code: 11, first_name: "Christos", second_name: "Tzolis", web_name: "Tzolis" },
    { id: 2, code: 22, first_name: "Erling", second_name: "Haaland", web_name: "Haaland" },
    { id: 3, code: 33, first_name: "Bruno", second_name: "Fernandes", web_name: "B.Fernandes" },
    { id: 4, first_name: "Alex", second_name: "Smith", web_name: "Smith" },
    { id: 5, first_name: "John", second_name: "Smith", web_name: "Smith" }
];
assert.equal(foldName("João-Pedro"), "joao pedro");
assert.equal(resolvePlayers("Tell me about Tzolis", players).players[0].id, 1);
assert.equal(resolvePlayers("Is Halland good?", players).players[0].id, 2, "reasonable typo");
assert.equal(resolvePlayers("Why is he low?", players, [1]).players[0].id, 1, "pronoun context");
assert.equal(resolvePlayers("Smith", players).status, "ambiguous");
assert.equal(resolvePlayers("Nobody Here", players).status, "not_found");
assert.deepEqual(resolvePlayers("Tzolis or Haaland", players).players.map(p => p.id), [1, 2]);
const intentCases = [
    ["Tell me about Tzolis and why the builder might underrate him.", true, true],
    ["Tell me about Tzolis.", true, false],
    ["Is Tzolis starting for Arsenal?", false, true],
    ["Why is Tzolis rated so low?", true, true],
    ["What's Haaland's Overall?", false, false],
    ["What is Bruno's price?", false, false],
    ["Give me Tzolis' career history.", true, false],
    ["Is Tzolis injured?", false, true]
];
intentCases.forEach(([question, historicalIntent, recentIntent]) => {
    const intent = detectIntent(question);
    assert.deepEqual({ model: intent.model, historical: intent.historical, recent: intent.recent },
        { model: true, historical: historicalIntent, recent: recentIntent }, question);
});
assert.equal(detectIntent("What did Tzolis do last season?").historyDepth, 1);
assert.equal(detectIntent("Give me Tzolis' full career history.").historyDepth, 6);
assert.deepEqual(detectIntent("Is Tzolis injured?").currentContext,
    { transfers: false, injuries: true, news: false });

const historical = normalizeHistorical({ seasons: [{ season: "2025-26", club: "Example",
    minutes: "1800", appearances: "25", goals: "12", assists: "8", xG: "9.1" }],
sources: [{ title: "Club", url: "https://club.example/profile" }, { url: "javascript:bad" }] });
assert.equal(historical.seasons[0].minutes, 1800);
assert.equal(historical.seasons[0].starts, null, "missing stats stay unavailable");
assert.equal(historical.sources.length, 1, "unsafe sources removed");
assert.equal(normalizeHistorical(null), null);
assert.deepEqual(dedupeSources([
    { title: "A", url: "https://source.test/a", supports: ["career"] },
    { title: "A duplicate", url: "https://source.test/a", supports: ["transfer"] }
])[0].supports, ["career", "transfer"]);

const model = { overall: 50, projectedPoints: 3.7, expectedMinutes: 70, value: 44 };
const before = structuredClone(model);
const scout = scoutAssessment(model, historical, { items: [] });
assert.ok(scout.rating > model.overall);
assert.equal(scout.disagreement, "positive");
assert.deepEqual(model, before, "Scout Rating never mutates model values");
assert.equal(scoutAssessment(model, null, null).rating, null);
const partialHistory = normalizeHistorical({ identity: { confidence: "High" }, partial: true,
    seasons: [{ season: "2025", club: "A", competition: "League", minutes: 900, goals: 5 }] });
assert.equal(scoutAssessment(model, partialHistory, null).confidence, "Low");
const partialAnswer = await answerWithProvider("career", [{ player: { name: "Tzolis", position: "MID", club: "Arsenal" },
    model, scout: scoutAssessment(model, partialHistory, null),
    knowledge: { historical: partialHistory, recent: null, failures: ["historical-history:rate_limit"] } }], {});
assert.match(partialAnswer, /Recent historical data is available/);
assert.match(buildPrompt("Question", [{ model }]), /Never invent statistics/);
assert.match(buildPrompt("Question", [{ model }]), /Separate Model View/);

clearKnowledgeCache(); let loads = 0;
assert.equal(await cached("same", 60, async () => ++loads, 1000), 1);
assert.equal(await cached("same", 60, async () => ++loads, 2000), 1);
assert.equal(loads, 1, "fresh cache hit avoids retrieval");
assert.equal(await cached("same", 60, async () => ++loads, 62000), 2, "stale cache refreshes");

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => new Response(JSON.stringify(url.includes("/history") ?
    { seasons: [{ season: "2025", club: "A", minutes: 900, goals: 5 }] } :
    { asOf: "2020-01-01T00:00:00Z", items: ["old"] }), { status: 200 });
try {
    clearKnowledgeCache();
    const knowledge = await retrieveKnowledge(players[0], { historical: true, recent: true },
        { FOOTBALL_DATA_URL: "https://data.test", FOOTBALL_CONTEXT_URL: "https://news.test" }, Date.parse("2026-01-01"));
    assert.equal(knowledge.historical.seasons.length, 1);
    assert.equal(knowledge.recent.stale, true, "old news is explicitly stale");
    assert.equal(knowledge.attempts.historical.state, "success");
    assert.equal(knowledge.attempts.recent.state, "success");
} finally { globalThis.fetch = originalFetch; }

clearKnowledgeCache();
const unconfigured = await retrieveKnowledge(players[0], { model: true, historical: true, recent: true }, {});
assert.deepEqual(unconfigured.cache, { historical: "not_configured", recent: "not_configured" });
assert.equal(unconfigured.attempts.historical.providerSelectionAttempted, true);
assert.equal(unconfigured.attempts.historical.providerConfigured, false);
assert.equal(unconfigured.attempts.recent.state, "provider_not_configured");

globalThis.fetch = async () => { throw new Error("offline"); };
try {
    clearKnowledgeCache();
    const degraded = await retrieveKnowledge(players[0], { historical: true, recent: true },
        { FOOTBALL_DATA_URL: "x", FOOTBALL_CONTEXT_URL: "x" });
    assert.deepEqual(degraded.failures, ["historical:upstream", "recent:upstream"]);
    assert.equal(degraded.attempts.historical.failureCategory, "upstream");
} finally { globalThis.fetch = originalFetch; }

globalThis.fetch = async () => new Response("provider down", { status: 503 });
try {
    await assert.rejects(() => answerWithProvider("question", [{ player: { name: "Tzolis", position: "MID", club: "Arsenal" },
        model, scout: { rating: null, confidence: "Low", disagreement: "unknown" },
        knowledge: { historical: null, recent: null, failures: [] } }],
    { LLM_API_URL: "https://llm.test", LLM_API_KEY: "secret" }), /Language provider returned 503/);
} finally { globalThis.fetch = originalFetch; }

console.log("ball knowledge tests passed");
