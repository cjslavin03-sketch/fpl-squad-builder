const FPL_BASE = "https://fantasy.premierleague.com/api";
const HISTORY_BASE =
    "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";
const CACHE_SECONDS = 6 * 60 * 60;

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

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${CACHE_SECONDS}`,
            "access-control-allow-origin": "*"
        }
    });
}

async function handleRequest(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "GET, OPTIONS"
            }
        });
    }
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
export { addAppearances, matchHistoricalPlayers, parseCsv, playerPayload, previousSeason, seasonFor };
