'use strict';

const { countDistinct, dataRows, findTotalsRow, parseAmount } = require('./rules');

/**
 * GRN section — Daily Report columns H, I and J.
 *
 *   H  Total no. of GRN   ← PO No.            distinct
 *   I  GRN Itemwise       ← Drug Description  distinct drug names
 *   J  Total GRN Value    ← Grand Total       read straight off the totals row
 *
 * No AUTO / suffix filtering here: the GRN section of the mapping document
 * applies neither rule, so every receipt line counts.
 */
function mapGrn(sheet, log) {
  const idFields = ['po no', 'grn no', 'drug description'];

  const totals = findTotalsRow(sheet.records, ['sno', 'po no', 'grn no', 'drug description'], 'grand total');
  const all = dataRows(sheet.records, idFields);
  log.info(`${all.length} GRN line rows read (no AUTO/suffix filter applies to this section)`);

  const h = countDistinct(all, 'po no');
  const i = countDistinct(all, 'drug description');
  log.ok(`H · Total no. of GRN = ${h.count}`, { values: h.values });
  log.ok(`I · GRN Itemwise = ${i.count}`, { values: i.values });

  let j = null;
  if (totals) {
    j = totals.amount;
    log.ok(`J · Total GRN Value = ${fmt(j)}  (totals row ${totals.row}, taken as printed)`);
  } else {
    const summed = all.reduce((a, r) => a + (parseAmount(r['grand total']) || 0), 0);
    log.warn(
      `J · no totals row found at the bottom of the sheet — Grand Total left blank. ` +
      `For reference, the data rows sum to ${fmt(summed)}.`,
    );
  }

  return {
    H: h.count,
    I: i.count,
    J: j,
    audit: {
      rowsRead: all.length,
      poNumbers: h.values,
      drugDescriptions: i.values,
      grnNumbers: countDistinct(all, 'grn no').values,
      totalsRow: totals ? totals.row : null,
    },
  };
}

function fmt(n) {
  return n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { mapGrn };
