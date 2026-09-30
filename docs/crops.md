<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Intelligent Farming Foundation
-->

# Crop packs

Per-crop check sets in `config/crops/`, built from the bundled checks. Each file is a
complete config: it carries the four fleet-health checks (`device-silent`,
`decode-failure`, `measurement-implausible`, `status-battery-low`) so it runs on its own,
followed by the crop's agronomic checks.

Thresholds come from published sources — university extension, UC IPM and, for the
disease infection curves, the controlled-environment studies those figures rest on —
cited with their URL in the entry's `//` comment. A few rest on weaker ground, and their
comments say so: a figure no UC document gives numerically (olive fruit freeze at
−1.7 °C, from a non-UC source that cites the UC manual), an upper pH limit no
crop-specific source gives (cotton, citrus), and infection curves measured on one host
applied to its relatives (brown rot, from cherry blossoms). Where a source gives no
number, or gives a range the check needs narrowed, the entry states the choice this pack
made or leaves the alert out.

Where a disease's wetness requirement depends on temperature (brown rot, peacock spot),
the entry carries the published curve as a `mold-risk` `curve` of bands, each held to
the longest requirement anywhere inside it, and counts a wet period by rate summation —
each wet hour adds 1 / (hours needed at that temperature), and the alert raises at
100 %. No band alerts on less wetness than the source needs, and a night whose
temperature drifts across a band edge stays one run. Olive peacock spot also bridges dry
spells of up to 12 h (`maxDryHours`); brown rot, with no data on dry breaks, does not.

## Using a pack

1. Copy the pack to your config location.
2. **Set the scope.** Every agronomic entry carries a placeholder `deviceNamePattern`
   (`%almond%`, `%vineyard%`, `%bin%`, …). Rename devices to match, or replace the
   pattern with `deviceProfiles`. A crop threshold applied to the whole fleet raises on
   every thermometer on the site; `test/smoke.js` rejects a pack entry without a scope.
   The exception is `forecast-threshold` entries (frost-tonight forecasts): a forecast is
   for the site's coordinates, not a device, so they take no scope and `test/smoke.js`
   exempts them.
3. **Shift `activeMonths`.** Stage timing is approximated by month for the region named in
   each file's `//months` note. Every month-gated entry sets `resolveOutOfSeason`, so a
   stage alert closes when its months end instead of staying open until next year.
4. **Enable the disabled entries once calibrated** (below).
5. `leadsman lint --config <file>`, then `leadsman run --dry-run`.

To run several crops on one site, merge the `checks` arrays and keep one copy of the
fleet-health entries. `as` names are unique across packs, so merged entries do not
collide. Watch `maxChecksPerRun` (default 64 enabled checks).

### What ships enabled

Enabled: checks whose threshold is a figure the sensor measures directly — air, leaf and
soil temperature, relative humidity, durations, rates, pH.

Disabled, with what to set in the entry's comment:

| Entry type | Why | What to set |
|---|---|---|
| Soil salinity (`soil.ec`) | Maas–Hoffman thresholds are saturated-paste ECe; probes report bulk or pore EC. FAO 29: soil-water EC ≈ 2 × ECe at field capacity, and bulk EC is lower than pore EC and moves with water content | Scale by the ratio of probe reading to a lab ECe taken beside it |
| Soil moisture bands, saturation, dry root zone | Volumetric moisture at field capacity, saturation and management-allowed depletion is specific to the soil | The probe's reading at those points in this soil |
| Leaf-wetness cut-offs | A `leaf.wetness` percentage means different things on different sensors | The sensor's dry/wet boundary |
| Hull-split deficit (almond) | UC targets are stem water potential, which no codec emits | Soil moisture paired with pressure-chamber readings at −14 and −18 bar |
| Soil nitrogen (`soil.n`) | An in-situ probe does not measure what a lab LSNT on a dried core measures | Check against lab tests on the field |
| Biofix and planting-date degree-days (navel orangeworm, codling moth, corn GDD) | The count starts on a date observed in the field each year | `since` as `YYYY-MM-DD`: the trap biofix, or the planting date; corn also the hybrid's GDD rating |
| Wallin late-blight severity values (tomato, potato) | Accumulation starts at plant emergence, observed in the field | `since` as `YYYY-MM-DD`: the emergence date |
| Per-variety chill (peach, cherry) | Requirements vary more by variety than by crop | `requirement` for the block's variety |
| `forecast-threshold` entries | Need the top-level `forecast` block and a Weatherbit key | See README, [Forecast](../README.md#forecast) |

## Packs

| File | Crops | Timezone | Checks (enabled) |
|---|---|---|---|
| `permanent-almond.example.json` | Almond | America/Los_Angeles | 16 (12) |
| `permanent-walnut-pistachio.example.json` | Walnut, pistachio | America/Los_Angeles | 13 (11) |
| `permanent-grape.example.json` | Wine grape | America/Los_Angeles | 16 (13) |
| `permanent-citrus.example.json` | Orange, mandarin, lemon | America/Los_Angeles | 10 (7) |
| `permanent-olive.example.json` | Olive | America/Los_Angeles | 11 (10) |
| `permanent-stone-fruit.example.json` | Peach, nectarine, sweet cherry, apricot | America/Los_Angeles | 18 (14) |
| `row-corn.example.json` | Field corn, popcorn, stored grain | America/Chicago | 20 (14) |
| `row-soy-wheat.example.json` | Soybean, winter wheat | America/Chicago | 20 (16) |
| `row-cotton-alfalfa.example.json` | Cotton, alfalfa | America/Chicago | 14 (11) |
| `veg-tomato-potato.example.json` | Tomato, potato | America/Los_Angeles | 22 (14) |
| `veg-lettuce.example.json` | Lettuce | America/Los_Angeles | 9 (7) |
| `veg-strawberry.example.json` | Strawberry | America/Los_Angeles | 11 (8) |

What each pack covers:

| Pack | Freeze / frost | Disease | Heat | Soil and water | Other |
|---|---|---|---|---|---|
| Almond | By stage: pink bud, full bloom, 30-min crop-loss dwell, small nut | Brown rot (five-band infection curve), shot hole | – | Hull-split deficit, salinity | Navel orangeworm flights; chill portions short and met |
| Walnut / pistachio | – | Walnut blight (two wetness bands), Alternaria late blight | Walnut sunburn | Pistachio salinity | Codling moth spray timing; walnut and pistachio chill portions; pistachio chill hours |
| Grape | By stage: swollen bud, budburst, leaf-out | Gubler-Thomas powdery mildew index, downy mildew 10:10:24 rain, botrytis | Heatwave (3 days above 40 °C; 3 days at 35 °C disabled) | Salinity, pH | Winkler region boundaries |
| Citrus | 4-hour fruit freeze, wind-machine start | – | – | Orange and lemon salinity, pH | – |
| Olive | Fruit, small-wood and tree freeze | Peacock spot (five-band infection curve, bridging 12 h dry spells), anthracnose | – | pH | – |
| Stone fruit | 10 % and 90 % kill at bloom, per species | Brown rot, per species (five-band infection curve) | – | Peach salinity | Per-variety chill portions |
| Corn | Seedling freeze dwell, leaf frost, fall killing freeze | – | Silking heat, pollen kill | Planting soil temperature, dry root zone, saturation (cool and warm), N | GDD staging from planting; grain warming trend, summer ceiling, winter cooling |
| Soy / wheat | Soy frost and killing freeze; wheat by stage from tillering to grain fill | White mold, Fusarium head blight | – | Flooding, salinity, pH | Wheat vernalization shortfall |
| Cotton / alfalfa | – | – | Boll-shed heat, hot nights | Planting soil temperature, salinity, pH | Cool-spell DD60; alfalfa weevil scouting by degree-days |
| Tomato / potato | – | Late blight Smith Period on 09:00 days (Hutton variant disabled), Wallin severity values (disabled until emergence is set), TOM-CAST spray points | Fruit-set hot days, hot nights, cold nights; potato soil heat | Uneven moisture (blossom-end rot), scab pH, salinity, pH | – |
| Lettuce | – | Downy mildew (UC wet-at-10:00-standard-time rule) | Heat stress, bolting | Salinity, pH | – |
| Strawberry | Sprinkler start, blossom freeze | Gray mold (RH and leaf-wetness variants) | – | Salinity, pH | – |

## Sensors each pack needs

Paths are the normalized vocabulary from
[@intelligent-farming/lorawan-codec-normalization](https://github.com/intelligent-farming/lorawan-codec-normalization).
Device counts are codecs in that package emitting the path.

| Path | Used for | Example codecs |
|---|---|---|
| `air.temperature`, `air.relativeHumidity` | Freeze, heat, every humidity-based disease entry | Any `climate` or `weather-station` codec (≈ 300 climate devices) |
| `temperature` | Fallback for bare temperature probes | `temperature` category (57) |
| `leaf.temperature` | Strawberry sprinkler start and blossom freeze (plant-level figure); disease temperature gates | decentlab/dl-ilt, dragino/llms01, dragino/lms01-lb, makerfabs/leaf-moisture-sn-3001 |
| `leaf.wetness` | Lettuce downy mildew, strawberry gray mold (wetness variant), tomato TOM-CAST (wetness variant) | decentlab/dl-lws, dragino/llms01, dragino/lms01-lb, makerfabs/leaf-moisture-sn-3001 |
| `soil.temperature` | Planting windows, potato tuber heat, warm-ponding gate | 29 codecs, e.g. dragino/lse01, milesight-iot/em500-smtc, sensecap S2105 |
| `soil.moisture` | Saturation, dry root zone, deficit bands | 27 codecs |
| `soil.ec` | Salinity | 16 codecs, e.g. dragino/lse01, decentlab/dl-trs12, makerfabs/soil-monitor |
| `soil.pH` | pH bands, potato scab | dragino/lsph01, dragino/sph01-lb, makerfabs/soil-monitor, rakwireless/rak2560, decentlab/dl-pheht |
| `soil.n` | Corn N (indicative) | dragino/lsnpk01, netvox/r72632a01 |
| `rain.intensity` | Grape downy mildew rain total | 15 codecs |
| `channels.N.temperature` | Grain cable positions | smartrural/grain-probe-01 |

### Reading `channels[]` positionally

Multi-position devices (grain cables, depth-profile soil probes such as decentlab/dl-smtp
and dragino/se0x-lb) report one object per position in the reserved `channels[]` array. A
path segment that is a number indexes that array — `channels.0.temperature` is Postgres
`object #>> '{channels,0,temperature}'` — so each position can be a check of its own
today. The index is positional, not the `channel` label: if a codec ever omits an entry,
later positions shift.

### Vendor extras

A `paths` entry may name a field outside the vocabulary. Several agronomic readings exist
only that way, under vendor-specific names and without guaranteed units:

| Reading | Extra field names | Devices |
|---|---|---|
| Solar radiation, W/m² | `solarRadiation` | decentlab/dl-atm41, dl-atm41g2, all mcf88/enginko MCF-LWWS and LW06DAV* |
| Daily evapotranspiration, mm | `dayEvapotranspiration`, `evapotranspirationDay`, `dailyEvapotranspiration`, `evapotranspiration`, `dayET` | mcf88/enginko stations |
| Soil water potential, kPa | `soilWaterPotential` | decentlab/dl-trs21, cital/lorasoil |
| Tensiometer, cbar | `soilMoistureCentibar`, `soilMoistureChannels` | mcf88/mcf-lw06davk, mcf-lwws03 |

`measurement-implausible` has no bounds for extras, so a scaling bug in one goes
unreported.

## Reference tables

### Salt tolerance (Maas–Hoffman)

ECe threshold (dS/m) above which yield declines, and the yield loss per dS/m beyond it.
Source: FAO Irrigation and Drainage Paper 29, Annex 1 (Maas & Grattan 1999),
<https://www.fao.org/4/y4263e/y4263e0e.htm>.

| Crop | Threshold | Slope (%/dS/m) | Crop | Threshold | Slope (%/dS/m) |
|---|---|---|---|---|---|
| Strawberry | 1.0 | 33 | Corn (and popcorn) | 1.7 | 12 |
| Bean | 1.0 | 19 | Potato | 1.7 | 12 |
| Onion | 1.2 | 16 | Peach | 1.7 | 21 |
| Lettuce | 1.3 | 13 | Alfalfa | 2.0 | 7.3 |
| Orange | 1.3 | 13.1 | Tomato | 2.5 | 9.9 |
| Almond | 1.5 | 19 | Soybean | 5.0 | 20 |
| Grape | 1.5 | 9.6 | Wheat | 6.0 | 7.1 |
| Lemon | 1.5 | 12.8 | Cotton | 7.7 | 5.2 |
| Pistachio (UC small-plot) | 9.4 | 8.4 | Sorghum | 6.8 | 16 |

FAO 29 Table 4 lists orange at 1.7; Maas & Grattan 1999 give 1.3. Walnut is rated
sensitive and olive moderately tolerant, without numeric thresholds.

### Management-allowed depletion

FAO-56 Table 22 depletion fraction *p* at ETc ≈ 5 mm/day — the share of available water
the root zone can lose before stress. Adjust for demand: *p* = *p*<sub>table</sub> +
0.04 × (5 − ETc), limited to 0.1–0.8. Source: <https://www.fao.org/4/x0490e/x0490e0e.htm>.

| Crop | *p* | Crop | *p* | Crop | *p* |
|---|---|---|---|---|---|
| Strawberry | 0.20 | Almond | 0.40 | Wheat | 0.55 |
| Lettuce | 0.30 | Pistachio | 0.40 | Corn (grain) | 0.55 |
| Potato | 0.35 | Wine grape | 0.45 | Alfalfa | 0.55 |
| Table grape | 0.35 | Walnut | 0.50 | Olive | 0.65 |
| Tomato | 0.40 | Citrus, stone fruit, soybean | 0.50 | Cotton | 0.65 |

Set a `soil-deficit-band` floor to the probe's reading at *p* depletion between field
capacity and wilting point.

### TOM-CAST disease severity values

Leaf-wetness hours in a day, by mean temperature during wetness, for each daily DSV. UC
IPM's tomato black-mold program sprays at 12 DSV (susceptible varieties) or 18
(resistant); 15 is the Midwest default. Each spray point resets the count to zero: DSV
earned on the crossing day beyond the threshold does not carry into the next interval.
Source: UC IPM,
<https://ipm.ucanr.edu/DISEASE/DATABASE/tomatoblackmold.html>.

| Mean temperature | DSV 0 | DSV 1 | DSV 2 | DSV 3 | DSV 4 |
|---|---|---|---|---|---|
| 13–17 °C | 0–6 h | 7–15 | 16–20 | 21+ | – |
| 18–20 °C | 0–3 | 4–8 | 9–15 | 16–22 | 23+ |
| 21–25 °C | 0–2 | 3–5 | 6–12 | 13–20 | 21+ |
| 26–29 °C | 0–3 | 4–8 | 9–15 | 16–22 | 23+ |

### Wallin late-blight severity values

Hours at RH ≥ 90 % in a day, by mean temperature during them, for each daily severity
value. Accumulation starts at plant emergence; blight is predicted 7–14 days after 18–20
severity values, so the first spray is due at 18. After a spray point the count restarts
from zero; BLITECAST's rain-based matrix for later sprays is not implemented. Outside
7.2–26.6 °C a day earns nothing. Source: UC IPM,
<https://ipm.ucanr.edu/DISEASE/DATABASE/potatolateblight.html>.

| Mean temperature | SV 0 | SV 1 | SV 2 | SV 3 | SV 4 |
|---|---|---|---|---|---|
| 7.2–11.6 °C | 0–15 h | 16–18 | 19–21 | 22–24 | 25+ |
| 11.7–15.0 °C | 0–12 | 13–15 | 16–18 | 19–21 | 22+ |
| 15.1–26.6 °C | 0–9 | 10–12 | 13–15 | 16–18 | 19+ |

## Not covered yet

| Model | Why not |
|---|---|
| BLITECAST's later-spray matrix (US late blight) | Needs rainfall; the Wallin entries restart the count at each spray point instead |
| Broome botrytis index (UC IPM grape) | Not implemented; the grape pack raises on 4 h of near-saturation inside the model's temperature range |
| Bulger / Florida StAS strawberry infection index | The equation coefficients were not verified; the pack uses the ≥ 4 h wetness at 15–22 °C condition |
| Soybean white mold 30-day mean maximum (Sporecaster inputs) | Needs a 30-day rolling mean of the daily maximum |

Also not covered: rules for chlorophyll, NDVI, insect traps or grain moisture, which no
codec in the vocabulary emits.
