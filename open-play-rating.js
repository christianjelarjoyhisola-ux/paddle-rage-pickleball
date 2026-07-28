(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.PBOpenPlayRating = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "pr-performance-v1";
  const K_FACTOR = 24;
  const RATING_SCALE = 400;
  const MIN_PODIUM_GAMES = 3;
  const DEFAULT_SKILL_LEVEL = 1;
  const BASE_RATING = 1000;
  const SKILL_STEP = 100;

  const asId = value => String(value ?? "");
  const roundOne = value => Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  const numeric = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  function normalizeSkillLevel(value) {
    const level = Number(value);
    return Number.isInteger(level) && level >= 1 && level <= 6
      ? level
      : DEFAULT_SKILL_LEVEL;
  }

  function seedRating(skillLevel) {
    return BASE_RATING + (normalizeSkillLevel(skillLevel) - 1) * SKILL_STEP;
  }

  function expectedScore(teamRating, opponentRating) {
    return 1 / (1 + Math.pow(10, (numeric(opponentRating) - numeric(teamRating)) / RATING_SCALE));
  }

  function matchDelta(teamRating, opponentRating, won) {
    const raw = K_FACTOR * ((won ? 1 : 0) - expectedScore(teamRating, opponentRating));
    if (!raw) return 0;
    const magnitude = Math.min(K_FACTOR - 1, Math.max(1, Math.round(Math.abs(raw))));
    return raw > 0 ? magnitude : -magnitude;
  }

  function matchSortValue(match) {
    const parsed = Date.parse(match?.resultAt || "");
    return Number.isFinite(parsed) ? parsed : null;
  }

  function chronologicalMatches(matches) {
    return (Array.isArray(matches) ? matches : [])
      .filter(match => {
        if (
          !match ||
          !["A", "B"].includes(match.winner) ||
          !Array.isArray(match.teamA) ||
          !Array.isArray(match.teamB) ||
          match.teamA.length !== 2 ||
          match.teamB.length !== 2
        ) return false;
        const playerIds = [...match.teamA, ...match.teamB].map(asId);
        return playerIds.every(Boolean) && new Set(playerIds).size === 4;
      })
      .map((match, inputIndex) => ({ match, inputIndex, time: matchSortValue(match) }))
      .sort((left, right) => {
        if (left.time !== null && right.time !== null && left.time !== right.time) {
          return left.time - right.time;
        }
        if ((left.time === null) !== (right.time === null)) {
          return left.time === null ? 1 : -1;
        }
        return (
          numeric(left.match.roundNo) - numeric(right.match.roundNo) ||
          numeric(left.match.courtIndex) - numeric(right.match.courtIndex) ||
          (left.match.completedGameIndex == null
            ? Number.MAX_SAFE_INTEGER
            : numeric(left.match.completedGameIndex, Number.MAX_SAFE_INTEGER)) -
            (right.match.completedGameIndex == null
              ? Number.MAX_SAFE_INTEGER
              : numeric(right.match.completedGameIndex, Number.MAX_SAFE_INTEGER)) ||
          numeric(left.match.sequence, left.inputIndex) -
            numeric(right.match.sequence, right.inputIndex) ||
          String(left.match.matchId || "").localeCompare(String(right.match.matchId || "")) ||
          left.inputIndex - right.inputIndex
        );
      })
      .map(entry => entry.match);
  }

  function calculateStandings(players, matches, options = {}) {
    const minGames = Math.max(1, Math.floor(numeric(options.minGames, MIN_PODIUM_GAMES)));
    const records = new Map();

    (Array.isArray(players) ? players : []).forEach((player, index) => {
      const id = asId(player?.id ?? player?.player_id ?? player?.name ?? index);
      if (!id || records.has(id)) return;
      const storedSeed = numeric(
        player?.performance_seed_rating ?? player?.rating_start ?? player?.ratingStart,
        NaN
      );
      const startingRating = Number.isFinite(storedSeed)
        ? storedSeed
        : seedRating(player?.skill_level ?? player?.skillLevel);
      records.set(id, {
        id,
        name: String(player?.full_name ?? player?.name ?? "Player"),
        skillLevel: normalizeSkillLevel(player?.skill_level ?? player?.skillLevel),
        seedRating: startingRating,
        ratingExact: startingRating,
        pointsExact: 0,
        games: 0,
        wins: 0,
        opponentRatingTotal: 0,
        bestUpset: 0,
      });
    });

    const ensureRecord = idValue => {
      const id = asId(idValue);
      return id ? records.get(id) || null : null;
    };

    chronologicalMatches(matches).forEach(match => {
      const teamA = match.teamA.map(ensureRecord);
      const teamB = match.teamB.map(ensureRecord);
      if (teamA.some(record => !record) || teamB.some(record => !record)) return;

      const teamARating = (teamA[0].ratingExact + teamA[1].ratingExact) / 2;
      const teamBRating = (teamB[0].ratingExact + teamB[1].ratingExact) / 2;
      const aWon = match.winner === "A";
      const deltaA = matchDelta(teamARating, teamBRating, aWon);
      const deltaB = roundOne(-deltaA);
      const upsetA = aWon ? Math.max(0, teamBRating - teamARating) : 0;
      const upsetB = !aWon ? Math.max(0, teamARating - teamBRating) : 0;

      teamA.forEach(record => {
        record.games += 1;
        if (aWon) record.wins += 1;
        record.opponentRatingTotal += teamBRating;
        record.bestUpset = Math.max(record.bestUpset, upsetA);
        record.pointsExact += deltaA;
        record.ratingExact += deltaA;
      });

      teamB.forEach(record => {
        record.games += 1;
        if (!aWon) record.wins += 1;
        record.opponentRatingTotal += teamARating;
        record.bestUpset = Math.max(record.bestUpset, upsetB);
        record.pointsExact += deltaB;
        record.ratingExact += deltaB;
      });
    });

    const sorted = [...records.values()]
      .map(record => {
        const points = roundOne(record.pointsExact);
        const rating = roundOne(record.ratingExact);
        const averageOpponentRating = record.games
          ? roundOne(record.opponentRatingTotal / record.games)
          : 0;
        const bestUpset = roundOne(record.bestUpset);
        return {
          id: record.id,
          name: record.name,
          skillLevel: record.skillLevel,
          seedRating: record.seedRating,
          rating,
          points,
          games: record.games,
          wins: record.wins,
          averageOpponentRating,
          bestUpset,
          eligible: record.games >= minGames,
          gamesNeeded: Math.max(0, minGames - record.games),
        };
      })
      .sort((left, right) =>
        Number(right.eligible) - Number(left.eligible) ||
        right.points - left.points ||
        right.averageOpponentRating - left.averageOpponentRating ||
        right.bestUpset - left.bestUpset ||
        left.name.localeCompare(right.name)
      );
    let qualifiedPosition = 0;
    let previousPerformanceKey = "";
    let previousRank = null;
    return sorted.map((record, index) => ({
      ...record,
      position: index + 1,
      rank: (() => {
        if (!record.eligible) return null;
        qualifiedPosition += 1;
        const performanceKey = [
          record.points,
          record.averageOpponentRating,
          record.bestUpset,
        ].join("|");
        if (performanceKey !== previousPerformanceKey) {
          previousRank = qualifiedPosition;
          previousPerformanceKey = performanceKey;
        }
        return previousRank;
      })(),
    }));
  }

  function podiumRows(rows, limit = 3) {
    return (Array.isArray(rows) ? rows : [])
      .filter(row => row?.eligible)
      .slice(0, Math.max(0, Number(limit) || 0));
  }

  return Object.freeze({
    VERSION,
    K_FACTOR,
    RATING_SCALE,
    MIN_PODIUM_GAMES,
    BASE_RATING,
    SKILL_STEP,
    normalizeSkillLevel,
    seedRating,
    expectedScore,
    matchDelta,
    chronologicalMatches,
    calculateStandings,
    podiumRows,
  });
});
