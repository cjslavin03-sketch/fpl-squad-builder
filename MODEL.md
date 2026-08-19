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

## Deliberately deferred sections

- A versioned historical-prior data store. Until it exists, conservative
  position priors are used before GW1 and shrunk with current-season exposure.
- A calibrated team-strength model and count-distribution simulation for exact
  clean-sheet, save-threshold and bonus points.
- Scenario-exact FPL autosub evaluation.
- Replacing the bounded beam search with an exact CP-SAT/MILP solver and an
  optimality-gap report.

These are separate migrations so each can be backtested without replacing the
entire builder in one change.

## Excluded fields

`ep_next`, `ep_this`, `form`, `points_per_game`, `total_points`, price and
ownership do not feed projected points. Ownership is only available to the
explicit differential strategy, and price remains a budget constraint plus a
replacement-value input.
