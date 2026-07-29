-- max_amount semantics fix: NULL = no upper bound ("$500M+" slider position).
--
-- Before this, the settings/onboarding sliders stored a literal 500,000,000
-- when parked at the ceiling, and the matcher's BETWEEN clause silently
-- excluded every round above the stored cap. Recursive Superintelligence's
-- $650M Series B (May 14) alerted only 3 users; its $500M pre-series-A
-- (Apr 20) alerted nobody.
--
-- 1. Allow NULL in max_amount (UI now stores NULL at the slider ceiling).
-- 2. Migrate users parked at the ceiling (exactly 500M) to NULL — that
--    position always rendered as the slider max, so "cap at exactly 500M"
--    was never expressible intent.
-- 3. Rewrite the matcher: NULL max = unbounded (no more 10B COALESCE,
--    which would drop a hypothetical >$10B round even for uncapped users).

ALTER TABLE user_preferences ALTER COLUMN max_amount DROP NOT NULL;

UPDATE user_preferences
SET max_amount = NULL
WHERE max_amount = 500000000;

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

  -- Match users + L3 logical-dedup guard via normalize_company_name()
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
    -- L3 logical dedup: skip if this user already has an alert for a
    -- normalized-matching company in the last 7 days. Uses our shared
    -- normalize_company_name() function which strips Inc/LLC/Bio/Tech/etc.
    -- so press articles about the same round (with name variations like
    -- "Stipple Bio, Inc." vs "Stipple Bio") don't double-fire.
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
