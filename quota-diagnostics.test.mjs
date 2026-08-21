import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { apiFootballHistory, apiFootballKeyFingerprint, clearProviderCache, ProviderError } from "./football-providers.mjs";
import { clearKnowledgeCache, detectIntent, retrieveKnowledge } from "./ball-knowledge.mjs";
import { debugBlock } from "./worker.mjs";

const key = "quota-test-secret-key";
const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 8);
assert.equal(await apiFootballKeyFingerprint(key), fingerprint);
assert.match(fingerprint, /^[a-f0-9]{8}$/);

const player = { id: 1, code: 101, first_name: "Christos", second_name: "Tzolis" };
const env = { FOOTBALL_DATA_API_KEY: key, FOOTBALL_CURRENT_SEASON: "2026",
    FOOTBALL_HISTORY_SEASONS: "1", FOOTBALL_API_MIN_INTERVAL_MS: "0" };
const record = { player: { id: 9, name: "Christos Tzolis", firstname: "Christos", lastname: "Tzolis" },
    statistics: [{ team: { name: "Club Brugge" }, league: { name: "First Division A" },
        games: { minutes: 900, position: "Midfielder" }, goals: { total: 4, assists: 3 } }] };
const headers = { "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "98",
    "x-ratelimit-limit": "300", "x-ratelimit-remaining": "297", "retry-after": "12",
    authorization: "Bearer response-secret", "x-apisports-key": "response-key", "x-arbitrary-secret": "do-not-copy" };
const originalFetch = globalThis.fetch;

clearKnowledgeCache();
globalThis.fetch = async input => {
    const url = new URL(input);
    return Response.json({ response: url.searchParams.has("search") ? [record] : [{ ...record }] }, { headers });
};
try {
    const knowledge = await retrieveKnowledge(player, detectIntent("Why is Tzolis rated so low?"), env);
    assert.equal(knowledge.providerDiagnostics.configuredKeyFingerprint, fingerprint);
    assert.equal(knowledge.providerDiagnostics.crossCallFingerprintConsistent, true);
    assert.ok(knowledge.providerDiagnostics.calls.length >= 2, "successful calls retain quota diagnostics");
    assert.deepEqual(knowledge.providerDiagnostics.calls[0].responseHeaders, {
        "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "98",
        "x-ratelimit-limit": "300", "x-ratelimit-remaining": "297", "retry-after": "12"
    });
    const serialized = JSON.stringify(knowledge.providerDiagnostics);
    assert.doesNotMatch(serialized, /quota-test-secret-key|response-secret|response-key|do-not-copy|authorization|x-apisports-key|x-arbitrary-secret/i);

    const output = debugBlock([{ playerId: 1, intent: detectIntent("Why is Tzolis rated so low?"),
        providerAttempts: knowledge.attempts, cache: knowledge.cache, providerMetrics: {},
        providerDiagnostics: knowledge.providerDiagnostics }], "fallback", []);
    assert.match(output, new RegExp(`configured key fingerprint: ${fingerprint}`));
    assert.match(output, /cross-call fingerprint consistent: yes/);
    assert.match(output, /x-ratelimit-requests-remaining: 98/);
    assert.doesNotMatch(output, /quota-test-secret-key|response-secret|response-key|do-not-copy|authorization|x-apisports-key|x-arbitrary-secret/i);
} finally { globalThis.fetch = originalFetch; }

clearProviderCache();
globalThis.fetch = async () => new Response("denied", { status: 429, headers });
try {
    await assert.rejects(() => apiFootballHistory(player, env), error => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, "rate_limit");
        assert.equal(error.providerDiagnostics.apiKeyFingerprint, fingerprint);
        assert.deepEqual(Object.keys(error.providerDiagnostics.responseHeaders), [
            "x-ratelimit-requests-limit", "x-ratelimit-requests-remaining", "x-ratelimit-limit",
            "x-ratelimit-remaining", "retry-after"]);
        assert.doesNotMatch(JSON.stringify(error), /quota-test-secret-key|response-secret|response-key|do-not-copy/i);
        return true;
    });
} finally { globalThis.fetch = originalFetch; }

console.log("quota diagnostic tests passed");