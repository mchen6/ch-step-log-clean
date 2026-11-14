'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('./support');
const {cleanLog} = require('../lib/clean');
const clean = require('../handlers/cleanService/clean');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// The fixtures follow a real job log's layout (checked against this
// repository's own CI log, 2026-11-11): a BOM, a timestamp on every line, a
// step's `##[group]Run …` header holding only the command, the step's output
// after `##[endgroup]`, sub-groups inside a step, post steps opened by a plain
// "Post job cleanup." line.
test('groups lines into steps and strips timestamps and ansi', () => {
  const out = cleanLog(fixture('ubuntu.log'));
  assert.deepStrictEqual(out, {
    steps: [
      {name: '(top)', lines: ["Current runner version: '2.338.2'", 'Image: ubuntu-24.04', 'Complete job name: test (ubuntu-latest, 24)']},
      {name: 'Run actions/checkout@v4', lines: [
        'Syncing repository: example/widgets',
        '[command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --depth=1 origin'
      ]},
      {name: 'Run npm test', lines: [
        '> widgets@1.0.0 test',
        '> node --test',
        '|', // a lone bar is content: a spinner redraws with \r, which shown() handles
        '✖ adds two numbers (2.1ms)',
        '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
        '  3 !== 4',
        '      at TestContext.<anonymous> (/home/runner/work/widgets/widgets/test/add.test.js:7:10)',
        '##[error]Process completed with exit code 1.'
      ]},
      {name: 'Post job cleanup', lines: ['[command]/usr/bin/git version', 'git version 2.56.0', 'Cleaning up orphan processes']}
    ],
    totalLines: 35,
    kept: 16
  });
});

test('cleans CRLF and BOM logs', () => { // Review Focus 1
  const out = cleanLog(fixture('windows-crlf-bom.log'));
  assert.strictEqual(out.steps[0].name, '(top)');
  assert.ok(out.steps.some((s) => s.name === 'Run tests'));
  assert.ok(out.steps.flatMap((s) => s.lines).every((l) => !l.includes('\r') && !l.includes('\ufeff')));
  assert.deepStrictEqual(out.steps.map((s) => s.name), ['(top)', 'Run tests']);
  assert.deepStrictEqual(out.steps[1].lines, [
    'Downloading 100%', // a carriage-return progress line keeps what a terminal shows last
    'not ok 1 - reads the config',
    "  Error: ENOENT: no such file or directory, open 'C:\\a\\widgets\\widgets\\config.json'",
    '##[error]Process completed with exit code 1.'
  ]);
  assert.strictEqual(out.totalLines, 10);
});

test('progress lines are dropped and counted', () => {
  const out = cleanLog([' 45%', '12.5%', 'Receiving objects:  3% (1/30)', 'Resolving deltas: 100% (2/2)', 'real line', '', '   ', '2026-11-11T19:00:11.1066192Z'].join('\n'));
  assert.deepStrictEqual(out, {steps: [{name: '(top)', lines: ['real line']}], totalLines: 8, kept: 1});
});

// A step header as the runner writes it: the group, the command echoed in cyan.
const header = (cmd) => [`##[group]Run ${cmd}`, `\x1b[36;1m${cmd}\x1b[0m`, 'shell: /usr/bin/bash -e {0}', '##[endgroup]'];

test('a sub-group inside a step stays in the step; its markers go', () => {
  const out = cleanLog([...header('make'), '##[group]Compiling', 'cc -c a.c', '##[endgroup]', 'done'].join('\n'));
  assert.deepStrictEqual(out.steps, [{name: 'Run make', lines: ['cc -c a.c', 'done']}]);
});

test('a step header holds only the echoed command, which the step name already says: its lines are dropped', () => {
  const out = cleanLog([...header('npm run lint || echo "lint error"'), 'ok'].join('\n'));
  assert.deepStrictEqual(out.steps, [{name: 'Run npm run lint || echo "lint error"', lines: ['ok']}]);
  const uses = cleanLog(['##[group]Run actions/setup-node@v4', 'with:', '  node-version: 24', '##[endgroup]', 'Found in cache'].join('\n'));
  assert.deepStrictEqual(uses.steps, [{name: 'Run actions/setup-node@v4', lines: ['Found in cache']}]);
});

test('a group a script opens with a name starting "Run " is a sub-group, not a step', () => {
  const out = cleanLog([...header('make test'), '##[group]Run unit tests', 'not ok 1 - adds', '##[endgroup]', 'done'].join('\n'));
  assert.deepStrictEqual(out.steps, [{name: 'Run make test', lines: ['not ok 1 - adds', 'done']}]);
});

test('a line ending in a carriage return is kept, error lines included', () => {
  const out = cleanLog([...header('x'), 'Downloading 100%\r', '##[error]failed\r'].join('\r\n'));
  assert.deepStrictEqual(out.steps[0].lines, ['Downloading 100%', '##[error]failed']);
});

test('progress filters drop only progress: real lines that start with a percentage, or are a lone dash or bar, stay', () => {
  const out = cleanLog(['100% of 3 suites failed', ' 85.5% Statements 120/140', '-', '|', ' 45%', 'remote: Counting objects: 100% (5/5), done.',
    '##[error]fatal: early EOF while Receiving objects: 45%', '##[warning]Resolving deltas: slow'].join('\n'));
  assert.deepStrictEqual(out.steps[0].lines, ['100% of 3 suites failed', ' 85.5% Statements 120/140', '-', '|',
    '##[error]fatal: early EOF while Receiving objects: 45%', '##[warning]Resolving deltas: slow']);
});

test('OSC hyperlinks and character-set escapes are stripped too', () => {
  const out = cleanLog(['see \x1b]8;;https://example.com/x\x07the docs\x1b]8;;\x07 now\x1b(B', 'a\x1b]0;title\x1b\\b'].join('\n'));
  assert.deepStrictEqual(out.steps[0].lines, ['see the docs now', 'ab']);
});

test('a step with no output is still a step; an empty (top) is left out', () => {
  const out = cleanLog([...header('true'), ...header('false'), '##[error]Process completed with exit code 1.'].join('\n'));
  assert.deepStrictEqual(out.steps, [{name: 'Run true', lines: []}, {name: 'Run false', lines: ['##[error]Process completed with exit code 1.']}]);
});

test('an empty log has no steps', () => {
  assert.deepStrictEqual(cleanLog(''), {steps: [], totalLines: 0, kept: 0});
  assert.deepStrictEqual(cleanLog('\ufeff'), {steps: [], totalLines: 0, kept: 0});
});

test('warning and error markers are kept, other ansi forms are stripped', () => {
  const out = cleanLog(['\x1b[1m\x1b[31m##[warning]disk almost full\x1b[0m', '##[error]boom', 'x\x1b[2Ky'].join('\n'));
  assert.deepStrictEqual(out.steps[0].lines, ['##[warning]disk almost full', '##[error]boom', 'xy']);
});

test('a 5 MB log is cleaned in well under a second', () => {
  const line = '2026-11-11T19:00:11.1066192Z \x1b[36mmodule ok\x1b[0m: something happened at step 42 with value 0x1f2e3d';
  const text = [...header('npm test'), ...Array(60000).fill(line)].join('\n');
  assert.ok(text.length > 5e6);
  const start = Date.now();
  const out = cleanLog(text);
  const ms = Date.now() - start;
  assert.strictEqual(out.kept, 60000);
  assert.ok(ms < 3000, `took ${ms} ms`); // generous: shared CI runners
});

test('handler wraps cleanLog and refuses a non-string', async () => {
  const {output} = await clean({text: fixture('ubuntu.log')});
  assert.deepStrictEqual(output, cleanLog(fixture('ubuntu.log')));
  for (const bad of [{}, {text: 7}, {text: ['a']}, null]) {
    await assert.rejects(clean(bad), (err) => err.code === 'ARGUMENTS_INVALID', JSON.stringify(bad));
  }
});

test('the module is a part: never listed', () => {
  assert.deepStrictEqual(require('../package.json').countinghouse, {role: 'part'});
});

// From the reviewer's range review of Tasks 1-7 (task-7b).
test('a long run of carriage returns inside a line stays linear', () => {
  const text = [...header('progress'), 'x' + '\r'.repeat(200000) + 'done', 'y' + '\r'.repeat(200000)].join('\n');
  const start = Date.now();
  const out = cleanLog(text);
  const ms = Date.now() - start;
  assert.deepStrictEqual(out.steps[0].lines, ['done', 'y']);
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test('a uses: step whose header group is empty is still a step', () => {
  const out = cleanLog([...header('make'), 'built', '##[group]Run ./.github/actions/mine', '##[endgroup]', 'action output', '##[error]Process completed with exit code 1.'].join('\n'));
  assert.deepStrictEqual(out.steps, [
    {name: 'Run make', lines: ['built']},
    {name: 'Run ./.github/actions/mine', lines: ['action output', '##[error]Process completed with exit code 1.']}
  ]);
});

// From /code-review medium on PR #30.
test('an empty group a script opens is not a step, even when named "Run …"; an empty action header is', () => {
  const out = cleanLog([...header('make db'), '##[group]Run migrations', '##[endgroup]', 'migrated',
    '##[group]Run actions/cache@v4', '##[endgroup]', 'Cache restored', '##[group]Run docker://alpine:3', '##[endgroup]', 'ran'].join('\n'));
  assert.deepStrictEqual(out.steps.map((s) => [s.name, s.lines]), [
    ['Run make db', ['migrated']], ['Run actions/cache@v4', ['Cache restored']], ['Run docker://alpine:3', ['ran']]
  ]);
});

test('every kept line is at most 20000 characters (redact\'s input bound), cut with …, never between the halves of a surrogate pair', async () => {
  const long = `2026-11-13T20:03:50.0000000Z ${'x'.repeat(25000)}`;
  const pair = `${'p'.repeat(19998)}\u{1F600}${'q'.repeat(10)}`;
  const {output} = await clean({text: `${long}\nshort line\n${'y'.repeat(900)}\n${pair}\n`});
  const lines = output.steps.flatMap((s) => s.lines);
  assert.deepStrictEqual(lines.map((l) => l.length), [20000, 10, 900, 19999]);
  assert.strictEqual(lines[0], `${'x'.repeat(19999)}…`);
  assert.strictEqual(lines[3], `${'p'.repeat(19998)}…`, 'the pair at 19998-19999 is not split');
  const schema = require('../schema.json');
  const svc = Object.keys(schema).find((k) => schema[k] != null && schema[k].clean != null);
  assert.strictEqual(schema[svc].clean.output.properties.steps.items.properties.lines.items.maxLength, 20000);
});
