'use strict';

const path = require('path');

/**
 * Which of the three source reports is this file?
 *
 * Filenames cannot be trusted — the portal exports "Pharmacy PRQ Details(1).CSV",
 * users rename files, and the Puppeteer half will name them differently again.
 * So identification is by FORMAT: the set of column headers the sheet actually
 * carries. The filename only breaks a tie between two equally-good matches.
 */

const SIGNATURES = [
  {
    kind: 'PRQ',
    label: 'Pharmacy PRQ Details',
    feeds: 'Daily Report columns C, D',
    // "auto prq(y/n)" and "required qty" appear in no other export.
    required: ['prq no', 'item name'],
    distinctive: ['auto prq(y/n)', 'required qty', 'po incl qty', 'parent po'],
    absent: ['grn no', 'grand total'],
    namePattern: /prq/i,
  },
  {
    kind: 'PO',
    label: 'Purchase Order Detail Report',
    feeds: 'Daily Report columns E, F, G',
    // The PO sheet is the only one carrying BOTH a PO No. and a PRQ No.
    required: ['po no', 'prq no', 'item name', 'grand total'],
    distinctive: ['po qty', 'item rate', 'item total', 'received qty'],
    absent: ['grn no'],
    namePattern: /purchase\s*order|(^|[^a-z])po([^a-z]|$)/i,
  },
  {
    kind: 'GRN',
    label: 'Purchase Report Pharmacy Detail (GRN)',
    feeds: 'Daily Report columns H, I, J',
    required: ['po no', 'grn no', 'drug description', 'grand total'],
    distinctive: ['grn date', 'grn status', 'grn type', 'invoice no', 'batch no'],
    absent: ['prq no'],
    namePattern: /purchase\s*report|grn/i,
  },
];

/**
 * Score a sheet against one signature.
 *   -1  → disqualified (a required column is missing, or a column that must
 *         not be present is)
 *   0+  → number of distinctive columns matched, plus the required ones
 */
function scoreSignature(headerSet, sig) {
  for (const key of sig.required) if (!headerSet.has(key)) return -1;
  for (const key of sig.absent) if (headerSet.has(key)) return -1;
  let score = sig.required.length * 2;
  for (const key of sig.distinctive) if (headerSet.has(key)) score += 1;
  return score;
}

/**
 * Identify a loaded sheet. Returns { kind, label, feeds, score, confidence,
 * reason } or a kind of 'UNKNOWN' with the reason it could not be placed.
 */
function identifySheet(sheet, filePath) {
  const headerSet = new Set(sheet.header.filter(Boolean));
  const base = filePath ? path.basename(filePath) : '';

  const scored = SIGNATURES.map((sig) => {
    let score = scoreSignature(headerSet, sig);
    const nameHit = score >= 0 && sig.namePattern.test(base);
    if (nameHit) score += 0.5; // tiebreak only — never enough to beat a format match
    return { sig, score, nameHit };
  }).filter((s) => s.score >= 0);

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      kind: 'UNKNOWN',
      label: base || 'unrecognised file',
      score: 0,
      confidence: 'none',
      reason: `Column layout matches none of the three known reports. Columns found: ${
        [...headerSet].slice(0, 12).join(', ') || '(none)'
      }`,
    };
  }

  const best = scored[0];
  const runnerUp = scored[1];
  const ambiguous = runnerUp && best.score - runnerUp.score < 1;

  const matchedDistinctive = best.sig.distinctive.filter((k) => headerSet.has(k));
  return {
    kind: best.sig.kind,
    label: best.sig.label,
    feeds: best.sig.feeds,
    score: best.score,
    confidence: ambiguous ? 'low' : 'high',
    reason:
      `matched on columns [${best.sig.required.join(', ')}]` +
      (matchedDistinctive.length ? ` + ${matchedDistinctive.length} distinctive (${matchedDistinctive.join(', ')})` : '') +
      (best.nameHit ? ' ; filename agrees' : ' ; filename gave no hint'),
  };
}

module.exports = { identifySheet };
