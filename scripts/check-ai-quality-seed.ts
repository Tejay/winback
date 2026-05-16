/**
 * Sanity-check the AI quality dashboard seed. Reads what each block's
 * query would aggregate and prints it — quick way to confirm the data
 * shape before clicking through the page.
 */

import {
  weekVsBaseline, cancellationCategoryMix, lowConfidenceClassifications,
  calibrationCohort, reengagementMatchRate,
  rankedAutoLostAudit, rankedHandoffAudit, handoffAuditSummary,
} from '../lib/admin/ai-quality-queries'

async function main() {
  console.log('\n=== Block 1: Calibration ===')
  const cal = await calibrationCohort(90, 30)
  console.log(`Cohort: n=${cal.total} (${cal.startDate.toLocaleDateString()} – ${cal.endDate.toLocaleDateString()})`)
  for (const r of cal.byLikelihood) {
    const recPct = r.n > 0 ? ((r.recovered / r.n) * 100).toFixed(0) : '—'
    const alPct  = r.n > 0 ? ((r.autoLost / r.n) * 100).toFixed(0) : '—'
    console.log(`  ${r.likelihood.padEnd(7)} n=${r.n.toString().padStart(3)}  recovered=${recPct}%  auto-lost=${alPct}%  lost-other=${r.lostOther}  still-open=${r.stillOpen}`)
  }
  for (const h of cal.handoffConversion) {
    const rec = h.n > 0 ? ((h.recovered / h.n) * 100).toFixed(0) : '—'
    console.log(`  ${h.cohort.padEnd(12)} n=${h.n.toString().padStart(3)}  recovered=${rec}%`)
  }
  console.log(`  auto-lost reversal: ${cal.autoLostReversal.reversed} / ${cal.autoLostReversal.n} cases`)

  console.log('\n=== Block 2: Drift (7d vs 23d) ===')
  const drift = await weekVsBaseline()
  for (const m of drift.metrics) {
    const dStr = m.deltaPct === null ? '—' : `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%`
    console.log(`  ${m.label.padEnd(32)} ${String(m.last7d.toFixed(2)).padStart(7)} vs ${String(m.prior23d.toFixed(2)).padStart(7)}  Δ ${dStr.padStart(6)}  ${m.flagged ? '⚠' : ''}`)
  }

  console.log('\n=== Block 3: Category mix ===')
  const cat = await cancellationCategoryMix()
  console.log(`Total 30d: ${cat.total30d}`)
  for (const r of cat.rows) {
    console.log(`  ${r.category.padEnd(11)} n=${r.count30d.toString().padStart(3)}  ${r.pct30d.toFixed(0)}%  Δ${r.pctShift7d > 0 ? '+' : ''}${r.pctShift7d.toFixed(1)}pp`)
  }

  console.log('\n=== Block 4: Smart-ranked auto-lost (top 5) ===')
  const al = await rankedAutoLostAudit(15)
  for (const r of al.slice(0, 5)) {
    console.log(`  score=${r.interestScore} mrr=$${(r.mrrCents / 100).toFixed(0)} replies=${r.replyCount} cat=${r.cancellationCategory ?? '—'} portal=${r.billingPortalClicked} — ${r.name}`)
  }

  console.log('\n=== Block 5: Handoff audit summary ===')
  const sum = await handoffAuditSummary(30)
  console.log(`  ${sum.total} handoffs · ${sum.resolved} resolved · ${sum.recovered} recovered (${sum.recoveryPct.toFixed(0)}%) · ${sum.open} open · ${sum.stale} stale`)
  const hands = await rankedHandoffAudit(15)
  const byState = hands.reduce<Record<string, number>>((acc, h) => {
    acc[h.resolutionState] = (acc[h.resolutionState] ?? 0) + 1
    return acc
  }, {})
  console.log(`  Resolution states: ${JSON.stringify(byState)}`)

  console.log('\n=== Block 6: Low-confidence ===')
  const low = await lowConfidenceClassifications(25)
  console.log(`  ${low.length} subscribers with confidence < 0.4`)

  console.log('\n=== Block 7: Match rate ===')
  const mr = await reengagementMatchRate(90)
  console.log(`  eligible=${mr.eligible} · emailed=${mr.emailed} · pending=${mr.pending} · expired=${mr.expired}`)

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
