"use strict";

const assert = require("node:assert/strict");
const model = require("./model.js");

const basePlayer = {
    id: 1,
    team: 1,
    element_type: 3,
    status: "a",
    chance_of_playing_next_round: null,
    starts: 6,
    minutes: 520,
    expected_goals: "1.8",
    expected_assists: "1.2",
    saves: 0,
    now_cost: 75,
    selected_by_percent: "30",
    form: "9.5",
    ep_next: "12"
};

const homeFixture = {
    team_h: 1,
    team_a: 2,
    team_h_difficulty: 2,
    team_a_difficulty: 4
};

const context = { gamesPlayed: 7, fixturesLoaded: true };

const baseline = model.projectFixture(basePlayer, homeFixture, context);
const sentimentChanged = model.projectFixture({
    ...basePlayer,
    now_cost: 130,
    selected_by_percent: "90",
    form: "0",
    ep_next: "0"
}, homeFixture, context);

assert.equal(
    baseline.mean,
    sentimentChanged.mean,
    "price, ownership, form and ep_next must not predict independent points"
);

const unavailable = model.projectFixture({
    ...basePlayer,
    status: "i",
    chance_of_playing_next_round: 0
}, homeFixture, context);
assert.equal(unavailable.expectedMinutes, 0);
assert.equal(unavailable.mean, 0);
assert.equal(unavailable.pZero, 1);

const easyDefender = model.projectFixture({ ...basePlayer, element_type: 2 }, homeFixture, context);
const hardFixture = { ...homeFixture, team_h_difficulty: 5 };
const hardDefender = model.projectFixture({ ...basePlayer, element_type: 2 }, hardFixture, context);
const easyKeeper = model.projectFixture({ ...basePlayer, element_type: 1, saves: 24 }, homeFixture, context);
const hardKeeper = model.projectFixture({ ...basePlayer, element_type: 1, saves: 24 }, hardFixture, context);
assert.ok(easyDefender.components.cleanSheetPoints > hardDefender.components.cleanSheetPoints);
assert.ok(hardKeeper.components.savePoints > easyKeeper.components.savePoints);

const single = model.projectGameweek(basePlayer, [homeFixture], context);
const double = model.projectGameweek(basePlayer, [homeFixture, homeFixture], context);
assert.ok(double.mean > single.mean);
assert.ok(double.mean < single.mean * 2, "double gameweeks include a rotation haircut");

const secure = { ...basePlayer, id: 2, team: 2, starts: 7, minutes: 620 };
const risky = { ...basePlayer, id: 3, team: 3, starts: 2, minutes: 210 };
const pair = model.captainPair([basePlayer, secure, risky], player =>
    model.projectFixture(player, homeFixture, context)
);
assert.ok(pair.captain);
assert.ok(pair.vice);
assert.notEqual(pair.captain.id, pair.vice.id);

const preseasonPlayer = {
    ...basePlayer,
    starts: 0,
    minutes: 0,
    expected_goals: 0,
    expected_assists: 0
};
const elitePrior = {
    matches: 34,
    starts: 32,
    minutes: 2780,
    expected_goals: 18,
    expected_assists: 9,
    saves: 0
};
const fringePrior = {
    matches: 25,
    starts: 4,
    minutes: 620,
    expected_goals: 0.5,
    expected_assists: 0.7,
    saves: 0
};
const elitePreseason = model.projectFixture(preseasonPlayer, homeFixture, {
    gamesPlayed: 0,
    fixturesLoaded: true,
    prior: elitePrior
});
const fringePreseason = model.projectFixture(preseasonPlayer, homeFixture, {
    gamesPlayed: 0,
    fixturesLoaded: true,
    prior: fringePrior
});
assert.ok(
    elitePreseason.mean - fringePreseason.mean > 1,
    "competitive priors must materially distinguish same-position players before GW1"
);

const scoringCompletePrior = {
    ...elitePrior,
    bonus: 30,
    bps: 720,
    yellow_cards: 4,
    red_cards: 1,
    own_goals: 0,
    penalties_missed: 1
};
const scoringComplete = model.projectFixture(preseasonPlayer, homeFixture, {
    gamesPlayed: 0, fixturesLoaded: true, prior: scoringCompletePrior
});
assert.ok(scoringComplete.components.bonusPoints > 0);
assert.ok(scoringComplete.components.otherDeduction > 0);
assert.ok(
    scoringComplete.components.bonusPoints > scoringComplete.components.otherDeduction,
    "established bonus production should survive conservative rare-event deductions"
);
assert.equal(
    scoringComplete.components.attackingPoints,
    elitePreseason.components.attackingPoints,
    "bonus and deductions must not double-count or alter xG/xA attacking points"
);

const cheapElite = model.projectFixture({
    ...preseasonPlayer,
    now_cost: 45,
    selected_by_percent: 1
}, homeFixture, { gamesPlayed: 0, fixturesLoaded: true, prior: elitePrior });
const expensiveElite = model.projectFixture({
    ...preseasonPlayer,
    now_cost: 140,
    selected_by_percent: 90
}, homeFixture, { gamesPlayed: 0, fixturesLoaded: true, prior: elitePrior });
assert.equal(
    cheapElite.mean,
    expensiveElite.mean,
    "price and ownership must not alter a competitive-prior projection"
);

function projectionWithPrior(prior, minutes, starts, gamesPlayed) {
    return model.projectFixture({
        ...preseasonPlayer,
        minutes,
        starts,
        expected_goals: minutes / 450,
        expected_assists: minutes / 900
    }, homeFixture, { gamesPlayed, fixturesLoaded: true, prior });
}
const smallSamplePriorGap = Math.abs(
    projectionWithPrior(elitePrior, 90, 1, 1).mean -
    projectionWithPrior(fringePrior, 90, 1, 1).mean
);
const largeSamplePriorGap = Math.abs(
    projectionWithPrior(elitePrior, 1800, 20, 20).mean -
    projectionWithPrior(fringePrior, 1800, 20, 20).mean
);
assert.ok(
    largeSamplePriorGap < smallSamplePriorGap * 0.5,
    "current-season performance must increasingly outweigh prior-season performance"
);

const displayRating = mean => model.displayRatings({
    mean,
    ceiling: mean + 3,
    expectedMinutes: 80,
    availability: 1,
    priorSource: "position"
}, { valueAboveReplacement: 0, seasonMinutes: 900 }).overall;
const representativeRatings = [2.5, 4, 5.5, 7].map(displayRating);
assert.deepEqual(
    representativeRatings,
    [55.6, 74, 83.8, 90.4],
    "representative one-match projections should have intuitive display ratings"
);
assert.ok(representativeRatings[0] < 62, "2.5 expected points must not look elite");
assert.ok(representativeRatings[1] >= 70, "4 expected points should look solid");
assert.ok(representativeRatings[2] >= 82, "5.5 expected points should look very strong");
assert.ok(representativeRatings[3] >= 88, "7 expected points should look elite");
assert.ok(representativeRatings.every((rating, index, ratings) =>
    index === 0 || rating > ratings[index - 1]
), "Overall display calibration must be monotonic");

const calibratedDisplays = model.displayRatings({
    mean: 5.5,
    ceiling: 9,
    expectedMinutes: 82,
    availability: 1,
    priorSource: "previous-season"
}, { valueAboveReplacement: 1, seasonMinutes: 900 });
assert.ok(calibratedDisplays.valueScore >= 70);
assert.ok(calibratedDisplays.minutesScore >= 90);
assert.ok(calibratedDisplays.upside >= 85);
assert.ok(calibratedDisplays.confidence >= 80);

console.log("model tests passed");
