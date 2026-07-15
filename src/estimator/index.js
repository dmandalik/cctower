'use strict';

// The estimator: turn prompt text + model into a token *range*, biased high.
// Layered pure functions (SPEC "Estimator"):
//   base o200k_base count  ->  content class  ->  model generation
//   ->  multiplier table   ->  per-user correction  ->  {low, high}.
// Never returns a single confident number.

const { countTokens } = require('gpt-tokenizer/encoding/o200k_base');
const M = require('./multipliers.json');

// --- content sniff -------------------------------------------------------
// Cheap regex heuristics; order matters (most specific first).

function sniff(text) {
  const t = text || '';
  if (!t.trim()) return 'prose';

  // cjk: a meaningful share of Han/Hiragana/Katakana/Hangul characters.
  const cjk = (t.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  if (cjk > 0 && cjk / t.length > 0.15) return 'cjk';

  // json: parses cleanly, or clearly looks like an object/array literal.
  const trimmed = t.trim();
  if (/^[[{]/.test(trimmed) && /[}\]]$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      if (/"\s*:\s*/.test(trimmed)) return 'json';
    }
  }

  // code: fenced blocks or strong syntax signals. Split python vs js/ts.
  const fenced = /```[\s\S]*```/.test(t);
  const pySignals = /\b(def |class |import |print\(|elif |self\.|lambda )/.test(t);
  const jsSignals =
    /\b(function |const |let |var |=>|require\(|export |=== )/.test(t) ||
    /;\s*$/m.test(t);
  if (fenced || pySignals || jsSignals) {
    if (pySignals && !jsSignals) return 'python';
    if (jsSignals && !pySignals) return 'js';
    // ambiguous fenced code: lean on whichever signal set is present.
    return pySignals ? 'python' : 'js';
  }

  // markdown: headings, lists, links, emphasis — prose with structure.
  if (/(^|\n)#{1,6}\s|\[[^\]]+\]\([^)]+\)|(^|\n)[-*]\s|(^|\n)>\s/.test(t)) {
    return 'markdown';
  }

  return 'prose';
}

// --- model generation ----------------------------------------------------
// Unknown / newer models default to new gen (the safer, higher multiplier).

function modelGeneration(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/claude-3/.test(id)) return 'old';
  if (/claude-sonnet-4-[56]\b/.test(id)) return 'old';
  if (/claude-opus-4-[56]\b/.test(id)) return 'old';
  if (/claude-haiku-4-5\b/.test(id)) return 'old';
  return 'new';
}

// --- multiplier lookup ---------------------------------------------------

function multiplierFor(gen, content) {
  if (gen === 'old') {
    const table = M.oldGen;
    if (content === 'python' || content === 'js') return table.code;
    return table[content] ?? table.prose;
  }
  const table = M.newGen;
  return table[content] ?? table.prose;
}

// Correction factor from calibration, clamped to a sane band.
function clampCorrection(c) {
  const n = Number.isFinite(c) ? c : 1;
  return Math.min(2.0, Math.max(0.5, n));
}

// --- estimate ------------------------------------------------------------

function estimate({ text = '', model = '', correction = 1 } = {}) {
  const base = countTokens(text);
  const content = sniff(text);
  const gen = modelGeneration(model);
  const multiplier = multiplierFor(gen, content);
  const corr = clampCorrection(correction);

  const point = base * multiplier * corr;
  const low = Math.round(point);
  const high = Math.round(point * M.highBias);

  return { base, content, gen, multiplier, correction: corr, low, high };
}

// "1240" -> "1.2k", "820" -> "820". Used by the gate's advise line.
function humanTokens(n) {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

module.exports = {
  estimate,
  sniff,
  modelGeneration,
  multiplierFor,
  clampCorrection,
  humanTokens,
};
