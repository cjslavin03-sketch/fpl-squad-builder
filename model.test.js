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

console.log("model tests passed");
