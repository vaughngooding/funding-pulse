import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  resolvePlanFromPriceId as resolvePlan,
  extractPriceId,
  extractIntendedPlan,
  planFromSubscriptionStatus,
  type PriceIdMap,
  type Plan,
} from './plan-resolver.ts'
import { createTrialSubscriptionFromPayment } from './trial-subscription.ts'

const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Stripe price IDs are mapped to plan tiers via env. Pro IDs are UNCHANGED;
// Basic IDs are net-new for the 2026-04-29 pricing change.
const PRICES: PriceIdMap = {
  basicMonthly: Deno.env.get('STRIPE_BASIC_MONTHLY_PRICE_ID') || '',
  basicAnnual: Deno.env.get('STRIPE_BASIC_ANNUAL_PRICE_ID') || '',
  proMonthly: Deno.env.get('STRIPE_PRO_PRICE_ID') || '',
  proAnnual: Deno.env.get('STRIPE_PRO_ANNUAL_PRICE_ID') || '',
}

// Resend email + trial-ending function URL — used for the trial_will_end
// reminder. Optional; if unset, the reminder simply doesn't send.
const TRIAL_ENDING_FUNCTION_URL = Deno.env.get('TRIAL_ENDING_FUNCTION_URL') || ''

// ---------- Signature verification helpers ----------

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = signatureHeader.split(',').reduce(
    (acc, part) => {
      const [key, value] = part.split('=')
      acc[key.trim()] = value
      return acc
    },
    {} as Record<string, string>,
  )

  const timestamp = parts['t']
  const expectedSignature = parts['v1']

  if (!timestamp || !expectedSignature) {
    console.error('Missing timestamp or v1 signature in Stripe-Signature header')
    return false
  }

  const timestampAge = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10)
  if (timestampAge > toleranceSeconds) {
    console.error(`Webhook timestamp too old: ${timestampAge}s exceeds ${toleranceSeconds}s tolerance`)
    return false
  }

  const signedPayload = `${timestamp}.${payload}`
  const encoder = new TextEncoder()

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signedPayload),
  )

  const computedSignature = uint8ArrayToHex(new Uint8Array(signatureBuffer))

  if (computedSignature.length !== expectedSignature.length) {
    return false
  }

  let mismatch = 0
  for (let i = 0; i < computedSignature.length; i++) {
    mismatch |= computedSignature.charCodeAt(i) ^ expectedSignature.charCodeAt(i)
  }
  return mismatch === 0
}

// ---------- Event handlers ----------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const STRIPE_AUTH = {
  Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
  'Content-Type': 'application/x-www-form-urlencoded',
}

// Duplicate-subscription guard (2026-08-25). Nothing used to cancel a
// user's existing subscription when they bought a new plan, so every
// trial/Basic -> Pro upgrade left TWO live subscriptions billing in
// parallel (first reported by a customer double-charged $19.99 + $89).
// After a paid subscription checkout completes, cancel every OTHER
// active/trialing subscription for this customer — including subscriptions
// under a different Stripe customer record with the same email (checkout
// used customer_email, which can mint a second customer object).
// Fail-soft: errors are logged, never thrown — the webhook must succeed.
async function cancelOtherSubscriptions(
  newSubId: string,
  customerId: string | null,
  email: string | null,
): Promise<void> {
  try {
    const customerIds = new Set<string>()
    if (customerId) customerIds.add(customerId)

    if (email) {
      const q = encodeURIComponent(`email:'${email.replace(/'/g, '')}'`)
      const res = await fetch(
        `https://api.stripe.com/v1/customers/search?query=${q}&limit=10`,
        { headers: STRIPE_AUTH },
      )
      if (res.ok) {
        const data = await res.json()
        for (const c of data.data ?? []) customerIds.add(c.id)
      } else {
        console.warn('dup-sub guard: customer search failed', res.status)
      }
    }

    for (const cid of customerIds) {
      const res = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${cid}&status=all&limit=20`,
        { headers: STRIPE_AUTH },
      )
      if (!res.ok) {
        console.warn(`dup-sub guard: sub list failed for ${cid}`, res.status)
        continue
      }
      const subs = await res.json()
      for (const sub of subs.data ?? []) {
        if (sub.id === newSubId) continue
        if (!['active', 'trialing', 'past_due'].includes(sub.status)) continue
        const del = await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
          method: 'DELETE',
          headers: STRIPE_AUTH,
        })
        if (del.ok) {
          console.log(
            `dup-sub guard: canceled ${sub.id} (${sub.status}) on ${cid} — superseded by ${newSubId}`,
          )
        } else {
          console.error(`dup-sub guard: cancel FAILED for ${sub.id}`, del.status, await del.text())
        }
      }
    }
  } catch (e) {
    console.error('dup-sub guard: unexpected error (webhook continues)', e)
  }
}

async function handleCheckoutCompleted(session: Record<string, unknown>) {
  // Match Stripe session → Supabase profile via metadata.user_id (preferred)
  // or case-insensitive email lookup.
  const metadata = session.metadata as Record<string, string> | null
  const userIdFromMetadata = metadata?.user_id || null
  const intendedPlan = metadata?.intended_plan || null

  // Two-step trial flow: a mode=payment session with checkout_plan=trial
  // means the user just paid $2.99 to start a 7-day Basic trial. Create the
  // subscription before continuing — that way the customer.subscription.*
  // events fire with the right metadata and the profile-update step below
  // will set plan='basic'. Throws on any Stripe error → Stripe retries the
  // webhook (idempotency key on the subscription create makes that safe).
  if (
    (session.mode as string) === 'payment' &&
    metadata?.checkout_plan === 'trial'
  ) {
    const subId = await createTrialSubscriptionFromPayment(
      { stripeSecretKey: STRIPE_SECRET_KEY, basicMonthlyPriceId: PRICES.basicMonthly },
      {
        id: session.id as string,
        customer: session.customer as string | null,
        payment_intent: session.payment_intent as string | null,
        metadata,
      },
    )
    console.log(`trial: created subscription ${subId} for session ${session.id}`)
  }

  const customerEmail =
    (session.customer_email as string | null) ??
    ((session.customer_details as Record<string, unknown> | null)?.email as string | null)

  const stripeCustomerId = session.customer as string | null


  // Resolve the target profile id. Prefer metadata.user_id (set by
  // /api/create-checkout from supabase.auth.getUser() — guaranteed to be
  // the auth.users.id). Fall back to email lookup only if metadata.user_id
  // is missing for some reason.
  let targetProfileId: string | null = userIdFromMetadata

  if (!targetProfileId && customerEmail) {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id')
      .ilike('email', customerEmail)
      .single()
    if (profile && !error) {
      targetProfileId = profile.id
    } else {
      console.warn('checkout.session.completed: email lookup failed', customerEmail, error)
    }
  }

  if (!targetProfileId) {
    console.error('checkout.session.completed: could not determine profile id from session', {
      userIdFromMetadata,
      customerEmail,
      stripeCustomerId,
    })
    return
  }

  // checkout.session.completed doesn't include line item price IDs by
  // default (would need to expand). The intended_plan metadata is the
  // primary signal here; subscription.updated will reconcile against the
  // real price ID a moment later.
  const newPlan = resolvePlan(null, intendedPlan, PRICES)

  // Defensive UPDATE-then-INSERT: the original SELECT-then-UPDATE path
  // silently no-op'd whenever the profile row didn't exist (handle_new_user
  // trigger races, signups via paths that bypass the trigger, etc.) —
  // returning 200 to Stripe while leaving the user paywalled. We instead
  // try UPDATE first; if it affects zero rows, INSERT the row. profiles.id
  // is a FK to auth.users.id, so the INSERT only succeeds for real auth
  // users — guarding against orphan profiles.
  const updatePayload = {
    plan: newPlan,
    stripe_customer_id: stripeCustomerId,
    // legacy_free intentionally NOT touched — it should retain whatever
    // value it had (false for new signups; true for grandfathered users
    // who happen to upgrade).
  }

  const { data: updatedRows, error: updateError } = await supabase
    .from('profiles')
    .update(updatePayload)
    .eq('id', targetProfileId)
    .select('id')

  if (updateError) {
    console.error('checkout.session.completed: update failed', { targetProfileId, updateError })
    return
  }

  if (!updatedRows || updatedRows.length === 0) {
    // Profile row missing — most likely the handle_new_user trigger didn't
    // fire (or hasn't yet). Create the row ourselves with the data we have.
    console.warn(
      `checkout.session.completed: profile ${targetProfileId} did not exist, inserting`,
    )
    const { error: insertError } = await supabase
      .from('profiles')
      .insert({
        id: targetProfileId,
        email: customerEmail,
        ...updatePayload,
      })
    if (insertError) {
      console.error('checkout.session.completed: insert failed', { targetProfileId, insertError })
    } else {
      console.log(
        `checkout.session.completed: created profile + set plan=${newPlan} for ${targetProfileId}`,
      )
    }
  } else {
    console.log(
      `checkout.session.completed: set plan=${newPlan} for profile ${targetProfileId} ` +
        `(intended=${intendedPlan})`,
    )
  }

  // Duplicate-subscription guard runs LAST so the profile's
  // stripe_customer_id already points at the new customer before the old
  // subscription's customer.subscription.deleted event can arrive — that
  // event matches profiles by customer id and would otherwise race a
  // momentary plan='free' downgrade.
  if ((session.mode as string) === 'subscription' && session.subscription) {
    await cancelOtherSubscriptions(
      session.subscription as string,
      stripeCustomerId,
      customerEmail,
    )
  }
}

async function handleSubscriptionUpdated(subscription: Record<string, unknown>) {
  const stripeCustomerId = subscription.customer as string
  const status = subscription.status as string

  if (!stripeCustomerId) {
    console.error('customer.subscription.updated: no customer ID on subscription')
    return
  }

  // `trialing` is a fully-entitled state — treat it like 'active' for plan purposes.
  const priceId = extractPriceId(subscription)
  const intended = extractIntendedPlan(subscription)
  const activePlan = resolvePlan(priceId, intended, PRICES)

  const newPlan: Plan | null = planFromSubscriptionStatus(status, activePlan)
  if (newPlan === null) {
    console.log(`customer.subscription.updated: unhandled status "${status}", skipping`)
    return
  }

  const { error } = await supabase
    .from('profiles')
    .update({ plan: newPlan })
    .eq('stripe_customer_id', stripeCustomerId)

  if (error) {
    console.error('customer.subscription.updated: failed to update profile', error)
  } else {
    console.log(
      `customer.subscription.updated: set plan=${newPlan} for customer ${stripeCustomerId} (status=${status})`,
    )
  }
}

async function handleSubscriptionDeleted(subscription: Record<string, unknown>) {
  const stripeCustomerId = subscription.customer as string
  if (!stripeCustomerId) {
    console.error('customer.subscription.deleted: no customer ID')
    return
  }

  // Drop to plan='free'. Crucially, do NOT touch legacy_free — its value
  // was set at migration time and never changes after. New signups stay at
  // legacy_free=false → paywalled.
  const { error } = await supabase
    .from('profiles')
    .update({ plan: 'free' })
    .eq('stripe_customer_id', stripeCustomerId)

  if (error) {
    console.error('customer.subscription.deleted: failed to update profile', error)
  } else {
    console.log(`customer.subscription.deleted: dropped customer ${stripeCustomerId} to plan=free`)
  }
}

async function handleTrialWillEnd(subscription: Record<string, unknown>) {
  // Stripe fires this 3 days before the trial converts. Forward to the
  // dedicated trial-ending function which sends the Resend email reminder.
  // We don't block the webhook on email delivery — fire-and-forget so a
  // mail outage doesn't cause Stripe to retry.
  if (!TRIAL_ENDING_FUNCTION_URL) {
    console.log('trial_will_end: TRIAL_ENDING_FUNCTION_URL not set, skipping reminder')
    return
  }

  const customerId = subscription.customer as string
  const trialEnd = subscription.trial_end as number | null

  try {
    await fetch(TRIAL_ENDING_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ stripe_customer_id: customerId, trial_end: trialEnd }),
    })
    console.log(`trial_will_end: forwarded reminder for customer ${customerId} (trial_end=${trialEnd})`)
  } catch (err) {
    console.error('trial_will_end: failed to forward reminder', err)
  }
}

// ---------- Edge function handler ----------

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const signatureHeader = request.headers.get('stripe-signature')
  if (!signatureHeader) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  const payload = await request.text()
  const isValid = await verifyStripeSignature(payload, signatureHeader, STRIPE_WEBHOOK_SECRET)
  if (!isValid) {
    console.error('Invalid Stripe webhook signature')
    return new Response('Invalid signature', { status: 401 })
  }

  let event: { type: string; data: { object: Record<string, unknown> } }
  try {
    event = JSON.parse(payload)
  } catch {
    return new Response('Invalid JSON payload', { status: 400 })
  }

  console.log(`Received Stripe event: ${event.type}`)

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object)
      break
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object)
      break
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object)
      break
    case 'customer.subscription.trial_will_end':
      await handleTrialWillEnd(event.data.object)
      break
    default:
      console.log(`Unhandled event type: ${event.type}`)
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
