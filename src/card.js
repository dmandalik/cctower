'use strict';

// The "done ≠ correct" analysis. Pure functions over an already-parsed turn
// plus git diff stats. No LLM calls (SPEC v1). Produces a verdict, a markdown
// card, and a short stdout summary.

// --- 1. files touched ----------------------------------------------------
function filesTouched(uses) {
  const paths = [];
  let edits = 0;
  let writes = 0;
  for (const u of uses) {
    if (u.name === 'Edit' || u.name === 'MultiEdit') {
      edits++;
      if (u.input.file_path) paths.push(u.input.file_path);
    } else if (u.name === 'Write') {
      writes++;
      if (u.input.file_path) paths.push(u.input.file_path);
    } else if (u.name === 'NotebookEdit') {
      edits++;
      if (u.input.notebook_path) paths.push(u.input.notebook_path);
    }
  }
  return { edits, writes, paths: [...new Set(paths)] };
}

// --- 3. tests / builds / lints -------------------------------------------
const TEST = [
  /pytest/, /jest/, /vitest/, /mocha/, /\brspec\b/, /phpunit/, /\bctest\b/,
  /go test/, /cargo test/, /gradle test/, /mvn test/, /dotnet test/, /bun test/,
  /node --test/, /npm (run )?test\b/, /yarn test\b/, /pnpm test\b/,
];
const LINT = [/eslint/, /npm run lint/, /\bruff\b/, /flake8/, /pylint/, /prettier/, /golangci-lint/, /clippy/];
const BUILD = [/npm run build/, /yarn build/, /pnpm build/, /\bmake\b/, /cargo build/, /go build/, /\btsc\b/, /gradle build/, /mvn package/, /bun build/];

function classifyCmd(cmd) {
  if (TEST.some((r) => r.test(cmd))) return 'test';
  if (LINT.some((r) => r.test(cmd))) return 'lint';
  if (BUILD.some((r) => r.test(cmd))) return 'build';
  return null;
}

function testRuns(uses, results) {
  const runs = [];
  for (const u of uses) {
    if (u.name !== 'Bash' || !u.input.command) continue;
    const kind = classifyCmd(u.input.command);
    if (!kind) continue;
    const r = results[u.id];
    let ok = null; // unknown if no result captured
    if (r) {
      if (r.isError) ok = false;
      else {
        const m = /exit (?:code|status)[:\s]+(\d+)/i.exec(r.text || '');
        ok = m ? Number(m[1]) === 0 : true;
      }
    }
    runs.push({ command: u.input.command, kind, ok });
  }
  return runs;
}

// --- 5. claims vs reality ------------------------------------------------
const CLAIM_PATTERNS = [
  { label: 'tests pass', kind: 'test', re: /\btests?\b[^.\n]{0,30}\b(pass|passing|passed|green)\b/i },
  { label: 'lint clean', kind: 'lint', re: /\blint(?:er)?\b[^.\n]{0,20}\b(clean|pass|passes|passing|green)\b/i },
  { label: 'builds', kind: 'build', re: /\b(builds|compiles)\b[^.\n]{0,20}\b(clean|success|successfully|fine|now)?\b|\bbuild (succeed|passe)/i },
  { label: 'ran it', kind: 'ran', re: /\bI\s+(ran|executed)\b|\bran the (tests?|suite|linter|build)\b/i },
  { label: 'verified', kind: 'verified', re: /\b(verified|confirmed)\b/i },
  { label: 'fixed', kind: 'fixed', re: /\b(fixed|resolved)\b/i },
];

function scanClaims(text, { tests, changed }) {
  const t = String(text || '');
  const testAny = tests.some((r) => r.kind === 'test');
  const testOk = tests.some((r) => r.kind === 'test' && r.ok === true);
  const testFail = tests.some((r) => r.kind === 'test' && r.ok === false);
  const lintOk = tests.some((r) => r.kind === 'lint' && r.ok === true);
  const buildOk = tests.some((r) => r.kind === 'build' && r.ok === true);
  const anyRun = tests.length > 0;
  const anyRunOk = tests.some((r) => r.ok === true);

  const out = [];
  for (const c of CLAIM_PATTERNS) {
    if (!c.re.test(t)) continue;
    let backed = false;
    let note = '';
    switch (c.kind) {
      case 'test':
        if (testFail) { backed = false; note = 'contradicted by a failing test'; }
        else if (testOk) { backed = true; }
        else { backed = false; note = testAny ? 'test result unknown' : 'claimed, not executed'; }
        break;
      case 'lint':
        backed = lintOk;
        if (!backed) note = 'claimed, not executed';
        break;
      case 'build':
        backed = buildOk;
        if (!backed) note = 'claimed, not executed';
        break;
      case 'ran':
        backed = anyRun;
        if (!backed) note = 'claimed, not executed';
        break;
      case 'verified':
        backed = anyRunOk;
        if (!backed) note = anyRun ? 'nothing passed' : 'claimed, not executed';
        break;
      case 'fixed':
        backed = changed;
        if (!backed) note = 'claimed, but nothing changed';
        break;
    }
    out.push({ label: c.label, backed, note });
  }
  return out;
}

// --- 6. verdict ----------------------------------------------------------
function decideVerdict({ files, diff, tests, claims }) {
  const changed = files.paths.length > 0 || (diff && diff.filesChanged > 0);
  const testFailed = tests.some((r) => r.ok === false);
  const testPassed = tests.some((r) => r.ok === true);
  const unbacked = claims.some((c) => !c.backed);

  if (testFailed) return 'FAILED';
  if (!changed && tests.length === 0) return 'NO-OP';
  if (testPassed && !unbacked) return 'VERIFIED';
  return 'UNVERIFIED';
}

// LAST-RESORT FALLBACK ONLY. The primary needs-input signal is deterministic
// transcript evidence (AskUserQuestion, or a mid-turn stalled tool_use seen
// by the widget's watcher). This check is intentionally strict — the final
// text must END on a question mark. Phrase matching ("let me know…") was
// removed: Claude's polite closings made completed turns read as questions.
function awaitsInput(text) {
  const t = String(text || '').trim();
  return /\?\s*$/.test(t);
}

// Commands that legitimately run quiet for a long time — a pending tool_use
// on one of these is normal execution, not a permission stall.
const LONG_RUNNING_RE = /\b(install|ci|update|upgrade|download|clone|fetch|pull|push|curl|wget|sleep|watch|serve|start|dev|deploy|docker|compose|migrate|seed|train)\b/i;
function looksLongRunning(cmd) {
  const c = String(cmd || '');
  return !!classifyCmd(c) || LONG_RUNNING_RE.test(c);
}

function analyze({ uses = [], results = {}, finalText = '', diff = null } = {}) {
  const files = filesTouched(uses);
  const tests = testRuns(uses, results);
  const changed = files.paths.length > 0 || (diff && diff.filesChanged > 0);
  const claims = scanClaims(finalText, { tests, changed });
  const verdict = decideVerdict({ files, diff, tests, claims });
  return { files, tests, claims, diff, changed, verdict };
}

// --- rendering -----------------------------------------------------------
const MARK = { true: '✅', false: '❌', null: '·' };

function claimMark(c) {
  return c.backed ? '✅' : c.note.includes('not executed') ? '⚠️' : '❌';
}

function renderCard(r) {
  const L = [];
  L.push('# cctower landing report', '');
  L.push(`**Verdict:** ${r.verdict}`);
  if (r.when) L.push(`**When:** ${r.when}`);
  if (r.session) L.push(`**Session:** ${r.session}`);
  L.push('');

  L.push('## Changed');
  if (r.files.edits || r.files.writes) L.push(`- ${r.files.edits} edited, ${r.files.writes} written`);
  if (r.diff) L.push(`- git: ${r.diff.filesChanged} files, +${r.diff.insertions} −${r.diff.deletions}`);
  if (r.files.paths.length) L.push(`- ${r.files.paths.join(', ')}`);
  if (!r.changed) L.push('- (nothing changed)');
  L.push('');

  L.push('## Tests & builds');
  if (r.tests.length) for (const t of r.tests) L.push(`- \`${t.command}\` — ${t.kind} — ${MARK[String(t.ok)]}`);
  else L.push('- none run');
  L.push('');

  if (r.claims.length) {
    L.push('## Claims check');
    for (const c of r.claims) L.push(`- "${c.label}" — ${claimMark(c)}${c.note ? ' ' + c.note : ' backed'}`);
    L.push('');
  }

  if (r.diff && r.diff.todos) {
    L.push('## New TODO/FIXME');
    for (const s of r.diff.todoSamples || []) L.push(`- ${s}`);
    L.push('');
  }

  if (r.estimate && r.actual) {
    L.push('## Estimate vs actual');
    L.push(`- estimated ~${r.estimate} · actual ${r.actual}${r.correction ? ` · correction now x${r.correction.toFixed(2)}` : ''}`);
    L.push('');
  }
  return L.join('\n');
}

function renderSummary(r) {
  const lines = [];
  const changed = r.diff
    ? `${r.diff.filesChanged} files (+${r.diff.insertions} −${r.diff.deletions})`
    : `${r.files.paths.length} files`;
  lines.push(`[cctower] ${r.verdict} — ${changed} changed`);

  if (r.tests.length) {
    lines.push('[cctower] ' + r.tests.map((t) => `${t.kind} ${MARK[String(t.ok)]}`).join(' · '));
  }
  const flagged = r.claims.filter((c) => !c.backed);
  if (flagged.length) {
    lines.push(`[cctower] ⚠️ ${flagged.length} unbacked claim(s): ${flagged.map((c) => `"${c.label}"`).join(', ')}`);
  }
  if (r.diff && r.diff.todos) lines.push(`[cctower] ${r.diff.todos} new TODO/FIXME in the diff`);
  if (r.cardPath) lines.push(`[cctower] card: ${r.cardPath}`);
  return lines.slice(0, 6);
}

module.exports = {
  analyze,
  awaitsInput,
  looksLongRunning,
  renderCard,
  renderSummary,
  filesTouched,
  testRuns,
  scanClaims,
  classifyCmd,
  decideVerdict,
};
