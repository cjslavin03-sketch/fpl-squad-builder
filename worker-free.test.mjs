import assert from "node:assert/strict";
import { handleFreeChat } from "./worker-free.mjs";

const originalFetch = globalThis.fetch;

globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === "fantasy.premierleague.com") return Response.json({
        elements: [{ id: 557, code: 777, first_name: "Christos", second_name: "Tzolis", web_name: "Tzolis",
            team: 1, status: "a", news: "", total_points: 0, minutes: 0, starts: 0, goals_scored: 0, assists: 0,
            form: "0.0", expected_goals: "0.00", expected_assists: "0.00", selected_by_percent: "4.2" }],
        teams: [{ id: 1, name: "Arsenal" }]
    });
    if (url.hostname === "raw.githubusercontent.com") return new Response(
        "code,first_name,second_name,total_points,minutes,starts,goals_scored,assists,expected_goals,expected_assists\n" +
        "777,Christos,Tzolis,150,2800,31,10,8,9.5,7.2\n");
    throw new Error(`Unexpected URL ${url}`);
};
try {
    const req = new Request("https://example.com/api/ball-knowledge", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Why is Tzolis rated so low?", players: [{ id: 557, code: 777, first_name: "Christos", second_name: "Tzolis", web_name: "Tzolis", team: 1 }],
            teams: [{ id: 1, name: "Arsenal" }], modelById: { 557: { overall: 57, value: 41.2, projectedPoints: 2.3, expectedMinutes: 15, fixture: "v Leeds" } } }) });
    const response = await handleFreeChat(req); const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.answerMode, "free-structured");
    assert.match(data.answer, /official Fantasy Premier League/i); assert.match(data.answer, /2800 min/); assert.match(data.answer, /expects about 15 minutes/i);
} finally { globalThis.fetch = originalFetch; }

globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === "www.fotmob.com" && url.pathname.includes("search")) return Response.json({ suggestions: [
        { type: "player", id: 123, name: "Lamine Yamal", teamName: "Barcelona" }
    ]});
    if (url.hostname === "www.fotmob.com" && url.pathname.includes("playerData")) return Response.json({
        name: "Lamine Yamal", teamName: "Barcelona", position: "Right Winger",
        currentSeason: { goals: 12, assists: 15, appearances: 34, starts: 30, minutesPlayed: 2700, rating: 8.1, expectedGoals: 10.2, expectedAssists: 12.4 }
    });
    if (url.hostname === "www.fotmob.com" && url.pathname.includes("playerMatches")) return Response.json({ matches: [] });
    throw new Error(`Unexpected URL ${url}`);
};
try {
    const req = new Request("https://example.com/api/ball-knowledge", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Tell me about Lamine Yamal", players: [], teams: [], modelById: {} }) });
    const response = await handleFreeChat(req); const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.answerMode, "free-global");
    assert.match(data.answer, /Lamine Yamal/); assert.match(data.answer, /12 goals/); assert.match(data.answer, /15 assists/);
} finally { globalThis.fetch = originalFetch; }

console.log("free Ball Knowledge tests passed");
