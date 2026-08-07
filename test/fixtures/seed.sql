-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Intelligent Farming Foundation
--
-- A ChirpStack-shaped event store seeded with one device per fault, using the
-- normalized codec vocabulary. Each device is designed to trip exactly one check, so
-- an over-firing check surfaces as an unexpected alert on a neighbouring device, and
-- the FFxx healthy controls must never raise anything at all.
--
-- Devices are numbered by concern:
--   00xx  fleet health (silence, battery, decode, missing field, weak link)
--   01xx  temperature — including multi-path fallback
--   02xx  wind
--   03xx  soil
--   04xx  tank / level — including multi-path fallback
--   05xx  metering counters
--   06xx  water & air quality
--   07xx  plant & equipment
--   08xx  boolean alarms
--   09xx  GPS / geofence
--   FFxx  healthy controls

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
-- The other event tables ChirpStack's PostgreSQL integration creates. Column types
-- mirror the real ones: event_log.level/code are TEXT holding numeric enum values,
-- event_status.battery_level is a real percentage from the MAC layer.
CREATE TABLE IF NOT EXISTS event_join (
  deduplication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time timestamptz NOT NULL, dev_eui text, device_name text,
  device_profile_name text, dev_addr text
);
CREATE TABLE IF NOT EXISTS event_status (
  deduplication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time timestamptz NOT NULL, dev_eui text, device_name text,
  device_profile_name text, margin smallint,
  external_power_source boolean, battery_level_unavailable boolean, battery_level real
);
CREATE TABLE IF NOT EXISTS event_log (
  id bigserial PRIMARY KEY,
  time timestamptz NOT NULL, dev_eui text, device_name text,
  device_profile_name text, level text, code text, description text, context jsonb
);
CREATE TABLE IF NOT EXISTS event_ack (
  queue_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time timestamptz NOT NULL, dev_eui text, device_name text,
  device_profile_name text, acknowledged boolean, f_cnt_down bigint
);

TRUNCATE event_up, event_join, event_status, event_log, event_ack;

-- Good radio conditions by default, so signal-degraded stays quiet unless intended.
CREATE OR REPLACE FUNCTION rx(rssi numeric DEFAULT -95, snr numeric DEFAULT 9.5)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS
$$ SELECT jsonb_build_array(jsonb_build_object('rssi', rssi, 'snr', snr)) $$;

-- ══ 00xx fleet health ════════════════════════════════════════════════════════

-- device-silent: 10 uplinks, none in the last 5 hours
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(hours => 5) - make_interval(mins => 15 * g),
       '0000000000000001', 'silent-node', 'soil-v1',
       jsonb_build_object('battery', 3.9, 'soil', jsonb_build_object('moisture', 28.0)), rx()
FROM generate_series(1, 10) g;

-- battery-low, escalating to critical at criticalAtVolts (3.2)
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '0000000000000002', 'flat-battery', 'soil-v1',
       jsonb_build_object('battery', 3.2, 'soil', jsonb_build_object('moisture', 31.0 + g)), rx()
FROM generate_series(1, 20) g;

-- decode-failure: uplinks arriving, object NULL
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '0000000000000003', 'no-codec', 'unknown-v0', NULL, rx(-88, 11.0)
FROM generate_series(1, 15) g;

-- measurement-missing: reported soil.moisture for days, then the field vanished while
-- uplinks kept decoding — a codec or device-profile change, not a radio problem
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(hours => 24) - make_interval(hours => g),
       '0000000000000004', 'lost-field', 'soil-v1',
       jsonb_build_object('battery', 3.8, 'soil', jsonb_build_object('moisture', 30.0 + (g % 5))), rx()
FROM generate_series(1, 40) g;
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000004', 'lost-field', 'soil-v1',
       jsonb_build_object('battery', 3.8, 'air', jsonb_build_object('temperature', 18.0)), rx()
FROM generate_series(1, 12) g;

-- decode-failure via JSON null: the codec RAN and returned `null`. This is a JSONB
-- null, not a SQL NULL, so `object IS NULL` does not match it. Found on a real
-- ChirpStack store where a device with a stub decoder logged uplinks that every check
-- silently ignored.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '0000000000000006', 'null-codec', 'stub-v0', 'null'::jsonb, rx(-90, 10.0)
FROM generate_series(1, 15) g;

-- signal-degraded: healthy data, poor link
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000005', 'weak-link', 'soil-v1',
       jsonb_build_object('battery', 3.9, 'soil', jsonb_build_object('moisture', 30.0 + (g % 7))),
       rx(-119, 2.0)
FROM generate_series(1, 30) g;

-- ══ 01xx temperature ═════════════════════════════════════════════════════════

-- frost-risk on air.temperature (the first candidate path)
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 15 * g),
       '0000000000000101', 'frost-station', 'weather-v1',
       jsonb_build_object('battery', 3.9,
         'air', jsonb_build_object('temperature', 0.8, 'pressure', 1013.0)), rx()
FROM generate_series(1, 12) g;

-- frost-risk via MULTI-PATH FALLBACK: emits bare `temperature`, not `air.temperature`.
-- Proves a later candidate resolves per device rather than the whole check missing it.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 15 * g),
       '0000000000000102', 'bare-temp-probe', 'temperature-v1',
       jsonb_build_object('battery', 3.7, 'temperature', 1.1), rx()
FROM generate_series(1, 12) g;

-- heat-stress
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 15 * g),
       '0000000000000103', 'hot-house', 'climate-v1',
       jsonb_build_object('battery', 3.9,
         'air', jsonb_build_object('temperature', 38.5, 'relativeHumidity', 60.0)), rx()
FROM generate_series(1, 12) g;

-- temperature-crash: 20C down to 4C over 4h = 4C/h against a 3C/h limit
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000104', 'plunging-temp', 'weather-v1',
       jsonb_build_object('battery', 3.9,
         'air', jsonb_build_object('temperature', 4.0 + (g - 1) * 2.0, 'pressure', 1009.0)), rx()
FROM generate_series(1, 9) g;

-- ══ 02xx wind ════════════════════════════════════════════════════════════════

-- wind-gust: the window average is calm and the latest reading is calm, but one
-- sample peaked at 21 m/s. Only measurement-peak sees it.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '0000000000000201', 'gusty-station', 'weather-v1',
       jsonb_build_object('battery', 3.9,
         'wind', jsonb_build_object('speed', CASE WHEN g = 7 THEN 21.0 ELSE 6.0 + (g % 3) END,
                                    'direction', 180.0 + g),
         'air', jsonb_build_object('temperature', 17.0, 'pressure', 1011.0)), rx()
FROM generate_series(1, 15) g;

-- anemometer-stuck: exactly 0 m/s for 30 readings — a seized cup
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000202', 'seized-anemometer', 'wind-v1',
       jsonb_build_object('battery', 3.8,
         'wind', jsonb_build_object('speed', 0.0, 'direction', 90.0)), rx()
FROM generate_series(1, 30) g;

-- ══ 03xx soil ════════════════════════════════════════════════════════════════

-- soil-moisture-low
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000301', 'dry-field', 'soil-v1',
       jsonb_build_object('battery', 3.9,
         'soil', jsonb_build_object('moisture', 9.0 + (g % 3) * 0.2, 'temperature', 19.0, 'ec', 1.2, 'pH', 6.5)), rx()
FROM generate_series(1, 20) g;

-- soil-probe-stuck: constant 30.00 across 20 readings
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000302', 'detached-probe', 'soil-v1',
       jsonb_build_object('battery', 3.8,
         'soil', jsonb_build_object('moisture', 30.0, 'temperature', 18.0)), rx()
FROM generate_series(1, 20) g;

-- soil-salinity-high: 6.5 dS/m against a 4 dS/m limit
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000303', 'salty-block', 'soil-v1',
       jsonb_build_object('battery', 3.9,
         'soil', jsonb_build_object('moisture', 28.0 + (g % 4), 'ec', 6.5, 'pH', 7.0)), rx()
FROM generate_series(1, 20) g;

-- ══ 04xx tank / level ════════════════════════════════════════════════════════

-- tank-draining-fast: 85% down to 30% over 6h ≈ 9%/h against an 8%/h limit
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000401', 'draining-tank', 'tank-v1',
       jsonb_build_object('battery', 3.9,
         'tank', jsonb_build_object('level', 30.0 + (g - 1) * 4.6, 'volume', 500.0)), rx()
FROM generate_series(1, 13) g;

-- tank-low via MULTI-PATH FALLBACK: no tank.level, only linear.position
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000402', 'float-sensor-tank', 'linear-v1',
       jsonb_build_object('battery', 3.8, 'linear', jsonb_build_object('position', 11.0 + (g % 2) * 0.3)), rx()
FROM generate_series(1, 12) g;

-- ══ 05xx metering counters ═══════════════════════════════════════════════════
-- Note the reversed series: g counts backwards in time, so subtracting from the base
-- makes the total increase with wall-clock time, as a real meter does.

-- water-burst: ~900 L/h sustained against a 500 L/h limit
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000501', 'burst-main', 'water-meter-v1',
       jsonb_build_object('battery', 3.9,
         'metering', jsonb_build_object('water', jsonb_build_object('total', 10000.0 - (g - 1) * 300.0))), rx()
FROM generate_series(1, 10) g;

-- water-meter-stalled: total flat across the whole window
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(hours => g),
       '0000000000000502', 'stalled-meter', 'water-meter-v1',
       jsonb_build_object('battery', 3.9,
         'metering', jsonb_build_object('water', jsonb_build_object('total', 44444.0))), rx()
FROM generate_series(1, 12) g;

-- counter decrease: a meter reset or replacement. Critical, because every
-- consumption figure derived from the series is now wrong.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(hours => g),
       '0000000000000503', 'reset-meter', 'water-meter-v1',
       jsonb_build_object('battery', 3.9,
         'metering', jsonb_build_object('water',
           jsonb_build_object('total', CASE WHEN g <= 4 THEN 120.0 ELSE 80000.0 END))), rx()
FROM generate_series(1, 12) g;

-- ══ 06xx water & air quality ═════════════════════════════════════════════════

-- dissolved-oxygen-low
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000601', 'pond-probe', 'water-quality-v1',
       jsonb_build_object('battery', 3.9,
         'water', jsonb_build_object('dissolvedOxygen', 3.1, 'ph', 7.4, 'turbidity', 12.0,
                                     'temperature', jsonb_build_object('current', 21.0))), rx()
FROM generate_series(1, 15) g;

-- co2-high
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 15 * g),
       '0000000000000602', 'storage-co2', 'air-quality-v1',
       jsonb_build_object('battery', 3.9,
         'air', jsonb_build_object('co2', 2400.0, 'temperature', 12.0, 'relativeHumidity', 70.0)), rx()
FROM generate_series(1, 12) g;

-- ══ 07xx plant & equipment ═══════════════════════════════════════════════════

-- leaf-wetness-high: fungal disease pressure
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000701', 'canopy-sensor', 'leaf-wetness-v1',
       jsonb_build_object('battery', 3.8,
         'leaf', jsonb_build_object('wetness', 94.0, 'temperature', 15.0)), rx()
FROM generate_series(1, 15) g;

-- pump-vibration-high
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000702', 'irrigation-pump', 'vibration-v1',
       jsonb_build_object('battery', 3.9,
         'vibration', jsonb_build_object('velocityRms', 11.4, 'peakFrequency', 48.0)), rx()
FROM generate_series(1, 15) g;

-- ══ 08xx boolean alarms ══════════════════════════════════════════════════════

-- water-leak asserted on the most recent uplinks
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000801', 'pumphouse-leak', 'water-leak-v1',
       jsonb_build_object('battery', 3.9, 'water', jsonb_build_object('leak', g <= 3)), rx()
FROM generate_series(1, 12) g;

-- contact-open: exercises a non-boolean truthy value (the contactState enum)
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '0000000000000802', 'grain-bin-hatch', 'contact-v1',
       jsonb_build_object('battery', 3.8, 'action', jsonb_build_object('contactState', 'open')), rx()
FROM generate_series(1, 12) g;

-- ══ 09xx GPS / geofence ══════════════════════════════════════════════════════

-- outside the fixture's bounding box (lat 42.5 is north of the 41.9 bound)
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '0000000000000901', 'stolen-generator', 'gps-v1',
       jsonb_build_object('battery', 3.9,
         'position', jsonb_build_object('latitude', 42.5, 'longitude', -93.6)), rx()
FROM generate_series(1, 10) g;


-- ══ 0Axx network-layer faults — the tables beyond event_up ═══════════════════
-- These devices all send healthy uplinks. Every fault below is invisible in event_up
-- and only appears in event_log, event_status, event_join, or event_ack.

-- Healthy uplinks for the whole 0Axx group, so device-silent and the measurement
-- checks stay quiet and the network-layer fault is the only thing reported.
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 15 * g), d.eui, d.name, 'net-v1',
       jsonb_build_object('battery', 3.9,
         'air', jsonb_build_object('temperature', 18.0 + (g % 5) * 0.3)), rx()
FROM generate_series(1, 12) g,
     (VALUES ('00000000000000a1','log-error-node'),
             ('00000000000000a2','status-batt-node'),
             ('00000000000000a3','status-margin-node'),
             ('00000000000000a5','unacked-node'),
             ('00000000000000af','net-healthy-node')) AS d(eui, name);

-- device-log-error: ChirpStack logged real ERRORs (level 2). Code 2 is its codec-error
-- code, but the check filters on level rather than code, so the exact number does not
-- matter — the description is what reaches the operator.
INSERT INTO event_log (time, dev_eui, device_name, device_profile_name, level, code, description)
SELECT now() - make_interval(mins => 30 * g),
       '00000000000000a1', 'log-error-node', 'net-v1', '2', '2',
       'Payload codec error: TypeError: Cannot read property length of undefined'
FROM generate_series(1, 6) g;

-- Noise control: only code-7 retransmission warnings, which every healthy LoRaWAN
-- device produces. The default excludeCodes must keep this device quiet.
INSERT INTO event_log (time, dev_eui, device_name, device_profile_name, level, code, description)
SELECT now() - make_interval(mins => 30 * g),
       '00000000000000af', 'net-healthy-node', 'net-v1', '1', '7',
       'Uplink was flagged as re-transmission / frame-counter did not increment'
FROM generate_series(1, 10) g;

-- status-battery-low: MAC-layer battery at 12 %. Its uplinks report battery 3.9 V, so
-- the codec-based battery-low check sees nothing — this is the codec-independent path.
INSERT INTO event_status (time, dev_eui, device_name, device_profile_name, margin,
                          external_power_source, battery_level_unavailable, battery_level)
SELECT now() - make_interval(hours => 12 * g), '00000000000000a2', 'status-batt-node',
       'net-v1', 15, false, false, 12.0
FROM generate_series(1, 5) g;

-- status-margin-low: healthy battery, but the device can barely hear the gateway.
INSERT INTO event_status (time, dev_eui, device_name, device_profile_name, margin,
                          external_power_source, battery_level_unavailable, battery_level)
SELECT now() - make_interval(hours => 12 * g), '00000000000000a3', 'status-margin-node',
       'net-v1', 2, false, false, 88.0
FROM generate_series(1, 5) g;

-- Controls for the status checks: mains-powered with a meaningless battery figure, and
-- a device that reports its battery as unavailable. Neither must raise anything.
INSERT INTO event_status (time, dev_eui, device_name, device_profile_name, margin,
                          external_power_source, battery_level_unavailable, battery_level)
SELECT now() - make_interval(hours => 12 * g), '00000000000000a6', 'mains-powered-node',
       'net-v1', 18, true, false, 0.0
FROM generate_series(1, 5) g;
INSERT INTO event_status (time, dev_eui, device_name, device_profile_name, margin,
                          external_power_source, battery_level_unavailable, battery_level)
SELECT now() - make_interval(hours => 12 * g), '00000000000000a7', 'batt-unavailable-node',
       'net-v1', 20, false, true, 0.0
FROM generate_series(1, 5) g;
INSERT INTO event_status (time, dev_eui, device_name, device_profile_name, margin,
                          external_power_source, battery_level_unavailable, battery_level)
SELECT now() - make_interval(hours => 12 * g), '00000000000000af', 'net-healthy-node',
       'net-v1', 17, false, false, 94.0
FROM generate_series(1, 5) g;

-- join-churn: 8 joins with 8 distinct DevAddrs against only 3 uplinks. Below the
-- minUplinks floor of device-silent, so this is the only check that can see it.
INSERT INTO event_join (time, dev_eui, device_name, device_profile_name, dev_addr)
SELECT now() - make_interval(hours => 3 * g), '00000000000000a4', 'rejoining-node',
       'net-v1', lpad(to_hex(1000 + g), 8, '0')
FROM generate_series(1, 8) g;
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(hours => 4 * g), '00000000000000a4', 'rejoining-node',
       'net-v1', jsonb_build_object('battery', 3.9), rx()
FROM generate_series(1, 3) g;

-- Join control: one join, plenty of uplinks — a normally commissioned device.
INSERT INTO event_join (time, dev_eui, device_name, device_profile_name, dev_addr)
VALUES (now() - make_interval(hours => 100), '00000000000000af', 'net-healthy-node',
        'net-v1', '0a0b0c0d');

-- downlink-unacked: 5 of 6 confirmed downlinks never acknowledged. Nothing in the
-- telemetry reflects a command that failed to land.
INSERT INTO event_ack (time, dev_eui, device_name, device_profile_name, acknowledged, f_cnt_down)
SELECT now() - make_interval(mins => 45 * g), '00000000000000a5', 'unacked-node',
       'net-v1', (g = 1), 500 + g
FROM generate_series(1, 6) g;

-- Ack control: every confirmed downlink acknowledged.
INSERT INTO event_ack (time, dev_eui, device_name, device_profile_name, acknowledged, f_cnt_down)
SELECT now() - make_interval(mins => 45 * g), '00000000000000af', 'net-healthy-node',
       'net-v1', true, 700 + g
FROM generate_series(1, 6) g;

-- ══ FFxx healthy controls — must never raise anything ════════════════════════

-- a fully healthy soil node: recent, varying, good battery, good link
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '00000000000000ff', 'healthy-soil', 'soil-v1',
       jsonb_build_object('battery', 3.95,
         'soil', jsonb_build_object('moisture', 26.0 + (g % 5) * 0.6, 'temperature', 17.0 + (g % 4) * 0.2,
                                    'ec', 1.1 + (g % 3) * 0.05, 'pH', 6.6)), rx()
FROM generate_series(1, 20) g;

-- a healthy weather station: calm wind, no gusts, mild temperature
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 10 * g),
       '00000000000000fe', 'healthy-weather', 'weather-v1',
       jsonb_build_object('battery', 3.9,
         'wind', jsonb_build_object('speed', 3.0 + (g % 4) * 0.5, 'direction', 200.0 + g),
         'air', jsonb_build_object('temperature', 18.0 + (g % 5) * 0.4, 'pressure', 1014.0),
         'rain', jsonb_build_object('intensity', 0.0, 'cumulative', 12.4)), rx()
FROM generate_series(1, 20) g;

-- a healthy GPS tracker, inside the box
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 30 * g),
       '00000000000000fd', 'yard-trailer', 'gps-v1',
       jsonb_build_object('battery', 3.9,
         'position', jsonb_build_object('latitude', 41.85, 'longitude', -93.6)), rx()
FROM generate_series(1, 10) g;

-- a healthy water meter: steady, plausible consumption (~120 L/h)
INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
SELECT now() - make_interval(mins => 20 * g),
       '00000000000000fc', 'healthy-meter', 'water-meter-v1',
       jsonb_build_object('battery', 3.9,
         'metering', jsonb_build_object('water', jsonb_build_object('total', 5000.0 - (g - 1) * 40.0))), rx()
FROM generate_series(1, 12) g;
