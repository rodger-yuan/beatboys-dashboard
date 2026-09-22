/* Beat Boys Dynasty dashboard — renders the prebuilt data bundle, then refreshes
   the Tank-a-thon straight from Sleeper so in-progress weeks score live. */

const API = "https://api.sleeper.app/v1";

const FLEX_ELIGIBLE = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

const SLOT_LABEL = { SUPER_FLEX: "SFLX", WRRB_FLEX: "W/R", REC_FLEX: "W/T", FLEX: "FLEX" };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
};
const fmt = (n) => Number(n).toFixed(2);
const fmt1 = (n) => Number(n).toFixed(1);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let DATA = {};
let NAMES = new Map();

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

init();

async function init() {
  try {
    const [league, tank, records, players] = await Promise.all(
      ["league", "tankathon", "records", "players"].map((f) =>
        fetch(`data/${f}.json`, { cache: "no-cache" }).then((r) => {
          if (!r.ok) throw new Error(`data/${f}.json → ${r.status}`);
          return r.json();
        })
      )
    );
    DATA = { league, tank, records, players };
  } catch (err) {
    document.querySelectorAll(".loading").forEach((n) => {
      n.textContent = "Couldn't load league data. Try a refresh.";
    });
    console.error(err);
    return;
  }

  for (const m of DATA.league.members) NAMES.set(m.userId, m);

  setupTabs();
  renderHeader();
  renderTank(DATA.tank);
  renderRecords();
  setupModal();

  // Non-blocking: replace the baked-in Tank-a-thon with live scoring.
  refreshLive();
  setInterval(refreshLive, 5 * 60 * 1000);
}

const teamOf = (userId) => {
  const m = NAMES.get(userId);
  if (!m) return { display: "Unknown", handle: "" };
  return { display: m.teamName || m.name, handle: m.teamName ? `@${m.name}` : "" };
};

function renderHeader() {
  const { league, tank } = DATA;
  $("season-label").textContent = `${league.currentSeason} season`;
  const wks = tank.weeksCounted;
  $("weeks-note").textContent = wks.length
    ? `Through week ${wks[wks.length - 1]} of the ${tank.playoffStart - 1}-week regular season.`
    : "No weeks scored yet.";
  stamp(league.updatedAt, false);
}

function stamp(iso, live) {
  const d = new Date(iso);
  const label = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  $("update-label").textContent = `Updated ${label}`;
  $("footer-updated").textContent = `Last refreshed ${label}.`;
  const pill = $("live-pill");
  pill.dataset.state = live ? "live" : "stale";
  pill.textContent = live ? "Live" : "Cached";
  pill.title = live ? "Scores pulled from Sleeper just now" : "Showing the last scheduled build";
}

function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        $(t.getAttribute("aria-controls")).hidden = !on;
      });
      history.replaceState(null, "", `#${tab.id.replace("tab-", "")}`);
    });
  });
  const hash = location.hash.slice(1);
  if (hash === "records") $("tab-records").click();
}

// ---------------------------------------------------------------------------
// optimal lineup (mirrors scripts/build-data.mjs)
// ---------------------------------------------------------------------------

/**
 * Best legal lineup from a full roster. Slot eligibility is a laminar family
 * (QB ⊂ SUPER_FLEX, RB/WR/TE ⊂ FLEX ⊂ SUPER_FLEX), so filling the most
 * restrictive slots first — each taking the best player left — is optimal.
 */
function optimalLineup(slots, candidates) {
  const ordered = slots
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
    lineup[i] = { slot, ...(pick || { id: null, name: "—", position: null, points: 0 }) };
  }

  const filled = lineup.filter(Boolean);
  return { lineup: filled, total: round2(filled.reduce((s, p) => s + p.points, 0)) };
}

// ---------------------------------------------------------------------------
// live refresh
// ---------------------------------------------------------------------------

async function refreshLive() {
  const { tank, league, players } = DATA;
  try {
    const state = await fetch(`${API}/state/nfl`).then((r) => r.json());
    const lastWeek = Math.min(state.week || 1, tank.playoffStart - 1);
    if (lastWeek < 1) return;

    const weeks = await Promise.all(
      Array.from({ length: lastWeek }, (_, i) =>
        fetch(`${API}/league/${league.leagueId}/matchups/${i + 1}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((entries) => ({ week: i + 1, entries }))
      )
    );

    const teams = tank.teams.map((t) => {
      const byWeek = [];
      for (const { week, entries } of weeks) {
        if (!entries) continue;
        const e = entries.find((x) => x.roster_id === t.rosterId);
        if (!e || !e.players_points) continue;
        const anyScore = Object.values(e.players_points).some((v) => v !== 0);
        if (!anyScore && !(e.points > 0)) continue; // week hasn't started

        const candidates = Object.entries(e.players_points)
          .filter(([id]) => players[id])
          .map(([id, points]) => ({ id, name: players[id][0], position: players[id][1], points: round2(points) }));
        const { lineup, total } = optimalLineup(tank.slots, candidates);
        const actual = round2(e.points || 0);
        byWeek.push({ week, best: total, actual, efficiency: total > 0 ? round2((100 * actual) / total) : 0, lineup });
      }
      if (!byWeek.length) return t;
      const totalBest = round2(byWeek.reduce((s, w) => s + w.best, 0));
      const totalActual = round2(byWeek.reduce((s, w) => s + w.actual, 0));
      return {
        ...t,
        totalBest,
        totalActual,
        efficiency: totalBest > 0 ? round2((100 * totalActual) / totalBest) : 0,
        weeks: byWeek,
      };
    });

    teams.sort((a, b) => a.totalBest - b.totalBest);
    teams.forEach((t, i) => (t.pick = i + 1));

    const counted = teams[0]?.weeks.map((w) => w.week) || tank.weeksCounted;
    DATA.tank = { ...tank, teams, weeksCounted: counted };
    renderTank(DATA.tank);
    $("weeks-note").textContent = counted.length
      ? `Through week ${counted[counted.length - 1]} of the ${tank.playoffStart - 1}-week regular season.`
      : "No weeks scored yet.";
    stamp(new Date().toISOString(), true);
  } catch (err) {
    console.warn("Live refresh failed, keeping cached data.", err);
  }
}

// ---------------------------------------------------------------------------
// Tank-a-thon
// ---------------------------------------------------------------------------

function renderTank(tank) {
  const body = $("tank-body");
  body.replaceChildren();

  if (!tank.teams.length) {
    body.append(el("tr", {}, el("td", { colSpan: 6, className: "empty" }, "No games scored yet this season.")));
    return;
  }

  for (const t of tank.teams) {
    const { display, handle } = teamOf(t.userId);
    const row = el(
      "tr",
      { className: "row-btn", tabIndex: 0, role: "button", "aria-label": `${display} weekly breakdown` },
      el("td", {}, el("span", { className: `pick${t.pick === 1 ? " top" : ""}`, textContent: String(t.pick) })),
      el("td", {}, el("div", { className: "team" }, display, handle ? el("small", { textContent: handle }) : null)),
      el("td", { className: "num rec hide-sm" }, `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`),
      el("td", { className: `num big${t.pick === 1 ? " hot" : ""}` }, fmt(t.totalBest)),
      el("td", { className: "num dim hide-sm" }, fmt(t.totalActual)),
      el(
        "td",
        { className: "num dim hide-sm" },
        `${fmt1(t.efficiency)}%`,
        el("div", { className: "bar" }, el("i", { style: `width:${Math.min(100, t.efficiency)}%` }))
      )
    );

    const detail = el("tr", { className: "detail", hidden: true }, el("td", { colSpan: 6 }, weekGrid(t)));
    const toggle = () => (detail.hidden = !detail.hidden);
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });

    body.append(row, detail);
  }
}

function weekGrid(team) {
  const cards = team.weeks.map((w) =>
    el(
      "div",
      { className: "wk" },
      el(
        "div",
        { className: "wk-top" },
        el("span", { className: "wk-label" }, `Week ${w.week}`),
        el("span", { className: "wk-best hot" }, fmt(w.best))
      ),
      el("div", { className: "wk-meta" }, `actual ${fmt(w.actual)} · ${fmt1(w.efficiency)}% efficient`),
      el(
        "table",
        { className: "lineup" },
        el(
          "tbody",
          {},
          w.lineup.map((p) =>
            el(
              "tr",
              {},
              el("td", {}, el("span", { className: "slot" }, SLOT_LABEL[p.slot] || p.slot)),
              el("td", {}, p.name || "—"),
              el("td", {}, fmt1(p.points))
            )
          )
        )
      )
    )
  );

  return el(
    "div",
    { className: "detail-inner" },
    cards.length ? el("div", { className: "wk-grid" }, cards) : el("div", { className: "empty" }, "No weeks scored.")
  );
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function renderRecords() {
  const { records } = DATA;
  $("score-note").textContent = records.notes.scores;
  $("pickup-note").textContent = records.notes.pickups;

  renderChampionships(records.championships);
  renderScoreBoard($("top-body"), records.topScores, "hot");
  renderScoreBoard($("low-body"), records.lowScores, "cold");
  renderPickups(records.pickupsByPosition);
}

function renderChampionships(rows) {
  const body = $("champ-body");
  body.replaceChildren();
  rows.forEach((r, i) => {
    const { display, handle } = teamOf(r.userId);
    body.append(
      el(
        "tr",
        {},
        el("td", {}, el("span", { className: `pick${r.titles > 0 ? " gold" : ""}` }, String(i + 1))),
        el("td", {}, el("div", { className: "team" }, display, handle ? el("small", { textContent: handle }) : null)),
        el("td", { className: `num big${r.titles ? " " : " faint"}` }, r.titles ? "🏆".repeat(Math.min(r.titles, 4)) + ` ${r.titles}` : "0"),
        el("td", { className: "num dim hide-sm" }, r.seasons.join(", ") || "—"),
        el("td", { className: "num faint hide-sm" }, r.runnerUps.join(", ") || "—")
      )
    );
  });
}

function renderScoreBoard(body, rows, tone) {
  body.replaceChildren();
  if (!rows.length) {
    body.append(el("tr", {}, el("td", { colSpan: 5, className: "empty" }, "Not enough history yet.")));
    return;
  }
  rows.forEach((s, i) => {
    const { display, handle } = teamOf(s.userId);
    const row = el(
      "tr",
      { className: "row-btn", tabIndex: 0, role: "button", "aria-label": `${display} week ${s.week} lineup` },
      el("td", {}, el("span", { className: "pick" }, String(i + 1))),
      el("td", {}, el("div", { className: "team" }, display, handle ? el("small", { textContent: handle }) : null)),
      el("td", { className: "num dim hide-sm" }, s.season),
      el("td", { className: "num dim hide-sm" }, `Wk ${s.week}`),
      el("td", { className: `num big ${tone}` }, fmt(s.points))
    );
    const open = () => openScoreModal(s, display);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    body.append(row);
  });
}

function renderPickups(byPos) {
  const positions = Object.keys(byPos);
  const chips = $("pos-chips");
  chips.replaceChildren();

  const show = (pos) => {
    [...chips.children].forEach((c) => c.setAttribute("aria-selected", String(c.dataset.pos === pos)));
    const body = $("pickup-body");
    body.replaceChildren();
    const rows = byPos[pos] || [];
    if (!rows.length) {
      body.append(el("tr", {}, el("td", { colSpan: 5, className: "empty" }, `No ${pos} pickups yet.`)));
      return;
    }
    rows.forEach((p, i) => {
      const { display } = teamOf(p.userId);
      const badge =
        p.type === "waiver"
          ? el("span", { className: "tag waiver" }, p.bid != null ? `$${p.bid}` : "Waiver")
          : el("span", { className: "tag" }, "FA");
      const row = el(
        "tr",
        { className: "row-btn", tabIndex: 0, role: "button", "aria-label": `${p.name} pickup detail` },
        el("td", {}, el("span", { className: "pick" }, String(i + 1))),
        el(
          "td",
          {},
          el(
            "div",
            { className: "team" },
            el("span", { className: "pos", "data-p": p.position }, p.position),
            " ",
            p.name,
            el("small", { textContent: `${p.nflTeam || "FA"} · ${p.weeksOwned} wk${p.weeksOwned === 1 ? "" : "s"} rostered` })
          )
        ),
        el("td", {}, el("div", { className: "team" }, display, el("small", { textContent: `${p.season} · wk ${p.addedWeek}` }))),
        el("td", { className: "right hide-sm" }, badge),
        el("td", { className: "num big accent" }, fmt1(p.points))
      );
      const open = () => openPickupModal(p, display);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
      body.append(row);
    });
  };

  positions.forEach((pos) => {
    const c = el("button", { className: "chip", type: "button", role: "tab" }, pos);
    c.dataset.pos = pos;
    c.addEventListener("click", () => show(pos));
    chips.append(c);
  });
  show(positions[0]);
}

// ---------------------------------------------------------------------------
// modal
// ---------------------------------------------------------------------------

function setupModal() {
  const modal = $("modal");
  $("modal-close").addEventListener("click", () => modal.close());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.close(); // click on backdrop
  });
}

function showModal(title, sub, nodes) {
  $("modal-title").textContent = title;
  $("modal-sub").textContent = sub;
  $("modal-body").replaceChildren(...nodes);
  $("modal").showModal();
}

function openScoreModal(s, display) {
  const rows = [...s.starters].sort((a, b) => b.points - a.points);
  const table = el(
    "table",
    { className: "lineup" },
    el(
      "tbody",
      {},
      rows.map((p) =>
        el(
          "tr",
          {},
          el("td", {}, el("span", { className: "pos", "data-p": p.position }, p.position || "—")),
          el("td", {}, p.name),
          el("td", {}, fmt1(p.points))
        )
      )
    )
  );

  const nodes = [
    table,
    el(
      "div",
      { className: "modal-total" },
      el("span", {}, "Counted total"),
      el("span", { className: "v" }, fmt(s.points))
    ),
  ];

  if (s.excludedStarters?.length) {
    nodes.push(
      el(
        "div",
        { className: "excluded" },
        el("span", { className: "wk-label" }, `Not counted — ${s.season} kickers & defense (${fmt1(s.excludedPoints)} pts)`),
        el(
          "table",
          { className: "lineup" },
          el(
            "tbody",
            {},
            s.excludedStarters.map((p) =>
              el(
                "tr",
                { className: "benched" },
                el("td", {}, el("span", { className: "pos" }, p.position || "—")),
                el("td", {}, p.name),
                el("td", {}, fmt1(p.points))
              )
            )
          )
        ),
        el("div", { className: "wk-meta" }, `Sleeper's official score that week was ${fmt(s.officialPoints)}.`)
      )
    );
  }

  showModal(display, `${s.season} · Week ${s.week} starting lineup`, nodes);
}

function openPickupModal(p, display) {
  const table = el(
    "table",
    { className: "lineup" },
    el(
      "tbody",
      {},
      p.log.map((w) =>
        el(
          "tr",
          { className: w.started ? "" : "benched" },
          el("td", {}, el("span", { className: "slot" }, `WK${w.week}`)),
          el("td", {}, w.started ? "Started" : "Bench"),
          el("td", {}, fmt1(w.points))
        )
      )
    )
  );

  const how = p.type === "waiver" ? `Waiver claim${p.bid != null ? ` · $${p.bid} FAAB` : ""}` : "Free agent add";

  showModal(
    p.name,
    `${p.position} · ${p.nflTeam || "FA"} — added by ${display} in week ${p.addedWeek}, ${p.season}`,
    [
      el("div", { className: "wk-meta", style: "padding:10px 0 2px" }, `${how} · ${p.weeksOwned} weeks rostered · started ${p.startedWeeks}`),
      table,
      el(
        "div",
        { className: "modal-total" },
        el("span", {}, "Total while rostered"),
        el("span", { className: "v accent" }, fmt1(p.points))
      ),
      el("div", { className: "wk-meta" }, `${fmt1(p.pointsStarted)} of those points came in the starting lineup.`),
    ]
  );
}
