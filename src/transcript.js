'use strict';

// Tolerant reader for Claude Code transcript JSONL. Every accessor
// feature-detects and degrades to empty rather than throwing — transcript
// shapes evolve and a half-written last line is normal. See SPEC reference
// shapes; verified fields: message.content blocks (text | tool_use |
// tool_result), message.usage.{input,cache_creation,cache_read,output}_tokens.

const fs = require('fs');

function readEntries(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a partial/corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function isAssistant(e) {
  return !!(e && e.type === 'assistant' && e.message);
}

function blocks(e) {
  const c = e && e.message && e.message.content;
  return Array.isArray(c) ? c : [];
}

// A genuine human prompt (not a tool_result carrier).
function isHumanPrompt(e) {
  if (!e || e.type !== 'user' || !e.message) return false;
  const c = e.message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) {
    const hasResult = c.some((b) => b && b.type === 'tool_result');
    const hasText = c.some((b) => b && b.type === 'text');
    return hasText && !hasResult;
  }
  return false;
}

function lastHumanIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (isHumanPrompt(entries[i])) return i;
  return -1;
}

// Entries from the current turn's human prompt to the end.
function sliceTurn(entries) {
  const i = lastHumanIndex(entries);
  return i === -1 ? entries.slice() : entries.slice(i);
}

function toolUses(turn) {
  const out = [];
  for (const e of turn) {
    if (!isAssistant(e)) continue;
    for (const b of blocks(e)) {
      if (b && b.type === 'tool_use') out.push({ id: b.id, name: b.name, input: b.input || {} });
    }
  }
  return out;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : (b && (b.text || b.content)) || '')).join('\n');
  }
  return '';
}

// tool_use_id -> { isError, text }
function toolResults(turn) {
  const map = {};
  for (const e of turn) {
    if (!e || e.type !== 'user' || !e.message) continue;
    const c = e.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_result' && b.tool_use_id) {
        map[b.tool_use_id] = { isError: !!b.is_error, text: resultText(b.content) };
      }
    }
  }
  return map;
}

function finalAssistantText(turn) {
  for (let i = turn.length - 1; i >= 0; i--) {
    if (isAssistant(turn[i])) {
      return blocks(turn[i])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }
  }
  return '';
}

function humanCount(turn) {
  return turn.filter(isHumanPrompt).length;
}

// input + cache_creation + cache_read (the "context in" for a response).
function usageIn(u) {
  if (!u) return null;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

// Actual input tokens attributable to this turn: the delta between this turn's
// last assistant usage and the last assistant usage of the previous turn.
function turnInputDelta(entries) {
  const humanIdx = lastHumanIndex(entries);
  const usages = [];
  entries.forEach((e, i) => {
    if (isAssistant(e) && e.message.usage) usages.push({ i, sum: usageIn(e.message.usage) });
  });
  if (!usages.length) return null;
  const cur = usages[usages.length - 1].sum;
  if (cur == null) return null;
  const prev = [...usages].reverse().find((u) => u.i < humanIdx);
  const delta = cur - (prev ? prev.sum : 0);
  return delta > 0 ? delta : cur;
}

// Conservative: only flag an obvious compaction/summary entry.
function hasCompaction(entries) {
  return entries.some(
    (e) => e && (e.type === 'summary' || e.isCompactSummary === true || e.compactMetadata),
  );
}

module.exports = {
  readEntries,
  sliceTurn,
  lastHumanIndex,
  toolUses,
  toolResults,
  finalAssistantText,
  humanCount,
  turnInputDelta,
  hasCompaction,
};
