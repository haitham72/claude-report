'use strict';

const { hours, withExampleHours } = require('./render');
const { scrubDeep } = require('./scan');

const TEXT_FIELDS = [
  { label: 'Summary', field: 'summary' },
  { label: 'Examples', field: 'examples' },
  { label: 'How AI was used', field: 'usedFor' },
  { label: 'Didn’t work', field: 'didntWork' },
  { label: 'Next month', field: 'nextMonth' }
];
const DURATION = /^~?\s*\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*(?:h|hrs?|hours?|days?|mins?|minutes?)?$/i;

function editText(window, title, value = '', required = true) {
  return window.showInputBox({
    title, value,
    validateInput: (input) => required && !input.trim() ? 'Enter a value.' : undefined
  }).then((input) => input === undefined ? undefined : scrubDeep(input.trim()));
}

async function editDuration(window, title, previous = '') {
  const input = await window.showInputBox({
    title, value: previous, prompt: 'Enter hours, a duration such as 45 min, or leave this empty.',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed === previous) return undefined;
      if (DURATION.test(trimmed) && Number.isFinite(hours(/[a-z]/i.test(trimmed) ? trimmed : `${trimmed} h`))) return undefined;
      return 'Enter hours or a duration such as 45 min or 2–3 h.';
    }
  });
  if (input === undefined) return undefined;
  const value = input.trim();
  return !value || value === previous || /[a-z]/i.test(value) ? value : `${value} h`;
}

function rawExample(example) {
  const { a, b, ...raw } = example;
  if (typeof raw.withoutAI !== 'string' || !raw.withoutAI) {
    const withoutAI = Number.isFinite(raw.withoutAI) ? raw.withoutAI : a;
    raw.withoutAI = Number.isFinite(withoutAI) ? `${withoutAI} h` : '';
  }
  if (typeof raw.withAI !== 'string' || !raw.withAI) {
    const withAI = Number.isFinite(raw.withAI) ? raw.withAI : b;
    raw.withAI = Number.isFinite(withAI) ? `${withAI} h` : '';
  }
  return raw;
}

async function editExample(window, previous = {}) {
  const task = await editText(window, 'Example task', previous.task);
  if (task === undefined) return undefined;
  const detail = await editText(window, 'Example details', previous.detail || '', false);
  if (detail === undefined) return undefined;
  const basis = await editText(window, 'Example basis', previous.basis || '', false);
  if (basis === undefined) return undefined;
  const withAI = await editDuration(window, 'Time spent with AI', previous.withAI);
  if (withAI === undefined) return undefined;
  const withoutAI = await editDuration(window, 'Time without AI', previous.withoutAI);
  if (withoutAI === undefined) return undefined;

  const timeChanged = withAI !== (previous.withAI || '') || withoutAI !== (previous.withoutAI || '');
  if (task === previous.task && detail === (previous.detail || '') && basis === (previous.basis || '') && !timeChanged) return previous;
  const next = { ...previous, task, basis, withAI, withoutAI };
  if (detail) next.detail = detail;
  else delete next.detail;
  if (timeChanged) {
    if (withAI || withoutAI) next.timeSource = 'reported';
    else delete next.timeSource;
  }
  return next;
}

async function editCollection(window, title, items, itemLabel, editItem) {
  const selected = await window.showQuickPick([
    { label: 'Add an item', add: true },
    ...items.map((item, index) => ({ label: itemLabel(item), index }))
  ], { title });
  if (!selected) return undefined;
  if (selected.add) {
    const added = await editItem();
    return added === undefined ? undefined : [...items, added];
  }
  const { index } = selected;
  const action = await window.showQuickPick(['Edit this item', 'Remove this item'], { title: selected.label });
  if (action === 'Remove this item') return items.filter((_, itemIndex) => itemIndex !== index);
  if (action !== 'Edit this item') return undefined;
  const edited = await editItem(items[index]);
  if (edited === undefined || JSON.stringify(edited) === JSON.stringify(items[index])) return undefined;
  return items.map((item, itemIndex) => itemIndex === index ? edited : item);
}

async function renameProject(window, project, projects) {
  const input = await window.showInputBox({
    title: 'Project name', value: project.name,
    validateInput: (value) => {
      const name = scrubDeep(value.trim());
      if (!name) return 'Enter a project name.';
      if (projects.some((other) => other !== project && other.name === name)) return 'Another project already uses that name.';
      return undefined;
    }
  });
  if (input === undefined) return undefined;
  const name = scrubDeep(input.trim());
  if (!name || name === project.name || projects.some((other) => other !== project && other.name === name)) return undefined;
  const replacement = { ...project, name, baseName: project.baseName || project.name };
  if (project.report) replacement.report = { ...project.report, project: name };
  return { project, replacement, overrides: {} };
}

async function editProject(vscode, data) {
  const { window } = vscode;
  const projects = data.projects || [];
  if (!projects.length) {
    window.showInformationMessage('This report has no projects.');
    return undefined;
  }
  const selected = await window.showQuickPick(projects.map((project) => ({ label: project.name, project })), { title: 'Choose a project to edit' });
  if (!selected) return undefined;
  const { project } = selected;
  const report = project.report;
  const action = await window.showQuickPick([
    { label: 'Rename project', field: 'name' },
    ...(report ? TEXT_FIELDS : []),
    { label: 'Remove project', field: 'remove' }
  ], { title: `Edit ${project.name}` });
  if (!action) return undefined;
  const { field } = action;
  if (field === 'name') return renameProject(window, project, projects);
  if (field === 'remove') {
    const confirmed = await window.showWarningMessage(`Remove ${project.name} from the report revision?`, { modal: true }, 'Remove project');
    return confirmed === 'Remove project' ? { project, remove: true } : undefined;
  }

  let value;
  if (field === 'summary') {
    value = await editText(window, action.label, report.summary);
    if (value === report.summary) return undefined;
  } else if (field === 'examples') {
    value = await editCollection(window, action.label, (report.examples || []).map(rawExample), (example) => example.task, (example) => editExample(window, example));
  } else {
    value = await editCollection(window, action.label, report[field] || [], (item) => item, (item) => editText(window, action.label, item));
  }
  if (value === undefined) return undefined;
  const overrides = { [field]: value };
  const edited = { ...report, ...overrides };
  const replacement = { ...project, report: field === 'examples' ? withExampleHours(edited) : edited };
  return { project, replacement, overrides };
}

module.exports = { editProject };
