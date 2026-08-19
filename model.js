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

    function interpolateScore(value, anchors) {
        const input = number(value);
        if (input <= anchors[0][0]) return anchors[0][1];
        for (let index = 1; index < anchors.length; index += 1) {
            const [upperInput, upperScore] = anchors[index];
            const [lowerInput, lowerScore] = anchors[index - 1];
            if (input <= upperInput) {
                const progress = (input - lowerInput) / (upperInput - lowerInput);
                return lowerScore + progress * (upperScore - lowerScore);
            }
        }
        return anchors[anchors.length - 1][1];
    }

    // Presentation-only translations of model outputs. These deliberately live
    // outside projectFixture/projectGameweek so they cannot affect projections
    // or any optimization objective.
    function displayRatings(projection, context) {
        const details = context || {};
        const projectionScore = interpolateScore(projection && projection.mean, [
            [0, 20], [1.5, 40], [2.5, 56], [4, 75.5], [5.5, 86],
            [7, 93], [9, 97], [12, 99]
        ]);
        const valueScore = interpolateScore(details.valueAboveReplacement, [
            [-2, 18], [-1, 34], [0, 50], [0.5, 62], [1, 73],
            [2, 86], [3.5, 94], [5, 98]
        ]);
        const minutesScore = interpolateScore(projection && projection.expectedMinutes, [
            [0, 0], [20, 24], [45, 52], [60, 70], [75, 86],
            [85, 95], [90, 99]
        ]);
        const upside = interpolateScore(projection && projection.ceiling, [
            [0, 10], [2, 30], [4, 52], [6, 70], [8, 83],
            [10, 91], [13, 97], [16, 99]
        ]);
        const evidenceScore = interpolateScore(details.seasonMinutes, [
            [0, 35], [180, 50], [450, 65], [900, 78],
            [1800, 90], [2700, 96]
        ]);
        const priorBonus = projection && projection.priorSource === "previous-season" ? 8 : 0;
        const availabilityPenalty = (1 - clamp(number(projection && projection.availability), 0, 1)) * 25;
        const confidence = clamp(evidenceScore + priorBonus - availabilityPenalty, 5, 98);

        // Expected points account for 94% of Overall. Value can move the
        // displayed rating by at most about three points around neutral.
        const overall = clamp(projectionScore * 0.94 + valueScore * 0.06, 0, 99);
        const rounded = score => Number(score.toFixed(1));
        return {
            overall: rounded(overall),
            projectionScore: rounded(projectionScore),
            valueScore: rounded(valueScore),
            minutesScore: rounded(minutesScore),
            upside: rounded(upside),
            confidence: rounded(confidence)
        };
    }

    function availability(player) {
        if (["i", "s", "u"].includes(player.status)) return 0;
        if (player.chance_of_playing_next_round !== null &&
            player.chance_of_playing_next_round !== undefined) {
            return clamp(number(player.chance_of_playing_next_round) / 100, 0, 1);
        }
        return player.status === "a" || !player.status ? 1 : 0.75;
    }

    function competitivePrior(context) {
        const prior = context && context.prior;
        if (!prior || number(prior.minutes) <= 0) return null;
        return prior;
    }

    function minutesDistribution(player, context) {
        const position = POSITION[number(player.element_type)] || "MID";
        const prior = PRIORS[position];
        const playerPrior = competitivePrior(context);
        const gamesPlayed = Math.max(0, number(context && context.gamesPlayed));
        const starts = clamp(number(player.starts), 0, Math.max(gamesPlayed, number(player.starts)));
        const priorMinutes = number(playerPrior && playerPrior.minutes);
        const priorStarts = number(playerPrior && playerPrior.starts);
        const priorGames = Math.max(priorStarts, number(playerPrior && playerPrior.matches));
        const playerPriorStartRate = priorGames > 0 ? priorStarts / priorGames : prior.start;
        const priorMatches = playerPrior
            ? Math.min(10, Math.max(3, priorGames))
            : (gamesPlayed < 4 ? 8 : 5);
        const startPrior = playerPrior
            ? (playerPriorStartRate * priorMatches + prior.start * 3) / (priorMatches + 3)
            : prior.start;
        const startProbability = (starts + priorMatches * startPrior) /
            Math.max(1, gamesPlayed + priorMatches);
        const observedStartMinutes = starts > 0
            ? clamp(number(player.minutes) / starts, 45, 90)
            : prior.startMinutes;
        const playerPriorStartMinutes = priorStarts > 0
            ? clamp(priorMinutes / priorStarts, 45, 90)
            : prior.startMinutes;
        const startMinutes = (starts * observedStartMinutes + priorMatches * playerPriorStartMinutes) /
            Math.max(1, starts + priorMatches);
        const available = availability(player);
        const pStart = available * clamp(startProbability, 0, 1);
        const pSub = available * (1 - clamp(startProbability, 0, 1)) * (position === "GK" ? 0.02 : 0.55);
        const pZero = clamp(1 - pStart - pSub, 0, 1);
        const p60 = pStart * clamp((startMinutes - 45) / 30, 0.25, 1);
        const expectedMinutes = pStart * startMinutes + pSub * prior.subMinutes;
        return {
            pStart, pSub, pZero, p60, expectedMinutes, availability: available,
            priorWeight: priorMatches / Math.max(1, gamesPlayed + priorMatches)
        };
    }

    function shrunkRate(total, minutes, priorRate, priorNineties) {
        const nineties = Math.max(0, minutes / 90);
        return (Math.max(0, total) + priorNineties * priorRate) /
            (nineties + priorNineties);
    }

    function performancePrior(position, context) {
        const cohort = PRIORS[position];
        const prior = competitivePrior(context);
        if (!prior) {
            return {
                xG90: cohort.xG90,
                xA90: cohort.xA90,
                saves90: cohort.saves90,
                nineties: 8,
                source: "position"
            };
        }
        const priorNineties = Math.max(1, number(prior.minutes) / 90);
        const playerWeight = Math.min(10, priorNineties);
        const cohortWeight = 3;
        return {
            xG90: (number(prior.expected_goals) + cohortWeight * cohort.xG90) /
                (priorNineties + cohortWeight),
            xA90: (number(prior.expected_assists) + cohortWeight * cohort.xA90) /
                (priorNineties + cohortWeight),
            saves90: (number(prior.saves) + cohortWeight * cohort.saves90) /
                (priorNineties + cohortWeight),
            nineties: playerWeight,
            source: "previous-season"
        };
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
        const performance = performancePrior(position, context || {});
        const xG90 = shrunkRate(number(player.expected_goals), seasonMinutes,
            performance.xG90, performance.nineties);
        const xA90 = shrunkRate(number(player.expected_assists), seasonMinutes,
            performance.xA90, performance.nineties);
        const scale = minutes.expectedMinutes / 90;
        const expectedGoals = xG90 * scale * venue.attack;
        const expectedAssists = xA90 * scale * venue.attack;
        const appearancePoints = (1 - minutes.pZero) + minutes.p60;
        const attackingPoints = GOAL_POINTS[position] * expectedGoals + 3 * expectedAssists;
        const baseCleanSheetProbability = position === "GK" || position === "DEF" ? 0.28 : 0.25;
        const cleanSheetProbability = clamp(baseCleanSheetProbability * venue.cleanSheet, 0.06, 0.55);
        const cleanSheetPoints = CLEAN_SHEET_POINTS[position] * minutes.p60 * cleanSheetProbability;
        const saves90 = position === "GK"
            ? shrunkRate(number(player.saves), seasonMinutes,
                performance.saves90, performance.nineties)
            : 0;
        const expectedSaves = saves90 * scale * venue.saves;
        const savePoints = position === "GK" ? expectedSaves / 3 : 0;
        const concededDeduction = position === "GK" || position === "DEF"
            ? minutes.p60 * clamp((1 - cleanSheetProbability) * (venue.difficulty >= 4 ? 0.38 : 0.22), 0, 0.5)
            : 0;
        const independentMean = Math.max(0,
            appearancePoints + attackingPoints + cleanSheetPoints + savePoints - concededDeduction);
        const currentNineties = seasonMinutes / 90;
        const useLegacyBridge = performance.source === "position" &&
            number(context && context.legacyPreseasonProjection) > 0 && currentNineties < 8;
        const legacyWeight = useLegacyBridge ? clamp(1 - currentNineties / 8, 0, 1) : 0;
        const fixtureBridge = position === "GK"
            ? venue.cleanSheet * 0.55 + venue.saves * 0.45
            : position === "DEF"
                ? venue.cleanSheet * 0.65 + venue.attack * 0.35
                : position === "MID"
                    ? venue.attack * 0.9 + venue.cleanSheet * 0.1
                    : venue.attack;
        const bridgedMean = number(context && context.legacyPreseasonProjection) *
            minutes.availability * fixtureBridge;
        const mean = independentMean * (1 - legacyWeight) + bridgedMean * legacyWeight;
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
            priorSource: legacyWeight > 0 ? "legacy-bridge" : performance.source,
            priorWeight: performance.nineties /
                Math.max(performance.nineties, performance.nineties + currentNineties),
            legacyWeight,
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

    return {
        POSITION, PRIORS, minutesDistribution, projectFixture, projectGameweek,
        captainPair, displayRatings
    };
}));
