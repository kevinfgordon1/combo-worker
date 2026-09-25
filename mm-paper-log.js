// JSON-lines tape plus an optional Supabase insert.
// A missing mm_paper_events table is logged once and then ignored.
// Combo Locks tables are never written.
'use strict';

const fs = require('fs');
const path = require('path');

const MISSING_RE = /schema cache|does not exist|could not find the table|PGRST205|42P01|mm_paper_events/i;

function createPaperLog({
  filePath,
  insertFn,
  writeFn,
  onError,
} = {}) {
  let supabaseOff = !insertFn;
  let announced = false;

  function append(line) {
    if (writeFn) {
      writeFn(line);
      return;
    }
    if (!filePath) return;
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
    }
    fs.appendFileSync(filePath, `${line}\n`);
  }

  async function write(event) {
    const row = { ...event, paper: true, orders: 'none' };
    if (!row.ts) row.ts = Date.now();
    if (!row.iso) row.iso = new Date(row.ts).toISOString();
    append(JSON.stringify(row));
    if (supabaseOff || !insertFn) return row;
    try {
      const result = await insertFn(row);
      const err = result && result.error;
      if (err) throw err;
    } catch (err) {
      const text = `${err && err.message ? err.message : err} ${err && err.code ? err.code : ''}`;
      if (MISSING_RE.test(text) || /relation|table/i.test(text)) {
        supabaseOff = true;
        if (!announced) {
          announced = true;
          const msg = '[MM-PAPER] supabase mm_paper_events unavailable — JSONL only';
          if (onError) onError(msg);
          else console.warn(msg);
        }
      } else if (onError) {
        onError(`[MM-PAPER] supabase insert failed: ${text}`);
      }
    }
    return row;
  }

  return { write, supabaseDisabled: () => supabaseOff };
}

module.exports = { createPaperLog, MISSING_RE };
