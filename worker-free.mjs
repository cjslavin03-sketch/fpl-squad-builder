import { handleRequest as legacyHandleRequest } from "./worker.mjs";

const FPL_BASE = "https://fantasy.premierleague.com/api";
const FPL_HISTORY_BASE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";
const FOTMOB_BASE = "https://www.fotmob.com";
const SOFA_BASE = "https://api.sofascore.com/api/v1";
let previousSeasonCache = null;

function json(payload, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "access-control-allow-origin": "*"
    }});
}

function fold(value = "") {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function shown(value, fallback = "unavailable") { return value === null || value === undefined || value === "" ? fallback : value; }
function seasonFor(date = new Date()) {
    const y = date.getUTCFullYear(), start = date.getUTCMonth() >= 6 ? y : y - 1;
    return `${start}-${String(start + 1).slice(-2)}`;
}
function previousSeason() {
    const current = seasonFor(); const start = Number(current.slice(0, 4)) - 1;
    return `${start}-${String(start + 1).slice(-2)}`;
}
function parseCsv(text) {
    const rows = []; let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === '"' && quoted && text[i + 1] === '"') { field += '"'; i += 1; }
        else if (c === '"') quoted = !quoted;
        else if (c === "," && !quoted) { row.push(field); field = ""; }
        else if ((c === "\n" || c === "\r") && !quoted) {
            if (c === "\r" && text[i + 1] === "\n") i += 1;
            row.push(field); field = ""; if (row.some(Boolean)) rows.push(row); row = [];
        } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const headers = rows.shift() || [];
    return rows.map(values => Object.fromEntries(headers.map((h, i) => [h.replace(/^\uFEFF/, ""), values[i] ?? ""])));
}

async function fplBootstrap() {
    const response = await fetch(`${FPL_BASE}/bootstrap-static/`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`FPL returned ${response.status}`);
    return response.json();
}
async function previousSeasonRows() {
    if (previousSeasonCache) return previousSeasonCache;
    previousSeasonCache = fetch(`${FPL_HISTORY_BASE}/${previousSeason()}/players_raw.csv`)
        .then(r => r.ok ? r.text() : Promise.reject(new Error(`history ${r.status}`))).then(parseCsv).catch(() => []);
    return previousSeasonCache;
}
function fplMentionedPlayers(question, players) {
    const q = ` ${fold(question)} `;
    const scored = (players || []).map(player => {
        const full = fold(`${player.first_name || ""} ${player.second_name || ""}`);
        const web = fold(player.web_name), last = fold(player.second_name);
        const exact = [full, web, last].filter(v => v.length >= 3).some(v => q.includes(` ${v} `));
        return { player, exact, length: Math.max(full.length, web.length, last.length) };
    }).filter(x => x.exact).sort((a, b) => b.length - a.length);
    const unique = [];
    for (const item of scored) if (!unique.some(p => p.id === item.player.id)) unique.push(item.player);
    return unique.slice(0, 3);
}
function teamName(id, teams = []) { return teams.find(t => Number(t.id) === Number(id))?.name || "Unknown club"; }
function fplAvailability(p) {
    const chance = p.chance_of_playing_next_round ?? p.chance_of_playing_this_round;
    if (p.status === "a" && chance == null && !p.news) return "Available; FPL has no current availability warning.";
    const bits = [];
    if (chance != null) bits.push(`${chance}% chance of playing`);
    if (p.news) bits.push(String(p.news));
    if (!bits.length) bits.push(`FPL status: ${p.status || "unknown"}`);
    return bits.join(" — ");
}
function previousRowFor(player, rows) {
    const code = String(player.code || "");
    let row = rows.find(r => code && String(r.code || "") === code);
    if (!row) {
        const wanted = fold(`${player.first_name || ""} ${player.second_name || ""}`);
        row = rows.find(r => fold(`${r.first_name || ""} ${r.second_name || ""}`) === wanted);
    }
    return row || null;
}
function fplStatLine(p) {
    return `Current FPL: ${shown(p.total_points, 0)} pts, ${shown(p.minutes, 0)} min, ${shown(p.starts, 0)} starts, ` +
        `${shown(p.goals_scored, 0)} goals, ${shown(p.assists, 0)} assists, form ${shown(p.form)}, ` +
        `xG ${shown(p.expected_goals)}, xA ${shown(p.expected_assists)}, selected ${shown(p.selected_by_percent)}%.`;
}
function previousStatLine(p) {
    if (!p) return "Previous-season FPL history is unavailable for this player.";
    return `Previous FPL season: ${shown(p.total_points, 0)} pts, ${shown(p.minutes, 0)} min, ${shown(p.starts, 0)} starts, ` +
        `${shown(p.goals_scored, 0)} goals, ${shown(p.assists, 0)} assists, xG ${shown(p.expected_goals)}, xA ${shown(p.expected_assists)}.`;
}
function fplAnswer(question, raw, input, model, prev, teams) {
    const name = `${raw.first_name || input.first_name || ""} ${raw.second_name || input.second_name || ""}`.trim();
    const club = teamName(raw.team || input.team, teams);
    const q = fold(question), availability = fplAvailability(raw);
    const lines = [`**${name} — ${club}**`, fplStatLine(raw), previousStatLine(prev), `Availability: ${availability}`];
    if (model?.fixture) lines.push(`Next model fixture: ${model.fixture}.`);
    if (/why|rated|rating|overall|low|high/.test(q)) {
        const reasons = [];
        if (model?.expectedMinutes != null) reasons.push(`your model expects about ${model.expectedMinutes} minutes`);
        if (model?.projectedPoints != null) reasons.push(`projects ${model.projectedPoints} FPL points`);
        if (raw.chance_of_playing_next_round != null && Number(raw.chance_of_playing_next_round) < 100)
            reasons.push(`official FPL availability is only ${raw.chance_of_playing_next_round}%`);
        if (reasons.length) lines.push(`**Why the model sees him this way:** ${reasons.join(", ")}. Playing time is usually the biggest driver of a low short-term FPL rating.`);
        if (model?.overall != null) lines.push(`Model Overall: ${model.overall}; Value: ${shown(model.value)}.`);
    } else if (/minute|start|play|available|injur|fitness|lineup/.test(q)) {
        lines.push(`**Minutes / availability read:** ${availability} The model currently expects ${shown(model?.expectedMinutes)} minutes. Official current-season minutes: ${shown(raw.minutes, 0)}.`);
    } else if (/fixture|schedule|opponent|next game/.test(q)) {
        lines.push(`**Fixture read:** ${shown(model?.fixture, "The current FPL fixture was not supplied to the model.")}`);
    } else if (/form|stats|perform|good|season|history/.test(q)) {
        lines.push("The current and previous-season lines above are the strongest free structured evidence available from official FPL data.");
    }
    lines.push("Source: official Fantasy Premier League data; previous-season FPL dataset when matched.");
    return lines.join("\n\n");
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0", Referer: "https://www.fotmob.com/" } });
    if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
    return response.json();
}
function walk(node, fn, parentKey = "") {
    if (Array.isArray(node)) return node.forEach(v => walk(v, fn, parentKey));
    if (!node || typeof node !== "object") return;
    fn(node, parentKey);
    Object.entries(node).forEach(([k, v]) => walk(v, fn, k));
}
function entityName(o) { return o.name || o.title || o.text || o.shortName || o.fullName || null; }
function entityId(o) { return o.id ?? o.playerId ?? o.entityId ?? null; }
function playerCandidates(payload) {
    const out = [];
    walk(payload, (o, parentKey) => {
        const type = fold(o.type || o.entityType || o.suggestionType || o.searchType || parentKey);
        const name = entityName(o), id = entityId(o);
        if (name && id != null && (type.includes("player") || type.includes("squadmember") || o.playerId != null))
            out.push({ id, name: String(name), team: o.teamName || o.team?.name || o.subtitle || null, raw: o });
    });
    return [...new Map(out.map(x => [`${x.id}`, x])).values()];
}
function queryTerms(question) {
    const stop = new Set("why is are was were how what who tell me about rated rating low high good bad stats statistics form minutes minute available availability injury injured start starting play playing compare versus vs season career current recent the a an of for to and please".split(" "));
    const words = fold(question).split(" ").filter(w => w.length > 1 && !stop.has(w));
    const terms = [];
    if (words.length) terms.push(words.join(" "));
    if (words.length >= 2) terms.push(words.slice(-2).join(" "));
    if (words.length >= 3) terms.push(words.slice(-3).join(" "));
    if (words.length) terms.push(words.at(-1));
    return [...new Set(terms)].filter(Boolean);
}
function similarity(name, term) {
    const n = fold(name), t = fold(term); if (n === t) return 100; if (n.includes(t) || t.includes(n)) return 70;
    return t.split(" ").filter(x => n.includes(x)).length * 15;
}
async function searchFotmob(question) {
    for (const term of queryTerms(question)) {
        for (const path of ["/api/data/search/suggest", "/api/searchData"]) {
            try {
                const url = new URL(path, FOTMOB_BASE); url.searchParams.set("term", term);
                if (path.includes("suggest")) { url.searchParams.set("hits", "20"); url.searchParams.set("lang", "en"); }
                const body = await fetchJson(url); const candidates = playerCandidates(body).sort((a,b) => similarity(b.name, term)-similarity(a.name, term));
                if (candidates.length) return candidates[0];
            } catch {}
        }
    }
    return null;
}
async function fotmobProfile(id) {
    for (const path of ["/api/data/playerData", "/api/playerData"]) {
        try { const url = new URL(path, FOTMOB_BASE); url.searchParams.set("id", id); url.searchParams.set("includeMarketValues", "true"); return await fetchJson(url); }
        catch {}
    }
    return null;
}
async function fotmobMatches(id) {
    for (const path of ["/api/data/playerMatches", "/api/playerMatches"]) {
        try { const url = new URL(path, FOTMOB_BASE); url.searchParams.set("playerId", id); return await fetchJson(url); }
        catch {}
    }
    return null;
}
function bestStatsObject(payload) {
    let best = null, bestScore = 0;
    const desired = /^(goals|assists|appearances|matches|starts|minutes|minutesplayed|rating|expectedgoals|expectedassists|xg|xa)$/i;
    walk(payload, o => {
        const score = Object.entries(o).filter(([k,v]) => desired.test(k) && (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v)))).length;
        if (score > bestScore) { best = o; bestScore = score; }
    });
    return best || {};
}
function firstDeep(payload, keys) {
    let found = null;
    const wanted = new Set(keys.map(k => fold(k).replace(/ /g, "")));
    walk(payload, o => {
        if (found != null) return;
        for (const [k,v] of Object.entries(o)) {
            if (wanted.has(fold(k).replace(/ /g, "")) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) { found = v; break; }
        }
    });
    return found;
}
function statValue(stats, keys) {
    for (const key of keys) if (stats[key] != null) return stats[key];
    const normalized = Object.fromEntries(Object.entries(stats).map(([k,v]) => [fold(k).replace(/ /g, ""), v]));
    for (const key of keys) { const v = normalized[fold(key).replace(/ /g, "")]; if (v != null) return v; }
    return null;
}
function fotmobSummary(candidate, profile, matches) {
    const stats = bestStatsObject(profile);
    const name = firstDeep(profile, ["name", "fullName"]) || candidate.name;
    const team = firstDeep(profile, ["teamName", "currentTeamName", "clubName"]) || candidate.team;
    const position = firstDeep(profile, ["position", "positionDescription"]);
    const injury = firstDeep(profile, ["injury", "injuryDescription", "injuryStatus", "isInjured"]);
    const s = {
        goals: statValue(stats, ["goals"]), assists: statValue(stats, ["assists"]), appearances: statValue(stats, ["appearances", "matches"]),
        starts: statValue(stats, ["starts"]), minutes: statValue(stats, ["minutes", "minutesPlayed"]), rating: statValue(stats, ["rating"]),
        xg: statValue(stats, ["expectedGoals", "xG"]), xa: statValue(stats, ["expectedAssists", "xA"])
    };
    let matchCount = 0; walk(matches, (o, key) => { if (matchCount === 0 && key.toLowerCase().includes("matches") && Array.isArray(o)) matchCount = o.length; });
    return { name, team, position, injury, stats: s, hasMatches: Boolean(matches), matchCount };
}
function globalAnswer(question, data, source = "FotMob") {
    const s = data.stats || {}, q = fold(question), statBits = [];
    if (s.appearances != null) statBits.push(`${s.appearances} apps`); if (s.starts != null) statBits.push(`${s.starts} starts`);
    if (s.minutes != null) statBits.push(`${s.minutes} min`); if (s.goals != null) statBits.push(`${s.goals} goals`); if (s.assists != null) statBits.push(`${s.assists} assists`);
    if (s.xg != null) statBits.push(`xG ${s.xg}`); if (s.xa != null) statBits.push(`xA ${s.xa}`); if (s.rating != null) statBits.push(`rating ${s.rating}`);
    const lines = [`**${data.name}${data.team ? ` — ${data.team}` : ""}**${data.position ? `\nPosition: ${data.position}.` : ""}`];
    lines.push(statBits.length ? `Structured player stats: ${statBits.join(", ")}.` : "Structured profile found, but this response did not expose a clean current-season stat block.");
    if (/injur|available|fitness|play|start|minute|lineup/.test(q)) lines.push(`Availability: ${data.injury == null ? "No explicit injury flag was found in the free profile response; that does not guarantee selection." : String(data.injury)}.`);
    else if (data.injury != null) lines.push(`Availability flag: ${data.injury}.`);
    if (data.hasMatches) lines.push("Recent player-match history was reachable and can be used for form/context questions.");
    lines.push(`Source: ${source} free web football data. This is an unofficial integration and may occasionally be unavailable.`);
    return lines.join("\n\n");
}

async function searchSofa(question) {
    for (const term of queryTerms(question)) {
        try {
            const url = new URL(`${SOFA_BASE}/search/all`); url.searchParams.set("q", term);
            const body = await fetchJson(url); const results = body.results || body.searchResults || [];
            const players = results.filter(r => fold(r.type || r.entity?.type).includes("player")).map(r => r.entity || r);
            if (players.length) return players.sort((a,b) => similarity(b.name,term)-similarity(a.name,term))[0];
        } catch {}
    }
    return null;
}
async function sofaData(candidate) {
    const id = candidate.id; if (id == null) return null;
    let profile = null, seasons = null;
    try { profile = await fetchJson(`${SOFA_BASE}/player/${id}`); } catch {}
    try { seasons = await fetchJson(`${SOFA_BASE}/player/${id}/statistics/seasons`); } catch {}
    if (!profile) return null;
    const p = profile.player || profile;
    return { name: p.name || candidate.name, team: p.team?.name || candidate.team?.name || null, position: p.position || null,
        injury: p.injury || p.injuryStatus || null, stats: bestStatsObject(seasons || profile), hasMatches: false, matchCount: 0 };
}

async function handleFreeChat(request) {
    let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const question = String(body.question || "").trim().slice(0, 1000);
    if (!question) return json({ error: "Question is required" }, 400);
    const fplMatches = fplMentionedPlayers(question, body.players || []);
    if (fplMatches.length) {
        try {
            const [bootstrap, history] = await Promise.all([fplBootstrap(), previousSeasonRows()]);
            const answers = fplMatches.map(input => {
                const raw = (bootstrap.elements || []).find(p => Number(p.id) === Number(input.id)) || input;
                const prev = previousRowFor(raw, history); const model = body.modelById?.[input.id] || {};
                return fplAnswer(question, raw, input, model, prev, bootstrap.teams || body.teams || []);
            });
            return json({ answer: answers.join("\n\n---\n\n"), answerMode: "free-structured", players: fplMatches.map(p => ({ id:p.id, name:`${p.first_name} ${p.second_name}`.trim() })), sources: [] });
        } catch (error) { return json({ error: `Official FPL lookup failed: ${error.message}` }, 502); }
    }

    const fotmob = await searchFotmob(question);
    if (fotmob) {
        const [profile, matches] = await Promise.all([fotmobProfile(fotmob.id), fotmobMatches(fotmob.id)]);
        if (profile) {
            const data = fotmobSummary(fotmob, profile, matches);
            return json({ answer: globalAnswer(question, data, "FotMob"), answerMode: "free-global", players: [{ id:`fotmob:${fotmob.id}`, name:data.name }], sources: [] });
        }
    }
    const sofa = await searchSofa(question);
    if (sofa) {
        const data = await sofaData(sofa);
        if (data) return json({ answer: globalAnswer(question, data, "Sofascore"), answerMode: "free-global-fallback", players: [{ id:`sofa:${sofa.id}`, name:data.name }], sources: [] });
    }
    return json({ error: "I couldn't identify that football player from FPL, FotMob, or Sofascore. Try the player's full name.", code: "PLAYER_NOT_FOUND" }, 404);
}

async function handleRequest(request, env = {}) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type"
    }});
    if (url.pathname === "/api/ball-knowledge" && request.method === "POST") return handleFreeChat(request);
    return legacyHandleRequest(request, env);
}

export default { fetch: handleRequest };
export { handleRequest, handleFreeChat, queryTerms, fplMentionedPlayers, globalAnswer };
