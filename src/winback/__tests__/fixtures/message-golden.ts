// Golden message fixtures used by classifier validator tests.
//
// Each `good` entry represents the standard we want the classifier to produce
// after the prompt tightening. `bad` entries document the anti-patterns we
// explicitly reject — if the validator ever starts accepting one of them,
// the prompt has drifted.

export interface Golden {
  name: string
  tier: 1 | 2 | 3 | 4
  hasChangelogMatch?: boolean
  body: string
}

export const good: Golden[] = [
  {
    name: 'Tier 1, changelog match, CSV export fix (tenure ack + reason ack)',
    tier: 1,
    hasChangelogMatch: true,
    body: [
      'Hi Sarah,',
      '',
      "Thanks for the four months with us — and fair call on the CSV export, the 1,000-row cap was genuinely limiting. I rebuilt it last week so it's uncapped now and streams directly to S3. No pressure at all, but if that was the blocker, it's gone.",
      '',
      '— Alex',
    ].join('\n'),
  },
  {
    name: 'Tier 1, changelog match, API latency fix (tenure ack + reason ack)',
    tier: 1,
    hasChangelogMatch: true,
    body: [
      'Hi Jordan,',
      '',
      'After six months, I can see why the slow API pushed you out — that was a fair frustration. The new edge-cached layer we shipped drops p95 from 800ms to around 90ms. If that was the missing piece, take another look whenever it suits.',
      '',
      '— Priya',
    ].join('\n'),
  },
  {
    name: 'Tier 2, enum only (too_expensive) — warmer, still ends with question',
    tier: 2,
    body: [
      'Hi Sam,',
      '',
      "I saw your Pro plan ended and Stripe flagged 'too expensive' as the reason. I'd rather hear what was actually going on for you — sometimes the number is fine, it's the fit or the value that's off. No pressure to reply, but if you have a second, what would have made it worth keeping?",
      '',
      '— Jamie',
    ].join('\n'),
  },
  {
    name: 'Tier 3, silent churn — warm acknowledgement of tenure, ends with question',
    tier: 3,
    body: [
      'Hi Morgan,',
      '',
      "Thanks for the eight months with us — genuinely. I'm not going to chase you, and there's nothing I'm trying to sell here. If you've got a spare second though, what was it that pushed you away?",
      '',
      '— Taylor',
    ].join('\n'),
  },
]

export interface BadGolden extends Golden {
  expectIssue: RegExp  // at least one issue must match this
}

export const bad: BadGolden[] = [
  {
    name: 'pushy CTA with exclamation + urgency + fluff',
    tier: 1,
    hasChangelogMatch: true,
    body: [
      'Hi Sarah,',
      '',
      "We'd love to have you back — you're a valued customer. For a limited time, come back and we'll give you 20% off. Click here to reactivate today!",
      '',
      '— Alex',
    ].join('\n'),
    expectIssue: /banned phrase|!|limited time|stacks/,
  },
  {
    name: 'banned opener "just checking in"',
    tier: 3,
    body: [
      'Hi Jordan,',
      '',
      "Just checking in to see how you're doing since you left. Would you mind sharing what happened? Hit reply — one line is enough.",
      '',
      '— Priya',
    ].join('\n'),
    expectIssue: /just checking in/,
  },
  {
    name: 'question + CTA stacked',
    tier: 1,
    hasChangelogMatch: false,
    body: [
      'Hi Chris,',
      '',
      'I noticed you cancelled. Would you like to come back? Here is a link to reactivate.',
      '',
      '— Dana',
    ].join('\n'),
    expectIssue: /stacks a question and a CTA/,
  },
  {
    name: 'too long (5 sentences)',
    tier: 3,
    body: [
      'Hi Morgan,',
      '',
      "I saw your subscription ended. We appreciate the time you spent with us. We have shipped a lot of updates recently. I'd love your perspective on what went wrong. Would you mind sharing what happened?",
      '',
      '— Taylor',
    ].join('\n'),
    expectIssue: /maximum is 3/,
  },
  {
    name: 'tier 2 missing question',
    tier: 2,
    body: [
      'Hi Sam,',
      '',
      "Saw your Pro plan ended and Stripe flagged 'too expensive' as the reason. The door's open if things change.",
      '',
      '— Jamie',
    ].join('\n'),
    expectIssue: /must end with a genuine question/,
  },
  {
    name: 'tier 1 with changelog match asks a question (should be a pointer)',
    tier: 1,
    hasChangelogMatch: true,
    body: [
      'Hi Jordan,',
      '',
      'You mentioned the API was too slow. We shipped a new edge-cached layer that dropped p95 to about 90ms. Does that sound like it would help?',
      '',
      '— Priya',
    ].join('\n'),
    expectIssue: /must not ask a question/,
  },
]
