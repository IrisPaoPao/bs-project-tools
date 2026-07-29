import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { extractLoginToken, isLoginEndpoint } = require('../../login-script.cjs');

test('extractLoginToken supports authorization and legacy token response wrappers', () => {
  assert.equal(extractLoginToken({ authorization: 'root-authorization' }), 'root-authorization');
  assert.equal(extractLoginToken({ response: { authorization: 'response-authorization' } }), 'response-authorization');
  assert.equal(extractLoginToken({ data: { authorization: 'data-authorization' } }), 'data-authorization');
  assert.equal(extractLoginToken({ token: 'root-token' }), 'root-token');
  assert.equal(extractLoginToken({ response: { token: 'response-token' } }), 'response-token');
  assert.equal(extractLoginToken({ data: { token: 'data-token' } }), 'data-token');
  assert.equal(extractLoginToken({ result: { token: 'result-token' } }), 'result-token');
  assert.equal(extractLoginToken({ data: {} }), null);
});

test('isLoginEndpoint rejects unrelated business requests', () => {
  const resolved = { loginApiPath: '/saas/login' };
  assert.equal(isLoginEndpoint('http://example/saas/login', resolved), true);
  assert.equal(isLoginEndpoint('http://example/other/api', resolved), false);
});
