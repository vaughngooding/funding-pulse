-- early_alerts: restore dashboard visibility.
--
-- RLS was enabled on early_alerts during the security lockdown pass, but the
-- 20260511 migration only added read policies for funding_rounds + fs_* —
-- early_alerts got RLS with ZERO policies. PostgREST returns an empty set
-- (not an error) in that state, so the dashboard's Early Alerts tab silently
-- showed nothing for every user while the service-role pipeline kept
-- upserting rows daily. Same read policy pattern as funding_rounds.
--
-- Applied to prod 2026-07-29 via MCP.

CREATE POLICY "early_alerts: authenticated users can view"
ON public.early_alerts FOR SELECT TO authenticated USING (true);
