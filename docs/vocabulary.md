<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Intelligent Farming Foundation -->

# Normalized measurement vocabulary

Every path a Leadsman check can be pointed at, and which check to use for it.

Generated from `definitions/vocabulary.schema.json` in
[@intelligent-farming/lorawan-codec-normalization](https://github.com/intelligent-farming/lorawan-codec-normalization)
— regenerate with `node scripts/gen-vocabulary-doc.js > docs/vocabulary.md`.

**Units are guaranteed.** Any device whose profile carries a normalized codec emits
these paths in these units regardless of vendor, which is why the shipped checks can
have meaningful default thresholds. A device on an upstream (non-normalized) codec
will not match these paths at all — it is ignored rather than misread, and
`measurement-missing` is what tells you it happened.

## Beyond `event_up`

Everything below describes the decoded `object` in `event_up`. Five checks read other
ChirpStack tables instead, where the fields are columns rather than vocabulary paths and
so take no `paths` parameter:

| Check | Table | Columns it reads |
|---|---|---|
| `device-log-error` | `event_log` | `level`, `code`, `description` |
| `status-battery-low` | `event_status` | `battery_level`, `battery_level_unavailable`, `external_power_source` |
| `status-margin-low` | `event_status` | `margin` |
| `join-churn` | `event_join` | `dev_addr` (plus `event_up` for the uplink ratio) |
| `downlink-unacked` | `event_ack` | `acknowledged`, `f_cnt_down` |

`event_status.battery_level` is worth singling out: it is a battery percentage from the
LoRaWAN MAC layer, so it works on a device whose payload codec emits nothing at all.

## Multi-path resolution

One concept often spans several paths, because which one a device emits depends on
what kind of sensor it is. Every check therefore takes a **priority-ordered list**,
resolves the first path present *per device* — in the newest uplink that carries any
candidate — and ignores devices carrying none of them. So a single entry covers a mixed fleet:

```json
{ "rule": "measurement-threshold", "as": "frost-risk",
  "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],
              "min": 1.5, "unit": "C" } }
```

`measurement-implausible` enforces the **Range** column in the tables below. It is not configured per
path: one config entry covers all 73 paths that carry a declared bound, reading them
straight from the vocabulary schema. It is named in the Checks column wherever that
column lists other checks, but its coverage is the Range column itself rather than that
list — a path with a range is checked whether or not it is annotated here.

Groupings worth knowing, since these are the ones that bite if you only list one:

| Concept | Candidate paths, in a sensible priority order |
|---|---|
| Temperature | `air.temperature`, `temperature`, `soil.temperature`, `leaf.temperature`, `water.temperature.current` |
| Level / fill | `tank.level`, `tank.volume`, `water.level`, `tank.distance`, `linear.position`, `analog.ratio` |
| Supply voltage | `battery`, `power.voltage`, `analog.voltage` |
| Moisture / wetness | `soil.moisture`, `leaf.wetness`, `air.relativeHumidity` |
| Canopy wetness, for a disease model | `leaf.wetness`, `air.relativeHumidity` — one band cannot serve both, so give each its own `mold-risk` entry |
| Accumulation inputs | `air.temperature` (degree days), `air.par` (light integral), `rain.intensity` (rainfall) — all via `measurement-accumulation`, and note `method` differs between a rate and a per-report quantity |
| Pressure | `pressure.gauge`, `pressure.absolute`, `water.pressure`, `air.pressure`, `pressure.differential` |
| Cumulative total | `metering.water.total`, `metering.energy.total`, `pulse.total`, `device.runtime` |
| Asserted flag | `water.leak`, `air.gasAlarm`, `action.smoke.detected`, `action.motion.detected`, `action.switch.state`, `action.contactState` |
| Vibration | `vibration.velocityRms`, `vibration.accelerationRms`, `vibration.accelerationPeak` |

## All paths (104)

### `time`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `time` | string | RFC3339 | — | — |

### `battery`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `battery` | number | V | ≥ 0 | `battery-low`, `measurement-threshold`, `measurement-implausible` |

### `temperature`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `temperature` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `mold-risk` (as the gate), `measurement-implausible`, `measurement-derived` |

### `tank`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `tank.distance` | number | m | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `tank.level` | number | % | ≥ 0, ≤ 100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `tank.volume` | number | L | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |

### `soil`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `soil.depth` | number | cm | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `soil.moisture` | number | % | ≥ 0, ≤ 100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible`, `soil-deficit-band` |
| `soil.temperature` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `soil.ec` | number | dS/m | ≥ 0, ≤ 621 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `soil.pH` | number | — | ≥ 0, ≤ 14 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `soil.n` | number | ppm | ≥ 0, ≤ 1000000 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `soil.p` | number | ppm | ≥ 0, ≤ 1000000 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `soil.k` | number | ppm | ≥ 0, ≤ 1000000 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |

### `air`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `air.location` | string | — | `indoor`, `outdoor` | — |
| `air.temperature` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `mold-risk` (as the gate), `measurement-implausible`, `measurement-derived` |
| `air.relativeHumidity` | number | % | ≥ 0, ≤ 100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `mold-risk`, `measurement-implausible`, `measurement-derived` |
| `air.pressure` | number | hPa | ≥ 300, ≤ 1100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.co2` | number | ppm | ≥ 0, ≤ 1000000 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.lightIntensity` | number | lux | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.pm1_0` | number | µg/m³ | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.pm2_5` | number | µg/m³ | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.pm10` | number | µg/m³ | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.tvoc` | number | ppb | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.iaqIndex` | number | 0-500 | ≥ 0, ≤ 500 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.solarIrradiance` | number | W/m² | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.par` | number | µmol/m²/s | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `air.gasAlarm` | boolean | — | — | `boolean-alarm` |

### `wind`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `wind.speed` | number | m/s | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `wind.direction` | number | ° | ≥ 0, < 360 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |

### `rain`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `rain.intensity` | number | mm/hour | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `rain.cumulative` | number | mm | ≥ 0 | `counter-spike`, `measurement-missing`, `measurement-implausible` |

### `water`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `water.leak` | boolean | — | — | `boolean-alarm` |
| `water.temperature.min` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.temperature.max` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.temperature.avg` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.temperature.current` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.level` | number | m | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.pressure` | number | kPa | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.ec` | number | µS/cm | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.ph` | number | — | ≥ 0, ≤ 14 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.turbidity` | number | NTU | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.residualChlorine` | number | mg/L | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.dissolvedOxygen` | number | mg/L | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `water.orp` | number | mV | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |

### `metering`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `metering.water.total` | number | L | ≥ 0 | `counter-stalled`, `counter-spike`, `measurement-implausible` |
| `metering.energy.total` | number | Wh | ≥ 0 | `counter-stalled`, `counter-spike`, `measurement-implausible` |

### `action`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `action.motion.detected` | boolean | — | — | `boolean-alarm` |
| `action.motion.count` | number | count | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `action.contactState` | string | — | `open`, `closed` | `boolean-alarm` |
| `action.occupancy.occupied` | boolean | — | — | `boolean-alarm` |
| `action.occupancy.duration` | number | s | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `action.button.pressed` | boolean | — | — | `boolean-alarm` |
| `action.button.event` | string | — | `single`, `double`, `triple`, `long`, `hold`, `release` | — |
| `action.button.count` | number | count | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `action.smoke.detected` | boolean | — | — | `boolean-alarm` |
| `action.switch.state` | boolean | — | — | `boolean-alarm` |

### `pressure`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `pressure.gauge` | number | kPa | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `pressure.absolute` | number | kPa | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `pressure.differential` | number | Pa | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |

### `vibration`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `vibration.velocityRms` | number | mm/s | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `vibration.accelerationRms` | number | g | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `vibration.accelerationPeak` | number | g | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `vibration.peakFrequency` | number | Hz | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `vibration.accelerationX` | number | g | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `vibration.accelerationY` | number | g | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `vibration.accelerationZ` | number | g | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `vibration.velocityX` | number | mm/s | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `vibration.velocityY` | number | mm/s | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `vibration.velocityZ` | number | mm/s | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |

### `tilt`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `tilt.angle` | number | ° | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `tilt.x` | number | ° | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `tilt.y` | number | ° | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `tilt.z` | number | ° | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |

### `power`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `power.voltage` | number | V | ≥ 0 | `battery-low`, `measurement-threshold`, `measurement-implausible` |
| `power.current` | number | A | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `power.active` | number | W | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `power.apparent` | number | VA | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `power.factor` | number | -1..1 | ≥ -1, ≤ 1 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `power.frequency` | number | Hz | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |

### `leaf`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `leaf.wetness` | number | % | ≥ 0, ≤ 100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `mold-risk`, `measurement-implausible` |
| `leaf.temperature` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `mold-risk` (as the gate), `measurement-implausible`, `measurement-derived` |

### `device`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `device.runtime` | number | s | ≥ 0 | `counter-stalled`, `counter-spike`, `measurement-implausible` |

### `position`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `position.latitude` | number | ° | ≥ -90, ≤ 90 | `geofence-breach`, `measurement-implausible` |
| `position.longitude` | number | ° | ≥ -180, ≤ 180 | `geofence-breach`, `measurement-implausible` |

### `analog`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `analog.current` | number | mA | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `analog.voltage` | number | V | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `analog.ratio` | number | % | ≥ 0, ≤ 100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `analog.raw` | number | — | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |

### `pulse`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `pulse.count` | number | count | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `pulse.total` | number | count | ≥ 0 | `counter-stalled`, `counter-spike`, `measurement-implausible` |

### `people`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `people.in` | number | count | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `people.out` | number | count | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `people.total` | number | — | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `people.present` | number | count | ≥ 0 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |

### `hvac`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `hvac.setpoint` | number | °C | ≥ -273.15 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `hvac.valvePosition` | number | % | ≥ 0, ≤ 100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `hvac.mode` | string | — | — | — |

### `sound`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `sound.level` | number | dB | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `sound.peak` | number | dB | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |

### `plant`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `plant.dendrometer` | number | µm | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |
| `plant.sapFlow` | number | g/h | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |

### `linear`

| Path | Type | Unit | Range | Checks |
|---|---|---|---|---|
| `linear.position` | number | % | ≥ 0, ≤ 100 | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck`, `measurement-implausible` |
| `linear.displacement` | number | mm | — | `measurement-threshold`, `measurement-peak`, `measurement-rate`, `measurement-stuck` |

## Device categories (37)

`requires` is what a device in the category always emits; `provides` is what it may
also emit. Use these to decide which paths to list in a check that should cover a
whole category.

| Category | Always | May also |
|---|---|---|
| air-quality | `air.co2` | `air.temperature`, `air.relativeHumidity`, `air.pressure`, `battery` |
| analog-interface | — | `air.temperature`, `battery` |
| button | — | `battery` |
| climate | `air.temperature`, `air.relativeHumidity` | `air.pressure`, `air.co2`, `battery` |
| contact | `action.contactState` | `action.motion.count`, `battery` |
| dendrometer | `plant.dendrometer` | `air.temperature`, `battery` |
| differential-pressure | `pressure.differential` | `air.temperature`, `battery` |
| gas-detector | `air.gasAlarm` | `air.temperature`, `battery` |
| gps-tracker | `position.latitude`, `position.longitude` | `battery` |
| groundwater | — | `water.temperature.current`, `water.ec`, `battery` |
| leaf-wetness | `leaf.wetness` | `leaf.temperature`, `air.temperature`, `battery` |
| light | `air.lightIntensity` | `battery` |
| linear-position | — | `air.temperature`, `battery` |
| motion | `action.motion.*` | `action.motion.detected`, `action.motion.count`, `battery` |
| occupancy | `action.occupancy.occupied` | `action.occupancy.duration`, `air.temperature`, `battery` |
| particulate | — | `air.temperature`, `air.relativeHumidity`, `battery` |
| people-counter | — | `air.temperature`, `battery` |
| power-meter | — | `power.frequency`, `power.factor`, `power.apparent`, `battery` |
| process-pressure | — | `air.temperature`, `battery` |
| rain-gauge | `rain.cumulative` | `rain.intensity`, `battery` |
| runtime-meter | `device.runtime` | `battery` |
| sap-flow | `plant.sapFlow` | `air.temperature`, `battery` |
| smoke-detector | `action.smoke.detected` | `battery` |
| soil-monitor | — | `soil.ec`, `soil.pH`, `soil.n`, `soil.p`, `soil.k`, `soil.depth`, `battery`, `air.temperature` |
| solar-radiation | — | `air.temperature`, `battery` |
| sound-level | — | `battery` |
| switch | `action.switch.state` | `air.temperature`, `power.active`, `battery` |
| tank-level | — | `air.temperature`, `battery` |
| temperature | `temperature` | `battery` |
| thermostat | — | `air.temperature`, `air.relativeHumidity`, `battery` |
| tilt | — | `battery` |
| vibration | — | `vibration.peakFrequency`, `air.temperature`, `battery` |
| water-leak | `water.leak` | `water.temperature.current`, `battery` |
| water-meter | `metering.water.total` | `water.temperature.current`, `battery` |
| water-quality | — | `water.temperature.current`, `water.ec`, `battery` |
| weather-station | `air.temperature`, `air.pressure` | `air.relativeHumidity`, `air.lightIntensity`, `wind.speed`, `wind.direction`, `rain.intensity`, `rain.cumulative`, `battery` |
| wind | `wind.speed` | `wind.direction`, `battery` |

