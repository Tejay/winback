# Prompts

This folder is the **source of truth** for every LLM system prompt the app sends to Anthropic. Edit the `.md` files; the build step bakes them into `src/winback/lib/prompts.generated.ts`.

## Files

| File | Used by | What it controls |
|---|---|---|
| `classifier-system.md` | `classifier.ts` → `classifySubscriber` | Tier 1 & 2 exit-email + follow-up voice. The biggest, most opinionated prompt. |
| `match-system.md` | `improvement-match.ts` → `checkImprovementMatch` | Gates whether a shipped feature actually addresses a subscriber's stated need. |
| `improvement-email-system.md` | `improvement-match.ts` → `generateImprovementEmail` | Writes the re-engagement email body when a match is found. |
| `improvement-sanity-system.md` | `improvement-match.ts` → `sanityCheckEmail` | Pre-send hallucination check. Fails closed. |
| `promotion-email-system.md` | `improvement-match.ts` → `generatePromotionEmail` | Writes the discount-bearing email for Tier 1 + Price subscribers when promos are enabled. |
| `promotion-sanity-system.md` | `improvement-match.ts` → `sanityCheckPromotionEmail` | Pre-send check for promotion emails. Fails closed. |
| `cluster-system.md` | `cluster-cancellations.ts` → `clusterCancellationsForCustomer` | Spec-79 themes: groups unmatched cancellations into "what to ship next" clusters for the founder dashboard. |

## How edits flow to production

```
   you edit              build script               TS imports
prompts/*.md   →   prompts.generated.ts   →   classifier.ts / improvement-match.ts
```

1. **Edit a `.md` file** in this folder.
2. Run `npm run prompts:build` (or just `npm run build` — `prebuild` triggers it automatically).
3. The generated file `src/winback/lib/prompts.generated.ts` updates.
4. Commit BOTH the `.md` change AND the regenerated `.ts` file. They must move together.

## Vercel deploys

The `prebuild` script in `package.json` runs `tsx scripts/build-prompts.ts` before every Vercel build, so production always uses the latest `.md` content. The generated file is also committed, which means deploys never depend on the build step succeeding — if `tsx` ever broke, the last committed generated file would still ship.

## Verifying nothing drifted

```bash
npm run prompts:verify
```

Re-extracts the originally-inlined string constants from `classifier.ts` and `improvement-match.ts` (where they used to live before this refactor) and compares them against the current generated constants. **Only meaningful immediately after the initial refactor** — once those inline definitions are gone from the source files (which they now are), this script can't compare against anything and will report missing constants. It's kept as a historical safety net.

For ongoing safety, just rerun `npm run prompts:build` after every edit and let the diff in `prompts.generated.ts` speak for itself.

## Voice / formatting rules (apply to all email-writer prompts)

The `classifier-system.md`, `improvement-email-system.md`, and `promotion-email-system.md` prompts share a common voice contract enforced by Zod schemas downstream:

- **Body ≤ 250 characters** (greeting + sentences + sign-off, newlines counted). The reactivation link and unsubscribe footer are appended outside the body.
- **EXACTLY 2 sentences** in the body. Three blows the cap.
- **First-person singular** ("I"), never "we" or "the team".
- **No exclamation marks. Ever.**
- **JSON output** — `{"subject": "...", "body": "..."}`. No markdown fences, no preamble.

If you break any of these, the email gets retried, then dead-lettered after 3 attempts. You'll see it in the admin dead-letter tile.

## Things NOT to touch via this folder

- **Model selection** (`claude-haiku-4-5-20251001`), **temperature**, **max_tokens** — they live in code because they're infrastructure decisions, not copy.
- **User prompts** (the dynamic per-call messages built from subscriber signals + business context) — those compose runtime data and stay in code.
- **Hardcoded email templates** (Tier 3 silent-churn, dunning, password reset, verification, etc.) — these are not LLM prompts. They live inline in `src/winback/lib/email.ts`, `classifier-tick.ts`, and `founder-handoff-email.ts`.

## Cluster prompt — `MIN_THEME_SIZE` drift guard

`cluster-system.md` is the only prompt where a code-side constant (`MIN_THEME_SIZE` in `src/winback/lib/cluster-cancellations.ts`, currently `3`) is hardcoded into the prompt text — specifically the line *"Each theme MUST include at least **3** subscribers"*.

If you ever change `MIN_THEME_SIZE`, you **must** update that number in `cluster-system.md` to match. A runtime assertion in `cluster-cancellations.ts` fires at module load and crashes the function loudly rather than silently sending a misaligned prompt to production, so drift is detectable. But fixing it = edit both, run `npm run prompts:build`, commit.

## Newline gotcha

Inside a TypeScript template literal (the previous home of these strings), `\n` in source becomes an actual newline character at runtime. When we moved the strings out to markdown, those escape sequences became real newlines in the `.md` files. So in `improvement-email-system.md` and `promotion-email-system.md`, you'll see the GOOD EXAMPLES blocks rendered as actual multi-line bodies, not as JSON-encoded `\n\n` strings. That matches what the LLM has been seeing all along.

If you ever want a literal `\n` in a prompt (you almost certainly don't), write `\\n` in the `.md` file.
