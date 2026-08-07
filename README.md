# leadsman

Scheduled rule engine over a ChirpStack event store. It runs a set of checks you
select in a config file, and records deduplicated alerts in Postgres.

Leadsman is the deterministic tier of a monitoring stack. It consumes no inference
tokens, and it does not send messages: it decides *what is wrong* and writes that
down. Delivery (SMS, webhook, an LLM agent for the cases that need interpretation)
is a separate concern reached through one webhook.

```
ChirpStack ──▶ events-postgres (event_up, event_join, …)
                     │  SELECT
                     ▼
                 leadsman  ──▶ leadsman.alert  ──▶ notify.webhookUrl
                 (cron)          (deduplicated)     (your sender / Hermes)
```

## Why a scheduler rather than an MQTT consumer

Most alerting on LoRaWAN telemetry can be done on the uplink stream, and where it
can be, it should be — that path has lower latency and no polling cost. Leadsman
exists for the checks that a stream consumer structurally cannot perform:

- **Absence.** You cannot trigger on a message that never arrived. `device-silent`
  needs a periodic sweep.
- **Aggregates over a window.** "Average RSSI has drifted down over three days"
  is a query, not an event.
- **Non-events.** A sensor reporting the same plausible value forever
  (`measurement-stuck`) or uplinks that arrive but never decode
  (`decode-failure`) generate no anomalous message to react to.

Every check aggregates in SQL and returns only breaching devices, so the work
happens in Postgres rather than in the engine.

## Install

```sh
npm install @intelligent-farming/leadsman
```

Or run the container — see [Deployment](#deployment).

## Quick start

```sh
cp config/leadsman.example.json config/leadsman.json
export LEADSMAN_DATABASE_URL='postgres://leadsman:...@events-postgres:5432/chirpstack_events'
export LEADSMAN_MIGRATE_URL='postgres://events:...@events-postgres:5432/chirpstack_events'

leadsman migrate            # create the leadsman schema
leadsman list               # what checks exist
leadsman verify             # validate config + database schema, write nothing
leadsman run --dry-run      # evaluate everything, report, write nothing
leadsman run                # one sounding for real
leadsman serve              # stay resident, sound on the configured schedule
leadsman status             # what is currently open
```

`verify` and `run --dry-run` are the two commands worth running before trusting a
config. `verify` checks that every table and column your enabled checks declare
actually exists in this ChirpStack version; `--dry-run` executes all the real SQL
and prints what it would raise.

## Configuration

`config/leadsman.json` selects checks and sets their parameters. It holds no
credentials — the database URL and webhook token come from the environment — so it
is safe to commit and review in a diff.

```json
{
  "schedule": "*/15 * * * *",
  "timezone": "America/Chicago",
  "statementTimeoutMs": 15000,
  "notify": { "webhookUrl": null },
  "checks": [
    { "rule": "device-silent", "params": { "silentMinutes": 180 } },

    { "rule": "measurement-threshold", "as": "soil-moisture-low",
      "params": { "paths": ["soil.moisture"], "min": 15, "unit": "%", "clearMargin": 2 } },

    { "rule": "measurement-threshold", "as": "frost-risk", "severity": "critical",
      "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],
                  "min": 1.5, "unit": "C", "lookbackHours": 6 } },

    { "rule": "signal-degraded", "enabled": false }
  ]
}
```

| Field | Meaning |
|---|---|
| `rule` | Which check script to run |
| `as` | Instance name, and the alert `kind`. Defaults to `rule`. Required when enabling the same rule twice |
| `enabled` | Defaults to `true`. Set `false` to keep an entry documented but inactive |
| `severity` | Overrides the check's default. A check may still escalate an individual finding |
| `params` | Merged over the check's `defaultParams`. Unknown keys are reported by `verify` |
| `statementTimeoutMs` | Per-query ceiling, applied as Postgres `statement_timeout` |

Generic checks like `measurement-threshold` are meant to be listed more than once
under different `as` names. Each instance raises and resolves independently, because
`kind` is part of the alert identity.

Two configs ship in `config/`:

| File | Purpose |
|---|---|
| `leadsman.example.json` | The full menu — every check, most disabled, organized by farm concern |
| `makerfabs-agrosense.example.json` | A worked per-device set for four Makerfabs AgroSense units (AGLWSM02, AGLWTH01, AGLWPP01, AGLWL01), with paths verified against each codec's `vectors.json` |

The Makerfabs config is the better starting point if you run that hardware, and the
better *example* either way — it shows per-family battery scoping, the peak-vs-latest
distinction, and thresholds annotated with why they are set where they are. Both are
exercised by CI against fixtures, so neither can drift from the code.

## Available checks

Eighteen checks in two families, organized by *mechanism* rather than by measurement.
Which sensor a check looks at is configuration; how it decides something is wrong is
code. That is why so few checks cover all 104 paths of the normalized vocabulary — a
wind threshold and a soil-moisture threshold are the same mechanism pointed at
different paths.

Run `leadsman list` for every parameter and default.

| Check | Mechanism | Default severity |
|---|---|---|
| `measurement-threshold` | Latest reading outside a min/max bound | warning |
| `measurement-peak` | Highest or lowest value *anywhere* in a window | warning |
| `measurement-rate` | Value changing faster than a per-hour limit | warning |
| `measurement-stuck` | Reading has not changed across many uplinks | warning |
| `measurement-missing` | A field vanished from the codec output | warning |
| `boolean-alarm` | A flag is asserted (leak, gas, smoke, motion, open contact) | critical |
| `counter-stalled` | A monotonic total stopped advancing, or went backwards | warning |
| `counter-spike` | A monotonic total advancing far too fast | critical |
| `geofence-breach` | Position outside a bounding box or radius | critical |
| `battery-low` | Supply voltage below threshold, with hysteresis | warning |
| `device-silent` | A device that was reporting has stopped | critical |
| `decode-failure` | Uplinks arriving but the codec decodes nothing | warning |
| `signal-degraded` | Average best-gateway RSSI/SNR toward the edge of coverage | info |

### Network-layer checks

The checks above read decoded telemetry from `event_up`. These read the *other* tables
ChirpStack's PostgreSQL integration writes, and they catch devices that look perfectly
healthy in `event_up`.

| Check | Reads | Mechanism | Default severity |
|---|---|---|---|
| `device-log-error` | `event_log` | ChirpStack's own error log for the device | warning |
| `status-battery-low` | `event_status` | Battery % from the MAC layer, **codec-independent** | warning |
| `status-margin-low` | `event_status` | Device's demodulation margin — can it hear the gateway | warning |
| `join-churn` | `event_join` | Repeated rejoins; session keeps dropping | warning |
| `downlink-unacked` | `event_ack` | Confirmed downlinks never acknowledged | critical |

Three of these are worth understanding rather than just enabling:

- **`status-battery-low` works when the codec does not.** `battery-low` reads whatever
  the payload codec decoded; if the codec is missing or broken it silently stops
  matching the device, so a flat battery goes unnoticed exactly when every other check
  has already gone quiet. `event_status` comes from a MAC-layer `DevStatusReq`, so no
  codec is involved. Enable both.
- **`status-margin-low` measures the opposite direction from `signal-degraded`.**
  RSSI is how well the *gateway* hears the device; margin is how well the *device*
  hears the gateway. Asymmetry is common, and a low margin breaks ADR, confirmed
  uplinks, and every actuator command.
- **`device-log-error` reports rather than infers.** When a normalized codec cannot
  parse, it returns `{errors: […]}` with no `data` key, so ChirpStack has nothing to put
  in `event_up.object` — the reason is written to `event_log` instead. `decode-failure`
  tells you *that* nothing decoded; this tells you *why*.

### The checks worth enabling first

Six describe a device that looks **completely healthy to every other check** while
producing no usable data:

- `decode-failure` — the codec is producing nothing.
- `measurement-missing` — the codec still works but a field silently disappeared, so
  every check on it stops matching the device. Silence looks identical to health.
- `measurement-stuck` — a detached probe or seized anemometer reporting a plausible
  constant forever.
- `counter-stalled` — a water meter reading the same total because the pump failed.
- `join-churn` — a device rejoining more often than it reports data. `device-silent`
  stays quiet because uplinks *are* arriving.
- `downlink-unacked` — a command that never landed. Nothing in the telemetry says a
  valve failed to open.

## Measurements and multi-path resolution

Checks point at the fixed vocabulary emitted by
[@intelligent-farming/lorawan-codec-normalization](https://github.com/intelligent-farming/lorawan-codec-normalization):
104 paths across 37 device categories, in **guaranteed units** (`wind.speed` is always
m/s, `temperature` always °C, `soil.moisture` always a percentage). That guarantee is
why the shipped checks can have meaningful default thresholds instead of asking you to
supply one per vendor. Full table: [docs/vocabulary.md](docs/vocabulary.md).

What the vocabulary does *not* give you is one path per concept. Temperature arrives as
`temperature`, `air.temperature`, `soil.temperature`, `leaf.temperature`, or
`water.temperature.current` depending on the sensor; a level is `tank.level`,
`tank.volume`, `water.level`, or `linear.position`. A check that knew only one of those
would silently ignore most of a mixed fleet.

So `paths` is a **priority-ordered candidate list**. Per device, the first path present
in that device's telemetry is used; devices carrying none of them are ignored rather
than treated as zero. One entry covers the fleet:

```json
{ "rule": "measurement-threshold", "as": "frost-risk", "severity": "critical",
  "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],
              "min": 1.5, "unit": "C", "clearMargin": 1 } }
```

A weather station matches `air.temperature`, a bare temperature probe falls through to
`temperature`, and a soil-only node is skipped. The alert's `detail.measurement`
records which path actually matched, so you can tell them apart afterwards.

Resolution happens in SQL — candidate paths arrive as one JSONB parameter, unnested
`WITH ORDINALITY`, so priority is `ORDER BY ord` and no SQL is assembled by string
concatenation.

### Scoping a check to part of the fleet

For most checks the candidate path *is* the scope: a `pressure.gauge` threshold only
ever matches a pressure sensor, because nothing else emits that path. No configuration
needed.

That breaks down for the fields every device reports — `battery` above all. Nearly every
category in the vocabulary provides it, but the sensible threshold is per hardware
family: a Makerfabs AgroSense light sensor operates normally at 2.85 V, while a
pipe-pressure node runs 3.6–4.0 V. One fleet-wide threshold either cries wolf on the
first or stays silent until the second is dead.

Every check therefore accepts two optional filters:

| Param | Effect |
|---|---|
| `deviceProfiles` | Exact ChirpStack `device_profile_name` values. Empty = all profiles |
| `deviceNamePattern` | SQL `LIKE` against `device_name`, e.g. `%pump%`. null = all devices |

```json
{ "rule": "battery-low", "as": "battery-low-light",
  "params": { "raiseAtVolts": 2.8, "clearAtVolts": 2.95,
              "deviceProfiles": ["makerfabs-light-intensity"] } }
```

Distinct `as` names mean the families raise and resolve independently. The same applies
to `device-silent`, where reporting intervals differ by family — a 5-minute pressure
logger and an hourly soil probe cannot share a silence threshold.

### Choosing between the measurement checks

The distinction that matters most is **latest reading vs. window**:

| Question | Check |
|---|---|
| Is it out of bounds right now? | `measurement-threshold` |
| Did it ever cross the line? | `measurement-peak` |
| Is it heading somewhere bad? | `measurement-rate` |

Wind is the clearest case. A station reporting 10-minute averages can hide a 21 m/s
gust completely — `measurement-threshold` sees calm, `measurement-peak` sees the gust.
Conversely a tank at 40 % passes every threshold while falling 9 %/h, which only
`measurement-rate` catches, and only `measurement-rate` gives you the hours of warning
that make it actionable.

## How alerts behave

An alert is *raised* when a check first reports a device, *held open* while the check
keeps reporting it, and *resolved* when it stops.

- **Deduplication.** A partial unique index allows at most one open alert per
  `(dev_eui, kind)`. A sensor oscillating around a threshold cannot produce more
  than one alert, so it cannot produce repeated notifications.
- **Only new alerts notify.** An alert open across a hundred soundings is delivered
  once.
- **Resolution is a timestamp, not a delete.** History stays queryable.
- **A failing check resolves nothing.** If a query errors, there is no evidence the
  breach ended, so open alerts are left untouched and the failure is recorded in
  `leadsman.run`.

Hysteresis is available where thresholds are involved — `battery-low` takes separate
raise and clear voltages, `measurement-threshold` takes a `clearMargin` — so a value
sitting on a boundary does not flap.

## Reading alerts

```sql
SELECT kind, dev_eui, device_name, severity, summary, raised_at
  FROM leadsman.open_alert
 ORDER BY raised_at DESC;
```

`leadsman.open_alert` is the read surface; query it rather than filtering
`leadsman.alert` yourself. `leadsman.run` records every check execution with
duration and outcome, which is where a slow query or a silently erroring check
shows up.

Migration 001 grants `SELECT` on the `leadsman` schema to the stack's existing
`events_api` role, so adding `'leadsman'` to the PostGraphile `schema` list in
`events-api/.postgraphilerc.js` exposes alerts over the existing read-only GraphQL
endpoint with no new credentials.

## Notification

Set `notify.webhookUrl` and Leadsman POSTs once per newly-raised alert, then stamps
`notified_at`. A failed POST leaves the alert unstamped, so the next sounding retries
it — there is no separate retry queue.

```json
{ "schema": "leadsman.alert/1", "id": "12", "rule": "battery-low",
  "kind": "battery-low", "devEui": "a84041000181d9e2", "deviceName": "soil-north-01",
  "severity": "critical", "summary": "soil-north-01 battery 3.2V (raise <=3.4V, clear >3.55V)",
  "detail": { "value": 3.2, "raiseAtVolts": 3.4 }, "raisedAt": "2026-08-06T12:00:00Z" }
```

Point it at your own sender, or at a Hermes webhook route. For routine threshold
alerts use a route with `deliver_only: true` — no model is invoked. Reserve
agent-invoking routes for alerts that genuinely need interpretation.

## Writing a check

Drop a module into `src/rules/` (or any directory named by `LEADSMAN_RULES_DIR`,
which lets deployment-specific checks live outside this repo). The filename must
match the `id`.

```ts
import type { Rule } from '@intelligent-farming/leadsman';
import { latestReadings, resolvePaths } from '@intelligent-farming/leadsman';

const rule: Rule = {
  id: 'tank-overflow',
  description: 'Flags tanks above their safe fill level.',
  defaultSeverity: 'critical',
  // Every parameter needs a default, and `paths` should list every vocabulary path
  // this concept can arrive on — see docs/vocabulary.md.
  defaultParams: { paths: ['tank.level', 'linear.position'], maxPercent: 95, lookbackHours: 6 },
  // `leadsman verify` checks these against the live database at startup.
  requires: [{ table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] }],

  async run(ctx) {
    const paths = resolvePaths(ctx.params, 'paths');
    // Resolves the first present path per device, guards the numeric cast, and skips
    // devices reporting none of the candidates.
    const readings = await latestReadings(ctx, paths, Number(ctx.params.lookbackHours));

    return readings
      .filter((r) => r.value > Number(ctx.params.maxPercent))
      .map((r) => ({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary: `${r.deviceName ?? r.devEui} ${r.matchedPath} at ${r.value}%`,
        detail: { measurement: r.matchedPath, value: r.value },
      }));
  },
};

export default rule;
```

Conventions that matter:

- **Return current state, not events.** The engine owns raise/resolve. A check that
  tries to remember what it already reported will fight the reconciler.
- **Use the resolver helpers** (`latestReadings`, `windowStats`, `latestBooleans`,
  `pathPresence`, `latestCoordinates`) rather than hand-writing the path lookup. They
  keep priority order, the numeric guard, and ignore-unmatched-devices identical
  across every check.
- **Aggregate in SQL.** Bound every query by time and let Postgres do the work.
  Returning thousands of rows to filter in TypeScript defeats the design.
- **Parameterize everything.** Never interpolate into SQL. Use `#>>` with a
  `text[]` path for JSONB access.
- **Guard numeric casts.** A codec emitting `"3.7V"` should not abort a sounding —
  see the `~ '^-?[0-9]+(\.[0-9]+)?$'` guard in the bundled checks.
- **Declare `requires`.** It is what turns a schema mismatch into a `verify` message
  instead of a 3am SQL error.
- **Use `ctx.openDevEuis` for hysteresis** rather than storing state.

## Deployment

Leadsman is designed to run beside
[intelligent-farming-stack](https://github.com/intelligent-farming/intelligent-farming-stack),
reading its `events-postgres`. See [`docs/stack-fragment.yml`](docs/stack-fragment.yml)
for the compose service to add there, plus the one-time role and index setup.

`docker-compose.yml` in this repo is for development only — it brings up a throwaway
Postgres with no ChirpStack writing to it, so `verify` will correctly report the
`event_*` tables missing. Use it to work on the engine; use the real stack to work
on check SQL.

Two operational notes for constrained hardware:

- **Leadsman reads five event tables**, not just `event_up`: also `event_log`,
  `event_status`, `event_join`, and `event_ack`. All are created by ChirpStack's
  PostgreSQL integration in the same database, so nothing extra is needed — but
  `leadsman verify` will report any that a given ChirpStack version does not create.
- **Index the event tables.** ChirpStack creates `event_*` with a primary-key index
  only. Every check filters by `time` and groups by `dev_eui`, so without indexes
  each sounding is a sequential scan. `migrations/002_event_indexes.sql` adds them,
  gated behind `LEADSMAN_APPLY_EVENT_INDEXES=true` because it alters
  ChirpStack-owned tables.
- **Checks run sequentially, and overlapping soundings are skipped.** On a device
  that also runs ChirpStack and Postgres, a fan-out of concurrent aggregate queries
  is how a monitor starts degrading the thing it monitors.

### Roles

Two roles, deliberately separate:

| Role | Rights | Used by |
|---|---|---|
| `leadsman` | `SELECT` on `public`, `INSERT`/`UPDATE` on `leadsman` | the engine |
| owner (`events`) | DDL | `leadsman migrate` only |

The engine cannot create schemas, and cannot modify or delete ChirpStack's data.
`migrations/010_leadsman_role.sh` creates the engine role and follows the same
pattern as the stack's own `010_events_roles.sh`, so it can be dropped into
`postgresql/events-initdb/`.

## Environment

| Variable | Purpose |
|---|---|
| `LEADSMAN_DATABASE_URL` | Postgres URL for the engine role. Required |
| `LEADSMAN_MIGRATE_URL` | Owner-role URL, used by `migrate`. Falls back to the above |
| `LEADSMAN_CONFIG` | Config path. Default `config/leadsman.json` |
| `LEADSMAN_RULES_DIR` | Extra directory of operator-supplied checks |
| `LEADSMAN_WEBHOOK_TOKEN` | Bearer token for `notify.webhookUrl` |
| `LEADSMAN_APPLY_EVENT_INDEXES` | `true` lets `migrate` apply migration 002 |
| `LEADSMAN_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. Default `info` |
| `LEADSMAN_LOG_FORMAT` | `json` \| `text`. Default `json` |

## Tests

```sh
npm test        # smoke suite — no database needed
npm run test:db # resolver + engine — requires a scratch Postgres
npm run test:all
```

Three layers, because they catch different things:

| Suite | Needs a DB | Covers |
|---|---|---|
| `test/smoke.js` | no | Config validation, check discovery, the `Rule` contract, param and scope coercion, CLI exit codes, and that every rule runs on its own defaults |
| `test/resolver.js` | yes | The five multi-path resolvers and the device-scope filter, each against the smallest event store that can distinguish the behaviour |
| `test/engine.js` | yes | The alert lifecycle, the runner's failure handling, the notifier, migration idempotency, and `statement_timeout` |
| `test/integration.js` | yes | 26 seeded faults plus 4 healthy controls across the vocabulary, end to end |
| `test/makerfabs.js` | yes | The shipped per-device config, against payload shapes from each codec's `vectors.json` |

**The SQL is the part worth testing.** Almost everything load-bearing here is a query:
path priority, the numeric guard, `first`/`last` ordering, the partial unique index that
deduplicates. A mock cannot exercise `WITH ORDINALITY`, lateral joins, or JSONB path
operators, so the database-backed suites use a real server and skip cleanly without one.

Two properties are worth calling out because getting them wrong is quiet rather than
loud, and both now have dedicated tests:

- **A failing check resolves nothing.** If a query errors there is no evidence the
  breach ended, so open alerts are left untouched. Without this, a database hiccup reads
  as a healthy fleet.
- **A failed delivery leaves `notified_at` NULL.** That is the retry mechanism — there
  is no separate queue — so the next sounding picks it up.

To run the database-backed suites locally:

```sh
docker run -d --name leadsman-test -p 5439:5432 \
  -e POSTGRES_USER=events -e POSTGRES_PASSWORD=test -e POSTGRES_DB=chirpstack_events \
  postgres:16-alpine

export LEADSMAN_TEST_DATABASE_URL=postgres://events:test@127.0.0.1:5439/chirpstack_events
npm run test:db
```

Each test file creates and drops its own scratch database, so the files are safe to run
concurrently — every case truncates `event_up`, and sharing one database means one file
wipes another's fixtures mid-test. The role therefore needs `CREATEDB`; the error says so
if it does not have it.

The two fixture-driven suites (`integration.js`, `makerfabs.js`) expect `leadsman migrate`
and one `leadsman run` to have happened first — see the `integration` job in
`.github/workflows/ci.yml` for the exact sequence.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
