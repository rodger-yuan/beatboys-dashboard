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
- **Best waiver wire pickups** — split into top 10 per position (QB/RB/WR/TE). A pickup's
  value is every point the player scored while on that roster, starting or benched.
  Covers both waiver claims (with FAAB bid) and in-season free-agent adds. Repeat
  pickups of the same player count as separate stints.

## How it works

`scripts/build-data.mjs` walks the league's full `previous_league_id` history on the
[Sleeper API](https://docs.sleeper.com/) and writes four JSON files into `data/`:

| file | contents |
| --- | --- |
| `league.json` | members, season list, last-updated stamp |
| `tankathon.json` | per-team best-possible totals + weekly optimal lineups |
| `records.json` | championships, score records, waiver pickups |
| `players.json` | slim `id → [name, position, nflTeam]` map (~150 KB) |

The page renders that bundle instantly, then re-pulls the current season's matchups
directly from Sleeper in the browser and recomputes the Tank-a-thon, so in-progress
weeks score live. If that fetch fails it silently keeps the built-in data.

GitHub Actions rebuilds and redeploys every 3 hours (`.github/workflows/deploy.yml`).
`data/` is generated in CI and is not committed.

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
