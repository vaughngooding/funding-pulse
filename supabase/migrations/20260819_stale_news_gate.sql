-- Stale-news gate: re-reported old rounds are stored but alert nobody.
--
-- The SaaS News re-reported 7AI's Dec 2025 $130M Series A on 2026-08-07 and
-- the pipeline alerted as if new — article freshness masquerading as round
-- freshness. run_fast.py checks big rounds (>=$25M) against pre-dated press
-- coverage (Exa, amount-matched, 14-day buffer, fail-open) and sets
-- stale_news=true; the matcher skips fanout for those rows. Keeping the row
-- gives permanent dedup immunity against the NEXT re-report of the round.
--
-- Applied to prod 2026-08-19 via MCP.

ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS stale_news boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.match_funding_to_users()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- L4: SEC EDGAR rounds NEVER fire user_alerts (catch-up enrichment)
  IF NEW.extraction_method = 'sec_edgar' THEN
    RETURN NEW;
  END IF;

  -- L5: re-reported old rounds (stale-news gate, 2026-08-19). Row is kept
  -- for dedup/history but alerts nobody.
  IF COALESCE(NEW.stale_news, false) THEN
    RETURN NEW;
  END IF;

  INSERT INTO user_alerts (user_id, funding_round_id)
  SELECT up.user_id, NEW.id
  FROM user_preferences up
  WHERE
    NEW.amount_usd >= COALESCE(up.min_amount, 0)
    AND (up.max_amount IS NULL OR NEW.amount_usd <= up.max_amount)
    AND (
      up.funding_types IS NULL
      OR up.funding_types = '{}'
      OR NEW.funding_type = ANY(up.funding_types)
    )
    AND (
      up.countries IS NULL
      OR up.countries = '{}'
      OR NEW.location_country = ANY(up.countries)
    )
    AND (
      up.industries IS NULL
      OR up.industries = '{}'
      OR NEW.industry_tags && up.industries
    )
    AND NOT EXISTS (
      SELECT 1
      FROM user_alerts ua_existing
      JOIN funding_rounds fr_existing ON fr_existing.id = ua_existing.funding_round_id
      WHERE ua_existing.user_id = up.user_id
        AND ua_existing.created_at > NOW() - INTERVAL '7 days'
        AND normalize_company_name(fr_existing.company_name) = normalize_company_name(NEW.company_name)
        AND length(normalize_company_name(NEW.company_name)) >= 3
    )
  ON CONFLICT (user_id, funding_round_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- Flag the incident row
UPDATE funding_rounds SET stale_news = true
WHERE company_name = '7AI' AND amount_usd = 130000000;
