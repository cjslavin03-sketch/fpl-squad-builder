const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const API_FOOTBALL_SOURCE = "https://www.api-football.com/documentation-v3";
const NEWS_API_BASE = "https://newsapi.org/v2/everything";
const IDENTITY_TTL = 30 * 60 * 1000;
const identityCache = new Map();
const TRUSTED_NEWS_DOMAINS = ["premierleague.com", "uefa.com", "bbc.co.uk", "skysports.com",
    "theathletic.com", "reuters.com", "arsenal.com", "mancity.com", "manutd.com", "liverpoolfc.com"];

export class ProviderError extends Error {
    constructor(kind, status, message) { super(message); this.name = "ProviderError"; this.kind = kind; this.status = status; }
}

function text(value) { return value == null ? "" : String(value).trim(); }
function number(value) { if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function fold(value = "") { return text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, ""); }
function dateValue(value) { const time = Date.parse(value || ""); return Number.isFinite(time) ? time : null; }

export function seasonStartYear(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(value.getTime())) throw new TypeError("A valid date is required");
    return value.getUTCMonth() >= 6 ? value.getUTCFullYear() : value.getUTCFullYear() - 1;
}

export function clearProviderCache() { identityCache.clear(); }

export function providerSelection(env = {}, kind = "historical") {
    const override = kind === "historical" ? env.FOOTBALL_DATA_URL : env.FOOTBALL_CONTEXT_URL;
    if (override) return { name: "custom", configured: true, override };
    const setting = kind === "historical" ? env.FOOTBALL_DATA_PROVIDER : env.FOOTBALL_CONTEXT_PROVIDER;
    const name = setting || "api-football";
    if (name === "none") return { name, configured: false };
    if (name === "api-football") return { name, configured: Boolean(env.FOOTBALL_DATA_API_KEY || env.API_FOOTBALL_KEY) };
    throw new ProviderError("configuration", 400, `Unsupported ${kind} provider: ${name}`);
}

async function checkedJson(url, headers, provider) {
    const response = await fetch(url, { headers: { Accept: "application/json", ...headers } });
    if (!response.ok) {
        const kind = response.status === 401 || response.status === 403 ? "auth" :
            response.status === 429 ? "rate_limit" : "upstream";
        throw new ProviderError(kind, response.status, `${provider} returned HTTP ${response.status}`);
    }
    let body;
    try { body = await response.json(); } catch { throw new ProviderError("malformed", 502, `${provider} returned invalid JSON`); }
    if (!body || typeof body !== "object") throw new ProviderError("malformed", 502, `${provider} returned an invalid payload`);
    if (body.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length))
        throw new ProviderError("upstream", 502, `${provider}: ${JSON.stringify(body.errors).slice(0, 240)}`);
    return body;
}

function apiFootball(env, path, params = {}) {
    const key = env.FOOTBALL_DATA_API_KEY || env.API_FOOTBALL_KEY;
    if (!key) throw new ProviderError("configuration", 503, "API-Football key is not configured");
    const url = new URL(path, env.API_FOOTBALL_BASE_URL || API_FOOTBALL_BASE);
    Object.entries(params).forEach(([name, value]) => { if (value !== null && value !== undefined && value !== "") url.searchParams.set(name, value); });
    return checkedJson(url, { "x-apisports-key": key }, "API-Football");
}

export function scoreIdentity(candidate, player) {
    const profile = candidate.player || candidate;
    const wantedName = fold(`${player.first_name || ""}${player.second_name || ""}`);
    const candidateNames = [profile.name, `${profile.firstname || ""}${profile.lastname || ""}`].map(fold);
    let score = candidateNames.includes(wantedName) ? 55 : candidateNames.some(name => name &&
        (name.includes(fold(player.second_name)) || wantedName.includes(name))) ? 28 : 0;
    const reasons = score ? [score === 55 ? "full_name" : "surname"] : [];
    if (player.date_of_birth && profile.birth?.date && player.date_of_birth === profile.birth.date) { score += 30; reasons.push("birth_date"); }
    const stats = Array.isArray(candidate.statistics) ? candidate.statistics : [];
    const clubs = stats.map(item => fold(item.team?.name));
    if (player.club && clubs.includes(fold(player.club))) { score += 12; reasons.push("current_club"); }
    if (player.nationality && fold(profile.nationality) === fold(player.nationality)) { score += 8; reasons.push("nationality"); }
    const positions = stats.map(item => fold(item.games?.position));
    if (player.position && positions.some(position => position.includes(fold(player.position)))) { score += 4; reasons.push("position"); }
    return { score, reasons, providerId: profile.id, profile, statistics: stats };
}

export function matchProviderIdentity(candidates, player) {
    const ranked = (Array.isArray(candidates) ? candidates : []).map(candidate => scoreIdentity(candidate, player))
        .filter(candidate => candidate.providerId).sort((a, b) => b.score - a.score);
    if (!ranked.length || ranked[0].score < 40) return { status: "not_found", confidence: "Low", candidates: ranked.slice(0, 3) };
    if (ranked[1] && ranked[0].score - ranked[1].score < 12)
        return { status: "ambiguous", confidence: "Low", candidates: ranked.slice(0, 3) };
    return { status: "matched", confidence: ranked[0].score >= 85 ? "High" : ranked[0].score >= 60 ? "Medium" : "Low", match: ranked[0] };
}

function source(category, supports, publishedAt = null) {
    return { title: "API-Football", url: API_FOOTBALL_SOURCE, category, supports, publishedAt };
}

function normalizedSeason(stat, season) {
    const games = stat.games || {}, goals = stat.goals || {}, shots = stat.shots || {}, passes = stat.passes || {};
    const minutes = number(games.minutes);
    return {
        season: String(season), club: text(stat.team?.name), league: text(stat.league?.name),
        competition: text(stat.league?.name), competitionType: text(stat.league?.type), country: text(stat.league?.country),
        appearances: number(games.appearences), starts: number(games.lineups), minutes,
        position: text(games.position) || null, rating: number(games.rating), captain: Boolean(games.captain),
        goals: number(goals.total), assists: number(goals.assists), goalsConceded: number(goals.conceded),
        saves: number(goals.saves), cleanSheets: null, shots: number(shots.total), shotsOnTarget: number(shots.on),
        keyPasses: number(passes.key), passes: number(passes.total), passAccuracy: number(passes.accuracy),
        tackles: number(stat.tackles?.total), blocks: number(stat.tackles?.blocks), interceptions: number(stat.tackles?.interceptions),
        duels: number(stat.duels?.total), duelsWon: number(stat.duels?.won), aerialSuccess: null,
        dribbleAttempts: number(stat.dribbles?.attempts), dribblesCompleted: number(stat.dribbles?.success),
        foulsDrawn: number(stat.fouls?.drawn), foulsCommitted: number(stat.fouls?.committed),
        yellowCards: number(stat.cards?.yellow), redCards: number(stat.cards?.red),
        penaltiesScored: number(stat.penalty?.scored), penaltiesMissed: number(stat.penalty?.missed), penaltiesSaved: number(stat.penalty?.saved),
        xG: number(stat.expected?.goals), xA: number(stat.expected?.assists), progressiveCarries: null,
        progressivePasses: null, touchesInBox: null, savePercentage: null, postShotXG: null,
        goalsAssistsPer90: minutes ? (((number(goals.total) || 0) + (number(goals.assists) || 0)) * 90 / minutes) : null
    };
}

async function resolveApiFootballPlayer(player, env) {
    const currentSeason = Number(env.FOOTBALL_CURRENT_SEASON) || seasonStartYear();
    const cacheKey = `${player.code || player.id || fold(`${player.first_name}${player.second_name}`)}:${currentSeason}`;
    const cached = identityCache.get(cacheKey);
    if (cached && Date.now() - cached.time < IDENTITY_TTL) return cached.value;
    const body = await apiFootball(env, "/players", { search: `${player.first_name} ${player.second_name}`.trim(), season: currentSeason });
    if (!Array.isArray(body.response)) throw new ProviderError("malformed", 502, "API-Football players response is missing response[]");
    const match = matchProviderIdentity(body.response, player);
    if (match.status !== "matched") throw new ProviderError(match.status === "ambiguous" ? "identity_ambiguous" : "identity_not_found", 422,
        match.status === "ambiguous" ? "Historical player identity is ambiguous" : "Historical player identity was not found");
    const value = { ...match, currentSeason };
    identityCache.set(cacheKey, { time: Date.now(), value });
    return value;
}

export async function apiFootballHistory(player, env) {
    const identity = await resolveApiFootballPlayer(player, env);
    const profile = identity.match.profile;
    const seasonsBody = await apiFootball(env, "/players/seasons", { player: profile.id });
    if (!Array.isArray(seasonsBody.response)) throw new ProviderError("malformed", 502, "API-Football seasons response is missing response[]");
    const seasons = seasonsBody.response.map(Number).filter(Number.isFinite).sort((a, b) => b - a)
        .slice(0, Math.max(1, Math.min(8, Number(env.FOOTBALL_HISTORY_SEASONS) || 6)));
    const seasonBodies = await Promise.all(seasons.map(season => apiFootball(env, "/players", { id: profile.id, season })));
    const rows = seasonBodies.flatMap((body, index) => {
        if (!Array.isArray(body.response)) throw new ProviderError("malformed", 502, "API-Football season response is missing response[]");
        return body.response.flatMap(record => (record.statistics || []).map(stat => normalizedSeason(stat, seasons[index])));
    }).filter(row => row.club && row.competition);
    return { provider: "api-football", providerPlayerId: profile.id, identity: {
        status: "matched", confidence: identity.confidence, signals: identity.match.reasons,
        providerName: profile.name, currentClubConfirmed: identity.match.reasons.includes("current_club")
    }, birthDate: profile.birth?.date || null, age: number(profile.age), nationality: profile.nationality || null,
    positions: [...new Set(rows.map(row => row.position).filter(Boolean))], seasons: rows,
    international: null, sources: [source("historical-statistics", ["identity", "career", "season-statistics", "advanced-statistics"])] };
}

function recentItem(kind, date, summary, status = "reported", extra = {}) {
    return { kind, date: date || null, summary, status, ...extra };
}

export async function apiFootballRecent(player, env, now = Date.now()) {
    const identity = await resolveApiFootballPlayer(player, env);
    const id = identity.match.providerId;
    const [transfersBody, injuriesBody] = await Promise.all([
        apiFootball(env, "/transfers", { player: id }),
        apiFootball(env, "/injuries", { player: id, season: identity.currentSeason })
    ]);
    if (!Array.isArray(transfersBody.response) || !Array.isArray(injuriesBody.response))
        throw new ProviderError("malformed", 502, "API-Football recent response is missing response[]");
    const cutoff = now - 365 * 24 * 60 * 60 * 1000;
    const transfers = transfersBody.response.flatMap(record => record.transfers || []).filter(item => (dateValue(item.date) || 0) >= cutoff)
        .map(item => recentItem("transfer", item.date,
            `${item.teams?.out?.name || "Unknown club"} to ${item.teams?.in?.name || "Unknown club"}${item.type ? ` (${item.type})` : ""}`, "confirmed-by-data-provider"));
    const injuries = injuriesBody.response.filter(item => !item.player?.id || Number(item.player.id) === Number(id))
        .filter(item => !item.fixture?.date || (dateValue(item.fixture.date) || 0) >= cutoff)
        .map(item => recentItem("injury", item.fixture?.date || null,
            `${item.type || "Injury"}${item.reason ? `: ${item.reason}` : ""}`, "provider-record",
            { team: item.team?.name || null }));
    const items = [...transfers, ...injuries].sort((a, b) => (dateValue(b.date) || 0) - (dateValue(a.date) || 0));
    return { provider: "api-football", asOf: new Date(now).toISOString(), items,
        conflicts: detectConflicts(items), identity: { providerPlayerId: id, confidence: identity.confidence, signals: identity.match.reasons },
        sources: [source("recent-structured-data", ["transfers", "injuries"], new Date(now).toISOString())] };
}

export function detectConflicts(items) {
    const injuryItems = items.filter(item => item.kind === "injury" || item.kind === "availability");
    if (injuryItems.some(item => /fit|available|returned/i.test(item.summary)) &&
        injuryItems.some(item => /out|injur|doubt|sidelined/i.test(item.summary)))
        return [{ topic: "availability", note: "Sources conflict on player availability; treat status as uncertain." }];
    return [];
}

export function newsRelevance(article, player, now = Date.now(), trustedDomains = TRUSTED_NEWS_DOMAINS) {
    const title = text(article.title), description = text(article.description);
    const haystack = `${title} ${description}`.toLowerCase();
    const fullName = `${player.first_name || ""} ${player.second_name || ""}`.trim().toLowerCase();
    const surname = text(player.second_name).toLowerCase();
    let host = ""; try { host = new URL(article.url).hostname.replace(/^www\./, ""); } catch { return 0; }
    let score = fullName && haystack.includes(fullName) ? 45 : surname && haystack.includes(surname) ? 20 : 0;
    if (player.club && haystack.includes(text(player.club).toLowerCase())) score += 15;
    if (trustedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) score += 20;
    if (/football|premier league|champions league|transfer|injur|manager|lineup|preseason|penalt|corner|start/i.test(haystack)) score += 10;
    const age = dateValue(article.publishedAt) === null ? Infinity : now - dateValue(article.publishedAt);
    if (age >= 0 && age <= 7 * 86400000) score += 10;
    else if (age >= 0 && age <= 30 * 86400000) score += 5;
    return score;
}

export async function newsApiContext(player, env, now = Date.now()) {
    if (!env.FOOTBALL_CONTEXT_API_KEY) return { items: [], sources: [] };
    const url = new URL(NEWS_API_BASE);
    url.searchParams.set("q", `\"${player.first_name} ${player.second_name}\" AND (${player.club || "football"} OR football)`);
    url.searchParams.set("searchIn", "title,description"); url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", "8"); url.searchParams.set("language", "en");
    const domains = text(env.FOOTBALL_NEWS_DOMAINS) || TRUSTED_NEWS_DOMAINS.join(",");
    url.searchParams.set("domains", domains);
    url.searchParams.set("from", new Date(now - 30 * 86400000).toISOString().slice(0, 10));
    const body = await checkedJson(url, { "X-Api-Key": env.FOOTBALL_CONTEXT_API_KEY }, "NewsAPI");
    if (!Array.isArray(body.articles)) throw new ProviderError("malformed", 502, "NewsAPI response is missing articles[]");
    const trusted = domains.split(",").map(domain => domain.trim()).filter(Boolean);
    const seen = new Set();
    const articles = body.articles.filter(article => article.url && article.title && dateValue(article.publishedAt))
        .map(article => ({ article, relevance: newsRelevance(article, player, now, trusted) }))
        .filter(entry => entry.relevance >= 45)
        .sort((a, b) => b.relevance - a.relevance || dateValue(b.article.publishedAt) - dateValue(a.article.publishedAt))
        .filter(entry => { const key = fold(entry.article.title); if (seen.has(key)) return false; seen.add(key); return true; })
        .slice(0, 5).map(entry => ({ ...entry.article, relevance: entry.relevance }));
    return { items: articles.map(article => recentItem("report", article.publishedAt,
        `${article.title}${article.description ? ` — ${article.description}` : ""}`, "reported",
        { publisher: article.source?.name || null, sourceUrl: article.url, relevance: article.relevance })),
    sources: articles.map(article => ({ title: article.source?.name || article.title, url: article.url,
        publishedAt: article.publishedAt, category: "recent-reporting", supports: [article.title] })) };
}

async function customProvider(base, player, env, kind) {
    const url = `${base.replace(/\/$/, "")}/${kind}?name=${encodeURIComponent(`${player.first_name} ${player.second_name}`)}`;
    const headers = env.FOOTBALL_DATA_KEY ? { Authorization: `Bearer ${env.FOOTBALL_DATA_KEY}` } : {};
    return checkedJson(url, headers, "Custom football adapter");
}

export async function fetchHistorical(player, env) {
    const selection = providerSelection(env, "historical");
    if (!selection.configured) return null;
    return selection.name === "custom" ? customProvider(selection.override, player, env, "history") : apiFootballHistory(player, env);
}

export async function fetchRecent(player, env, now = Date.now()) {
    const selection = providerSelection(env, "recent");
    if (!selection.configured) return null;
    if (selection.name === "custom") return customProvider(selection.override, player, env, "recent");
    const structured = await apiFootballRecent(player, env, now);
    let news = { items: [], sources: [] };
    const providerFailures = [];
    if (env.FOOTBALL_CONTEXT_API_KEY) try { news = await newsApiContext(player, env, now); }
    catch (error) { providerFailures.push(`news:${error.kind || "upstream"}`); }
    return { ...structured, items: [...structured.items, ...news.items], sources: [...structured.sources, ...news.sources],
        conflicts: detectConflicts([...structured.items, ...news.items]), providerFailures };
}
