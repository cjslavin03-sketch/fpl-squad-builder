const HISTORICAL_TTL = 30 * 24 * 60 * 60;
const RECENT_TTL = 30 * 60;
const cache = new Map();
import { clearProviderCache, fetchHistorical, fetchRecent, providerSelection } from "./football-providers.mjs";

export function foldName(value = "") {
    return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function distance(a, b) {
    const row = [...Array(b.length + 1).keys()];
    for (let i = 1; i <= a.length; i += 1) {
        let diagonal = row[0]; row[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const above = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return row[b.length];
}

export function resolvePlayers(query, players, contextIds = []) {
    const text = foldName(query);
    if (/\b(he|him|this player|this guy)\b/.test(text) && contextIds.length) {
        return { status: "resolved", players: players.filter(p => contextIds.includes(p.id)).slice(0, 1) };
    }
    const aliases = { kdb: "kevin de bruyne", bruno: "bruno fernandes", trent: "trent alexander arnold" };
    const scored = players.map(player => {
        const full = foldName(`${player.first_name || ""} ${player.second_name || ""}`);
        const names = [full, foldName(player.web_name), foldName(player.second_name)];
        let score = names.some(name => name && (` ${text} `).includes(` ${name} `)) ? 0 : Infinity;
        const queryTokens = text.split(" ").filter(token => token.length >= 3 &&
            !["tell", "about", "what", "why", "who", "player", "good", "rated"].includes(token));
        for (const token of queryTokens) {
            const target = aliases[token] || token;
            for (const name of names) if (name) score = Math.min(score, distance(target, name));
        }
        return { player, score };
    }).filter(item => item.score <= 2).sort((a, b) => a.score - b.score);
    if (!scored.length) return { status: "not_found", players: [] };
    const explicit = scored.filter(item => item.score === 0);
    if (explicit.length > 1 && new Set(explicit.map(item => foldName(item.player.second_name))).size > 1 && explicit.every(item => {
        const surname = foldName(item.player.second_name);
        return surname && (` ${text} `).includes(` ${surname} `);
    })) return { status: "resolved", players: explicit.slice(0, 3).map(item => item.player) };
    const best = scored[0].score;
    const matches = scored.filter(item => item.score === best).map(item => item.player);
    return { status: matches.length > 1 ? "ambiguous" : "resolved", players: matches.slice(0, 3) };
}

export function detectIntent(question) {
    const q = foldName(question);
    const ratingInterpretation = /why .*rat|rated .*low|rated .*high|rating .*low|rating .*high/.test(q);
    const disagreement = /underrat|overrat/.test(q);
    const lastSeason = /last season|previous season/.test(q);
    const fullCareer = /full career|entire career|complete career/.test(q);
    const transfers = /transfer|signed|signing|move|this summer/.test(q);
    const injuries = /injur|fit|available|doubt|sidelined|suspend/.test(q);
    const news = /current|recent|start|lineup|preseason|manager|role|set piece|outlook|trap|upside|risk/.test(q) ||
        disagreement || ratingInterpretation;
    return {
        model: true,
        historical: /tell me about|career|history|last season|previous|stats|good|scout/.test(q) ||
            disagreement || ratingInterpretation,
        recent: transfers || injuries || news,
        historyDepth: lastSeason ? 1 : fullCareer ? 6 : 2,
        fullCareer,
        currentContext: { transfers, injuries, news }
    };
}

export function normalizeHistorical(raw) {
    if (!raw || typeof raw !== "object") return null;
    const seasons = Array.isArray(raw.seasons) ? raw.seasons.map(row => ({
        season: String(row.season || ""), club: String(row.club || ""), league: String(row.league || ""),
        competition: String(row.competition || row.league || ""), competitionType: row.competitionType || null,
        country: row.country || null, position: row.position || null,
        appearances: numberOrNull(row.appearances), starts: numberOrNull(row.starts),
        minutes: numberOrNull(row.minutes), goals: numberOrNull(row.goals),
        assists: numberOrNull(row.assists), xG: numberOrNull(row.xG), xA: numberOrNull(row.xA),
        shots: numberOrNull(row.shots), shotsOnTarget: numberOrNull(row.shotsOnTarget),
        keyPasses: numberOrNull(row.keyPasses), passes: numberOrNull(row.passes), passAccuracy: numberOrNull(row.passAccuracy),
        progressiveCarries: numberOrNull(row.progressiveCarries), progressivePasses: numberOrNull(row.progressivePasses),
        touchesInBox: numberOrNull(row.touchesInBox), tackles: numberOrNull(row.tackles), blocks: numberOrNull(row.blocks),
        interceptions: numberOrNull(row.interceptions), duels: numberOrNull(row.duels), duelsWon: numberOrNull(row.duelsWon),
        aerialSuccess: numberOrNull(row.aerialSuccess), saves: numberOrNull(row.saves), savePercentage: numberOrNull(row.savePercentage),
        postShotXG: numberOrNull(row.postShotXG), goalsConceded: numberOrNull(row.goalsConceded), cleanSheets: numberOrNull(row.cleanSheets),
        yellowCards: numberOrNull(row.yellowCards), redCards: numberOrNull(row.redCards), rating: numberOrNull(row.rating)
    })) : [];
    return { provider: raw.provider || "custom", providerPlayerId: raw.providerPlayerId || null,
        identity: raw.identity || { status: "unverified", confidence: "Low", signals: [] },
        birthDate: raw.birthDate || null, age: numberOrNull(raw.age), nationality: raw.nationality || null,
        positions: arrayStrings(raw.positions), seasons, partial: Boolean(raw.partial),
        providerFailures: arrayStrings(raw.providerFailures), metrics: raw.metrics || null,
        historyDepthRequested: numberOrNull(raw.historyDepthRequested),
        historySeasonsReturned: arrayStrings(raw.historySeasonsReturned), international: raw.international || null,
        sources: normalizeSources(raw.sources) };
}

function numberOrNull(value) { if (value === null || value === undefined || value === "") return null;
    const n = Number(value); return Number.isFinite(n) ? n : null; }
function arrayStrings(value) { return Array.isArray(value) ? value.map(String) : []; }
function normalizeSources(value) {
    return (Array.isArray(value) ? value : []).filter(source => source && /^https:\/\//.test(source.url || ""))
        .map(source => ({ title: String(source.title || "Source"), url: source.url,
            publishedAt: source.publishedAt || null, category: source.category || "football-data",
            supports: arrayStrings(source.supports) }));
}

export function dedupeSources(sources) {
    const byUrl = new Map();
    normalizeSources(sources).forEach(source => {
        const found = byUrl.get(source.url);
        if (!found) byUrl.set(source.url, source);
        else found.supports = [...new Set([...found.supports, ...source.supports])];
    });
    return [...byUrl.values()].slice(0, 12);
}

export function scoutAssessment(model, historical, recent) {
    const overall = numberOrNull(model.overall);
    if (!historical || !historical.seasons.length || overall === null)
        return { rating: null, confidence: "Low", disagreement: "unknown", delta: null };
    const rows = historical.seasons.filter(row => row.minutes && row.minutes >= 180);
    if (!rows.length) return { rating: null, confidence: "Low", disagreement: "unknown", delta: null };
    const latest = rows[rows.length - 1];
    const returns90 = ((latest.goals || 0) + (latest.assists || 0)) * 90 / latest.minutes;
    const production = Math.min(100, 45 + returns90 * 55);
    const minutesSignal = model.expectedMinutes == null ? 50 : Math.min(100, model.expectedMinutes / 0.9);
    const rating = Math.round(production * .65 + minutesSignal * .35);
    const delta = rating - overall;
    const evidenceConfidence = rows.length >= 3 && recent ? "High" : rows.length >= 2 ? "Medium" : "Low";
    const identityConfidence = historical.identity?.confidence || "Low";
    const confidence = historical.partial || identityConfidence === "Low" ? "Low" :
        identityConfidence === "Medium" && evidenceConfidence === "High" ? "Medium" : evidenceConfidence;
    return { rating, confidence,
        delta, disagreement: delta >= 8 ? "positive" : delta <= -8 ? "negative" : "aligned" };
}

async function cached(key, ttl, loader, now = Date.now()) {
    const found = cache.get(key);
    if (found && now - found.time < ttl * 1000) return found.value;
    const value = await loader(); cache.set(key, { time: now, value }); return value;
}
async function cachedResult(key, ttl, loader, now = Date.now()) {
    const found = cache.get(key);
    if (found && now - found.time < ttl * 1000) return { value: found.value, hit: true };
    const value = await loader(); cache.set(key, { time: now, value }); return { value, hit: false };
}
function cacheHasFresh(key, ttl, now) {
    const found = cache.get(key);
    return Boolean(found && now - found.time < ttl * 1000);
}
export function clearKnowledgeCache() { cache.clear(); clearProviderCache(); }

export async function retrieveKnowledge(player, intent, env, now = Date.now()) {
    const failures = [];
    let historical = null, recent = null;
    const cacheStatus = { historical: "skipped", recent: "skipped" };
    const attempts = {
        historical: { requested: Boolean(intent.historical), providerSelectionAttempted: false,
            provider: null, providerConfigured: null, identityLookupAttempted: false, identityLookupRequestCompleted: false,
            state: "skipped_by_intent", failureCategory: null, providerErrorKeys: [], providerMessage: null, providerMetrics: null },
        recent: { requested: Boolean(intent.recent), providerSelectionAttempted: false,
            provider: null, providerConfigured: null, identityLookupAttempted: false, identityLookupRequestCompleted: false,
            state: "skipped_by_intent", failureCategory: null, providerErrorKeys: [], providerMessage: null, providerMetrics: null }
    };
    if (intent.historical) try {
        const selection = providerSelection(env, "historical");
        const cacheKey = `h:${player.code || player.id}:${intent.historyDepth || 2}:${intent.fullCareer ? "full" : "recent"}`;
        const willHitCache = cacheHasFresh(cacheKey, HISTORICAL_TTL, now);
        Object.assign(attempts.historical, { providerSelectionAttempted: true, provider: selection.name,
            providerConfigured: selection.configured, identityLookupAttempted: selection.name === "api-football" && selection.configured && !willHitCache,
            state: selection.configured ? "provider_attempted" : "provider_not_configured" });
        if (!selection.configured) { cacheStatus.historical = "not_configured"; }
        else {
        cacheStatus.historical = willHitCache ? "hit" : "miss";
        const result = await cachedResult(cacheKey, HISTORICAL_TTL,
            () => fetchHistorical(player, env, { depth: intent.historyDepth, fullCareer: intent.fullCareer }), now);
        historical = normalizeHistorical(result.value);
        if (historical?.partial) cache.delete(cacheKey);
        if (historical?.providerFailures?.length) {
            failures.push(...historical.providerFailures.map(value => `historical-${value}`));
            attempts.historical.failureCategory = historical.providerFailures.some(value => value.includes("rate_limit")) ?
                "rate_limit" : "partial_provider_failure";
        }
        attempts.historical.state = historical?.seasons?.length ? "success" : "empty";
        attempts.historical.identityLookupRequestCompleted = attempts.historical.identityLookupAttempted;
        }
    } catch (error) { const category = error.kind || "upstream"; failures.push(`historical:${category}`);
        attempts.historical.state = "failed"; attempts.historical.failureCategory = category;
        attempts.historical.identityLookupRequestCompleted = error.identityLookupCompleted ??
            (attempts.historical.identityLookupAttempted && error.stage !== "identity_lookup");
        attempts.historical.providerErrorKeys = Array.isArray(error.providerErrorKeys) ? error.providerErrorKeys : [];
        attempts.historical.providerMessage = error.providerMessage || null;
        attempts.historical.providerMetrics = error.providerMetrics || null; }
    if (intent.recent) try {
        const selection = providerSelection(env, "recent");
        const current = intent.currentContext || {};
        const needsProviderIdentity = Boolean(current.transfers || current.injuries);
        const cacheKey = `r:${player.code || player.id}:${current.transfers ? 1 : 0}:${current.injuries ? 1 : 0}:${current.news ? 1 : 0}`;
        const willHitCache = cacheHasFresh(cacheKey, RECENT_TTL, now);
        Object.assign(attempts.recent, { providerSelectionAttempted: true, provider: selection.name,
            providerConfigured: selection.configured, identityLookupAttempted: selection.name === "api-football" &&
                selection.configured && needsProviderIdentity && !willHitCache,
            state: selection.configured ? "provider_attempted" : "provider_not_configured" });
        if (!selection.configured) { cacheStatus.recent = "not_configured"; }
        else {
        cacheStatus.recent = willHitCache ? "hit" : "miss";
        const result = await cachedResult(cacheKey, RECENT_TTL,
            () => fetchRecent(player, env, now, current), now);
        recent = result.value;
        if (recent?.partial) cache.delete(cacheKey);
        if (recent) recent = { provider: recent.provider || null, identity: recent.identity || null,
            asOf: recent.asOf || null, items: Array.isArray(recent.items) ? recent.items : [],
            conflicts: Array.isArray(recent.conflicts) ? recent.conflicts : [], sources: normalizeSources(recent.sources),
            stale: recent.asOf ? !Number.isFinite(Date.parse(recent.asOf)) || now - Date.parse(recent.asOf) > RECENT_TTL * 1000 : true,
            partial: Boolean(recent.partial), providerFailures: arrayStrings(recent.providerFailures), metrics: recent.metrics || null };
        if (Array.isArray(result.value?.providerFailures)) failures.push(...result.value.providerFailures.map(value => `recent-${value}`));
        attempts.recent.state = recent?.items?.length ? "success" : "empty";
        attempts.recent.identityLookupRequestCompleted = attempts.recent.identityLookupAttempted;
        if (result.value?.providerFailures?.length) attempts.recent.failureCategory = "partial_provider_failure";
        }
    } catch (error) { const category = error.kind || "upstream"; failures.push(`recent:${category}`);
        attempts.recent.state = "failed"; attempts.recent.failureCategory = category;
        attempts.recent.identityLookupRequestCompleted = error.identityLookupCompleted ??
            (attempts.recent.identityLookupAttempted && error.stage !== "identity_lookup");
        attempts.recent.providerErrorKeys = Array.isArray(error.providerErrorKeys) ? error.providerErrorKeys : [];
        attempts.recent.providerMessage = error.providerMessage || null;
        attempts.recent.providerMetrics = error.providerMetrics || null; }
    return { historical, recent, failures, cache: cacheStatus, attempts };
}

export function buildEvidence(context) {
    const knowledge = context.knowledge || { historical: null, recent: null, failures: [] };
    const scout = context.scout || { rating: null, confidence: "Low", disagreement: "unknown" };
    const historical = knowledge.historical;
    const career = historical?.seasons || [];
    const recentSeasons = [...career].sort((a, b) => String(b.season).localeCompare(String(a.season))).slice(0, 6);
    const advancedStats = recentSeasons.map(row => ({ season: row.season, club: row.club,
        competition: row.competition, minutes: row.minutes, xG: row.xG, xA: row.xA, shots: row.shots,
        shotsOnTarget: row.shotsOnTarget, keyPasses: row.keyPasses, progressiveCarries: row.progressiveCarries,
        progressivePasses: row.progressivePasses, tackles: row.tackles, interceptions: row.interceptions,
        saves: row.saves, savePercentage: row.savePercentage, postShotXG: row.postShotXG }));
    return { player: context.player, modelView: context.model, career, recentSeasons, advancedStats,
        currentContext: knowledge.recent?.stale ? [] : knowledge.recent?.items || [],
        currentContextAsOf: knowledge.recent?.asOf || null,
        currentContextStale: knowledge.recent?.stale ?? true,
        conflicts: knowledge.recent?.conflicts || [],
        competitionContext: [...new Set(career.map(row => [row.season, row.club, row.competition, row.country].filter(Boolean).join(" — ")))],
        scoutView: scout, confidence: { identity: historical?.identity?.confidence || "Unavailable",
            scout: scout.confidence, historicalAvailable: Boolean(career.length),
            currentAvailable: Boolean(knowledge.recent && !knowledge.recent.stale) },
        sources: dedupeSources([...(historical?.sources || []), ...(knowledge.recent?.sources || [])]),
        unavailableLayers: knowledge.failures || [] };
}

export function buildPrompt(question, contexts) {
    const rules = "Use only CONTEXT facts. Never invent statistics, fees, quotes, injuries, dates, prices, minutes or status. Mark unavailable facts as unavailable. Separate Model View from Ball Knowledge View and judgments from evidence. Cite sources with [S1]. Recent items marked stale must not be stated as current.";
    return `${rules} Treat null as unavailable, never as zero. Explain conflicting reports rather than choosing one without evidence. Scout Rating is experimental, not player ability.\nQUESTION: ${question}\nEVIDENCE: ${JSON.stringify(contexts.map(buildEvidence))}`;
}

function fallbackAnswer(context) {
    const p = context.player, m = context.model, s = context.scout;
    const lines = [`**Short verdict**\n${p.name} is a ${p.position} for ${p.club}. The live builder is the authority for the FPL figures below.`];
    lines.push(`**Model View**\nOverall: ${m.overall ?? "unavailable"}; projected points: ${m.projectedPoints ?? "unavailable"}; expected minutes: ${m.expectedMinutes ?? "unavailable"}; Value: ${m.value ?? "unavailable"}; price: ${m.price == null ? "unavailable" : `£${m.price}m`}.`);
    lines.push(`**Ball Knowledge View**\nScout Rating: ${s.rating ?? "unavailable"} (Confidence: ${s.confidence}). Model disagreement: ${s.disagreement}.`);
    if (context.knowledge.historical?.seasons?.length) lines.push(`**Career / production**\n${context.knowledge.historical.seasons.map(x =>
        `${x.season}: ${x.club}, ${x.competition || "competition unavailable"} — ${x.appearances ?? "?"} apps, ${x.starts ?? "?"} starts, ${x.minutes ?? "?"} minutes, ${x.goals ?? "?"} goals, ${x.assists ?? "?"} assists${x.xG != null ? `, ${x.xG} xG` : ""}${x.xA != null ? `, ${x.xA} xA` : ""}`).join("\n")}`);
    else lines.push("**Career / production**\nReliable deeper historical data is currently unavailable; I will not invent it.");
    if (context.knowledge.historical?.partial) lines.push("Recent historical data is available, but deeper retrieval is temporarily limited by the provider.");
    if (context.knowledge.recent && !context.knowledge.recent.stale) lines.push(`**Current situation** (as of ${context.knowledge.recent.asOf})\n${context.knowledge.recent.items.length ?
        context.knowledge.recent.items.map(item => `${item.date || "date unavailable"}: ${item.summary}`).join("\n") : "The provider returned no recent transfer or injury records."}${context.knowledge.recent.conflicts?.length ? `\nUncertainty: ${context.knowledge.recent.conflicts.map(item => item.note).join(" ")}` : ""}`);
    else lines.push("**Current situation**\nVerified recent context is unavailable or stale, so no current lineup, injury, transfer, or preseason claim is made.");
    lines.push("**Ball Knowledge verdict**\nThe Scout Rating is an experimental analytical signal only. It does not alter Overall, projected points, Value, or optimizer selections.");
    return lines.join("\n\n");
}

export async function answerWithProvider(question, contexts, env) {
    if (!env.LLM_API_URL || !env.LLM_API_KEY) return fallbackAnswer(contexts[0]);
    const response = await fetch(env.LLM_API_URL, { method: "POST", headers: {
        "content-type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({ model: env.LLM_MODEL || "gpt-4.1-mini", temperature: 0.2,
        messages: [{ role: "system", content: "You are Ball Knowledge, a careful football research analyst." },
            { role: "user", content: buildPrompt(question, contexts) }] }) });
    if (!response.ok) throw new Error(`Language provider returned ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || fallbackAnswer(contexts[0]);
}

export { cached, HISTORICAL_TTL, RECENT_TTL };
