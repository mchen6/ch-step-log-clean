'use strict';
// One GitHub Actions job log, cleaned into steps. A pure function of its input.
//
// A job log's layout (checked against a real one, 2026-11-11): a UTF-8 BOM; an
// ISO timestamp on every line; each step opened by a `##[group]Run <command>`
// header group that holds only the command (echoed in cyan) or a uses: step's
// with:/env: block, the step's output following the header's `##[endgroup]`;
// other groups (checkout's "Fetching the repository", or one a script opens
// with ::group::, whatever its name) nested inside a step's output; post steps
// opened by a plain "Post job cleanup." line; the set-up lines before the first
// step. So a step runs from its header to the next header; a header's own
// lines are dropped (the step's name already carries the command, and an
// echoed "|| echo error" is not an error); a group that is not a header is
// only markers to drop; what comes before the first header is "(top)".

const BOM = /^\uFEFF/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z(?: |$)/;
// CSI (colours, erase: any parameter bytes, colon and <=>? ones included),
// OSC (hyperlinks, titles; BEL or ST ended), the 8-bit CSI and OSC, and
// every other escape (ESC, intermediates, a final byte: character set
// selects, two-byte escapes, an unknown one) -- never an ESC that leaves its
// byte glued to the text after it (the pre-work high on pack 1, L3). An OSC
// body stops at the next opener, so a line of openers with no terminator is
// scanned once (its medium, 1). After intermediates, a final byte that a
// letter, digit or _ follows is no final: it starts the text (ESC SP ghp_…
// keeps its g -- the medium, 2).
const ANSI = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b\u009b\u009c\u009d]*(?:\x07|\x1b\\)|[ -\/]+(?:[0-~](?![0-9A-Za-z_]))?|[0-~])|\u009b[0-?]*[ -\/]*[@-~]|\u009d[^\x07\x1b\u009b\u009c\u009d]*(?:\x07|\u009c|\x1b\\)/g;
// (an escape between two letters or digits is a space: removed, it would
// glue a letter to a token after it, x\e[0mghp_… -- the medium, 3)
const WORD_CHAR = /[0-9A-Za-z_]/;
const unescaped = (text) => text.replace(ANSI, (m, at, all) => ((at > 0 && WORD_CHAR.test(all[at - 1]) && WORD_CHAR.test(all[at + m.length] || '')) ? ' ' : ''));
// What is left that no one sees -- a control (C0, C1), the runtime's hidden
// characters (tags, bidi, zero-width, fillers: countinghouse's
// lib/conditions-why.json hiddenClass, held to it by a test) -- is a space,
// never removed: removing one could glue a letter to a token after it, which
// ch-step-redact's patterns then miss (L3, L4).
const HIDDEN_CLASS = '\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\u2800\\u3164\\ud800-\\udfff\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}';
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`, 'gu');
// (before a step header's echo, the hidden characters that are no control:
// a zero-width one there still lets the cyan echo be seen -- the medium, 5)
const VISIBLE_START = new RegExp(`^(?:(?![\\u0000-\\u001f\\u007f-\\u009f])[${HIDDEN_CLASS}])+`, 'u');
const CYAN = '\x1b[36;1m';
const GROUP = /^##\[group\](.*)$/;
const ENDGROUP = /^##\[endgroup\]/;
const STEP_HEADER = /^Run /;
const USES_BLOCK = /^(?:with|env):\s*$/;
// What a uses: step's header names: ./path, owner/repo[/path]@ref, docker://image.
const ACTION_REF = /^Run (?:\.{1,2}\/\S+|[\w.-]+\/[\w./-]+@\S+|docker:\/\/\S+)$/;
const POST_STEP = /^Post job cleanup\.?$/;
const MARKED = /^##\[(?:error|warning)\]/;
// Progress: a bare percentage, and git's transfer counters.
const PROGRESS = [/^\s*\d{1,3}(?:\.\d+)?%\s*$/, /^\s*(?:remote:\s+)?(?:Enumerating|Counting|Compressing|Receiving) objects:|^\s*(?:remote:\s+)?Resolving deltas:/];
const TOP = '(top)';
// Every kept line at most LINE_MAX characters, cut with … and never between
// the halves of a surrogate pair (the reviewer, 2026-11-13): a log line can
// be megabytes (a minified bundle, a JSON dump). The bound is
// ch-step-redact's input bound, not the 500 of what reaches a result: redact
// masks a line before it cuts it to 500, so a secret across the 500th
// character is masked whole; cut here first, its head would stay in view,
// matching no pattern (/code-review medium).
// A line over LINE_MAX characters is never cut and kept: it is replaced
// whole by "(a line of N characters, omitted)" (the reviewer, 2026-11-13).
// A cut anywhere in it can split a secret (a token, or a quoted value
// holding spaces), whose head would reach ch-step-redact matching no
// pattern. Lines that long do not help triage. ch-step-redact omits them the
// same way.
const LINE_MAX = 20000;
// An omitted line keeps what ch-step-redact needs to follow private key
// blocks (the reviewer's high on ch-step-redact, 1): without it, the key's
// body lines after a long BEGIN line would reach ch-step-redact unmasked.
// The block's state after the line is computed exactly as ch-step-redact's
// maskKeyBlocks computes it, with its own two patterns and its own scan (a
// BEGIN, then an END only after it; with a block open, the first END from
// the line's start: two markers may share their dashes), for both states a
// line may meet: a block open before it, or none. The note then carries the
// least that gives ch-step-redact the same state after it:
// - open either way, or open from none: the note, then a BEGIN (from an open
//   block, closed by the full line but kept open here, it fails closed);
// - closed either way: an END, then the note (an END with no block open is
//   plain text to ch-step-redact);
// - closed from none, open from an open block: the note alone.
// Both patterns are bounded ({0,40}), so the scans are linear. They must
// stay ch-step-redact's (lib/rules.js KEY_BEGIN and KEY_END).
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
function openAfter(line, inside) {
  let pos = 0;
  if (inside) {
    KEY_END.lastIndex = 0;
    const end = KEY_END.exec(line);
    if (end === null) return true;
    pos = end.index + end[0].length;
  }
  for (;;) {
    KEY_BEGIN.lastIndex = pos;
    const begin = KEY_BEGIN.exec(line);
    if (begin === null) return false;
    KEY_END.lastIndex = begin.index + begin[0].length;
    const end = KEY_END.exec(line);
    if (end === null) return true;
    pos = end.index + end[0].length;
  }
}
// (the markers put back, built here so no source line holds one whole: a
// secret scanner flags a bare marker too)
const MARK = (word) => `-----${word} ` + 'PRIVATE KEY-----';
// (L2) A bare key body (a whole line of base64 from MII, MIG, MHc or an
// OpenSSH key's header, ch-step-redact's BARE_BODY) opens a block of its own
// in ch-step-redact, which takes the base64 lines after it too, from no block
// open or after another bare body; inside a BEGIN block it is an inner line.
// Omitted, such a line is replaced by one that opens the same: a bare body
// of its own, 64 wide (so the next 64-wide line goes on), plainly made here.
// ch-step-redact masks it whole, as it would the full line.
const BARE_BODY = /^\s*(?:M(?:II|IG|Hc)|b3BlbnNzaC1rZXktdjE)[A-Za-z0-9+/]{37,}={0,2}\s*$/;
const BARE_STANDIN = ('M' + 'IIomittedLongLineOfAKeyBody').padEnd(64, 'A');
function cutLine(t) {
  if (t.length <= LINE_MAX) return t;
  if (BARE_BODY.test(t)) return BARE_STANDIN;
  const note = `(a line of ${t.length} characters, omitted)`;
  if (openAfter(t, false)) return `${note} ${MARK('BEGIN')}`;
  if (!openAfter(t, true)) return `${MARK('END')} ${note}`;
  return note;
}
// A step's name, read from its header line, at most NAME_MAX characters.
// Longer, it is cut at the last space before the bound, with …, never in a
// word (the pre-work high on pack 1, L1): a word cut there could be a token's
// head (git clone https://x-access-token:<token>@…), which ch-step-redact
// then matches no pattern of. A first word longer than the bound is a note.
const NAME_MAX = 200;
function cutName(t) {
  if (t.length <= NAME_MAX) return t;
  let end = NAME_MAX - 1;
  while (end > 0 && !/\s/.test(t[end])) end--;
  const kept = t.slice(0, end).trimEnd();
  return kept === '' ? `(a step name of ${t.length} characters)` : `${kept}…`;
}

// What a terminal would show of one raw line: carriage returns at its end are
// the line ending's, one inside it is a progress bar redrawing itself.
// Linear: a regex /\r+$/ rescans a long run of CRs from every start.
function shown(rawLine) {
  let end = rawLine.length;
  while (end > 0 && rawLine.charCodeAt(end - 1) === 13) end--;
  const cr = rawLine.lastIndexOf('\r', end - 1);
  return cr === -1 ? rawLine.slice(0, end) : rawLine.slice(cr + 1, end);
}

// -> {steps: [{name, lines}], totalLines, kept}: totalLines counts the input's
// lines (a final newline ends the last one, it does not start another), kept
// the lines in steps. Dropped: header lines, group markers, progress lines,
// blank lines.
function cleanLog(text) {
  const raw = text.replace(BOM, '').split(/\r?\n/);
  if (raw[raw.length - 1] === '') raw.pop();
  const steps = [];
  let current = {name: TOP, lines: []};
  const open = (name) => {
    if (current.name !== TOP || current.lines.length > 0) steps.push(current);
    current = {name, lines: []};
  };
  let inHeader = false;
  let kept = 0;
  const visible = raw.map((r) => shown(r).replace(TIMESTAMP, ''));
  visible.forEach((withAnsi, i) => {
    const line = unescaped(withAnsi).replace(HIDDEN, ' ').trimEnd();
    if (inHeader) {
      if (ENDGROUP.test(line)) inHeader = false;
      return;
    }
    const group = GROUP.exec(line);
    if (group) {
      const next = (i + 1 < visible.length ? visible[i + 1] : '').replace(VISIBLE_START, '');
      // A header holds the cyan command echo, a uses: step's with:/env: block,
      // or, for an action with no inputs, nothing at all; an empty group a
      // script opens ("Run migrations") is not an action reference.
      const nextLine = unescaped(next).replace(HIDDEN, ' ');
      const name = group[1].trim();
      if (STEP_HEADER.test(name) && (next.startsWith(CYAN) || USES_BLOCK.test(nextLine) || (ENDGROUP.test(nextLine) && ACTION_REF.test(name)))) {
        open(cutName(name));
        inHeader = true;
      }
      return;
    }
    if (ENDGROUP.test(line)) return;
    if (POST_STEP.test(line)) {
      open('Post job cleanup');
      return;
    }
    if (line.trim() === '' || (!MARKED.test(line) && PROGRESS.some((re) => re.test(line)))) return;
    current.lines.push(cutLine(line));
    kept++;
  });
  if (current.name !== TOP || current.lines.length > 0) steps.push(current);
  return {steps, totalLines: raw.length, kept};
}

// (the markers and the state scan, for the test that holds them to ch-step-redact's)
module.exports = {cleanLog, LINE_MAX, KEY_BEGIN, KEY_END, openAfter, BARE_BODY, HIDDEN_CLASS};
