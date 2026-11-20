'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { editProject } = require('../src/report-editor');

function mockEditor(choices, inputs = [], confirm) {
  const prompts = [];
  return {
    prompts,
    window: {
      async showQuickPick(items) {
        const label = choices.shift();
        if (label === undefined) return undefined;
        const selected = items.find((item) => (item.label || item) === label);
        assert.ok(selected, `Expected ${label} in the menu`);
        return selected;
      },
      async showInputBox(options) {
        prompts.push(options);
        const value = inputs.shift();
        if (value !== undefined) assert.equal(options.validateInput(value), undefined);
        return value;
      },
      async showWarningMessage() { return confirm; }
    }
  };
}

const row = {
  name: 'Project', id: 'project-id', prompts: 12,
  report: { project: 'Project', summary: 'Existing summary', usedFor: ['Reviewed changes'], didntWork: [], nextMonth: [],
    examples: [{ task: 'Old example', a: 3, b: 0.5 }]
  }
};

test('renames a project without changing its key or overriding generated text', async () => {
  const other = { name: 'Another', report: {} };
  const vscode = mockEditor(['Project', 'Rename project'], ['New name']);
  const result = await editProject(vscode, { projects: [row, other] });
  assert.equal(vscode.prompts[0].validateInput(' Another '), 'Another project already uses that name.');
  assert.equal(result.project, row);
  assert.deepEqual(result.replacement, { ...row, name: 'New name', baseName: 'Project', report: { ...row.report, project: 'New name' } });
  assert.deepEqual(result.overrides, {});
});

test('records a new example with manual timings while preserving numeric legacy examples', async () => {
  const vscode = mockEditor(['Project', 'Examples', 'Add an item'], ['Review .env', 'Checked both themes', 'Verified the behavior', '45 min', '2.5']);
  const { replacement, overrides } = await editProject(vscode, { projects: [row] });
  assert.deepEqual(overrides, { examples: [
    { task: 'Old example', withoutAI: '3 h', withAI: '0.5 h' },
    { task: 'Review [redacted]', detail: 'Checked both themes', basis: 'Verified the behavior', withAI: '45 min', withoutAI: '2.5 h', timeSource: 'reported' }
  ] });
  assert.deepEqual(replacement.report.examples, [
    { ...overrides.examples[0], a: 3, b: 0.5 },
    { ...overrides.examples[1], a: 2.5, b: 0.75 }
  ]);
  assert.match(vscode.prompts[3].validateInput('-1 h'), /Enter hours/);
});

test('an unchanged example or a cancelled prompt leaves the revision untouched', async () => {
  const choices = ['Project', 'Examples', 'Old example', 'Edit this item'];
  const data = { projects: [row] };
  assert.equal(await editProject(mockEditor([...choices], ['Old example', '', '', '0.5 h', '3 h']), data), undefined);
  assert.equal(await editProject(mockEditor([...choices], ['New task', 'Basis', undefined]), data), undefined);
  assert.equal(row.report.examples[0].task, 'Old example');
});

test('removes list items and offers confirmation before removing a project', async () => {
  const data = { projects: [row] };
  const { replacement, overrides } = await editProject(mockEditor(['Project', 'How AI was used', 'Reviewed changes', 'Remove this item']), data);
  assert.deepEqual(overrides, { usedFor: [] });
  assert.deepEqual(replacement.report.usedFor, []);
  assert.equal(await editProject(mockEditor(['Project', 'Remove project']), data), undefined);
  assert.deepEqual(await editProject(mockEditor(['Project', 'Remove project'], [], 'Remove project'), data), { project: row, remove: true });
});
