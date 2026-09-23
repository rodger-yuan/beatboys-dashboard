#!/usr/bin/env node
/**
 * Builds the static data bundle for the Beat Boys Dynasty dashboard.
 *
 * Pulls every season in the league's history from the Sleeper API and writes
 * data/*.json. Run locally with `npm run build:data`, or on a schedule via
 * .github/workflows/build-data.yml.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
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

/**
 * KTC is scraped at most once a day. The scrape is cached on disk and the
 * cache is restored between CI runs (see .github/workflows/deploy.yml), so the
 * 3-hourly Sleeper rebuild doesn't re-hit KTC. Dynasty values barely move
 * inside a day anyway.
 */
const KTC_CACHE = resolve(ROOT, ".cache", "ktc.json");
const KTC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  const cached = await readKTCCache();
  if (cached && Date.now() - cached.fetchedAt < KTC_MAX_AGE_MS) {
    const age = Math.round((Date.now() - cached.fetchedAt) / 3.6e6);
    console.log(`  KTC: ${cached.players.length} valuations from cache (${age}h old)`);
    return indexKTC(cached.players);
  }

  try {
    const res = await fetch(KTC_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; beatboys-dashboard/1.0)" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const html = await res.text();
    const match = html.match(/<script[^>]*id=["']ktc-players["'][^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error("ktc-players payload not found");

    const players = JSON.parse(match[1])
      .filter((p) => PICKUP_POSITIONS.includes(p.position) && p.superflexValues?.tepp)
      .map((p) => ({
        name: p.playerName,
        position: p.position,
        value: p.superflexValues.tepp.value,
        rank: p.superflexValues.tepp.rank,
        positionalRank: p.superflexValues.tepp.positionalRank,
        trend: p.superflexValues.overall7DayTrend ?? null,
        age: p.age ?? null,
      }));

    await mkdir(dirname(KTC_CACHE), { recursive: true });
    await writeFile(KTC_CACHE, JSON.stringify({ fetchedAt: Date.now(), players }));
    console.log(`  KTC: ${players.length} valuations fetched (superflex, TEP+)`);
    return indexKTC(players);
  } catch (err) {
    // A stale scrape still beats dropping the board to points-only.
    if (cached) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 3.6e6);
      console.warn(`  ! KTC fetch failed (${err.message}) — reusing ${age}h-old cache`);
      return indexKTC(cached.players);
    }
    console.warn(`  ! KTC unavailable (${err.message}) — pickups will rank on points`);
    return new Map();
  }
}

async function readKTCCache() {
  try {
    const cached = JSON.parse(await readFile(KTC_CACHE, "utf8"));
    return Array.isArray(cached.players) && cached.players.length ? cached : null;
  } catch {
    return null;
  }
}

/** Index by name + position; the board is value-sorted, so first hit wins. */
function indexKTC(players) {
  const map = new Map();
  for (const p of players) {
    const key = `${nameKey(p.name)}|${p.position}`;
    if (!map.has(key)) map.set(key, p);
  }
  return map;
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

  // The board answers "which players on a roster right now came off the waiver
  // wire, and who found them?" Credit goes to the manager who made the pickup,
  // even if the player has since been traded on — the find was theirs. A player
  // picked up more than once counts only for the most recent pickup, so each
  // player appears exactly once.
  /** Current dynasty worth — not worth at the time of the claim. */
  function ktcFor(playerId, position) {
    const v = ktc.get(`${nameKey(nameOf(playerId))}|${position}`) || null;
    return {
      ktcValue: v?.value ?? null,
      ktcPosRank: v?.positionalRank ?? null,
      ktcRank: v?.rank ?? null,
      ktcTrend: v?.trend ?? null,
      age: v?.age ?? null,
    };
  }

  const rosteredNow = new Map(); // playerId -> userId currently holding them
  for (const r of current.rosters) {
    const userId = current.ownerOf.get(r.roster_id);
    if (!userId) continue;
    for (const playerId of r.players || []) rosteredNow.set(playerId, userId);
  }

  /**
   * The unbroken stretch on this manager's roster that the pickup belongs to.
   *
   * Matched on the run's *end*, not its start, because a pickup doesn't always
   * open a run: a same-week drop-and-re-add leaves tenure unbroken (Chris
   * Rodriguez was re-claimed in 2025 week 7 while already rostered since week
   * 3), and a claim that processes after the week's snapshot starts the run a
   * week late. Either way the whole stretch is theirs.
   */
  function runFor(userId, playerId, acq) {
    const indices = presence.get(`${userId}|${playerId}`);
    if (!indices?.length) return [];

    const from = timeline.findIndex(
      (slot) =>
        slot.seasonIndex > acq.seasonIndex ||
        (slot.seasonIndex === acq.seasonIndex && slot.week >= acq.week)
    );
    if (from === -1) return []; // picked up after the last scored week

    const runs = [];
    for (const idx of indices) {
      const last = runs[runs.length - 1];
      if (last && idx === last[last.length - 1] + 1) last.push(idx);
      else runs.push([idx]);
    }
    return runs.find((run) => run[run.length - 1] >= from) || [];
  }

  const pickups = [];
  for (const [playerId, currentOwner] of rosteredNow) {
    const position = posOf(playerId);
    if (!position || !PICKUP_POSITIONS.includes(position)) continue;

    // The most recent time anyone claimed this player off the wire. Drafted
    // players have none; trades don't count as a pickup.
    let acq = null;
    for (const a of acquisitions) {
      if (a.playerId !== playerId) continue;
      if (a.type !== "waiver" && a.type !== "free_agent") continue;
      if (!acq || a.created > acq.created) acq = a;
    }
    if (!acq) continue;

    // Points are what the player scored for the manager who picked them up —
    // a trade ends that stretch, and the acquiring team's points aren't theirs.
    const run = runFor(acq.userId, playerId, acq);
    const log = run.map((idx) => {
      const slot = timeline[idx];
      const e = slot.byUser.get(acq.userId);
      return {
        season: slot.season,
        week: slot.week,
        points: round2(e.players_points?.[playerId] ?? 0),
        started: (e.starters || []).includes(playerId),
      };
    });

    pickups.push({
      season: acq.season,
      playerId,
      name: nameOf(playerId),
      position,
      nflTeam: players[playerId]?.[2] || null,
      userId: acq.userId,
      currentOwner,
      tradedAway: currentOwner !== acq.userId,
      addedWeek: acq.week,
      spansSeasons: log.length > 0 && log[log.length - 1].season !== acq.season,
      type: acq.type,
      bid: acq.type === "waiver" ? acq.bid : null,
      ...ktcFor(playerId, position),
      points: round2(log.reduce((sum, w) => sum + w.points, 0)),
      weeksOwned: log.length,
      startedWeeks: log.filter((w) => w.started).length,
      pointsStarted: round2(log.filter((w) => w.started).reduce((sum, w) => sum + w.points, 0)),
      log,
    });
  }

  // Rank on current dynasty value; fall back to points when KTC is unavailable
  // or the player sits below KTC's top-500 cutoff.
  const ktcAvailable = ktc.size > 0;
  const rankByValue = (a, b) => (b.ktcValue ?? -1) - (a.ktcValue ?? -1) || b.points - a.points;
  const rankByPoints = (a, b) => b.points - a.points;

  const pickupsByPosition = {};
  for (const pos of PICKUP_POSITIONS) {
    pickupsByPosition[pos] = pickups
      .filter((p) => p.position === pos)
      .sort(ktcAvailable ? rankByValue : rankByPoints)
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
    ktcAvailable,
    ktcCount: ktc.size,
    notes: {
      scores:
        "Regular-season weeks only. Kicker and defense points are removed from every total because those roster spots were cut for 2026.",
      pickups:
        "Every player still on a roster who was originally picked up off the waiver wire, ranked by current KeepTradeCut dynasty value for a superflex, TE-premium+ league. Credit goes to whoever made the pickup, even if the player has since been traded on. Players picked up more than once count only for the most recent pickup. Points are what they scored for the manager who claimed them.",
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
    `\nWrote ${Object.keys(players).length} players, ${weeklyScores.length} weekly scores, ${pickups.length} pickups.`
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
