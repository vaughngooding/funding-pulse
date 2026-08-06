import type { EarlyAlert } from '@/lib/types'

const STAGE_LABEL: Record<string, string> = {
  no_prior: 'First round',
  seed_prior: 'Post-seed',
  series_a_prior: 'Post-Series A',
  later_stage: 'Later stage',
  ambiguous: 'Stage unclear',
}

const STAGE_COLOR: Record<string, string> = {
  no_prior: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  seed_prior: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  ambiguous: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  series_a_prior: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  later_stage: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
}

function fmtAmount(usd: number | null | undefined): string {
  if (!usd) return '—'
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  return `$${usd.toLocaleString()}`
}

function daysAgo(iso: string): number {
  const d = new Date(iso + 'T00:00:00Z')
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000))
}

// Filings this size confirm at 3-4x the rate of smaller ones — give them
// a visually distinct card so they read as the priority signals.
const BIG_FILING_USD = 20_000_000

export default function EarlyAlertCard({ alert }: { alert: EarlyAlert }) {
  const age = daysAgo(alert.form_d_filing_date)
  const stageLabel = STAGE_LABEL[alert.stage_category] ?? alert.stage_category
  const stageColor =
    STAGE_COLOR[alert.stage_category] ??
    'bg-slate-700/40 text-slate-300 border-slate-600'
  const isBig = (alert.amount_usd ?? 0) >= BIG_FILING_USD

  return (
    <article
      className={`rounded-lg border p-4 ${
        isBig
          ? 'border-emerald-500/40 bg-emerald-950/20'
          : 'border-slate-700/60 bg-slate-900/60'
      }`}>
      {/* Top row: name + amount + age + stage badge */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h3 className="text-white font-semibold">
            {alert.entity_name}
          </h3>
          <span className="text-emerald-400 font-medium">
            {fmtAmount(alert.amount_usd)}
          </span>
          {alert.status === 'confirmed' && alert.lead_time_days != null ? (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              {alert.lead_time_days > 0
                ? `✨ called it ${alert.lead_time_days}d early`
                : `matched ${Math.abs(alert.lead_time_days)}d after`}
            </span>
          ) : (
            <span className="text-xs text-slate-400">
              filed {age >= 0 ? `${age}d ago` : `in ${-age}d`}
            </span>
          )}
        </div>
        <span
          className={`text-[11px] px-2 py-0.5 rounded-full border ${stageColor}`}
        >
          {stageLabel}
        </span>
      </div>

      {/* Meta chips */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px] text-slate-400">
        {alert.industry && (
          <span className="px-1.5 py-0.5 rounded bg-slate-800/80">
            {alert.industry}
          </span>
        )}
        {alert.state_of_business && (
          <span className="px-1.5 py-0.5 rounded bg-slate-800/80">
            {alert.state_of_business}
          </span>
        )}
        <span className="px-1.5 py-0.5 rounded bg-slate-800/80 uppercase tracking-wide">
          {alert.v5_bin}
        </span>
      </div>

      {/* Prior round info from Haiku+Exa lookup */}
      {alert.prior_stage && alert.prior_stage !== 'unknown' && (
        <p className="mt-3 text-xs text-slate-400 leading-snug">
          <span className="text-slate-300">Prior round:</span>{' '}
          <strong className="text-slate-200">{alert.prior_stage}</strong>{' '}
          {alert.prior_amount_usd ? fmtAmount(alert.prior_amount_usd) : ''}
          {alert.prior_year ? ` · ${alert.prior_year}` : ''}
          {alert.prior_evidence ? (
            <>
              {' — '}
              <em className="text-slate-500">{alert.prior_evidence}</em>
            </>
          ) : null}
        </p>
      )}

      {/* Verifier evidence — short snippet */}
      {alert.verifier_evidence && (
        <p className="mt-2 text-xs text-slate-500 leading-snug border-l-2 border-slate-700 pl-3">
          {alert.verifier_evidence.slice(0, 240)}
          {alert.verifier_evidence.length > 240 ? '…' : ''}
        </p>
      )}

      {/* Links */}
      <div className="mt-3 flex items-center gap-3 text-xs text-blue-400">
        {alert.website_url && (
          <a
            href={alert.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            🌐 website
          </a>
        )}
        <a
          href={alert.form_d_url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          📄 Form D index
        </a>
        <a
          href={alert.form_d_xml_url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline text-slate-500"
        >
          XML
        </a>
        {alert.verifier_article_url && (
          <a
            href={alert.verifier_article_url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            source
          </a>
        )}
      </div>
    </article>
  )
}
