# fpl-squad-builder
Fantasy Premier League squad builder and simulator

## Ball Knowledge

Ball Knowledge is the builder's football research chat drawer. It uses three deliberately
separate layers:

1. **Live Builder/Model View** — the browser sends the exact currently displayed price,
   club, position, availability, fixture, expected minutes, projected points, Overall and
   Value. These figures remain authoritative and external providers may not replace them.
2. **Historical football** — the built-in API-Football provider (or a custom adapter) supplies normalized
   season rows (club, competition, appearances, starts, minutes, goals, assists, xG and
   xA where reliably available), international context, and HTTPS source links. A missing
   field remains `null`; it is never estimated just to complete a biography.
3. **Recent context** — a separate adapter supplies dated, sourced transfers, injuries,
   suspensions, selection, tactical role, manager usage and preseason context. Items older
   than the 30-minute current-context TTL are marked stale and cannot be presented as current.

The retrieval pipeline resolves names (accent folding, surname queries, common aliases and
small spelling errors), detects whether the question needs model-only, historical, or recent
retrieval, normalizes provider output, constructs a compact evidence object, and finally asks
the configured language provider to answer only from that object. Conversation player IDs,
or the selected squad as fallback, resolve follow-ups such as “why is he so low?”. Historical
profiles cache for 30 days; recent context caches for 30 minutes. Cloudflare's existing player
payload remains cached independently for six hours.

### Model View versus Ball Knowledge View

**Model View** is the existing quantitative projection. **Ball Knowledge View** is an
independent, experimental scouting presentation. The initial **Scout Rating** combines the
latest reliable per-90 goal/assist production (65%) with the builder's expected-minutes
opportunity (35%). Confidence is Low when history is thin, Medium with at least two usable
season samples, and High only with three samples plus recent context. A rating is withheld
rather than fabricated when no season has at least 180 minutes.

A Scout Rating at least eight points above Overall is a `positive` disagreement; eight below
is `negative`; smaller gaps are `aligned`. This prepares cohort queries for later iterations.
The rating is intentionally simple and should not be read as precise player ability. Most
importantly, **Scout Rating and chat judgment do not change projected points, Overall, Value,
optimizer selection, squad legality, or quantitative transfer recommendations**. The code
operates on a copy of the displayed model values and the optimizer remains untouched.

### Built-in providers and secrets

All provider calls happen in the Worker; no secret is shipped to the browser. The production-ready
default is [API-Football](https://www.api-football.com/documentation-v3), selected because its
structured player, season, transfer and injury endpoints cover many domestic and international
competitions behind one stable identity. Optional recent journalism comes from
[NewsAPI's Everything endpoint](https://newsapi.org/docs/endpoints/everything); its article URLs,
publishers and publication dates remain attached to the evidence. Configure these Cloudflare
Worker secrets/variables:

| Variable | Purpose |
| --- | --- |
| `FOOTBALL_DATA_PROVIDER` | `api-football` (default) or `none`. |
| `FOOTBALL_CONTEXT_PROVIDER` | `api-football` (default) or `none`. |
| `FOOTBALL_DATA_API_KEY` | API-Football key from the provider dashboard; required by the built-in provider and stored only as a Worker secret. `API_FOOTBALL_KEY` is accepted as an alias. |
| `API_FOOTBALL_BASE_URL` | Optional API-Football-compatible base URL, primarily for testing. |
| `FOOTBALL_CURRENT_SEASON` | Optional season-start year override; normally inferred in UTC. |
| `FOOTBALL_HISTORY_SEASONS` | Free-tier ceiling for automatic recent history, default 3; normal intent requests 1–2 seasons. |
| `FOOTBALL_API_MIN_INTERVAL_MS` | Minimum spacing for serialized API-Football calls, default 1000 ms. |
| `FOOTBALL_API_RATE_LIMIT_COOLDOWN_MS` | Cooldown after a provider rate limit, default 90000 ms. |
| `FOOTBALL_CONTEXT_API_KEY` | Optional NewsAPI key for recent reputable reporting. Keep it server-side. |
| `FOOTBALL_NEWS_DOMAINS` | Optional comma-separated NewsAPI domain allowlist for trusted club/league/journalism sources. |
| `FOOTBALL_DATA_URL` | Optional custom adapter override (`/history?name=...`); takes precedence over the built-in provider. |
| `FOOTBALL_CONTEXT_URL` | Optional custom adapter override (`/recent?name=...`); takes precedence over the built-in provider. |
| `FOOTBALL_DATA_KEY` | Optional bearer credential for custom adapters only. |
| `LLM_API_URL` | OpenAI-compatible server-side chat-completions endpoint. |
| `LLM_API_KEY` | Language-provider bearer credential. |
| `LLM_MODEL` | Swappable provider model name (defaults to `gpt-4.1-mini`). |
| `BALL_KNOWLEDGE_LOGGING` | Set to `true` for concise provider/cache/latency diagnostics; questions and credentials are never logged. |

API-Football and NewsAPI both publish plan details on their websites; limits and production-use
terms change, so verify the current plan before deployment. Retrieval is intent-aware, serialized,
individually cached, and described in the free-tier section below. The application does not scrape
or blindly inject search pages. Every external source carries a category and the evidence it
supports; reporting also has a publisher, article URL, and publication date.

With no external configuration the chat still resolves players and gives a grounded Model View,
explicitly labels historical/current facts unavailable, and never invents them. Historical or
news failure degrades only that layer. Language-provider failure falls back to a deterministic
answer; squad-builder state is preserved, and the UI offers retry by resubmitting the question.

### Adapter shapes

History returns identity confidence and signals plus `{ birthDate, age, nationality, positions,
seasons: [{ season, club, league, competition, country, appearances, starts, minutes, position,
goals, assists, shots, shotsOnTarget, keyPasses, passes, passAccuracy, tackles, blocks,
interceptions, duels, duelsWon, dribblesCompleted, cards, saves, goalsConceded, xG, xA, ... }],
international, sources }`. Unsupported advanced fields—including xG/xA when the selected feed
does not supply them—remain `null`, never zero. Recent context returns `{ asOf, items, conflicts,
sources }`; transfer and injury records are structured, while journalism is explicitly labelled
`reported`. Sources are `{ title, url, publishedAt, category, supports }`; only HTTPS links survive
normalization. Add another provider behind these shapes rather than coupling UI or prompts to a
proprietary response.

Identity matching ranks full name, date of birth, current club, nationality and position. A weak
match is rejected and near-tied common-name candidates are treated as ambiguous; identity
confidence flows into the evidence summary and Scout confidence. The compact LLM evidence object
contains Model View, full career rows, six recent season/competition rows, available advanced
metrics, non-stale current items, conflicts, Scout View, confidence, missing layers and deduplicated
sources—not raw provider payloads or HTML.

### Deployment and production smoke test

The frontend and Worker are configured for the same production Worker,
`jolly-glitter-bb07.cjslavin03.workers.dev`. Deploy from the repository root with `npx wrangler
deploy`. Non-secret provider defaults live under `[vars]` in `wrangler.toml`; install credentials
without writing them to a file:

```sh
npx wrangler secret put FOOTBALL_DATA_API_KEY
npx wrangler secret put FOOTBALL_CONTEXT_API_KEY # optional NewsAPI reporting
npx wrangler secret put LLM_API_KEY              # optional with LLM_API_URL/LLM_MODEL vars
```

Use `npx wrangler secret list` to verify names (secret values are never printed). After deployment,
run `node smoke-ball-knowledge.mjs`. Override the target safely with
`BALL_KNOWLEDGE_ENDPOINT=https://... node smoke-ball-knowledge.mjs`; the script contains no keys,
loads the target's live FPL payload, exercises Tzolis, Haaland, Bruno, a defender, goalkeeper and
budget midfielder, and reports resolved identity, Model View, evidence presence, source count,
Scout confidence, cache status, answer mode, and failure categories.

Free-tier defaults avoid the previous cold-query fan-out of one identity search, one season-list
call, six concurrent season calls, transfers, and injuries (up to 11 API-Football calls). Normal
history now directly fetches the two most recent completed seasons: one identity plus two sequential
season calls (3 calls cold), with no season-list request. “Last season” costs 2 calls, while an
explicit full-career request progressively uses the cached season list and up to six seasons.
Model-only questions cost zero research calls. Transfers and injuries are independently requested
only when their sub-intent requires them; role/underrating questions can use trusted news without
spending API-Football current-context quota.

API-Football requests are serialized and spaced by `FOOTBALL_API_MIN_INTERVAL_MS` (1000 ms by
default), with identical in-flight requests coalesced. Identity caches for 7 days; each player-season
and available-season list for 30 days; transfers for 6 hours; injuries for 45 minutes. A rate-limit
response starts a 90-second isolate-local cooldown and is never permanently cached. Successful
season rows survive a later rate limit as a partial, Low-confidence profile. Smoke/debug output
exposes attempted, cached, coalesced, and rate-limited call counts without URLs or credentials.

### Manual evaluation checklist

Use Tzolis (new-club/translation and minutes uncertainty), Haaland (elite established forward),
Bruno Fernandes (career and role), an established defender, a goalkeeper, and an obscure budget
player. A configured data adapter must supply the evidence for career claims—including PAOK,
Norwich, loans, Club Brugge, European production, transfers and preseason in Tzolis's case.
Without a configured API-Football key, the correct example answer is the conservative fallback: live model figures are
shown, deeper history/current context is declared unavailable, Scout Rating confidence is
reduced, and no Arsenal transfer, fee, selection, injury, or statistic is asserted.
