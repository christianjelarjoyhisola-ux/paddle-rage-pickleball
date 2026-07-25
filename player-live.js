(() => {
  "use strict";

  const POLL_MS = 3000;
  const PLAYER_NAME_KEY = "paddle_rage_player_live_name_v1";
  const state = {
    token: String(location.hash || "").slice(1).trim(),
    snapshot: null,
    signature: "",
    selectedName: "",
    inFlight: false,
    failures: 0,
    terminal: false,
    winnerReveal: null,
    winnerRevealTimer: null,
    matchupReveals: [],
    pendingMatchupReveals: [],
    matchupRevealTimer: null,
    pollTimer: null,
    clockTimer: null,
  };

  const root = () => document.getElementById("playerLiveRoot");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "Open Play";
    const [year, month, day] = String(value).split("-").map(Number);
    if (!year || !month || !day) return String(value);
    return new Date(year, month - 1, day).toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function elapsedLabel(value) {
    const started = Date.parse(value || "");
    if (!Number.isFinite(started)) return "00:00";
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function relativeTime(value) {
    const generated = Date.parse(value || "");
    if (!Number.isFinite(generated)) return "Waiting for update";
    const seconds = Math.max(0, Math.floor((Date.now() - generated) / 1000));
    if (seconds < 5) return "Updated just now";
    if (seconds < 60) return `Updated ${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `Updated ${minutes}m ago`;
  }

  function readSelectedName() {
    try {
      return localStorage.getItem(PLAYER_NAME_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function saveSelectedName(name) {
    state.selectedName = String(name || "");
    try {
      if (state.selectedName) localStorage.setItem(PLAYER_NAME_KEY, state.selectedName);
      else localStorage.removeItem(PLAYER_NAME_KEY);
    } catch (_) {}
  }

  function statusLabel(status) {
    if (status === "paused") return "PAUSED";
    if (status === "completed") return "FINAL";
    return "LIVE";
  }

  function updateHeader() {
    const pill = document.getElementById("plbStatusPill");
    const freshness = document.getElementById("plbFreshness");
    if (!pill || !freshness) return;

    pill.className = "plb-status-pill";
    if (state.terminal) {
      pill.textContent = "UNAVAILABLE";
      pill.classList.add("is-offline");
      freshness.textContent = "This player link is no longer active";
      return;
    }
    if (!state.snapshot) {
      pill.textContent = state.failures ? "OFFLINE" : "CONNECTING";
      pill.classList.add(state.failures ? "is-offline" : "is-loading");
      freshness.textContent = state.failures ? "Could not reach the live board" : "Opening live board…";
      return;
    }
    if (state.failures) {
      pill.textContent = "RECONNECTING";
      pill.classList.add("is-reconnecting");
      freshness.textContent = `${relativeTime(state.snapshot.generatedAt)} · retrying`;
      return;
    }
    const status = state.snapshot.session?.status || "active";
    pill.textContent = statusLabel(status);
    pill.classList.add(`is-${status}`);
    freshness.textContent = relativeTime(state.snapshot.generatedAt);
  }

  function isMine(name) {
    return Boolean(state.selectedName && String(name) === state.selectedName);
  }

  function nameFitClass(name) {
    const length = String(name || "").trim().length;
    if (length > 28) return "is-very-long";
    if (length > 18) return "is-long";
    return "";
  }

  function playerItem(name) {
    return `
      <li class="plb-player ${isMine(name) ? "is-mine" : ""}">
        <span class="${nameFitClass(name)}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        ${isMine(name) ? `<b>YOU</b>` : ""}
      </li>
    `;
  }

  function matchEventKey(snapshot, game, courtIndex) {
    if (!game?.startedAt) return "";
    const roundNo = Number(snapshot?.latestRound?.roundNo || snapshot?.session?.currentRound || 0);
    return [
      roundNo,
      Number(courtIndex),
      String(game.courtName || ""),
      String(game.startedAt),
      Number(game.gameCount || 1),
    ].join(":");
  }

  function matchupRevealsForUpdate(previousSnapshot, nextSnapshot) {
    if (String(nextSnapshot?.session?.status || "active") !== "active") return [];
    const previousAssignments = previousSnapshot?.latestRound?.assignments || [];
    const nextAssignments = nextSnapshot?.latestRound?.assignments || [];
    const previousRoundNo = Number(previousSnapshot?.latestRound?.roundNo || previousSnapshot?.session?.currentRound || 0);
    const nextRoundNo = Number(nextSnapshot?.latestRound?.roundNo || nextSnapshot?.session?.currentRound || 0);
    return nextAssignments.flatMap((game, courtIndex) => {
      if (!game || game.winner || !game.startedAt) return [];
      const eventKey = matchEventKey(nextSnapshot, game, courtIndex);
      const previousGame = previousAssignments[courtIndex];
      const previousKey = previousGame && !previousGame.winner
        ? matchEventKey(previousSnapshot, previousGame, courtIndex)
        : "";
      const actualAdvance = (
        !previousGame ||
        Boolean(previousGame.winner) ||
        nextRoundNo !== previousRoundNo ||
        String(previousGame.courtName || "") !== String(game.courtName || "") ||
        Number(game.gameCount || 1) > Number(previousGame.gameCount || 1)
      );
      if (!eventKey || eventKey === previousKey || !actualAdvance) return [];
      return [{
        eventKey,
        courtIndex,
        courtName: game.courtName || `Court ${courtIndex + 1}`,
        team1: Array.isArray(game.team1) ? game.team1 : [],
        team2: Array.isArray(game.team2) ? game.team2 : [],
      }];
    });
  }

  function winnerRevealForUpdate(previousSnapshot, nextSnapshot) {
    const previousCount = Number(previousSnapshot?.resultCount || 0);
    const nextCount = Number(nextSnapshot?.resultCount || 0);
    const result = nextSnapshot?.latestResult;
    if (nextCount <= previousCount || !result || !["A", "B"].includes(result.winner)) return null;
    return {
      ...result,
      team1: Array.isArray(result.team1) ? result.team1 : [],
      team2: Array.isArray(result.team2) ? result.team2 : [],
    };
  }

  function winningNames(result) {
    return result?.winner === "A" ? (result.team1 || []) : (result.team2 || []);
  }

  function renderWinnerReveal(result) {
    if (!result) return "";
    const teamLabel = result.winner === "A" ? "Team 1" : "Team 2";
    const teamClass = result.winner === "A" ? "team-one" : "team-two";
    const names = winningNames(result);
    return `
      <div class="plb-winner-reveal ${teamClass}" aria-hidden="true">
        <span class="plb-winner-reveal-sparks"></span>
        <div class="plb-winner-reveal-copy">
          <span>${escapeHtml(result.courtName || "Court")} · ${teamLabel}</span>
          <strong class="plb-winner-reveal-names">
            ${(names.length ? names : [teamLabel]).map(name => `
              <span class="${nameFitClass(name)}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            `).join("")}
          </strong>
          <b><i>✓</i> WIN</b>
        </div>
      </div>
    `;
  }

  function renderMatchupReveal(matchup) {
    if (!matchup) return "";
    const teamNames = (names, fallback) => (names.length ? names : [fallback]).map(name => `
      <span class="${nameFitClass(name)}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    `).join("");
    return `
      <div class="plb-matchup-reveal" aria-hidden="true">
        <div class="plb-matchup-reveal-head">
          <span class="plb-matchup-live-dot"></span>
          <strong>New match</strong>
          <span>${escapeHtml(matchup.courtName || "Court")}</span>
        </div>
        <div class="plb-matchup-reveal-grid">
          <section class="plb-matchup-reveal-team team-one">
            <b>Team 1</b>
            <div>${teamNames(matchup.team1 || [], "Team 1")}</div>
          </section>
          <span class="plb-matchup-reveal-vs">VS</span>
          <section class="plb-matchup-reveal-team team-two">
            <b>Team 2</b>
            <div>${teamNames(matchup.team2 || [], "Team 2")}</div>
          </section>
        </div>
      </div>
    `;
  }

  function scheduleMatchupRevealEnd() {
    clearTimeout(state.matchupRevealTimer);
    const reducedMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    state.matchupRevealTimer = setTimeout(() => {
      state.matchupReveals = [];
      document.querySelectorAll(".plb-matchup-reveal").forEach(reveal => reveal.remove());
      document.querySelectorAll(".plb-court-card.has-matchup-reveal").forEach(card => {
        card.classList.remove("has-matchup-reveal");
      });
    }, reducedMotion ? 120 : 1750);
  }

  function beginMatchupReveals(reveals) {
    if (!reveals.length) return;
    state.pendingMatchupReveals = [];
    state.matchupReveals = reveals;
    renderBoard();
    announceUpdate(state.snapshot);
    scheduleMatchupRevealEnd();
  }

  function scheduleWinnerRevealEnd(pendingMatchups = []) {
    clearTimeout(state.winnerRevealTimer);
    const reducedMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    state.winnerRevealTimer = setTimeout(() => {
      state.winnerReveal = null;
      document.querySelectorAll(".plb-winner-reveal").forEach(reveal => reveal.remove());
      document.querySelectorAll(".plb-court-card.has-winner-reveal").forEach(card => {
        card.classList.remove("has-winner-reveal");
      });
      if (pendingMatchups.length) beginMatchupReveals(pendingMatchups);
    }, reducedMotion ? 120 : 1900);
  }

  function myPosition(snapshot) {
    const name = state.selectedName;
    if (!name) return null;
    if (!(snapshot.players || []).includes(name)) {
      return {
        eyebrow: "Player not active",
        title: "Ask the session manager",
        detail: "Your saved name is no longer in this live roster.",
        tone: "muted",
      };
    }
    const sessionStatus = String(snapshot.session?.status || "active");
    const assignments = snapshot.latestRound?.assignments || [];
    const liveGame = assignments.find(game =>
      !game.winner && [...(game.team1 || []), ...(game.team2 || [])].includes(name)
    );
    const queue = snapshot.latestRound?.queue || [];
    const queueIndex = queue.indexOf(name);

    if (sessionStatus === "completed") {
      return {
        eyebrow: "Session complete",
        title: "Final results are posted",
        detail: "See your wins and games in the standings below.",
        tone: "finished",
      };
    }

    if (sessionStatus === "paused") {
      if (liveGame) {
        const team = (liveGame.team1 || []).includes(name) ? "Team 1" : "Team 2";
        return {
          eyebrow: "Session paused",
          title: liveGame.courtName || "Current court",
          detail: `${team} · Play will continue when the manager resumes`,
          tone: "muted",
        };
      }
      if (queueIndex >= 0) {
        return {
          eyebrow: "Session paused",
          title: `Queue position #${queueIndex + 1}`,
          detail: "Your position is saved until play resumes.",
          tone: "muted",
        };
      }
      return {
        eyebrow: "Session paused",
        title: "Your position is on hold",
        detail: "Check again when the manager resumes play.",
        tone: "muted",
      };
    }

    if (liveGame) {
      const team = (liveGame.team1 || []).includes(name) ? "Team 1" : "Team 2";
      return {
        eyebrow: "You are playing now",
        title: liveGame.courtName || "Live court",
        detail: `${team} · Check the court card below`,
        tone: "playing",
      };
    }

    if (queueIndex >= 0) {
      if (queueIndex < 4) {
        return {
          eyebrow: "You are up next",
          title: "Stay close to the courts",
          detail: `Ready group · Queue position #${queueIndex + 1}`,
          tone: "next",
        };
      }
      return {
        eyebrow: "Your queue position",
        title: `#${queueIndex + 1}`,
        detail: `${queueIndex - 3} player${queueIndex - 3 === 1 ? "" : "s"} ahead of the next group`,
        tone: "waiting",
      };
    }

    const finalGame = assignments.find(game =>
      game.winner && [...(game.team1 || []), ...(game.team2 || [])].includes(name)
    );
    if (finalGame) {
      return {
        eyebrow: "Last court",
        title: finalGame.courtName || "Game complete",
        detail: "Waiting for the queue to update",
        tone: "finished",
      };
    }

    return {
      eyebrow: "Waiting for an assignment",
      title: "Stay close to the courts",
      detail: "The manager is updating the next playing group.",
      tone: "waiting",
    };
  }

  function renderMyPosition(snapshot) {
    const position = myPosition(snapshot);
    if (!position) return "";
    return `
      <section class="plb-my-card is-${position.tone}" aria-label="Your live position">
        <span>${escapeHtml(position.eyebrow)}</span>
        <strong>${escapeHtml(position.title)}</strong>
        <small>${escapeHtml(position.detail)}</small>
      </section>
    `;
  }

  function renderCourt(game, index, sessionStatus = "active") {
    const hasWinner = Boolean(game.winner);
    const ready = hasWinner && sessionStatus !== "completed";
    const final = hasWinner && sessionStatus === "completed";
    const live = !hasWinner && sessionStatus === "active";
    const paused = !hasWinner && sessionStatus === "paused";
    const courtState = ready ? "READY" : final ? "FINAL" : paused ? "PAUSED" : live ? "LIVE" : "ENDED";
    const courtStateClass = ready ? "is-ready" : final ? "is-final" : paused ? "is-paused" : live ? "is-live" : "is-ended";
    const teamOneWon = game.winner === "A";
    const teamTwoWon = game.winner === "B";
    const selectedOnCourt = [...(game.team1 || []), ...(game.team2 || [])].some(isMine);
    const reveal = state.winnerReveal;
    const revealOnCourt = reveal && (
      Number(reveal.courtIndex) === index ||
      (!Number.isFinite(Number(reveal.courtIndex)) && String(reveal.courtName || "") === String(game.courtName || ""))
    );
    const currentMatchKey = matchEventKey(state.snapshot, game, index);
    const matchupReveal = state.matchupReveals.find(matchup =>
      Number(matchup.courtIndex) === index && matchup.eventKey === currentMatchKey
    );
    return `
      <article class="plb-court-card ${courtStateClass} ${selectedOnCourt ? "has-mine" : ""} ${revealOnCourt ? "has-winner-reveal" : ""} ${matchupReveal ? "has-matchup-reveal" : ""}">
        <header class="plb-court-head">
          <div>
            <span>Court ${index + 1}</span>
            <h3>${escapeHtml(game.courtName || `Court ${index + 1}`)}</h3>
          </div>
          <div class="plb-court-state">
            <span class="plb-court-pill ${courtStateClass}">${courtState}</span>
            ${hasWinner
              ? `<span class="plb-court-time">Game ${Number(game.gameCount || 1)}</span>`
              : live
                ? `<span class="plb-court-time" data-live-start="${escapeHtml(game.startedAt || "")}">${elapsedLabel(game.startedAt)}</span>`
                : `<span class="plb-court-time">${paused ? "Paused" : "Session ended"}</span>`
            }
          </div>
        </header>
        <div class="plb-match">
          <section class="plb-team team-one ${teamOneWon ? "is-winner" : ""}" aria-label="Team 1${teamOneWon ? ", winner" : ""}">
            <div class="plb-team-label"><span>Team 1</span>${teamOneWon ? "<b>WINNER</b>" : ""}</div>
            <ul>${(game.team1 || []).map(playerItem).join("")}</ul>
          </section>
          <span class="plb-vs" aria-hidden="true">VS</span>
          <section class="plb-team team-two ${teamTwoWon ? "is-winner" : ""}" aria-label="Team 2${teamTwoWon ? ", winner" : ""}">
            <div class="plb-team-label"><span>Team 2</span>${teamTwoWon ? "<b>WINNER</b>" : ""}</div>
            <ul>${(game.team2 || []).map(playerItem).join("")}</ul>
          </section>
        </div>
        ${hasWinner ? `
          <div class="plb-result-line ${ready ? "is-ready" : ""}">${teamOneWon ? "Team 1" : "Team 2"} won${ready ? " &middot; Waiting for next match" : " this game"}</div>
        ` : ""}
        ${revealOnCourt ? renderWinnerReveal(reveal) : ""}
        ${matchupReveal ? renderMatchupReveal(matchupReveal) : ""}
      </article>
    `;
  }

  function renderUpNext(queue, sessionStatus = "active") {
    const next = queue.slice(0, 4);
    if (!next.length) {
      return `<div class="plb-empty">${sessionStatus === "completed" ? "No players were waiting when the session ended." : "No players are waiting right now."}</div>`;
    }
    return `
      <div class="plb-next-grid">
        ${next.map((name, index) => `
          <div class="plb-next-player ${isMine(name) ? "is-mine" : ""}">
            <span>${index + 1}</span>
            <strong>${escapeHtml(name)}</strong>
            ${isMine(name) ? "<b>YOU</b>" : ""}
          </div>
        `).join("")}
        ${next.length < 4 && sessionStatus === "active" ? `
          <p class="plb-next-waiting">${4 - next.length} more player${4 - next.length === 1 ? "" : "s"} needed for a full next group.</p>
        ` : ""}
      </div>
    `;
  }

  function renderQueue(queue) {
    if (!queue.length) return `<div class="plb-empty">Everyone is currently on court.</div>`;
    return `
      <ol class="plb-queue-list" id="plbQueueList" tabindex="0" aria-label="Waiting players in playing order">
        ${queue.map((name, index) => `
          <li class="${isMine(name) ? "is-mine" : ""}">
            <span class="plb-queue-number">${index + 1}</span>
            <strong>${escapeHtml(name)}</strong>
            ${index < 4 ? `<span class="plb-up-badge">UP NEXT</span>` : ""}
            ${isMine(name) ? `<span class="plb-you-badge">YOU</span>` : ""}
          </li>
        `).join("")}
      </ol>
    `;
  }

  function renderStandings(standings) {
    if (!standings.length) return `<div class="plb-empty">Standings will appear after play begins.</div>`;
    return `
      <div class="plb-table-wrap" id="plbStandingsTable" tabindex="0" aria-label="Player standings">
        <table class="plb-standings">
          <thead>
            <tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Wins</th><th scope="col">Games</th></tr>
          </thead>
          <tbody>
            ${standings.map((row, index) => `
              <tr class="${isMine(row.name) ? "is-mine" : ""}">
                <td><span>${index + 1}</span></td>
                <th scope="row">${escapeHtml(row.name)}${isMine(row.name) ? ` <b>YOU</b>` : ""}</th>
                <td>${Number(row.wins || 0)}</td>
                <td>${Number(row.games || 0)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderBoard() {
    const element = root();
    const snapshot = state.snapshot;
    if (!element || !snapshot) return;
    const activeElement = document.activeElement;
    const focusedId = element.contains(activeElement) ? activeElement.id : "";
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const nestedScroll = {};
    ["plbQueueList", "plbStandingsTable"].forEach(id => {
      const scrollRegion = document.getElementById(id);
      if (scrollRegion) nestedScroll[id] = scrollRegion.scrollTop;
    });
    const players = snapshot.players || [];

    const session = snapshot.session || {};
    const round = snapshot.latestRound || { assignments: [], queue: [], roundNo: session.currentRound || 0 };
    const assignments = round.assignments || [];
    const queue = round.queue || [];
    const results = snapshot.resultCount === undefined
      ? assignments.filter(game => Boolean(game.winner)).length
      : Number(snapshot.resultCount || 0);
    const sessionStatus = session.status || "active";
    const sessionActive = sessionStatus === "active";
    const liveCourts = assignments.filter(game => !game.winner).length;
    const readyCourts = sessionStatus !== "completed"
      ? assignments.filter(game => Boolean(game.winner)).length
      : 0;
    const courtsEyebrow = sessionActive
      ? "Now playing"
      : sessionStatus === "paused"
        ? "Play is paused"
        : "Session complete";
    const courtsTitle = sessionActive
      ? "Live Courts"
      : sessionStatus === "paused"
        ? "Paused Courts"
        : "Final Court State";
    const courtsCountLabel = sessionActive
      ? `${liveCourts} live${readyCourts ? ` &middot; ${readyCourts} ready` : ""}`
      : `${assignments.length} shown`;
    const nextEyebrow = sessionActive
      ? "Ready group"
      : sessionStatus === "paused"
        ? "Queue paused"
        : "At session end";
    const nextTitle = sessionActive
      ? "Up Next"
      : sessionStatus === "paused"
        ? "Up Next (Paused)"
        : "Queue at End";
    const statusMessage = sessionStatus === "paused"
      ? "The manager paused this session. Court and queue positions remain visible."
      : sessionStatus === "completed"
        ? "This session is complete. Final results remain available for 24 hours."
        : "";
    const headerStats = document.getElementById("plbHeaderStats");
    if (headerStats) {
      headerStats.innerHTML = `
        <div><strong>${assignments.length}</strong><span>Courts</span></div>
        <div><strong>${players.length}</strong><span>Players</span></div>
        <div><strong>${queue.length}</strong><span>Waiting</span></div>
        <div><strong>${results}</strong><span>Results</span></div>
      `;
    }

    document.title = `Round ${Number(round.roundNo || 0)} · Paddle Rage Live`;
    element.className = "plb-board";
    element.setAttribute("aria-busy", "false");
    element.innerHTML = `
      <section class="plb-session-hero">
        <div>
          <span class="plb-eyebrow">${escapeHtml(statusLabel(sessionStatus))} OPEN PLAY</span>
          <h1>${escapeHtml(formatDate(session.date))}</h1>
          <p>Follow the live courts, playing order, and session standings.</p>
        </div>
        <div class="plb-session-meta">
          <span>${escapeHtml(session.timeLabel || "Paddle Rage Open Play")}</span>
          <strong>Round ${Number(round.roundNo || session.currentRound || 0)}</strong>
        </div>
      </section>

      ${statusMessage ? `<div class="plb-session-banner is-${escapeHtml(sessionStatus)}">${escapeHtml(statusMessage)}</div>` : ""}

      <div class="plb-player-tools">
        <section class="plb-find-card">
          <label for="plbFindName">
            <span>Find my position</span>
            <select id="plbFindName" aria-describedby="plbFindHelp">
              <option value="">Choose your name</option>
              ${state.selectedName && !players.includes(state.selectedName)
                ? `<option value="${escapeHtml(state.selectedName)}" selected>${escapeHtml(state.selectedName)} (not active)</option>`
                : ""}
              ${players.map(name => `
                <option value="${escapeHtml(name)}" ${name === state.selectedName ? "selected" : ""}>${escapeHtml(name)}</option>
              `).join("")}
            </select>
          </label>
          <p id="plbFindHelp">Saved only on this device. Your name will be highlighted across the live board.</p>
        </section>
        ${renderMyPosition(snapshot)}
      </div>

      <div class="plb-connection-note ${state.failures ? "is-error" : ""}" id="plbConnectionNote" role="status" aria-live="polite">
        ${state.failures ? "Connection interrupted. Showing the last update while reconnecting." : "Live connection active. This page refreshes automatically."}
      </div>

      <div class="plb-live-layout" id="plbLiveBoard">
        <div class="plb-live-content">
          <section class="plb-section" aria-labelledby="plbCourtsTitle">
            <div class="plb-round-strip">
              <div class="plb-round-copy">
                <span>${courtsEyebrow}</span>
                <h2 id="plbCourtsTitle">${courtsTitle}</h2>
                <small>${courtsCountLabel}</small>
              </div>
              <button class="plb-refresh" type="button" data-plb-action="refresh" aria-label="Refresh live board">
                <span aria-hidden="true">↻</span> Refresh
              </button>
            </div>
            <div class="plb-courts">
              ${assignments.map((game, index) => renderCourt(game, index, sessionStatus)).join("") || `<div class="plb-empty plb-empty-large">Court assignments have not started yet.</div>`}
            </div>
          </section>
        </div>

        <aside class="plb-live-rail" aria-label="Playing order and standings">
          <section class="plb-panel plb-next-panel" aria-labelledby="plbNextTitle">
            <div class="plb-panel-head">
              <div><span>${nextEyebrow}</span><h2 id="plbNextTitle">${nextTitle}</h2></div>
              <b>${Math.min(queue.length, 4)} / 4 ready</b>
            </div>
            <div class="plb-panel-body">${renderUpNext(queue, sessionStatus)}</div>
          </section>

          <section class="plb-panel plb-queue-panel" aria-labelledby="plbQueueTitle">
            <div class="plb-panel-head">
              <div><span>Playing order</span><h2 id="plbQueueTitle">Player Queue</h2></div>
              <b>${queue.length} waiting</b>
            </div>
            <div class="plb-panel-body">${renderQueue(queue)}</div>
          </section>

          <section class="plb-panel plb-standings-panel" aria-labelledby="plbStandingsTitle">
            <div class="plb-panel-head">
              <div><span>Session totals</span><h2 id="plbStandingsTitle">Standings</h2></div>
              <b>Wins · Games</b>
            </div>
            <div class="plb-panel-body">${renderStandings(snapshot.standings || [])}</div>
          </section>
        </aside>
      </div>
    `;

    Object.entries(nestedScroll).forEach(([id, top]) => {
      const scrollRegion = document.getElementById(id);
      if (scrollRegion) scrollRegion.scrollTop = top;
    });
    if (focusedId) {
      element.querySelector(`#${CSS.escape(focusedId)}`)?.focus({ preventScroll: true });
      window.scrollTo(scrollX, scrollY);
    }
    updateHeader();
    updateClocks();
  }

  function renderUnavailable() {
    const element = root();
    if (!element) return;
    const headerStats = document.getElementById("plbHeaderStats");
    if (headerStats) {
      headerStats.innerHTML = `
        <div><strong>–</strong><span>Courts</span></div>
        <div><strong>–</strong><span>Players</span></div>
        <div><strong>–</strong><span>Waiting</span></div>
        <div><strong>–</strong><span>Results</span></div>
      `;
    }
    element.className = "plb-message-card";
    element.setAttribute("aria-busy", "false");
    element.innerHTML = `
      <span class="plb-message-icon" aria-hidden="true">×</span>
      <span class="plb-eyebrow">Player link unavailable</span>
      <h1>This live board is no longer active.</h1>
      <p>The session may have ended, or the manager may have generated a new link. Ask Paddle Rage staff for the latest QR code.</p>
    `;
    const announcement = document.getElementById("plbAnnouncements");
    if (announcement) {
      announcement.textContent = "This player link is no longer active. Ask Paddle Rage staff for the latest QR code.";
    }
    updateHeader();
  }

  function renderConnectionError() {
    const element = root();
    if (!element) return;
    element.className = "plb-message-card";
    element.setAttribute("aria-busy", "false");
    element.innerHTML = `
      <span class="plb-message-icon is-warn" aria-hidden="true">↻</span>
      <span class="plb-eyebrow">Connection problem</span>
      <h1>The courts could not load yet.</h1>
      <p>Check your internet connection, then try again. The board will also reconnect automatically.</p>
      <button class="plb-refresh is-primary" type="button" data-plb-action="refresh">Try Again</button>
    `;
    updateHeader();
  }

  function contentSignature(snapshot) {
    return JSON.stringify([
      snapshot.session || null,
      snapshot.players || [],
      snapshot.latestRound || null,
      snapshot.standings || [],
      Number(snapshot.resultCount || 0),
      snapshot.latestResult || null,
    ]);
  }

  function announceUpdate(snapshot) {
    const announcement = document.getElementById("plbAnnouncements");
    if (!announcement || !snapshot) return;
    const round = snapshot.latestRound || {};
    const assignments = round.assignments || [];
    const queue = round.queue || [];
    const sessionStatus = String(snapshot.session?.status || "active");
    const unfinishedCourts = assignments.filter(game => !game.winner).length;
    const courtUpdate = sessionStatus === "active"
      ? `${unfinishedCourts} active court${unfinishedCourts === 1 ? "" : "s"}.`
      : sessionStatus === "paused"
        ? `Session paused with ${unfinishedCourts} unfinished court${unfinishedCourts === 1 ? "" : "s"}.`
        : `Session complete with ${assignments.length} court${assignments.length === 1 ? "" : "s"} shown.`;
    const resultCount = snapshot.resultCount === undefined
      ? assignments.filter(game => Boolean(game.winner)).length
      : Number(snapshot.resultCount || 0);
    const position = myPosition(snapshot);
    const playerUpdate = position
      ? ` ${position.eyebrow}: ${position.title}.`
      : "";
    const reveal = state.winnerReveal;
    const winnerUpdate = reveal
      ? ` ${winningNames(reveal).join(" and ")} won on ${reveal.courtName || "their court"}.`
      : "";
    const matchupUpdate = state.matchupReveals.length
      ? ` ${state.matchupReveals.map(matchup => {
          const team1 = (matchup.team1 || []).join(" and ") || "Team 1";
          const team2 = (matchup.team2 || []).join(" and ") || "Team 2";
          return `New match on ${matchup.courtName}: ${team1} versus ${team2}.`;
        }).join(" ")}`
      : "";
    announcement.textContent = [
      `Live board updated. Round ${Number(round.roundNo || snapshot.session?.currentRound || 0)}.`,
      courtUpdate,
      `${queue.length} player${queue.length === 1 ? "" : "s"} waiting.`,
      `${resultCount} result${resultCount === 1 ? "" : "s"} recorded.`,
      winnerUpdate,
      matchupUpdate,
      playerUpdate,
    ].join(" ").trim();
  }

  function updateClocks() {
    document.querySelectorAll("[data-live-start]").forEach(element => {
      element.textContent = elapsedLabel(element.dataset.liveStart);
    });
    updateHeader();
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.terminal || document.hidden) return;
    const delay = state.failures
      ? Math.min(60000, POLL_MS * (2 ** Math.min(state.failures, 3)))
      : POLL_MS;
    state.pollTimer = setTimeout(fetchSnapshot, delay);
  }

  async function fetchSnapshot() {
    if (state.inFlight || state.terminal || document.hidden) return;
    state.inFlight = true;
    document.querySelectorAll('[data-plb-action="refresh"]').forEach(button => {
      button.disabled = true;
    });
    try {
      const snapshot = await DB.getPublicOpenPlayGameLiveBoard(state.token);
      if (!snapshot) {
        state.terminal = true;
        state.snapshot = null;
        renderUnavailable();
        return;
      }
      const hadSnapshot = Boolean(state.snapshot);
      const winnerReveal = hadSnapshot ? winnerRevealForUpdate(state.snapshot, snapshot) : null;
      const matchupReveals = hadSnapshot ? matchupRevealsForUpdate(state.snapshot, snapshot) : [];
      const signature = contentSignature(snapshot);
      state.snapshot = snapshot;
      state.failures = 0;
      if (signature !== state.signature) {
        state.signature = signature;
        if (winnerReveal || matchupReveals.length) {
          clearTimeout(state.winnerRevealTimer);
          clearTimeout(state.matchupRevealTimer);
          state.winnerReveal = winnerReveal;
          state.pendingMatchupReveals = winnerReveal ? matchupReveals : [];
          state.matchupReveals = winnerReveal ? [] : matchupReveals;
        }
        renderBoard();
        if (hadSnapshot) announceUpdate(snapshot);
        if (winnerReveal) scheduleWinnerRevealEnd(matchupReveals);
        else if (matchupReveals.length) scheduleMatchupRevealEnd();
      } else {
        const note = document.getElementById("plbConnectionNote");
        if (note) {
          note.classList.remove("is-error");
          note.textContent = "Live connection active. This page refreshes automatically.";
        }
        updateHeader();
      }
    } catch (error) {
      state.failures += 1;
      if (!state.snapshot) renderConnectionError();
      else {
        const note = document.getElementById("plbConnectionNote");
        if (note) {
          note.classList.add("is-error");
          note.textContent = "Connection interrupted. Showing the last update while reconnecting.";
        }
        updateHeader();
      }
    } finally {
      state.inFlight = false;
      document.querySelectorAll('[data-plb-action="refresh"]').forEach(button => {
        button.disabled = false;
      });
      schedulePoll();
    }
  }

  function handleClick(event) {
    const button = event.target.closest("[data-plb-action]");
    if (!button) return;
    if (button.dataset.plbAction === "refresh") {
      clearTimeout(state.pollTimer);
      fetchSnapshot();
    }
  }

  function handleChange(event) {
    if (event.target.id !== "plbFindName") return;
    saveSelectedName(event.target.value);
    renderBoard();
    announceUpdate(state.snapshot);
  }

  function start() {
    state.selectedName = readSelectedName();
    root()?.addEventListener("click", handleClick);
    root()?.addEventListener("change", handleChange);
    state.clockTimer = setInterval(updateClocks, 1000);

    if (!/^[0-9a-f]{64}$/.test(state.token)) {
      state.terminal = true;
      renderUnavailable();
      return;
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearTimeout(state.pollTimer);
      } else {
        fetchSnapshot();
      }
    });
    window.addEventListener("online", fetchSnapshot);
    window.addEventListener("offline", () => {
      state.failures = Math.max(1, state.failures);
      updateHeader();
      const note = document.getElementById("plbConnectionNote");
      if (note) {
        note.classList.add("is-error");
        note.textContent = "You are offline. Showing the last saved live update.";
      }
    });
    window.addEventListener("hashchange", () => location.reload());
    fetchSnapshot();
  }

  start();
})();
