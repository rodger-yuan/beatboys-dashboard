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

/**
 * KeepTradeCut dynasty rankings. The league is superflex with a 0.5 TE
 * reception bonus, so `superflexValues.tepp` (superflex, TE Premium+) is the
 * matching valuation. KTC embeds the whole board as JSON in the page; it caps
 * at 500 players, and anyone below that cutoff is worth under ~460 points —
 * i.e. dynasty-irrelevant — so a miss is treated as unranked, not as an error.
 */
const KTC_URL = "https://keeptradecut.com/dynasty-rankings";

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
// KeepTradeCut
// --------------------------------------------------------------------------

/** Name key that survives punctuation, accents and generational suffixes. */
function nameKey(name) {
  let n = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  n = n.replace(/ (jr|sr|ii|iii|iv|v)$/, "");
  return n.replace(/ /g, "");
}

/**
 * Superflex / TEP+ dynasty values, keyed by name + position.
 * Returns an empty map rather than throwing: a KTC outage should degrade the
 * pickup board to points-ranked, not fail the whole build.
 */
async function fetchKTC() {
  try {
    const res = await fetch(KTC_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; beatboys-dashboard/1.0)" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const html = await res.text();
    const match = html.match(/<script[^>]*id=["']ktc-players["'][^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error("ktc-players payload not found");

    const map = new Map();
    for (const p of JSON.parse(match[1])) {
      if (!PICKUP_POSITIONS.includes(p.position)) continue;
      const v = p.superflexValues?.tepp;
      if (!v) continue;
      const key = `${nameKey(p.playerName)}|${p.position}`;
      // The board is value-sorted, so the first hit on a duplicate name wins.
      if (!map.has(key)) {
        map.set(key, {
          value: v.value,
          rank: v.rank,
          positionalRank: v.positionalRank,
          trend: p.superflexValues.overall7DayTrend ?? null,
          age: p.age ?? null,
        });
      }
    }
    console.log(`  KTC: ${map.size} valuations (superflex, TEP+)`);
    return map;
  } catch (err) {
    console.warn(`  ! KTC unavailable (${err.message}) — pickups will rank on points`);
    return new Map();
  }
}

// --------------------------------------------------------------------------
// build
// --------------------------------------------------------------------------

async function main() {
  console.log(`Building from league ${LEAGUE_ID}`);

  const [chain, playersRaw, ktc] = await Promise.all([
    leagueChain(LEAGUE_ID),
    api("players/nfl"),
    fetchKTC(),
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
        // Trades are collected too — not as pickups, but so a player who was
        // waivered once and later traded back isn't credited to the old claim.
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
    console.log(`  ${adds.length} acquisitions`);

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
  // Tenure is read back from the weekly matchup snapshots rather than replayed
  // from the transaction log: the snapshots are what Sleeper actually scored,
  // so they can't drift out of sync with reality. A claim can process after a
  // week's snapshot is taken (Malik Willis, claimed in 2025 week 16, first
  // appears in week 17), so a run is anchored to the snapshots and then matched
  // back to whichever acquisition brought the player in — never the reverse.
  //
  // Runs span seasons. This is a dynasty league, so a waiver claim that keeps
  // paying out next year is exactly the thing worth measuring.

  // Every scored week across every season, oldest first.
  const timeline = [];
  seasons.forEach((s, seasonIndex) => {
    for (const { week, entries } of s.weeks) {
      const byUser = new Map();
      for (const e of entries) {
        const userId = s.ownerOf.get(e.roster_id);
        if (userId) byUser.set(userId, e);
      }
      timeline.push({ seasonIndex, season: s.season, week, byUser });
    }
  });

  // Every acquisition of any type, keyed to the manager rather than the roster
  // slot, so tenure survives roster_id changes between seasons.
  const acquisitions = [];
  seasons.forEach((s, seasonIndex) => {
    for (const a of s.adds) {
      const userId = s.ownerOf.get(a.rosterId);
      if (userId) acquisitions.push({ ...a, seasonIndex, season: s.season, userId });
    }
  });

  // manager+player -> the timeline indices they were rostered for.
  const presence = new Map();
  timeline.forEach((slot, idx) => {
    for (const [userId, e] of slot.byUser) {
      for (const playerId of e.players || []) {
        const key = `${userId}|${playerId}`;
        let arr = presence.get(key);
        if (!arr) presence.set(key, (arr = []));
        arr.push(idx);
      }
    }
  });

  /** Most recent acquisition by this manager at or before a run's first week. */
  function acquisitionFor(userId, playerId, slot) {
    let best = null;
    for (const a of acquisitions) {
      if (a.userId !== userId || a.playerId !== playerId) continue;
      if (a.seasonIndex > slot.seasonIndex) continue;
      if (a.seasonIndex === slot.seasonIndex && a.week > slot.week) continue;
      if (!best || a.created > best.created) best = a;
    }
    return best;
  }

  // The board answers "which players on my roster right now did I get off the
  // waiver wire, and what are they worth?" — so it is driven by the live
  // rosters rather than by every historical stint. That also means a player
  // can only appear once (one manager rosters them), and someone who dropped
  // a player doesn't get credit for value that accrued to whoever holds him.
  const currentRoster = new Map(); // userId -> Set(playerId)
  for (const r of current.rosters) {
    const userId = current.ownerOf.get(r.roster_id);
    if (userId) currentRoster.set(userId, new Set(r.players || []));
  }

  /** The unbroken stretch of weeks ending at the present, if there is one. */
  function currentRun(userId, playerId) {
    const indices = presence.get(`${userId}|${playerId}`);
    if (!indices?.length) return [];
    const lastIdx = timeline.length - 1;
    if (indices[indices.length - 1] !== lastIdx) return [];
    const run = [];
    for (let i = indices.length - 1, expect = lastIdx; i >= 0 && indices[i] === expect; i--, expect--) {
      run.unshift(indices[i]);
    }
    return run;
  }

  const currentPickups = [];
  for (const [userId, roster] of currentRoster) {
    for (const playerId of roster) {
      const position = posOf(playerId);
      if (!position || !PICKUP_POSITIONS.includes(position)) continue;

      // How this manager most recently came to own the player. Drafted players
      // have no acquisition; a trade isn't a waiver pickup.
      let acq = null;
      for (const a of acquisitions) {
        if (a.userId !== userId || a.playerId !== playerId) continue;
        if (!acq || a.created > acq.created) acq = a;
      }
      if (!acq || (acq.type !== "waiver" && acq.type !== "free_agent")) continue;

      const run = currentRun(userId, playerId);
      const log = run.map((idx) => {
        const slot = timeline[idx];
        const e = slot.byUser.get(userId);
        return {
          season: slot.season,
          week: slot.week,
          points: round2(e.players_points?.[playerId] ?? 0),
          started: (e.starters || []).includes(playerId),
        };
      });

      currentPickups.push({
        season: acq.season,
        playerId,
        name: nameOf(playerId),
        position,
        nflTeam: players[playerId]?.[2] || null,
        userId,
        addedWeek: acq.week,
        spansSeasons: log.length > 0 && log[log.length - 1].season !== acq.season,
        type: acq.type,
        bid: acq.type === "waiver" ? acq.bid : null,
        ...valueOf(playerId, position),
        points: round2(log.reduce((sum, w) => sum + w.points, 0)),
        weeksOwned: log.length,
        startedWeeks: log.filter((w) => w.started).length,
        pointsStarted: round2(log.filter((w) => w.started).reduce((sum, w) => sum + w.points, 0)),
        log,
      });
    }
  }

  /** Current dynasty worth — not worth at the time of the claim. */
  function valueOf(playerId, position) {
    const v = ktc.get(`${nameKey(nameOf(playerId))}|${position}`) || null;
    return {
      ktcValue: v?.value ?? null,
      ktcPosRank: v?.positionalRank ?? null,
      ktcRank: v?.rank ?? null,
      ktcTrend: v?.trend ?? null,
      age: v?.age ?? null,
    };
  }

  // Every historical stint, for the all-time production board. A player who
  // was later dropped or traded still counts here — the points were real.
  const pastPickups = [];
  for (const [key, indices] of presence) {
    const [userId, playerId] = key.split("|");
    const position = posOf(playerId);
    if (!position || !PICKUP_POSITIONS.includes(position)) continue;

    const runs = [];
    for (const idx of indices) {
      const last = runs[runs.length - 1];
      if (last && idx === last[last.length - 1] + 1) last.push(idx);
      else runs.push([idx]);
    }

    for (const run of runs) {
      const startSlot = timeline[run[0]];
      let acq = null;
      for (const a of acquisitions) {
        if (a.userId !== userId || a.playerId !== playerId) continue;
        if (a.seasonIndex > startSlot.seasonIndex) continue;
        if (a.seasonIndex === startSlot.seasonIndex && a.week > startSlot.week) continue;
        if (!acq || a.created > acq.created) acq = a;
      }
      if (!acq || (acq.type !== "waiver" && acq.type !== "free_agent")) continue;

      const log = run.map((idx) => {
        const slot = timeline[idx];
        const e = slot.byUser.get(userId);
        return {
          season: slot.season,
          week: slot.week,
          points: round2(e.players_points?.[playerId] ?? 0),
          started: (e.starters || []).includes(playerId),
        };
      });
      const endSlot = timeline[run[run.length - 1]];

      pastPickups.push({
        season: acq.season,
        playerId,
        name: nameOf(playerId),
        position,
        nflTeam: players[playerId]?.[2] || null,
        userId,
        addedWeek: acq.week,
        throughSeason: endSlot.season,
        throughWeek: endSlot.week,
        spansSeasons: endSlot.season !== acq.season,
        stillRostered: currentRoster.get(userId)?.has(playerId) === true,
        type: acq.type,
        bid: acq.type === "waiver" ? acq.bid : null,
        ...valueOf(playerId, position),
        points: round2(log.reduce((sum, w) => sum + w.points, 0)),
        weeksOwned: log.length,
        startedWeeks: log.filter((w) => w.started).length,
        pointsStarted: round2(log.filter((w) => w.started).reduce((sum, w) => sum + w.points, 0)),
        log,
      });
    }
  }

  // Rank on current dynasty value; fall back to points when KTC is unavailable
  // or the player sits below KTC's top-500 cutoff.
  const ktcAvailable = ktc.size > 0;
  const rankByValue = (a, b) => (b.ktcValue ?? -1) - (a.ktcValue ?? -1) || b.points - a.points;
  const rankByPoints = (a, b) => b.points - a.points;

  const pickupsByValue = {};
  const pickupsByPoints = {};
  for (const pos of PICKUP_POSITIONS) {
    pickupsByValue[pos] = currentPickups
      .filter((p) => p.position === pos)
      .sort(ktcAvailable ? rankByValue : rankByPoints)
      .slice(0, 10);
    pickupsByPoints[pos] = pastPickups
      .filter((p) => p.position === pos)
      .sort(rankByPoints)
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
    pickupsByValue,
    pickupsByPoints,
    ktcAvailable,
    ktcCount: ktc.size,
    notes: {
      scores:
        "Regular-season weeks only. Kicker and defense points are removed from every total because those roster spots were cut for 2026.",
      pickupsValue:
        "Players on a roster right now that their manager originally got off the waiver wire, ranked by current KeepTradeCut dynasty value for a superflex, TE-premium+ league. Anyone since dropped or traded away is excluded — that value belongs to whoever holds them now.",
      pickupsPoints:
        "Every waiver claim and in-season free-agent add in league history, ranked by the points the player scored while on that roster — starter or bench, carried across seasons. Dropped and traded players still count; the production was real.",
    },
    updatedAt: league.updatedAt,
  };

  await Promise.all([
    writeJson("league.json", league),
    writeJson("tankathon.json", tankathon),
    writeJson("records.json", records),
    writeJson("players.json", players),
  ]);

  console.log(
    `\nWrote ${Object.keys(players).length} players, ${weeklyScores.length} weekly scores, ` +
      `${currentPickups.length} rostered pickups, ${pastPickups.length} historical stints.`
  );
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
