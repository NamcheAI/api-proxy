import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

process.env.API_PROXY_NO_LISTEN = '1';
process.env.CONFIG_PATH = fileURLToPath(new URL('./fixtures/config.yaml', import.meta.url));

const { classifyGithubAppReviewEvent } = await import('../index.mjs');

const user = { login: 'jodok', type: 'User' };
const openPullRequest = {
  draft: false,
  state: 'open',
  user,
};

test('accepts supported pull request lifecycle events', () => {
  for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
    assert.deepEqual(classifyGithubAppReviewEvent({
      event: 'pull_request',
      action,
      payload: { sender: user, pull_request: openPullRequest },
    }), { eligible: true, reason: 'automatic_pr_event' });
  }
});

test('accepts only the review App completed check run', () => {
  const completion = {
    sender: { login: 'namche-review[bot]', type: 'Bot' },
    check_run: {
      name: 'namche-review',
      external_id: 'namche-review:abc123',
      app: { slug: 'namche-review' },
    },
  };
  assert.deepEqual(classifyGithubAppReviewEvent({
    event: 'check_run',
    action: 'completed',
    payload: completion,
  }), { eligible: true, reason: 'review_completed' });

  for (const [payload, action, reason] of [
    [completion, 'created', 'unsupported_check_run_action'],
    [{ ...completion, check_run: { ...completion.check_run, name: 'test' } }, 'completed', 'unrelated_check_run'],
    [{ ...completion, check_run: { ...completion.check_run, external_id: 'foreign' } }, 'completed', 'unrelated_check_run'],
    [{ ...completion, check_run: { ...completion.check_run, app: { slug: 'foreign' } } }, 'completed', 'unrelated_check_run'],
  ]) {
    assert.deepEqual(classifyGithubAppReviewEvent({
      event: 'check_run',
      action,
      payload,
    }), { eligible: false, reason });
  }
});

test('ignores drafts, review-App PRs, closed PRs, and unsupported actions', () => {
  const cases = [
    [{ sender: user, pull_request: { ...openPullRequest, draft: true } }, 'opened', 'draft'],
    [{ sender: user, pull_request: { ...openPullRequest, state: 'closed' } }, 'opened', 'closed'],
    [{ sender: user, pull_request: { ...openPullRequest, user: { login: 'namche-review[bot]', type: 'Bot' } } }, 'opened', 'review_app_authored_pr'],
    [{ sender: { login: 'namche-review[bot]', type: 'Bot' }, pull_request: openPullRequest }, 'opened', 'review_app_sender'],
    [{ sender: user, pull_request: openPullRequest }, 'closed', 'unsupported_pr_action'],
  ];

  for (const [payload, action, reason] of cases) {
    assert.deepEqual(classifyGithubAppReviewEvent({
      event: 'pull_request',
      action,
      payload,
    }), { eligible: false, reason });
  }
});

test('accepts pull requests authored by coding bots', () => {
  for (const login of ['chatgpt-codex-connector[bot]', 'claude[bot]', 'dependabot[bot]']) {
    assert.deepEqual(classifyGithubAppReviewEvent({
      event: 'pull_request',
      action: 'opened',
      payload: {
        sender: { login, type: 'Bot' },
        pull_request: {
          ...openPullRequest,
          user: { login, type: 'Bot' },
        },
      },
    }), { eligible: true, reason: 'automatic_pr_event' });
  }
});

test('accepts authorized mentions in PR conversation comments', () => {
  assert.deepEqual(classifyGithubAppReviewEvent({
    event: 'issue_comment',
    action: 'created',
    payload: {
      sender: user,
      issue: { pull_request: {}, user },
      comment: {
        author_association: 'OWNER',
        body: 'please @namche-review re-review this.',
      },
    },
  }), { eligible: true, reason: 'mention' });
});

test('accepts authorized mentions in inline review comments', () => {
  assert.deepEqual(classifyGithubAppReviewEvent({
    event: 'pull_request_review_comment',
    action: 'created',
    payload: {
      sender: user,
      pull_request: openPullRequest,
      comment: {
        author_association: 'MEMBER',
        body: '@namche-review review',
      },
    },
  }), { eligible: true, reason: 'mention' });
});

test('accepts contributor mentions only from the pull request author', () => {
  const cases = [
    {
      event: 'issue_comment',
      payload: {
        sender: { ...user, login: 'Jodok' },
        issue: { pull_request: {}, user },
        comment: {
          author_association: 'CONTRIBUTOR',
          body: '@namche-review review',
        },
      },
    },
    {
      event: 'pull_request_review_comment',
      payload: {
        sender: user,
        pull_request: openPullRequest,
        comment: {
          author_association: 'CONTRIBUTOR',
          body: '@namche-review re-review',
        },
      },
    },
  ];

  for (const { event, payload } of cases) {
    assert.deepEqual(classifyGithubAppReviewEvent({
      event,
      action: 'created',
      payload,
    }), { eligible: true, reason: 'mention' });
  }

  assert.deepEqual(classifyGithubAppReviewEvent({
    event: 'issue_comment',
    action: 'created',
    payload: {
      sender: { login: 'unrelated-contributor', type: 'User' },
      issue: { pull_request: {}, user },
      comment: {
        author_association: 'CONTRIBUTOR',
        body: '@namche-review review',
      },
    },
  }), { eligible: false, reason: 'unauthorized_commenter' });
});

test('ignores ordinary, unauthorized, non-PR, and bot comments', () => {
  const base = {
    issue: { pull_request: {}, user },
    sender: user,
    comment: {
      author_association: 'COLLABORATOR',
      body: 'ordinary discussion',
    },
  };
  const cases = [
    [base, 'no_mention'],
    [{ ...base, comment: { ...base.comment, author_association: 'NONE', body: '@namche-review review' } }, 'unauthorized_commenter'],
    [{ ...base, issue: {} }, 'not_a_pull_request'],
    [{ ...base, sender: { login: 'namche-review[bot]', type: 'Bot' }, comment: { ...base.comment, body: '@namche-review review' } }, 'review_app_sender'],
  ];

  for (const [payload, reason] of cases) {
    assert.deepEqual(classifyGithubAppReviewEvent({
      event: 'issue_comment',
      action: 'created',
      payload,
    }), { eligible: false, reason });
  }
});

test('ignores unsupported events and actions', () => {
  assert.deepEqual(classifyGithubAppReviewEvent({
    event: 'ping',
    action: '',
    payload: { sender: user },
  }), { eligible: false, reason: 'unsupported_event' });

  assert.deepEqual(classifyGithubAppReviewEvent({
    event: 'issue_comment',
    action: 'edited',
    payload: { sender: user },
  }), { eligible: false, reason: 'unsupported_event' });
});
