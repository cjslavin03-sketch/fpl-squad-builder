# Preseason projection compression diagnosis

> This document records the pre-upgrade baseline. The scoring-completeness
> implementation now adds conservatively shrunk bonus/BPS and rare-event
> deductions; see `MODEL.md` and `validate-preseason.mjs` for the current model
> and reproducible before/after report.

## Scope and evidence

This is a diagnosis only. It does not change the projection or display calibration.
It traces the current implementation and uses the three reported live observations.
The live payload retains prior minutes, starts, xG, xA and saves, but discards the
other historical fields needed to reconstruct an exact prior-season FPL scorecard.
Consequently, the app cannot currently produce a numeric goal/assist/bonus/card
reconciliation from its own payload. That data loss is itself one of the findings;
values not retained must not be invented.

| Player | Position | Prior points | Prior PPG | Prior minutes | Projected | Projection minus prior PPG | Retained prior PPG |
|---|---:|---:|---:|---:|---:|---:|---:|
| Erling Haaland | FWD | 239 | 6.8 | 2,953 | 4.8 | -2.0 | 71% |
| Bruno Fernandes | MID | 235 | 6.7 | 3,065 | 4.5 | -2.2 | 67% |
| Igor Thiago | FWD | 181 | 4.8 | 3,282 | 4.2 | -0.6 | 88% |

Haaland's prior advantage over Thiago is 2.0 points per appearance, but the
projection retains only 0.6 (30%). Bruno's 1.9 advantage becomes 0.3 (16%). The
compression to explain is therefore 1.4 and 1.6 points respectively. This is
not a `/100` display effect: it exists in the independent expected-point mean.

`points_per_game` is per appearance, not per 90. For established players a
second comparison should use `90 * total_points / minutes`; the worker does not
retain enough scoring fields to decompose that rate, and the UI does not expose
it. The raw prior row should be retained for a position-stratified backtest
(minimum suggested eligibility: 1,800 minutes), reporting actual points per
appearance and per 90 beside the neutral-fixture preseason prediction.

## What the model actually scores

For one fixture, the returned decomposition is exactly:

```
mean = appearance
     + goal points + assist points
     + clean-sheet points
     + goalkeeper save points
     - generic goals-conceded deduction
```

The player-level details are:

| Component | Haaland | Bruno Fernandes | Igor Thiago |
|---|---|---|---|
| Appearance | `P(appears) + P(plays 60+)` | same | same |
| Goals | `4 * shrunk_xG90 * expected_minutes / 90 * attack_FDR` | `5 * ...` | `4 * ...` |
| Assists | `3 * shrunk_xA90 * expected_minutes / 90 * attack_FDR` | same | same |
| Clean sheets | 0 (FWD) | `P(60+) * generic_CS_probability` (MID: 1 point) | 0 (FWD) |
| Saves | 0 | 0 | 0 |
| Bonus/other | **0** | **0** | **0** |
| Deductions | **0** (FWD) | **0** (MID) | **0** (FWD) |

Thus, for all three reported players, every projected point beyond appearance
(and Bruno's small generic clean-sheet term) must come from xG and xA. The live
rounded means alone are insufficient to split attacking points into goals and
assists; that requires the retained xG/xA and fixture. The app already returns
`appearancePoints`, aggregate `attackingPoints`, `cleanSheetPoints`,
`savePoints`, and `concededDeduction`, but it does not separately return goal
and assist points.

The missing scoring terms are not merely unreported in the decomposition. They
are absent from the mean:

- bonus points/BPS expectation;
- yellow and red cards, own goals and missed penalties;
- penalty saves (ordinary saves are included for goalkeepers);
- the applicable FPL defensive-contribution points;
- FPL assists that are not represented by the provider's expected-assists
  definition; and
- exact goals-conceded deductions (the model uses a generic fractional proxy
  only for goalkeepers and defenders).

## Root cause

### 1. The prior transports chances, not FPL productivity

Previous-season `total_points` and `points_per_game` never enter the independent
model. The worker transports only starts, appearances, minutes, xG, xA and
saves. A player's repeatable ability to outperform xG, create FPL assists not
captured by xA, earn BPS/bonus, take penalties, and earn defensive-contribution
points is therefore reset to zero (or to the same positional assumption) at
GW1.

This explains why the ordering can be sensible while the scale is compressed:
xG/xA ranks attackers reasonably, but appearance points form a large common
base and all omitted sources of player-level separation contribute exactly
zero. Bruno's especially large 2.2-point gap is consistent with a model that
recognizes chance creation but not his broader FPL scoring routes and bonus
profile. This is a structural omission, not evidence that he should receive an
ad-hoc elite multiplier.

### 2. Clean-sheet probability is generic

The base clean-sheet probability is 0.28 for goalkeepers/defenders and 0.25 for
midfielders, adjusted only by fixture difficulty and venue. It has no club
strength, opponent scoring rate, projected lineup or bookmaker-free historical
team rate. All same-position teammates receive the same probability. This
compresses defenders and goalkeepers across clubs; among the three examples it
only adds a small, generic midfield term to Bruno and cannot restore individual
quality separation.

### 3. Established-player performance shrinkage is not the main culprit

The prior xG/xA rate is shrunk toward the position cohort with three pseudo-90s.
For the reported minute totals (32.8--36.5 90s), the cohort weights are only
about 8.4%, 8.1% and 7.6%. At preseason the resulting player rate is then passed
through unchanged: the second shrink function receives no current-season data
and returns that performance prior. Therefore the attacking-rate shrinkage is
modest, not enough by itself to explain loss of 70--84% of the observed PPG
spread.

Minutes are more strongly regularized. Prior start rates use at most ten prior
matches plus three cohort matches, so a full established season is treated like
only ten matches. This can unnecessarily compress expected minutes and
appearance points, although it cannot explain the missing bonus/other scoring.
There is also a data-quality risk: historical `starts` must be validated, since
missing/zero starts can force a legitimate regular toward the cohort start
rate.

### 4. xG/xA-only modeling deliberately regresses finishing and creation to zero

Avoiding double-counting xG with goals is correct, but excluding goals entirely
implicitly assumes no persistent finishing signal. A conservative empirical
Bayes residual (goals minus xG), penalty-role model, and an assist residual
calibrated to the official FPL assist definition can preserve only the portion
shown to repeat out of sample. The same principle applies to bonus: model
expected BPS/bonus from underlying events and a shrunk player residual rather
than adding last season's bonus wholesale.

## Smallest principled changes, in order

1. **Retain and audit before changing predictions.** Extend the historical
   snapshot with goals, assists, clean sheets, goals conceded, bonus/BPS,
   cards, own goals, penalties missed/saved, defensive contributions and total
   points. Add an offline position-stratified calibration report with component
   residuals, MAE/calibration slope, and actual points per appearance and per
   90. This is observability, not a model inflation.
2. **Complete the scoring identity.** Add population-calibrated expectations for
   bonus, cards, own goals, penalty events and defensive contributions. Start
   with positional/base rates where player evidence is weak, and shrink
   player-specific rates by event opportunity. Report every term separately.
3. **Add only validated repeatable residuals.** Backtest finishing over xG,
   official-assist over xA, penalty share and bonus/BPS residuals across seasons.
   Apply empirical-Bayes shrinkage based on relevant attempts/actions, not an
   elite-player flag or prior total points multiplier.
4. **Replace generic clean sheets with a team/opponent goal model.** Estimate
   team attack/defence strengths and derive clean-sheet and two-goals-conceded
   probabilities from a count distribution. This principally fixes GK/DEF
   calibration and should precede tuning their player priors.
5. **Relax only the minutes cap if validation supports it.** Use more than ten
   prior matches for established players (with recency weighting), explicitly
   distinguish transfers/manager changes, and validate missing `starts`.

Do not tune the display mapping or multiply the three named players. Acceptance
should be based on held-out positional calibration: a regression of next-season
actual points/90 on preseason expected points/90 should have a materially
non-zero player-quality slope, sensible residuals by scoring component, and no
systematic elite-only uplift after accounting for minutes and role.
