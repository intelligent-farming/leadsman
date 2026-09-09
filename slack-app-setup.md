# Setting up the Intelligent Farming Slack app

Operator runbook for the workspace side of the `slack` notify provider. Takes about ten
minutes. Do this before `leadsman test-notify --to slack` will work.

This is an **internal, single-workspace app** — not a distributed one. No app review, no
OAuth flow, no submission to the Slack Marketplace. Other organizations deploying leadsman
create their own app in their own workspace, exactly as they create their own Telegram bot.

## 1. Create the app from a manifest

Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest** → pick the
Intelligent Farming workspace → paste the YAML below → review → **Create**.

```yaml
_metadata:
  major_version: 2
  minor_version: 1

display_information:
  name: Intelligent Farming
  description: Device and telemetry alerts from the Intelligent Farming monitoring stack
  background_color: "#1F3D2B"

features:
  bot_user:
    display_name: Intelligent Farming
    always_online: true
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: false

oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - chat:write.customize

settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Notes on each choice:

- **`chat:write`** is the only scope strictly required.
- **`chat:write.public`** lets the app post to a public channel without being invited to it.
  Drop it if you would rather invite the bot deliberately to each channel — that is the more
  conservative posture and costs one `/invite`.
- **`chat:write.customize`** is only needed if you want Hermes to post under a distinguishable
  display name (e.g. "Intelligent Farming · Hermes") while sharing the same app identity.
  Drop it if both producers should look identical.
- **`token_rotation_enabled: false`** matters. Rotation makes the bot token expire and
  requires a refresh flow; leadsman holds a static credential and has no such flow, so
  enabling it would break delivery when the token first expires.
- **`socket_mode_enabled: false`** and no `interactivity` block: the app only sends. It has
  no inbound endpoint, by design.
- `background_color` is a placeholder — set it to whatever the Foundation actually uses.
- `long_description` is omitted because it is only required for public distribution.

If your workspace restricts app installation, this is the point where an admin has to approve
the request. Budget for that rather than being surprised by it.

## 2. Give it a face

**Basic Information → Display Information**: upload a 512×512 PNG icon and confirm the name.
This is the identity that appears on every alert in the channel — it is the whole reason for
using an app rather than an anonymous webhook, so it is worth doing properly rather than
leaving the default placeholder avatar.

## 3. Install and take the token

**OAuth & Permissions → Install to Workspace → Allow.**

Copy the **Bot User OAuth Token** — it starts with `xoxb-`. Take care to grab the right
credential: the App-Level Token (`xapp-`) is for Socket Mode and the Signing Secret is for
verifying inbound requests, and neither is used here.

Store it wherever the Foundation keeps deployment secrets. Two things to be honest about:

- The token is **workspace-wide**. With `chat:write.public` it can post to any public channel,
  not just the alert channel. That is the accepted tradeoff for using a bot token instead of a
  channel-bound incoming webhook, and it is why the token belongs in a secret store rather
  than a `.env` file in a repo.
- It is revocable and rotatable on its own from **OAuth & Permissions** without touching
  anything else in the workspace — the same property that makes a Twilio API Key preferable
  to the Account Auth Token.

## 4. Create the channel and get its ID

Create the channel (e.g. `#field-alerts`). If it is **private**, or if you dropped
`chat:write.public`, invite the app:

```
/invite @Intelligent Farming
```

Without this you get a `not_in_channel` error at send time.

Then get the channel **ID**: open the channel → click its name → the ID (`C0123456789`) is at
the bottom of the details dialog. Prefer the ID over `#field-alerts` in config — the ID
survives a channel rename, the name does not.

## 5. Prove it before wiring leadsman

```sh
export SLACK_BOT_TOKEN='xoxb-…'
curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-type: application/json; charset=utf-8' \
  -d '{"channel":"C0123456789","text":"leadsman wiring test"}'
```

You want `{"ok":true,…}`. Note that a **failure also returns HTTP 200** — the body is where
the truth is, which is exactly why the provider checks the envelope rather than the status
code. Common errors:

| `error` | Means |
|---|---|
| `invalid_auth` / `not_authed` | Wrong token, or you grabbed the `xapp-` one |
| `channel_not_found` | Bad ID, or the app cannot see that channel |
| `not_in_channel` | Private channel, or no `chat:write.public` — `/invite` the app |
| `missing_scope` | The manifest scopes did not apply; reinstall after changing scopes |

Any scope change requires **reinstalling** the app for the new scope to take effect.

## 6. Hand off to leadsman

```sh
export LEADSMAN_SLACK_BOT_TOKEN='xoxb-…'
```

```json
"destinations": {
  "slack": { "provider": "slack", "channel": "C0123456789" }
},
"routing": { "fact": "slack", "situation": "agent" }
```

Then:

```sh
leadsman verify
leadsman test-notify --to slack
```

Hermes uses the same token and the same channel — one app, two callers, one identity in the
channel.

## Operational notes

- `chat.postMessage` is rate-limited to roughly **one message per second per channel**, with
  burst allowance. A gateway outage that raises forty `device-silent` alerts at once will be
  throttled, not dropped, and a `ratelimited` failure leaves `notified_at` unstamped so the
  next sounding retries it.
- Nothing here needs revisiting when leadsman adds threading later; `thread_ts` needs no
  additional scope.
