const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/migrations/20260725110000_play_manager_live_sharing.sql");
const lifecycleMigration = read("supabase/migrations/20260725120000_play_manager_live_share_lifecycle.sql");
const mutationGuardMigration = read("supabase/migrations/20260725130000_play_manager_session_mutation_guard.sql");
const replacementMigration = read("supabase/migrations/20260725100000_play_manager_player_replacement.sql");
const queueWaitMigration = read("supabase/migrations/20260725140000_play_manager_queue_wait_time.sql");
const winnerCorrectionMigration = read("supabase/migrations/20260725150000_play_manager_match_winner_correction.sql");
const winnerRevealMigration = read("supabase/migrations/20260725160000_play_manager_winner_reveal.sql");
const readyCourtMigrationPath = "supabase/migrations/20260725170000_play_manager_ready_courts.sql";
const readyCourtMigration = fs.existsSync(path.join(root, readyCourtMigrationPath))
  ? read(readyCourtMigrationPath)
  : "";
const playerSkillMigrationPath = "supabase/migrations/20260725180000_play_manager_player_skill_levels.sql";
const playerSkillMigration = fs.existsSync(path.join(root, playerSkillMigrationPath))
  ? read(playerSkillMigrationPath)
  : "";
const client = read("supabase-config.js");
const setupSql = read("SETUP_NEW_SUPABASE.sql");
const manager = read("play-manager.js");
const managerCss = read("play-manager.css");
const playerPage = read("player-live.html");
const playerClient = read("player-live.js");
const playerCss = read("player-live.css");
const admin = read("admin.html");
const headers = read("_headers");
const deployScript = read("deploy-cloudflare-pages.ps1");
const gitignore = read(".gitignore");

test("live-board bearer secrets are hashed in a locked table", () => {
  const shareTable = migration.match(
    /create table if not exists public\.open_play_game_session_shares[\s\S]*?\n\);/i
  )?.[0] || "";
  assert.match(migration, /create table if not exists public\.open_play_game_session_shares/i);
  assert.match(migration, /token_hash\s+bytea not null unique/i);
  assert.match(migration, /check \(octet_length\(token_hash\) = 32\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(
    migration,
    /revoke all on table public\.open_play_game_session_shares\s+from public, anon, authenticated/i
  );
  assert.match(migration, /extensions\.digest\(v_token, 'sha256'\)/i);
  assert.doesNotMatch(shareTable, /public_share_token|share_token\s+text|\btoken\s+text/i);
});

test("only active dashboard roles can create, rotate, or revoke player links", () => {
  const management = migration.match(
    /create function public\.set_open_play_game_public_share[\s\S]*?\n\$\$;/i
  )?.[0] || "";
  assert.match(management, /account\.id = auth\.uid\(\)/i);
  assert.match(management, /account\.status = 'active'/i);
  assert.match(management, /account\.role in \('owner', 'court_owner', 'staff'\)/i);
  assert.match(management, /extensions\.gen_random_bytes\(32\)/i);
  assert.match(management, /delete from public\.open_play_game_session_shares/i);
  assert.match(
    migration,
    /grant execute on function public\.set_open_play_game_public_share\(uuid, boolean\)\s+to authenticated, service_role/i
  );
});

test("anonymous live-board reads require the token and return a narrow projection", () => {
  const publicFunction = migration.match(
    /create function public\.get_public_open_play_game_live_board[\s\S]*?\n\$\$;/i
  )?.[0] || "";
  assert.match(publicFunction, /security definer/i);
  assert.match(publicFunction, /char_length\(p_share_token\) <> 64/i);
  assert.match(publicFunction, /\^\[0-9a-f\]\{64\}\$/i);
  assert.match(publicFunction, /share\.token_hash = extensions\.digest\(p_share_token, 'sha256'\)/i);
  assert.match(publicFunction, /session\.status in \('active', 'paused'\)/i);
  assert.match(publicFunction, /session\.status = 'completed'[\s\S]*?interval '24 hours'/i);
  assert.doesNotMatch(
    publicFunction,
    /source_registration_id|contact_number|email|court_ids|partner_history|opponent_history|to_jsonb\(v_session\)|to_jsonb\(v_latest_round\)/i
  );
  assert.match(publicFunction, /'courtName'[\s\S]*?'team1'[\s\S]*?'team2'[\s\S]*?'winner'/i);
  assert.match(publicFunction, /'name'[\s\S]*?'games'[\s\S]*?'wins'/i);
  assert.match(
    migration,
    /grant execute on function public\.get_public_open_play_game_live_board\(text\)\s+to anon, authenticated, service_role/i
  );
});

test("production and local adapters expose the same sharing API", () => {
  assert.equal((client.match(/async setOpenPlayGamePublicShare\(/g) || []).length, 2);
  assert.equal((client.match(/async rotateOpenPlayGamePublicShare\(/g) || []).length, 2);
  assert.equal((client.match(/async getPublicOpenPlayGameLiveBoard\(/g) || []).length, 2);
  assert.match(client, /_sb\.rpc\('set_open_play_game_public_share'/i);
  assert.match(client, /_sb\.rpc\('rotate_open_play_game_public_share'/i);
  assert.match(client, /_sb\.rpc\('get_public_open_play_game_live_board'/i);
  assert.match(client, /openPlayGameShares: \[\]/i);
  assert.match(client, /function localOpenPlayLiveBoard\(/i);
  assert.doesNotMatch(
    client.match(/function localOpenPlayLiveBoard[\s\S]*?\n  }\n\n  window\.DB/i)?.[0] || "",
    /source_registration_id\s*:|contact_number\s*:|email\s*:/
  );
  assert.match(client, /share\.expires_at[\s\S]*?shareExpiresAt <= Date\.now\(\)/i);
  assert.match(client, /resultCount/i);
});

test("share lifecycle supports independent links, explicit rotation, and absolute expiry", () => {
  assert.match(lifecycleMigration, /add column if not exists id uuid default gen_random_uuid\(\)/i);
  assert.match(
    lifecycleMigration,
    /add constraint open_play_game_session_shares_pkey primary key \(id\)/i
  );
  assert.match(lifecycleMigration, /create index if not exists idx_open_play_game_session_shares_session/i);
  assert.match(lifecycleMigration, /add column if not exists expires_at timestamptz/i);
  assert.match(lifecycleMigration, /expires_at <= now\(\)/i);
  assert.match(lifecycleMigration, /insert into public\.open_play_game_session_shares/i);
  assert.doesNotMatch(lifecycleMigration, /on conflict\s*\(\s*session_id\s*\)/i);
  assert.match(lifecycleMigration, /create function public\.rotate_open_play_game_public_share/i);
  assert.match(lifecycleMigration, /where session\.id = p_session_id\s+for update/i);
  assert.match(
    lifecycleMigration,
    /token_hash <> extensions\.digest\(v_token, 'sha256'\)/i
  );
  assert.match(lifecycleMigration, /share\.expires_at > now\(\)/i);
  assert.match(lifecycleMigration, /jsonb_build_object\('resultCount', v_result_count\)/i);
});

test("ended sessions reject stale roster and round mutations across staff devices", () => {
  assert.match(
    mutationGuardMigration,
    /create unique index if not exists idx_op_game_rounds_session_round_no_unique/i
  );
  assert.match(mutationGuardMigration, /guard_open_play_game_session_transition/i);
  assert.match(
    mutationGuardMigration,
    /old\.status in \('completed', 'cancelled'\)[\s\S]*?PLAY_MANAGER_SESSION_TERMINAL/i
  );
  assert.match(mutationGuardMigration, /guard_open_play_game_round_mutation/i);
  assert.match(
    mutationGuardMigration,
    /from public\.open_play_game_sessions session[\s\S]*?for update/i
  );
  assert.match(
    mutationGuardMigration,
    /tg_op = 'UPDATE'[\s\S]*?v_status <> 'active'[\s\S]*?PLAY_MANAGER_SESSION_NOT_ACTIVE/i
  );
  assert.match(mutationGuardMigration, /guard_open_play_game_player_mutation/i);
  assert.match(mutationGuardMigration, /drop policy if exists op_game_rounds_admin_all/i);
  assert.match(mutationGuardMigration, /drop policy if exists op_game_rounds_dashboard_all/i);
  assert.match(mutationGuardMigration, /drop policy if exists op_game_players_admin_all/i);
  assert.match(mutationGuardMigration, /drop policy if exists op_game_players_dashboard_all/i);
  assert.match(
    mutationGuardMigration,
    /public\.has_account_role\(array\['owner', 'court_owner', 'staff'\]\)/i
  );
  assert.match(mutationGuardMigration, /delete_latest_open_play_game_round_guarded/i);
  assert.match(mutationGuardMigration, /clear_open_play_game_rounds_guarded/i);
  assert.match(
    mutationGuardMigration,
    /clear_open_play_game_rounds_guarded[\s\S]*?for v_round in[\s\S]*?for update[\s\S]*?select session\.status, session\.current_round[\s\S]*?for update/i
  );
  assert.match(
    mutationGuardMigration,
    /old\.round_no <> coalesce\(v_current_round, 0\)[\s\S]*?PLAY_MANAGER_ROUND_CONFLICT/i
  );
  assert.match(client, /_sb\.rpc\('delete_latest_open_play_game_round_guarded'/i);
  assert.match(client, /_sb\.rpc\('clear_open_play_game_rounds_guarded'/i);
  assert.match(client, /function requireLocalPlayManagerSession\(/i);
  assert.match(
    client,
    /async updateOpenPlayGameRoundIfCurrent[\s\S]*?requireLocalPlayManagerSession\(db, current\.session_id, \['active'\]\)/i
  );
});

test("share links keep the bearer token in the URL fragment", () => {
  assert.match(manager, /url\.hash = token/i);
  assert.doesNotMatch(manager, /searchParams\.set\(["'](?:s|token|share)/i);
  assert.match(playerClient, /String\(location\.hash \|\| ""\)\.slice\(1\)/i);
  assert.match(playerClient, /\^\[0-9a-f\]\{64\}\$/i);
  assert.match(playerPage, /meta name="referrer" content="no-referrer"/i);
  assert.match(playerPage, /meta name="robots" content="noindex,nofollow,noarchive"/i);
});

test("manager offers separate text-copy and live-sharing actions", () => {
  assert.match(manager, /data-pm-action="share-live"/i);
  assert.match(manager, /canShare \? "Share Live" : "Sharing Ended"/i);
  assert.match(manager, />Copy Text Update<\/button>/i);
  assert.match(manager, /id="pm2ShareDialog"/i);
  assert.match(manager, /data-pm-action="rotate-live-link"/i);
  assert.match(manager, /data-pm-action="disable-live-link"/i);
  assert.doesNotMatch(manager, /data-pm-action="copy-update"/i);
  assert.match(manager, /class="pm2-live-court-actions"[\s\S]*?data-pm-action="edit-setup"[\s\S]*?data-pm-action="share-live"/i);
  assert.doesNotMatch(manager, /class="pm2-mobile-dock"/i);
  const qrScriptIndex = admin.indexOf("qrcode.min.js?v=1.5.4");
  const managerScriptIndex = admin.search(/play-manager\.js\?v=[^"']+/i);
  assert.ok(
    qrScriptIndex >= 0 && managerScriptIndex > qrScriptIndex,
    "the local QR encoder must load before the manager module"
  );
  assert.ok(fs.statSync(path.join(root, "qrcode.min.js")).size > 10000);
});

test("player view ships with private caching headers and the QR license", () => {
  assert.match(
    headers,
    /\/player-live\r?\n\s+Cache-Control: no-store\r?\n\s+Referrer-Policy: no-referrer/i
  );
  assert.match(deployScript, /"qrcode-LICENSE\.txt"/i);
  assert.match(gitignore, /!qrcode-LICENSE\.txt/i);
  assert.match(read("qrcode-LICENSE.txt"), /The MIT License/i);
});

test("player live board uses the transparent system logo without a badge background", () => {
  assert.match(
    playerPage,
    /<img class="plb-brand-mark" src="paddleragelogo-transparent\.png" alt="" width="48" height="48" aria-hidden="true">/i
  );
  assert.doesNotMatch(playerPage, /class="plb-brand-mark"[^>]*>PR<\/span>/i);
  assert.match(playerPage, /player-live\.css\?v=20260728-smooth-live-v4/i);
  assert.match(
    playerCss,
    /\.plb-brand-mark\s*\{[\s\S]*?width:\s*48px[\s\S]*?height:\s*48px[\s\S]*?border:\s*0[\s\S]*?background:\s*transparent[\s\S]*?object-fit:\s*contain/i
  );
});

test("Share Live is a spectator-first, responsive match center", () => {
  const matchCenterCss = playerCss.match(
    /\/\* Spectator-first Live Match Center \*\/([\s\S]*)$/i
  )?.[1] || "";

  assert.match(playerPage, /id="plbHeaderStats"[^>]*aria-label="Session totals"/i);
  assert.match(playerPage, /id="plbHeaderSession"[^>]*aria-label="Current session"/i);
  assert.match(playerPage, />Skip to live board</i);
  assert.match(playerPage, /data-plb-action="share"[^>]*aria-label="Share this live match center"/i);
  assert.match(
    playerPage,
    /class="plb-mobile-nav"[\s\S]*?href="#plbCourts"[\s\S]*?href="#plbDispatch"[\s\S]*?href="#plbQueue"[\s\S]*?href="#plbStandings"/i
  );
  assert.match(playerClient, /class="plb-live-layout" id="plbLiveBoard"/i);
  assert.match(playerClient, /class="plb-live-rail" aria-label="Playing order and standings"/i);
  assert.doesNotMatch(playerClient, /<main class="plb-live-content"/i);
  assert.match(
    playerClient,
    /id="plbFindName" aria-describedby="plbFindHelp"/i
  );
  assert.match(
    playerClient,
    /id="plbQueueList" tabindex="0" aria-label="Waiting players in playing order"/i
  );
  assert.match(
    playerClient,
    /id="plbStandingsTable" tabindex="0" aria-label="Player standings"/i
  );
  assert.match(
    playerClient,
    /\["plbQueueList", "plbStandingsTable"\][\s\S]*?nestedScroll\[id\] = scrollRegion\.scrollTop/i
  );
  assert.match(
    playerClient,
    /Object\.entries\(nestedScroll\)[\s\S]*?scrollRegion\.scrollTop = top/i
  );
  assert.ok(
    playerClient.indexOf('id="plbCourts"') < playerClient.indexOf('id="plbDispatch"')
    && playerClient.indexOf('id="plbDispatch"') < playerClient.indexOf('id="plbQueue"')
    && playerClient.indexOf('id="plbQueue"') < playerClient.indexOf('id="plbStandings"'),
    "spectator sections should render in courts, Up Next, queue, standings order"
  );
  assert.match(playerClient, /function resolveDispatchGroups\(round, upNext\)/i);
  assert.match(playerClient, /while \(groups\.length < 3\)/i);
  assert.match(playerClient, /return groups\.slice\(0, 3\)/i);
  assert.match(playerClient, /const visibleQueue = queue\.slice\(0, 10\)/i);
  assert.match(playerClient, /const topStandings = standings\.slice\(0, 10\)/i);
  assert.match(playerClient, /navigator\.share\(shareData\)/i);
  assert.match(playerClient, /navigator\.clipboard\?\.writeText/i);
  assert.match(playerCss, /--plb-navy:\s*#111827/i);
  assert.match(playerCss, /--plb-navy-2:\s*#1f2937/i);
  assert.match(playerCss, /--plb-canvas:\s*#f1f3f6/i);
  assert.match(
    matchCenterCss,
    /\.plb-live-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/i
  );
  assert.match(
    matchCenterCss,
    /\.plb-live-rail\s*\{[^}]*grid-template-columns:\s*minmax\(280px,\s*\.72fr\) minmax\(0,\s*1\.28fr\)/i
  );
  assert.match(
    matchCenterCss,
    /@media \(min-width:\s*721px\)\s*\{[\s\S]*?\.plb-courts,\s*\.plb-dispatch-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/i
  );
  assert.match(
    matchCenterCss,
    /\.plb-match\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-auto-rows:\s*auto[^}]*align-items:\s*start/i
  );
  assert.match(
    matchCenterCss,
    /\.plb-team\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*34px auto[^}]*min-height:\s*0/i
  );
  assert.match(
    matchCenterCss,
    /\.plb-team-label\s*\{[^}]*height:\s*34px[^}]*min-height:\s*34px/i
  );
  assert.match(
    matchCenterCss,
    /\.plb-team ul\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*48px\)[^}]*height:\s*auto[^}]*min-height:\s*0/i
  );
  assert.match(
    matchCenterCss,
    /\.plb-player\s*\{[^}]*height:\s*48px[^}]*min-height:\s*48px[^}]*overflow:\s*hidden/i
  );
  assert.doesNotMatch(playerClient, /<span>Court \$\{index \+ 1\}<\/span>/i);
  assert.match(matchCenterCss, /\.plb-queue-list\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/is);
  assert.match(matchCenterCss, /\.plb-table-wrap\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/is);
  assert.match(
    matchCenterCss,
    /@media \(max-width:\s*720px\)[\s\S]*?\.plb-mobile-nav\s*\{[^}]*position:\s*fixed[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/i
  );
  assert.match(matchCenterCss, /bottom:\s*max\(8px,\s*env\(safe-area-inset-bottom\)\)/i);
  assert.match(
    matchCenterCss,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.plb-winner-reveal,[\s\S]*?display:\s*none !important/i
  );
});

test("Share Live updates smoothly without recurring blink animations", () => {
  const fetchSnapshot = playerClient.match(
    /async function fetchSnapshot\(\{ showBusy = false \} = \{\}\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function handleClick/i
  )?.[0] || "";
  const handleClick = playerClient.match(
    /function handleClick\(event\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function handleChange/i
  )?.[0] || "";

  assert.match(playerClient, /hasRendered:\s*false/i);
  assert.match(playerClient, /const initialRender = !state\.hasRendered/i);
  assert.match(
    playerClient,
    /element\.className = `plb-board\$\{initialRender \? " is-initial-render" : ""\}`/i
  );
  assert.match(playerClient, /state\.hasRendered = true/i);
  assert.match(fetchSnapshot, /if \(showBusy\)[\s\S]*?button\.disabled = true/i);
  assert.match(fetchSnapshot, /if \(showBusy\)[\s\S]*?button\.disabled = false/i);
  assert.match(handleClick, /fetchSnapshot\(\{ showBusy: true \}\)/i);
  assert.match(playerClient, /state\.pollTimer = setTimeout\(fetchSnapshot, delay\)/i);
  assert.match(
    playerClient,
    /const currentId = links[\s\S]*?aria-current[\s\S]*?sections\.some\(section => section\.id === currentId\) \? currentId/i
  );
  assert.doesNotMatch(playerClient, /setCurrent\(sections\[0\]\?\.id \|\| ""\);/i);

  assert.match(
    playerCss,
    /\.plb-status-pill\.is-active::before\s*\{[^}]*animation:\s*none/i
  );
  assert.match(
    playerCss,
    /\.plb-court-pill\.is-live::before\s*\{[^}]*animation:\s*none/i
  );
  assert.match(
    playerCss,
    /\.plb-matchup-live-dot\s*\{[^}]*animation:\s*none/i
  );
  assert.match(
    playerCss,
    /\.plb-board\.is-initial-render \.plb-court-card,[\s\S]*?animation:\s*plb-enter-up/i
  );
  assert.doesNotMatch(playerCss, /plb-ready-glow/i);

  const signatureStart = playerClient.indexOf("  function contentSignature(");
  const signatureEnd = playerClient.indexOf("  function announceUpdate(", signatureStart);
  assert.ok(signatureStart >= 0 && signatureEnd > signatureStart, "content signature must be extractable");
  const signature = new Function(
    `${playerClient.slice(signatureStart, signatureEnd)}\nreturn contentSignature;`
  )();
  const baseSnapshot = {
    generatedAt: "2026-07-28T06:00:00.000Z",
    session: { date: "2026-07-28", timeLabel: "6PM–10PM", status: "active", currentRound: 1 },
    players: ["A", "B", "C", "D"],
    latestRound: {
      roundNo: 1,
      assignments: [{
        courtName: "Court 1",
        team1: ["A", "B"],
        team2: ["C", "D"],
        startedAt: "2026-07-28T06:00:00.000Z",
        winner: null,
        gameCount: 1,
      }],
      queue: ["A", "B", "C", "D"],
    },
    standings: [{ name: "A", wins: 0, games: 1 }],
    resultCount: 0,
    latestResult: null,
  };
  const semanticallyEqual = {
    ...structuredClone(baseSnapshot),
    generatedAt: "2026-07-28T06:00:03.000Z",
    ignoredServerField: "does not render",
    session: { ...baseSnapshot.session, ignoredServerField: true },
  };
  assert.equal(
    signature(baseSnapshot),
    signature(semanticallyEqual),
    "freshness and unrelated response fields must not recreate the live board"
  );
  const changedSnapshot = structuredClone(baseSnapshot);
  changedSnapshot.latestRound.queue = ["B", "A", "C", "D"];
  assert.notEqual(signature(baseSnapshot), signature(changedSnapshot));
});

test("manager exposes clear live-session completion controls", () => {
  assert.match(manager, /data-pm-action="end-session"/i);
  assert.match(manager, /data-pm-action="choose-players"/i);
  assert.match(manager, /data-pm-action="start-match"/i);
  assert.match(
    manager,
    /class="pm2-round-actions"[\s\S]*?data-pm-action="share-live"[\s\S]*?data-pm-action="copy-text-update"[\s\S]*?data-pm-action="edit-setup"[\s\S]*?data-pm-action="end-session"[\s\S]*?<\/div>/i
  );
  assert.doesNotMatch(manager, /data-pm-action="undo-round"|function undoRound\(/i);
  assert.doesNotMatch(manager, /data-pm-action="next-round"|Start Next Round/i);
  assert.doesNotMatch(manager, />Courts Live<\/button>/i);
  assert.match(manager, /DB\.rotateOpenPlayGamePublicShare\(state\.session\.id\)/i);
  assert.match(manager, /const newBoard = await DB\.getPublicOpenPlayGameLiveBoard\(token\)/i);
  assert.match(manager, /Results can only be recorded while the session is active/i);
  assert.match(
    managerCss,
    /\.pm2-session-end\s*\{[\s\S]*?color:\s*#f8c7ce[\s\S]*?border-color:\s*#a94b5b[\s\S]*?background:\s*#3b252d/i
  );
  assert.match(
    managerCss,
    /\.pm2-session-end:hover:not\(:disabled\)\s*\{[\s\S]*?color:\s*#fff[\s\S]*?background:\s*#c4324a/i
  );
});

test("completed sessions show a top-three podium and rankings from fourth onward", () => {
  const completedMarkup = manager.match(
    /function completedSessionMarkup\(matches, standings\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function matchTimeMarkup/i
  )?.[0] || "";

  assert.match(manager, /const leaders = rows\.slice\(0, 3\)/i);
  assert.match(manager, /const remaining = rows\.slice\(3\)/i);
  assert.match(manager, /const rank = index \+ 4/i);
  assert.match(completedMarkup, /Tonight&rsquo;s champions/i);
  assert.match(completedMarkup, /Top 3 players/i);
  assert.match(completedMarkup, /Full leaderboard/i);
  assert.match(completedMarkup, /Rankings #4&ndash;#/i);
  assert.match(completedMarkup, /id="pm2MatchLog"/i);
  assert.match(
    manager,
    /if \(sessionStatus === "completed"\) \{\s*return completedSessionMarkup\(matches, standings\)/i
  );
  assert.match(
    managerCss,
    /\.pm2-podium-card\.is-rank-1\s*\{[^}]*order:\s*2[^}]*min-height:\s*260px/is
  );
  assert.match(
    managerCss,
    /\.pm2-final-grid\s*\{[^}]*grid-template-columns:\s*minmax\(310px,\s*\.8fr\) minmax\(0,\s*1\.2fr\)/is
  );
  assert.match(
    managerCss,
    /@media \(max-width:\s*720px\)[\s\S]*?\.pm2-podium-card\.is-rank-1\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*order:\s*1/is
  );
});

test("completed sessions download a branded Paddle Rage result image", () => {
  const brandedDownload = manager.match(
    /async function downloadBrandedResult\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function exportCsv/i
  )?.[0] || "";

  assert.match(manager, /data-pm-action="download-result">Download branded result/i);
  assert.match(brandedDownload, /state\.session\?\.status[\s\S]*?completed/i);
  assert.match(brandedDownload, /document\.createElement\("canvas"\)/i);
  assert.match(brandedDownload, /loadResultBrandLogo\(\)/i);
  assert.match(manager, /image\.src = "paddleragelogo-transparent\.png"/i);
  assert.match(brandedDownload, /PADDLE RAGE PICKLEBALL/i);
  assert.match(brandedDownload, /SESSION CHAMPIONS/i);
  assert.match(brandedDownload, /const topStandings = standings\.slice\(0, 10\)/i);
  assert.match(brandedDownload, /const remaining = topStandings\.slice\(3\)/i);
  assert.match(brandedDownload, /TOP \$\{topStandings\.length\} LEADERBOARD/i);
  assert.match(brandedDownload, /Showing \$\{topStandings\.length\} of \$\{standings\.length\} players/i);
  assert.match(
    manager,
    /const placeY = avatarY \+ avatarRadius \+ 30[\s\S]*?const nameY = placeY \+ 40[\s\S]*?const recordY = nameY \+ \(isChampion \? 72 : 62\)[\s\S]*?const metaY = y \+ height - 28/i
  );
  assert.match(brandedDownload, /canvas\.toBlob\(resolve, "image\/png"\)/i);
  assert.match(brandedDownload, /paddle-rage-results-\$\{state\.session\?\.date \|\| localDateValue\(\)\}\.png/i);
  assert.match(manager, /action === "download-result"[\s\S]*?withBusy\(downloadBrandedResult\)/i);
  assert.match(
    managerCss,
    /@media \(max-width:\s*720px\)[\s\S]*?\.pm2-final-actions \.pm2-btn-download\s*\{[^}]*grid-column:\s*1 \/ -1/is
  );
});

test("player board announces changes and preserves an inactive name selection", () => {
  assert.match(playerPage, /id="plbAnnouncements"[\s\S]*?aria-live="polite"/i);
  assert.match(playerClient, /function announceUpdate\(snapshot\)/i);
  assert.match(playerClient, /snapshot\.resultCount/i);
  assert.match(playerClient, /\(not active\)/i);
  assert.doesNotMatch(
    playerClient,
    /if \(state\.selectedName && !players\.includes\(state\.selectedName\)\) saveSelectedName\(""\)/i
  );
  assert.match(playerClient, /renderCourt\(game, index, sessionStatus\)/i);
});

test("new results play one contained winner reveal in the manager and shared board", () => {
  assert.match(
    winnerRevealMigration,
    /create or replace function public\.get_public_open_play_game_live_board/i
  );
  assert.match(
    winnerRevealMigration,
    /v_latest_result := jsonb_build_object\([\s\S]*?'courtIndex'[\s\S]*?'team1'[\s\S]*?'team2'[\s\S]*?'winner'/i
  );
  assert.match(winnerRevealMigration, /'latestResult', v_latest_result/i);
  assert.match(
    winnerRevealMigration,
    /share\.token_hash = extensions\.digest\(p_share_token, 'sha256'\)[\s\S]*?share\.expires_at > now\(\)/i
  );
  assert.match(client, /latestResult\s*=\s*null/i);
  assert.match(client, /latestResult,\s*\n\s*\};/i);

  assert.match(manager, /function playWinnerReveal\(courtIndex, winner\)/i);
  assert.match(manager, /data-pm-team="A"[\s\S]*?pm2-team-win-badge">WIN/i);
  assert.match(manager, /await playWinnerReveal\(index, winner\)/i);
  assert.match(managerCss, /@keyframes pm2-winner-team-lift/i);
  assert.match(managerCss, /@keyframes pm2-win-badge-spring/i);
  assert.match(managerCss, /\.pm2-winner-sparks::before/i);

  assert.match(playerClient, /function winnerRevealForUpdate\(previousSnapshot, nextSnapshot\)/i);
  assert.match(playerClient, /nextCount <= previousCount/i);
  assert.match(playerClient, /const winnerReveal = hadSnapshot \? winnerRevealForUpdate/i);
  assert.match(playerClient, /function renderWinnerReveal\(result\)/i);
  assert.match(playerClient, /scheduleWinnerRevealEnd\(/i);
  assert.match(playerCss, /@keyframes plb-winner-reveal/i);
  assert.match(playerCss, /\.plb-winner-reveal-sparks::before/i);
  assert.match(playerPage, /player-live\.js\?v=20260728-smooth-live-v2/i);
});

test("Share Live keeps the completed winner visible while its court is READY", () => {
  const renderCourt = playerClient.match(
    /function renderCourt\(game, index, sessionStatus = "active"\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function renderUpNext/i
  )?.[0] || "";

  assert.match(renderCourt, /game\.winner/i);
  assert.match(renderCourt, /READY/i);
  assert.match(renderCourt, /is-ready/i);
  assert.match(renderCourt, /Waiting for next match/i);
  assert.match(renderCourt, /game\.team1[\s\S]*?game\.team2/i);
  assert.match(renderCourt, /Team 1[\s\S]*?Team 2/i);
  assert.doesNotMatch(playerClient, /\breadyMatch\b/i);
  assert.match(playerCss, /\.plb-court-pill\.is-ready\s*\{/i);
});

test("Share Live reveals each newly started matchup once, never on first load or replay", () => {
  const matchupDiff = playerClient.match(
    /function matchupRevealsForUpdate\(previousSnapshot, nextSnapshot\) \{[\s\S]*?\n  \}/i
  )?.[0] || "";
  const fetchSnapshot = playerClient.match(
    /async function fetchSnapshot\(\{ showBusy = false \} = \{\}\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function handleClick/i
  )?.[0] || "";

  assert.match(matchupDiff, /previousSnapshot[\s\S]*?nextSnapshot/i);
  assert.match(matchupDiff, /startedAt/i);
  assert.match(matchupDiff, /winner/i);
  assert.match(matchupDiff, /eventKey|matchEventKey/i);
  assert.match(playerClient, /function renderMatchupReveal\(/i);
  assert.match(playerClient, /function beginMatchupReveals\(/i);
  assert.match(fetchSnapshot, /const hadSnapshot = Boolean\(state\.snapshot\)/i);
  assert.match(
    fetchSnapshot,
    /const matchupReveals = hadSnapshot\s*\?\s*matchupRevealsForUpdate\(state\.snapshot, snapshot\)\s*:\s*\[\]/i
  );
  assert.match(fetchSnapshot, /if \(signature !== state\.signature\)/i);
  assert.match(
    fetchSnapshot,
    /state\.pendingMatchupReveals = winnerReveal \? matchupReveals : \[\]/i
  );
  assert.match(fetchSnapshot, /if \(winnerReveal\) scheduleWinnerRevealEnd\(matchupReveals\)/i);
  assert.match(
    playerClient,
    /function scheduleWinnerRevealEnd\([\s\S]*?beginMatchupReveals/i
  );
  assert.match(playerCss, /@keyframes plb-matchup/i);

  const helperStart = playerClient.indexOf("  function matchEventKey(");
  const helperEnd = playerClient.indexOf("  function winnerRevealForUpdate(", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "matchup transition helpers must be extractable");
  const detectMatchups = new Function(
    `${playerClient.slice(helperStart, helperEnd)}\nreturn matchupRevealsForUpdate;`
  )();
  const readySnapshot = {
    session: { status: "active", currentRound: 3 },
    latestRound: {
      roundNo: 3,
      assignments: [{
        courtName: "Court 1",
        team1: ["Previous One", "Previous Two"],
        team2: ["Previous Three", "Previous Four"],
        startedAt: "2026-07-25T04:00:00.000Z",
        gameCount: 1,
        winner: "A",
      }],
    },
  };
  const startedSnapshot = {
    session: { status: "active", currentRound: 3 },
    latestRound: {
      roundNo: 3,
      assignments: [{
        courtName: "Court 1",
        team1: ["A very long player name that must fit", "Player Two"],
        team2: ["Player Three", "Player Four"],
        startedAt: "2026-07-25T04:05:00.000Z",
        gameCount: 2,
        winner: null,
      }],
    },
  };
  const firstTransition = detectMatchups(readySnapshot, startedSnapshot);
  assert.equal(firstTransition.length, 1);
  assert.deepEqual(firstTransition[0].team1, startedSnapshot.latestRound.assignments[0].team1);
  assert.deepEqual(detectMatchups(startedSnapshot, startedSnapshot), [], "the same poll must not replay");

  const replacementSnapshot = structuredClone(startedSnapshot);
  replacementSnapshot.latestRound.assignments[0].startedAt = "2026-07-25T04:06:00.000Z";
  replacementSnapshot.latestRound.assignments[0].team1 = ["Replacement Player", "Player Two"];
  assert.deepEqual(
    detectMatchups(startedSnapshot, replacementSnapshot),
    [],
    "replacing a player must not look like a newly started match"
  );
});

test("winner and matchup reveals fit long names and honor reduced motion", () => {
  const playerNameRule = playerCss.match(/\.plb-player span\s*\{([^}]*)\}/i)?.[1] || "";
  assert.match(playerClient, /function nameFitClass\(name\)/i);
  assert.match(
    playerClient,
    /function playerItem\(name\)[\s\S]*?class="\$\{nameFitClass\(name\)\}" title="\$\{escapeHtml\(name\)\}"/i
  );
  assert.match(playerClient, /class="plb-winner-reveal-names"/i);
  assert.match(playerClient, /plb-matchup-reveal-team[\s\S]*?teamNames\(/i);
  assert.match(playerNameRule, /overflow-wrap:\s*anywhere/i);
  assert.doesNotMatch(playerNameRule, /white-space:\s*nowrap/i);
  assert.match(playerCss, /\.plb-winner-reveal-names > span\s*\{[\s\S]*?overflow-wrap:\s*anywhere/i);
  assert.match(playerCss, /\.plb-matchup-reveal-team[\s\S]*?overflow-wrap:\s*anywhere/i);
  assert.match(
    playerCss,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\*,[\s\S]*?animation-duration:\s*\.01ms !important/i
  );
});

test("ready-court reservations stay out of the player queue", () => {
  assert.match(
    manager,
    /function occupiedGameIds\(game\)[\s\S]*?isLiveGame\(game\)[\s\S]*?game\.teamA[\s\S]*?readyMatchIds\(game\)/i
  );
  assert.match(
    manager,
    /function roundQueue\(round = lastRound\(\)\)[\s\S]*?liveAssignments\(round\)[\s\S]*?\.flatMap\(occupiedGameIds\)/i
  );
  assert.match(
    client,
    /const liveAssigned = new Set\([\s\S]*?\.flatMap\(game => game\.winner[\s\S]*?game\.readyMatch\?\.teamA[\s\S]*?game\.readyMatch\?\.teamB[\s\S]*?game\.teamA[\s\S]*?game\.teamB/i
  );
  assert.match(
    replacementMigration,
    /jsonb_array_elements\(v_assignments\)[\s\S]*?where nullif\(game\.value ->> 'winner', ''\) is null[\s\S]*?union all[\s\S]*?where nullif\(game\.value ->> 'winner', ''\) is null/i
  );
  assert.match(
    replacementMigration,
    /p_team is null[\s\S]*?p_team not in \('A', 'B'\)/i
  );
});

test("Up Next renders one ordered dispatch slot per court and keeps READY reservations stable", () => {
  const queueOrder = manager.match(
    /function readyMatchQueueOrder\(game\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function hasReadyMatch/i
  )?.[0] || "";
  const dispatch = manager.match(
    /function nextDispatchSlots\(assignments, queue\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function dispatchPlayerMarkup/i
  )?.[0] || "";
  const renderLive = manager.match(
    /function renderLive\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function readSetup/i
  )?.[0] || "";

  assert.match(queueOrder, /readyMatch\?\.queueOrder/i);
  assert.match(queueOrder, /storedOrder\.every\(id => playerSet\.has\(id\)\)/i);
  assert.match(dispatch, /const slotCount = Math\.max\(assignments\.length, sessionCourtIds\(\)\.length\)/i);
  assert.match(dispatch, /\.filter\(item => hasReadyMatch\(item\.game\)\)/i);
  assert.match(dispatch, /readyMatch\?\.reservedAt/i);
  assert.match(dispatch, /playerIds:\s*readyMatchQueueOrder\(game\)/i);
  assert.match(dispatch, /const previewCount = Math\.max\(0, slotCount - ready\.length\)/i);
  assert.match(dispatch, /queue\.slice\(index \* 4, index \* 4 \+ 4\)/i);
  assert.match(dispatch, /return \[\.\.\.ready, \.\.\.previews\]\.map/i);
  assert.match(renderLive, /const dispatchSlots = nextDispatchSlots\(assignments, queue\)/i);
  assert.match(
    renderLive,
    /data-target="pm2Next" aria-label="Up Next, \$\{dispatchSlots\.length\}"[\s\S]*?<span>Up Next<\/span><b aria-hidden="true">\$\{dispatchSlots\.length\}<\/b>/i
  );
  assert.match(renderLive, /nextDispatchMarkup\(dispatchSlots, sessionStatus\)/i);
  assert.ok(
    renderLive.indexOf('id="pm2Courts"') < renderLive.indexOf('id="pm2Next"')
      && renderLive.indexOf('id="pm2Next"') < renderLive.indexOf('id="pm2MatchLog"'),
    "court dispatch should sit directly below the courts and above Match Log"
  );
  assert.match(manager, /class="pm2-btn pm2-btn-primary pm2-dispatch-start"[\s\S]*?data-pm-action="start-match"/i);
  assert.match(manager, />Start on \$\{escapeHtml\(slot\.courtName\)\}<\/button>/i);
  assert.match(manager, /queueOrder:\s*nextIds/i);
  assert.match(manager, /const selectedQueueOrder = poolOrder\.filter\(id => selectedSet\.has\(id\)\)/i);
  assert.match(manager, /queueOrder:\s*selectedQueueOrder/i);
  assert.doesNotMatch(manager, /class="pm2-dispatch-vs"[^>]*>VS<\/span>/i);
  assert.match(managerCss, /\.pm2-dispatch-grid\s*\{[\s\S]*?repeat\(auto-fit, minmax\(230px, 1fr\)\)/i);
  assert.match(managerCss, /\.pm2-dispatch-grid\s*\{[^}]*grid-auto-rows:\s*320px/i);
  assert.match(managerCss, /\.pm2-dispatch-card\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0/i);
  assert.match(
    managerCss,
    /\.pm2-dispatch-matchup\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*min-height:\s*142px/i
  );
  assert.match(
    managerCss,
    /\.pm2-dispatch-team-players\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(36px,\s*1fr\)\)/i
  );
  assert.match(managerCss, /\.pm2-dispatch-card\.is-ready\s*\{[\s\S]*?border-color:\s*#93ddbd/i);
});

test("recording winners fills every open court in order without duplicating players", () => {
  const recordWinner = manager.match(
    /async function recordWinner\(index, winner\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async function skipPlayer/i
  )?.[0] || "";
  const allocator = manager.match(
    /function reserveOpenCourtLineups\(assignments, queue, history, reservedAt = new Date\(\)\.toISOString\(\)\) \{[\s\S]*?\r?\n  \}(?=\r?\n\r?\n  function lineupPool)/i
  )?.[0] || "";

  assert.match(recordWinner, /const completed = \{ \.\.\.current, winner, resultAt \}/i);
  assert.match(recordWinner, /const completedAssignments = liveAssignments\(round\)\.map/i);
  assert.match(recordWinner, /reserveOpenCourtLineups\(\s*completedAssignments,\s*nextPool,\s*historyWithResult,\s*resultAt/i);
  assert.match(recordWinner, /const assignments = allocation\.assignments/i);
  assert.match(recordWinner, /const queueSnapshot = allocation\.queueSnapshot/i);
  assert.match(allocator, /\.filter\(item => item\.game\?\.winner && !hasReadyMatch\(item\.game\)\)/i);
  assert.match(allocator, /Date\.parse\(left\.game\.resultAt/i);
  assert.match(allocator, /if \(queueSnapshot\.length < 4\) return/i);
  assert.match(allocator, /const nextIds = queueSnapshot\.slice\(0, 4\)/i);
  assert.match(allocator, /bestSplit\(nextIds\.map\(id => \(\{ id \}\)\), history, false\)/i);
  assert.match(allocator, /readyMatch:\s*\{[\s\S]*?queueOrder:\s*nextIds[\s\S]*?reservedAt:\s*game\.resultAt \|\| reservedAt/i);
  assert.match(allocator, /queueSnapshot = queueSnapshot\.slice\(4\)/i);
  assert.match(allocator, /newlyReady\.push\(/i);
  assert.match(manager, /reserveOpenCourtLineups\(\s*liveAssignments\(round\),\s*queueWithWalkIn,\s*buildHistory\(\)/i);
  assert.doesNotMatch(recordWinner, /startReadyMatch|completedGames:\s*\[\.\.\.completedGames|startedAt\s*=\s*new Date/i);

  let matchSequence = 0;
  const reserveOpenCourts = new Function(
    "unique",
    "hasReadyMatch",
    "bestSplit",
    "createMatchId",
    "asId",
    `${allocator}; return reserveOpenCourtLineups;`
  )(
    values => [...new Set((values || []).map(String))],
    game => (game?.readyMatch?.teamA || []).length === 2
      && (game?.readyMatch?.teamB || []).length === 2,
    group => ({ teamA: group.slice(0, 2), teamB: group.slice(2, 4) }),
    () => `match-${++matchSequence}`,
    value => String(value ?? "")
  );
  const allocated = reserveOpenCourts(
    [
      { courtName: "Court 1", winner: "A", resultAt: "2026-07-26T10:02:00Z" },
      { courtName: "Court 2", winner: "B", resultAt: "2026-07-26T10:01:00Z" },
      { courtName: "Court 3", teamA: ["live-1", "live-2"], teamB: ["live-3", "live-4"] },
    ],
    ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
    {}
  );
  assert.deepEqual(allocated.newlyReady.map(item => item.courtName), ["Court 2", "Court 1"]);
  assert.deepEqual(allocated.assignments[1].readyMatch.queueOrder, ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(allocated.assignments[0].readyMatch.queueOrder, ["p5", "p6", "p7", "p8"]);
  assert.deepEqual(allocated.queueSnapshot, []);
  assert.equal(
    new Set(allocated.newlyReady.flatMap(item => item.playerIds)).size,
    8,
    "each player must be reserved to only one open court"
  );
});

test("READY courts expose a clean per-court start and four-player chooser", () => {
  const readyCard = manager.match(
    /function readyCourtCard\(game, index, sessionStatus\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function courtCard/i
  )?.[0] || "";
  const chooserValidation = manager.match(
    /function updateChoosePlayersDialog\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function openChoosePlayersDialog/i
  )?.[0] || "";
  const saveLineup = manager.match(
    /async function saveReadyLineup\(form\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async function startReadyMatch/i
  )?.[0] || "";

  assert.match(readyCard, /pm2-live-pill is-ready">READY/i);
  assert.match(readyCard, /data-pm-action="start-match"/i);
  assert.match(readyCard, /data-pm-action="choose-players"/i);
  assert.match(readyCard, /active && complete \? "" : "disabled"/i);
  assert.doesNotMatch(readyCard, /Team 1|Team 2|pm2-ready-matchup|pm2-ready-note/i);
  assert.match(readyCard, />Start match<\/button>/i);
  assert.match(readyCard, /complete \? "Change players" : "Choose players"/i);
  assert.match(manager, /class="pm2-dialog[^"]*" id="pm2ChooseDialog"/i);
  ["teamA0", "teamA1", "teamB0", "teamB1"].forEach(name => {
    assert.match(manager, new RegExp(`name="${name}"[^>]*data-pm-lineup-slot`, "i"));
  });
  assert.match(chooserValidation, /const duplicate = values\.length !== uniqueValues\.length/i);
  assert.match(chooserValidation, /values\.length === 4[\s\S]*?!duplicate/i);
  assert.match(chooserValidation, /option\.disabled = values\.includes/i);
  assert.match(chooserValidation, /submit\.disabled = !valid/i);
  assert.match(saveLineup, /selectedIds\.length !== 4 \|\| unique\(selectedIds\)\.length !== 4/i);
  assert.match(saveLineup, /selectedIds\.some\(id => !allowed\.has\(id\)\)/i);
  assert.match(managerCss, /\.pm2-ready-card\s*\{/i);
  assert.match(managerCss, /\.pm2-ready-card\s*\{[\s\S]*?align-self:\s*stretch/i);
  assert.match(managerCss, /\.pm2-ready-actions\s*\{/i);
  assert.doesNotMatch(managerCss, /\.pm2-ready-(?:matchup|team|name|empty|vs)\s*\{/i);
  assert.match(managerCss, /#pm2ChooseDialog\s*\{/i);
});

test("READY court card matches the compact teal and mint reference treatment", () => {
  assert.match(managerCss, /\.pm2-ready-card\s*\{[^}]*border-color:\s*#4ade80[^}]*border-radius:\s*14px/is);
  assert.match(managerCss, /\.pm2-ready-card::before\s*\{[^}]*display:\s*none/is);
  assert.match(managerCss, /\.pm2-ready-bar\s*\{[^}]*min-height:\s*66px[^}]*background:\s*#104f4b/is);
  assert.match(managerCss, /\.pm2-live-pill\.is-ready\s*\{[^}]*border-radius:\s*6px[^}]*background:\s*#baf7d4/is);
  assert.match(managerCss, /\.pm2-ready-court\s*\{[^}]*align-content:\s*center[^}]*background:\s*#f6fffa/is);
  assert.match(managerCss, /\.pm2-ready-actions\s*\{[^}]*gap:\s*8px/is);
  assert.match(managerCss, /\.pm2-ready-start,\s*\.pm2-ready-choose\s*\{[^}]*min-height:\s*56px[^}]*border-radius:\s*11px[^}]*font-size:\s*1rem/is);
  assert.match(managerCss, /\.pm2-ready-start\s*\{[^}]*background:\s*#08b86a/is);
  assert.match(managerCss, /\.pm2-ready-choose\s*\{[^}]*background:\s*#edf1f5/is);
  assert.match(
    managerCss,
    /@media \(max-width:\s*720px\)[\s\S]*?\.pm2-court-card\s*\{[^}]*min-block-size:\s*0[\s\S]*?\.pm2-court-bar\.pm2-ready-bar\s*\{[^}]*min-height:\s*66px/is
  );
  assert.match(
    managerCss,
    /@media \(pointer:\s*coarse\)[\s\S]*?\.pm2-ready-start,\s*\.pm2-ready-choose\s*\{[^}]*font-size:\s*1rem !important/is
  );
});

test("LIVE court card mirrors the READY card system with a cyan state treatment", () => {
  assert.match(
    managerCss,
    /\.pm2-court-card\.is-live\s*\{[^}]*border-color:\s*#22d3ee[^}]*border-radius:\s*14px[^}]*background:\s*#f4fcfe/is
  );
  assert.match(managerCss, /\.pm2-court-card\.is-live::before\s*\{[^}]*display:\s*none/is);
  assert.match(
    managerCss,
    /\.pm2-court-card\.is-live \.pm2-court-bar\s*\{[^}]*min-height:\s*66px[^}]*background:\s*#164e63/is
  );
  assert.match(
    managerCss,
    /\.pm2-court-card\.is-live \.pm2-live-pill\s*\{[^}]*border-radius:\s*6px[^}]*color:\s*#155e75[^}]*background:\s*#cffafe/is
  );
  assert.match(managerCss, /\.pm2-court-card\.is-live \.pm2-match\s*\{[^}]*background:\s*#f4fcfe/is);
  assert.match(managerCss, /\.pm2-court-card\.is-live \.pm2-result-actions\s*\{[^}]*background:\s*#f4fcfe/is);
  assert.match(
    managerCss,
    /\.pm2-court-card\.is-live \.pm2-result-btn\s*\{[^}]*min-height:\s*56px[^}]*border-radius:\s*11px[^}]*font-size:\s*1rem/is
  );
  assert.match(admin, /play-manager\.css\?v=20260728-compact-mobile-v24/i);
});

test("court cards share one compact height and use the modern indigo-coral team palette", () => {
  const courtsRule = managerCss.match(/\.pm2-courts\s*\{([^}]*)\}/i)?.[1] || "";
  const cardRule = managerCss.match(/\.pm2-court-card\s*\{([^}]*)\}/i)?.[1] || "";
  const readyCourtRule = managerCss.match(/\.pm2-ready-court\s*\{([^}]*)\}/i)?.[1] || "";

  assert.match(courtsRule, /grid-auto-rows:\s*1fr/i);
  assert.match(courtsRule, /align-items:\s*stretch/i);
  assert.match(cardRule, /display:\s*flex/i);
  assert.match(cardRule, /height:\s*100%/i);
  assert.match(cardRule, /min-block-size:\s*0/i);
  assert.match(cardRule, /flex-direction:\s*column/i);
  assert.match(readyCourtRule, /flex:\s*1 1 auto/i);
  assert.match(managerCss, /\.pm2-result-actions\s*\{[^}]*margin-top:\s*0/is);

  assert.match(managerCss, /--pm2-blue:\s*#4f46e5/i);
  assert.match(managerCss, /--pm2-orange:\s*#e11d48/i);
  assert.match(playerCss, /--plb-blue:\s*#4f46e5/i);
  assert.match(playerCss, /--plb-orange:\s*#e11d48/i);
  assert.doesNotMatch(managerCss, /#1976d2|#ef6c00/i);
  assert.doesNotMatch(playerCss, /#1976d2|#ef6c00/i);
});

test("court states use distinct cyan LIVE and emerald READY accents", () => {
  assert.match(
    manager,
    /const cardStateClass = winner[\s\S]*?"is-final"[\s\S]*?"is-paused"[\s\S]*?"is-live"[\s\S]*?"is-ended"/i
  );
  assert.match(manager, /pm2-court-card pm2-ready-card is-ready/i);
  assert.match(manager, /pm2-court-card \$\{cardStateClass\}/i);
  assert.match(managerCss, /\.pm2-court-card\s*\{[^}]*border-radius:\s*18px/is);
  assert.match(managerCss, /\.pm2-court-card\.is-live\s*\{[^}]*--pm2-court-accent:\s*var\(--pm2-live-accent\)/is);
  assert.match(managerCss, /\.pm2-ready-card\s*\{[^}]*--pm2-court-accent:\s*var\(--pm2-ready-accent\)/is);
  assert.match(managerCss, /\.pm2-court-card\.is-live \.pm2-live-pill::before\s*\{[^}]*animation:\s*pm2-live-status-pulse/is);
  assert.match(
    managerCss,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.pm2-court-card\.is-live \.pm2-live-pill::before\s*\{[^}]*animation:\s*none !important/is
  );

  assert.match(playerClient, /plb-court-card \$\{courtStateClass\}/i);
  assert.match(playerCss, /--plb-live-accent:\s*#22d3ee/i);
  assert.match(
    playerCss,
    /\.plb-court-card\.is-live\s*\{[^}]*--plb-court-accent:\s*var\(--plb-live-accent\)[^}]*border-color:\s*#22d3ee[^}]*background:\s*#f4fcfe/is
  );
  assert.match(playerCss, /\.plb-court-card\.is-ready\s*\{[^}]*--plb-court-accent:\s*#34d399/is);
  assert.match(playerCss, /\.plb-court-card\.is-live \.plb-court-head\s*\{[^}]*background:\s*#164e63/is);
  assert.match(playerCss, /\.plb-court-pill\.is-live\s*\{[^}]*color:\s*#155e75[^}]*background:\s*#cffafe/is);
  assert.match(playerCss, /\.plb-court-card\.is-live \.plb-match\s*\{[^}]*background:\s*#f4fcfe/is);
  assert.match(playerCss, /\.plb-status-pill\.is-active\s*\{[^}]*color:\s*#155e75[^}]*background:\s*#cffafe/is);
  assert.match(playerCss, /\.plb-status-pill\.is-active::before\s*\{[^}]*background:\s*var\(--plb-live\)/is);
  assert.match(playerCss, /\.plb-court-pill\.is-live::before\s*\{[^}]*background:\s*var\(--plb-live\)/is);
});

test("starting a READY match archives the result once and promotes only its reserved teams", () => {
  const startReadyMatch = manager.match(
    /async function startReadyMatch\(courtIndex\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async function recordWinner/i
  )?.[0] || "";

  assert.match(startReadyMatch, /!game\?\.winner \|\| !hasReadyMatch\(game\)/i);
  assert.match(
    startReadyMatch,
    /const \{\s*completedGames = \[\],\s*readyMatch,\s*\.\.\.finishedResult\s*\} = game/i
  );
  assert.match(startReadyMatch, /teamA:\s*\(readyMatch\.teamA \|\| \[\]\)\.map\(asId\)/i);
  assert.match(startReadyMatch, /teamB:\s*\(readyMatch\.teamB \|\| \[\]\)\.map\(asId\)/i);
  assert.match(startReadyMatch, /startedAt,\s*\n\s*matchId:\s*readyMatch\.matchId \|\| createMatchId\(\)/i);
  assert.match(startReadyMatch, /completedGames:\s*\[\.\.\.completedGames, finishedResult\]/i);
  assert.equal(
    (startReadyMatch.match(/completedGames:\s*\[\.\.\.completedGames, finishedResult\]/gi) || []).length,
    1,
    "the completed result should be appended exactly once"
  );
  const nextGame = startReadyMatch.match(/const nextGame = \{[\s\S]*?\n    \};/i)?.[0] || "";
  assert.doesNotMatch(nextGame, /\bwinner\b|\bresultAt\b|\breadyMatch\b\s*:/i);
});

test("ready reservations are filtered from public queue data without being exposed", () => {
  const localBoard = client.match(
    /function localOpenPlayLiveBoard\([\s\S]*?\r?\n  \}\r?\n\r?\n  window\.DB/i
  )?.[0] || "";

  assert.match(localBoard, /game\.winner[\s\S]*?game\.readyMatch\?\.teamA[\s\S]*?game\.readyMatch\?\.teamB/i);
  assert.match(
    localBoard,
    /queue_snapshot[\s\S]*?!liveAssigned\.has\(playerId\)[\s\S]*?queuedIds\.push\(playerId\)/i
  );
  assert.ok(readyCourtMigration, `${readyCourtMigrationPath} must exist`);
  assert.match(readyCourtMigration, /readyMatch/i);
  assert.match(readyCourtMigration, /latestRound[\s\S]*?queue/i);
  assert.match(readyCourtMigration, /jsonb_set/i);
  assert.doesNotMatch(
    readyCourtMigration,
    /jsonb_build_object\s*\(\s*'readyMatch'|jsonb_set\s*\([^;]*?\{[^}]*readyMatch/i
  );
});

test("local Share Live projects the reserved next lineup separately from the waiting queue", () => {
  const localBoard = client.match(
    /function localOpenPlayLiveBoard\([\s\S]*?\r?\n  \}\r?\n\r?\n  window\.DB/i
  )?.[0] || "";
  const resolveUpNext = playerClient.match(
    /function resolveUpNext\(round\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function myPosition/i
  )?.[0] || "";

  assert.match(localBoard, /const readyLineups = \(latestRound\?\.assignments \|\| \[\]\)/i);
  assert.match(localBoard, /game\.readyMatch\?\.queueOrder/i);
  assert.match(localBoard, /const publicUpNext = readyLineups\.length/i);
  assert.match(localBoard, /upNext:\s*publicUpNext/i);
  assert.match(resolveUpNext, /round\?\.upNext/i);
  assert.match(resolveUpNext, /projectedPlayers\.length === 4/i);
  assert.match(resolveUpNext, /\(round\?\.queue \|\| \[\]\)\.slice\(0, 4\)/i);
  assert.match(playerClient, /const reservedIndex = upNext\.reserved \? upNext\.players\.indexOf\(name\) : -1/i);
  assert.match(playerClient, /renderUpNext\(upNext, sessionStatus\)/i);
  assert.match(playerClient, /renderQueue\(queue, upNext\.reserved\)/i);
  assert.match(playerClient, /reservedAhead \? "ON DECK" : "UP NEXT"/i);
  assert.doesNotMatch(playerClient, /\breadyMatch\b/i);
});

test("admin live session groups courts, matchmaking, and activity in operational order", () => {
  const renderLive = manager.match(
    /function renderLive\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function readSetup/i
  )?.[0] || "";
  const matchmaking = renderLive.match(
    /<section class="pm2-dashboard-section pm2-matchmaking-section"[\s\S]*?<\/section>\s*<\/div>\s*<\/section>/i
  )?.[0] || "";
  const activity = renderLive.match(
    /<section class="pm2-dashboard-section pm2-session-activity-section"[\s\S]*?<\/section>\s*<\/div>\s*<\/section>/i
  )?.[0] || "";

  assert.match(renderLive, /id="pm2LiveCourtsTitle">Live Courts<\/h2>/i);
  assert.match(renderLive, /id="pm2MatchmakingTitle">Matchmaking<\/h2>/i);
  assert.match(renderLive, /id="pm2ActivityTitle">Session Activity<\/h2>/i);
  assert.ok(
    renderLive.indexOf('id="pm2LiveCourtsTitle"') < renderLive.indexOf('id="pm2MatchmakingTitle"')
      && renderLive.indexOf('id="pm2MatchmakingTitle"') < renderLive.indexOf('id="pm2ActivityTitle"'),
    "live courts, matchmaking, and session activity should follow the host workflow"
  );
  assert.match(matchmaking, /<h3>Player Queue<\/h3>[\s\S]*?Court dispatch[\s\S]*?<h3>Up Next<\/h3>/i);
  assert.match(activity, /id="pm2MatchLog"[\s\S]*?<h3>Match Log<\/h3>[\s\S]*?id="pm2Standings"[\s\S]*?<h3>Standings<\/h3>/i);
  assert.match(renderLive, /const standings = standingsRows\(matches\)/i);
  assert.match(manager, /queue\.length > 10[\s\S]*?tabindex="0"[\s\S]*?Player queue/i);
  assert.match(manager, /rows\.length > 4[\s\S]*?tabindex="0"[\s\S]*?Player standings/i);
  assert.match(manager, /pm2-queue-list pm2-scroll-region/i);
  assert.match(manager, /pm2-standings-list pm2-scroll-region/i);
  assert.match(manager, /function standingsRows\(matches\)[\s\S]*?winningTeam/i);
  assert.match(manager, /role="listitem"/i);
  assert.match(managerCss, /\.pm2-scroll-region\s*\{[\s\S]*?overflow-y:\s*auto/i);
  assert.match(managerCss, /\.pm2-queue-list\s*\{[\s\S]*?max-height:\s*700px/i);
  assert.match(managerCss, /\.pm2-standings-list\s*\{\s*max-height:\s*194px/i);
  assert.match(
    managerCss,
    /\.pm2-queue-row\s*\{[\s\S]*?min-height:\s*70px/i
  );
  assert.match(
    managerCss,
    /\.pm2 \.pm2-queue-row\s*\{[^}]*height:\s*70px;[^}]*min-height:\s*70px/i
  );
  assert.match(
    managerCss,
    /\.pm2 \.pm2-queue-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(44px,\s*1fr\)\)/i
  );
  assert.match(managerCss, /\.pm2 \.pm2-courts\s*\{[\s\S]*?repeat\(3,\s*minmax\(0,\s*1fr\)\)/i);
  assert.match(
    managerCss,
    /\.pm2 \.pm2-matchmaking-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(300px,\s*350px\) minmax\(0,\s*1fr\)/i
  );
  assert.match(
    managerCss,
    /@media \(min-width:\s*721px\) and \(max-width:\s*1180px\)[\s\S]*?\.pm2 \.pm2-courts\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/i
  );
  assert.match(
    managerCss,
    /@media \(min-width:\s*721px\) and \(max-width:\s*1080px\)[\s\S]*?\.pm2 \.pm2-matchmaking-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(220px,\s*\.72fr\) minmax\(0,\s*1\.28fr\)/i
  );
});

test("Play Manager stays fluid, touch-friendly, stacked, and motion-safe", () => {
  const unifiedManagerCss =
    managerCss.match(/\/\* Unified Play Manager design system \*\/([\s\S]*)$/i)?.[1] || "";

  assert.match(
    unifiedManagerCss,
    /--pm2-page-gutter:\s*clamp\(12px,\s*2vw,\s*22px\)/i
  );
  assert.match(
    unifiedManagerCss,
    /\.pm2 \.pm2-workspace\s*\{[^}]*max-width:\s*1320px;[^}]*padding:\s*var\(--pm2-page-gutter\)/i
  );
  assert.match(
    unifiedManagerCss,
    /\.pm2 \.pm2-view-head h1,\s*\.pm2 \.pm2-final-hero h1\s*\{[^}]*font-size:\s*clamp\(1\.5rem,\s*1\.25rem \+ 1vw,\s*2rem\)/i
  );
  assert.match(
    unifiedManagerCss,
    /@media \(max-width:\s*720px\)\s*\{[\s\S]*?\.pm2 \.pm2-live-rail\s*\{[^}]*grid-template-columns:\s*1fr[^}]*\}[\s\S]*?\.pm2 \.pm2-matchmaking-layout,\s*\.pm2 \.pm2-activity-layout\s*\{[^}]*grid-template-columns:\s*1fr[^}]*\}[\s\S]*?\.pm2 \.pm2-courts,\s*\.pm2 \.pm2-dispatch-grid\s*\{[^}]*grid-template-columns:\s*1fr/i
  );
  assert.match(
    unifiedManagerCss,
    /@media \(max-width:\s*720px\)\s*\{[\s\S]*?\.pm2 \.pm2-header\s*\{[^}]*position:\s*relative;[^}]*top:\s*auto;[\s\S]*?\.pm2 \.pm2-live-jump\s*\{[^}]*position:\s*fixed;[^}]*top:\s*auto;[^}]*bottom:\s*max\(8px,\s*env\(safe-area-inset-bottom\)\)/i
  );
  assert.match(
    unifiedManagerCss,
    /@media \(pointer:\s*coarse\)\s*\{[\s\S]*?\.pm2 \.pm2-player-replace\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/i
  );
  assert.match(
    unifiedManagerCss,
    /@media \(min-width:\s*721px\) and \(max-width:\s*1080px\)\s*\{[\s\S]*?\.pm2 \.pm2-matchmaking-layout \.pm2-queue-meta\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*white-space:\s*nowrap/i
  );
  assert.match(
    unifiedManagerCss,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.pm2,\s*\.pm2 \*,\s*\.pm2 \*::before,\s*\.pm2 \*::after\s*\{[^}]*scroll-behavior:\s*auto !important;[^}]*transition-duration:\s*\.01ms !important;[^}]*animation-duration:\s*\.01ms !important;[^}]*animation-delay:\s*0ms !important;[^}]*animation-iteration-count:\s*1 !important/i
  );
  assert.match(
    admin,
    /<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"\s*\/>/i
  );
});

test("queue wait timers persist, reset on court entry, and survive skips", () => {
  assert.match(queueWaitMigration, /add column if not exists queue_entered_at timestamptz/i);
  assert.match(queueWaitMigration, /create or replace function public\.sync_open_play_game_queue_wait_times/i);
  assert.match(
    queueWaitMigration,
    /player\.id = any\(v_queue_ids\)[\s\S]*?coalesce\(player\.queue_entered_at, clock_timestamp\(\)\)[\s\S]*?else null/i
  );
  assert.match(queueWaitMigration, /grant execute on function public\.sync_open_play_game_queue_wait_times/i);
  assert.equal((client.match(/async syncOpenPlayGameQueueWaitTimes\(/g) || []).length, 2);
  assert.match(client, /_sb\.rpc\('sync_open_play_game_queue_wait_times'/i);
  assert.match(
    client,
    /queue_entered_at:\s*isQueued\s*\?\s*\(player\.queue_entered_at \|\| enteredAt\)\s*:\s*null/i
  );
  assert.match(manager, /data-pm-wait-start="\$\{escapeHtml\(waitStartedAt\)\}"/i);
  assert.match(manager, /querySelectorAll\("\[data-pm-wait-start\]"\)/i);
  assert.match(manager, /await syncQueueWaitTimes\(roundQueue\(state\.rounds\[state\.rounds\.length - 1\]\)\)/i);
  assert.match(manager, /data-pm-action="skip-player"/i);
});

test("manager queue matches the compact reference while retaining Skip", () => {
  assert.match(manager, /<h3>Player Queue<\/h3>[\s\S]*?\$\{queue\.length\} waiting/i);
  assert.match(manager, /Avg\. game[\s\S]*?\$\{averageGameDuration\(\)\}/i);
  assert.match(manager, /data-pm-action="add-player"><span aria-hidden="true">[+]<\/span> Add player<\/button>/i);
  assert.match(manager, /\$\{isLast \? "Last" : "Skip"\}/i);
  assert.match(manager, /\$\{isLast \? "disabled" : ""\}/i);
  assert.match(manager, /const winRate = games \? `\$\{Math\.round\(\(wins \/ games\) \* 100\)\}%` : "—"/i);
  assert.match(manager, /\$\{games\} \$\{games === 1 \? "game" : "games"\}/i);
  assert.match(manager, /\$\{winRate\} wins/i);
  assert.match(managerCss, /--pm2-queue-green:\s*#08e58a/i);
  assert.match(managerCss, /\.pm2-queue-no\s*\{[\s\S]*?font-size:\s*1\.16rem/i);
  assert.match(managerCss, /\.pm2-queue-meta\s*\{[\s\S]*?font-variant-numeric|\.pm2-queue-wait\s*\{[\s\S]*?font-variant-numeric/i);
});

test("Play Manager stores editable six-star player skills and uses them for balanced teams", () => {
  assert.ok(playerSkillMigration, `${playerSkillMigrationPath} must exist`);
  assert.match(
    playerSkillMigration,
    /add column if not exists skill_level smallint not null default 1/i
  );
  assert.match(playerSkillMigration, /check \(skill_level between 1 and 6\)/i);
  assert.match(setupSql, /skill_level smallint not null default 1/i);
  assert.match(setupSql, /check \(skill_level between 1 and 6\)/i);

  assert.match(client, /function normalizeOpenPlaySkillLevel\(value, fallback = 1\)/i);
  assert.equal((client.match(/async updateOpenPlayGamePlayer\(id, updates\)/g) || []).length, 2);
  assert.match(client, /skill_level:\s*normalizeOpenPlaySkillLevel\(player\.skillLevel \?\? player\.skill_level\)/i);
  assert.match(client, /requireLocalPlayManagerSession\(db, current\.session_id, \['draft', 'active'\]\)/i);

  assert.match(manager, /const SKILL_LEVELS = \[/i);
  assert.match(
    manager,
    /Beginner[\s\S]*?Advanced Beginner[\s\S]*?Intermediate[\s\S]*?Advanced Intermediate[\s\S]*?Advanced[\s\S]*?Expert/i
  );
  assert.match(manager, /const DEFAULT_SKILL_LEVEL = 1/i);
  assert.match(manager, /function skillSelectorMarkup\(selectedLevel = DEFAULT_SKILL_LEVEL\)/i);
  assert.match(manager, /name="skillLevel"/i);
  assert.match(manager, />★<\/span>/i);
  assert.match(manager, /Set skill/i);
  assert.match(manager, /New players start at 1-star Beginner/i);
  assert.match(manager, /data-pm-action="edit-player-skill"/i);
  assert.match(manager, /class="pm2-player-identity"[\s\S]*?data-pm-action="edit-player-skill"[\s\S]*?data-player-id="\$\{escapeHtml\(id\)\}"/i);
  assert.match(manager, /class="pm2-player-skill-icon"[^>]*>★<\/span>/i);
  assert.match(manager, /aria-label="Open \$\{escapeHtml\(name\)\} player profile, \$\{escapeHtml\(skillSummary\)\}"/i);
  assert.match(manager, /function teamSkillTotal\(playerIds\)/i);
  assert.match(manager, /class="pm2-team-skill-total"[^>]*>★ \$\{teamASkill\}<\/span>/i);
  assert.match(manager, /class="pm2-team-skill-total"[^>]*>★ \$\{teamBSkill\}<\/span>/i);
  assert.match(manager, /function savePlayerDetails\(playerId, playerNameValue, skillLevel\)/i);
  assert.match(manager, /await DB\.updateOpenPlayGamePlayer\(player\.id,\s*\{\s*fullName:\s*cleanName,\s*skillLevel:\s*level/i);
  assert.match(manager, /await addWalkIn\(name, skillLevel\)/i);
  assert.match(manager, /const skillGap = Math\.abs\(teamASkill - teamBSkill\)/i);
  assert.match(managerCss, /\.pm2-skill-star\.is-filled\s*\{[\s\S]*?color:\s*#f5a800/i);
  assert.match(managerCss, /\.pm2-queue-skill\s*\{/i);
  assert.match(
    managerCss,
    /\.pm2-player-skill\s*\{[\s\S]*?display:\s*inline-flex[\s\S]*?width:\s*34px[\s\S]*?border-radius:\s*999px[\s\S]*?background:\s*#fff8dc/i
  );
  assert.match(managerCss, /\.pm2-player-identity:hover:not\(:disabled\)/i);
  assert.match(managerCss, /\.pm2-player-identity:focus-visible/i);
  assert.match(managerCss, /\.pm2-queue-profile-button:hover:not\(:disabled\)/i);
  assert.match(
    managerCss,
    /\.pm2-team-skill-total\s*\{[\s\S]*?border-radius:\s*999px[\s\S]*?letter-spacing:\s*0/i
  );
  assert.match(admin, /supabase-config\.js\?v=20260726-player-profile-v5/i);
  assert.match(admin, /play-manager\.js\?v=20260728-compact-mobile-v24/i);
  assert.doesNotMatch(playerClient, /skill_level|skillLevel/i);
});

test("player profile editor shows live session stats and edits both name and skill", () => {
  assert.match(manager, /id="pm2PlayerEditorSummary"[^>]*hidden/i);
  assert.match(manager, /id="pm2PlayerEditorGames">0G played/i);
  assert.match(manager, /id="pm2PlayerEditorWinRate">0% win rate/i);
  assert.match(manager, /id="pm2PlayerEditorCheckIn">Checked-in time unavailable/i);
  assert.match(manager, /function playerEditorStats\(player\)/i);
  assert.match(manager, /gamesText:\s*`\$\{games\}G played`/i);
  assert.match(manager, /winRateText:\s*`\$\{winRate\}% win rate`/i);
  assert.match(manager, /`Checked-in at \$\{checkedTime\} · \$\{duration\} in session`/i);
  assert.match(manager, /nameInput\.readOnly = false/i);
  assert.match(manager, /submit\.textContent = editing \? "Save changes"/i);
  assert.match(manager, /class="pm2-queue-player pm2-queue-profile-button"[\s\S]*?data-pm-action="edit-player-skill"/i);
  assert.match(client, /row\.full_name = String\(updates\.fullName \?\? updates\.full_name\)\.trim\(\)/i);
  assert.match(client, /full_name:\s*updates\.fullName !== undefined \|\| updates\.full_name !== undefined/i);
  assert.match(managerCss, /\.pm2-player-editor-summary\s*\{/i);
  assert.match(managerCss, /\.pm2-player-editor-note\s*\{/i);
});

test("match log includes rotated and final results once, newest first", () => {
  const completedMatches = manager.match(
    /function completedMatches\(rounds = state\.rounds\)[\s\S]*?\r?\n  }\r?\n\r?\n  function bestSplit/i
  )?.[0] || "";
  assert.match(completedMatches, /const completedGames = Array\.isArray\(game\.completedGames\)/i);
  assert.match(completedMatches, /results\.push\(\{ result: game, completedGameIndex: null \}\)/i);
  assert.match(completedMatches, /if \(!\["A", "B"\]\.includes\(result\.winner\)\) return/i);
  assert.match(completedMatches, /Date\.parse\(result\.resultAt/i);
  assert.match(completedMatches, /return b\.sortTime - a\.sortTime/i);
  assert.match(manager, /id="pm2MatchLog"/i);
  assert.match(manager, /data-target="pm2MatchLog"/i);
  assert.match(manager, /matches\.length > 4[\s\S]*?tabindex="0"[\s\S]*?Match log/i);
  assert.match(manager, /Completed matches will appear here\./i);
  assert.match(managerCss, /\.pm2-match-log-list\s*\{[\s\S]*?max-height:\s*392px/i);
  assert.match(managerCss, /\.pm2-match-log-card\s*\{[\s\S]*?height:\s*92px/i);
  assert.match(
    managerCss,
    /\.pm2-live-jump\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/i
  );
});

test("losing match-log team can atomically become the corrected winner", () => {
  assert.match(winnerCorrectionMigration, /create or replace function public\.correct_open_play_game_match_winner/i);
  assert.match(
    winnerCorrectionMigration,
    /v_round\.assignments <> coalesce\(p_expected_assignments, '\[\]'::jsonb\)[\s\S]*?PLAY_MANAGER_ROUND_CONFLICT/i
  );
  assert.match(
    winnerCorrectionMigration,
    /v_session_status in \('active', 'paused'\)[\s\S]*?has_account_role\(array\['owner', 'court_owner', 'staff'\]\)/i
  );
  assert.match(
    winnerCorrectionMigration,
    /v_session_status = 'completed'[\s\S]*?has_account_role\(array\['owner'\]\)/i
  );
  assert.match(
    winnerCorrectionMigration,
    /'previousWinner', v_current_winner[\s\S]*?'winner', p_new_winner[\s\S]*?'correctedAt'[\s\S]*?'correctedBy'/i
  );
  assert.match(
    winnerCorrectionMigration,
    /set_config\('app\.play_manager_result_correction', 'on', true\)[\s\S]*?set assignments = v_assignments/i
  );
  assert.match(
    winnerCorrectionMigration,
    /new\.queue_snapshot is distinct from old\.queue_snapshot[\s\S]*?PLAY_MANAGER_RESULT_CORRECTION_INVALID/i
  );
  assert.equal((client.match(/async correctOpenPlayGameMatchWinner\(/g) || []).length, 2);
  assert.match(client, /_sb\.rpc\('correct_open_play_game_match_winner'/i);
  assert.match(manager, /data-pm-action="correct-winner"/i);
  assert.match(manager, />Make winner<\/button>/i);
  assert.match(manager, /id="pm2WinnerDialog"/i);
  assert.match(manager, /Standings will update\. Court rotations and the player queue will stay unchanged\./i);
  assert.match(manager, /state\.rounds\[roundIndex\] = saved/i);
  assert.match(manager, /Standings updated\./i);
  assert.match(
    managerCss,
    /\.pm2 \.pm2-match-make-winner\s*\{[\s\S]*?border-radius:\s*999px[\s\S]*?color:\s*#9a3412[\s\S]*?background:\s*#ffedd5[\s\S]*?font:\s*950 \.46rem/i
  );
});

test("all Play Manager dialogs are centered in the viewport", () => {
  assert.match(
    managerCss,
    /\.pm2-dialog\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0[\s\S]*?margin:\s*auto/i
  );
  assert.match(manager, /class="pm2-dialog" id="pm2AddDialog"/i);
  assert.match(manager, /class="pm2-dialog" id="pm2ReplaceDialog"/i);
  assert.match(manager, /class="pm2-dialog pm2-winner-dialog"/i);
  assert.match(manager, /class="pm2-dialog pm2-share-dialog"/i);
});

test("Play Manager dialogs share a modern, clean visual and copy system", () => {
  assert.match(manager, /class="pm2-dialog-heading"/i);
  assert.match(manager, /class="pm2-dialog-kicker"[^>]*>Player queue</i);
  assert.match(manager, /<h3 id="pm2AddTitle">Add a player<\/h3>/i);
  assert.match(manager, /Add a walk-in to the end of the waiting list\./i);
  assert.match(manager, />Waiting player<\/span>/i);
  assert.match(manager, />After the replacement<\/span>/i);
  assert.match(manager, />Confirm replacement<\/button>/i);
  assert.match(manager, /class="pm2-dialog-kicker is-teal">Player view</i);
  assert.match(
    managerCss,
    /\.pm2-dialog\s*\{[\s\S]*?border-radius:\s*22px[\s\S]*?box-shadow:/i
  );
  assert.match(
    managerCss,
    /\.pm2-dialog-head\s*\{[\s\S]*?padding:\s*14px 16px 12px[\s\S]*?linear-gradient/i
  );
  assert.match(
    managerCss,
    /\.pm2-dialog \.pm2-input,[\s\S]*?border-radius:\s*12px[\s\S]*?background:\s*#f8fafc/i
  );
  assert.match(
    managerCss,
    /\.pm2-choice:has\(input:checked\)\s*\{[\s\S]*?background:\s*#f8fce9/i
  );
  assert.match(
    managerCss,
    /\.pm2-dialog \.pm2-btn\s*\{[\s\S]*?min-height:\s*44px[\s\S]*?border-radius:\s*12px/i
  );
});

test("Play Manager popups fit normally without hiding actions behind internal scroll", () => {
  const dialogBodyRule = managerCss.match(/\.pm2-dialog-body\s*\{([^}]*)\}/i)?.[1] || "";
  const shareBodyRule = managerCss.match(/\.pm2-share-body\s*\{([^}]*)\}/i)?.[1] || "";
  assert.match(dialogBodyRule, /gap:\s*10px/i);
  assert.match(dialogBodyRule, /padding:\s*14px 16px 16px/i);
  assert.match(dialogBodyRule, /overflow-y:\s*visible/i);
  assert.doesNotMatch(dialogBodyRule, /overflow-y:\s*auto/i);
  assert.match(shareBodyRule, /max-height:\s*none/i);
  assert.match(shareBodyRule, /overflow-y:\s*visible/i);
  assert.match(
    managerCss,
    /\.pm2-dialog \.pm2-input,[\s\S]*?\.pm2-dialog \.pm2-select\s*\{[\s\S]*?min-height:\s*44px/i
  );
  assert.match(manager, /class="pm2-replace-source-switch"/i);
  assert.match(
    managerCss,
    /\.pm2-replace-source-switch\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*?min-height:\s*44px/i
  );
  assert.match(
    managerCss,
    /\.pm2-replace-source-panel\[hidden\]\s*\{\s*display:\s*none/i
  );
  assert.match(
    managerCss,
    /\.pm2-choice-field\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/i
  );
  assert.match(manager, /class="pm2-share-layout"/i);
  assert.match(manager, /class="pm2-share-controls"/i);
  assert.match(
    managerCss,
    /\.pm2-share-layout\s*\{[\s\S]*?grid-template-columns:\s*auto minmax\(0,\s*1fr\)/i
  );
  assert.match(
    managerCss,
    /\.pm2-share-qr-shell\s*\{[\s\S]*?--pm2-qr-size:\s*clamp\(160px,\s*27dvh,\s*216px\)[\s\S]*?width:\s*calc\(var\(--pm2-qr-size\) \+ 12px\)/i
  );
  assert.match(
    managerCss,
    /@media \(max-width:\s*499px\)[\s\S]*?\.pm2-share-layout\s*\{[\s\S]*?grid-template-columns:\s*1fr/i
  );
  assert.match(
    managerCss,
    /@media \(max-height:\s*560px\)[\s\S]*?\.pm2-dialog-body,[\s\S]*?\.pm2-share-body\s*\{[\s\S]*?overflow-y:\s*auto/i
  );
  assert.doesNotMatch(managerCss, /pm2-dialog-actions[\s\S]{0,120}display:\s*none/i);
});

test("on-court player X controls remain usable in venue display mode", () => {
  assert.match(manager, /function courtPlayerRow\([\s\S]*?class="pm2-player-replace"/i);
  assert.match(manager, /data-pm-action="replace-player"/i);
  assert.match(manager, /aria-label="\$\{escapeHtml\(actionLabel\)\}"/i);
  assert.match(manager, /aria-haspopup="dialog"/i);
  assert.match(manager, /aria-controls="pm2ReplaceDialog"/i);
  assert.match(manager, /\$\{locked \? "disabled" : ""\}/i);
  assert.match(manager, /const replacementLocked = !!winner \|\| !sessionActive/i);
  assert.match(
    manager,
    /if \(action === "replace-player"\) \{\s*openReplacementDialog\(button\)/i
  );
  assert.match(manager, /name="outgoingAction" value="queue"/i);
  assert.match(manager, /name="outgoingAction" value="removed"/i);
  assert.doesNotMatch(
    managerCss,
    /\.pm2\.pm2-display\s+\.pm2-player-replace\s*\{[\s\S]*?display:\s*none/i
  );
  assert.match(managerCss, /\.pm2-player-replace:hover:not\(:disabled\)/i);
  assert.match(managerCss, /\.pm2-player-replace:disabled\s*\{[\s\S]*?cursor:\s*not-allowed/i);
});

test("replacement dialog recommends the next queued player without auto-submitting", () => {
  assert.match(manager, /name="replacementSource"[\s\S]*?value="queue"[\s\S]*?aria-controls="pm2ReplacementQueuePanel"/i);
  assert.match(manager, /name="replacementSource"[\s\S]*?value="walkin"[\s\S]*?aria-controls="pm2ReplacementWalkInPanel"/i);
  assert.match(manager, /id="pm2ReplacementQueuePanel"[\s\S]*?data-pm-replacement-panel="queue"/i);
  assert.match(manager, /id="pm2ReplacementWalkInPanel"[\s\S]*?data-pm-replacement-panel="walkin"[\s\S]*?hidden/i);
  assert.match(manager, /id="pm2ReplacementNextBadge" hidden>Next in queue<\/span>/i);
  assert.match(manager, /id="pm2ReplacementMeta">Choose a waiting player\.<\/small>/i);
  assert.match(manager, /id="pm2ReplacementPlanTitle">Choose a replacement player<\/strong>/i);
  assert.match(
    manager,
    /id="pm2ReplacementSubmit"[\s\S]*?aria-describedby="pm2ReplacementPlanTitle pm2ReplacementPlanDetail"[\s\S]*?disabled/i
  );
  assert.match(
    manager,
    /const queue = roundQueue\(round\)[\s\S]*?queue\.map\(\(id, index\)[\s\S]*?Next in queue[\s\S]*?select\.value = queue\.length \? asId\(queue\[0\]\) : ""/i
  );
  assert.match(
    manager,
    /queueSource\.disabled = !queue\.length;\s*queueSource\.checked = !!queue\.length;[\s\S]*?walkInSource\.checked = !queue\.length/i
  );
  assert.match(
    manager,
    /function syncReplacementSource\(dialog\)[\s\S]*?panel\.hidden = panel\.dataset\.pmReplacementPanel !== source[\s\S]*?select\.disabled = source !== "queue" \|\| !!queueSource\?\.disabled[\s\S]*?nameInput\.disabled = source !== "walkin"/i
  );
  assert.match(
    manager,
    /function updateReplacementPreview\(\)[\s\S]*?const source = syncReplacementSource\(dialog\)[\s\S]*?const typedName = source === "walkin"[\s\S]*?const selectedId = source === "queue"[\s\S]*?badge\.hidden = source !== "queue" \|\| queueIndex !== 0[\s\S]*?submit\.disabled = !incomingName/i
  );
  assert.match(
    manager,
    /Queue position #\$\{queueIndex \+ 1\} · Waiting <span data-pm-wait-start=/i
  );
  assert.match(
    manager,
    /event\.target\.matches\('input\[name="replacementSource"\]'\)[\s\S]*?syncReplacementSource\([\s\S]*?updateReplacementPreview\(\)/i
  );
  assert.match(
    manager,
    /event\.target\.matches\('input\[name="outgoingAction"\]'\)[\s\S]*?updateReplacementPreview\(\)/i
  );
  const replacementInputHandler = manager.match(/function handleInput\(event\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(
    replacementInputHandler,
    /event\.target\.id === "pm2ReplacementName"[\s\S]*?updateReplacementPreview\(\)/i
  );
  assert.doesNotMatch(replacementInputHandler, /select\.value\s*=|queue\[0\]|requestSubmit|\.submit\(\)/i);
  assert.match(
    manager,
    /const replacementSource = data\.get\("replacementSource"\) === "walkin" \? "walkin" : "queue"[\s\S]*?const newName = replacementSource === "walkin"[\s\S]*?const incomingId = replacementSource === "queue"/i
  );
  assert.match(manager, /setTimeout\(\(\) => \(queue\.length \? select : nameInput\)\?\.focus\(\), 0\)/i);
  assert.match(
    managerCss,
    /\.pm2-replace-next-badge\s*\{[\s\S]*?border-radius:\s*999px[\s\S]*?background:\s*#f3fbd7/i
  );
  assert.match(
    managerCss,
    /\.pm2-replace-plan\s*\{[\s\S]*?border-radius:\s*12px[\s\S]*?linear-gradient/i
  );
  assert.match(
    managerCss,
    /\.pm2-replace-actions\s*\{[\s\S]*?border-top:\s*1px solid #e8edf3/i
  );
  assert.match(
    manager,
    /replacementDialog\?\.addEventListener\("close"[\s\S]*?state\.replacement = null;[\s\S]*?state\.replacementTrigger = null;[\s\S]*?trigger\?\.isConnected/i
  );
  assert.match(
    manager,
    /state\.replacement = null;\s*state\.replacementTrigger = null;\s*renderShell\(\);\s*let queueSyncNote = "";[\s\S]*?try \{[\s\S]*?syncQueueWaitTimes\(roundQueue\(savedRound\)\)[\s\S]*?catch \(error\)[\s\S]*?Queue wait times will refresh automatically\./i
  );
  assert.match(
    managerCss,
    /\.pm2-replace-summary small\s*\{[\s\S]*?max-width:\s*58%[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis/i
  );
  assert.match(
    managerCss,
    /@media \(pointer:\s*coarse\)[\s\S]*?\.pm2-dialog \.pm2-input,[\s\S]*?\.pm2-dialog \.pm2-select\s*\{[\s\S]*?min-height:\s*44px[\s\S]*?\.pm2-dialog \.pm2-dialog-close\s*\{[\s\S]*?min-height:\s*44px/i
  );
});

test("admin refresh and browser history restore the current permitted section", () => {
  assert.match(admin, /function sectionFromLocation\(\)/i);
  assert.match(admin, /decodeURIComponent\(raw\)\.trim\(\)\.toLowerCase\(\)/i);
  assert.match(admin, /function canAccessSection\(s,role=sess\?\.role\)/i);
  assert.match(admin, /function firstAllowedSection\(role=sess\?\.role\)/i);
  assert.match(admin, /function updateSectionRoute\(s,mode='push'\)/i);
  assert.match(admin, /history\.pushState\(nextState,'',nextHash\)/i);
  assert.match(admin, /history\.replaceState\(nextState,'',nextHash\)/i);
  assert.match(admin, /window\.addEventListener\('popstate',handleAdminRouteChange\)/i);
  assert.match(admin, /window\.addEventListener\('hashchange',handleAdminRouteChange\)/i);
  assert.match(
    admin,
    /const initialSection = requestedSection && canAccessSection\(requestedSection, role\)[\s\S]*?await goto\(initialSection,\{historyMode:'replace',announceDenied:false\}\)/i
  );
  assert.match(
    admin,
    /const returnTo = `admin\.html\$\{requestedSection \? `#\$\{encodeURIComponent\(requestedSection\)\}` : ''\}`/i
  );
  assert.match(manager, /await window\.goto\("gamemgr"\)/i);
});

test("admin inline scripts remain syntactically valid", () => {
  const inlineScripts = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(inlineScripts.length, 2);
  inlineScripts.forEach(source => {
    assert.doesNotThrow(() => new Function(source));
  });
});

test("admin hides the default dashboard until the restored section is ready", () => {
  assert.match(admin, /<body class="admin-booting" data-theme="dark">/i);
  assert.match(admin, /id="adminBootSplash" role="status" aria-live="polite"/i);
  assert.match(
    admin,
    /<img class="admin-boot-logo" src="paddleragelogo-transparent\.png" alt="Paddle Rage Pickleball">/i
  );
  assert.doesNotMatch(admin, /class="admin-boot-mark"[^>]*>PR</i);
  assert.match(admin, /<div id="adminShell" inert aria-hidden="true">/i);
  assert.match(admin, /body\.admin-booting \.admin-boot-splash\s*\{[\s\S]*?visibility:\s*visible/i);
  assert.match(admin, /prefers-reduced-motion: reduce[\s\S]*?animation:\s*none/i);
  assert.match(
    admin,
    /function finishAdminBoot\(\)[\s\S]*?shell\.removeAttribute\('inert'\)[\s\S]*?classList\.remove\('admin-booting'\)/i
  );
  assert.match(
    admin,
    /await goto\(initialSection,\{historyMode:'replace',announceDenied:false\}\)[\s\S]*?startAdminRealtime\(\);\s*finishAdminBoot\(\)/i
  );
  assert.match(admin, /catch \(error\) \{[\s\S]*?showAdminBootError\(/i);
});

test("all same-context Play Manager rerenders preserve main and panel scroll", () => {
  assert.match(manager, /displayModeRevision:\s*0/i);
  assert.match(
    manager,
    /function scrollContextKey\(\)[\s\S]*?asId\(state\.session\?\.id\)[\s\S]*?state\.view[\s\S]*?state\.displayMode[\s\S]*?state\.displayModeRevision/i
  );
  assert.match(
    manager,
    /function captureRenderScroll\(element\)[\s\S]*?\.pm2\[data-pm-scroll-context\][\s\S]*?shell\.classList\.contains\("pm2-display"\) \? shell : pageScroller\(\)[\s\S]*?\[data-pm-scroll-key\][\s\S]*?mainTop/i
  );
  assert.match(
    manager,
    /function restoreScrollTop\(scroller, value\)[\s\S]*?Math\.max\(0, scroller\.scrollHeight - scroller\.clientHeight\)[\s\S]*?Math\.min\(Math\.max\(0, requested\), maxTop\)/i
  );
  assert.match(
    manager,
    /function restoreRenderScroll\(element, context, snapshot\)[\s\S]*?snapshot\.context !== context[\s\S]*?restoreScrollTop\(mainScroller, snapshot\.mainTop\)[\s\S]*?restoreScrollTop\(scroller, snapshot\.panels\[key\]\)/i
  );
  assert.match(
    manager,
    /function renderShell\(inheritedScrollSnapshot\)[\s\S]*?captureRenderScroll\(element\)[\s\S]*?const scrollContext = scrollContextKey\(\)[\s\S]*?data-pm-scroll-context="\$\{escapeHtml\(scrollContext\)\}"[\s\S]*?updateTimers\(\);\s*restoreRenderScroll\(element, scrollContext, scrollSnapshot\)/i
  );
  assert.match(
    manager,
    /const scrollSnapshot = captureRenderScroll\(element\);\s*element\.innerHTML = loadingMarkup\(\);[\s\S]*?renderShell\(scrollSnapshot\)/i
  );
  ["queue", "standings", "match-log"].forEach(key => {
    assert.match(manager, new RegExp(`data-pm-scroll-key="${key}"`, "i"));
  });
  assert.doesNotMatch(manager, /captureDisplayScroll|restoreDisplayScroll/i);
  assert.match(
    manager,
    /if \(action === "winner"\) \{\s*await withBusy\(\(\) => recordWinner\(/i
  );
  assert.match(
    manager,
    /if \(action === "display"\) \{\s*state\.displayModeRevision \+= 1;\s*state\.displayMode = !state\.displayMode/i
  );
  assert.match(managerCss, /\.pm2\.pm2-display\s*\{[\s\S]*?overflow:\s*auto/i);
});

test("Play Manager uses the system logo without a badge background", () => {
  assert.match(
    manager,
    /<img class="pm2-brand-mark" src="paddleragelogo-transparent\.png" alt="">/i
  );
  assert.doesNotMatch(manager, /<div class="pm2-brand-mark"[^>]*>PR<\/div>/i);
  assert.match(
    managerCss,
    /\.pm2-brand-mark\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/i
  );
});
