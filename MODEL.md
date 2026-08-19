# Analytics model v2 — staged rollout

This release is the first implementation section of the approved architecture.
It replaces the correlated player scoring pipeline while preserving the existing
single-page builder and its public rendering functions.

## Implemented in this section

- An independent fixture projection built from minutes, starts, availability,
  expected goals, expected assists, saves, position and fixture difficulty.
- Availability enters only through a discrete start/substitute/non-appearance
  minutes model.
- Expected goals and expected assists are converted to shrunk per-90 rates;
  goals, assists, xGI, ICT, threat and creativity are not added again.
- Fixture effects are separated into attack, clean-sheet and goalkeeper-save
  adjustments.
- Double gameweeks receive a conservative rotation haircut rather than two
  assumed full projections.
- Player outputs include mean, floor, ceiling, expected minutes, non-appearance
  probability and points above a positional replacement baseline.
- Automatic captain and vice-captain choices maximize expected captain bonus,
  including vice contingency and a same-club shared-risk haircut.
- Finished optimizer candidates are compared on a legal XI, captain/vice and
  probability-weighted bench utility rather than the sum of all 15 players.
- When the data source supplies `previous_season_elements`, the model uses each
  player's previous competitive minutes, starts, xG, xA and saves as a prior.
  Current-season exposure automatically receives more weight as it accumulates.

## Preseason bridge

The live worker does not currently guarantee a historical player snapshot. The
app therefore accepts competitive history either in `previous_season_elements`
or on a player's `previous_season` property, matched by stable player code where
possible. It never invents missing historical statistics.

When history is available, player-specific competitive rates distinguish an
established elite player from a fringe player before GW1. When it is absent,
the pre-v2 projection is retained as an explicitly temporary cold-start bridge.
That compatibility path may contain FPL's `ep_next`, or ultimately price and
ownership when every performance field is empty. It is not part of the
independent event model and fades linearly to zero by 720 current-season
minutes. Current injury availability and selected-fixture adjustments are
applied after selecting either prior path.

## Deliberately deferred sections

- Supplying and versioning the historical-prior snapshot at the worker. The
  browser-side schema and automatic current-season transition are implemented.
- A calibrated team-strength model and count-distribution simulation for exact
  clean-sheet, save-threshold and bonus points.
- Scenario-exact FPL autosub evaluation.
- Replacing the bounded beam search with an exact CP-SAT/MILP solver and an
  optimality-gap report. The current optimizer remains a temporary heuristic:
  Best Overall evaluates XI/captain/bench utility, but is not guaranteed to be
  the globally optimal legal squad.

These are separate migrations so each can be backtested without replacing the
entire builder in one change.

## Excluded fields

`ep_next`, `ep_this`, `form`, `points_per_game`, `total_points`, price and
ownership do not feed the independent event model. Ownership is otherwise only
available to the explicit differential strategy, and price remains a budget
constraint plus a replacement-value input. The temporary no-history preseason
bridge is the documented exception and is removed automatically as current
competitive minutes accumulate.
