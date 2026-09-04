'use strict';

const {
  isAutoPrq, hasLetterSuffix, countDistinct, dataRows, findTotalsRow, parseAmount, clean,
} = require('./rules');

/**
 * Purchase Order section — Daily Report columns E, F and G.
 *
 * Two filters apply, in this order, to the rows behind E and F:
 *   1. drop any row whose PRQ No. (inside the PO file) starts "AUTO"
 *   2. drop any row whose PO No. ends in a letter suffix — a split/amended PO
 *
 *   E  PO Created      ← PO No.       distinct, on the twice-filtered rows
 *   F  PO Items        ← Item Name    distinct drug names, same rows as E
 *   G  Total PO Value  ← Grand Total  read straight off the sheet's totals row
 *
 * G is deliberately NOT a sum of the filtered rows: the document says to take
 * the figure as printed on the totals row, which covers the whole sheet.
 */
function mapPo(sheet, log) {
  const idFields = ['po no', 'item name'];

  const totals = findTotalsRow(sheet.records, ['sno', 'po no', 'item name'], 'grand total');
  const all = dataRows(sheet.records, idFields);
  log.info(`${all.length} PO line rows read`);

  const afterAuto = [];
  const droppedAuto = new Set();
  for (const rec of all) {
    if (isAutoPrq(rec['prq no'])) { droppedAuto.add(clean(rec['prq no'])); continue; }
    afterAuto.push(rec);
  }
  if (droppedAuto.size) {
    log.info(
      `filter 1 — dropped ${all.length - afterAuto.length} row(s) on ${droppedAuto.size} AUTO PRQ(s)`,
      { values: [...droppedAuto].sort() },
    );
  } else {
    log.info('filter 1 — no AUTO PRQ rows in the PO file');
  }

  const kept = [];
  const droppedSuffix = new Set();
  for (const rec of afterAuto) {
    if (hasLetterSuffix(rec['po no'])) { droppedSuffix.add(clean(rec['po no'])); continue; }
    kept.push(rec);
  }
  if (droppedSuffix.size) {
    log.info(
      `filter 2 — dropped ${afterAuto.length - kept.length} row(s) on ${droppedSuffix.size} suffixed (split/amended) PO(s)`,
      { values: [...droppedSuffix].sort() },
    );
  } else {
    log.info('filter 2 — no suffixed PO numbers among the rows that survived filter 1');
  }

  const e = countDistinct(kept, 'po no');
  const f = countDistinct(kept, 'item name');
  log.ok(`E · PO Created = ${e.count}`, { values: e.values });
  log.ok(`F · PO Items = ${f.count}`, { values: f.values });

  let g = null;
  if (totals) {
    g = totals.amount;
    log.ok(`G · Total PO Value = ${fmt(g)}  (totals row ${totals.row}, taken as printed)`);
  } else {
    const summed = kept.reduce((a, r) => a + (parseAmount(r['grand total']) || 0), 0);
    log.warn(
      `G · no totals row found at the bottom of the sheet — Grand Total left blank. ` +
      `For reference, the filtered rows sum to ${fmt(summed)}.`,
    );
  }

  return {
    E: e.count,
    F: f.count,
    G: g,
    audit: {
      rowsRead: all.length,
      rowsKept: kept.length,
      autoPrqsDropped: [...droppedAuto].sort(),
      suffixedPosDropped: [...droppedSuffix].sort(),
      poNumbers: e.values,
      itemNames: f.values,
      totalsRow: totals ? totals.row : null,
    },
  };
}

function fmt(n) {
  return n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { mapPo };
