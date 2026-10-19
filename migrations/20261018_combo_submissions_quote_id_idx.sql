-- combo_submissions is looked up by quote_id on every fill save / quote stamp
-- (live-runner.js: persistQuoteSkip, markFilled, persistQuoteOrder, ...). With ~1.46M rows and
-- no index, each lookup was a full parallel seq scan (~330 ms) and fill saves timed out under
-- load (Oct 18, ~12:01-12:07 AM ET).
--
-- Already applied to production on 2026-10-18 at ~1:33 AM ET (approved by Kevin); this file
-- records it. IF NOT EXISTS makes re-running a no-op.
--
-- CONCURRENTLY: does not block writes, but cannot run inside a transaction block, so run this
-- file on its own (e.g. psql -f), not wrapped in BEGIN/COMMIT. If a concurrent build fails it
-- leaves an INVALID index: DROP INDEX CONCURRENTLY public.combo_submissions_quote_id_idx; then retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS combo_submissions_quote_id_idx
  ON public.combo_submissions USING btree (quote_id);
