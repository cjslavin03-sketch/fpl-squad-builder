import assert from "node:assert/strict";
import { validatePreseason } from "./validate-preseason.mjs";

const names = [
    ["Alisson", "Becker"], ["David", "Raya"], ["Jordan", "Pickford"],
    ["Virgil", "van Dijk"], ["William", "Saliba"], ["Josko", "Gvardiol"],
    ["Bruno", "Fernandes"], ["Mohamed", "Salah"], ["Cole", "Palmer"],
    ["Erling", "Haaland"], ["Igor", "Thiago"], ["Ollie", "Watkins"]
];
const elements = names.map(([first_name, second_name], index) => ({
    id: index + 1, first_name, second_name, web_name: second_name,
    element_type: Math.floor(index / 3) + 1, team: 1, status: "a",
    chance_of_playing_next_round: null
}));
const previous_season_elements = elements.map((player, index) => ({
    id: player.id, first_name: player.first_name, second_name: player.second_name,
    web_name: player.web_name, minutes: 2400 + index * 40, starts: 28,
    matches: 32, appearances: 32, total_points: 120 + index * 9,
    expected_goals: player.element_type < 3 ? 2 : 8 + index,
    expected_assists: player.element_type < 3 ? 3 : 5 + index / 2,
    saves: player.element_type === 1 ? 95 : 0,
    bonus: 10 + index * 2, bps: 450 + index * 20,
    yellow_cards: index % 5, red_cards: index === 4 ? 1 : 0,
    own_goals: index === 3 ? 1 : 0, penalties_missed: index === 9 ? 1 : 0
}));

const report = validatePreseason({ elements, previous_season_elements });
assert.equal(report.eligibility.players, 12);
assert.deepEqual(Object.values(report.positions).map(position => position.players), [3, 3, 3, 3]);
assert.ok(Object.values(report.positions).every(position => position.before !== null && position.after !== null));
assert.deepEqual(report.targets.map(target => target.name),
    ["Erling Haaland", "Bruno Fernandes", "Igor Thiago"]);
assert.ok(report.targets.every(target => target.components.bonusPoints > 0));
assert.ok(report.targets.every(target =>
    Math.abs(target.after - target.before - target.change) < 0.002));

console.log("preseason validation tests passed: 12 established players, 3 per position");
