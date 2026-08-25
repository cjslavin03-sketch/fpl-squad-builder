import { handleRequest as freeHandleRequest } from "./worker-free.mjs";

const SOFA_BASE = "https://api.sofascore.com/api/v1";

function json(payload, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
    }});
}

function fold(value = "") {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.sofascore.com/"
    }});
    if (!response.ok) throw new Error(`Sofascore ${response.status}`);
    return response.json();
}

function previousSeasonTokens(date = new Date()) {
    const currentStart = date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
    const start = currentStart - 1;
    const end = start + 1;
    return [String(start), `${String(start).slice(-2)}/${String(end).slice(-2)}`, `${start}/${end}`, `${start}-${String(end).slice(-2)}`];
}

function cleanPosition(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text || /^\d+(\.\d+)?$/.test(text)) return null;
    const normalized = fold(text);
    const aliases = new Map([
        ["g", "Goalkeeper"], ["gk", "Goalkeeper"], ["goalkeeper", "Goalkeeper"],
        ["d", "Defender"], ["df", "Defender"], ["defender", "Defender"], ["defence", "Defender"],
        ["m", "Midfielder"], ["mf", "Midfielder"], ["midfielder", "Midfielder"], ["midfield", "Midfielder"],
        ["f", "Forward"], ["fw", "Forward"], ["forward", "Forward"], ["attacker", "Forward"]
    ]);
    if (aliases.has(normalized)) return aliases.get(normalized);
    if (/goalkeeper|keeper/.test(normalized)) return "Goalkeeper";
    if (/back|defend|centre back|center back/.test(normalized)) return text;
    if (/midfield|winger|wing/.test(normalized)) return text;
    if (/forward|striker|attack/.test(normalized)) return text;
    return null;
}

function sofaSearchName(body) {
    const players = body.players || [];
    if (!players.length) return null;
    const first = players[0];
    return `${first.first_name || ""} ${first.second_name || first.web_name || ""}`.trim() || first.web_name || null;
}

async function searchSofaPlayer(name) {
    if (!name) return null;
    const url = new URL(`${SOFA_BASE}/search/all`);
    url.searchParams.set("q", name);
    const body = await fetchJson(url);
    const results = body.results || body.searchResults || [];
    const candidates = results.map(item => item.entity || item)
        .filter(item => fold(item.type || item.entityType || "player").includes("player") || item.position || item.team)
        .filter(item => item.id != null && item.name);
    const wanted = fold(name);
    candidates.sort((a, b) => {
        const score = item => fold(item.name) === wanted ? 100 : fold(item.name).includes(wanted) || wanted.includes(fold(item.name)) ? 70 : wanted.split(" ").filter(x => fold(item.name).includes(x)).length * 15;
        return score(b) - score(a);
    });
    return candidates[0] || null;
}

function seasonEntries(payload) {
    const out = [];
    const visit = (node, tournament = null) => {
        if (Array.isArray(node)) return node.forEach(item => visit(item, tournament));
        if (!node || typeof node !== "object") return;
        const nextTournament = node.uniqueTournament || node.tournament || tournament;
        if (node.id != null && (node.year || node.name) && nextTournament?.id != null) {
            out.push({ seasonId: node.id, seasonName: String(node.year || node.name), tournamentId: nextTournament.id,
                tournamentName: nextTournament.name || nextTournament.slug || "competition" });
        }
        for (const value of Object.values(node)) visit(value, nextTournament);
    };
    visit(payload);
    return [...new Map(out.map(item => [`${item.tournamentId}:${item.seasonId}`, item])).values()];
}

function previousSeasonEntries(payload) {
    const tokens = previousSeasonTokens();
    return seasonEntries(payload).filter(item => tokens.some(token => item.seasonName.includes(token))).slice(0, 6);
}

function statNumber(stats, ...keys) {
    for (const key of keys) {
        const value = stats?.[key];
        if (value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
}

function normalizedSeasonStats(payload, entry) {
    const stats = payload?.statistics || payload?.stats || payload || {};
    return {
        competition: entry.tournamentName,
        season: entry.seasonName,
        appearances: statNumber(stats, "appearances", "matches"),
        starts: statNumber(stats, "starts"),
        minutes: statNumber(stats, "minutesPlayed", "minutes"),
        goals: statNumber(stats, "goals"),
        assists: statNumber(stats, "assists"),
        xg: statNumber(stats, "expectedGoals", "xG"),
        xa: statNumber(stats, "expectedAssists", "xA"),
        rating: statNumber(stats, "rating", "averageRating")
    };
}

function seasonScore(stats) {
    return (stats.minutes || 0) + (stats.appearances || 0) * 90 + (stats.starts || 0) * 45;
}

async function sofaPreviousSeason(player) {
    if (!player?.id) return null;
    let seasons;
    try { seasons = await fetchJson(`${SOFA_BASE}/player/${player.id}/statistics/seasons`); }
    catch { return null; }
    const entries = previousSeasonEntries(seasons);
    let best = null;
    for (const entry of entries) {
        try {
            const payload = await fetchJson(`${SOFA_BASE}/player/${player.id}/unique-tournament/${entry.tournamentId}/season/${entry.seasonId}/statistics/overall`);
            const stats = normalizedSeasonStats(payload, entry);
            if (!best || seasonScore(stats) > seasonScore(best)) best = stats;
        } catch {}
    }
    return best;
}

function seasonLine(stats) {
    if (!stats) return null;
    const bits = [];
    if (stats.appearances != null) bits.push(`${stats.appearances} apps`);
    if (stats.starts != null) bits.push(`${stats.starts} starts`);
    if (stats.minutes != null) bits.push(`${stats.minutes} min`);
    if (stats.goals != null) bits.push(`${stats.goals} goals`);
    if (stats.assists != null) bits.push(`${stats.assists} assists`);
    if (stats.xg != null) bits.push(`xG ${stats.xg}`);
    if (stats.xa != null) bits.push(`xA ${stats.xa}`);
    if (stats.rating != null) bits.push(`rating ${stats.rating}`);
    return `Previous season (${stats.season}, ${stats.competition}): ${bits.length ? bits.join(", ") : "season participation found, but aggregate statistics were unavailable"}.`;
}

function sanitizePosition(answer, sofaPlayer) {
    const valid = cleanPosition(sofaPlayer?.position);
    return String(answer || "").replace(/\nPosition:\s*\d+(?:\.\d+)?\./i, valid ? `\nPosition: ${valid}.` : "");
}

async function enrichBallKnowledge(request) {
    let body;
    try { body = await request.clone().json(); }
    catch { return freeHandleRequest(request); }

    const base = await freeHandleRequest(request.clone());
    if (!base.ok) return base;
    let payload;
    try { payload = await base.json(); }
    catch { return base; }

    const question = String(body.question || "");
    const fplName = sofaSearchName(body);
    const responseName = payload.players?.[0]?.name;
    const name = fplName && fold(question).includes(fold(fplName.split(" ").at(-1))) ? fplName : responseName || fplName;
    if (!name) return json(payload, base.status);

    let sofa = null;
    try { sofa = await searchSofaPlayer(name); } catch {}
    payload.answer = sanitizePosition(payload.answer, sofa);

    const needsHistory = /previous|last season|history|career|rated|rating|underrat|overrat|tell me about/i.test(question) ||
        /Previous-season FPL history is unavailable/i.test(payload.answer || "");
    if (needsHistory && sofa) {
        const previous = await sofaPreviousSeason(sofa);
        const line = seasonLine(previous);
        if (line) {
            if (/Previous-season FPL history is unavailable for this player\./i.test(payload.answer || ""))
                payload.answer = payload.answer.replace(/Previous-season FPL history is unavailable for this player\./i, line);
            else if (!String(payload.answer || "").includes("Previous season ("))
                payload.answer = `${payload.answer}\n\n${line}\n\nSource for previous-season aggregate: Sofascore free football data.`;
        }
    }
    return json(payload, base.status);
}

async function handleRequest(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ball-knowledge" && request.method === "POST") return enrichBallKnowledge(request);
    return freeHandleRequest(request, env);
}

export default { fetch: handleRequest };
export { cleanPosition, previousSeasonTokens, seasonEntries, previousSeasonEntries, normalizedSeasonStats, handleRequest };
