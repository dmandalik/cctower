'use strict';

// Deterministic prompt heuristics for the gate: a heaviness test and the lint
// rules. Lint returns at most one note (highest-priority match) — the SPEC is
// explicit that we never stack notes or nag on trivial prompts.

const SCOPE_VERBS = /\b(refactor|migrate|rewrite|overhaul|redesign|re-?architect|port)\b/i;
const SCOPE_WORDS = /\b(all|entire|every|everything|whole|across the (?:code|repo|project))\b/i;
const SUCCESS_CRITERIA = /\b(should|must|until|so that|test|verify|ensure|expect|pass(?:es|ing)?)\b/i;
const VAGUE_PHRASES =
  /\b(fix everything|clean up (?:the )?(?:code|everything)|make it better|improve the code|tidy (?:it|things) up)\b/i;

const FILE_REF =
  /(?:^|[\s`(])[\w./-]+\.(?:js|ts|jsx|tsx|py|json|md|go|rs|java|rb|c|cpp|h|hpp|cs|php|sh|css|scss|html|yml|yaml|toml|sql)\b/gi;

function countFileRefs(text) {
  return (String(text).match(FILE_REF) || []).length;
}

// A prompt is "heavy" if it has broad scope, is large, or fans across files.
function isHeavy(text, estHigh) {
  const t = String(text || '');
  if (SCOPE_VERBS.test(t)) return true;
  if (SCOPE_WORDS.test(t) && /\b(code|file|function|module|test|repo|project|class)\b/i.test(t))
    return true;
  if (estHigh > 2000) return true;
  if (countFileRefs(t) >= 4) return true;
  return false;
}

// Longest fenced code block, in characters (0 if none).
function largestFencedBlock(text) {
  let max = 0;
  const re = /```[\w-]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) max = Math.max(max, m[1].length);
  return max;
}

// Rough token estimate for a chunk of text (~4 chars/token) — cheap, no encode.
function roughTokens(chars) {
  return Math.round(chars / 4);
}

function hasNounAnchor(text) {
  return countFileRefs(text) > 0 || /`[^`]+`/.test(text) || /\b[a-z]+[A-Z]\w*\b/.test(text);
}

// Returns { note } (one line) or null. `ctx` carries what the gate already
// computed so we don't recompute: { prompt, estHigh, heavy, model, transcript }.
function lint(ctx) {
  const { prompt = '', estHigh = 0, heavy = false, model = '', transcript = '' } = ctx;

  // 1. Heavy task with no definition of done.
  if (heavy && !SUCCESS_CRITERIA.test(prompt)) {
    return { note: "heavy task with no success criteria — say what 'done' looks like" };
  }

  // 2. Vague scope with nothing concrete to anchor on.
  if (VAGUE_PHRASES.test(prompt) || (SCOPE_WORDS.test(prompt) && !hasNounAnchor(prompt))) {
    return { note: 'vague scope — name the files, symbols, or behavior to change' };
  }

  // 3. A big paste that's already in the conversation.
  const fenceChars = largestFencedBlock(prompt);
  if (fenceChars > 0 && roughTokens(fenceChars) > 400 && transcript) {
    const block = /```[\w-]*\n([\s\S]*?)```/.exec(prompt);
    const needle = block && block[1].trim().slice(0, 200);
    if (needle && transcript.includes(needle)) {
      return { note: "that paste is already in context — reference it instead of re-pasting" };
    }
  }

  // 4. A huge inline paste that looks like a file.
  if (roughTokens(fenceChars) > 400) {
    return { note: 'large inline paste — reference the file instead of pasting it' };
  }

  // 5. Premium model on a throwaway prompt.
  if (/opus|fable/i.test(model) && !heavy && estHigh < 150) {
    return { note: 'premium model for a small prompt — /model to a lighter one saves quota' };
  }

  return null;
}

module.exports = { lint, isHeavy, countFileRefs };
