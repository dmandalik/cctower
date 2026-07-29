'use strict';

// Prompt lint: deterministic, prompt-SPECIFIC insights. Every rule returns
//   { rule, note, evidence, fix }
// where `evidence` quotes the offending part of the user's actual prompt and
// `fix` is a concrete suggestion — never a canned category line alone.
// Pure: all chat/repo context arrives via ctx (the gate does the I/O).
// No LLM anywhere (spec) — these are regex/fs/diff-grade checks. Each rule is
// individually fail-open.

const SCOPE_VERBS = /\b(refactor|migrate|rewrite|overhaul|redesign|re-?architect|port)\b/gi;
const SCOPE_WORDS = /\b(all|entire|every|everything|whole|across the (?:code|repo|project))\b/gi;
const SUCCESS_CRITERIA = /\b(should|must|until|so that|test|verify|ensure|expect|pass(?:es|ing)?)\b/i;
const VAGUE_PHRASES =
  /\b(fix everything|clean up (?:the )?(?:code|everything)|make it better|improve the code|tidy (?:it|things) up)\b/i;
const FILE_REF =
  /(?:^|[\s`("'])((?:[\w-]+\/)*[\w-]+\.(?:js|ts|jsx|tsx|py|json|md|go|rs|java|rb|c|cpp|h|hpp|cs|php|sh|css|scss|html|yml|yaml|toml|sql))\b/g;
const PROBLEM_WORDS = /\b(doesn'?t work|does not work|isn'?t working|not working|broken|keeps? failing|still fails?|there'?s a bug)\b/i;
const IMPERATIVE =
  /^(add|fix|make|change|update|remove|delete|create|implement|build|write|rename|move|refactor|explain|tell|show|give|verify|test|check|ensure|plan|start|stop|use|keep|put|include|display|render|hide)\b/i;

function quote(s, max = 60) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return `"${t.length > max ? t.slice(0, max - 1) + '…' : t}"`;
}

function matches(re, text) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < 4) out.push(m[1] || m[0]);
  return out;
}

function fileRefs(text) {
  return matches(FILE_REF, text);
}

function hasNounAnchor(text) {
  return fileRefs(text).length > 0 || /`[^`]+`/.test(text) || /\b[a-z]+[A-Z]\w*\b/.test(text);
}

function largestFencedBlock(text) {
  let best = '';
  const re = /```[\w-]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) if (m[1].length > best.length) best = m[1];
  return best;
}

function roughTokens(chars) {
  return Math.round(chars / 4);
}

// A prompt is "heavy" if it has broad scope, is large, or fans across files.
function isHeavy(text, estHigh) {
  const t = String(text || '');
  SCOPE_VERBS.lastIndex = 0;
  SCOPE_WORDS.lastIndex = 0;
  if (SCOPE_VERBS.test(t)) return true;
  if (SCOPE_WORDS.test(t) && /\b(code|file|function|module|test|repo|project|class)\b/i.test(t)) return true;
  if (estHigh > 2000) return true;
  if (fileRefs(t).length >= 4) return true;
  return false;
}

function countAsks(prompt) {
  const numbered = (prompt.match(/(?:^|[\s(])\(?\d+[).:]\s/g) || []).length;
  if (numbered >= 2) return numbered;
  return prompt
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => IMPERATIVE.test(s)).length;
}

// 8-word shingles for repeated-instruction detection.
function shingles(text, n = 8) {
  const w = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

// ctx: { prompt, estHigh, heavy, model, transcriptText, prevPrompts, cwd,
//        repo: { recent: [paths], all: [paths] }, readFile(path)->string|null,
//        fileExists(path)->bool, lastVerdict, config }
// Returns ranked insights, most important first.
function lintAll(ctx) {
  const {
    prompt = '',
    estHigh = 0,
    heavy = false,
    model = '',
    transcriptText = '',
    prevPrompts = [],
    repo = { recent: [], all: [] },
    readFile = () => null,
    fileExists = () => false,
    lastVerdict = null,
    config = {},
  } = ctx;
  const out = [];
  const rule = (fn) => {
    try {
      const r = fn();
      if (r) out.push(r);
    } catch {
      /* each rule fails open */
    }
  };

  // 1. Stale reference: a named file that doesn't exist BUT a same-named file
  // does elsewhere — a typo or moved path. Requiring the near-match is what
  // keeps "create tests/foo.py"-style prompts (files that don't exist yet,
  // on purpose) from false-firing.
  rule(() => {
    for (const ref of fileRefs(prompt).slice(0, 5)) {
      if (fileExists(ref)) continue;
      const base = ref.split('/').pop();
      const near = (repo.all || []).find((f) => (f.endsWith('/' + base) || f === base) && f !== ref);
      if (!near) continue;
      return {
        rule: 'stale-reference',
        note: 'file not found',
        evidence: `${ref} doesn't exist in this repo`,
        fix: `did you mean ${near}?`,
      };
    }
    return null;
  });

  // 2. A big paste that's already in the conversation.
  rule(() => {
    const block = largestFencedBlock(prompt);
    if (roughTokens(block.length) <= 400 || !transcriptText) return null;
    const needle = block.trim().slice(0, 200);
    if (!needle || !transcriptText.includes(needle)) return null;
    return {
      rule: 'duplicate-paste',
      note: 'paste already in context',
      evidence: `the ~${roughTokens(block.length)}-token block starting ${quote(block, 40)} appeared earlier in this chat`,
      fix: 'refer to it ("the block above") instead of re-pasting',
    };
  });

  // 3. Huge paste that IS a file on disk — reference the path instead.
  rule(() => {
    const block = largestFencedBlock(prompt);
    if (roughTokens(block.length) <= 400) return null;
    const norm = (s) => s.replace(/\s+/g, '');
    const nb = norm(block).slice(0, 2000);
    if (nb.length > 100) {
      for (const f of (repo.recent || []).slice(0, 10)) {
        const content = readFile(f);
        if (content && norm(content).includes(nb)) {
          return {
            rule: 'paste-is-file',
            note: 'pasted a file that Claude can read itself',
            evidence: `the ~${roughTokens(block.length)}-token paste is ${f}`,
            fix: `reference ${f} by path — saves ~${Math.round(roughTokens(block.length) / 100) / 10}k tokens`,
          };
        }
      }
    }
    return {
      rule: 'huge-paste',
      note: 'large inline paste',
      evidence: `~${roughTokens(block.length)} tokens starting ${quote(block, 40)}`,
      fix: 'if this lives in a file, reference the path instead',
    };
  });

  // 4. Previous turn failed and this prompt ignores it.
  rule(() => {
    if (lastVerdict !== 'FAILED' || /\b(fix|fail|test|error|broke|revert)\b/i.test(prompt)) return null;
    return {
      rule: 'unresolved-failure',
      note: 'previous turn ended FAILED',
      evidence: 'a test or build failed last turn and this prompt starts new work',
      fix: 'address or explicitly defer it first (see the landing card)',
    };
  });

  // 5. Heavy task with no definition of done.
  rule(() => {
    if (!heavy || SUCCESS_CRITERIA.test(prompt)) return null;
    const words = [...new Set([...matches(SCOPE_VERBS, prompt), ...matches(SCOPE_WORDS, prompt)])];
    return {
      rule: 'no-success-criteria',
      note: 'heavy task with no success criteria',
      evidence: words.length ? `scope words ${words.map((w) => `"${w}"`).join(', ')} with no "done" definition` : 'no observable outcome stated',
      fix: 'add "…so that <tests pass / X behaves like Y>"',
    };
  });

  // 6. Vague scope with nothing concrete to anchor on.
  rule(() => {
    VAGUE_PHRASES.lastIndex = 0;
    SCOPE_WORDS.lastIndex = 0;
    const vague = prompt.match(VAGUE_PHRASES);
    // Broad words alone ("every response") aren't code scope — they only
    // count when the prompt is actually about code/files and has no anchor.
    const aboutCode = /\b(code|file|repo|project|module|class|function|test)s?\b/i.test(prompt);
    const broad = matches(SCOPE_WORDS, prompt);
    if (!vague && !(broad.length && aboutCode && !hasNounAnchor(prompt))) return null;
    if (!vague && hasNounAnchor(prompt)) return null;
    const anchors = (repo.recent || []).slice(0, 3);
    const phrase = vague ? vague[0] : broad[0];
    const idx = prompt.toLowerCase().indexOf(String(phrase).toLowerCase());
    const around = prompt.slice(Math.max(0, idx - 20), idx + 40);
    return {
      rule: 'vague-scope',
      note: 'vague scope',
      evidence: `${quote(around)} names no file or symbol`,
      fix: anchors.length ? `name a target — e.g. ${anchors.join(', ')} (recently changed)` : 'name the files, symbols, or behavior to change',
    };
  });

  // 7. "It's broken" with no evidence pasted.
  rule(() => {
    const m = prompt.match(PROBLEM_WORDS);
    if (!m) return null;
    if (/```/.test(prompt) || /\b(error|exception|traceback|exit code|stderr)\b[:\s]/i.test(prompt)) return null;
    return {
      rule: 'problem-without-evidence',
      note: 'problem reported without the evidence',
      evidence: `${quote(m[0])} but no error text or output is included`,
      fix: 'paste the exact error/output — saves a whole diagnostic round-trip',
    };
  });

  // 8. Many asks in one prompt (its own toggle: config.lintMultiAsk).
  // Numbered lists are explicit asks (fire at 4+); bare imperative sentences
  // over-count well-specified prompts ("Add X. Keep Y compatible. Make sure
  // tests pass.") so they need 6+ before this speaks up.
  rule(() => {
    if (config.lintMultiAsk === false) return null;
    const numbered = (prompt.match(/(?:^|[\s(])\(?\d+[).:]\s/g) || []).length;
    const n = countAsks(prompt);
    const threshold = numbered >= 2 ? 4 : 6;
    if (n < threshold) return null;
    return {
      rule: 'multi-ask',
      note: `${n} distinct asks in one prompt`,
      evidence: `numbered or imperative asks counted: ${n}`,
      fix: 'consider splitting — each ask gets more attention and a failure only loses one',
    };
  });

  // 9. Re-stating an instruction Claude already has.
  rule(() => {
    if (!prevPrompts.length) return null;
    const prev = new Set();
    for (const p of prevPrompts.slice(-20)) for (const s of shingles(p)) prev.add(s);
    if (!prev.size) return null;
    for (const sentence of prompt.split(/[.!?\n]+/)) {
      if (sentence.trim().split(/\s+/).length < 8) continue;
      for (const sh of shingles(sentence)) {
        if (prev.has(sh)) {
          return {
            rule: 'repeated-instruction',
            note: 'instruction repeated',
            evidence: `${quote(sentence)} was already said earlier in this chat`,
            fix: 'Claude still has it in context — no need to re-state',
          };
        }
      }
    }
    return null;
  });

  // 10. Premium model on a throwaway prompt.
  rule(() => {
    if (!/opus|fable/i.test(model) || heavy || estHigh >= 150) return null;
    return {
      rule: 'premium-model',
      note: 'premium model for a small prompt',
      evidence: `~${estHigh} tokens on ${model}`,
      fix: '/model to a lighter one saves quota',
    };
  });

  return out;
}

// One-line rendering of an insight for toasts / advise lines.
function insightLine(i) {
  return i.evidence ? `${i.note}: ${i.evidence} — ${i.fix}` : `${i.note} — ${i.fix}`;
}

module.exports = { lintAll, insightLine, isHeavy, countAsks, fileRefs };
