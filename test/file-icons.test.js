// file-icons.test.js
// Tests for file kind icons in the file tree and binary viewer

import { kindFromPath } from '../js/file-kind.js';

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected "${expected}", got "${actual}"`);
  }
}

function assertUndefined(actual, msg) {
  if (actual !== undefined) {
    throw new Error(`${msg}: expected undefined, got "${actual}"`);
  }
}

// PDF
assertEqual(kindFromPath('a.pdf').icon, '📕', 'pdf icon');

// Word / Document
assertEqual(kindFromPath('a.docx').icon, '📘', 'docx icon');
assertEqual(kindFromPath('a.doc').icon, '📘', 'doc icon');
assertEqual(kindFromPath('a.odt').icon, '📘', 'odt icon');
assertEqual(kindFromPath('a.rtf').icon, '📘', 'rtf icon');

// Excel / Spreadsheet
assertEqual(kindFromPath('a.xlsx').icon, '📗', 'xlsx icon');
assertEqual(kindFromPath('a.xls').icon, '📗', 'xls icon');
assertEqual(kindFromPath('a.ods').icon, '📗', 'ods icon');

// PowerPoint / Presentation
assertEqual(kindFromPath('a.pptx').icon, '📙', 'pptx icon');
assertEqual(kindFromPath('a.ppt').icon, '📙', 'ppt icon');
assertEqual(kindFromPath('a.odp').icon, '📙', 'odp icon');

// Other kinds are unaffected
assertUndefined(kindFromPath('a.md').icon, 'md icon should be undefined');
assertUndefined(kindFromPath('a.png').icon, 'png icon should be undefined');

console.log('All tests passed');