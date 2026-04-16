# Changelog — how it works

A visual walkthrough of how the changelog field flows through the system,
when it's read, when it's written, and — critically — what it does *not*
trigger.

---

## 1. The big picture

One textarea. One column. Read at classification time. Never retroactive.

```mermaid
flowchart LR
  Founder([Founder])
  Textarea[Textarea drawer<br/>on dashboard]
  DB[(wb_customers<br/>changelog_text)]
  Classifier{{AI classifier<br/>Haiku 4.5}}
  Email[[Win-back email]]
  Subscriber([Cancelled subscriber])

  Founder -- edits --> Textarea
  Textarea -- PUT /api/changelog --> DB
  Subscriber -- cancels on Stripe --> Classifier
  DB -- read at classify time --> Classifier
  Classifier -- personalised copy --> Email
  Email -- sent via Resend --> Subscriber

  style DB fill:#f5f5f5,stroke:#64748b
  style Classifier fill:#e0f2fe,stroke:#0284c7
  style Email fill:#dcfce7,stroke:#16a34a
```

---

## 2. Founder update — three patterns, one mechanic

Every save is a full overwrite of `changelog_text`. The founder's behaviour
varies; the system's behaviour doesn't.

```mermaid
flowchart TB
  Open[Founder opens drawer]
  Prefill[Drawer pre-filled<br/>with current text]

  Open --> Prefill
  Prefill --> Choice{What are<br/>they doing?}

  Choice -- "Add a new shipment" --> A[Type new line at top<br/>leave old lines intact]
  Choice -- "Fix a fact" --> B[Edit in place<br/>e.g. $4 → $5]
  Choice -- "Prune stale entries" --> C[Delete lines<br/>that aren't current truth]

  A --> Save[Hit save]
  B --> Save
  C --> Save

  Save --> Write[(PUT /api/changelog<br/>replaces changelog_text)]
  Write --> Done[Done — zero side effects]

  style Done fill:#dcfce7,stroke:#16a34a
  style Write fill:#f5f5f5,stroke:#64748b
```

**Key point:** the *mechanic* is always "overwrite." The *behaviour* the
founder adopts is "edit a living doc." They add, correct, and prune — they
don't start from scratch, and they don't append forever.

---

## 3. What a save does and does NOT do

The single most important diagram in this doc. Every "No" is what keeps the
product simple and prevents spam.

```mermaid
flowchart TB
  Save[Founder hits save]
  Write[(Write changelog_text<br/>to wb_customers)]

  Save --> Write

  Write --> Does[✅ DOES]
  Write --> DoesNot[❌ DOES NOT]

  Does --> D1[Update the field]
  Does --> D2[Make new future<br/>classifications smarter]
  Does --> D3[Remove the empty-state<br/>nudge on dashboard]

  DoesNot --> N1[Re-classify past<br/>subscribers]
  DoesNot --> N2[Send any emails]
  DoesNot --> N3[Create a version row]
  DoesNot --> N4[Notify anyone]
  DoesNot --> N5[Trigger a job]

  style Does fill:#dcfce7,stroke:#16a34a
  style DoesNot fill:#fee2e2,stroke:#dc2626
  style N1 fill:#fee2e2,stroke:#dc2626
  style N2 fill:#fee2e2,stroke:#dc2626
  style N3 fill:#fee2e2,stroke:#dc2626
  style N4 fill:#fee2e2,stroke:#dc2626
  style N5 fill:#fee2e2,stroke:#dc2626
```

---

## 4. The read path — what happens on a new cancellation

This is the only place `changelog_text` is consumed. Every cancellation
event pulls the *current* changelog and hands it to the AI.

```mermaid
sequenceDiagram
  autonumber
  participant S as Stripe
  participant W as /api/stripe/webhook
  participant DB as Postgres
  participant AI as Claude Haiku 4.5
  participant R as Resend
  participant C as Subscriber

  S->>W: customer.subscription.deleted
  W->>DB: load customer (incl. changelog_text)
  W->>DB: extract signals from Stripe
  W->>AI: classify(signals, {productName, founderName, changelog})
  AI-->>W: tier, reason, suppress?, winBackBody
  alt suppress = false & email exists
    W->>R: send(winBackBody)
    R->>C: personalised win-back email
    W->>DB: insert churnedSubscriber status='contacted'
  else suppress = true
    W->>DB: insert churnedSubscriber status='skipped'
  end
```

The changelog is read in step 2 (customer load) and consumed in step 4
(classify). It has no role after the email is sent.

---

## 5. Time-ordered example — founder updates over 45 days

Concrete walkthrough of three updates and what each one actually changes.
Read top-to-bottom.

```mermaid
sequenceDiagram
  autonumber
  participant F as Founder
  participant DB as changelog_text
  participant AI as Classifier
  participant Past as Past subscribers
  participant Future as Future cancellations

  Note over F,Future: Day 0, 09:00 — onboarding complete
  F->>DB: (empty)
  Note over Past: 12 backfilled, already classified with no changelog

  Note over F,Future: Day 0, 16:00 — first fill
  F->>DB: "Offline mode. iOS share fix. 40% faster cold start."
  Note over Past: Untouched. Decisions frozen.
  Note over Future: Next cancellation benefits.

  Note over F,Future: Day 1, 09:00 — new cancellation
  Future->>AI: stripe_comment = "need offline for trips"
  DB-->>AI: current changelog
  AI-->>Future: Tier 1 email — "You mentioned offline, we shipped it last week"

  Note over F,Future: Day 14, 11:00 — append new feature
  F->>DB: "Team workspaces $5/seat. Offline mode. iOS share fix. 40% faster."
  Note over Past: 30 cancellations between day 1–14 untouched.
  Note over Future: New cancellations can match team workspaces.

  Note over F,Future: Day 14, 15:00 — cancellation matches
  Future->>AI: stripe_comment = "too expensive for one, would split"
  DB-->>AI: current changelog
  AI-->>Future: Tier 1 email — offers team workspaces

  Note over F,Future: Day 45, 21:00 — typo fix
  F->>DB: "Team workspaces $5/seat..." (fixed from $4)
  Note over Past: NOTHING HAPPENS. No wave. No emails.
  Note over Future: Next cancellation sees corrected price.
```

---

## 6. Why no versioning, no re-evaluation

Explicit rejection of four common temptations, with the reason each is out.

```mermaid
flowchart LR
  Q{Tempting feature}

  Q --> T1[Version history<br/>of changelog]
  Q --> T2[Re-evaluate past<br/>subs on update]
  Q --> T3[Structured entries<br/>title, date, tags]
  Q --> T4[Notify founder per<br/>contact/skip decision]

  T1 --> R1[❌ No consumer needs<br/>'the changelog at time T'.<br/>Past decisions are frozen<br/>in the subscriber row.]
  T2 --> R2[❌ Spam risk, founder<br/>loses control, edits become<br/>loaded weapons.]
  T3 --> R3[❌ LLM reads prose better<br/>than schema. Structured form<br/>gets abandoned.]
  T4 --> R4[❌ Dashboard already<br/>shows everything.<br/>Notifications = noise.]

  style R1 fill:#fee2e2,stroke:#dc2626
  style R2 fill:#fee2e2,stroke:#dc2626
  style R3 fill:#fee2e2,stroke:#dc2626
  style R4 fill:#fee2e2,stroke:#dc2626
```

---

## 7. Content guidance — what makes a good changelog entry

```mermaid
flowchart TB
  Entry[A line you're<br/>about to add]

  Entry --> Q1{Specific in the<br/>customer's language?}
  Q1 -- No --> F1[❌ Rewrite.<br/>'Improved sharing reliability'<br/>→ 'Fixed iOS share extension']
  Q1 -- Yes --> Q2

  Q2{Customer-visible<br/>outcome, not work?}
  Q2 -- No --> F2[❌ Drop it.<br/>'Migrated to new sync engine'<br/>is internal.]
  Q2 -- Yes --> Q3

  Q3{Shipped recently<br/>~3-6 months?}
  Q3 -- No --> F3[❌ Prune.<br/>Old wins don't trigger<br/>recoveries.]
  Q3 -- Yes --> Keep[✅ Keep as one line.<br/>Add date in parens if useful.]

  style Keep fill:#dcfce7,stroke:#16a34a
  style F1 fill:#fef3c7,stroke:#d97706
  style F2 fill:#fef3c7,stroke:#d97706
  style F3 fill:#fef3c7,stroke:#d97706
```

**Target length:** 200–800 chars sweet spot. Cap ~2000. Soft character
counter in the UI guides the founder; no hard limit.

---

## 8. Cadence — when to update

```mermaid
flowchart LR
  Ship[Founder ships something]

  Ship --> Q{Worth a release tweet?}

  Q -- Yes --> Update[Update changelog<br/>same day]
  Q -- No --> Skip[Skip]

  Update --> Examples1[Major features<br/>Pricing changes<br/>Customer-visible bug fixes]
  Skip --> Examples2[Internal refactors<br/>Marketing page tweaks<br/>Ops work]

  style Update fill:#dcfce7,stroke:#16a34a
  style Skip fill:#f5f5f5,stroke:#64748b
```

Expected rhythm: one bulk fill at onboarding (last 3 months of shipments),
then a quick edit every 1–4 weeks as they ship.

---

## 9. The complete lifecycle on one page

```mermaid
flowchart TB
  subgraph Onboarding
    O1[Founder connects Stripe]
    O2[Dashboard loads]
    O3[Empty-state nudge:<br/>'Add what you've shipped →']
    O1 --> O2 --> O3
  end

  subgraph FirstFill[First fill]
    F1[Opens drawer]
    F2[Placeholder shows example]
    F3[Types 3–6 recent shipments]
    F4[Save]
    F1 --> F2 --> F3 --> F4
  end

  subgraph OngoingEdits[Ongoing edits]
    E1[Ships a feature]
    E2[Opens drawer — text pre-filled]
    E3[Adds line at top<br/>or edits in place<br/>or prunes]
    E4[Save]
    E1 --> E2 --> E3 --> E4
  end

  subgraph ClassificationLoop[Per cancellation]
    C1[Subscriber cancels]
    C2[Webhook fires]
    C3[Classifier reads current changelog]
    C4[AI decides: suppress / email]
    C5[Email sent or skip logged]
    C1 --> C2 --> C3 --> C4 --> C5
  end

  Onboarding --> FirstFill
  FirstFill --> OngoingEdits
  OngoingEdits -.-> ClassificationLoop
  FirstFill -.-> ClassificationLoop

  style Onboarding fill:#f5f5f5,stroke:#64748b
  style FirstFill fill:#e0f2fe,stroke:#0284c7
  style OngoingEdits fill:#e0f2fe,stroke:#0284c7
  style ClassificationLoop fill:#dcfce7,stroke:#16a34a
```

Dotted arrows mean "independent — happens whenever a cancellation occurs,
not triggered by the edit."

---

## Recap in one sentence

**The founder edits a living doc; the system reads it at classification
time; nothing retroactive ever happens.** Everything else in this file is a
consequence of those three rules.
