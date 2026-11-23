'use strict';

const crypto = require('crypto');
const { toFragment } = require('./report-document');

// The report template is a page fragment. A VS Code webview needs a full
// document with a strict CSP, and follows the editor theme through the class
// VS Code puts on <body>.
function wrapForWebview(fragment, nonce = crypto.randomBytes(16).toString('base64')) {
  const body = toFragment(fragment).replace(/<script(?![^>]*type="application\/json")/g, `<script nonce="${nonce}"`);
  // The report's own Light/Dark choice wins; only System follows the editor theme.
  const theme = `(function(){var r=document.documentElement,b=document.body;function pick(){try{var s=localStorage.getItem('claude-report-theme');return s==='light'||s==='dark'?s:null}catch(e){return null}}function t(){var s=pick();if(s){r.setAttribute('data-theme',s);return}var l=b.classList.contains('vscode-light')||b.classList.contains('vscode-high-contrast-light');r.setAttribute('data-theme',l?'light':'dark')}t();new MutationObserver(t).observe(b,{attributes:true,attributeFilter:['class']});var sel=document.getElementById('theme');if(sel)sel.addEventListener('change',function(){setTimeout(t,0)})})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">` +
    `</head><body>${body}<script nonce="${nonce}">${theme}</script></body></html>`;
}

module.exports = { wrapForWebview };
