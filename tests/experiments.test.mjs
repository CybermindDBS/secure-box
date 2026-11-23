// Experiments are off unless a build turns them on: run with npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BROWSER_VAULT, EXPERIMENTS } from '../src/experiments.js';

test('experiments are off outside an experimental build', () => {
  assert.equal(BROWSER_VAULT, false);
  assert.deepEqual(EXPERIMENTS, []);
});
