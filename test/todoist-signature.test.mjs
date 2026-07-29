import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

process.env.API_PROXY_NO_LISTEN = '1';
process.env.CONFIG_PATH = fileURLToPath(new URL('./fixtures/config.yaml', import.meta.url));

const { verifyTodoistSignature } = await import('../index.mjs');

const CLIENT_SECRET = 'test-todoist-client-secret';
const BODY = Buffer.from(JSON.stringify({
  event_name: 'item:added',
  user_id: '2671355',
  event_data: { id: '6XR4GqQQCW6Gv9h4', content: 'Buy Milk' },
}));

function sign(body, secret = CLIENT_SECRET) {
  return createHmac('sha256', secret).update(body).digest('base64');
}

test('accepts a signature Todoist would send', () => {
  assert.equal(verifyTodoistSignature(BODY, sign(BODY), CLIENT_SECRET), true);
});

test('rejects a signature made with the wrong secret', () => {
  assert.equal(verifyTodoistSignature(BODY, sign(BODY, 'other-secret'), CLIENT_SECRET), false);
});

test('rejects a body that changed after signing', () => {
  const signature = sign(BODY);
  const tampered = Buffer.from(JSON.stringify({
    event_name: 'item:added',
    user_id: '2671355',
    event_data: { id: '6XR4GqQQCW6Gv9h4', content: 'Buy Beer' },
  }));

  assert.equal(verifyTodoistSignature(tampered, signature, CLIENT_SECRET), false);
});

test('rejects missing and malformed signature headers', () => {
  for (const header of [undefined, null, '', '   ', 'not-base64', `sha256=${sign(BODY)}`, sign(BODY).slice(0, -1)]) {
    assert.equal(verifyTodoistSignature(BODY, header, CLIENT_SECRET), false, `header: ${String(header)}`);
  }
});
