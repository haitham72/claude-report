'use strict';

const crypto = require('crypto');
const { toFragment } = require('./report-document');

// The report template is a page fragment. A VS Code webview needs a full
// document with a strict CSP, and follows the editor theme through the class
// VS Code puts on <body>.
function wrapForWebview(fragment, nonce = crypto.randomBytes(16).toString('base64')) {
  const body = toFragment(fragment).replace(/<script(?![^>]*type="application\/json")/g, `<script nonce="${nonce}"`);
  const theme = `(function(){var r=document.documentElement,b=document.body;function t(){var l=b.classList.contains('vscode-light')||b.classList.contains('vscode-high-contrast-light');r.setAttribute('data-theme',l?'light':'dark')}t();new MutationObserver(t).observe(b,{attributes:true,attributeFilter:['class']})})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">` +
    `</head><body>${body}<script nonce="${nonce}">${theme}</script></body></html>`;
}

module.exports = { wrapForWebview };
