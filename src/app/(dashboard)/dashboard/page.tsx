import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import DashboardClient from './DashboardClient'
import type { UserAlert, FundingRound, EarlyAlert } from '@/lib/types'

// Always fetch fresh — see (dashboard)/layout.tsx for why.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const ALL_ROUNDS_LIMIT = 200

// Customer-facing stages. Audit 2026-07-29: series_a_prior produced the
// most genuine early catches with the longest leads (Maneva 28d, Prime
// Intellect-class rounds), so it's shown; ambiguous produced zero genuine
// leads ever, so it's hidden. later_stage stays internal-only.
const EARLY_ALERTS_SHOW_STAGES = ['no_prior', 'seed_prior', 'series_a_prior']

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Fetch profile for plan info
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  // Fetch user-specific alerts (matches), the firehose of all recent rounds,
  // and the early-alerts feed (active + recently-confirmed). The dashboard
  // client toggles between the three views.
  const [alertsResult, roundsResult, earlyAlertsResult] = await Promise.all([
    supabase
      .from('user_alerts')
      .select(`*, funding_round:funding_rounds(*)`)
      .eq('user_id', user.id)
      .neq('status', 'archived')
      .order('created_at', { ascending: false }),
    supabase
      .from('funding_rounds')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(ALL_ROUNDS_LIMIT),
    supabase
      .from('early_alerts')
      .select('*')
      .in('status', ['active', 'confirmed'])
      .in('stage_category', EARLY_ALERTS_SHOW_STAGES)
      // Bigger filings confirm at 3-4x the rate of small ones ($20-100M:
      // 20% vs $5-20M: 8%) — surface size within each filing day.
      .order('form_d_filing_date', { ascending: false })
      .order('amount_usd', { ascending: false, nullsFirst: false }),
  ])

  if (alertsResult.error) {
    console.error('Error fetching alerts:', alertsResult.error)
  }
  if (roundsResult.error) {
    console.error('Error fetching all rounds:', roundsResult.error)
  }
  if (earlyAlertsResult.error) {
    console.error('Error fetching early alerts:', earlyAlertsResult.error)
  }

  return (
    <DashboardClient
      alerts={(alertsResult.data as UserAlert[]) || []}
      allRounds={(roundsResult.data as FundingRound[]) || []}
      earlyAlerts={(earlyAlertsResult.data as EarlyAlert[]) || []}
      plan={profile?.plan || 'free'}
      legacyFree={profile?.legacy_free ?? false}
    />
  )
}
