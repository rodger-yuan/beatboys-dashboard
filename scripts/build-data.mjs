#!/usr/bin/env node
/**
 * Builds the static data bundle for the Beat Boys Dynasty dashboard.
 *
 * Pulls every season in the league's history from the Sleeper API and writes
 * data/*.json. Run locally with `npm run build:data`, or on a schedule via
 * .github/workflows/build-data.yml.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data");
const API = "https://api.sleeper.app/v1";

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID || "1312156446493794305";
const MAX_WEEK = 18;

/** Positions dropped from the league in 2026; excluded from every record board. */
const RETIRED_POSITIONS = new Set(["K", "DEF"]);
/** Positions that get their own waiver-pickup leaderboard. */
const PICKUP_POSITIONS = ["QB", "RB", "WR", "TE"];

// --------------------------------------------------------------------------
// fetch helpers
// --------------------------------------------------------------------------

async function api(path, { allowNull = false } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${API}/${path}`);
      if (res.status === 404 && allowNull) return null;
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) {
        if (allowNull) {
          console.warn(`  ! giving up on ${path}: ${err.message}`);
          return null;
        }
        throw new Error(`GET ${path} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

/** Resolve the full league chain, oldest season first. */
async function leagueChain(startId) {
  const chain = [];
  let id = startId;
  while (id) {
    const league = await api(`league/${id}`);
    if (!league) break;
    chain.push(league);
    id = league.previous_league_id;
  }
  return chain.reverse();
}

// --------------------------------------------------------------------------
// lineup math
// --------------------------------------------------------------------------

const FLEX_ELIGIBLE = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

/**
 * Highest-scoring legal lineup from an entire roster.
 *
 * The slot eligibility sets form a laminar family (QB ⊂ SUPER_FLEX,
 * RB/WR/TE ⊂ FLEX ⊂ SUPER_FLEX, and the strict slots are pairwise disjoint),
 * so filling slots from most restrictive to least restrictive — each taking the
 * best player still available — is provably optimal.
 */
function optimalLineup(slots, candidates) {
  const ordered = [...slots]
    .map((slot, i) => ({ slot, i, size: (FLEX_ELIGIBLE[slot] || []).length }))
    .sort((a, b) => a.size - b.size || a.i - b.i);

  const pool = [...candidates].sort((a, b) => b.points - a.points);
  const used = new Set();
  const lineup = [];

  for (const { slot, i } of ordered) {
    const eligible = FLEX_ELIGIBLE[slot];
    if (!eligible) continue;
    const pick = pool.find((p) => !used.has(p.id) && eligible.includes(p.position));
    if (pick) used.add(pick.id);
    lineup[i] = { slot, ...(pick || { id: null, name: null, position: null, points: 0 }) };
  }

  const filled = lineup.filter(Boolean);
  return { lineup: filled, total: round2(filled.reduce((s, p) => s + p.points, 0)) };
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// --------------------------------------------------------------------------
// build
// --------------------------------------------------------------------------

async function main() {
  console.log(`Building from league ${LEAGUE_ID}`);

  const [chain, playersRaw] = await Promise.all([
    leagueChain(LEAGUE_ID),
    api("players/nfl"),
  ]);
  if (!chain.length) throw new Error("No leagues resolved — check SLEEPER_LEAGUE_ID");
  console.log(`Seasons: ${chain.map((l) => l.season).join(", ")}`);

  // Slim player map: [name, position, nflTeam]. Keeps the browser payload small
  // enough to ship while still covering every player who could be picked up.
  const players = {};
  for (const [id, p] of Object.entries(playersRaw)) {
    const pos = p.position;
    if (!pos || !["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)) continue;
    players[id] = [p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id, pos, p.team || null];
  }
  const nameOf = (id) => players[id]?.[0] || id;
  const posOf = (id) => players[id]?.[1] || null;

  const members = new Map(); // user_id -> member record
  const seasons = [];

  for (const league of chain) {
    const season = league.season;
    console.log(`\n${season} (${league.league_id})`);

    const [users, rosters, bracket] = await Promise.all([
      api(`league/${league.league_id}/users`),
      api(`league/${league.league_id}/rosters`),
      api(`league/${league.league_id}/winners_bracket`, { allowNull: true }),
    ]);

    for (const u of users) {
      const existing = members.get(u.user_id);
      const record = {
        userId: u.user_id,
        name: u.display_name,
        teamName: u.metadata?.team_name || existing?.teamName || null,
        avatar: u.avatar || existing?.avatar || null,
      };
      members.set(u.user_id, record); // latest season wins for display name
    }

    const ownerOf = new Map(rosters.map((r) => [r.roster_id, r.owner_id]));
    const playoffStart = league.settings?.playoff_week_start || 15;
    const lastScored = league.status === "complete" ? MAX_WEEK : league.settings?.last_scored_leg || 0;

    // ---- matchups -------------------------------------------------------
    const weeks = [];
    for (let w = 1; w <= MAX_WEEK; w++) {
      if (w > lastScored) break;
      const m = await api(`league/${league.league_id}/matchups/${w}`, { allowNull: true });
      if (!m || !m.length) break;
      const scored = m.some((x) => x.points > 0);
      if (!scored) break;
      weeks.push({ week: w, entries: m });
      process.stdout.write(`  wk${w}`);
    }
    console.log("");

    const regularWeeks = weeks.filter((w) => w.week < playoffStart);

    // ---- transactions ---------------------------------------------------
    const adds = [];
    for (let w = 1; w <= MAX_WEEK; w++) {
      const txns = await api(`league/${league.league_id}/transactions/${w}`, { allowNull: true });
      if (!txns) continue;
      for (const t of txns) {
        if (t.status !== "complete") continue;
        if (t.type !== "waiver" && t.type !== "free_agent") continue;
        for (const [playerId, rosterId] of Object.entries(t.adds || {})) {
          adds.push({
            playerId,
            rosterId,
            week: t.leg || w,
            type: t.type,
            bid: t.settings?.waiver_bid ?? null,
            created: t.created,
          });
        }
      }
    }
    console.log(`  ${adds.length} waiver/FA adds`);

    seasons.push({
      season,
      leagueId: league.league_id,
      name: league.name,
      status: league.status,
      rosterPositions: league.roster_positions.filter((p) => p !== "BN"),
      playoffStart,
      ownerOf,
      rosters,
      weeks,
      regularWeeks,
      bracket,
      adds,
      hadKickersAndDefense: league.roster_positions.some((p) => RETIRED_POSITIONS.has(p)),
    });
  }

  const current = seasons[seasons.length - 1];

  // ======================================================================
  // Tank-a-thon: lowest cumulative best-possible-lineup score, current season
  // ======================================================================
  const tankSlots = current.rosterPositions;
  const tankTeams = current.rosters.map((r) => {
    const byWeek = [];
    for (const { week, entries } of current.weeks) {
      if (week >= current.playoffStart) continue;
      const entry = entries.find((e) => e.roster_id === r.roster_id);
      if (!entry) continue;
      const candidates = Object.entries(entry.players_points || {})
        .filter(([id]) => posOf(id))
        .map(([id, points]) => ({ id, name: nameOf(id), position: posOf(id), points: round2(points) }));
      const { lineup, total } = optimalLineup(tankSlots, candidates);
      byWeek.push({
        week,
        best: total,
        actual: round2(entry.points || 0),
        efficiency: total > 0 ? round2((100 * (entry.points || 0)) / total) : 0,
        lineup,
      });
    }
    const totalBest = round2(byWeek.reduce((s, w) => s + w.best, 0));
    const totalActual = round2(byWeek.reduce((s, w) => s + w.actual, 0));
    return {
      rosterId: r.roster_id,
      userId: current.ownerOf.get(r.roster_id),
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      totalBest,
      totalActual,
      efficiency: totalBest > 0 ? round2((100 * totalActual) / totalBest) : 0,
      weeks: byWeek,
    };
  });

  // Lowest best-possible total drafts first.
  tankTeams.sort((a, b) => a.totalBest - b.totalBest);
  tankTeams.forEach((t, i) => (t.pick = i + 1));

  const tankathon = {
    season: current.season,
    slots: tankSlots,
    weeksCounted: current.weeks.filter((w) => w.week < current.playoffStart).map((w) => w.week),
    playoffStart: current.playoffStart,
    teams: tankTeams,
  };

  // ======================================================================
  // Championships
  // ======================================================================
  const titles = new Map();
  const championships = [];
  for (const s of seasons) {
    if (s.status !== "complete" || !s.bracket) continue;
    const final = s.bracket.find((m) => m.p === 1);
    const winnerRoster = final?.w ?? Number(s.rosters.find((r) => r.roster_id === 1) && null);
    if (!winnerRoster) continue;
    const runnerUp = final.t1 === winnerRoster ? final.t2 : final.t1;
    const champUser = s.ownerOf.get(winnerRoster);
    championships.push({
      season: s.season,
      champion: champUser,
      runnerUp: s.ownerOf.get(runnerUp) || null,
      record: (() => {
        const r = s.rosters.find((x) => x.roster_id === winnerRoster);
        return r ? `${r.settings.wins}-${r.settings.losses}${r.settings.ties ? `-${r.settings.ties}` : ""}` : null;
      })(),
    });
    titles.set(champUser, (titles.get(champUser) || 0) + 1);
  }

  const championshipBoard = [...members.values()]
    .map((m) => ({
      userId: m.userId,
      titles: titles.get(m.userId) || 0,
      seasons: championships.filter((c) => c.champion === m.userId).map((c) => c.season),
      runnerUps: championships.filter((c) => c.runnerUp === m.userId).map((c) => c.season),
    }))
    .sort((a, b) => b.titles - a.titles || b.runnerUps.length - a.runnerUps.length);

  // ======================================================================
  // Weekly score records (regular season, kickers + defenses excluded)
  // ======================================================================
  const weeklyScores = [];
  for (const s of seasons) {
    for (const { week, entries } of s.regularWeeks) {
      for (const e of entries) {
        const starters = (e.starters || []).filter((id) => id && id !== "0");
        if (!starters.length) continue;

        const detail = starters.map((id, i) => ({
          id,
          name: nameOf(id),
          position: posOf(id),
          points: round2((e.starters_points || [])[i] ?? e.players_points?.[id] ?? 0),
        }));
        const counted = detail.filter((p) => !RETIRED_POSITIONS.has(p.position));
        const excluded = detail.filter((p) => RETIRED_POSITIONS.has(p.position));

        weeklyScores.push({
          season: s.season,
          week,
          userId: s.ownerOf.get(e.roster_id),
          rosterId: e.roster_id,
          points: round2(counted.reduce((sum, p) => sum + p.points, 0)),
          officialPoints: round2(e.points || 0),
          excludedPoints: round2(excluded.reduce((sum, p) => sum + p.points, 0)),
          starters: counted,
          excludedStarters: excluded,
        });
      }
    }
  }

  const byPoints = [...weeklyScores].sort((a, b) => b.points - a.points);
  const topScores = byPoints.slice(0, 10);
  const lowScores = [...byPoints].reverse().slice(0, 10);

  // ======================================================================
  // Best waiver-wire pickups
  // ======================================================================
  // Roster membership is read back from the weekly matchup snapshots rather
  // than replayed from the transaction log — the snapshots are what Sleeper
  // actually scored, so they can't drift out of sync with reality.
  const pickups = [];
  for (const s of seasons) {
    const rosterWeeks = new Map(); // `${rosterId}|${week}` -> matchup entry
    for (const { week, entries } of s.weeks) {
      for (const e of entries) rosterWeeks.set(`${e.roster_id}|${week}`, e);
    }
    const lastWeek = s.weeks.length ? s.weeks[s.weeks.length - 1].week : 0;

    // Sort adds chronologically so repeat pickups of the same player resolve
    // into separate, non-overlapping stints.
    const sorted = [...s.adds].sort((a, b) => a.created - b.created);
    const consumed = new Set(); // `${rosterId}|${playerId}|${week}`

    for (const add of sorted) {
      const position = posOf(add.playerId);
      if (!position || !PICKUP_POSITIONS.includes(position)) continue;

      const weeksOwned = [];
      let points = 0;
      for (let w = add.week; w <= lastWeek; w++) {
        const key = `${add.rosterId}|${add.playerId}|${w}`;
        const entry = rosterWeeks.get(`${add.rosterId}|${w}`);
        if (!entry || !(entry.players || []).includes(add.playerId)) break;
        if (consumed.has(key)) break; // already credited to an earlier stint
        consumed.add(key);
        const pts = round2(entry.players_points?.[add.playerId] ?? 0);
        const started = (entry.starters || []).includes(add.playerId);
        weeksOwned.push({ week: w, points: pts, started });
        points += pts;
      }
      if (!weeksOwned.length) continue;

      pickups.push({
        season: s.season,
        playerId: add.playerId,
        name: nameOf(add.playerId),
        position,
        nflTeam: players[add.playerId]?.[2] || null,
        userId: s.ownerOf.get(add.rosterId),
        addedWeek: add.week,
        type: add.type,
        bid: add.type === "waiver" ? add.bid : null,
        points: round2(points),
        weeksOwned: weeksOwned.length,
        startedWeeks: weeksOwned.filter((w) => w.started).length,
        pointsStarted: round2(weeksOwned.filter((w) => w.started).reduce((s2, w) => s2 + w.points, 0)),
        log: weeksOwned,
      });
    }
  }

  const pickupsByPosition = {};
  for (const pos of PICKUP_POSITIONS) {
    pickupsByPosition[pos] = pickups
      .filter((p) => p.position === pos)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
  }

  // ======================================================================
  // write
  // ======================================================================
  await mkdir(OUT, { recursive: true });

  const league = {
    leagueId: LEAGUE_ID,
    name: current.name,
    currentSeason: current.season,
    seasons: seasons.map((s) => ({
      season: s.season,
      leagueId: s.leagueId,
      status: s.status,
      playoffStart: s.playoffStart,
      weeksScored: s.weeks.length ? s.weeks[s.weeks.length - 1].week : 0,
      hadKickersAndDefense: s.hadKickersAndDefense,
      rosterPositions: s.rosterPositions,
    })),
    members: [...members.values()],
    rosterOwners: Object.fromEntries(current.ownerOf),
    updatedAt: new Date().toISOString(),
  };

  const records = {
    championships: championshipBoard,
    championshipsBySeason: championships,
    topScores,
    lowScores,
    pickupsByPosition,
    notes: {
      scores:
        "Regular-season weeks only. Kicker and defense points are removed from every total because those roster spots were cut for 2026.",
      pickups:
        "Waiver claims and in-season free-agent adds. Value is every point the player scored while on that roster, starter or bench.",
    },
    updatedAt: league.updatedAt,
  };

  await Promise.all([
    writeJson("league.json", league),
    writeJson("tankathon.json", tankathon),
    writeJson("records.json", records),
    writeJson("players.json", players),
  ]);

  console.log(`\nWrote ${Object.keys(players).length} players, ${weeklyScores.length} weekly scores, ${pickups.length} pickups.`);
}

async function writeJson(name, value) {
  const path = resolve(OUT, name);
  await writeFile(path, JSON.stringify(value));
  console.log(`  ${name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
