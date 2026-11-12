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
// CSI (colours, erase), OSC (hyperlinks, titles; BEL or ST ended), character
// set selects, and the other two-byte escapes.
const ANSI = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+][0-9A-Za-z]|[\x40-\x5f])/g;
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
    const line = withAnsi.replace(ANSI, '').trimEnd();
    if (inHeader) {
      if (ENDGROUP.test(line)) inHeader = false;
      return;
    }
    const group = GROUP.exec(line);
    if (group) {
      const next = i + 1 < visible.length ? visible[i + 1] : '';
      // A header holds the cyan command echo, a uses: step's with:/env: block,
      // or, for an action with no inputs, nothing at all; an empty group a
      // script opens ("Run migrations") is not an action reference.
      const nextLine = next.replace(ANSI, '');
      const name = group[1].trim();
      if (STEP_HEADER.test(name) && (next.startsWith(CYAN) || USES_BLOCK.test(nextLine) || (ENDGROUP.test(nextLine) && ACTION_REF.test(name)))) {
        open(name);
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
    current.lines.push(line);
    kept++;
  });
  if (current.name !== TOP || current.lines.length > 0) steps.push(current);
  return {steps, totalLines: raw.length, kept};
}

module.exports = {cleanLog};
