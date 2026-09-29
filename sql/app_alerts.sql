-- In-app alerts for the owner (Kevin). Shown as a bell/banner inside aibetbuilder.
-- Written by combo-worker (service role). Read + dismissed by the owner only:
-- JWT email kev120909@gmail.com (same gate as OWNER_EMAIL / canSeeOwnerTools).
-- Do not authorize on user_metadata. Safe to re-run.
--
-- dedupe_key: at most ONE unresolved alert (resolved_at IS NULL) per key, even
-- after the owner dismisses it (read_at), so a dismissed low-cash alert does not
-- re-fire while cash stays low. The worker sets resolved_at when the condition
-- clears, so a later recurrence inserts a fresh row.

CREATE TABLE IF NOT EXISTS public.app_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email text NOT NULL DEFAULT 'kev120909@gmail.com',
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  dedupe_key text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  resolved_at timestamptz,
  CONSTRAINT app_alerts_severity_check CHECK (severity IN ('info', 'warn', 'error')),
  CONSTRAINT app_alerts_title_check CHECK (length(btrim(title)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_alerts_open_dedupe_idx
  ON public.app_alerts (owner_email, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS app_alerts_owner_unread_idx
  ON public.app_alerts (owner_email, created_at DESC)
  WHERE read_at IS NULL;

COMMENT ON TABLE public.app_alerts IS
  'Owner-only in-app alerts (combo bucket transfers, low combo cash). Service role writes; owner reads and marks read.';

ALTER TABLE public.app_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.app_alerts FROM PUBLIC;
REVOKE ALL ON TABLE public.app_alerts FROM anon;
REVOKE ALL ON TABLE public.app_alerts FROM authenticated;
GRANT SELECT ON TABLE public.app_alerts TO authenticated;
GRANT UPDATE (read_at) ON TABLE public.app_alerts TO authenticated;
GRANT ALL ON TABLE public.app_alerts TO service_role;

DROP POLICY IF EXISTS app_alerts_select_owner ON public.app_alerts;
CREATE POLICY app_alerts_select_owner
  ON public.app_alerts
  FOR SELECT
  TO authenticated
  USING (
    lower(coalesce((select auth.jwt() ->> 'email'), '')) = 'kev120909@gmail.com'
    AND lower(owner_email) = 'kev120909@gmail.com'
  );

DROP POLICY IF EXISTS app_alerts_update_owner ON public.app_alerts;
CREATE POLICY app_alerts_update_owner
  ON public.app_alerts
  FOR UPDATE
  TO authenticated
  USING (
    lower(coalesce((select auth.jwt() ->> 'email'), '')) = 'kev120909@gmail.com'
    AND lower(owner_email) = 'kev120909@gmail.com'
  )
  WITH CHECK (
    lower(coalesce((select auth.jwt() ->> 'email'), '')) = 'kev120909@gmail.com'
    AND lower(owner_email) = 'kev120909@gmail.com'
  );
