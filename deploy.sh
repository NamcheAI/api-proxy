#!/bin/sh
# Manual deploy over the tailnet.
#
# The rp hosts (rp-civ today, rp-hetzner later) are tailnet-only / behind
# office NAT and are not reachable from a GitHub runner (their public DNAT
# is 443/80 only, not SSH), so this repo has no push-CD. Deploy by running
# this script from an operator's machine that is connected to the tailnet.
#
# Requires SSH access as the `admin` user (has sudo) on the target host.
#
# Usage:
#   ./deploy.sh            # deploys to rp-civ (production)
#   ./deploy.sh <host>     # deploys to another rp host, e.g. rp-hetzner
#
# The real /etc/api-proxy/config.yaml is managed by ansible
# (roles/app_api_proxy), NOT by this script.

set -eu

HOST="${1:-rp-civ.silverside-mermaid.ts.net}"
DEPLOY_PATH=/home/deploy/apps/api-proxy

echo "Deploying api-proxy to $HOST:$DEPLOY_PATH"

# Build the archive as its own step, NOT a `tar | ssh` pipeline: POSIX sh
# has no pipefail, so a piped tar failure (a file changed while read, an
# unreadable file) would be masked by ssh's exit 0 and deploy a truncated
# tree. `set -e` aborts here instead if tar fails.
ARCHIVE="$(mktemp -t api-proxy-deploy.XXXXXX.tgz)"
trap 'rm -f "$ARCHIVE"' EXIT
tar czf "$ARCHIVE" --exclude=.git --exclude=.github --exclude=node_modules --exclude=.env .

ssh "admin@$HOST" 'set -e; sudo install -d -o deploy -g deploy '"$DEPLOY_PATH"'; sudo tar xzf - -C '"$DEPLOY_PATH"'; sudo chown -R deploy:deploy '"$DEPLOY_PATH"'; sudo -u deploy sh -lc "cd '"$DEPLOY_PATH"' && npm ci --omit=dev"; sudo systemctl restart api-proxy; sudo systemctl is-active --quiet api-proxy && echo DEPLOY_OK' < "$ARCHIVE"
