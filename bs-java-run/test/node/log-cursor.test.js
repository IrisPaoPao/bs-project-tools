import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readIncrementalLog } from '../../src/lib/process-manager.js';

test('readIncrementalLog reads only new bytes and auto-resets when file is truncated', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-log-'));
  const logFile = path.join(dir, 'app.log');

  // 1. Initial write
  writeFileSync(logFile, 'Line 1: Started in 2.5 seconds\n', 'utf8');
  const stat1 = statSync(logFile);

  let cursor = { inode: stat1.ino, offset: stat1.size };

  // 2. Append new content
  writeFileSync(logFile, 'Line 2: New log line\n', { flag: 'a' });

  const { incrementalText, cursor: newCursor } = readIncrementalLog(logFile, cursor);
  assert.equal(incrementalText, 'Line 2: New log line\n');
  assert.ok(newCursor.offset > cursor.offset);

  // 3. Truncate file
  writeFileSync(logFile, 'Truncated content\n', 'utf8');
  const { incrementalText: resetText } = readIncrementalLog(logFile, newCursor);
  assert.equal(resetText, 'Truncated content\n');
});
