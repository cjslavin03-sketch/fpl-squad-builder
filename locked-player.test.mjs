import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(Boolean);

assert.doesNotThrow(
    () => new Function(inlineScripts.join("\n")),
    "the inline application script must have valid JavaScript syntax"
);
assert.match(html, /function\s+togglePlayerLock\s*\(/,
    "the player-card lock handler must resolve to a declared function");
assert.match(html, /\(\)\s*=>\s*togglePlayerLock\(player\.id\)/,
    "the lock button must invoke togglePlayerLock without a missing global");

function extractFunction(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const brace = html.indexOf("{", start);
    let depth = 0;
    for (let index = brace; index < html.length; index++) {
        if (html[index] === "{") depth++;
        if (html[index] === "}" && --depth === 0) return html.slice(start, index + 1);
    }
    throw new Error(`Could not parse ${name}`);
}

const storage = new Map();
const context = vm.createContext({
    console,
    localStorage: {
        setItem: (key, value) => storage.set(key, value),
        getItem: key => storage.get(key) ?? null,
        removeItem: key => storage.delete(key)
    }
});

vm.runInContext(`
var players = [{ id: 7, element_type: 3, team: 1, now_cost: 75 }];
var squad = [];
var lockedPlayerIds = new Set();
var renderCount = 0;
function renderSquad() { renderCount++; }
function renderPlayers() { renderCount++; }
function saveSquad() {}
function addPlayerToSquad(id) { const player = players.find(p => Number(p.id) === Number(id)); if (player) squad.push(player); }
${extractFunction("saveLockedPlayers")}
${extractFunction("loadLockedPlayers")}
${extractFunction("togglePlayerLock")}
${extractFunction("removePlayerFromSquad")}
`, context);

assert.doesNotThrow(() => vm.runInContext("togglePlayerLock(7)", context),
    "clicking Lock Player must not throw ReferenceError");
assert.equal(vm.runInContext("squad.some(player => player.id === 7)", context), true,
    "locking a player outside the squad adds them first");
assert.equal(vm.runInContext("lockedPlayerIds.has(7)", context), true);
assert.deepEqual(JSON.parse(storage.get("fpl_locked_player_ids")), [7],
    "locks persist as numeric IDs only");

vm.runInContext("togglePlayerLock('7')", context);
assert.equal(vm.runInContext("lockedPlayerIds.has(7)", context), false,
    "clicking Locked unlocks the normalized ID");
assert.equal(vm.runInContext("squad.length", context), 1,
    "unlocking does not remove the player");

vm.runInContext("togglePlayerLock(7); removePlayerFromSquad(7)", context);
assert.equal(vm.runInContext("squad.length", context), 0);
assert.equal(vm.runInContext("lockedPlayerIds.has(7)", context), false,
    "manual removal also removes the lock");
assert.deepEqual(JSON.parse(storage.get("fpl_locked_player_ids")), []);

storage.set("fpl_locked_player_ids", JSON.stringify([7, "999", "invalid"]));
vm.runInContext("squad.push(players[0]); loadLockedPlayers()", context);
assert.deepEqual(JSON.parse(storage.get("fpl_locked_player_ids")), [7],
    "reload retains only numeric IDs resolving to restored squad players");

assert.match(html, /squad:\s*\[\.\.\.lockedPlayers\]/,
    "optimizer search must begin with every locked player");
assert.match(html, /requirements\[position\]\s*-\s*lockedCounts\[position\]/,
    "optimizer must fill only position slots remaining after locks");

console.log("locked-player regression checks passed");
