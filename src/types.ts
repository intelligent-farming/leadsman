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

/** A device that a check found to be in breach on this run. */
export interface Finding {
  /** DevEUI, lowercase hex. The stable device identity — device_name is mutable. */
  devEui: string;
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
   */
  openDevEuis: ReadonlySet<string>;

  /** The configured instance name for this check — also the alert `kind`. */
  kind: string;

  /** Wall clock at the start of the sounding. Prefer SQL `now()` for time math. */
  now: Date;

  log: Logger;
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
  /** Return every device currently in breach. Throw to fail the sounding. */
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
 *
 * The three messaging providers send *text*, so they render the alert to one line. Reach for
 * a webhook when the receiver needs the structure; reach for a provider when a person needs
 * to read it on a phone.
 */
export type NotifyProvider = 'webhook' | 'twilio' | 'telegram' | 'signal';

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
}

/** One delivery target: either a webhook or a messaging provider. */
export interface NotifyDestination {
  /** Defaults to 'webhook', which keeps every existing destination working unchanged. */
  provider?: NotifyProvider;

  /** Recipients for `twilio` and `signal` — E.164 numbers. */
  to?: string[];
  /** Chat or channel id for `telegram`. Groups and channels are negative. */
  chatId?: string;

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
  checks: CheckConfig[];
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
