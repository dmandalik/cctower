'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { lintAll, insightLine, isHeavy, countAsks } = require('../src/lint');

// Helper: run lintAll with sane defaults, overriding what the test needs.
function run(ctx) {
  return lintAll({ prompt: '', estHigh: 100, heavy: false, model: '', config: {}, ...ctx });
}

function find(insights, rule) {
  return insights.find((i) => i.rule === rule);
}

test('isHeavy fires on scope verbs, size, and file fan-out', () => {
  assert.ok(isHeavy('refactor the auth module', 100));
  assert.ok(isHeavy('rewrite everything in the repo', 100));
  assert.ok(isHeavy('tiny tweak', 2500));
  assert.ok(isHeavy('touch a.js b.py c.md d.json', 100));
  assert.ok(!isHeavy('add a null check to the parser', 100));
});

test('stale-reference quotes the missing path and suggests the real one', () => {
  const r = find(
    run({
      prompt: 'fix the bug in src/gate.js please',
      fileExists: () => false,
      repo: { recent: [], all: ['src/hooks/gate.js', 'src/state.js'] },
    }),
    'stale-reference',
  );
  assert.match(r.evidence, /src\/gate\.js doesn't exist/);
  assert.match(r.fix, /src\/hooks\/gate\.js/);
});

test('stale-reference stays silent for files being created (no near-match)', () => {
  const insights = run({
    prompt: 'create tests/test_alpaca_retry.py with two cases',
    fileExists: () => false,
    repo: { recent: [], all: ['src/other.js'] },
  });
  assert.ok(!find(insights, 'stale-reference'));
});

test('duplicate-paste says the block is already in this chat', () => {
  const body = 'function widget() { return 42; }\n'.repeat(60);
  const r = find(
    run({ prompt: 'look at this\n```js\n' + body + '```', transcriptText: 'earlier:\n' + body }),
    'duplicate-paste',
  );
  assert.match(r.evidence, /appeared earlier in this chat/);
  assert.match(r.fix, /instead of re-pasting/);
});

test('paste-is-file identifies the file on disk and quantifies the saving', () => {
  const content = 'const x = 1;\n'.repeat(200);
  const r = find(
    run({
      prompt: 'here it is\n```js\n' + content + '```',
      repo: { recent: ['src/form.js'], all: [] },
      readFile: (f) => (f === 'src/form.js' ? content : null),
    }),
    'paste-is-file',
  );
  assert.match(r.evidence, /is src\/form\.js/);
  assert.match(r.fix, /reference src\/form\.js by path/);
});

test('unresolved-failure fires only when the prompt ignores a FAILED turn', () => {
  const hit = find(run({ prompt: 'now add dark mode to the settings page', lastVerdict: 'FAILED' }), 'unresolved-failure');
  assert.ok(hit);
  const addressed = find(run({ prompt: 'fix the failing test first', lastVerdict: 'FAILED' }), 'unresolved-failure');
  assert.ok(!addressed);
});

test('no-success-criteria quotes the scope words it matched', () => {
  const r = find(run({ prompt: 'refactor the entire pipeline', heavy: true }), 'no-success-criteria');
  assert.match(r.evidence, /"refactor"/);
  assert.match(r.fix, /so that/);
});

test('vague-scope quotes the phrase and suggests recently-changed anchors', () => {
  const r = find(
    run({ prompt: 'clean up the code', repo: { recent: ['src/ui/index.html', 'src/lint.js'], all: [] } }),
    'vague-scope',
  );
  assert.match(r.evidence, /clean up the code/);
  assert.match(r.fix, /src\/ui\/index\.html/);
});

test('vague-scope needs a code context — "every response" alone is not scope', () => {
  assert.ok(!find(run({ prompt: 'after every response tell me the time' }), 'vague-scope'));
});

test('problem-without-evidence asks for the error text', () => {
  const r = find(run({ prompt: 'the widget is broken again' }), 'problem-without-evidence');
  assert.match(r.evidence, /"broken"/);
  assert.match(r.fix, /paste the exact error/);
  assert.ok(!find(run({ prompt: 'it is broken, error: ENOENT at line 3' }), 'problem-without-evidence'), 'evidence present -> silent');
});

test('multi-ask counts numbered asks and respects its own toggle', () => {
  const prompt = '1) add a button 2) fix the color 3) rename the file 4) update the docs';
  assert.ok(countAsks(prompt) >= 4);
  assert.ok(find(run({ prompt }), 'multi-ask'));
  assert.ok(!find(run({ prompt, config: { lintMultiAsk: false } }), 'multi-ask'), 'toggle off silences it');
});

test('repeated-instruction spots a sentence already said in this chat', () => {
  const sentence = 'always give me the exact commands to run after every single change you make';
  const r = find(run({ prompt: `ok now ${sentence}.`, prevPrompts: [`earlier: ${sentence} please`] }), 'repeated-instruction');
  assert.match(r.evidence, /already said earlier/);
});

test('premium-model includes the numbers', () => {
  const r = find(run({ prompt: 'say hi', estHigh: 40, model: 'claude-fable-5' }), 'premium-model');
  assert.match(r.evidence, /~40 tokens on claude-fable-5/);
});

test('a clean prompt yields no insights at all', () => {
  const insights = run({
    prompt: 'add a null check in src/parser.js so the empty-input test passes',
    fileExists: () => true,
  });
  assert.deepStrictEqual(insights, []);
});

test('insightLine renders note + evidence + fix', () => {
  assert.strictEqual(
    insightLine({ note: 'n', evidence: 'e', fix: 'f' }),
    'n: e — f',
  );
});

test('the whole engine stays inside the hook budget', () => {
  const prevPrompts = Array.from({ length: 20 }, (_, i) => `previous prompt number ${i} with plenty of words to shingle over and over`);
  const t = process.hrtime.bigint();
  run({ prompt: 'refactor everything '.repeat(200), heavy: true, prevPrompts, transcriptText: 'x'.repeat(500000) });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 50, `lintAll took ${ms.toFixed(1)}ms`);
});
