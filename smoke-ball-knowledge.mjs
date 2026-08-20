const endpoint = (process.env.BALL_KNOWLEDGE_ENDPOINT ||
    "https://jolly-glitter-bb07.cjslavin03.workers.dev").replace(/\/$/, "");

async function checked(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${body.error || response.statusText}`);
    return body;
}

function findPlayer(players, name) {
    const folded = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]/g, "");
    return players.find(player => [player.web_name, `${player.first_name} ${player.second_name}`]
        .some(value => folded(value).includes(folded(name))));
}

let payload;
try { payload = await checked(`${endpoint}/api/players`); }
catch (error) {
    console.error(JSON.stringify({ endpoint, stage: "players", error: error.message,
        hint: "Set BALL_KNOWLEDGE_ENDPOINT to a reachable deployed Worker." }));
    process.exit(1);
}
const players = payload.elements || [], teams = payload.teams || [];
const budget = [...players].filter(player => Number(player.element_type) === 3)
    .sort((a, b) => Number(a.now_cost) - Number(b.now_cost))[0];
const cases = [
    ["Tzolis", "Tell me about Tzolis and why the builder might underrate him."],
    ["Haaland", "Give me Haaland's career history and current FPL outlook."],
    ["Bruno", "Why does Bruno rate so highly in the builder? Give me the football context too."],
    ["Saliba", "Give me Saliba's career, defensive evidence and current role."],
    ["Raya", "Give me Raya's career, goalkeeping evidence and current role."],
    [budget?.web_name, `Tell me about ${budget?.web_name} and be clear if evidence is sparse.`]
].filter(([name]) => name);

for (const [name, question] of cases) {
    const player = findPlayer(players, name);
    if (!player) { console.log(JSON.stringify({ query: name, skipped: "not in live FPL payload" })); continue; }
    const modelById = { [player.id]: { price: Number(player.now_cost) / 10,
        overall: null, value: null, projectedPoints: Number(player.ep_next) || null,
        expectedMinutes: null, availability: player.news || player.status || "unknown" } };
    try {
        const result = await checked(`${endpoint}/api/ball-knowledge`, { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ question,
                players: players.map(item => ({ id: item.id, code: item.code, first_name: item.first_name,
                    second_name: item.second_name, web_name: item.web_name, team: item.team,
                    element_type: item.element_type, date_of_birth: item.date_of_birth || null,
                    nationality: item.nationality || null, club: teams.find(team => team.id === item.team)?.name || null })),
                teams, modelById }) });
        const resolved = result.players?.[0], diagnostic = result.diagnostics?.[0] || {};
        console.log(JSON.stringify({ query: name, status: 200, resolved: resolved?.name,
            modelView: resolved?.model, historicalEvidence: diagnostic.historicalRows > 0,
            currentEvidence: diagnostic.currentItems > 0 && diagnostic.currentStale === false,
            sources: result.sources?.length || 0, scout: resolved?.scout,
            cache: diagnostic.cache, answerMode: result.answerMode, failures: result.failures }, null, 2));
    } catch (error) { console.log(JSON.stringify({ query: name, error: error.message })); }
}
