import { handleRequest as v2HandleRequest } from "./worker-free-v2.mjs";

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

function targetPreviousStart(date = new Date()) {
    const currentStart = date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
    return currentStart - 1;
}

function seasonStart(value) {
    const text = String(value || "");
    const four = text.match(/\b(20\d{2})\s*[\/-]\s*(?:20)?\d{2}\b/);
    if (four) return Number(four[1]);
    const short = text.match(/\b(\d{2})\s*\/\s*(\d{2})\b/);
    if (short) return 2000 + Number(short[1]);
    const lone = text.match(/\b(20\d{2})\b/);
    return lone ? Number(lone[1]) : null;
}

function explicitSeasonEntries(payload, date = new Date()) {
    const target = targetPreviousStart(date);
    const groups = Array.isArray(payload?.uniqueTournamentSeasons) ? payload.uniqueTournamentSeasons : [];
    const out = [];
    for (const group of groups) {
        const tournament = group?.uniqueTournament;
        if (!tournament?.id) continue;
        for (const season of Array.isArray(group?.seasons) ? group.seasons : []) {
            const label = season.year || season.name || "";
            if (season?.id != null && seasonStart(label) === target) {
                out.push({
                    tournamentId: tournament.id,
                    tournamentName: tournament.name || tournament.slug || "competition",
                    seasonId: season.id,
                    seasonName: String(label)
                });
            }
        }
    }
    return out;
}

function num(stats, ...keys) {
    for (const key of keys) {
        const value = stats?.[key];
        if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
}

function normalizeStats(payload, entry) {
    const s = payload?.statistics || payload?.stats || payload || {};
    return {
        competition: entry.tournamentName,
        season: entry.seasonName,
        appearances: num(s, "appearances", "matches"),
        starts: num(s, "matchesStarted", "starts"),
        minutes: num(s, "minutesPlayed", "minutes"),
        goals: num(s, "goals"),
        assists: num(s, "assists"),
        xg: num(s, "expectedGoals", "xG"),
        xa: num(s, "expectedAssists", "xA"),
        rating: num(s, "rating", "averageRating")
    };
}

function score(stats) {
    return (stats.minutes || 0) + (stats.appearances || 0) * 90 + (stats.starts || 0) * 45;
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
    return `Previous season (${stats.season}, ${stats.competition}): ${bits.length ? bits.join(", ") : "aggregate statistics unavailable"}.`;
}

async function searchPlayer(name) {
    const url = new URL(`${SOFA_BASE}/search/all`);
    url.searchParams.set("q", name);
    const body = await fetchJson(url);
    const results = body.results || body.searchResults || [];
    const candidates = results.map(item => item.entity || item).filter(item => item?.id != null && item?.name);
    const wanted = fold(name);
    candidates.sort((a, b) => {
        const scoreName = item => fold(item.name) === wanted ? 100 : fold(item.name).includes(wanted) || wanted.includes(fold(item.name)) ? 70 : wanted.split(" ").filter(x => fold(item.name).includes(x)).length * 15;
        return scoreName(b) - scoreName(a);
    });
    return candidates[0] || null;
}

async function previousSeasonForName(name) {
    const player = await searchPlayer(name);
    if (!player?.id) return null;
    const seasons = await fetchJson(`${SOFA_BASE}/player/${player.id}/statistics/seasons`);
    const entries = explicitSeasonEntries(seasons);
    let best = null;
    for (const entry of entries) {
        try {
            const payload = await fetchJson(`${SOFA_BASE}/player/${player.id}/unique-tournament/${entry.tournamentId}/season/${entry.seasonId}/statistics/overall`);
            const stats = normalizeStats(payload, entry);
            if (!best || score(stats) > score(best)) best = stats;
        } catch {}
    }
    return best;
}

function mentionedFplName(body, question) {
    const q = ` ${fold(question)} `;
    for (const player of body.players || []) {
        const full = `${player.first_name || ""} ${player.second_name || ""}`.trim();
        const names = [full, player.web_name, player.second_name].filter(Boolean).map(fold).filter(x => x.length >= 3);
        if (names.some(name => q.includes(` ${name} `))) return full || player.web_name;
    }
    return null;
}

async function handleBallKnowledge(request) {
    let body;
    try { body = await request.clone().json(); } catch { return v2HandleRequest(request); }
    const response = await v2HandleRequest(request.clone());
    if (!response.ok) return response;
    let payload;
    try { payload = await response.json(); } catch { return response; }

    const answer = String(payload.answer || "");
    const question = String(body.question || "");
    if (!/Previous-season FPL history is unavailable for this player\./i.test(answer)) return json(payload, response.status);

    const name = mentionedFplName(body, question) || payload.players?.[0]?.name;
    if (!name) return json(payload, response.status);

    try {
        const stats = await previousSeasonForName(name);
        const line = seasonLine(stats);
        if (line) {
            payload.answer = answer.replace(/Previous-season FPL history is unavailable for this player\./i, line) +
                "\n\nSource for previous-season aggregate: Sofascore free football data.";
        }
    } catch {}
    return json(payload, response.status);
}

async function handleRequest(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ball-knowledge" && request.method === "POST") return handleBallKnowledge(request);
    return v2HandleRequest(request, env);
}

export default { fetch: handleRequest };
export { explicitSeasonEntries, seasonStart, targetPreviousStart, normalizeStats, handleRequest };
