'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('require() and import give the same classes', async () => {
  const cjs = require('../lib/index.cjs');
  const esm = await import('../lib/index.mjs');
  assert.equal(typeof cjs.Client, 'function');
  assert.equal(cjs.Client, esm.Client);
  assert.equal(cjs.UnlyxError, esm.UnlyxError);
  assert.equal(cjs.default, cjs);
  assert.equal(esm.default.VERSION, '1.0.1');
});
