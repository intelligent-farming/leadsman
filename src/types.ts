/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * The contract between the engine and a check script.
 *
 * A check is a stateless predicate over current telemetry: given a database it
 * can read and some parameters, return the devices that are *currently* in
 * breach. It does not decide whether that is new, whether anyone has been told,
 * or when to stop caring — the engine reconciles findings against open alerts and
 * owns the raise/resolve lifecycle. Keeping checks stateless is what makes them
 * safe to add, remove, and reorder from a config file.
 */

export type Severity = 'info' | 'warning' | 'critical';

/**
 * Whether an alert is self-explanatory or needs interpreting.
 *
 * This is the routing axis, and it is deliberately NOT severity. Severity says how bad;
 * routing says whether a reader — human or model — has to work out what the alert means.
 *
 *   fact       The summary line is the whole story: "battery 3.15V (raise <=3.4V)". Send it
 *              straight to whoever acts on it. Costs nothing to deliver.
 *   situation  Ambiguous alone, actionable only in combination with other alerts or outside
 *              context: one silent device is a dead node, six at once is the gateway. This is
 *              the only class worth spending an LLM invocation on.
 *
 * A critical alert is very often a `fact` — `pipe-pressure-low` already tells you the pressure
 * and the threshold. Routing everything critical to a model is the mistake this type exists to
 * prevent, because you then pay tokens to be told what the summary already said.
 */
export type Routing = 'fact' | 'situation';

/**
 * What an alert is about.
 *
 * Checks started out device-only, and for most of them that is still the right unit: a
 * flat battery belongs to a node. But the faults that make a whole site go quiet do not
 * belong to any device — pinning "the gateway stopped forwarding" on one of the twelve
 * sensors behind it is how an operator ends up driving to a field to look at a sensor
 * that was working the whole time.
 *
 *   device   a provisioned node. `id` is its DevEUI.
 *   gateway  a LoRaWAN gateway. `id` is its gateway EUI.
 *   site     everything this engine can see — the fleet, the network server, the
 *            backhaul between them. One instance is one edge device is one site.
 *   engine   Leadsman and the host it runs on.
 */
export type SubjectKind = 'device' | 'gateway' | 'site' | 'engine';

/** The thing an alert is about. `id` is what dedup keys on, together with `kind`. */
export interface AlertSubject {
  kind: SubjectKind;
  /** Stable identity. Mutable display names belong in `name`. */
  id: string;
  /** Human-readable label at time of sounding. */
  name?: string | null;
}

/** Something a check found to be in breach on this run. */
export interface Finding {
  /**
   * DevEUI, lowercase hex. The stable device identity — device_name is mutable.
   *
   * Optional only so non-device checks can exist; for a device check this is still the
   * field to set, and the engine derives `subject` from it. Set exactly one of `devEui`
   * or `subject` — a finding with neither is discarded.
   */
  devEui?: string;
  /** Non-device subject. Omit it and a `devEui` becomes `{ kind: 'device', id: devEui }`. */
  subject?: AlertSubject;
  /** Human-readable device name at time of sounding, if the row carried one. */
  deviceName?: string | null;
  /** One line, suitable for an SMS body. No trailing period needed. */
  summary: string;
  /** Overrides the check's default severity for this particular finding. */
  severity?: Severity;
  /**
   * Structured context — measured value, threshold, sample count. Keep it small:
   * this is the payload a notifier or an agent receives, and every field costs
   * tokens if a model reads it.
   */
  detail?: Record<string, unknown>;
}

/** Minimal logger, so checks don't take a dependency on a logging library. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /**
   * Optional: return a logger that tags every line with `bindings`. The engine uses
   * it to label output with the current check, and falls back to the parent logger
   * when an implementation doesn't provide it — so a caller passing a bare console
   * shim still works.
   */
  child?(bindings: Record<string, unknown>): Logger;
}

/** What the engine hands a check on each sounding. */
export interface SoundingContext {
  /**
   * Parameterized read-only query against the event store. Always pass values as
   * `$1`-style parameters; never interpolate into SQL. A statement timeout is
   * already applied at the connection level.
   */
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;

  /** Config `params` merged over the check's `defaultParams`. */
  params: Record<string, unknown>;

  /**
   * DevEUIs that currently have an open alert for *this* check's kind. Checks that
   * implement hysteresis use this to widen their predicate for devices already in
   * breach: raise at one threshold, clear at a looser one, so a value sitting on
   * the boundary does not oscillate.
   *
   * For a device check this is identical to `openSubjects` — the subject ids *are*
   * the DevEUIs — and it remains the name to use in one.
   */
  openDevEuis: ReadonlySet<string>;

  /**
   * Subject ids that currently have an open alert for this check's kind. The same set
   * as `openDevEuis`, under the name that is accurate for a gateway or site check.
   */
  openSubjects: ReadonlySet<string>;

  /** The configured instance name for this check — also the alert `kind`. */
  kind: string;

  /** Wall clock at the start of the sounding. Prefer SQL `now()` for time math. */
  now: Date;

  /**
   * ChirpStack's own view of the gateways, when a connection is configured.
   *
   * `rx_info` shows which gateways *forwarded* an uplink, which is enough to notice one
   * that stopped. It cannot show a gateway that is connected and sending stats but
   * hearing nothing (dead concentrator, disconnected antenna) or one registered and
   * never heard from at all — in both cases the gateway is simply absent from the
   * telemetry. That needs the network server's own record.
   *
   * Null when unconfigured. Declare `needs: ['chirpstack']` rather than checking for
   * null, and the engine will skip the check instead of running it blind.
   */
  gateways?: GatewaySource | null;

  /** Facts about this engine and its host, which no amount of telemetry can supply. */
  engine: EngineFacts;

  /**
   * The small amount of memory a check is allowed to keep between soundings.
   *
   * Checks are stateless by design, and almost all of them should stay that way: a check
   * that remembers what it already reported is a check that can disagree with the
   * database about what is open. This exists for the few facts that are not derivable
   * from telemetry at all — the address the gateways were told to use is the motivating
   * case, since nothing in the event store records it.
   *
   * Keys are namespaced per check instance, so two instances of the same rule with
   * different parameters cannot overwrite each other. Writes are no-ops under
   * `--dry-run`, which is what keeps a dry run genuinely side-effect free.
   */
  state: CheckState;

  log: Logger;
}

/** Per-check persistent scalars. See SoundingContext.state. */
export interface CheckState {
  get(key: string): Promise<{ value: string | null; seenAt: string } | null>;
  set(key: string, value: string | null): Promise<void>;
}

/** One gateway as the network server knows it. */
export interface GatewayRecord {
  /** Gateway EUI, lowercase hex. */
  gatewayId: string;
  name: string | null;
  description: string | null;
  createdAt: string | null;
  /** Last time ChirpStack heard anything from it. Null means never. */
  lastSeenAt: string | null;
  /** ChirpStack's own verdict, when it reports one: ONLINE | OFFLINE | NEVER_SEEN. */
  state: string | null;
}

/**
 * Where gateway records come from. An interface rather than the concrete client so a
 * check can be tested with a stub and no HTTP.
 */
export interface GatewaySource {
  listGateways(): Promise<GatewayRecord[]>;
}

/** Host- and engine-level facts, gathered once per sounding. */
export interface EngineFacts {
  /**
   * When the event store's Postgres last started. A restart here means the stack — and
   * on a single-box deployment the host — came back up, which is how a power cut is
   * detectable after the fact. Readable by any role, no privileges needed.
   */
  postmasterStartTime: string | null;
  /** Most recent completed sounding before this one. Null on a first run. */
  previousRunAt: string | null;
  /**
   * The address gateways are configured to forward to, as the host currently sees it.
   *
   * Injected, not discovered: Leadsman runs in a bridged container and cannot see the
   * host's LAN address from inside one. Null when no source is configured.
   */
  hostAddress: string | null;
}

/** A table plus the columns a check reads, for `leadsman verify`. */
export interface SchemaRequirement {
  table: string;
  columns: string[];
}

/** A check script. Modules in src/rules/ default-export one of these. */
export interface Rule {
  /** Stable identifier, matching the filename. Referenced by config `rule`. */
  id: string;
  /** One or two sentences: what it detects and when you would enable it. */
  description: string;
  /** Applied to findings that don't set their own. */
  defaultSeverity: Severity;
  /**
   * Where this check's alerts go by default — see `Routing`. Config `notifyTo` overrides it.
   *
   * Only meaningful for rules whose id *is* their meaning (device-silent, battery-low,
   * geofence-breach). The generic mechanisms — measurement-threshold, measurement-peak,
   * counter-spike and friends — serve many meanings at once: one config can use
   * measurement-threshold for both `frost-risk` (a situation) and `soil-ph-range` (a fact).
   * Those rules default to 'fact' as the cheap, safe baseline, and the per-check `notifyTo`
   * is how a deployment says which of its instances need interpreting.
   */
  defaultRouting: Routing;
  /** Merged under config `params`. Every parameter must have a default. */
  defaultParams: Record<string, unknown>;
  /**
   * Tables and columns this check reads. `leadsman verify` compares these against
   * the live database and reports mismatches, so a ChirpStack schema difference
   * surfaces as a clear message rather than a runtime SQL error at 3am.
   */
  requires: SchemaRequirement[];
  /**
   * Optional capabilities this check cannot work without.
   *
   *   chirpstack   a configured connection to the network server's gateway API
   *   hostAddress  a configured source for the host's forwarding address
   *
   * A check naming something unconfigured is recorded as `skipped` rather than run, so
   * "this needs setting up" reads differently from "this found nothing" in
   * `leadsman.run`. Without it, an unconfigured gateway check looks exactly like a
   * healthy one — which is the failure mode this whole area exists to remove.
   */
  needs?: ReadonlyArray<'chirpstack' | 'hostAddress'>;
  /** Return everything currently in breach. Throw to fail the sounding. */
  run(ctx: SoundingContext): Promise<Finding[]>;
}

/** One entry in the config's `checks` array. */
export interface CheckConfig {
  /** Rule id — the script to run. */
  rule: string;
  /**
   * Instance name, and therefore the alert `kind`. Defaults to `rule`. Set this
   * when enabling the same script more than once with different parameters
   * (e.g. measurement-threshold for both soil moisture and air temperature).
   */
  as?: string;
  enabled?: boolean;
  severity?: Severity;
  /**
   * Destination name from `notify.destinations`, or a `Routing` value resolved through
   * `notify.routing`. Overrides the rule's `defaultRouting`. This is where a deployment
   * expresses meaning the generic rules cannot know — that its `measurement-threshold`
   * instance named `pipe-pressure-low` is a situation while `soil-ph-range` is a fact.
   */
  notifyTo?: string;
  params?: Record<string, unknown>;
}

/**
 * How a destination delivers.
 *
 *   webhook   POST the alert JSON. The original behaviour, and what an agent route wants:
 *             the receiver gets structured fields, not a sentence.
 *   twilio    SMS via Twilio's REST API.
 *   telegram  A Telegram bot message.
 *   signal    Signal via a signal-cli-rest-api instance you run.
 *   slack     A Slack bot message via `chat.postMessage`.
 *
 * The messaging providers send *text*, so they render the alert to one line. Reach for a
 * webhook when the receiver needs the structure; reach for a provider when a person needs
 * to read it on a phone.
 */
export type NotifyProvider = 'webhook' | 'twilio' | 'telegram' | 'signal' | 'slack';

/** Credentials and endpoints for the messaging providers. Env only — never the config file. */
export interface MessagingCredentials {
  twilio?: {
    /** Account SID (AC…). Identifies the account in the request path. */
    accountSid: string;
    /**
     * API Key SID (SK…) and its secret. These authenticate — not the Account Auth Token.
     *
     * An API Key is revocable and rotatable on its own; the Auth Token is the account's
     * master credential, so rotating it breaks every other integration and leaking it hands
     * over the whole account. Twilio's own guidance is to use keys for application access,
     * and there is no reason for an alerting engine to hold anything stronger.
     */
    apiKeySid: string;
    apiKeySecret: string;
    /** Sending number or messaging-service alphanumeric sender. */
    from: string;
    /** Override for testing or a regional edge. Default https://api.twilio.com */
    baseUrl?: string;
  };
  telegram?: {
    botToken: string;
    /** Override for a local Bot API server. Default https://api.telegram.org */
    baseUrl?: string;
  };
  signal?: {
    /** signal-cli-rest-api base URL, e.g. http://signal-cli:8080 — there is no hosted API. */
    baseUrl: string;
    /** The registered sending number. */
    from: string;
  };
  slack?: {
    /** Bot user OAuth token (xoxb-…). Needs the chat:write scope. */
    botToken: string;
    /** Override for testing. Default https://slack.com */
    baseUrl?: string;
  };
}

/** One delivery target: either a webhook or a messaging provider. */
export interface NotifyDestination {
  /** Defaults to 'webhook', which keeps every existing destination working unchanged. */
  provider?: NotifyProvider;

  /** Recipients for `twilio` and `signal` — E.164 numbers. */
  to?: string[];
  /** Chat or channel id for `telegram`. Groups and channels are negative. */
  chatId?: string;
  /** Channel for `slack` — an ID (`C…`, stable across renames) or a `#name`. */
  channel?: string;

  /** Required for `webhook`; ignored by the providers. */
  webhookUrl?: string;
  /** See NotifyConfig.webhookAuth. Defaults to 'bearer'. */
  webhookAuth?: 'hmac' | 'token' | 'bearer';
  /** Header for `token` auth. Default `X-Webhook-Token`. */
  webhookTokenHeader?: string | null;
  /**
   * Secret, read from LEADSMAN_WEBHOOK_TOKEN_<NAME> (name upper-cased, hyphens to
   * underscores), falling back to LEADSMAN_WEBHOOK_TOKEN so a single shared secret still
   * works. Never read from the config file.
   */
  webhookToken?: string | null;
  /** Give up after this long. Default 5000. */
  timeoutMs?: number;
}

export interface NotifyConfig {
  /** Default per-destination timeout, overridable on each one. Default 5000. */
  timeoutMs?: number;

  /**
   * Names the edge device this engine runs on. Every delivered message leads with it —
   * `Alert from <name>: <alert>` — and webhook receivers get it as the payload's `instance`
   * field instead of a prefix.
   *
   * Set it when several deployments share one channel or group chat: unset, both devices
   * report as "Leadsman" and a recipient cannot tell which site is dry. Blank counts as
   * unset. Normally supplied as LEADSMAN_INSTANCE_NAME rather than written here, because the
   * config file is meant to be identical across installs while *which device this is* is a
   * property of the host.
   */
  instanceName?: string;

  /**
   * Named delivery targets, keyed by a name you choose. Required whenever `notify` is
   * present: there is exactly one way to describe delivery, so there is no second path that
   * can quietly win or quietly do nothing.
   */
  destinations: Record<string, NotifyDestination>;

  /**
   * Which destination each `Routing` class goes to. The normal shape is
   * `{ "fact": "sms", "situation": "agent" }`. A class mapped to null is recorded in Postgres
   * and not delivered — useful for silencing the high-volume half without losing it.
   */
  routing?: Partial<Record<Routing, string | null>>;

  /**
   * Fallback destination when routing yields nothing. Null means record-only, which is the
   * safe default: an unroutable alert is never silently dropped, it is just not pushed.
   */
  defaultDestination?: string | null;

  /**
   * Optional severity override, applied above the rule's routing but below a check's explicit
   * `notifyTo`. `{ "critical": "agent" }` escalates everything critical regardless of class.
   * Use sparingly — most critical alerts are facts whose summary is already actionable.
   */
  bySeverity?: Partial<Record<Severity, string | null>>;

  /**
   * Provider credentials, populated from the environment by parseConfig. Never read from the
   * config file, so a config carrying a Twilio destination is still safe to commit.
   */
  messaging?: MessagingCredentials;
}

export interface LeadsmanConfig {
  /** Cron expression for `serve` mode. Five or six fields. */
  schedule: string;
  /** IANA timezone the schedule is interpreted in. Default 'UTC'. */
  timezone?: string;
  /**
   * Per-query ceiling, applied as Postgres `statement_timeout`. This is the guard
   * that stops one slow sounding from starving ChirpStack's ingestion on a shared
   * box. Default 15000.
   */
  statementTimeoutMs?: number;
  /**
   * Refuse to run more than this many checks per sounding. A crude backstop
   * against a config that grew unnoticed. Default 64.
   */
  maxChecksPerRun?: number;
  notify?: NotifyConfig;
  /** Hold back alerts a higher-level alert already explains. Empty/absent = deliver everything. */
  suppress?: SuppressRule[];
  heartbeat?: HeartbeatConfig;
  chirpstack?: ChirpStackConfig;
  /** Where to read the host's gateway-forwarding address. */
  hostAddress?: HostAddressConfig;
  checks: CheckConfig[];
}

/**
 * One suppression edge: while any of `while` is open, mute anything matching `mute`.
 *
 * This exists because a single fault reports itself at several levels at once. A gateway
 * that stops forwarding makes every device behind it silent, so `fleet-silent` and forty
 * `device-silent` alerts are all true simultaneously — but only the first is a fault, and
 * the other forty each name a healthy sensor. Delivering them is worse than useless: it
 * buries the one alert that identifies the actual problem.
 *
 * Muting is not dropping. A muted alert is still raised, still visible in `leadsman
 * status` and `leadsman.open_alert`, and carries `detail.suppressedBy` saying what
 * withheld it. If it is still open when the suppressing alert resolves — a node that
 * really is dead, not merely unreachable — it becomes deliverable and goes out then.
 */
export interface SuppressRule {
  /** Kinds whose open alerts activate this rule. */
  while: string[];
  /**
   * What to mute, matched against either a check's `kind` (its `as` name) or its rule id.
   * Rule id is usually what you want: one config often has a dozen
   * `measurement-missing` instances under names like `soil-moisture-missing`, and naming
   * the rule covers all of them.
   */
  mute: string[];
  /** Off by default would defeat the purpose; set false to disable one entry. */
  enabled?: boolean;
}

/**
 * Outbound liveness ping.
 *
 * The one failure this engine structurally cannot report is its own. A power cut, a
 * kernel panic, a full disk, a container that never came back — in every case Leadsman
 * is not running, and a rule engine that is not running raises nothing. Silence from a
 * healthy site and silence from a dead one are identical from the inside.
 *
 * So the signal has to be inverted and it has to leave the box: something outside
 * notices that the pings stopped. Whatever receives this — a Hermes route,
 * healthchecks.io, your own endpoint — owns that alerting.
 */
export interface HeartbeatConfig {
  /** Where to POST. A GET-style ping receiver works too; the body is ignorable. */
  url: string;
  /** Same three modes as a webhook destination. Defaults to 'bearer'. */
  auth?: 'hmac' | 'token' | 'bearer' | 'none';
  /** Header for `token` auth. Default `X-Webhook-Token`. */
  tokenHeader?: string | null;
  /** Give up after this long. Default 5000. */
  timeoutMs?: number;
  /** Send even when the sounding errored. Default true — a degraded engine is still alive. */
  onError?: boolean;
}

/** Connection to ChirpStack's REST API, for the gateway records `rx_info` cannot supply. */
export interface ChirpStackConfig {
  /**
   * Base URL of chirpstack-rest-api (the grpc-gateway, typically :8090) — NOT the gRPC
   * port. Omit to take it from the shared config file.
   */
  url?: string;
  /** Tenant whose gateways to read. Omit to take it from the shared config file. */
  tenantId?: string;
  /**
   * Path to a JSON file holding `chirpStackUrl`, `apiKey` and `tenantId`.
   *
   * In intelligent-farming-stack the provisioner writes exactly that to
   * /shared/config.json on every start, and leftenant and mock-sensors already read it
   * the same way — so this needs no new secret handling and no key of its own. The API
   * key is never read from the Leadsman config file, which stays committable.
   */
  configFile?: string | null;
  timeoutMs?: number;
}

/** Where the host's gateway-forwarding address comes from. */
export interface HostAddressConfig {
  /** Literal address. Normally left unset in favour of the file or the environment. */
  address?: string | null;
  /**
   * JSON file to read it from, and the key within it. Defaults to the same shared
   * config file as `chirpstack`, whose `gatewayBridgeHost` is the address the stack
   * detected on the host and handed to gateways.
   */
  configFile?: string | null;
  configKey?: string;
}

/** Outcome of running one check. */
export interface CheckResult {
  ruleId: string;
  kind: string;
  status: 'ok' | 'error' | 'skipped';
  findings: number;
  raised: number;
  resolved: number;
  durationMs: number;
  error?: string;
}
