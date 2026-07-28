const test = require("node:test");
const assert = require("node:assert/strict");
const rating = require("./open-play-rating.js");

const players = [
  { id: "a", full_name: "A", skill_level: 3 },
  { id: "b", full_name: "B", skill_level: 3 },
  { id: "c", full_name: "C", skill_level: 5 },
  { id: "d", full_name: "D", skill_level: 5 },
];

test("seeds ratings from the manager's six skill levels", () => {
  assert.equal(rating.seedRating(1), 1000);
  assert.equal(rating.seedRating(3), 1200);
  assert.equal(rating.seedRating(6), 1500);
  assert.equal(rating.seedRating("invalid"), 1000);
});

test("an upset earns more performance points than an expected win", () => {
  const upset = rating.calculateStandings(players, [{
    resultAt: "2026-07-28T10:00:00.000Z",
    teamA: ["a", "b"],
    teamB: ["c", "d"],
    winner: "A",
  }]);
  const expected = rating.calculateStandings(players, [{
    resultAt: "2026-07-28T10:00:00.000Z",
    teamA: ["a", "b"],
    teamB: ["c", "d"],
    winner: "B",
  }]);

  assert.ok(upset.find(row => row.id === "a").points > 12);
  assert.ok(expected.find(row => row.id === "c").points < 12);
  assert.equal(
    upset.find(row => row.id === "a").points,
    -upset.find(row => row.id === "c").points
  );
});

test("a current court result sorts after its archived games when timestamps tie", () => {
  const ordered = rating.chronologicalMatches([
    {
      resultAt: "",
      roundNo: 1,
      courtIndex: 0,
      completedGameIndex: null,
      sequence: 1,
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "B",
    },
    {
      resultAt: "",
      roundNo: 1,
      courtIndex: 0,
      completedGameIndex: 0,
      sequence: 0,
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
  ]);

  assert.equal(ordered[0].winner, "A");
  assert.equal(ordered[1].winner, "B");
});

test("rating follows each player while teammates rotate", () => {
  const rotatingPlayers = [
    ...players,
    { id: "e", full_name: "E", skill_level: 3 },
    { id: "f", full_name: "F", skill_level: 3 },
  ];
  const rows = rating.calculateStandings(rotatingPlayers, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "e"],
      teamB: ["b", "f"],
      winner: "A",
    },
  ], { minGames: 1 });

  assert.equal(rows.find(row => row.id === "a").games, 2);
  assert.equal(rows.find(row => row.id === "a").wins, 2);
  assert.ok(rows.find(row => row.id === "a").points > rows.find(row => row.id === "b").points);
});

test("minimum games controls podium eligibility without using wins as rank", () => {
  const rows = rating.calculateStandings(players, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "c"],
      teamB: ["b", "d"],
      winner: "B",
    },
    {
      resultAt: "2026-07-28T10:20:00.000Z",
      teamA: ["a", "d"],
      teamB: ["b", "c"],
      winner: "A",
    },
  ]);

  assert.ok(rows.every(row => row.eligible));
  assert.equal(rating.podiumRows(rows).length, 3);
  assert.deepEqual(rows.map(row => row.rank), [1, 1, 3, 4]);
});

test("replaying corrected immutable match history changes ratings deterministically", () => {
  const original = [{
    resultAt: "2026-07-28T10:00:00.000Z",
    teamA: ["a", "b"],
    teamB: ["c", "d"],
    winner: "A",
  }];
  const corrected = [{ ...original[0], winner: "B" }];
  const originalRows = rating.calculateStandings(players, original, { minGames: 1 });
  const correctedRows = rating.calculateStandings(players, corrected, { minGames: 1 });

  assert.ok(originalRows.find(row => row.id === "a").points > 0);
  assert.ok(correctedRows.find(row => row.id === "a").points < 0);
  assert.deepEqual(
    rating.calculateStandings(players, corrected, { minGames: 1 }),
    correctedRows
  );
});

test("a corrected early result replays every later expectation", () => {
  const replayPlayers = [
    { id: "a", full_name: "A", performance_seed_rating: 1000 },
    { id: "b", full_name: "B", performance_seed_rating: 1000 },
    { id: "c", full_name: "C", performance_seed_rating: 1300 },
    { id: "d", full_name: "D", performance_seed_rating: 1300 },
    { id: "e", full_name: "E", performance_seed_rating: 1100 },
    { id: "f", full_name: "F", performance_seed_rating: 1100 },
  ];
  const matches = [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "e"],
      teamB: ["c", "f"],
      winner: "A",
    },
  ];
  const before = rating.calculateStandings(replayPlayers, matches, { minGames: 1 });
  const after = rating.calculateStandings(
    replayPlayers,
    [{ ...matches[0], winner: "B" }, matches[1]],
    { minGames: 1 }
  );

  assert.equal(before.find(row => row.id === "a").points, 36);
  assert.equal(before.find(row => row.id === "e").points, 16);
  assert.equal(after.find(row => row.id === "a").points, 13);
  assert.equal(after.find(row => row.id === "e").points, 17);
});

test("invalid teams and unknown player IDs never create phantom standings", () => {
  const rows = rating.calculateStandings(players, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "a"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "missing"],
      teamB: ["c", "d"],
      winner: "B",
    },
  ], { minGames: 1 });

  assert.equal(rows.length, players.length);
  assert.ok(rows.every(row => row.games === 0 && row.points === 0));
});

test("exact performance ties share an official rank", () => {
  const tied = rating.calculateStandings(players, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
  ], { minGames: 1 });

  assert.equal(tied.find(row => row.id === "a").rank, tied.find(row => row.id === "b").rank);
  assert.equal(tied.find(row => row.id === "c").rank, tied.find(row => row.id === "d").rank);
});
