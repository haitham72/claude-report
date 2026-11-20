'use strict';

const { dayKey } = require('./scan');

function localDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00');
  return Number.isFinite(+date) && dayKey(date) === value ? date : null;
}

function readDateRange(value) {
  return localDay(value?.from) && localDay(value?.to) && value.from <= value.to
    ? { from: value.from, to: value.to } : null;
}

function reportBounds(month, range, cutoff = new Date()) {
  let from, end;
  if (range) {
    const clean = readDateRange(range);
    if (!clean) throw new Error('Invalid report date range');
    from = localDay(clean.from);
    end = localDay(clean.to);
    end.setDate(end.getDate() + 1);
  } else {
    const [year, number] = month.split('-').map(Number);
    from = new Date(year, number - 1, 1);
    end = new Date(year, number, 1);
  }
  return { from, end, to: new Date(Math.min(+end, +new Date(cutoff))) };
}

function dateRangeLabel(range) {
  const format = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const from = format.format(localDay(range.from));
  const to = format.format(localDay(range.to));
  return from === to ? from : from + ' to ' + to;
}

module.exports = { localDay, readDateRange, reportBounds, dateRangeLabel };
