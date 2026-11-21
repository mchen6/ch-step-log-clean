'use strict';
// The reviewer on #4 (cross-repo): an omitted long line keeps the key-block
// state ch-step-redact would compute from the full line, so this module's
// two marker patterns and its scan must be ch-step-redact's own. This test
// holds them to ch-step-redact (a devDependency, pinned to the commit whose
// patterns it compares): the patterns by their source and flags, and the
// scan by running ch-step-redact itself on every line of a table, from both
// states a line may meet.
const test = require('node:test');
const assert = require('node:assert');
const {KEY_BEGIN, KEY_END, openAfter} = require('../lib/clean');
const redact = require('@countinghouse/ch-step-redact/lib/rules');

test('the private key marker patterns are ch-step-redact\'s own', () => {
  assert.strictEqual(KEY_BEGIN.source, redact.KEY_BEGIN.source);
  assert.strictEqual(KEY_BEGIN.flags, redact.KEY_BEGIN.flags);
  assert.strictEqual(KEY_END.source, redact.KEY_END.source);
  assert.strictEqual(KEY_END.flags, redact.KEY_END.flags);
});

test('the key-block state after a line is the one ch-step-redact computes, from both states', () => {
  // (markers built at run time: a secret scanner flags a bare one in source)
  const K = 'PRIVATE ' + 'KEY-----';
  const B = `-----BEGIN EC ${K}`;
  const E = `-----END EC ${K}`;
  const lines = ['', 'plain', B, E, `x ${B} y`, `x ${E} y`, `${B} k ${E}`, `${E} k ${B}`, `${B}${E.slice(5)}`, `${E}${B.slice(5)}`,
    `-----END EC PRIVATE ${'KEY'}-----BEGIN EC ${K}`, `${B} ${B}`, `${E} ${E}`, `${B} k ${E} m ${B}`, `-----BEGIN ${K}`, `-----BEGIN RSA ${K}`];
  // (a line of the key's body follows: masked exactly when a block is open)
  const BODY = 'bodyLINEq83vAbZz';
  for (const line of lines) {
    for (const inside of [false, true]) {
      const input = [...(inside ? [B] : []), line, BODY];
      const open = !redact.redactLines(input).lines.some((l) => l.includes(BODY));
      assert.strictEqual(openAfter(line, inside), open, `${JSON.stringify(line)} from ${inside ? 'an open block' : 'none'}`);
    }
  }
});
