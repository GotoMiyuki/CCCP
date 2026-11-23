import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidDate } from '../src/date.mjs';

test('accepts a valid date', () => {
  assert.equal(isValidDate(2024, 1, 31), true);
});

test('rejects invalid arguments', () => {
  assert.equal(isValidDate(2024, 13, 1), false);
  assert.equal(isValidDate(2024, 1, 32), false);
  assert.equal(isValidDate(2024, 1, 0), false);
  assert.equal(isValidDate(2024, 1, 2.5), false);
});
