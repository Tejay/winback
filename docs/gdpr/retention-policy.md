# Data Retention Policy

**GDPR Art. 5(1)(e)** — storage limitation. Filled in during Tier 1.

> Stub — populated as part of Tier 1. Manual enforcement until Tier 3 adds cron.

## Retention periods

| Table | Retention | Rationale |
|---|---|---|
| `wb_users` | Until account closure + 30d | Recovery window |
| `wb_customers` | Until account closure + 30d | Recovery window |
| `wb_churned_subscribers` | 2 years from `created_at` | Attribution + re-engagement window |
| `wb_churned_subscribers` (recovered) | 1 year past `attributionEndsAt` | MRR audit |
| `wb_emails_sent` | 2 years | Audit trail |
| `wb_recoveries` | 2 years past `attributionEndsAt` | MRR audit |
| `wb_legal_acceptances` | Until user deletion + 7 years | Contract evidence |

## Controller account closure
When a controller closes their account (`wb_customers` row deleted), all their subscriber data cascades immediately. No 30-day grace for subject data.

## Enforcement
- **Tier 1–2:** manual quarterly SQL cleanup, logged in `docs/gdpr/retention-runs/<date>.md`.
- **Tier 3+:** automated cron at `app/api/cron/retention/route.ts` (daily 03:00 UTC).
