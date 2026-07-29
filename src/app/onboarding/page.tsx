'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const ROLES = [
  { value: 'SDR', label: 'SDR', desc: 'Sales Development Representative' },
  { value: 'AE', label: 'AE', desc: 'Account Executive' },
  { value: 'Sales Manager', label: 'Sales Manager', desc: 'Team lead or manager' },
  { value: 'Founder', label: 'Founder', desc: 'Founder or co-founder' },
  { value: 'Investor', label: 'Investor', desc: 'VC, angel, or LP' },
  { value: 'Other', label: 'Other', desc: 'Any other role' },
]

const COUNTRIES = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'IL', label: 'Israel' },
  { value: 'IN', label: 'India' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AU', label: 'Australia' },
  { value: 'BR', label: 'Brazil' },
  { value: 'WW', label: 'Worldwide' },
]

const FUNDING_TYPES = [
  'pre-seed',
  'seed',
  'series-a',
  'series-b',
  'series-c',
  'series-d',
]

function formatFundingType(type: string): string {
  return type.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatAmountLabel(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value}`
}

const TOTAL_STEPS = 5

// ─────────────────────────────────────────────────────────────────────────────
// Plan selection types — must mirror src/app/api/create-checkout/route.ts.
// 'free' is intentionally absent: the free signup path is eliminated.
// ─────────────────────────────────────────────────────────────────────────────
type PlanTier = 'trial' | 'basic' | 'pro'
type BillingCycle = 'monthly' | 'annual'

/** URL ?plan= → ({tier, billingCycle}) for pre-selection from landing CTAs. */
function parseUrlPlan(planParam: string | null): { tier: PlanTier; billing: BillingCycle } {
  switch (planParam) {
    case 'trial':
      return { tier: 'trial', billing: 'annual' } // billing N/A for trial — annual default takes effect when user switches to Basic/Pro
    case 'basic':
      return { tier: 'basic', billing: 'monthly' }
    case 'basic-annual':
    case 'basic_annual':
      return { tier: 'basic', billing: 'annual' }
    case 'pro':
    case 'monthly': // legacy alias
      return { tier: 'pro', billing: 'monthly' }
    case 'pro-annual':
    case 'pro_annual':
    case 'annual': // legacy alias
      return { tier: 'pro', billing: 'annual' }
    default:
      return { tier: 'trial', billing: 'annual' } // safest low-friction default — annual is the recommended billing cadence
  }
}

/** Convert (tier, billing) into the canonical plan ID the checkout API expects. */
function checkoutPlanId(tier: PlanTier, billing: BillingCycle): string {
  if (tier === 'trial') return 'trial'
  if (tier === 'basic') return billing === 'annual' ? 'basic-annual' : 'basic'
  return billing === 'annual' ? 'pro-annual' : 'pro'
}

function OnboardingPageInner() {
  const searchParams = useSearchParams()
  const initial = parseUrlPlan(searchParams.get('plan'))
  // Allow ?step=plan to deep-link straight into the plan selector after signup.
  const initialStep = searchParams.get('step') === 'plan' ? 4 : 1

  const [step, setStep] = useState(initialStep)
  const [upgrading, setUpgrading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1: Role + LinkedIn (optional)
  const [role, setRole] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')

  // Step 2: Geographies
  const [countries, setCountries] = useState<string[]>([])

  // Step 3: Funding range + types
  const [minAmount, setMinAmount] = useState(0)
  // Ceiling (500M) means "$500M+" — saved as null (no cap).
  const [maxAmount, setMaxAmount] = useState(500_000_000)
  const [fundingTypes, setFundingTypes] = useState<string[]>([])

  // Step 4: Plan selection.
  // Note: there is NO free option. Every path leads to Stripe Checkout —
  // the cheapest entry is the $2.99 trial which auto-converts to Basic.
  const [chosenTier, setChosenTier] = useState<PlanTier>(initial.tier)
  const [billingCycle, setBillingCycle] = useState<BillingCycle>(initial.billing)

  // Step 5: Telegram connect (optional)
  const [telegramConnected, setTelegramConnected] = useState(false)
  const [telegramConnecting, setTelegramConnecting] = useState(false)

  // Lapsed-subscriber state: if user already has a Stripe customer record,
  // show an "Update payment method" CTA on Step 4. Past-Pro users whose card
  // failed (plan='free', legacy_free=false → paywalled) land here via the
  // dashboard layout guard; their fastest path back is fixing the card, not
  // re-doing checkout. Only set true when the profile row is loaded AND has
  // a non-null stripe_customer_id.
  const [hasStripeCustomer, setHasStripeCustomer] = useState(false)
  const [openingPortal, setOpeningPortal] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadProfile() {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single()
      if (cancelled) return
      setHasStripeCustomer(Boolean(data?.stripe_customer_id))
    }
    loadProfile()
    return () => {
      cancelled = true
    }
  }, [])

  async function openCustomerPortal() {
    setOpeningPortal(true)
    setError(null)
    try {
      const res = await fetch('/api/portal', { method: 'POST' })
      const body = await res.json()
      if (!res.ok || !body.url) {
        setError(body.error ?? 'Could not open the Stripe customer portal.')
        setOpeningPortal(false)
        return
      }
      window.location.href = body.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error opening portal.')
      setOpeningPortal(false)
    }
  }

  function toggleCountry(country: string) {
    setCountries((prev) =>
      prev.includes(country) ? prev.filter((c) => c !== country) : [...prev, country],
    )
  }

  function toggleFundingType(type: string) {
    setFundingTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    )
  }

  function canProceed(): boolean {
    switch (step) {
      case 1:
        return role !== ''
      case 2:
        return countries.length > 0
      case 3:
        return fundingTypes.length > 0
      case 4:
        return true // plan always has a default
      case 5:
        return true // Telegram is optional
      default:
        return false
    }
  }

  // Step 5: Telegram connect — same pattern as SettingsForm.tsx
  async function handleConnectTelegram() {
    setTelegramConnecting(true)
    setError(null)
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setError('Not authenticated. Please log in again.')
      setTelegramConnecting(false)
      return
    }

    const token = crypto.randomUUID()
    const { error: tokenError } = await supabase
      .from('user_preferences')
      .upsert(
        { user_id: user.id, telegram_link_token: token },
        { onConflict: 'user_id' },
      )
    if (tokenError) {
      setError(`Failed to generate Telegram link: ${tokenError.message}`)
      setTelegramConnecting(false)
      return
    }

    window.open(`https://t.me/FundingScoutAlerts_Bot?start=${token}`, '_blank')

    let attempts = 0
    const maxAttempts = 30
    const interval = setInterval(async () => {
      attempts += 1
      const { data } = await supabase
        .from('user_preferences')
        .select('telegram_chat_id')
        .eq('user_id', user.id)
        .single()
      if (data?.telegram_chat_id) {
        clearInterval(interval)
        setTelegramConnected(true)
        setTelegramConnecting(false)
      } else if (attempts >= maxAttempts) {
        clearInterval(interval)
        setTelegramConnecting(false)
      }
    }, 2000)
  }

  /** Persist role + filter preferences. Called before kicking off Stripe checkout. */
  async function savePrefs(): Promise<boolean> {
    setError(null)
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setError('Not authenticated. Please log in again.')
      return false
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', user.id)

    if (profileError) {
      setError(`Failed to save profile: ${profileError.message}`)
      return false
    }

    const { error: prefsError } = await supabase
      .from('user_preferences')
      .upsert(
        {
          user_id: user.id,
          min_amount: minAmount,
          max_amount: maxAmount >= 500_000_000 ? null : maxAmount,
          funding_types: fundingTypes,
          countries,
          industries: [],
          digest_frequency: 'daily',
          digest_hour: 9,
          slack_webhook_url: null,
          teams_webhook_url: null,
          linkedin_url: linkedinUrl.trim() || null,
        },
        { onConflict: 'user_id' },
      )

    if (prefsError) {
      setError(`Failed to save preferences: ${prefsError.message}`)
      return false
    }

    return true
  }

  /** Save prefs then redirect to Stripe Checkout — every onboarding finish goes through Stripe. */
  async function handleCheckout() {
    setUpgrading(true)
    const ok = await savePrefs()
    if (!ok) {
      setUpgrading(false)
      return
    }
    try {
      const planId = checkoutPlanId(chosenTier, billingCycle)
      const res = await fetch('/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error || 'Failed to start checkout')
        setUpgrading(false)
      }
    } catch {
      setError('Network error. Please try again.')
      setUpgrading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-4 py-12">
      {/* Logo */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-white tracking-tight">
          Funding<span className="text-emerald-400">Scout</span>
        </h1>
        <p className="mt-2 text-slate-400 text-sm">
          Let&apos;s set up your alert preferences
        </p>
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-lg mb-8">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-500">
            Step {step} of {TOTAL_STEPS}
          </span>
          <span className="text-xs text-slate-500">
            {Math.round((step / TOTAL_STEPS) * 100)}%
          </span>
        </div>
        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
          />
        </div>
      </div>

      {/* Card */}
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700/50 rounded-xl p-8 shadow-2xl">
        {/* Error */}
        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Step 1: Role + LinkedIn */}
        {step === 1 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              What&apos;s your role?
            </h2>
            <p className="text-sm text-slate-400 mb-6">
              This helps us tailor the experience for you.
            </p>
            <div className="grid gap-3">
              {ROLES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setRole(r.value)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                    role === r.value
                      ? 'bg-blue-500/10 border-blue-500/40 ring-1 ring-blue-500/30'
                      : 'bg-slate-800 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  <span className="block text-sm font-semibold text-white">
                    {r.label}
                  </span>
                  <span className="block text-xs text-slate-400 mt-0.5">
                    {r.desc}
                  </span>
                </button>
              ))}
            </div>

            {/* LinkedIn profile (optional) */}
            <div className="mt-6 pt-6 border-t border-slate-800">
              <label htmlFor="linkedin" className="block text-sm font-semibold text-white mb-1">
                LinkedIn profile
              </label>
              <p className="text-xs text-slate-400 mb-3">
                Helps us understand who you are and what you&apos;re building.
              </p>
              <input
                id="linkedin"
                type="url"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                placeholder="https://www.linkedin.com/in/yourname"
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors text-sm"
              />
            </div>
          </div>
        )}

        {/* Step 2: Geographies */}
        {step === 2 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              Which geographies do you care about?
            </h2>
            <p className="text-sm text-slate-400 mb-6">
              We&apos;ll only alert you about funding rounds in these regions. Pick &ldquo;Worldwide&rdquo; to see everything.
            </p>
            <div className="flex flex-wrap gap-2">
              {COUNTRIES.map((c) => (
                <button
                  key={c.value}
                  onClick={() => toggleCountry(c.value)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                    countries.includes(c.value)
                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {countries.length > 0 && (
              <p className="text-xs text-slate-500 mt-3">
                {countries.length} selected
              </p>
            )}
          </div>
        )}

        {/* Step 3: Funding range + types */}
        {step === 3 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              What funding rounds interest you?
            </h2>
            <p className="text-sm text-slate-400 mb-6">
              Set the amount range and round types you want to track.
            </p>

            {/* Amount sliders */}
            <div className="space-y-4 mb-6">
              <div>
                <label className="flex items-center justify-between text-sm text-slate-300 mb-2">
                  <span>Minimum amount</span>
                  <span className="text-emerald-400 font-medium">
                    {formatAmountLabel(minAmount)}
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={500_000_000}
                  step={1_000_000}
                  value={minAmount}
                  onChange={(e) => setMinAmount(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                />
              </div>
              <div>
                <label className="flex items-center justify-between text-sm text-slate-300 mb-2">
                  <span>Maximum amount</span>
                  <span className="text-emerald-400 font-medium">
                    {maxAmount >= 500_000_000
                      ? '$500M+ (no cap)'
                      : formatAmountLabel(maxAmount)}
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={500_000_000}
                  step={1_000_000}
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                />
              </div>
            </div>

            {/* Funding types */}
            <div>
              <h3 className="text-sm font-medium text-slate-300 mb-3">
                Round Types
              </h3>
              <div className="flex flex-wrap gap-2">
                {FUNDING_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => toggleFundingType(type)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                      fundingTypes.includes(type)
                        ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                        : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
                    }`}
                  >
                    {formatFundingType(type)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Choose plan — Trial / Basic / Pro. No free option. */}
        {step === 4 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              Choose your plan
            </h2>
            <p className="text-sm text-slate-400 mb-6">
              Try us for $2.99 / 7 days, or jump straight to Basic or Pro. Cancel anytime.
            </p>

            {/* Lapsed-subscriber shortcut: if the user already paid in the past
                (stripe_customer_id is set), their fastest path back to access
                is updating the card on their existing subscription via the
                Stripe Customer Portal — not running a fresh checkout. */}
            {hasStripeCustomer && (
              <div className="mb-6 rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
                <p className="text-sm font-semibold text-white mb-1">
                  Already had a card on file?
                </p>
                <p className="text-xs text-slate-400 mb-3">
                  Update your payment method to restore your previous plan instead of starting over.
                </p>
                <button
                  type="button"
                  onClick={openCustomerPortal}
                  disabled={openingPortal}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white transition-colors"
                >
                  {openingPortal ? 'Opening portal…' : 'Update payment method →'}
                </button>
              </div>
            )}

            {/* Annual / Monthly billing toggle — sits above the cards so the
                user sees the choice before pricing displays. Default is
                'annual' so the first impression is the discounted price. The
                toggle has no effect on the Trial card (fixed $2.99 one-time
                charge), but is shown regardless so users learn about the
                cadence choice up front. */}
            <div className="mb-6 flex justify-center">
              <div className="inline-flex rounded-full bg-slate-900/70 p-0.5 ring-1 ring-slate-700">
                <button
                  type="button"
                  onClick={() => setBillingCycle('annual')}
                  className={`rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all ${
                    billingCycle === 'annual'
                      ? 'bg-emerald-600 text-white shadow'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Annual
                </button>
                <button
                  type="button"
                  onClick={() => setBillingCycle('monthly')}
                  className={`rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all ${
                    billingCycle === 'monthly'
                      ? 'bg-emerald-600 text-white shadow'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Monthly
                </button>
              </div>
            </div>

            <div className="grid gap-3">
              {/* Trial card — recommended */}
              <button
                type="button"
                onClick={() => setChosenTier('trial')}
                className={`text-left p-5 rounded-xl border-2 transition-all relative ${
                  chosenTier === 'trial'
                    ? 'bg-gradient-to-br from-emerald-500/15 to-blue-500/10 border-emerald-400 ring-2 ring-emerald-400/30'
                    : 'bg-slate-800/40 border-slate-700 hover:border-emerald-500/40'
                }`}
              >
                <div className="absolute -top-2.5 right-4 px-2 py-0.5 rounded-full bg-emerald-500 text-xs font-bold text-slate-900">
                  RECOMMENDED
                </div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-base font-bold text-white">7-day trial</span>
                  <span className="text-sm font-semibold text-emerald-300">$2.99</span>
                </div>
                <p className="text-[11px] text-slate-400 mb-2">
                  Auto-converts to Basic ($19.99/mo) on day 8 unless cancelled.
                </p>
                <ul className="space-y-1.5">
                  <li className="flex items-start gap-2 text-xs text-slate-300">
                    <span className="text-emerald-400">✓</span>
                    Daily/weekly email digest
                  </li>
                  <li className="flex items-start gap-2 text-xs text-slate-300">
                    <span className="text-emerald-400">✓</span>
                    Web dashboard + custom filters
                  </li>
                  <li className="flex items-start gap-2 text-xs text-slate-300">
                    <span className="text-emerald-400">✓</span>
                    Cancel anytime — one click
                  </li>
                </ul>
              </button>

              {/* Basic card */}
              <button
                type="button"
                onClick={() => setChosenTier('basic')}
                className={`text-left p-5 rounded-xl border-2 transition-all ${
                  chosenTier === 'basic'
                    ? 'bg-slate-800 border-slate-400 ring-1 ring-slate-300/30'
                    : 'bg-slate-800/40 border-slate-700 hover:border-slate-500'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-base font-bold text-white">Basic</span>
                  <span className="text-sm font-semibold text-slate-200">
                    {billingCycle === 'annual' ? '$8.25/mo' : '$19.99/mo'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mb-2">
                  {billingCycle === 'annual'
                    ? 'Billed $99 once a year — save $140 vs monthly.'
                    : 'Billed monthly. Cancel anytime.'}
                </p>
                <ul className="space-y-1.5">
                  <li className="flex items-start gap-2 text-xs text-slate-300">
                    <span className="text-emerald-400">✓</span>
                    Daily/weekly email digest
                  </li>
                  <li className="flex items-start gap-2 text-xs text-slate-300">
                    <span className="text-emerald-400">✓</span>
                    Web dashboard + custom filters
                  </li>
                  <li className="flex items-start gap-2 text-xs text-slate-500">
                    <span className="text-slate-600">✗</span>
                    Real-time alerts (Pro only)
                  </li>
                  <li className="flex items-start gap-2 text-xs text-slate-500">
                    <span className="text-slate-600">✗</span>
                    SMS / Slack / Telegram (Pro only)
                  </li>
                </ul>
              </button>

              {/* Pro card */}
              <button
                type="button"
                onClick={() => setChosenTier('pro')}
                className={`text-left p-5 rounded-xl border-2 transition-all ${
                  chosenTier === 'pro'
                    ? 'bg-gradient-to-br from-emerald-500/10 to-blue-500/10 border-emerald-400 ring-2 ring-emerald-400/30'
                    : 'bg-slate-800/40 border-slate-700 hover:border-emerald-500/40'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-base font-bold text-white">Pro</span>
                  <span className="text-sm font-semibold text-emerald-300">
                    {billingCycle === 'annual' ? '$49/mo' : '$89/mo'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mb-2">
                  {billingCycle === 'annual'
                    ? 'Billed $588 once a year — save $480 vs monthly.'
                    : 'Billed monthly. Cancel anytime.'}
                </p>
                <ul className="space-y-1.5">
                  <li className="flex items-start gap-2 text-xs text-slate-200">
                    <span className="text-emerald-400">✓</span>
                    <strong className="text-white">Real-time</strong> alerts (within 1 min)
                  </li>
                  <li className="flex items-start gap-2 text-xs text-slate-200">
                    <span className="text-emerald-400">✓</span>
                    <strong className="text-white">SMS</strong>, <strong className="text-white">Slack</strong>, Telegram, Teams
                  </li>
                  <li className="flex items-start gap-2 text-xs text-slate-200">
                    <span className="text-emerald-400">✓</span>
                    Email digest + dashboard + bookmarks + CSV export
                  </li>
                </ul>
              </button>

            </div>

            <p className="text-xs text-slate-500 mt-4 text-center">
              Want to add Slack or Telegram later? Find them in <strong className="text-slate-400">Settings → Integrations</strong> after onboarding.
            </p>
          </div>
        )}

        {/* Step 5: Telegram (optional) */}
        {step === 5 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              Want instant alerts on Telegram?
            </h2>
            <p className="text-sm text-slate-400 mb-6">
              Quick to connect and works on every device. Connect now in 30 seconds —
              or skip and add it later from Settings.
            </p>

            {telegramConnected ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
                <div className="text-3xl mb-2">✅</div>
                <h3 className="text-lg font-semibold text-white mb-1">
                  Telegram connected!
                </h3>
                <p className="text-sm text-slate-300">
                  You&apos;ll start receiving funding alerts in your Telegram chat.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-6">
                <div className="flex items-start gap-3 mb-5">
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center text-xl">
                    📱
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      Get pinged the moment a round matches your filters
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      No app install. No phone number. Works on any device with
                      Telegram. We&apos;ll never DM you outside funding alerts.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleConnectTelegram}
                  disabled={telegramConnecting}
                  className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {telegramConnecting ? 'Waiting for confirmation in Telegram…' : 'Connect Telegram'}
                </button>

                {telegramConnecting && (
                  <p className="text-xs text-slate-400 mt-3 text-center">
                    A new tab opened. Tap <strong>Start</strong> in the bot to
                    confirm. We&apos;ll detect it automatically.
                  </p>
                )}
              </div>
            )}

            <p className="text-xs text-slate-500 mt-4 text-center">
              Prefer Slack, Teams, SMS, or email? Set them up after onboarding in <strong className="text-slate-400">Settings</strong>.
            </p>
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-slate-700/50">
          {step > 1 ? (
            <button
              onClick={() => setStep(step - 1)}
              className="text-sm text-slate-400 hover:text-white font-medium transition-colors"
            >
              Back
            </button>
          ) : (
            <div />
          )}

          {step < TOTAL_STEPS ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          ) : (
            // Final step (5): always go through Stripe Checkout. The free
            // signup escape hatch was removed 2026-04-29.
            <button
              onClick={handleCheckout}
              disabled={upgrading}
              className="px-6 py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-blue-500 hover:from-emerald-400 hover:to-blue-400 text-white text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-500/30"
            >
              {upgrading
                ? 'Loading checkout…'
                : chosenTier === 'trial'
                  ? telegramConnected
                    ? 'Continue to checkout (start trial) →'
                    : 'Skip & start 7-day trial →'
                  : telegramConnected
                    ? `Continue to ${chosenTier === 'pro' ? 'Pro' : 'Basic'} checkout →`
                    : `Skip & continue to ${chosenTier === 'pro' ? 'Pro' : 'Basic'} →`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      <OnboardingPageInner />
    </Suspense>
  )
}
