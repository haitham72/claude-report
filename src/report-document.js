'use strict';

// The report template is a page fragment: the editor panel wraps it with its own strict document.
// A saved or exported file needs a real document so it opens in standards mode, in UTF-8, at phone width.
const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
const TAIL = '</html>';

const toDocument = (html) => /^\s*<!doctype/i.test(html) ? html : HEAD + html + TAIL;
const toFragment = (html) => html.startsWith(HEAD) && html.endsWith(TAIL) ? html.slice(HEAD.length, -TAIL.length) : html;

module.exports = { toDocument, toFragment };
