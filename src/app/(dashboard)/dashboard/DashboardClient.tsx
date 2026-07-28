'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import AlertCard from '@/components/AlertCard'
import EarlyAlertCard from '@/components/EarlyAlertCard'
import FilterSidebar, { type FilterState } from '@/components/FilterSidebar'
import type { UserAlert, FundingRound, EarlyAlert, Plan } from '@/lib/types'
import { canUseProFeatures } from '@/lib/access'

type ViewMode = 'matches' | 'all' | 'early-alerts'

interface DashboardClientProps {
  alerts: UserAlert[]
  allRounds: FundingRound[]
  earlyAlerts: EarlyAlert[]
  plan: Plan
  legacyFree: boolean
}

// Wrap a raw FundingRound as a synthetic UserAlert so the rest of the
// rendering pipeline (filters, AlertCard) can stay uniform between modes.
function roundToSyntheticAlert(round: FundingRound): UserAlert {
  return {
    id: `synthetic-${round.id}`,
    user_id: '',
    funding_round_id: round.id,
    funding_round: round,
    status: 'sent',
    is_bookmarked: false,
    notes: null,
    email_sent_at: null,
    read_at: null,
    created_at: round.created_at,
    user_flag: null,
    user_flag_at: null,
  }
}

function isWithinDateRange(
  dateStr: string,
  range: FilterState['dateRange']
): boolean {
  if (range === 'all') return true
  const date = new Date(dateStr)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (range) {
    case 'today':
      return date >= startOfToday
    case 'week': {
      const weekAgo = new Date(startOfToday)
      weekAgo.setDate(weekAgo.getDate() - 7)
      return date >= weekAgo
    }
    case 'month': {
      // "Last 30 days" — use setDate not setMonth to avoid calendar
      // edge cases (March 31 - 1 month = "Feb 31" which JS coerces to
      // March 3, giving only 28 days back instead of 30).
      const thirtyDaysAgo = new Date(startOfToday)
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      return date >= thirtyDaysAgo
    }
    case 'quarter': {
      const ninetyDaysAgo = new Date(startOfToday)
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
      return date >= ninetyDaysAgo
    }
    default:
      return true
  }
}

export default function DashboardClient({
  alerts,
  allRounds,
  earlyAlerts,
  plan,
  legacyFree,
}: DashboardClientProps) {
  const [search, setSearch] = useState('')
  // 'matches' = user_alerts (pre-filtered by saved preferences)
  // 'all'     = every recent funding round (firehose, replaces /explore)
  // Default to 'all' for users with no matches yet (e.g., brand-new accounts)
  // so they always see content. Existing users with matches start in 'matches'.
  const [viewMode, setViewMode] = useState<ViewMode>(
    alerts.length > 0 ? 'matches' : 'all',
  )
  const [filters, setFilters] = useState<FilterState>({
    dateRange: 'all',
    amountMin: 0,
    amountMax: 500_000_000,
    fundingTypes: [],
    industries: [],
    countries: [],
  })

  // The active dataset depends on the view mode. Rounds in 'all' mode are
  // wrapped as synthetic alerts so the same filter + render pipeline works.
  // 'early-alerts' uses its own dataset + render path (different schema).
  const activeAlerts = useMemo(
    () => (viewMode === 'matches' ? alerts : allRounds.map(roundToSyntheticAlert)),
    [viewMode, alerts, allRounds],
  )

  // Early alerts filter: server already applies status + stage_category.
  // Client adds search by entity name. Sidebar filters don't apply here —
  // early alerts have different schema (no funding_type, no normalized
  // industry tags); a future iteration can wire industry/amount to them.
  const filteredEarlyAlerts = useMemo(() => {
    if (!search) return earlyAlerts
    const q = search.toLowerCase()
    return earlyAlerts.filter((ea) =>
      ea.entity_name.toLowerCase().includes(q)
    )
  }, [earlyAlerts, search])

  const filteredAlerts = useMemo(() => {
    return activeAlerts.filter((alert) => {
      const round = alert.funding_round
      if (!round) return false

      // Search by company name
      if (
        search &&
        !round.company_name.toLowerCase().includes(search.toLowerCase())
      ) {
        return false
      }

      // Date range
      if (!isWithinDateRange(alert.created_at, filters.dateRange)) {
        return false
      }

      // Amount range. amountMax at the slider ceiling (500M) means "$500M+",
      // i.e. no upper bound — same semantics as explore/page.tsx.
      if (
        round.amount_usd < filters.amountMin ||
        (filters.amountMax < 500_000_000 &&
          round.amount_usd > filters.amountMax)
      ) {
        return false
      }

      // Funding type
      if (
        filters.fundingTypes.length > 0 &&
        !filters.fundingTypes.includes(round.funding_type)
      ) {
        return false
      }

      // Industries
      if (filters.industries.length > 0) {
        const hasMatch = round.industry_tags?.some((tag) =>
          filters.industries.includes(tag)
        )
        if (!hasMatch) return false
      }

      // Countries (multi-select — empty array = no filter)
      if (
        filters.countries.length > 0 &&
        !filters.countries.includes(round.location_country || '')
      ) {
        return false
      }

      return true
    })
  }, [activeAlerts, search, filters])

  // Show the "Upgrade to Pro" banner to anyone who's NOT on Pro and has more
  // than 3 alerts to look at. Same triggering threshold as before; we just
  // generalised the gate so basic + legacy_free both see the upsell.
  // (Pro users never see it. Paywalled users wouldn't reach this page —
  // they're redirected by the dashboard layout guard.)
  const showUpgradeBanner = !canUseProFeatures({ plan, legacy_free: legacyFree }) && alerts.length > 3

  return (
    <div className="flex gap-6">
      {/* Sidebar */}
      <FilterSidebar onFilterChange={setFilters} />

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Header row */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Dashboard</h1>
            <p className="text-sm text-slate-400 mt-1">
              {viewMode === 'early-alerts'
                ? `${filteredEarlyAlerts.length} early alert${filteredEarlyAlerts.length !== 1 ? 's' : ''} from Form D filings in the last 14 days`
                : `${filteredAlerts.length} funding round${filteredAlerts.length !== 1 ? 's' : ''}${viewMode === 'matches' ? ' matching your alert settings' : ' in the database'}`}
            </p>
          </div>

          {/* My matches / All rounds / Early Alerts toggle */}
          <div className="inline-flex items-center gap-0.5 rounded-full bg-slate-900 p-1 ring-1 ring-slate-700 shrink-0">
            <button
              type="button"
              onClick={() => setViewMode('matches')}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${
                viewMode === 'matches'
                  ? 'bg-emerald-600 text-white shadow-[0_4px_12px_-4px_rgba(16,185,129,0.5)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              My matches
            </button>
            <button
              type="button"
              onClick={() => setViewMode('all')}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${
                viewMode === 'all'
                  ? 'bg-emerald-600 text-white shadow-[0_4px_12px_-4px_rgba(16,185,129,0.5)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              All rounds
            </button>
            <button
              type="button"
              onClick={() => setViewMode('early-alerts')}
              className={`relative whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${
                viewMode === 'early-alerts'
                  ? 'bg-emerald-600 text-white shadow-[0_4px_12px_-4px_rgba(16,185,129,0.5)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Early Alerts
              <span
                aria-hidden
                className="absolute -top-1 -right-1 text-[8px] leading-none font-bold uppercase tracking-wider px-1 py-0.5 rounded-full bg-emerald-400 text-slate-900 ring-2 ring-slate-900"
              >
                New
              </span>
            </button>
          </div>

          {/* Search bar */}
          <div className="relative w-full sm:w-80">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              placeholder="Search by company name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-700 bg-slate-900 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors text-sm"
            />
          </div>
        </div>

        {/* Upgrade banner */}
        {showUpgradeBanner && (
          <div className="mb-6 bg-gradient-to-r from-blue-600/20 to-emerald-600/20 border border-blue-500/30 rounded-xl p-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Upgrade to Pro
              </h3>
              <p className="text-xs text-slate-300 mt-0.5">
                You have {alerts.length} alerts. Unlock real-time delivery,
                SMS, Slack/Teams/Telegram integrations, bookmarks, and CSV export.
              </p>
            </div>
            <Link
              href="/settings"
              className="flex-shrink-0 ml-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
            >
              Upgrade
            </Link>
          </div>
        )}

        {/* Feed: Early Alerts gets its own render path (different schema +
            description copy + Pro gate); matches/all share AlertCard. */}
        {viewMode === 'early-alerts' ? (
          <EarlyAlertsView
            alerts={filteredEarlyAlerts}
            isPro={canUseProFeatures({ plan, legacy_free: legacyFree })}
            hasSearch={!!search}
          />
        ) : filteredAlerts.length > 0 ? (
          <div className="grid gap-4">
            {filteredAlerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-800 mb-4">
              <svg
                className="w-8 h-8 text-slate-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-white mb-1">
              No funding events found
            </h3>
            <p className="text-sm text-slate-400 max-w-sm mx-auto">
              {search || filters.dateRange !== 'all' || filters.fundingTypes.length > 0 || filters.countries.length > 0
                ? 'Try adjusting your search or filters to see more results.'
                : viewMode === 'matches'
                  ? "You don't have any matched alerts yet. Switch to All rounds to browse the database, or update your alert settings."
                  : 'No funding events in the database. The pipeline scrapes new rounds every minute — check back soon.'}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {viewMode === 'matches' && (
                <button
                  type="button"
                  onClick={() => setViewMode('all')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
                >
                  Switch to All rounds
                </button>
              )}
              <Link
                href="/settings"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-sm font-medium transition-colors"
              >
                Update alert settings
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Early Alerts inline view ----
//
// Description copy + disclaimer + list (or Pro upsell). Lives inside the
// dashboard rather than a separate page per Vaughn's request — it's a third
// toggle, not a new screen at the head of the app.
function EarlyAlertsView({
  alerts,
  isPro,
  hasSearch,
}: {
  alerts: EarlyAlert[]
  isPro: boolean
  hasSearch: boolean
}) {
  return (
    <>
      <div className="mb-6 rounded-lg border border-slate-700/50 bg-slate-900/50 px-5 py-4 text-sm text-slate-300 leading-relaxed">
        <p>
          <strong className="text-white">
            Companies that have quietly filed a Form D
          </strong>{' '}
          with the SEC, signaling a funding round is in motion. Most announce
          publicly within 14 days. FundingScout catches these filings within
          hours and flags the ones matching our funding-round pattern.
        </p>
        <p className="mt-2">
          Form D is a regulatory filing companies submit when raising private
          capital — by law it goes up before any public announcement, which is
          why it&rsquo;s a leading indicator.
        </p>
        <p className="mt-3 text-amber-300/90">
          <strong>Disclaimer:</strong> This is a forward-looking signal, not a
          guarantee. Some flagged companies delay their announcement, withdraw
          the round, or never announce publicly. Use this list for speculative
          leads only — not commitments.
        </p>
      </div>

      {!isPro ? (
        <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-600/10 to-blue-600/10 p-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/15 mb-4">
            <svg
              className="w-6 h-6 text-emerald-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-1">
            Early Alerts is a Pro feature
          </h3>
          <p className="text-sm text-slate-300 max-w-md mx-auto mb-5">
            See companies likely to announce funding within 14 days, before
            the press release hits. Upgrade to Pro to unlock the list.
          </p>
          <Link
            href="/settings"
            className="inline-flex items-center px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
          >
            Upgrade to Pro
          </Link>
        </div>
      ) : alerts.length > 0 ? (
        <div className="grid gap-3">
          {alerts.map((a) => (
            <EarlyAlertCard key={a.id} alert={a} />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 rounded-lg border border-dashed border-slate-700">
          <p className="text-sm text-slate-400">
            {hasSearch
              ? 'No early alerts match your search.'
              : 'No early alerts in the rolling 14-day window. Check back tomorrow — the list refreshes daily at 6am PT.'}
          </p>
        </div>
      )}
    </>
  )
}
