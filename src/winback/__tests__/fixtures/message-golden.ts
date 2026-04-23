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
    name: 'Tier 1, changelog match, CSV export fix (concession beat opener + gift)',
    tier: 1,
    hasChangelogMatch: true,
    body: [
      'Hi Sarah,',
      '',
      "Fair call on the CSV cap — 1,000 rows was genuinely limiting after four months of using it every day. I rebuilt it last week so it's uncapped now and streams straight to S3. If that was the blocker, it's gone.",
      '',
      '— Alex',
    ].join('\n'),
  },
  {
    name: 'Tier 1, changelog match, API latency fix (concession beat opener + gift)',
    tier: 1,
    hasChangelogMatch: true,
    body: [
      'Hi Jordan,',
      '',
      "You're right that the API was too slow for anything serious. We shipped a new edge-cached layer last week that drops p95 from 800ms to around 90ms. If that was the missing piece, take another look whenever it suits.",
      '',
      '— Priya',
    ].join('\n'),
  },
  {
    name: 'Tier 2, enum only — honest reframe (gift) + specific question',
    tier: 2,
    body: [
      'Hi Sam,',
      '',
      "I saw Stripe flagged 'too expensive' as the reason your Pro plan ended, but I'd rather hear it in your own words. Sometimes the number's fine and it's actually the fit or value that's off. If one thing had been different, would you still be here?",
      '',
      '— Jamie',
    ].join('\n'),
  },
  {
    name: 'Tier 3, silent churn — tenure ack + permission to leave + specific question',
    tier: 3,
    body: [
      'Hi Morgan,',
      '',
      "Thanks for the eight months — genuinely. I'm not going to chase you, and there's nothing I'm selling here. If you've got a spare second though, what was the actual dealbreaker?",
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
