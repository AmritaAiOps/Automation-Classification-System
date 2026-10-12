'use strict';

const {
  isAutoPrq, hasLetterSuffix, countDistinct, dataRows, findTotalsRow, dropWhere, totalOrWarn,
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

  const auto = dropWhere(all, isAutoPrq, 'prq no');
  if (auto.dropped) {
    log.info(
      `filter 1 — dropped ${auto.dropped} row(s) on ${auto.values.length} AUTO PRQ(s)`,
      { values: auto.values },
    );
  } else {
    log.info('filter 1 — no AUTO PRQ rows in the PO file');
  }

  const suffix = dropWhere(auto.kept, hasLetterSuffix, 'po no');
  const kept = suffix.kept;
  if (suffix.dropped) {
    log.info(
      `filter 2 — dropped ${suffix.dropped} row(s) on ${suffix.values.length} suffixed (split/amended) PO(s)`,
      { values: suffix.values },
    );
  } else {
    log.info('filter 2 — no suffixed PO numbers among the rows that survived filter 1');
  }

  const e = countDistinct(kept, 'po no');
  const f = countDistinct(kept, 'item name');
  log.ok(`E · PO Created = ${e.count}`, { values: e.values });
  log.ok(`F · PO Items = ${f.count}`, { values: f.values });

  const g = totalOrWarn(log, totals, 'G · Total PO Value', kept, 'filtered rows');

  return {
    E: e.count,
    F: f.count,
    G: g,
    audit: {
      rowsRead: all.length,
      rowsKept: kept.length,
      autoPrqsDropped: auto.values,
      suffixedPosDropped: suffix.values,
      poNumbers: e.values,
      itemNames: f.values,
      totalsRow: totals ? totals.row : null,
    },
  };
}

module.exports = { mapPo };
