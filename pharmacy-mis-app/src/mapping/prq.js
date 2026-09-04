'use strict';

const { isAutoPrq, countDistinct, dataRows, clean } = require('./rules');

/**
 * PRQ section — Daily Report columns C and D.
 *
 *   C  Total no. of PRQ   ← PRQ No.     distinct, excluding any starting "AUTO"
 *   D  PRQ Itemwise       ← Item Name   distinct drug names on the same rows
 */
function mapPrq(sheet, log) {
  const all = dataRows(sheet.records, ['prq no', 'item name']);
  log.info(`${all.length} PRQ line rows read`);

  const kept = [];
  const droppedPrqs = new Set();
  for (const rec of all) {
    if (isAutoPrq(rec['prq no'])) {
      droppedPrqs.add(clean(rec['prq no']));
      continue;
    }
    kept.push(rec);
  }

  const dropped = all.length - kept.length;
  if (dropped) {
    log.info(
      `dropped ${dropped} row(s) on ${droppedPrqs.size} system-generated PRQ(s) starting "AUTO"`,
      { values: [...droppedPrqs].sort() },
    );
  } else {
    log.info('no AUTO PRQs present — nothing dropped');
  }

  const c = countDistinct(kept, 'prq no');
  const d = countDistinct(kept, 'item name');
  log.ok(`C · Total no. of PRQ = ${c.count}`, { values: c.values });
  log.ok(`D · PRQ Itemwise = ${d.count}`, { values: d.values });

  return {
    C: c.count,
    D: d.count,
    audit: {
      rowsRead: all.length,
      rowsKept: kept.length,
      rowsDropped: dropped,
      autoPrqsDropped: [...droppedPrqs].sort(),
      prqNumbers: c.values,
      itemNames: d.values,
    },
  };
}

module.exports = { mapPrq };
