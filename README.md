# Beat Boys Dynasty — League Dashboard

Static dashboard for the [Beat Boys Dynasty](https://sleeper.com/leagues/1312156446493794305) Sleeper league.

**Live:** https://rodger-yuan.github.io/beatboys-dashboard/

## Sections

### Tank-a-thon
Next year's draft order, ranked from the **lowest** cumulative *best possible lineup* to
the highest. Each week every roster is scored as if it had been started perfectly —
the highest-scoring legal lineup out of all rostered players, bench included — so the
standings measure roster quality rather than start/sit luck. Pick 1 goes to the worst
roster. Click a team to see the optimal lineup it left on the table each week.

Regular-season weeks only.

### League Records
- **Championships** — all-time titles per manager, most to least.
- **Top 10 / Bottom 10 weekly scores** — click any row for that week's starting lineup.
  Kicker and defense points are **excluded from every total**, since those roster spots
  were cut for 2026. The modal shows what was dropped and Sleeper's official number.
- **Best waiver wire pickups** — top 10 per position (QB/RB/WR/TE), ranked by current
  [KeepTradeCut](https://keeptradecut.com/dynasty-rankings) value for a **superflex,
  TE-premium+** league (`superflexValues.tepp`), matching this league's SUPER_FLEX slot
  and 0.5 TE reception bonus. Points alone ranked streaming QBs above real dynasty
  assets, which is what value-ranking fixes.

  The rules:
  - Only players **still on a roster** count.
  - Credit goes to whoever **made the pickup**, even if the player has since been traded
    on — the find was theirs. The row notes where the player ended up.
  - A player picked up more than once counts only for the **most recent** pickup, so each
    player appears exactly once.
  - Covers waiver claims (with FAAB bid) and in-season free-agent adds.
  - Points shown are what the player scored for the manager who claimed them, starter or
    bench, carried across seasons and ending if they were traded away.

## How it works

`scripts/build-data.mjs` walks the league's full `previous_league_id` history on the
[Sleeper API](https://docs.sleeper.com/) and writes four JSON files into `data/`:

| file | contents |
| --- | --- |
| `league.json` | members, season list, last-updated stamp |
| `tankathon.json` | per-team best-possible totals + weekly optimal lineups |
| `records.json` | championships, score records, both waiver-pickup boards |
| `players.json` | slim `id → [name, position, nflTeam]` map (~150 KB) |

The page renders that bundle instantly, then re-pulls the current season's matchups
directly from Sleeper in the browser and recomputes the Tank-a-thon, so in-progress
weeks score live. If that fetch fails it silently keeps the built-in data.

GitHub Actions rebuilds and redeploys every 3 hours (`.github/workflows/deploy.yml`).
`data/` is generated in CI and is not committed.

KTC values are scraped from the JSON payload embedded in the dynasty-rankings page, **at
most once a day**: the scrape is cached under `.cache/`, and the workflow restores that
cache between runs keyed on the UTC date, so the 3-hourly Sleeper rebuild doesn't re-hit
KTC. The board caps at 500 players with a value floor around 460, so a player who isn't
found is shown as unranked rather than treated as an error. If KTC is unreachable the
build reuses the last scrape, and failing that still succeeds with points ranking.

### Reading tenure from snapshots, not the transaction log

Weeks rostered come from the weekly matchup snapshots, not from replaying transactions.
A waiver claim can process *after* a week's snapshot is taken — Malik Willis was claimed
in 2025 week 16 but first appears in week 17 — so anchoring a stint to the transaction
week silently dropped those pickups entirely. Runs are built from the snapshots and then
matched back to whichever acquisition brought the player in, on the run's *end* rather
than its start: a same-week drop-and-re-add leaves tenure unbroken (Chris Rodriguez was
re-claimed in 2025 week 7 while already rostered since week 3), so a pickup doesn't
always open a run.

### Optimal lineup math

Slot eligibility forms a laminar family (`QB ⊂ SUPER_FLEX`, `RB/WR/TE ⊂ FLEX ⊂
SUPER_FLEX`, strict slots pairwise disjoint), so filling the most restrictive slots
first — each taking the best player still available — is provably optimal. No search
needed.

## Local development

```bash
npm run build:data   # pull fresh data from Sleeper into data/
npm run dev          # serve on http://localhost:4180
```

Point it at a different league with `SLEEPER_LEAGUE_ID=<id> npm run build:data`.
