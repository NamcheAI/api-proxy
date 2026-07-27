# namche-review GitHub App - setup

The `namche-review` GitHub App turns pull-request events and explicit review
mentions into cross-model review runs. GitHub sends subscribed events for every
installed repo to a single webhook, which api-proxy receives at
`POST /v1/webhooks/apps/github-app`.

## 1. Register the App

Manifest lives at [`github-app-manifest.json`](./github-app-manifest.json)
(name `namche-review`, webhook
`https://api.namche.net/v1/webhooks/apps/github-app`, permissions
`contents:read`, `pull_requests:write`, `checks:write`, `issues:write`, events
`pull_request`, `issue_comment`, `pull_request_review_comment`).

The current production App was originally registered as `namche-ai-tashi`.
Migrate that App in place after the review worker passes E2E validation so its
existing installations remain intact. For a new environment, create the App
under the **NamcheAI org** (Settings -> Developer settings -> GitHub Apps ->
New GitHub App) and use the manifest values.

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

## 5. Acting as `namche-review[bot]`

To post reviews/comments/approvals the agent mints a short-lived installation
access token from (App ID + private key -> App JWT -> installation token). All
writes then appear as `namche-review[bot]`, distinct from human `jodok` actions.

## 6. Event behavior

Automatic runs:

- `pull_request.opened`
- `pull_request.reopened`
- `pull_request.synchronize`
- `pull_request.ready_for_review`

Explicit runs:

- `issue_comment.created` on a PR with `@namche-review review` or
  `@namche-review re-review`
- `pull_request_review_comment.created` with the same commands
- mention author must be `OWNER`, `MEMBER`, or `COLLABORATOR`

Everything else is HMAC-verified and then answered with `202 ignored` without
waking the reviewer.
