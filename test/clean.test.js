'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {cleanLog} = require('../lib/clean');
const {CountinghouseError} = require('countinghouse/lib/countinghouse-error');
// the handler as the runtime calls it: (input, ctx), ctx.error the runtime's
const ctx = {error: (code, message, details) => CountinghouseError.module(code, message, details)};
const handler = require('../handlers/cleanService/clean');
const clean = Object.assign((input) => handler(input, ctx), handler);

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
  // (an escape between two letters is removed, as before: a space goes in
  // only before a token's head -- the high on #6, F1)
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
    await assert.rejects(clean(bad), (err) => err.code === 'INPUT_REJECTED', JSON.stringify(bad));
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

test('a line over 20000 characters is omitted whole, never cut: no secret across the cut is kept, whatever its quoting', async () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJ${'a'.repeat(19470)}.${'s'.repeat(20)}`;
  const across = (secret) => `${jwt} ${'x'.repeat(20000 - jwt.length - 8)} ${secret} tail`;
  const secrets = [`ghp_${'A1b2C3d4E5'.repeat(4)}`, 'password="Zq9 Wx7 Kp3 Mn5 Rt8"', '{"password": "Zq9 Wx7 Kp3 Mn5 Rt8"}', "API_KEY='Zq9 Wx7 Kp3 Mn5 Rt8'"];
  const long = secrets.map(across);
  for (const l of long) assert.ok(l.length > 20000);
  const {output} = await clean({text: `${long.join('\n')}\nshort line\n${'y'.repeat(20000)}\n`});
  const lines = output.steps.flatMap((s) => s.lines);
  assert.deepStrictEqual(lines.slice(0, 4), long.map((l) => `(a line of ${l.length} characters, omitted)`));
  assert.deepStrictEqual(lines.slice(4).map((l) => l.length), [10, 20000], 'up to 20000 kept as it is');
  const schema = require('../schema.json');
  const svc = Object.keys(schema).find((k) => schema[k] != null && schema[k].clean != null);
  assert.strictEqual(schema[svc].clean.output.properties.steps.items.properties.lines.items.maxLength, 20000);
});

test('a step name read from its header is at most 200 characters, and the schema says so', async () => {
  const command = `npm test -- ${'x'.repeat(400)}`;
  const text = `##[group]Run ${command}\n\u001b[36;1m${command}\u001b[0m\n##[endgroup]\nok\n`;
  const {output} = await clean({text});
  const step = output.steps.find((s) => s.lines.includes('ok'));
  // (never cut mid-word: the pre-work high on pack 1, L1)
  assert.strictEqual(step.name, 'Run npm test --…');
  const schema = require('../schema.json');
  const svc = Object.keys(schema).find((k) => schema[k] != null && schema[k].clean != null);
  assert.strictEqual(schema[svc].clean.output.properties.steps.items.properties.name.maxLength, 200);
});

// The reviewer's high on ch-step-redact, 1: a private key block whose BEGIN
// line is over LINE_MAX characters. That line was omitted here whole, so
// ch-step-redact never saw the block open, and the key's body lines passed.
// An omitted line keeps the least that gives ch-step-redact the state the
// full line would: per marker order, two markers sharing their dashes
// included (the medium on this fix, 1).
test('an omitted long line leaves ch-step-redact\'s key-block state as the full line would', () => {
  const {cleanLog, LINE_MAX} = require('../lib/clean');
  const B = '-----BEGIN ' + 'EC PRIVATE KEY-----';
  const E = '-----END ' + 'EC PRIVATE KEY-----';
  const long = (tail) => cleanLog('x'.repeat(LINE_MAX + 1) + tail).steps[0].lines[0];
  // (markers built at run time: a secret scanner flags a bare one in source)
  const K = 'PRIVATE ' + 'KEY-----';
  const OPEN = `-----BEGIN ${K}`;
  const SHUT = `-----END ${K}`;
  const note = /\(a line of \d+ characters, omitted\)/.source;
  const cases = [
    ['', `^${note}$`],
    [B, `^${note} ${OPEN}$`],
    [E, `^${SHUT} ${note}$`],
    [B + 'k' + E, `^${SHUT} ${note}$`],
    [E + 'k' + B, `^${note} ${OPEN}$`],
    // END and BEGIN sharing dashes: both are markers to ch-step-redact
    ['-----END EC ' + K + 'BEGIN EC ' + K, `^${note} ${OPEN}$`],
    // BEGIN and END sharing dashes: from none, ch-step-redact sees the BEGIN
    // only (its dashes are taken), so a block opens; from an open block, the
    // END closes it. No note gives both: it keeps the block open (fails
    // closed)
    ['-----BEGIN EC ' + K + 'END EC ' + K, `^${note} ${OPEN}$`]
  ];
  for (const [tail, want] of cases) assert.match(long(tail), new RegExp(want), JSON.stringify(tail));
});


// The reviewer's pre-work high on pack 1 (L1-L4), with the probes' inputs.
// Values built at run time and plainly fake.
const redactLib = require('@countinghouse/ch-step-redact/lib/rules');
const FAKE_TOKEN = 'ghs_' + 'Ab3dE6'.repeat(6);
// (a secret's name and its value are built at run time, so no line here is
// a name=value pair a secret scanner flags)
const PW = ['pass', 'word'].join('');
const DB_PW = ['DB', 'PASS' + 'WORD'].join('_');
const GH_TOKEN = ['GITHUB', 'TOKEN'].join('_');
const part = (...p) => p.join('');
const LINE_MAX = require('../lib/clean').LINE_MAX;
const stepWith = (name, line) => `##[group]Run ${name}\n\u001b[36;1m${name}\u001b[0m\n##[endgroup]\n${line}\n`;

test('L1: a step name over 200 characters is never cut mid-word: a token near the cut goes whole or stays whole', () => {
  for (let pad = 150; pad <= 200; pad++) {
    const command = `${'x'.repeat(pad)} git clone https://x-access-token:${FAKE_TOKEN}@github.com/o/r.git`;
    const {steps} = cleanLog(stepWith(command, 'ok'));
    const name = steps.find((s) => s.lines.includes('ok')).name;
    assert.ok(name.length <= 200, `${pad}: ${name.length}`);
    // (either the whole token, which ch-step-redact masks, or none of it)
    const masked = redactLib.redactLines([name]).lines[0];
    assert.ok(!masked.includes('Ab3dE6'), `${pad}: ${masked}`);
  }
  // (one word longer than the bound: never its head -- a name starts "Run ")
  const {steps} = cleanLog(stepWith('x'.repeat(300), 'ok'));
  assert.strictEqual(steps.find((s) => s.lines.includes('ok')).name, 'Run…');
});

test('L2: an omitted bare key body line leaves ch-step-redact\'s bare-body state as the full line would', () => {
  const b64 = (n, seed) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let s = ''; let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % 64]; } return s; };
  const body = [b64(64, 2), b64(64, 3), b64(40, 4) + '=='];
  const runs = [
    ['M' + 'II' + b64(LINE_MAX + 5000, 1), ...body],
    ['M' + 'II' + b64(61, 5), 'M' + 'II' + b64(LINE_MAX + 5000, 6), ...body],
    ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'M' + 'II' + b64(LINE_MAX + 5000, 7), ...body]
  ];
  for (const raw of runs) {
    const direct = redactLib.redactLines(raw).lines.join('\n');
    const viaClean = redactLib.redactLines(cleanLog(raw.join('\n')).steps[0].lines).lines.join('\n');
    for (const l of body) {
      assert.strictEqual(viaClean.includes(l.slice(0, 30)), direct.includes(l.slice(0, 30)), `${raw[0].slice(0, 20)}: ${viaClean.slice(0, 200)}`);
      assert.ok(!viaClean.includes(l.slice(0, 30)), 'the body is masked');
    }
  }
});

test('L3: every escape sequence goes, and a control left over goes too: no letter is glued to a token', () => {
  const E = '\u001b';
  const ghp = 'ghp_' + 'a1B2'.repeat(9);
  const lines = [`${E}[38:5:208m${ghp}${E}[0m`, `${E}[38:2::255:0:0m${ghp}`, `${E}[>4;2m${ghp}`, `\u009b32m${ghp}\u009b0m`, `${E}x${ghp}`, `a\u0007${ghp}`];
  const {steps} = cleanLog(lines.join('\n'));
  const out = steps[0].lines;
  assert.strictEqual(out.length, lines.length);
  for (const l of out) {
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(l), JSON.stringify(l));
    assert.ok(!/[A-Za-z0-9]ghp_/.test(l), JSON.stringify(l));
    assert.ok(!redactLib.redactLines([l]).lines[0].includes('a1B2a1B2'), JSON.stringify(l));
  }
  // (colours still go as before, and the text between them stays)
  assert.deepStrictEqual(cleanLog(`${E}[31mred${E}[0m and ${E}[1;32mgreen${E}[0m`).steps[0].lines, ['red and green']);
});

test('L4: the runtime\'s hidden characters (tags, bidi, zero-width) never pass: removed, a space only before a token\'s head', () => {
  const hidden = ['\u200b', '\u200e', '\u202e', '\u2066', '\u2069', '\ufeff', '\u{e0041}', '\u{e007f}', '\u00ad', '\u061c', '\u180e', '\u2060', '\u3164', '\ufe0f'];
  const line = 'Error: x' + hidden.join('y') + 'z';
  const out = cleanLog(`first\n${line}\n`).steps[0].lines[1];
  const {hiddenClass} = require('countinghouse/lib/conditions-why.json');
  assert.ok(!new RegExp(`[${hiddenClass}]`, 'u').test(out), JSON.stringify(out));
  // (removed, but a whitespace one -- U+FEFF -- or a blank filler -- U+3164 --
  // is a space, as a screen shows it)
  // (inside a word every one is removed, a whitespace one too)
  assert.strictEqual(out, 'Error: x' + 'y'.repeat(hidden.length - 1) + 'z');
  assert.deepStrictEqual(cleanLog('a \ufeff b').steps[0].lines, ['a   b'].map((l) => l.replace(/ +/g, (m) => m)));
});

test('L4: the hidden class is the runtime\'s own (lib/conditions-why.json hiddenClass)', () => {
  const {HIDDEN_CLASS} = require('../lib/clean');
  assert.strictEqual(HIDDEN_CLASS, require('countinghouse/lib/conditions-why.json').hiddenClass);
});

// The medium on L1-L4.
test('L3 medium: an escape between a letter and a token is a space (an ESC\'s final byte is its own: ruled)', () => {
  const E = '\u001b';
  const ghp = 'ghp_' + 'a1B2'.repeat(9);
  // (an ESC, intermediates and a token's first letter: the letter is the
  // escape's final, as a terminal reads it -- ruled; a 1.1 row)
  const lines = [`x${E}[0m${ghp}`, `x\u009d0;t\u009c${ghp}`, `${E}x${ghp}`];
  for (const l of cleanLog(lines.join('\n')).steps[0].lines) {
    assert.ok(!redactLib.redactLines([l]).lines[0].includes('a1B2a1B2'), JSON.stringify(l));
  }
});

test('L3 medium: a line of 8-bit OSC openers with no terminator stays linear', () => {
  const t = Date.now();
  cleanLog('\u009d'.repeat(200000));
  cleanLog('\u001b]'.repeat(100000));
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
});

test('L2 medium: an omitted OpenSSH key body line leaves ch-step-redact\'s state as the full line would', () => {
  const head = 'b3BlbnNzaC1rZXktdjE';
  const raw = [head + 'A'.repeat(LINE_MAX + 1), 'Q'.repeat(64), 'tail line'];
  const direct = redactLib.redactLines(raw).lines;
  const viaClean = redactLib.redactLines(cleanLog(raw.join('\n')).steps[0].lines).lines;
  assert.strictEqual(viaClean.some((l) => l.includes('QQQQ')), direct.some((l) => l.includes('QQQQ')), JSON.stringify([direct, viaClean]));
  assert.ok(!viaClean.some((l) => l.includes('QQQQ')), 'the body is masked');
});

test('L4 medium: a step header is found past hidden characters, in its group line and before its echo', () => {
  const E = '\u001b';
  const cases = [`##[group]Run y\n\u200b${E}[36;1my${E}[0m\n##[endgroup]\nok2\n`, `##[group]\u200bRun y\n${E}[36;1my${E}[0m\n##[endgroup]\nok2\n`, `##[group]Run\ty\n${E}[36;1my${E}[0m\n##[endgroup]\nok2\n`];
  for (const c of cases) {
    const {steps} = cleanLog(c);
    assert.deepStrictEqual(steps.map((s) => [s.name, s.lines]), [['Run y', ['ok2']]], JSON.stringify(c));
  }
});

// The reviewer's high on #6 (F1-F3, F5), with its probes' inputs.
const pipelineMasks = (raw, needle) => {
  const lines = cleanLog(raw).steps.flatMap((s) => s.lines);
  const out = redactLib.redactLines(lines).lines.join('\n');
  return !out.includes(needle);
};
test('F1: an escape inside a token or a secret is removed, so ch-step-redact sees it whole', () => {
  const E = '\u001b';
  const tok = 'Ab3dEf6h' + 'a1B2'.repeat(7);
  const cases = [
    [`src/a.js:3:const t = "${E}[01;31m${E}[Kghp_${E}[m${E}[K${tok}"`, tok],
    [`${PW}=${part('FAKE', 'pa')}${E}[7mX${E}[27m${part('rt', 'Two')}`, part('rt', 'Two')],
    [`mysql -uroot -p${E}[1m${E}[0mFAKEvalueZZ9 app`, 'FAKEvalueZZ9'],
    [`jwt eyJ${'h'.repeat(17)}.${E}[1meyJ${'y'.repeat(20)}${E}[0m.sig${'x'.repeat(40)}`, 'y'.repeat(20)]
  ];
  for (const [raw, needle] of cases) assert.ok(pipelineMasks(raw, needle), JSON.stringify(raw));
  // (a space still goes in before a token's head after a word: x\e[0mghp_…)
  const ghp = 'ghp_' + 'a1B2'.repeat(9);
  assert.deepStrictEqual(redactLib.redactLines(cleanLog(`x${E}[0m${ghp}`).steps[0].lines).lines, ['x <githubToken>']);
});

test('F2: a character-set designator\'s final byte is always its own', () => {
  const ghp = 'ghp_' + 'a1B2'.repeat(9);
  assert.ok(pipelineMasks(`\u001b(B${ghp}`, 'a1B2a1B2'), 'masked');
});

test('F3: a control inside a value is removed, so the value is masked whole', () => {
  assert.ok(pipelineMasks(`${DB_PW}=${part('QJN', '0j')}\u000e${part('1zr', 'Awk7K7C1Vegu')}`, part('1zr', 'Awk')), 'masked');
  // (a tab is a space, as before)
  assert.deepStrictEqual(cleanLog('a\tb').steps[0].lines, ['a b']);
});

test('F5: an omitted bare key body after a marker leaves ch-step-redact\'s state as the full line would', () => {
  const b64 = (n, seed) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let s = ''; let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % 64]; } return s; };
  const body = [b64(64, 21), b64(64, 22)];
  const raw = ['##[debug]M' + 'II' + b64(LINE_MAX + 5000, 20), ...body.map((b) => `##[debug]${b}`)];
  const direct = redactLib.redactLines(raw).lines.join('\n');
  const viaClean = redactLib.redactLines(cleanLog(raw.join('\n')).steps[0].lines).lines.join('\n');
  for (const b of body) {
    assert.ok(!direct.includes(b.slice(0, 30)), 'ch-step-redact alone masks it');
    assert.ok(!viaClean.includes(b.slice(0, 30)), viaClean.slice(0, 300));
  }
  assert.ok(cleanLog(raw.join('\n')).steps[0].lines[0].startsWith('##[debug]'), 'the marker kept');
});

// The medium on the high's round (F1-F5).
test('F1 medium: one pass, linear on long lines of escapes and hidden characters', () => {
  // (a 360 KB line of each: a quadratic pass took 25 s on the zero-width
  // one; linear, well under a second, a loaded runner allowed for)
  const t = Date.now();
  for (const unit of ['a\u200b', 'a\u001b[0m', 'a\u001b[0mghp_']) cleanLog(unit.repeat(Math.floor(360000 / unit.length)));
  assert.ok(Date.now() - t < 8000, `${Date.now() - t} ms`);
});

test('F1 medium: a gap a screen shows as space stays a space; heads and tails a token needs are kept apart', () => {
  const E = '\u001b';
  const tok = part('abcdefghijklmnopqrstuv', '0123456789');
  const cases = [
    // (a gap a screen shows as space, next to punctuation: a space)
    [`--${PW} \u000b${tok}`, tok], [`Authorization:\u2028Bearer ${tok}`, tok], [`${PW}=${E}[1C${tok}`, tok],
    [`x${E}[0mBearer ${tok}`, tok], [`x${E}[0mb3BlbnNzaC1rZXktdjE${'A'.repeat(60)}`, 'A'.repeat(40)], [`+${E}[0mM` + `IIB${'A'.repeat(60)}`, 'A'.repeat(40)],
    [`key: AKIA` + `IOSFODNN7EXAMPLE${E}[0mfoo`, 'IOSFODNN7EXAMPLE'], [`npm_${'a1B2'.repeat(9)}${E}[0mabc`, 'a1B2a1B2'],
    [`x${E}]8;;${'q'.repeat(100)}\u0007gh${'\u200b'.repeat(70)}p_${'a1B2'.repeat(9)}`, 'a1B2a1B2']
  ];
  for (const [raw, needle] of cases) {
    const out = redactLib.redactLines(cleanLog(raw).steps[0].lines).lines.join('\n');
    assert.ok(!out.includes(needle), `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);
  }
});

test('F1 medium: a hidden character never turns printed text into a group marker or hides a step header', () => {
  const E = '\u001b';
  const out = cleanLog(`before\n##[gr\u200boup]Run x\n${E}[36;1mx${E}[0m\n##[endgroup]\nafter\n`).steps.flatMap((s) => s.lines);
  assert.ok(out.includes('after'), JSON.stringify(out));
  assert.ok(out.some((l) => l.startsWith('##[gr')), JSON.stringify(out));
  const {steps} = cleanLog(`##[group]Run\u2800x\n${E}[36;1mx${E}[0m\n##[endgroup]\nok\n`);
  assert.deepStrictEqual(steps.map((s) => s.name), ['Run x']);
});

// The reviewer's ruling on separators: an invisible character after a
// secret's name (the word just written) is a space, as the value expects.
test('a whitespace-like invisible after a secret\'s name is its separator; inside a secret it is removed', () => {
  const E = '\u001b';
  const tok = part('abcdefghijklmnopqrstuv', '0123456789');
  for (const raw of [`--${PW}\u000b${tok}`, `Bearer\u2028${tok}`, `${PW}=${E}[1C${tok}`, `x Basic\u000c${tok}`]) {
    const out = redactLib.redactLines(cleanLog(raw).steps[0].lines).lines.join('\n');
    assert.ok(!out.includes(tok.slice(0, 12)), `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);
  }
  // (inserted mid-secret, it is still removed)
  assert.deepStrictEqual(cleanLog(`${DB_PW}=ab\u000bcd${tok}`).steps[0].lines, [`${DB_PW}=abcd${tok}`]);
});

test('NAME_END is ch-step-redact\'s own', () => {
  const {NAME_END} = require('../lib/clean');
  assert.strictEqual(NAME_END.source, redactLib.NAME_END.source);
  assert.strictEqual(NAME_END.flags, redactLib.NAME_END.flags);
});

// The reviewer's g1 fuzz (one gap at every position): a gap before a
// head-like run inside a token never splits it.
test('a gap inside a token, before a head-like run, never splits it', () => {
  const E = '\u001b';
  const A20 = 'Ab3dEf6hIj9kLm2nOp5q';
  const A13 = 'Rs8tUv1wXy4zA';
  const cases = [`token ghp_${A20}${E}[1mmig${A13}`, `token ghp_${A20}${E}[1mMII${A13}`, `token ghp_${A20}\u200bmhc${A13}`, `export ${GH_TOKEN}=Qx${A20}\u0001eyj${A13}`];
  for (const raw of cases) {
    const out = redactLib.redactLines(cleanLog(raw).steps[0].lines).lines.join('\n');
    assert.ok(!out.includes(A13) && !out.includes(A20.slice(0, 8)), `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);
  }
  // (a head after a short word is still kept apart: x\e[0mghp_…)
  const ghp = 'ghp_' + 'a1B2'.repeat(9);
  assert.deepStrictEqual(redactLib.redactLines(cleanLog(`x${E}[0m${ghp}`).steps[0].lines).lines, ['x <githubToken>']);
});
