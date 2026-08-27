import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterAccountsByEnvironment, getLoginConfigFile } from '../../src/commands/login.js';

const environments = [{ name: 'dev' }, { name: 'test' }];
const accounts = [
  { name: 'dev-001', env: 'dev' },
  { name: 'test-001', env: 'test' },
];

test('filterAccountsByEnvironment returns only accounts from the selected login environment', () => {
  assert.deepEqual(
    filterAccountsByEnvironment(accounts, environments, 'test').map(account => account.name),
    ['test-001'],
  );
});

test('filterAccountsByEnvironment rejects an unknown or unconfigured login environment', () => {
  assert.throws(() => filterAccountsByEnvironment(accounts, environments, 'missing'), /未找到登录环境/);
  assert.throws(() => filterAccountsByEnvironment([], environments, 'test'), /未配置登录账户/);
});

test('getLoginConfigFile keeps login in the current workspace configuration directory', () => {
  assert.equal(
    getLoginConfigFile({ configDirectory: '/tmp/tax-work/.bs-java-run' }),
    '/tmp/tax-work/.bs-java-run/JAVARUN.md',
  );
});
