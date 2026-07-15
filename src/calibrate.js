'use strict';

// Self-tuning: keep estimate-vs-actual pairs and derive a correction factor
// the estimator multiplies by. correction = median(actual/estimate) over the
// last 50 clean pairs, clamped to [0.5, 2.0]. Pure — the hook does the I/O.

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function appendPair(cal, estimate, actual) {
  const prior = cal && Array.isArray(cal.pairs) ? cal.pairs : [];
  const pairs = prior.concat([{ estimate, actual }]).slice(-200);

  const ratios = pairs
    .slice(-50)
    .filter((p) => p.estimate > 0 && p.actual > 0)
    .map((p) => p.actual / p.estimate);

  let correction = median(ratios);
  if (correction == null) correction = 1;
  correction = Math.min(2.0, Math.max(0.5, correction));

  return { pairs, correction };
}

// Median absolute % error over the last 50 pairs — used by status/report.
function accuracy(cal) {
  const pairs = cal && Array.isArray(cal.pairs) ? cal.pairs.slice(-50) : [];
  const errs = pairs
    .filter((p) => p.estimate > 0 && p.actual > 0)
    .map((p) => Math.abs(p.actual - p.estimate) / p.estimate);
  const med = median(errs);
  return med == null ? null : Math.round(med * 100);
}

module.exports = { appendPair, accuracy, median };
