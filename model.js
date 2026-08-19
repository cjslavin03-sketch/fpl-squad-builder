(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    root.FPLModel = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const POSITION = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
    const GOAL_POINTS = { GK: 6, DEF: 6, MID: 5, FWD: 4 };
    const CLEAN_SHEET_POINTS = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
    const PRIORS = {
        GK: { start: 0.72, startMinutes: 90, subMinutes: 0, xG90: 0.001, xA90: 0.002, saves90: 3.0 },
        DEF: { start: 0.68, startMinutes: 82, subMinutes: 14, xG90: 0.05, xA90: 0.08, saves90: 0 },
        MID: { start: 0.65, startMinutes: 79, subMinutes: 18, xG90: 0.18, xA90: 0.16, saves90: 0 },
        FWD: { start: 0.62, startMinutes: 77, subMinutes: 20, xG90: 0.32, xA90: 0.12, saves90: 0 }
    };
    const ATTACK_FDR = { 1: 1.18, 2: 1.09, 3: 1, 4: 0.91, 5: 0.82 };
    const CLEAN_SHEET_FDR = { 1: 1.30, 2: 1.14, 3: 1, 4: 0.78, 5: 0.58 };
    const SAVE_FDR = { 1: 0.82, 2: 0.91, 3: 1, 4: 1.10, 5: 1.20 };

    function number(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function clamp(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    function availability(player) {
        if (["i", "s", "u"].includes(player.status)) return 0;
        if (player.chance_of_playing_next_round !== null &&
            player.chance_of_playing_next_round !== undefined) {
            return clamp(number(player.chance_of_playing_next_round) / 100, 0, 1);
        }
        return player.status === "a" || !player.status ? 1 : 0.75;
    }

    function minutesDistribution(player, context) {
        const position = POSITION[number(player.element_type)] || "MID";
        const prior = PRIORS[position];
        const gamesPlayed = Math.max(0, number(context && context.gamesPlayed));
        const starts = clamp(number(player.starts), 0, Math.max(gamesPlayed, number(player.starts)));
        const priorMatches = gamesPlayed < 4 ? 8 : 5;
        const startProbability = gamesPlayed > 0
            ? (starts + priorMatches * prior.start) / (gamesPlayed + priorMatches)
            : prior.start;
        const observedStartMinutes = starts > 0
            ? clamp(number(player.minutes) / starts, 45, 90)
            : prior.startMinutes;
        const startMinutes = (starts * observedStartMinutes + 5 * prior.startMinutes) / (starts + 5);
        const available = availability(player);
        const pStart = available * clamp(startProbability, 0, 1);
        const pSub = available * (1 - clamp(startProbability, 0, 1)) * (position === "GK" ? 0.02 : 0.55);
        const pZero = clamp(1 - pStart - pSub, 0, 1);
        const p60 = pStart * clamp((startMinutes - 45) / 30, 0.25, 1);
        const expectedMinutes = pStart * startMinutes + pSub * prior.subMinutes;
        return { pStart, pSub, pZero, p60, expectedMinutes, availability: available };
    }

    function shrunkRate(total, minutes, priorRate, priorNineties) {
        const nineties = Math.max(0, minutes / 90);
        return (Math.max(0, total) + priorNineties * priorRate) /
            (nineties + priorNineties);
    }

    function fixtureContext(player, fixture) {
        if (!fixture) {
            return { attack: 1, cleanSheet: 1, saves: 1, isHome: null, difficulty: 3 };
        }
        const team = number(player.team);
        const isHome = number(fixture.team_h) === team;
        const difficulty = clamp(number(isHome
            ? fixture.team_h_difficulty
            : fixture.team_a_difficulty) || 3, 1, 5);
        return {
            attack: ATTACK_FDR[difficulty] * (isHome ? 1.04 : 0.97),
            cleanSheet: CLEAN_SHEET_FDR[difficulty] * (isHome ? 1.08 : 0.94),
            saves: SAVE_FDR[difficulty],
            isHome,
            difficulty
        };
    }

    function projectFixture(player, fixture, context) {
        const position = POSITION[number(player.element_type)] || "MID";
        const prior = PRIORS[position];
        const minutes = minutesDistribution(player, context || {});
        const venue = fixtureContext(player, fixture);
        const seasonMinutes = number(player.minutes);
        const xG90 = shrunkRate(number(player.expected_goals), seasonMinutes, prior.xG90, 8);
        const xA90 = shrunkRate(number(player.expected_assists), seasonMinutes, prior.xA90, 8);
        const scale = minutes.expectedMinutes / 90;
        const expectedGoals = xG90 * scale * venue.attack;
        const expectedAssists = xA90 * scale * venue.attack;
        const appearancePoints = (1 - minutes.pZero) + minutes.p60;
        const attackingPoints = GOAL_POINTS[position] * expectedGoals + 3 * expectedAssists;
        const baseCleanSheetProbability = position === "GK" || position === "DEF" ? 0.28 : 0.25;
        const cleanSheetProbability = clamp(baseCleanSheetProbability * venue.cleanSheet, 0.06, 0.55);
        const cleanSheetPoints = CLEAN_SHEET_POINTS[position] * minutes.p60 * cleanSheetProbability;
        const saves90 = position === "GK"
            ? shrunkRate(number(player.saves), seasonMinutes, prior.saves90, 8)
            : 0;
        const expectedSaves = saves90 * scale * venue.saves;
        const savePoints = position === "GK" ? expectedSaves / 3 : 0;
        const concededDeduction = position === "GK" || position === "DEF"
            ? minutes.p60 * clamp((1 - cleanSheetProbability) * (venue.difficulty >= 4 ? 0.38 : 0.22), 0, 0.5)
            : 0;
        const mean = Math.max(0, appearancePoints + attackingPoints + cleanSheetPoints + savePoints - concededDeduction);
        const eventVariance = GOAL_POINTS[position] * GOAL_POINTS[position] * expectedGoals +
            9 * expectedAssists + cleanSheetPoints * Math.max(0, CLEAN_SHEET_POINTS[position] - cleanSheetPoints);
        const absenceVariance = minutes.pZero * (1 - minutes.pZero) * mean * mean;
        const standardDeviation = Math.sqrt(Math.max(0.5, eventVariance + absenceVariance));
        return {
            mean,
            floor: Math.max(0, mean - 0.84 * standardDeviation),
            ceiling: mean + 1.28 * standardDeviation,
            haulProbability: clamp((mean / Math.max(10, mean + standardDeviation * 2)), 0, 0.75),
            expectedMinutes: minutes.expectedMinutes,
            pZero: minutes.pZero,
            p60: minutes.p60,
            availability: minutes.availability,
            xG90,
            xA90,
            components: { appearancePoints, attackingPoints, cleanSheetPoints, savePoints, concededDeduction }
        };
    }

    function projectGameweek(player, fixtures, context) {
        if (!fixtures || !fixtures.length) {
            if (context && context.fixturesLoaded) {
                return { ...projectFixture(player, null, context), mean: 0, floor: 0, ceiling: 0, haulProbability: 0 };
            }
            return projectFixture(player, null, context);
        }
        const projections = fixtures.map(fixture => projectFixture(player, fixture, context));
        const rotation = projections.length > 1 ? 0.88 : 1;
        const sum = key => projections.reduce((total, projection) => total + projection[key], 0) * rotation;
        return {
            ...projections[0],
            mean: sum("mean"), floor: sum("floor"), ceiling: sum("ceiling"),
            haulProbability: clamp(sum("haulProbability"), 0, 0.9),
            expectedMinutes: sum("expectedMinutes"),
            pZero: projections.reduce((probability, projection) => probability * projection.pZero, 1),
            p60: clamp(sum("p60"), 0, projections.length),
            components: Object.fromEntries(Object.keys(projections[0].components).map(key => [
                key, projections.reduce((total, projection) => total + projection.components[key], 0) * rotation
            ]))
        };
    }

    function captainPair(players, projectionFor) {
        let best = null;
        players.forEach(captain => players.forEach(vice => {
            if (number(captain.id) === number(vice.id)) return;
            const captainProjection = projectionFor(captain);
            const viceProjection = projectionFor(vice);
            const sharedRisk = number(captain.team) === number(vice.team) ? 0.9 : 1;
            const utility = captainProjection.mean + captainProjection.pZero * viceProjection.mean * sharedRisk;
            if (!best || utility > best.utility) best = { captain, vice, utility };
        }));
        return best;
    }

    return { POSITION, PRIORS, minutesDistribution, projectFixture, projectGameweek, captainPair };
}));
