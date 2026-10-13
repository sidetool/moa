# Source popularity aggregation

The visible label stays “오늘의 TOP 10”. This is a combination of extension-provided popular-list positions, not MOA viewing statistics or a measured daily chart.

- For each on-demand source of the current tab, reuse up to 20 entries of the popular first page, including the tab’s existing filter selection. Do not fetch extra pages.
- Positions 1–20 contribute 20–1 points. Group using existing profile-aware title identity, season/edition boundaries and manual overrides. A source contributes only its best position per group, once.
- Sort by total points, contributing source count, best position and stable group key. Source arrival/order does not affect the final ordering for the same input.
- Only supplied entries contribute; unrelated library copies add no votes. Disabled, live, inaccessible and wrong-provider entries are rejected. Kids filtering uses the existing title-group path.
- Return at most ten cards through `POST /api/media/popular` (`{lists:[{sourceId,ids}]}`). Limits: 32 source lists × 20 IDs. The client caches by profile and input lists for five minutes.
- TOP 10 aggregates equivalent works regardless of the catalogue grouping display toggle. The hero, per-source shelves and their grouping preference retain their existing behavior. A failed ranking request hides the ranking row; it never fabricates a numbered fallback.
