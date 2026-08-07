-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Intelligent Farming Foundation
--
-- Fixture for config/makerfabs-agrosense.example.json.
--
-- Two devices per AgroSense model: one healthy, one with a planted fault. Decoded
-- payload shapes are copied from each codec's vectors.json in
-- @intelligent-farming/lorawan-codec-normalization, so the paths and units here are
-- what the real devices actually emit — not what the model names imply.
--
--   SM  0001 healthy soil monitor        0002 dry + saline + root frost + stuck probe
--   TH  0011 healthy climate node        0012 frost overnight + high humidity
--   PP  0021 healthy pipe pressure       0022 pressure collapse to zero
--   L   0031 healthy light sensor        0032 fouled: daily peak never gets bright
--
-- Also exercises the per-family battery scoping: device 0032 sits at 2.85 V, which is
-- healthy for a light sensor but would breach the soil monitor's 3.3 V raise point.
-- If scoping is broken, that device raises battery-low-soil and the test fails.

CREATE TABLE IF NOT EXISTS event_up (
  deduplication_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time                timestamptz NOT NULL,
  dev_eui             text NOT NULL,
  device_name         text,
  device_profile_name text,
  f_cnt               bigint,
  object              jsonb,
  rx_info             jsonb
);
CREATE TABLE IF NOT EXISTS event_join   (time timestamptz, dev_eui text);
CREATE TABLE IF NOT EXISTS event_status (time timestamptz, dev_eui text);

TRUNCATE event_up;

CREATE OR REPLACE FUNCTION rx(rssi numeric DEFAULT -95, snr numeric DEFAULT 9.5)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS
$$ SELECT jsonb_build_array(jsonb_build_object('rssi', rssi, 'snr', snr)) $$;

-- ══ AGLWSM02 — makerfabs/soil-monitor ════════════════════════════════════════
-- Shape: {make, model, battery, soil:{moisture, temperature, ec, pH}, transmitInterval}

-- healthy: moisture mid-band and moving, EC low, pH in band, battery good
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000001', 'sm02-block-a', 'makerfabs-soil-monitor',
       jsonb_build_object('make','makerfabs','model','soil-monitor','battery', 3.55,
         'soil', jsonb_build_object('moisture', 30.0 + (g % 6) * 0.8,
                                    'temperature', 16.0 + (g % 5) * 0.3,
                                    'ec', 1.4 + (g % 4) * 0.05, 'pH', 6.6),
         'transmitInterval', 0.5), rx()
FROM generate_series(1, 24) g;

-- faulted: dry (9 %), saline (6.2 dS/m), root frost (0.4 C), and moisture frozen at a
-- constant — one device tripping four independent checks, which is realistic for a
-- probe that has been lifted out of the ground into cold air.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000002', 'sm02-block-b', 'makerfabs-soil-monitor',
       jsonb_build_object('make','makerfabs','model','soil-monitor','battery', 3.5,
         'soil', jsonb_build_object('moisture', 9.0, 'temperature', 0.4,
                                    'ec', 6.2, 'pH', 8.4),
         'transmitInterval', 0.5), rx()
FROM generate_series(1, 24) g;

-- ══ AGLWTH01 — makerfabs/air-temperature-and-humidity ════════════════════════
-- Shape: {make, model, battery, air:{temperature, relativeHumidity}}

-- healthy: mild, moderate humidity, no trend
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000011', 'th01-orchard-n', 'makerfabs-air-temperature-and-humidity',
       jsonb_build_object('make','makerfabs','model','air-temperature-and-humidity',
         'battery', 3.4,
         'air', jsonb_build_object('temperature', 17.0 + (g % 5) * 0.5,
                                   'relativeHumidity', 62.0 + (g % 6))), rx()
FROM generate_series(1, 30) g;

-- faulted: it dipped to -1.2 C six hours ago and has since recovered to 8 C, so a
-- latest-reading frost check sees nothing. Only the window minimum catches it.
-- Humidity is also pinned high (94 %) — fungal infection pressure.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000012', 'th01-orchard-s', 'makerfabs-air-temperature-and-humidity',
       jsonb_build_object('make','makerfabs','model','air-temperature-and-humidity',
         'battery', 3.35,
         'air', jsonb_build_object(
           'temperature', CASE WHEN g BETWEEN 17 AND 20 THEN -1.2 ELSE 8.0 + (g % 4) * 0.4 END,
           'relativeHumidity', 94.0 + (g % 3))), rx()
FROM generate_series(1, 30) g;

-- ══ AGLWPP01 — makerfabs/pipe-pressure ═══════════════════════════════════════
-- Shape: {make, model, battery, pressure:{gauge}, sampleCount, reportingInterval}

-- healthy: steady line pressure around 320 kPa
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '0000000000000021', 'pp01-main-line', 'makerfabs-pipe-pressure',
       jsonb_build_object('make','makerfabs','model','pipe-pressure','battery', 3.85,
         'pressure', jsonb_build_object('gauge', 320.0 + (g % 5) * 4.0),
         'sampleCount', 5, 'reportingInterval', 300), rx()
FROM generate_series(1, 24) g;

-- faulted: collapsed from 340 kPa to 20 kPa over ~2h — a burst main. Trips both the
-- low-pressure threshold and the rate-of-collapse check.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '0000000000000022', 'pp01-branch-3', 'makerfabs-pipe-pressure',
       jsonb_build_object('make','makerfabs','model','pipe-pressure','battery', 3.8,
         'pressure', jsonb_build_object('gauge', 20.0 + (g - 1) * 26.0),
         'sampleCount', 5, 'reportingInterval', 300), rx()
FROM generate_series(1, 13) g;

-- ══ AGLWL01 — makerfabs/light-intensity ══════════════════════════════════════
-- Shape: {make, model, seqNo, battery, air:{lightIntensity}}
-- Note battery ≈ 2.9 V is NORMAL for this device — the per-family scoping test.

-- healthy: a real diurnal curve peaking around 62 000 lux
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000031', 'l01-canopy-open', 'makerfabs-light-intensity',
       jsonb_build_object('make','makerfabs','model','light-intensity','seqNo', g,
         'battery', 2.95,
         'air', jsonb_build_object('lightIntensity',
           round(greatest(0, 62000 * sin(pi() * ((48 - g) % 48) / 48.0))::numeric, 2))), rx()
FROM generate_series(1, 48) g;

-- faulted: same diurnal shape but scaled to a peak of ~900 lux — the head is fouled,
-- snow-covered, or overgrown. Every reading is individually plausible (it IS dark at
-- night), so only a peak-below check catches it. Battery 2.85 V is healthy here and
-- must NOT trip the soil monitor's 3.3 V threshold.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000032', 'l01-canopy-shaded', 'makerfabs-light-intensity',
       jsonb_build_object('make','makerfabs','model','light-intensity','seqNo', g,
         'battery', 2.85,
         'air', jsonb_build_object('lightIntensity',
           round(greatest(0, 900 * sin(pi() * ((48 - g) % 48) / 48.0))::numeric, 2))), rx()
FROM generate_series(1, 48) g;
