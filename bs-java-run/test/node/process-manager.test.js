import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyProcessBelongsToService } from '../../src/lib/process-manager.js';

test('verifyProcessBelongsToService returns false when pidInfo uuid does not match process command', () => {
  const currentPid = process.pid;
  const dummyPidInfo = {
    pid: currentPid,
    uuid: 'non-existent-uuid-12345',
    serviceName: 'demo-service',
    warName: 'demo-service-server.war',
  };

  const isBelongs = verifyProcessBelongsToService(currentPid, dummyPidInfo);
  assert.equal(isBelongs, false);
});
