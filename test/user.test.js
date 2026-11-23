'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { accountUsername } = require('../src/user');

test('report name: first available of profile display name, full name, git name, email name, OS user', () => {
  const none = () => '';
  assert.strictEqual(accountUsername({ account: { displayName: 'Haitham', fullName: 'H. I.', emailAddress: 'x@y.z' }, git: () => 'git', osUser: () => 'os' }), 'Haitham');
  assert.strictEqual(accountUsername({ account: { fullName: '  Haitham   Ibrahim ', emailAddress: 'x@y.z' }, git: () => 'git', osUser: () => 'os' }), 'Haitham Ibrahim');
  assert.strictEqual(accountUsername({ account: { emailAddress: 'faz3vids.ai@x.com' }, git: () => 'haitham72', osUser: () => 'os' }), 'haitham72');
  assert.strictEqual(accountUsername({ account: { emailAddress: 'faz3vids.ai@x.com' }, git: none, osUser: () => 'os' }), 'faz3vids.ai');
  assert.strictEqual(accountUsername({ account: {}, git: none, osUser: () => 'h.ibrahim' }), 'h.ibrahim');
  assert.strictEqual(accountUsername({ account: { displayName: 'me@mail.com' }, git: none, osUser: none }), 'user', 'never an email address');
});
