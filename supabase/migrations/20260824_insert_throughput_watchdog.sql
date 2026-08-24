-- Cloud insert-throughput watchdog.
--
-- The Aug 19-24 incident: a caught NameError in extraction silently killed
-- every funding_rounds insert for 5 days while the per-minute heartbeat
-- stayed green — no monitoring watched whether the pipeline PRODUCED
-- anything. This check alarms when no press-pipeline round has inserted for
-- 24h (clears dead weekends; worst observed organic gap ~20h).
--
-- Applied to prod 2026-08-24 via MCP.

create or replace function public.check_insert_throughput()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  latest      timestamptz;
  stale_hours numeric;
  webhook_url text;
begin
  select decrypted_secret into webhook_url
  from vault.decrypted_secrets where name = 'slack_watchdog_webhook' limit 1;
  if webhook_url is null then return; end if;

  select max(created_at) into latest
  from public.funding_rounds where extraction_method != 'sec_edgar';
  stale_hours := extract(epoch from (now() - coalesce(latest, now() - interval '999 hours'))) / 3600;

  if stale_hours > 24 then
    perform net.http_post(
      url := webhook_url,
      body := jsonb_build_object('text', format(
        '🚨 *No funding rounds inserted for %s hours* (last: %s UTC). The heartbeat can be green while extraction is broken — check /tmp/fundingscout.log for [DROP]/validation errors. (Cloud throughput watchdog.)',
        round(stale_hours), to_char(latest, 'YYYY-MM-DD HH24:MI'))),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end if;
end;
$$;

select cron.schedule('insert-throughput-check', '0 */2 * * *',
  $$select public.check_insert_throughput()$$);
