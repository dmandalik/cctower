#!/usr/bin/env node
'use strict';

// Landing report (Stop). Slices the transcript for this turn, runs the
// deterministic "done ≠ correct" pipeline, writes a markdown card, prints a
// short summary, records the verdict (for the done toast), and self-tunes the
// estimator from the turn's real token usage. No LLM calls. Fail open.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { readStdinJson } = require('../io');
const { statePaths } = require('../paths');
const { readJson, writeJson, writeFileAtomic, appendEvent } = require('../state');
const T = require('../transcript');
const card = require('../card');
const { appendPair } = require('../calibrate');

const CARD_COOLDOWN_MS = 60_000;

function recentCard(sess, now) {
  return typeof sess.lastCardAt === 'number' && now - sess.lastCardAt < CARD_COOLDOWN_MS;
}

// git diff stats against the ref recorded at gate time. null when not a repo
// or the ref is unknown/invalid.
function gitDiff(cwd, ref) {
  if (!ref) return null;
  const dir = cwd || process.cwd();
  try {
    const numstat = execFileSync('git', ['-C', dir, 'diff', '--numstat', ref], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString();
    let insertions = 0;
    let deletions = 0;
    const files = [];
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const [a, d, f] = line.split('\t');
      insertions += Number(a) || 0;
      deletions += Number(d) || 0;
      if (f) files.push(f);
    }

    let todos = 0;
    const todoSamples = [];
    try {
      const diff = execFileSync('git', ['-C', dir, 'diff', ref], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).toString();
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++') && /\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
          todos++;
          if (todoSamples.length < 3) todoSamples.push(line.slice(1).trim().slice(0, 80));
        }
      }
    } catch {
      /* diff body optional */
    }
    return { filesChanged: files.length, insertions, deletions, files, todos, todoSamples };
  } catch {
    return null;
  }
}

function run() {
  const input = readStdinJson();
  if (input.stop_hook_active === true) return 0; // recursion guard

  const now = Date.now();
  const sp = statePaths();
  const sessFile = path.join(sp.sessions, `${input.session_id || 'unknown'}.json`);
  const sess = readJson(sessFile, {}) || {};
  if (recentCard(sess, now)) return 0; // 60s per-session cooldown

  const entries = T.readEntries(input.transcript_path);
  const turn = T.sliceTurn(entries);
  const gitRef = sess.lastPrompt && sess.lastPrompt.gitRef;
  const diff = gitDiff(input.cwd, gitRef);

  const result = card.analyze({
    uses: T.toolUses(turn),
    results: T.toolResults(turn),
    finalText: T.finalAssistantText(turn),
    diff,
  });

  // Self-tuning: append an estimate/actual pair on a clean turn.
  let correction;
  let actual;
  const estimate = sess.lastPrompt && sess.lastPrompt.estimate && sess.lastPrompt.estimate.low;
  try {
    const clean = T.humanCount(turn) === 1 && !T.hasCompaction(entries);
    if (estimate > 0 && clean) {
      actual = T.turnNewInput(entries);
      // Sanity guard: only calibrate on plausible pairs. A wildly off ratio
      // means the measurement caught context/tool churn, not the prompt — drop
      // it rather than let one bad turn poison the correction factor.
      const ratio = actual > 0 ? actual / estimate : 0;
      if (ratio >= 0.2 && ratio <= 5) {
        const next = appendPair(readJson(sp.calibration, {}) || {}, estimate, actual);
        writeJson(sp.calibration, next);
        correction = next.correction;
      }
    }
  } catch {
    /* self-tuning is best-effort */
  }

  // Write the card.
  fs.mkdirSync(sp.cards, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cardPath = path.join(sp.cards, `${input.session_id || 'session'}-${stamp}.md`);
  const rendered = { ...result, session: input.session_id, when: new Date().toISOString(), estimate, actual, correction, cardPath };
  writeFileAtomic(cardPath, card.renderCard(rendered));

  process.stdout.write(card.renderSummary(rendered).join('\n') + '\n');

  // Re-read to preserve fields the parallel Stop hook may have written.
  const fresh = readJson(sessFile, {}) || {};
  writeJson(sessFile, { ...fresh, verdict: result.verdict, lastCardAt: now, lastCardPath: cardPath });

  appendEvent({
    ts: new Date().toISOString(),
    event: 'land',
    session: input.session_id || null,
    verdict: result.verdict,
    files: result.files.paths.length,
  });
  return 0;
}

try {
  process.exit(run());
} catch {
  process.exit(0); // fail open
}
