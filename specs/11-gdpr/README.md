# Spec 11 — GDPR Compliance

Tiered, incremental compliance. Each tier is independently shippable with its own trigger, effort estimate, and PR.

| Tier | Status | Trigger | Effort | Spec |
|------|--------|---------|--------|------|
| 1 — Minimum legal | [x] Shipped | EU launch | 1d | [01](./01-tier-1-minimum.md) |
| 2 — Operational hygiene | [ ] Not started | DSR > 2/mo or 1st enterprise ask | 2d | [02](./02-tier-2-hygiene.md) |
| 3 — Defensibility | [ ] Not started | Audit request or MRR > £10k/mo | 3d | [03](./03-tier-3-defensibility.md) |
| 4 — Enterprise posture | [ ] Not started | Enterprise pipeline justifies spend | 1w | [04](./04-tier-4-enterprise.md) |

See [`00-overview.md`](./00-overview.md) for the full context and GDPR article traceability.

## Current state
- [x] Tier 1 shipped — minimum legal surface for EU launch (migration 005, unsubscribe flow, clickwrap, zero-retention, public legal pages, DSR script).

## Deferred decisions (revisit when moving to next tier)
- (Populated as we go.)

## How to work on this
1. Pick the lowest un-shipped tier.
2. Open its spec file, follow the checklist top to bottom.
3. Tick checkboxes as you go; commit per logical unit.
4. Update status in this index on merge: `[x] Shipped (commit: <sha>)`.
5. Add anything deferred to the "Deferred decisions" section above with the tier that introduced it.
