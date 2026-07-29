export interface FundingRound {
  id: string
  company_name: string
  website: string | null
  location: string | null
  location_country: string | null
  amount_usd: number
  funding_type: string
  investors: string[]
  lead_investor: string | null
  industry: string | null
  industry_tags: string[]
  confidence_score: number
  article_url: string
  article_title: string | null
  source_feed: string | null
  published_date: string | null
  created_at: string
  // Phase 6: enrichment fields (CEO + website source tracking)
  ceo_name: string | null
  website_source: string | null
  ceo_source: string | null
  // Phase 7: Kirha/Apollo CEO contact enrichment
  ceo_email: string | null
  ceo_linkedin_url: string | null
  ceo_email_source: string | null
  enrichment_attempted_at: string | null
  // Layer 1 enrichment: extracted from article at zero cost
  company_description: string | null
  founded_year: number | null
  employee_range: string | null
}

export interface UserAlert {
  id: string
  user_id: string
  funding_round_id: string
  status: 'pending' | 'sent' | 'read' | 'archived'
  is_bookmarked: boolean
  notes: string | null
  email_sent_at: string | null
  read_at: string | null
  created_at: string
  user_flag: 'not_funding' | 'duplicate' | 'incorrect_details' | null
  user_flag_at: string | null
  funding_round?: FundingRound
}

/**
 * Subscription tier.
 *
 * - `free`: legacy users (created before 2026-04-29). Distinguished from
 *   "paywalled" via the `legacy_free` flag. Cannot be created new.
 * - `basic`: paid entry tier ($19.99/mo or $99/yr, also the post-trial state).
 *   Same feature set as legacy free; we are charging for what was free.
 * - `pro`: unchanged from before this commit. $89/mo or $588/yr. All
 *   real-time + integration features.
 */
export type Plan = 'free' | 'basic' | 'pro' | 'wholesale'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  company: string | null
  role: string | null
  plan: Plan
  /**
   * True ONLY for users created before the 2026-04-29 free-tier elimination,
   * grandfathered onto the legacy free experience. New signups never get this
   * flag, so a cancelled subscriber lands on `plan='free' && legacy_free=false`
   * → paywalled.
   */
  legacy_free: boolean
  timezone: string
  stripe_customer_id: string | null
}

export interface UserPreferences {
  id: string
  user_id: string
  min_amount: number
  max_amount: number | null
  funding_types: string[]
  countries: string[]
  industries: string[]
  digest_frequency: 'daily' | 'weekly'
  digest_hour: number
  slack_webhook_url: string | null
  teams_webhook_url: string | null
  // Phase 1: Telegram
  telegram_chat_id: number | null
  telegram_link_token: string | null
  // Phase 2: Web Push
  push_subscription: PushSubscriptionJSON | null
  // Phase 3: SMS / iMessage (phone is shared between channels)
  phone_number: string | null
  phone_verified: boolean
  imessage_enabled: boolean
  // Phase 4: Slack App
  slack_team_id: string | null
  slack_channel_id: string | null
  slack_bot_token: string | null
  slack_app_installed: boolean
  // Phase 5: Email-to-channel relay (enterprise workaround)
  slack_channel_email: string | null
  teams_channel_email: string | null
  // Phase 7: LinkedIn profile (optional, captured during onboarding or in settings)
  linkedin_url: string | null
}

export interface PushSubscriptionJSON {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

export interface CompanySummary {
  slug: string
  display_name: string
  round_count: number
  total_raised: number
  largest_round: number
  first_seen: string
  last_seen: string
  best_confidence: number
  location: string | null
  location_country: string | null
  website: string | null
  all_investors: string[] | null
  all_industry_tags: string[] | null
}

export interface ExploreStats {
  total_rounds: number
  total_capital: number
  avg_round_size: number
  unique_companies: number
  top_industries: { tag: string; cnt: number }[]
}

// Mirrors the early_alerts table created in 20260504_early_alerts.sql.
// Populated by populate_early_alerts.py (read the comment block in that file
// for the producer-side contract).
export type EarlyAlertStageCategory =
  | 'no_prior'
  | 'seed_prior'
  | 'series_a_prior'
  | 'later_stage'
  | 'ambiguous'

export type EarlyAlertStatus = 'active' | 'confirmed' | 'stale'

export interface EarlyAlert {
  id: string
  cik: string
  accession: string
  entity_name: string
  normalized_name: string
  form_d_filing_date: string
  form_d_url: string
  form_d_xml_url: string
  industry: string | null
  state_of_business: string | null
  entity_type: string | null
  amount_usd: number | null
  v5_bin: 'high' | 'medium'
  v5_score: number
  verifier_is_real: boolean | null
  verifier_confidence: 'high' | 'medium' | 'low' | null
  verifier_evidence: string | null
  verifier_article_url: string | null
  website_url: string | null
  stage_category: EarlyAlertStageCategory
  stage_source: 'haiku' | 'db' | 'default'
  prior_stage: string | null
  prior_amount_usd: number | null
  prior_year: number | null
  prior_evidence: string | null
  status: EarlyAlertStatus
  confirmed_at: string | null
  confirmed_funding_round_id: string | null
  lead_time_days: number | null
  staled_at: string | null
  diagnostic_notes: string | null
  created_at: string
  updated_at: string
}
