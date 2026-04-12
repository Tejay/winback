# How to use this with Claude Code

## One-time setup

Copy all files from this package into your Next.js project root.
`CLAUDE.md` must be in the project root — Claude Code reads it automatically at the start of every session.

## Starting Claude Code

```bash
cd your-project-folder
claude
```

First message to send:
```
Read CLAUDE.md and TASKS.md. The project is a fresh Next.js app with no backend.
Start with Task 1.1 — audit what already exists and report back before touching anything.
```

## STOP checkpoints

Every spec has `⛔ CHECKPOINT` sections. Claude Code will pause and wait for your reply.

These cover:
- Database migration SQL (you review it before it runs)
- Anthropic API call cost (~$0.003, you approve before the call)
- Real email send (you approve before anything is sent)
- OAuth setup in your browser (Stripe Dashboard, Google Cloud Console)
- Stripe CLI webhook testing
- Visual review of UI against live site
- Billing formula verification

**Just type `yes` to continue, or give corrections if something looks wrong.**

## Check progress at any time

```
Which tasks in TASKS.md are complete? What's the next unchecked task?
```

## Fix a mistake

```
Stop. That's wrong — [explain the problem]. Do not continue until this is fixed.
```

## Spec file map

| Spec | Covers |
|------|--------|
| specs/01-database-auth.md | Database schema, Drizzle, NextAuth, shared components |
| specs/02-public-pages.md | Landing page, login, register |
| specs/03-onboarding.md | All 4 onboarding steps with exact UI |
| specs/04-core-engine.md | Stripe signals, LLM classifier, Resend email, inbound webhook |
| specs/05-dashboard.md | Dashboard page, subscriber table, detail panel |
| specs/06-settings.md | Settings page (integrations + billing sections) |
| specs/07-billing.md | Changelog trigger, fee calculation |

## Estimated time

| Phase | Tasks | Your active time |
|-------|-------|-----------------|
| 1 — Foundation | 1.1–1.6 | ~1 hour (DB setup, OAuth approvals) |
| 2 — Public pages | 2.1–2.3 | ~20 min (visual check) |
| 3 — Onboarding | 3.1–3.4 | ~45 min (OAuth flows in browser) |
| 4 — Core engine | 4.1–4.5 | ~45 min (Stripe CLI, email test, API approval) |
| 5 — Dashboard | 5.1–5.3 | ~30 min (visual check, action tests) |
| 6 — Settings | 6.1 | ~15 min |
| 7 — Billing | 7.1–7.2 | ~20 min (formula check) |
| 8 — Launch prep | 8.1–8.3 | ~20 min |
| **Total** | | **~4 hours your time** |
