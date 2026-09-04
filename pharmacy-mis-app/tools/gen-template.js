'use strict';

/**
 * Bakes the reference workbook ("Daily Report for coding.xlsx") into
 * src/excel/template.js as base64, so the packaged exe carries the master
 * report's exact formatting — title band, header band, column widths, borders,
 * number formats — with no reference folder to ship alongside it.
 *
 * Re-run with:  node tools/gen-template.js [path-to-reference.xlsx]
 */

const fs = require('fs');
const path = require('path');

const src = process.argv[2] || path.join(__dirname, '..', '..', 'reference', 'Daily Report for coding.xlsx');
const out = path.join(__dirname, '..', 'src', 'excel', 'template.js');

if (!fs.existsSync(src)) {
  console.error(`Reference workbook not found: ${src}`);
  process.exit(1);
}

const b64 = fs.readFileSync(src).toString('base64');
const lines = b64.match(/.{1,120}/g) || [];

fs.writeFileSync(
  out,
  `'use strict';\n\n` +
  `/**\n` +
  ` * GENERATED FILE — do not edit by hand.\n` +
  ` * Produced by tools/gen-template.js from:\n` +
  ` *   ${path.basename(src)}  (${b64.length} base64 chars)\n` +
  ` *\n` +
  ` * This is the master report's reference format. A new month's master file is\n` +
  ` * seeded from it, then its historical data rows are cleared so the month\n` +
  ` * starts at row 1 — see src/excel/master.js.\n` +
  ` */\n\n` +
  `const TEMPLATE_BASE64 = [\n${lines.map((l) => `  '${l}',`).join('\n')}\n].join('');\n\n` +
  `module.exports = {\n` +
  `  TEMPLATE_BASE64,\n` +
  `  templateBuffer: () => Buffer.from(TEMPLATE_BASE64, 'base64'),\n` +
  `};\n`,
  'utf8',
);

console.log(`Wrote ${out} (${(b64.length / 1024).toFixed(1)} KB base64)`);
