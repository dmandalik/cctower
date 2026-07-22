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
const { readJson, writeJson, writeFileAtomic, appendEvent, loadConfig } = require('../state');
const { notify } = require('../notify');
const T = require('../transcript');
const card = require('../card');
const { appendPair } = require('../calibrate');

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

  const entries = T.readEntries(input.transcript_path);
  const turn = T.sliceTurn(entries);

  // Dedupe duplicate Stop firings for the SAME turn by transcript position —
  // a time-based cooldown here used to swallow legitimate consecutive turns
  // (two prompts inside 60s meant the second got no card and no state).
  const last = entries[entries.length - 1];
  const turnMark = entries.length + ':' + ((last && last.timestamp) || '');
  if (entries.length && sess.lastCardMark === turnMark) return 0;
  const gitRef = sess.lastPrompt && sess.lastPrompt.gitRef;
  const diff = gitDiff(input.cwd, gitRef);

  const finalText = T.finalAssistantText(turn);
  const result = card.analyze({
    uses: T.toolUses(turn),
    results: T.toolResults(turn),
    finalText,
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

  // Post-turn state drives the orb:
  //   FAILED verdict -> issue (red)
  //   needs-input    -> waiting (yellow): an AskUserQuestion left in the final
  //                     message, or (fallback) final text ending on a question.
  //                     A pending ordinary tool_use at Stop time is NOT
  //                     needs-input — the turn is over, so it means the user
  //                     interrupted or the file write raced; permission stalls
  //                     happen MID-turn and are caught by the widget watcher.
  //   otherwise      -> done (blue)
  let state = 'done';
  const evidence = T.needsInputEvidence(turn);
  const interrupted = T.hasInterruption(turn);
  if (result.verdict === 'FAILED') state = 'issue';
  else if (interrupted) state = 'done'; // user hit Esc / rejected — they're present
  else if (evidence === 'ask_user_question' || card.awaitsInput(finalText)) state = 'waiting';

  // Re-read to preserve fields the parallel Stop hook may have written.
  const fresh = readJson(sessFile, {}) || {};
  const proj = input.cwd ? path.basename(String(input.cwd)) : fresh.project;
  writeJson(sessFile, {
    ...fresh,
    project: proj || fresh.project,
    verdict: result.verdict,
    state,
    stall: false, // any mid-turn stall is over once the turn lands
    lastCardMark: turnMark,
    lastCardAt: now,
    lastCardPath: cardPath,
  });

  // Notify per state (land owns this — it knows the verdict + final message).
  const cfg = loadConfig();
  const muted = Array.isArray(cfg.mutedProjects) && cfg.mutedProjects.includes(proj);
  let toggle = cfg.notifications.done;
  let title = `✓ Claude done · ${proj}`;
  let urgent = false;
  if (state === 'issue') {
    title = `⚠ Claude hit an issue · ${proj}`;
    urgent = true;
  } else if (state === 'waiting') {
    toggle = cfg.notifications.needsInput;
    title = `● Claude needs your input · ${proj}`;
  }
  if (toggle && !muted) {
    notify({ title, message: `${result.verdict}`, urgent, sound: cfg.notifications.sound, group: input.session_id });
  }

  appendEvent({
    ts: new Date().toISOString(),
    event: 'land',
    session: input.session_id || null,
    verdict: result.verdict,
    state,
    files: result.files.paths.length,
  });
  return 0;
}

try {
  process.exit(run());
} catch {
  process.exit(0); // fail open
}
