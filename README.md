# api-proxy

Hono service behind the canonical `api.namche.net` endpoint.

## Purpose

- receive external webhooks
- validate app-specific incoming auth
- forward to OpenClaw agents over Tailscale HTTPS

## Current Endpoints

- `POST /v1/webhooks/agents/:agentId/notetaker/:notetakerId` (currently `:notetakerId` = `krisp`)
- `POST /v1/webhooks/apps/github/:owner/:repo` (optional, per-repo GitHub webhooks)
- `POST /v1/webhooks/apps/github-app` (optional, single GitHub App webhook; owner/repo from payload)
- `POST /v1/webhooks/agents/:agentId/webform/:formId`
- `POST /v1/webhooks/agents/:agentId/gmail/:subscription` (optional, Gmail Pub/Sub push)
- `POST /v1/webhooks/agents/:agentId/todoist/:accountId` (optional, Todoist app webhooks)

## Configuration

Config is loaded from YAML:

- default: `/etc/api-proxy/config.yaml`
- optional override: `CONFIG_PATH=/custom/path/config.yaml`

Current config shape:

- `listen` (`host`, `port`)
- `logLevel` (`error`, `warn`, `info`, `debug`)
- `WEBFORM_ALLOWED_ORIGINS` (array of allowed browser origins for `/v1/webhooks/agents/*`)
- `webform.enabled` (optional boolean route toggle, default `true`)
- `agents`:
  - keyed by shortname (for example `tashi`)
  - each agent defines:
    - `url`
    - `openclawHooksToken`
- `apps`:
  - currently `krisp`, optional `github`, optional `gmail`, optional `todoist`
  - defines:
    - `krisp.agents.<agentId>.incomingAuthorization` (required per-agent auth by URL `:agentId`)
    - `krisp.enabled` (optional boolean route toggle, default `true`)
    - `github.targetAgent` (agent shortname)
    - `github.webhookSecret`
    - `github.sessionKey`
    - `github.enabled` (optional boolean route toggle, default `true`)
    - `agents.<agentId>.apps.gmail.enabled` (optional boolean route toggle for Gmail on that agent, default `true`)
    - `agents.<agentId>.apps.gmail.subscriptions.<subscription>.oidcEmail` (GCP SA expected in OIDC JWT)
    - `agents.<agentId>.apps.gmail.subscriptions.<subscription>.token` (required Authorization token for forwarding to `gog gmail watch serve`)
    - `agents.<agentId>.apps.gmail.subscriptions.<subscription>.forwardPort` (optional port for `gog gmail watch serve` on that agent host, defaults to `8788`)
    - `todoist.enabled` (optional boolean route toggle, default `true`)
    - `todoist.agents.<agentId>.accounts.<accountId>.clientSecret` (registered Todoist app's client secret, signs the incoming HMAC)

See:

- `docs/config.yaml.example`

Route toggle behavior:

- disabled routes are not registered
- requests to disabled paths fall through to wildcard handlers and return `invalid_path`
- when `apps.github.enabled` is `false`, its required auth/target fields are not required
- omit `agents.<agentId>.apps.gmail` to disable Gmail for that agent entirely
- set `agents.<agentId>.apps.gmail.enabled: false` to keep config in place but disable Gmail for that agent
- if no agent has Gmail enabled, the Gmail route is disabled
- omit `apps.todoist` (or set `apps.todoist.enabled: false`) to disable the Todoist route

## Krisp Forwarding

Incoming check:

- endpoint: `POST /v1/webhooks/agents/:agentId/notetaker/:notetakerId` (`:notetakerId` must be `krisp`)
- request `Authorization` must exactly match `apps.krisp.agents.<agentId>.incomingAuthorization`

Forwarded request:

- `POST <agents.<agentId>.url>/hooks/agent`
- `Authorization: <agents.<agentId>.openclawHooksToken>`
- `Content-Type: application/json`

Forwarded payload:

```json
{
  "name": "notetaker:krisp",
  "message": "<raw body string>",
  "sessionKey": "hook:notetaker:krisp",
  "deliver": false
}
```

Expected upstream response:

- `202 { "status": "ok" }`

## GitHub Forwarding

Optional route — active when `apps.github` exists and `apps.github.enabled` is not `false`.

Incoming endpoint:

- `POST /v1/webhooks/apps/github/:owner/:repo`
- auth: GitHub HMAC signature (`X-Hub-Signature-256`) using `apps.github.webhookSecret`

Routing model:

- `:owner` and `:repo` are validated and forwarded as metadata
- all events forward to `apps.github.targetAgent`
- all events use one configured session key: `apps.github.sessionKey`

Forwarded payload:

```json
{
  "name": "github:<owner>/<repo>",
  "message": "{\"source\":\"github\",\"owner\":\"<owner>\",\"repo\":\"<repo>\",\"repository\":\"<owner>/<repo>\",\"event\":\"<x-github-event>\",\"action\":\"<payload.action>\",\"delivery\":\"<x-github-delivery>\",\"payload\":{...}}",
  "sessionKey": "agent:main:discord:channel:<DISCORD_CHANNEL_ID>",
  "wakeMode": "now",
  "deliver": true
}
```

Config:

```yaml
apps:
  github:
    enabled: true
    targetAgent: tashi
    webhookSecret: <GITHUB_WEBHOOK_SECRET>
    sessionKey: agent:main:discord:channel:<DISCORD_CHANNEL_ID>
```

## GitHub App Forwarding

For a GitHub App (single webhook URL across all installed repos), rather than a
per-repo webhook. Used by the `namche-review` App.

Incoming endpoint:

- `POST /v1/webhooks/apps/github-app`
- auth: GitHub HMAC signature (`X-Hub-Signature-256`) using `apps.githubApp.webhookSecret`

Routing model:

- one fixed URL for all repos; `owner`/`repo`/`repository` are derived from `payload.repository.full_name`
- `installationId` from `payload.installation.id` is forwarded as metadata
- supported PR lifecycle events forward automatically: `opened`, `reopened`,
  `synchronize`, and `ready_for_review`
- PR conversation and inline review comments forward only when an
  `OWNER`, `MEMBER`, or `COLLABORATOR` uses `@namche-review review` or
  `@namche-review re-review`; a `CONTRIBUTOR` may use the same commands only
  when they are also the pull request author
- drafts, closed or review-App-authored PRs, review-App comments, ordinary
  comments, and all unsupported events return `202` with `ignored: true`
  without waking the agent; PRs from Claude, Codex, Dependabot, and other bots
  remain eligible
- eligible events forward to `apps.githubApp.targetAgent` on one
  `apps.githubApp.sessionKey`

Forwarded payload:

```json
{
  "name": "github-app:<owner>/<repo>",
  "message": "{\"source\":\"github-app\",\"owner\":\"<owner>\",\"repo\":\"<repo>\",\"repository\":\"<owner>/<repo>\",\"event\":\"<x-github-event>\",\"action\":\"<payload.action>\",\"delivery\":\"<x-github-delivery>\",\"installationId\":<id>,\"payload\":{...}}",
  "sessionKey": "hook:github-app:review",
  "wakeMode": "now",
  "deliver": true
}
```

Config:

```yaml
apps:
  githubApp:
    enabled: true
    targetAgent: tashi
    webhookSecret: <GITHUB_APP_WEBHOOK_SECRET>
    sessionKey: hook:github-app:review
```

## Webform Forwarding

Incoming endpoint:

- `POST /v1/webhooks/agents/:agentId/webform/:formId`
- browser CORS origin allowlist comes from `WEBFORM_ALLOWED_ORIGINS`

Forwarded payload:

```json
{
  "name": "webform:<formId>",
  "message": "<raw body string>",
  "sessionKey": "hook:webform:<formId>",
  "wakeMode": "next-heartbeat",
  "deliver": false
}
```

## Gmail Pub/Sub Forwarding

Optional route — active when any agent defines `agents.<agentId>.apps.gmail.enabled` as `true` or leaves it unset.

Each route selects one agent and one Gmail subscription.

Incoming endpoint:

- `POST /v1/webhooks/agents/:agentId/gmail/:subscription`
- auth: GCP Pub/Sub OIDC JWT (`Authorization: Bearer <jwt>`) — verified against Google's public keys at api-proxy ingress and matched against `oidcEmail`
- `:agentId` selects `agents.<agentId>`
- `:subscription` selects `agents.<agentId>.apps.gmail.subscriptions.<subscription>`

Forwarded request:

- `POST http://<hostname-from-agents.<agentId>.url>:<forwardPort>/gmail-pubsub`
- `x-gog-token: <agents.<agentId>.apps.gmail.subscriptions.<subscription>.token>` is sent upstream to `gog gmail watch serve`
- the hostname comes from `agents.<agentId>.url`; the proxy derives the Gmail target URL and always uses `http`, the configured `forwardPort` or default `8788`, and `/gmail-pubsub`
- this fixes the mistaken ingress token check and the watcher-side audience mismatch by keeping OIDC at api-proxy ingress and not forwarding the Pub/Sub JWT upstream

Config:

```yaml
agents:
  tashi:
    url: https://tashi.silverside-mermaid.ts.net
    openclawHooksToken: Bearer <OPENCLAW_HOOKS_TOKEN_TASHI>
    apps:
      gmail:
        enabled: true
        subscriptions:
          jodok.batlogg@pina.earth:
            oidcEmail: pubsub-push@<PROJECT>.iam.gserviceaccount.com
            token: <GMAIL_WATCHER_TOKEN_PINA>
            forwardPort: 8788
```

Each agent can define zero or more Gmail subscriptions under `subscriptions`. `enabled` defaults to `true` when the Gmail app block exists.

GCP Pub/Sub setup — one Pub/Sub subscription per Gmail subscription entry:

```bash
PROJECT_ID=<PROJECT_ID>
SA=pubsub-push@${PROJECT_ID}.iam.gserviceaccount.com
AGENT=tashi
SUBSCRIPTION=jodok.batlogg@pina.earth

# 1. Create a shared service account for Pub/Sub push auth (once per project)
gcloud iam service-accounts create pubsub-push \
  --display-name="Pub/Sub push auth" \
  --project=${PROJECT_ID}

# 2. Create a topic (once per project)
gcloud pubsub topics create gmail-hook --project=${PROJECT_ID}

# 3. Create one push subscription per configured Gmail subscription entry
gcloud pubsub subscriptions create gmail-watch-${AGENT} \
  --topic=gmail-hook \
  --push-endpoint="https://api.namche.net/v1/webhooks/agents/${AGENT}/gmail/${SUBSCRIPTION}" \
  --push-auth-service-account="${SA}" \
  --project=${PROJECT_ID}
```

Set `oidcEmail` per Gmail subscription to `pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com`.
Set `token` per Gmail subscription to the shared token expected by the local watcher via `x-gog-token`.
Set `forwardPort` only when the local `gog gmail watch serve` port is not `8788`. This hotfix keeps OIDC verification at api-proxy ingress, fixes the mistaken ingress token check, and fixes the watcher-side audience mismatch by not forwarding the Pub/Sub JWT upstream.

## Todoist Forwarding

Optional route — active when `apps.todoist` exists and `apps.todoist.enabled` is not `false`.

Todoist webhooks belong to an app registered in the
[App Management Console](https://app.todoist.com/app/settings/integrations/app-management),
not to a personal API token. The app's **client secret** signs every delivery, so
that secret — not the account's `api_key` — is what this proxy needs. One account
per registered app; `:accountId` keeps a second account (its own app, its own
secret) addressable on the same agent.

Incoming endpoint:

- `POST /v1/webhooks/agents/:agentId/todoist/:accountId`
- auth: `X-Todoist-Hmac-SHA256` — base64 HMAC-SHA256 of the raw body, keyed with
  `apps.todoist.agents.<agentId>.accounts.<accountId>.clientSecret`
- `:agentId` and `:accountId` must both match the config

Forwarded payload:

```json
{
  "name": "todoist:<event_name>",
  "message": "{\"source\":\"todoist\",\"account\":\"<accountId>\",\"event\":\"<event_name>\",\"delivery\":\"<x-todoist-delivery-id>\",\"payload\":{...}}",
  "sessionKey": "hook:todoist:<accountId>",
  "wakeMode": "next-heartbeat",
  "deliver": false
}
```

Response contract — Todoist treats any non-`200` as a failed delivery and retries
after 15 minutes, at most three times, reusing the same `X-Todoist-Delivery-ID`.
So this route does not pass the upstream status through the way the other routes
do: a `2xx` from the agent becomes a plain `200`, and a genuine upstream failure
returns `502` to earn the retry. The delivery id is forwarded so the agent can
dedupe re-deliveries.

Which events arrive is chosen in the App Management Console, not here — this
route dispatches whatever the app is subscribed to.

Config:

```yaml
apps:
  todoist:
    enabled: true
    agents:
      tashi:
        accounts:
          jodok:
            clientSecret: <TODOIST_CLIENT_SECRET>
```

Webhook callback URL to register in the console:

```text
https://api.namche.net/v1/webhooks/agents/tashi/todoist/jodok
```

## Local Run

```bash
npm install
CONFIG_PATH=./docs/config.yaml.example npm start
```

## Deploy (NamcheAI/infra)

`NamcheAI/infra` is the deployment authority. Its `app_api_proxy` Ansible
role checks out an immutable commit from this repository, runs
`npm ci --omit=dev`, templates the runtime config, and manages the systemd
service identically on both reverse proxies.

Shipping a release therefore requires a reviewed infra PR that bumps
`app_api_proxy_version`. Merging that PR applies the same commit to the complete
RP inventory through the fleet pipeline. Do not deploy a single RP manually.

It deploys to:

- path: `/home/deploy/apps/api-proxy`
- restart target: `api-proxy.service`

Nginx integration (from infra):

- `api.namche.net` resolves to both RPs and proxies to `http://127.0.0.1:3000`
- selected `api.namche.ai` paths remain compatibility routes during migration
- proxy headers come from `/etc/nginx/proxy_params`

Production files on both RP hosts:

- `/etc/api-proxy/config.yaml` — managed by Ansible
- `/home/deploy/apps/api-proxy` — pinned source checkout managed by Ansible

Config contains secrets. Restrict file permissions accordingly.

See service template:

- `docs/api-proxy.service.example`
