import assert from "node:assert/strict";
import {
    addAppearances, matchHistoricalPlayers, parseCsv, playerPayload,
    previousSeason, seasonFor
} from "./worker.mjs";

assert.equal(seasonFor(new Date("2026-08-19T00:00:00Z")), "2026-27");
assert.equal(previousSeason("2026-27"), "2025-26");

const history = addAppearances(parseCsv(`id,code,first_name,second_name,web_name,minutes,starts,expected_goals,expected_assists,saves
10,1001,Erling,Haaland,Haaland,2775,31,25.1,4.2,0
20,1002,Bruno,Fernandes,B.Fernandes,3050,34,8.3,13.1,0
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
        return new Response(`id,code,first_name,second_name,web_name,minutes,starts,expected_goals,expected_assists,saves
10,1001,Erling,Haaland,Haaland,2775,31,25.1,4.2,0
20,1002,Bruno,Fernandes,B.Fernandes,3050,34,8.3,13.1,0
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

console.log(`worker tests passed: ${priors.length} matched, ${current.length - priors.length} fallback`);
