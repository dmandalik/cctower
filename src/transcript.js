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

function userText(e) {
  const c = e && e.message && e.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}

// Real transcripts write "[Request interrupted by user]"-style markers as
// user text entries when the user hits Esc or rejects a tool. They are not
// prompts, and they prove the user is at the keyboard.
function isInterruptionMarker(e) {
  return /^\s*\[Request interrupted/i.test(userText(e));
}

// A genuine human prompt (not a tool_result carrier, meta entry, or
// interruption marker — all of which real transcripts also store as "user").
function isHumanPrompt(e) {
  if (!e || e.type !== 'user' || !e.message || e.isMeta) return false;
  if (isInterruptionMarker(e)) return false;
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

// tool_use blocks that never received a tool_result AND have no user entry
// of any kind after them. A later user entry (tool_result for a sibling,
// interruption marker, denial) means the app already moved past the
// permission point — the call is dead, not blocked. Mid-turn, what remains
// is the currently executing or permission-blocked call.
function pendingToolUses(turn) {
  const results = toolResults(turn);
  const out = [];
  for (let i = 0; i < turn.length; i++) {
    if (!isAssistant(turn[i])) continue;
    const uses = blocks(turn[i]).filter((b) => b && b.type === 'tool_use');
    if (!uses.length) continue;
    const userAfter = turn.slice(i + 1).some((e) => e && e.type === 'user');
    for (const u of uses) {
      if (u.id && !results[u.id] && !userAfter) {
        out.push({ id: u.id, name: u.name, input: u.input || {} });
      }
    }
  }
  return out;
}

// Did the user interrupt or reject a tool call this turn? (User is present.)
function hasInterruption(turn) {
  for (const e of turn) {
    if (!e || e.type !== 'user') continue;
    if (isInterruptionMarker(e)) return true;
    const c = e.message && e.message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_result' && /doesn't want to proceed|user rejected/i.test(resultText(b.content))) {
          return true;
        }
      }
    }
  }
  return false;
}

// Parse only the tail of a transcript (default 256KB) — enough for the
// current turn's pending-tool check without paying for a huge file.
function readTailEntries(file, bytes = 262144) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let raw = buf.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1); // drop partial line
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* partial/corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Deterministic needs-input evidence from the turn's structure (no wording
// guesses). Returns a signal name or null:
//   'ask_user_question' — the final assistant message calls AskUserQuestion,
//     Claude Code's explicit ask-the-user tool.
//   'pending_tool_use'  — the turn ends on an assistant tool_use with no
//     matching tool_result, i.e. stalled waiting for permission.
function needsInputEvidence(turn) {
  const pend = pendingToolUses(turn); // already excludes interrupted/dead calls
  if (!pend.length) return null;
  if (pend.some((u) => u.name === 'AskUserQuestion')) return 'ask_user_question';
  return 'pending_tool_use';
}

// New (non-cached) input tokens attributable to this turn's prompt: the first
// assistant response after the human prompt, counting input_tokens +
// cache_creation but NOT cache_read. Cached context re-reads (usually the bulk
// of the tokens) aren't caused by the new prompt, so including them would
// dwarf the estimate and produce nonsense ratios. For a cached conversation
// this approximates the prompt's own token cost.
function turnNewInput(entries) {
  const humanIdx = lastHumanIndex(entries);
  for (let i = humanIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (isAssistant(e) && e.message.usage) {
      const u = e.message.usage;
      return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  }
  return null;
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
  pendingToolUses,
  hasInterruption,
  readTailEntries,
  needsInputEvidence,
  turnNewInput,
  hasCompaction,
};
