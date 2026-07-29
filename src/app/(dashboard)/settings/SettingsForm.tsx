'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Profile, UserPreferences } from '@/lib/types'
import { canUseProFeatures } from '@/lib/access'
import ApiKeysSection from '@/components/ApiKeysSection'

const FUNDING_TYPES = [
  'pre-seed',
  'seed',
  'series-a',
  'series-b',
  'series-c',
  'series-d',
]

const INDUSTRIES = [
  'AI/ML',
  'SaaS',
  'FinTech',
  'HealthTech',
  'Climate',
  'B2B',
  'B2C',
  'EdTech',
  'Security',
  'Data',
]

const COUNTRIES = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'IL', label: 'Israel' },
  { value: 'IN', label: 'India' },
  { value: 'AU', label: 'Australia' },
  { value: 'SG', label: 'Singapore' },
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

function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return token
}

interface SettingsFormProps {
  profile: Profile
  preferences: UserPreferences
}

export default function SettingsForm({
  profile: initialProfile,
  preferences: initialPreferences,
}: SettingsFormProps) {
  // Routed through canUseProFeatures to keep all Pro gates consistent across
  // the codebase. Semantically identical to `plan === 'pro'`.
  const isPro = canUseProFeatures(initialProfile)
  const isLegacyFree = initialProfile.plan === 'free' && initialProfile.legacy_free === true

  const [profile, setProfile] = useState({
    full_name: initialProfile.full_name || '',
    company: initialProfile.company || '',
    timezone: initialProfile.timezone || 'America/New_York',
  })
  const [prefs, setPrefs] = useState({
    min_amount: initialPreferences.min_amount,
    // null = no cap; the slider parks at its ceiling for that state.
    max_amount: initialPreferences.max_amount ?? 500_000_000,
    funding_types: initialPreferences.funding_types,
    countries: initialPreferences.countries,
    industries: initialPreferences.industries,
    digest_frequency: initialPreferences.digest_frequency,
    digest_hour: initialPreferences.digest_hour,
    slack_webhook_url: initialPreferences.slack_webhook_url || '',
    teams_webhook_url: initialPreferences.teams_webhook_url || '',
    slack_channel_email: initialPreferences.slack_channel_email || '',
    teams_channel_email: initialPreferences.teams_channel_email || '',
    linkedin_url: initialPreferences.linkedin_url || '',
  })
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // ----- Telegram state -----
  const [telegramChatId, setTelegramChatId] = useState<number | null>(
    initialPreferences.telegram_chat_id,
  )
  const [telegramLinking, setTelegramLinking] = useState(false)

  // ----- Web Push state -----
  const [pushEnabled, setPushEnabled] = useState(!!initialPreferences.push_subscription)
  const [pushLoading, setPushLoading] = useState(false)

  // ----- Phone notification state (iMessage v1, SMS coming soon) -----
  const [phoneNumber, setPhoneNumber] = useState(initialPreferences.phone_number || '')
  const [phoneVerified, setPhoneVerified] = useState(initialPreferences.phone_verified)
  const [verificationCode, setVerificationCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [phoneLoading, setPhoneLoading] = useState(false)
  const [smsConsent, setSmsConsent] = useState(false)
  // iMessage is deferred to v1.1 (pending business Apple ID setup).
  // Field stays in DB so the dispatcher and UI can light up later without a migration.
  const [imessageEnabled] = useState(initialPreferences.imessage_enabled ?? false)

  // ----- Slack App state -----
  const [slackAppInstalled, setSlackAppInstalled] = useState(
    initialPreferences.slack_app_installed,
  )

  // Check for Slack OAuth callback result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('slack') === 'connected') {
      setSlackAppInstalled(true)
      setToast({ type: 'success', message: 'Slack app connected successfully!' })
      setTimeout(() => setToast(null), 4000)
      // Clean URL
      window.history.replaceState({}, '', '/settings')
    } else if (params.get('slack') === 'error') {
      setToast({ type: 'error', message: 'Failed to connect Slack app.' })
      setTimeout(() => setToast(null), 4000)
      window.history.replaceState({}, '', '/settings')
    }
  }, [])

  function toggleArrayItem(
    key: 'funding_types' | 'countries' | 'industries',
    item: string,
  ) {
    const current = prefs[key]
    const updated = current.includes(item)
      ? current.filter((i) => i !== item)
      : [...current, item]
    setPrefs({ ...prefs, [key]: updated })
  }

  // ----- Telegram: connect flow -----
  const handleConnectTelegram = useCallback(async () => {
    setTelegramLinking(true)
    const supabase = createClient()
    const token = generateToken()

    // Upsert the link token
    const { error } = await supabase
      .from('user_preferences')
      .upsert(
        { user_id: initialProfile.id, telegram_link_token: token },
        { onConflict: 'user_id' },
      )

    if (error) {
      setToast({ type: 'error', message: `Failed to generate Telegram link: ${error.message}` })
      setTelegramLinking(false)
      return
    }

    // Open Telegram deep link
    window.open(`https://t.me/FundingScoutAlerts_Bot?start=${token}`, '_blank')

    // Poll for connection every 3s for up to 60s
    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      if (attempts > 20) {
        clearInterval(interval)
        setTelegramLinking(false)
        return
      }

      const { data } = await supabase
        .from('user_preferences')
        .select('telegram_chat_id')
        .eq('user_id', initialProfile.id)
        .single()

      if (data?.telegram_chat_id) {
        clearInterval(interval)
        setTelegramChatId(data.telegram_chat_id)
        setTelegramLinking(false)
        setToast({ type: 'success', message: 'Telegram connected!' })
        setTimeout(() => setToast(null), 4000)
      }
    }, 3000)
  }, [initialProfile.id])

  const handleDisconnectTelegram = useCallback(async () => {
    const supabase = createClient()
    await supabase
      .from('user_preferences')
      .update({ telegram_chat_id: null, telegram_link_token: null })
      .eq('user_id', initialProfile.id)

    setTelegramChatId(null)
    setToast({ type: 'success', message: 'Telegram disconnected.' })
    setTimeout(() => setToast(null), 4000)
  }, [initialProfile.id])

  // ----- Web Push: enable/disable -----
  const handleTogglePush = useCallback(async () => {
    setPushLoading(true)
    const supabase = createClient()

    if (pushEnabled) {
      // Disable: remove subscription
      await supabase
        .from('user_preferences')
        .update({ push_subscription: null })
        .eq('user_id', initialProfile.id)
      setPushEnabled(false)
      setPushLoading(false)
      setToast({ type: 'success', message: 'Push notifications disabled.' })
      setTimeout(() => setToast(null), 4000)
      return
    }

    // Enable: request permission and subscribe
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setToast({ type: 'error', message: 'Push notifications not supported in this browser.' })
      setPushLoading(false)
      return
    }

    // If the user (or their browser) already blocked notifications previously,
    // requestPermission() returns 'denied' immediately without showing a prompt.
    // Tell them how to manually unblock since the browser won't ask again.
    if (Notification.permission === 'denied') {
      setToast({
        type: 'error',
        message:
          'Notifications blocked by your browser. Click the lock icon next to the URL, allow notifications, then reload this page.',
      })
      setPushLoading(false)
      return
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      setToast({
        type: 'error',
        message:
          'Notifications blocked by your browser. Click the lock icon next to the URL, allow notifications, then reload this page.',
      })
      setPushLoading(false)
      return
    }

    try {
      const registration = await navigator.serviceWorker.ready
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!vapidKey) {
        setToast({ type: 'error', message: 'VAPID key not configured.' })
        setPushLoading(false)
        return
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      })

      const subJson = subscription.toJSON()

      await supabase
        .from('user_preferences')
        .upsert(
          { user_id: initialProfile.id, push_subscription: subJson },
          { onConflict: 'user_id' },
        )

      setPushEnabled(true)
      setToast({ type: 'success', message: 'Push notifications enabled!' })
      setTimeout(() => setToast(null), 4000)
    } catch (err) {
      console.error('Push subscription failed:', err)
      setToast({ type: 'error', message: 'Failed to enable push notifications.' })
    }
    setPushLoading(false)
  }, [pushEnabled, initialProfile.id])

  // ----- SMS: send code -----
  const handleSendCode = useCallback(async () => {
    if (!phoneNumber.trim()) return
    setPhoneLoading(true)

    try {
      const res = await fetch('/api/verify-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', phone: phoneNumber.trim() }),
      })
      const data = await res.json()
      if (data.sent) {
        setCodeSent(true)
        setToast({ type: 'success', message: 'Verification code sent!' })
        setTimeout(() => setToast(null), 4000)
      } else {
        setToast({ type: 'error', message: data.error || 'Failed to send code.' })
        setTimeout(() => setToast(null), 4000)
      }
    } catch {
      setToast({ type: 'error', message: 'Failed to send verification code.' })
      setTimeout(() => setToast(null), 4000)
    }
    setPhoneLoading(false)
  }, [phoneNumber])

  // ----- SMS: confirm code -----
  const handleConfirmCode = useCallback(async () => {
    if (!verificationCode.trim()) return
    setPhoneLoading(true)

    try {
      const res = await fetch('/api/verify-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', code: verificationCode.trim() }),
      })
      const data = await res.json()
      if (data.verified) {
        setPhoneVerified(true)
        setCodeSent(false)
        setVerificationCode('')
        setToast({ type: 'success', message: 'Phone number verified!' })
        setTimeout(() => setToast(null), 4000)
      } else {
        setToast({ type: 'error', message: data.error || 'Invalid code.' })
        setTimeout(() => setToast(null), 4000)
      }
    } catch {
      setToast({ type: 'error', message: 'Failed to verify code.' })
      setTimeout(() => setToast(null), 4000)
    }
    setPhoneLoading(false)
  }, [verificationCode])

  // ----- Slack App: disconnect -----
  const handleDisconnectSlack = useCallback(async () => {
    const supabase = createClient()
    await supabase
      .from('user_preferences')
      .update({
        slack_app_installed: false,
        slack_bot_token: null,
        slack_team_id: null,
        slack_channel_id: null,
      })
      .eq('user_id', initialProfile.id)

    setSlackAppInstalled(false)
    setToast({ type: 'success', message: 'Slack app disconnected.' })
    setTimeout(() => setToast(null), 4000)
  }, [initialProfile.id])

  // ----- Save handler -----
  async function handleSave() {
    setSaving(true)
    setToast(null)

    const supabase = createClient()

    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        full_name: profile.full_name || null,
        company: profile.company || null,
        timezone: profile.timezone || 'America/New_York',
      })
      .eq('id', initialProfile.id)

    if (profileError) {
      setToast({ type: 'error', message: `Profile update failed: ${profileError.message}` })
      setSaving(false)
      return
    }

    const { error: prefsError } = await supabase
      .from('user_preferences')
      .upsert(
        {
          user_id: initialProfile.id,
          min_amount: prefs.min_amount,
          // Slider at the ceiling means "$500M+" — store null so the alert
          // matcher applies no upper bound. A literal 500M silently drops
          // every mega-round above it.
          max_amount:
            prefs.max_amount >= 500_000_000 ? null : prefs.max_amount,
          funding_types: prefs.funding_types,
          countries: prefs.countries,
          industries: prefs.industries,
          digest_frequency: prefs.digest_frequency,
          digest_hour: prefs.digest_hour,
          slack_webhook_url: prefs.slack_webhook_url || null,
          teams_webhook_url: prefs.teams_webhook_url || null,
          slack_channel_email: prefs.slack_channel_email || null,
          teams_channel_email: prefs.teams_channel_email || null,
          linkedin_url: prefs.linkedin_url || null,
          imessage_enabled: imessageEnabled,
        },
        { onConflict: 'user_id' },
      )

    if (prefsError) {
      setToast({ type: 'error', message: `Preferences update failed: ${prefsError.message}` })
      setSaving(false)
      return
    }

    setToast({ type: 'success', message: 'Settings saved successfully.' })
    setSaving(false)
    setTimeout(() => setToast(null), 4000)
  }

  // ----- Pro-only wrapper for channel sections -----
  function ProGate({ children }: { children: React.ReactNode }) {
    if (isPro) return <>{children}</>
    return (
      <div className="relative">
        <div className="opacity-50 pointer-events-none">{children}</div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="bg-slate-800/90 border border-slate-600 rounded-lg px-4 py-2 text-sm text-slate-300">
            Upgrade to Pro to enable this channel
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-8">
      {/* Toast notification */}
      {toast && (
        <div
          className={`fixed top-20 right-6 z-50 px-4 py-3 rounded-lg border shadow-lg text-sm font-medium transition-all ${
            toast.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Profile Section */}
      <section className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Profile</h2>
        <div className="grid gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Full Name
            </label>
            <input
              type="text"
              value={profile.full_name}
              onChange={(e) =>
                setProfile({ ...profile, full_name: e.target.value })
              }
              placeholder="John Smith"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Company
            </label>
            <input
              type="text"
              value={profile.company}
              onChange={(e) =>
                setProfile({ ...profile, company: e.target.value })
              }
              placeholder="Acme Corp"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              LinkedIn profile
            </label>
            <input
              type="url"
              value={prefs.linkedin_url}
              onChange={(e) =>
                setPrefs({ ...prefs, linkedin_url: e.target.value })
              }
              placeholder="https://www.linkedin.com/in/yourname"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
            />
          </div>
        </div>
      </section>

      {/* Preferences Section */}
      <section className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">
          Alert Preferences
        </h2>
        <div className="space-y-6">
          {/* Amount Range */}
          <div>
            <h3 className="text-sm font-medium text-slate-300 mb-3">
              Funding Amount Range
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">
                  Min: {formatAmountLabel(prefs.min_amount)}
                </label>
                <input
                  type="range"
                  min={0}
                  max={500_000_000}
                  step={1_000_000}
                  value={prefs.min_amount}
                  onChange={(e) =>
                    setPrefs({ ...prefs, min_amount: Number(e.target.value) })
                  }
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">
                  Max:{' '}
                  {prefs.max_amount >= 500_000_000
                    ? '$500M+ (no cap)'
                    : formatAmountLabel(prefs.max_amount)}
                </label>
                <input
                  type="range"
                  min={0}
                  max={500_000_000}
                  step={1_000_000}
                  value={prefs.max_amount}
                  onChange={(e) =>
                    setPrefs({ ...prefs, max_amount: Number(e.target.value) })
                  }
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Funding Types */}
          <div>
            <h3 className="text-sm font-medium text-slate-300 mb-3">
              Funding Types
            </h3>
            <div className="flex flex-wrap gap-2">
              {FUNDING_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleArrayItem('funding_types', type)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    prefs.funding_types.includes(type)
                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  {formatFundingType(type)}
                </button>
              ))}
            </div>
          </div>

          {/* Industries */}
          <div>
            <h3 className="text-sm font-medium text-slate-300 mb-3">
              Industries
            </h3>
            <div className="flex flex-wrap gap-2">
              {INDUSTRIES.map((industry) => (
                <button
                  key={industry}
                  type="button"
                  onClick={() => toggleArrayItem('industries', industry)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    prefs.industries.includes(industry)
                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  {industry}
                </button>
              ))}
            </div>
          </div>

          {/* Countries */}
          <div>
            <h3 className="text-sm font-medium text-slate-300 mb-3">
              Countries
            </h3>
            <div className="flex flex-wrap gap-2">
              {COUNTRIES.map((country) => (
                <button
                  key={country.value}
                  type="button"
                  onClick={() => toggleArrayItem('countries', country.value)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    prefs.countries.includes(country.value)
                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  {country.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Email alerts Section */}
      <section className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Email alerts</h2>
        <div className="space-y-6">
          {/* Digest Frequency */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Digest Frequency
            </label>
            <div className="flex gap-3">
              {(['daily', 'weekly'] as const).map((freq) => (
                <button
                  key={freq}
                  type="button"
                  onClick={() =>
                    setPrefs({ ...prefs, digest_frequency: freq })
                  }
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    prefs.digest_frequency === freq
                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  {freq.charAt(0).toUpperCase() + freq.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Digest Time + Timezone */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Digest Time
            </label>
            <p className="text-xs text-slate-500 mb-2">
              When you want your daily/weekly digest delivered, in your local time.
            </p>
            <div className="flex gap-3 flex-wrap">
              <select
                value={prefs.digest_hour}
                onChange={(e) =>
                  setPrefs({ ...prefs, digest_hour: Number(e.target.value) })
                }
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
              >
                {Array.from({ length: 24 }, (_, i) => {
                  const label = i === 0 ? '12:00 AM' : i < 12 ? `${i}:00 AM` : i === 12 ? '12:00 PM' : `${i - 12}:00 PM`
                  return <option key={i} value={i}>{label}</option>
                })}
              </select>
              <select
                value={profile.timezone}
                onChange={(e) =>
                  setProfile({ ...profile, timezone: e.target.value })
                }
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
              >
                <option value="America/New_York">Eastern (ET)</option>
                <option value="America/Chicago">Central (CT)</option>
                <option value="America/Los_Angeles">Pacific (PT)</option>
              </select>
            </div>
          </div>

          {/* ---- Real-time alerts header ---- */}
          <div className="border-t border-slate-700/50 pt-6">
            <h2 className="text-lg font-semibold text-white mb-1">Real-time alerts</h2>
            <p className="text-xs text-slate-500 mb-4">
              Get funding alerts the moment they break — pushed to your favorite tools.
            </p>
          </div>

          {/* ---- Slack Section ---- */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-3">Slack</h3>
            <ProGate>
              {slackAppInstalled ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      Connected
                    </span>
                    <span className="text-sm text-slate-400">Slack App installed</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleDisconnectSlack}
                    className="text-sm text-red-400 hover:text-red-300 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <a
                    href={`https://slack.com/oauth/v2/authorize?client_id=${process.env.NEXT_PUBLIC_SLACK_CLIENT_ID || ''}&scope=chat:write,commands,incoming-webhook&redirect_uri=${encodeURIComponent('https://fundingscout.io/api/slack/callback')}`}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#4A154B] hover:bg-[#611f64] text-white text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.164 0a2.528 2.528 0 0 1 2.521 2.522v6.312zM15.164 18.956a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.164 24a2.528 2.528 0 0 1-2.521-2.522v-2.522h2.521zm0-1.271a2.528 2.528 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.314A2.528 2.528 0 0 1 24 15.164a2.528 2.528 0 0 1-2.522 2.521h-6.314z" />
                    </svg>
                    Add to Slack
                  </a>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      Or use a webhook URL (legacy)
                    </label>
                    <input
                      type="url"
                      value={prefs.slack_webhook_url}
                      onChange={(e) =>
                        setPrefs({ ...prefs, slack_webhook_url: e.target.value })
                      }
                      placeholder="https://hooks.slack.com/services/..."
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors text-sm"
                    />
                  </div>
                  <details className="rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2">
                    <summary className="text-xs font-semibold text-slate-300 cursor-pointer">
                      Workplace Slack locked down? Use channel email instead
                    </summary>
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-slate-400 leading-relaxed">
                        If your IT requires app approval, you can route alerts via your channel&apos;s built-in
                        email address — no app install needed. In Slack: open your channel → click the channel name →
                        Integrations → Send emails to this channel → copy the generated address and paste below.
                      </p>
                      <input
                        type="email"
                        value={prefs.slack_channel_email}
                        onChange={(e) =>
                          setPrefs({ ...prefs, slack_channel_email: e.target.value })
                        }
                        placeholder="channel-name-abc123@yourcompany.slack.com"
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors text-xs"
                      />
                    </div>
                  </details>
                </div>
              )}
            </ProGate>
          </div>

          {/* ---- Teams Section ---- */}
          <div className="border-t border-slate-700/50 pt-6">
            <h3 className="text-sm font-semibold text-white mb-3">Microsoft Teams</h3>
            <ProGate>
              <input
                type="url"
                value={prefs.teams_webhook_url}
                onChange={(e) =>
                  setPrefs({ ...prefs, teams_webhook_url: e.target.value })
                }
                placeholder="https://outlook.office.com/webhook/..."
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
              />
              <p className="text-xs text-slate-500 mt-1">
                Receive alerts directly in your Teams channel.
              </p>
              <details className="mt-3 rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2">
                <summary className="text-xs font-semibold text-slate-300 cursor-pointer">
                  Workplace Teams locked down? Use channel email instead
                </summary>
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    If your IT requires app approval, route alerts via your channel&apos;s built-in
                    email. In Teams: open your channel → click the &ldquo;...&rdquo; menu → Get
                    email address → copy and paste below.
                  </p>
                  <input
                    type="email"
                    value={prefs.teams_channel_email}
                    onChange={(e) =>
                      setPrefs({ ...prefs, teams_channel_email: e.target.value })
                    }
                    placeholder="Channel Name - Workspace abc@amer.teams.ms"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors text-xs"
                  />
                </div>
              </details>
            </ProGate>
          </div>

          {/* ---- Telegram Section ---- */}
          <div className="border-t border-slate-700/50 pt-6">
            <h3 className="text-sm font-semibold text-white mb-3">Telegram</h3>
            <ProGate>
              {telegramChatId ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      Connected
                    </span>
                    <span className="text-sm text-slate-400">
                      Chat ID: {telegramChatId}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleDisconnectTelegram}
                    className="text-sm text-red-400 hover:text-red-300 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleConnectTelegram}
                  disabled={telegramLinking}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0088cc] hover:bg-[#006fa1] text-white text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                  </svg>
                  {telegramLinking ? 'Waiting for connection...' : 'Connect Telegram'}
                </button>
              )}
              <p className="text-xs text-slate-500 mt-2">
                Receive instant alerts via Telegram bot.
              </p>
            </ProGate>
          </div>

          {/* ---- Web Push Section ---- */}
          <div className="border-t border-slate-700/50 pt-6">
            <h3 className="text-sm font-semibold text-white mb-3">
              Push Notifications
            </h3>
            <ProGate>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-300">
                    {pushEnabled
                      ? 'Push notifications are enabled for this browser.'
                      : 'Get browser notifications for new funding alerts.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleTogglePush}
                  disabled={pushLoading}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                    pushEnabled
                      ? 'bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30'
                      : 'bg-blue-500/20 text-blue-300 border border-blue-500/40 hover:bg-blue-500/30'
                  }`}
                >
                  {pushLoading
                    ? 'Loading...'
                    : pushEnabled
                      ? 'Disable'
                      : 'Enable'}
                </button>
              </div>
            </ProGate>
          </div>

          {/* ---- Phone Notifications Section (SMS v1, iMessage coming soon) ---- */}
          <div className="border-t border-slate-700/50 pt-6">
            <h3 className="text-sm font-semibold text-white mb-1">Phone Notifications</h3>
            <p className="text-xs text-slate-500 mb-3">
              Get instant funding alerts on your phone via SMS. Up to 10 messages per day.
              Msg &amp; data rates may apply. Reply STOP to unsubscribe, HELP for help. See{' '}
              <a href="/sms" className="text-emerald-400 hover:underline">SMS terms</a>{' '}
              and{' '}
              <a href="/privacy" className="text-emerald-400 hover:underline">Privacy Policy</a>.
            </p>
            {phoneVerified ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    Verified
                  </span>
                  <span className="text-sm text-slate-400">{phoneNumber}</span>
                </div>
                {isPro ? (
                  <p className="text-xs text-slate-400">
                    You&apos;ll receive SMS alerts at this number for matching funding rounds.
                  </p>
                ) : (
                  <p className="text-xs text-amber-300">
                    SMS alerts require Pro. Your number is verified — upgrade to start receiving real-time texts.
                  </p>
                )}
                <label className="flex items-center gap-2 opacity-50 cursor-not-allowed">
                  <input
                    type="checkbox"
                    disabled
                    className="w-4 h-4 rounded border-slate-700 bg-slate-800"
                  />
                  <span className="text-sm text-slate-400">
                    Also notify via iMessage{' '}
                    <span className="text-slate-500 text-xs">(coming soon)</span>
                  </span>
                </label>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+1 (555) 123-4567"
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
                  />
                </div>
                <div className="rounded-lg border border-slate-600 bg-slate-800/50 p-4">
                  <p className="text-sm text-slate-300 mb-3">
                    By checking the box below and clicking &quot;Send Code,&quot; I agree to receive
                    recurring automated SMS text messages from FundingScout containing
                    real-time funding alerts matching my saved filters. Up to 10 messages
                    per day. Message and data rates may apply. Consent is not a condition
                    of any purchase. Reply STOP at any time to unsubscribe, or HELP for
                    help.
                  </p>
                  <label className="flex items-start gap-3 cursor-pointer mb-3">
                    <input
                      type="checkbox"
                      checked={smsConsent}
                      onChange={(e) => setSmsConsent(e.target.checked)}
                      className="w-4 h-4 mt-0.5 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500"
                    />
                    <span className="text-sm text-white font-medium">
                      I agree to receive SMS text messages from FundingScout
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={phoneLoading || !phoneNumber.trim() || !smsConsent}
                    className="w-full px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {phoneLoading ? 'Sending...' : 'Send Code'}
                  </button>
                  <p className="text-xs text-slate-500 mt-2">
                    See our{' '}
                    <a href="/sms" className="text-emerald-400 hover:underline">SMS terms</a>{' '}
                    and{' '}
                    <a href="/privacy" className="text-emerald-400 hover:underline">Privacy Policy</a>.
                  </p>
                </div>
                {codeSent && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={verificationCode}
                      onChange={(e) => setVerificationCode(e.target.value)}
                      placeholder="6-digit code"
                      maxLength={6}
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
                    />
                    <button
                      type="button"
                      onClick={handleConfirmCode}
                      disabled={phoneLoading || verificationCode.length !== 6}
                      className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Verify
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Plan Info */}
      <section className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-2">Plan</h2>
        <div className="flex items-center justify-between">
          <div>
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                initialProfile.plan === 'pro'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : initialProfile.plan === 'basic'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                    : 'bg-slate-700 text-slate-300 border border-slate-600'
              }`}
            >
              {initialProfile.plan === 'pro'
                ? 'Pro'
                : initialProfile.plan === 'basic'
                  ? 'Basic'
                  : isLegacyFree
                    ? 'Free (legacy)'
                    : 'Free'}
            </span>
            <p className="text-sm text-slate-400 mt-1">
              {initialProfile.plan === 'pro'
                ? 'Unlimited alerts, bookmarks, and integrations.'
                : initialProfile.plan === 'basic'
                  ? 'Daily/weekly digest, dashboard, and saved filters. Upgrade to Pro for real-time alerts.'
                  : isLegacyFree
                    ? "You're on our legacy free plan. Thanks for being an early user!"
                    : 'Subscribe to access funding alerts.'}
            </p>
          </div>

          <div className="flex flex-shrink-0 ml-4 gap-2">
            {/* Pro users + paying Basic users go to the Stripe Customer Portal
                to manage their subscription (cancel, update card, switch plan).
                Legacy free + paywalled users go to the upgrade flow instead. */}
            {(initialProfile.plan === 'pro' || initialProfile.plan === 'basic') && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await fetch('/api/portal', { method: 'POST' })
                    const data = await res.json()
                    if (data.url) {
                      window.location.href = data.url
                    } else if (data.redirect) {
                      window.location.href = data.redirect
                    } else {
                      setToast({
                        type: 'error',
                        message: data.error || 'Failed to open billing portal.',
                      })
                    }
                  } catch {
                    setToast({
                      type: 'error',
                      message: 'Network error. Please try again.',
                    })
                  }
                }}
                className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors"
              >
                Manage subscription
              </button>
            )}
            {initialProfile.plan !== 'pro' && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const planId = initialProfile.plan === 'basic' ? 'pro' : 'trial'
                    const res = await fetch('/api/create-checkout', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ plan: planId }),
                    })
                    const data = await res.json()
                    if (data.url) {
                      window.location.href = data.url
                    } else {
                      setToast({
                        type: 'error',
                        message: data.error || 'Failed to start checkout. Please try again.',
                      })
                    }
                  } catch {
                    setToast({
                      type: 'error',
                      message: 'Network error. Please try again.',
                    })
                  }
                }}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
              >
                {initialProfile.plan === 'basic' ? 'Upgrade to Pro' : isLegacyFree ? 'Upgrade' : 'Subscribe'}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* API Keys (Pro feature) */}
      <ApiKeysSection isPro={isPro} />

      {/* Save button */}
      <div className="flex justify-end pb-8">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
