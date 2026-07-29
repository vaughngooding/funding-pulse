import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import SettingsForm from './SettingsForm'
import type { Profile, UserPreferences } from '@/lib/types'

// Always fetch fresh — never serve a cached version. Critical so the Pro
// upgrade reflects in the UI immediately after the Stripe webhook fires.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SettingsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Fetch profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  // Fetch preferences
  const { data: preferences } = await supabase
    .from('user_preferences')
    .select('*')
    .eq('user_id', user.id)
    .single()

  // Provide defaults if preferences don't exist yet
  const defaultPreferences: UserPreferences = {
    id: '',
    user_id: user.id,
    min_amount: 0,
    max_amount: null,
    funding_types: [],
    countries: [],
    industries: [],
    digest_frequency: 'daily',
    digest_hour: 9,
    slack_webhook_url: null,
    teams_webhook_url: null,
    telegram_chat_id: null,
    telegram_link_token: null,
    push_subscription: null,
    phone_number: null,
    phone_verified: false,
    imessage_enabled: false,
    slack_team_id: null,
    slack_channel_id: null,
    slack_bot_token: null,
    slack_app_installed: false,
    slack_channel_email: null,
    teams_channel_email: null,
    linkedin_url: null,
  }

  const defaultProfile: Profile = {
    id: user.id,
    email: user.email || '',
    full_name: null,
    company: null,
    role: null,
    plan: 'free',
    legacy_free: false,
    timezone: 'America/New_York',
    stripe_customer_id: null,
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">
          Manage your profile and alert preferences.
        </p>
      </div>

      <SettingsForm
        profile={(profile as Profile) || defaultProfile}
        preferences={(preferences as UserPreferences) || defaultPreferences}
      />
    </div>
  )
}
