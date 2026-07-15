# Tashi review App - setup

The `tashi` GitHub App turns pull-request events into review runs. GitHub sends
all events for every installed repo to a single webhook, which api-proxy
receives at `POST /v1/webhooks/apps/github-app` and forwards to the agent.

## 1. Register the App

Manifest lives at [`github-app-manifest.json`](./github-app-manifest.json)
(name `tashi`, webhook `https://api.namche.ai/v1/webhooks/apps/github-app`,
permissions `contents:read`, `pull_requests:write`, `checks:write`, events
`pull_request`, `pull_request_review`, `issue_comment`).

Create it under the **NamcheAI org** (Settings -> Developer settings -> GitHub
Apps -> New GitHub App). Either fill the form to match the manifest, or use the
create-from-manifest flow and paste the JSON.

## 2. Collect the credentials (once)

After creation GitHub gives you:

- **App ID**
- **Webhook secret** - set it during creation (generate a random string)
- **Private key** - "Generate a private key", downloads a `.pem` (shown once)
- Client ID / secret (not needed for webhook + installation-token flow)

Store the **private key**, **webhook secret** and **App ID** in 1Password
(vault `tashi`).

## 3. Wire api-proxy

Set in the api-proxy `config.yaml`:

```yaml
apps:
  githubApp:
    enabled: true
    targetAgent: tashi
    webhookSecret: <the App's webhook secret>
    sessionKey: hook:github-app:review
```

Restart api-proxy. `GET /healthz` should list `/v1/webhooks/apps/github-app`
and `routeToggles.githubApp: true`.

## 4. Install the App

Install on the target repos: NamcheAI org repos, `jodok/*` Context repos, and
the here-be-dragons-ai org. Installation grants the App access and yields an
`installation_id` (also delivered in every webhook payload as
`installation.id`).

## 5. Acting as `tashi[bot]`

To post reviews/comments/approvals the agent mints a short-lived installation
access token from (App ID + private key -> App JWT -> installation token). All
writes then appear as `tashi[bot]`, distinct from human `jodok` actions - which
lets a single human account still submit real `Approve` / `Request changes`
reviews (no self-approval conflict, no extra seat).
