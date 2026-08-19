# Production audit

This audit reviews the current single-page application as an FPL squad builder and gameweek simulator. Risk describes the risk of implementing the recommendation, not the severity of the underlying issue. Only the low-risk fixes explicitly marked **Implemented** were made in this pass.

## 1. Critical bugs

| Finding and recommendation | Why it matters | Risk | User-visible? | Status |
|---|---|---:|:---:|---|
| Player cards registered both an inline click handler and an `addEventListener`; use one event path. | One click could add and immediately remove the same player (or vice versa), making selection appear broken. | Low | Yes | **Implemented** |
| Fixture API failure was treated as a blank gameweek; fall back to an unweighted projection when fixture data did not load. | A temporary secondary API failure made every player project zero despite player data loading successfully. A genuine blank still projects zero when fixture data was loaded. | Low | Yes | **Implemented** |
| Auto formation read a nonexistent `player.analytics.projectedPoints`, then fell back to season total points. Use the selected-GW projection. | “Auto” could choose a formation based on historic totals rather than the simulated gameweek. | Low | Yes | **Implemented** |
| The bench retained squad insertion order. Put the substitute goalkeeper first and rank outfield substitutes by selected-GW projection. | The displayed bench did not represent the best automatic substitution order. | Low | Yes | **Implemented** |
| API strings were interpolated into player-card HTML. Escape names, team names, and news (and ultimately migrate all cards to DOM text nodes). | Upstream text could corrupt markup or become an injection route. The highest-exposure player-list fields are now escaped; pitch/bench rendering should still be migrated. | Low | No, except malformed data | **Partially implemented** |
| `localStorage.setItem/removeItem` failures propagated into squad actions. Catch storage failures and keep the in-memory app usable. | Storage can be unavailable because of browser policy, quota, or privacy mode; selection should still work. | Low | Only on storage failure | **Implemented** |
| Saved squads are rehydrated but not explicitly revalidated for duplicate IDs, positional quotas, club quota, or budget. Add a shared legality validator and discard/report invalid entries. | Corrupt or manually edited storage can create a state the UI could not otherwise produce. | Low | Only for invalid saves | Recommended |
| The hard-coded worker is a single point of failure and has no timeout/retry/cache-age indicator. Add an abort timeout, retry action, and last-updated state; retain partial-data fallback. | A hung request leaves the app in loading state and users cannot distinguish stale, partial, and current data. | Low | Yes | Recommended |

## 2. Analytics/model issues

These recommendations are intentionally **not implemented** because they can materially alter ratings, projections, strategy output, or optimizer selections.

| Finding and recommendation | Why it matters | Risk | User-visible? |
|---|---|---:|:---:|
| Attacking score mixes cumulative goals, assists, xG, xA, xGI, threat, creativity, and bonus. Convert season totals to per-90/rate statistics with sample shrinkage and remove overlapping inputs (xGI already contains xG+xA; ICT also overlaps threat/creativity). | Productive players are counted repeatedly, while cumulative totals increasingly overwhelm new players as the season advances. The scale is not stable between GW1 and GW38. | High | Yes |
| Clean sheets and saves are added as cumulative bonuses to a one-game projection. Replace with opponent- and position-specific expected clean-sheet/save components, normalized per appearance. | A season-to-date count is not an expectation for the next fixture and causes projections to drift upward through the season. | High | Yes |
| `ep_next`, which is already an expected-points estimate, is adjusted again by the app’s minutes/availability model and fixture multiplier. Establish whether it is the baseline or build an independent model; do not layer partially duplicated adjustments without validation. | Availability and fixture context may be double-counted, producing falsely precise projections. | High | Yes |
| Availability affects `minutesScore`, then `playingFactor`; minutes and availability also appear again in overall and several strategies. Separate conditional points-if-starting from appearance probability and combine once. | Doubtful players can be penalized multiple times, and “safe” strategy amplifies the same signal again. | High | Yes |
| The no-data fallback uses price and ownership to predict points, and value then divides that projection by price. Replace with position/price priors calibrated on historical seasons and label uncertainty. | Price both raises projected points and is used as its denominator; ownership is crowd sentiment rather than football performance. This can create circular ratings and herd bias. | High | Yes |
| Value is a capped linear points-per-million score without replacement-level or position context. Model marginal points above a viable positional baseline per extra £m. | Cheap low-ceiling players can look artificially efficient, while premiums’ captaincy and scarcity value is missed. | High | Yes |
| The overall display score is manually remapped (`35 + raw × .65`) and floored at 25. Publish component definitions and calibrate against out-of-sample FPL outcomes rather than desired-looking ranges. | The label `/100` implies an interpretable probability/quality scale, but the current score is presentation-driven. | Medium | Yes |
| Fixture difficulty applies the same scalar to all positions and player archetypes, plus a flat home bonus. Validate separate attacking and clean-sheet fixture effects, ideally against bookmaker-free historical FPL data. | A difficult opponent affects a goalkeeper’s saves, a defender’s clean-sheet chance, and a forward’s scoring differently. | High | Yes |
| Double-gameweek projection simply sums full single-fixture multipliers. Model expected minutes/rotation across fixtures. | Players unlikely to start twice are systematically overrated. | High | Yes |
| Captain and vice captain are the top two point estimates. Consider appearance probability, ceiling, and vice-captain contingency, and explain the recommendation. | The best mean projection is not always the best captain once non-appearance and haul distribution are considered; vice should hedge captain non-appearance. | Medium | Yes |
| Optimizer maximizes the summed score of all 15 players rather than optimizing the best legal XI, captain, bench utility, and remaining budget. Redesign the objective only after agreeing on strategy semantics. | It may overspend on bench points and return a worse starting XI even when called “Best Overall.” | High | Yes |
| Beam search truncates each position to 45 score leaders plus 15 cheapest and keeps only 300 partial states. Add deterministic tests and compare with an exact integer-programming/brute-force benchmark on reduced datasets before tuning. | It is a heuristic and can discard the globally optimal legal squad; no optimality gap is reported. | Medium | Yes |
| Seven strategies use different weights, but many inputs are strongly correlated or derived from one another. Measure squad overlap and outcome sensitivity; define each strategy as a clear football/FPL objective. | “Attack” and “Upside” both emphasize overlapping attacking inputs; “Safe” repeats reliability embedded in projection; “Balanced” and “Overall” may differ mostly cosmetically. | High | Yes |
| “Attack Heavy” cannot change mandatory positional counts and does not explicitly favor an attacking starting formation; it only changes player scoring. Rename it or incorporate XI/formation intent in a redesigned optimizer. | The strategy description can promise a structurally attack-heavy squad that FPL rules and the current objective do not express. | Medium | Yes |

## 3. UX/design improvements

| Finding and recommendation | Why it matters | Risk | User-visible? | Status |
|---|---|---:|:---:|---|
| Inputs lacked accessible names, filter buttons relied only on visual state, and focus was not prominent. Add labels/ARIA state and `:focus-visible`. | Keyboard and screen-reader users need clear control names, state, and focus. | Low | Yes | **Partially implemented** |
| Status updates were not announced and used `innerHTML`. Make the status a polite live region and assign text only. | Loading/failure feedback becomes accessible and cannot inject error text as markup. | Low | Minimal | **Implemented** |
| Player cards expose a very long list with no pagination/virtualization and dense analytics on mobile. Add a compact summary with expandable details and a sticky filter/squad summary. | Scanning hundreds of large cards is slow and cumbersome, particularly on phones. | Medium | Yes | Recommended |
| Alerts are blocking and disappear without context. Replace them with an inline, focus-managed validation summary while retaining concise card feedback. | Users need to understand and recover from budget, club, and positional errors. | Low | Yes | Recommended |
| Strategy descriptions do not disclose data assumptions or distinguish current-GW optimization from season planning. Add an explanation panel and model-version/date label. | Users may treat experimental scores as authoritative advice. | Low | Yes | Recommended |
| The “Projected” summary includes the captain bonus but does not say so, while player cards show a non-gameweek base projection. Rename labels and add tooltips. | Identically named metrics currently refer to different calculations. | Low | Yes | Recommended |
| Pitch cards and controls need testing at 320px, 400% zoom, and with long player/news strings. Allow safe wrapping and avoid fixed visual density. | Current responsive breakpoints change columns but do not guarantee readable pitch rows or zoom reflow. | Low | Yes | Recommended |
| Locks are not visible on the pitch and can remain in the lock set after a player is removed. Clear a removed player’s lock or expose lock state consistently. | Users may not understand what the optimizer will preserve. | Low | Yes | Recommended |

## 4. Performance/code-quality improvements

| Finding and recommendation | Why it matters | Risk | User-visible? | Status |
|---|---|---:|:---:|---|
| Two `renderSquad` declarations existed; the first was silently replaced through function hoisting. Remove the dead implementation. | Duplicate authoritative logic is misleading and easy to edit incorrectly. | Low | No | **Implemented** |
| Player selection had two separate implementations (`togglePlayer` and add/remove helpers). Retain one validated path. | Duplicated legality logic had already caused divergent save behavior and the double-click bug. | Low | No | **Implemented** |
| `calculateAnalytics`, fixture lookup, gameweek projection, and rating are repeatedly recomputed during sorting, rendering, captain selection, formation selection, summaries, and optimizer expansion. Cache immutable analytics per data refresh and GW projections per player/GW; invalidate on refresh. | Current rendering and beam search perform large amounts of identical work and repeatedly scan every fixture. | Low | No (faster) | Recommended |
| Fixture lookup filters the full fixture list for every player calculation. Index fixtures by `event` and `team`. | This turns repeated O(fixtures) scans into constant-time lookups. | Low | No (faster) | Recommended |
| `updateSquadStats` and `updateSquadSummary` overlap, and the latter uses season points while its DOM IDs imply projections/ratings. Remove the dead function after confirming no external consumers. | Dead competing definitions invite future regressions and confuse metric meaning. | Low | No | Recommended |
| A 6,000-line HTML file mixes structure, styles, data access, model, optimizer, storage, and rendering. Extract modules incrementally (without a rewrite) behind tests. | Separation would make model review, caching, error handling, and regression testing practical. | Medium | No |
| There is no automated test/build setup. Add fixture-based unit tests for legality, projections, blanks/doubles, formations, captaincy, storage migration, and optimizer determinism. | Syntax checking alone cannot protect FPL rules or mathematical behavior. | Low | No | Recommended |
| Inline templates still interpolate API values on pitch and bench. Migrate remaining UI generation to `textContent`/DOM construction. | A single escaping omission can reintroduce markup injection. | Low | Only malformed data | Recommended |

## 5. Nice-to-have future features

| Feature | Why it matters | Risk | User-visible? |
|---|---|---:|:---:|
| Multi-gameweek planning with configurable horizon, transfer count, and discounted future points. | A one-GW squad is not the same as a good medium-term FPL squad. | High | Yes |
| Import an FPL team by public entry ID, clearly separating purchase/sale value and money in the bank from a fresh £100m draft. | Transfer planning requires actual sale prices and budget, unlike initial squad building. | High | Yes |
| Scenario comparison and explanation (“why this player/formation/captain?”), including score components and uncertainty bands. | Transparent recommendations are more useful and trustworthy than a single opaque rating. | Medium | Yes |
| Data freshness timestamp, offline last-good snapshot, retry button, and schema validation. | Live-data failures become understandable and recoverable. | Medium | Yes |
| Share/export squads through a compact URL or JSON, plus explicit storage reset/migration. | Users can move squads between devices and recover from schema changes. | Low | Yes |
| Accessibility regression testing (axe), keyboard-only flows, reduced-motion support, and high-contrast verification. | Prevents accessibility regressions as the interface grows. | Low | Yes |
