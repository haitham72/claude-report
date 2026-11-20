'use strict';

const path = require('node:path');
const {
  deleteReportExport, deleteReportRun, forgetReportExport, getReportExport, listReports, loadRun, setReportArchived
} = require('./report-store');

function runLabel(run) {
  return run ? run.replace(/ (\d{2})-(\d{2})-(\d{2})/, ' $1:$2:$3') : 'Legacy report';
}

function createReportManager({ vscode, home, openReport, runExport, editReport, enhanceReport, deepReport, showRuntime, compareReport, refresh, isExporting = () => false }) {
  const { window, workspace, commands, Uri } = vscode;
  const trashLabel = 'Move to Trash';

  async function choose(actions, title) {
    const action = await window.showQuickPick(actions, { title });
    if (action) await action.run();
  }

  async function changeVisibility(month, run, archived) {
    setReportArchived(home, month, run, archived);
    await refresh();
  }

  async function deleteSavedReport(month, run, label) {
    const confirmed = await window.showWarningMessage(`Move the saved report for ${label} (${runLabel(run)}) to Trash?`, {
      modal: true,
      detail: 'Any copies you exported are kept.'
    }, trashLabel);
    if (confirmed !== trashLabel) return;
    if (isExporting(month, run)) throw new Error('Wait for the export to finish before deleting this report.');
    await deleteReportRun(home, month, run, (dir) => workspace.fs.delete(Uri.file(dir), { useTrash: true, recursive: true }));
    await refresh();
  }

  async function manageCopy(month, run, id) {
    const copy = getReportExport(home, month, run, id);
    const name = path.basename(copy.path);
    const actions = copy.missing ? [] : [
      { label: 'Show in folder', run: async () => {
        const current = getReportExport(home, month, run, id);
        if (current.missing) return window.showWarningMessage('This exported copy has moved or changed.');
        await commands.executeCommand('revealFileInOS', Uri.file(current.path));
      } },
      { label: 'Delete this copy', run: async () => {
        const confirmed = await window.showWarningMessage(`Move ${name} to Trash?`, { modal: true, detail: copy.path }, trashLabel);
        if (confirmed !== trashLabel) return;
        const result = await deleteReportExport(home, month, run, id, (file) => workspace.fs.delete(Uri.file(file), { useTrash: true, recursive: false }));
        await refresh();
        if (!result.deleted) window.showWarningMessage('The copy moved or changed. Its entry was removed from report history.');
      } }
    ];
    actions.push({ label: 'Remove from history', description: 'Keep the file on disk', run: async () => {
      forgetReportExport(home, month, run, id);
      await refresh();
    } });
    await choose(actions, copy.missing ? `${name} · Unavailable` : name);
  }

  async function manageCopies(month, run, record) {
    const choices = record.exports.map((copy) => ({
      label: path.basename(copy.path),
      description: copy.missing ? 'Unavailable' : copy.format.toUpperCase(),
      detail: copy.path,
      run: () => manageCopy(month, run, copy.id)
    }));
    await choose(choices, 'Manage exported copies');
  }

  async function manage(month, run = '') {
    try {
      const record = loadRun(home, month, run);
      const label = record.data.label || month;
      const actions = [
        { label: 'Open report', run: () => openReport(month, run) },
        { label: 'Export', run: () => runExport(month, run) },
        { label: 'Edit projects', run: () => editReport(month, run, record) },
        { label: 'Enhance report', run: () => enhanceReport(month, run, record) }
      ];
      if (record.data.failures?.length) {
        actions.push({ label: 'Retry failed projects', run: () => enhanceReport(month, run, record, { failedOnly: true }) });
      }
      if (deepReport && record.data.projects.length) {
        actions.push({ label: 'Run Deep prompting review', run: () => deepReport(month, run, record) });
        if (record.data.reviewFailures?.length) {
          actions.push({ label: 'Retry failed prompting reviews', run: () => deepReport(month, run, record, { failedOnly: true }) });
        }
      }
      actions.push({ label: 'Runtime log', run: () => showRuntime(month, run, record) });
      if (compareReport && Object.hasOwn(record.metadata, 'parentRun')) {
        actions.push({ label: 'Compare with previous revision', run: () => compareReport(month, run, record) });
      }
      if (record.exports.length) actions.push({ label: 'Manage exported copies', run: () => manageCopies(month, run, record) });
      actions.push(
        { label: record.archived ? 'Restore to history' : 'Hide from history', run: () => changeVisibility(month, run, !record.archived) },
        { label: 'Delete saved report', run: () => deleteSavedReport(month, run, label) }
      );
      await choose(actions, `${label} · ${runLabel(run)}`);
    } catch (error) {
      window.showErrorMessage(`Claude Report: ${error.message}`);
    }
  }

  async function archivedReports() {
    try {
      const archived = listReports(home, { includeArchived: true }).filter((report) => report.archived);
      if (!archived.length) {
        window.showInformationMessage('There are no hidden reports.');
        return;
      }
      const report = await window.showQuickPick(archived.map(({ month, run, label }) => ({
        label, description: runLabel(run), month, run
      })), { title: 'Hidden reports' });
      if (!report) return;
      const { month, run, label } = report;
      await choose([
        { label: 'Restore to history', run: () => changeVisibility(month, run, false) },
        { label: 'Delete saved report', run: () => deleteSavedReport(month, run, label) }
      ], `${label} · ${runLabel(run)}`);
    } catch (error) {
      window.showErrorMessage(`Claude Report: ${error.message}`);
    }
  }

  return { manage, archivedReports };
}

module.exports = { createReportManager };
