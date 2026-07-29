-- Cloud freshness watchdog for the daily Form D early-alerts pipeline.
--
-- Why: the pipeline's schedule was buried as an hour-gated fork inside
-- run_digest.sh — undiscoverable, coupled to the digest cron, and with no
-- alert if it simply never ran (run_early_alerts.sh only alerts when it
-- runs AND fails). Moved to a dedicated crontab entry on 2026-07-29; this
-- check is the off-box guarantee that a missed day is loud.
--
-- Signal: populate_early_alerts.py upserts every tracked flag daily (incl.
-- weekends) and early_alerts.updated_at auto-bumps on upsert, so
-- max(updated_at) advances every day the pipeline runs. Checked daily at
-- 17:00 UTC: healthy = ~4h old (13:10 UTC run), missed = ~28h. Threshold 24h.
--
-- Reuses the vault 'slack_watchdog_webhook' secret from the 20260714
-- pipeline watchdog. Stateless — re-alerts once per daily check while stale.
--
-- Applied to prod 2026-07-29 via MCP.

create or replace function public.check_early_alerts_freshness()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  latest      timestamptz;
  stale_hours numeric;
  webhook_url text;
  msg         text;
begin
  select decrypted_secret into webhook_url
  from vault.decrypted_secrets
  where name = 'slack_watchdog_webhook'
  limit 1;

  if webhook_url is null then
    raise warning 'early-alerts watchdog: no slack_watchdog_webhook secret in vault';
    return;
  end if;

  select max(updated_at) into latest from public.early_alerts;
  stale_hours := extract(epoch from (now() - coalesce(latest, now() - interval '999 hours'))) / 3600;

  if stale_hours > 24 then
    msg := format(
      '🚨 *Form D early-alerts pipeline did NOT run* — early_alerts last touched %s hours ago (%s UTC). ' ||
      'Expected daily at 6:00 AM PT via crontab run_early_alerts.sh on the Mac Mini. ' ||
      'Check: crontab -l, /tmp/fundingscout-early-alerts.log. ' ||
      '(Cloud watchdog — fires even if the Mini is dead.)',
      round(stale_hours), to_char(latest, 'YYYY-MM-DD HH24:MI')
    );
    perform net.http_post(
      url := webhook_url,
      body := jsonb_build_object('text', msg),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end if;
end;
$$;

select cron.schedule(
  'early-alerts-freshness-check',
  '0 17 * * *',
  $$select public.check_early_alerts_freshness()$$
);
