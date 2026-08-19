#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const model = require("./model.js");

const TARGETS = ["Erling Haaland", "Bruno Fernandes", "Igor Thiago"];

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function playerName(player) {
    return [player.first_name, player.second_name].filter(Boolean).join(" ") || player.web_name;
}

function round(value) {
    return Number(value.toFixed(3));
}

export function validatePreseason(payload, minimumMinutes = 1800) {
    const currentById = new Map((payload.elements || []).map(player => [String(player.id), player]));
    const rows = (payload.previous_season_elements || []).flatMap(prior => {
        const current = currentById.get(String(prior.id));
        if (!current || number(prior.minutes) < minimumMinutes || number(prior.total_points) <= 0) return [];
        const preseasonPlayer = {
            ...current, starts: 0, minutes: 0, expected_goals: 0, expected_assists: 0, saves: 0
        };
        const projection = model.projectFixture(preseasonPlayer, null, {
            gamesPlayed: 0, fixturesLoaded: true, prior
        });
        const before = projection.mean - projection.components.bonusPoints +
            projection.components.otherDeduction;
        const appearances = Math.max(1, number(prior.appearances || prior.matches));
        return [{
            name: playerName(prior),
            position: model.POSITION[number(current.element_type)],
            minutes: number(prior.minutes),
            actualPerAppearance: round(number(prior.total_points) / appearances),
            actualPer90: round(90 * number(prior.total_points) / number(prior.minutes)),
            before: round(before),
            after: round(projection.mean),
            change: round(projection.mean - before),
            components: Object.fromEntries(Object.entries(projection.components)
                .map(([key, value]) => [key, round(value)]))
        }];
    });
    const positions = Object.fromEntries(["GK", "DEF", "MID", "FWD"].map(position => {
        const sample = rows.filter(row => row.position === position);
        const average = key => sample.length
            ? round(sample.reduce((sum, row) => sum + row[key], 0) / sample.length)
            : null;
        const mae = key => sample.length
            ? round(sample.reduce((sum, row) => sum + Math.abs(row[key] - row.actualPerAppearance), 0) /
                sample.length)
            : null;
        return [position, {
            players: sample.length,
            actualPerAppearance: average("actualPerAppearance"),
            actualPer90: average("actualPer90"), before: average("before"), after: average("after"),
            beforeMae: mae("before"), afterMae: mae("after")
        }];
    }));
    return {
        eligibility: { minimumMinutes, players: rows.length },
        positions,
        targets: TARGETS.map(name => rows.find(row => row.name === name) || { name, unavailable: true })
    };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const path = process.argv[2];
    if (!path) throw new Error("Usage: node validate-preseason.mjs <worker-payload.json> [minimum-minutes]");
    const report = validatePreseason(JSON.parse(fs.readFileSync(path, "utf8")),
        number(process.argv[3]) || 1800);
    console.log(JSON.stringify(report, null, 2));
}
