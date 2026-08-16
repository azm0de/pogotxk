# Migration numbering

`0002_flare_discord_close.sql` and `0002_poi_reports_report_only.sql` are both
numbered 0002. This is intentional and stays that way — investigated
2026-08-16, see below.

**Do not rename either file to de-duplicate the number.** D1 records applied
migrations by exact filename in its own `d1_migrations` table:

```
id  name                                applied_at
1   0001_initial.sql                    2026-08-05 19:54:50
2   0002_poi_reports_report_only.sql    2026-08-15 17:19:55
3   0002_flare_discord_close.sql        2026-08-15 17:38:49
```

`wrangler d1 migrations list` diffs the local `migrations/` directory against
that `name` column by exact string match, not by parsed number. Rename either
file and wrangler stops recognizing it as applied — the next
`wrangler d1 migrations apply` sees a "new" migration and reruns it against a
database where it already ran.

The two files fail differently, and the asymmetry is the point.
`0002_flare_discord_close.sql` only adds a column, so a rerun errors on an
existing column — loud, and safe. `0002_poi_reports_report_only.sql` opens with
`DROP TABLE IF EXISTS poi_reports`, so a rerun drops the table and takes
whatever is in it.

Today that costs nothing: checked 2026-08-16, `poi_reports` holds **0 rows** and
nothing in `src/` writes to it — the only reference is a `COUNT(*)` on the admin
dashboard. So this is a trap being disarmed before it is armed, not a live
data-loss risk. The moment something starts writing reports, it becomes one, and
by then nobody will re-derive this.

Hand-editing the remote `d1_migrations` table to patch around a rename is not
worth the risk either — it's an unforced desync on a system that isn't broken
today.

Nothing is broken: `wrangler` sorts by filename, and `0002_flare_discord_close`
sorts after `0002_poi_reports_report_only` deterministically, matching the
order they were actually applied in. The next new migration is
**`0003_*`** — `0003` was never claimed by either of these, despite the
appearance of a gap.
