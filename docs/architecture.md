# Winback Architecture

Updated 2026-04-27 — reflects the post-billing-rewrite system (PRs #35–#39
plus Phase D hardening). Two Stripe accounts now: the customer's *Connected*
account (where subscribers live) and Winback's own *Platform* account (where
the founder is billed via Stripe Subscription).

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#3b82f6', 'primaryTextColor': '#0f172a', 'lineColor': '#64748b', 'fontSize': '13px' }}}%%

flowchart LR
  %% === Stripe accounts ===
  subgraph STRIPE_CONNECTED[" Stripe — Merchant (Connected) "]
    direction TB
    SCONN["Subscribers cancel\nor have card fail"]
  end

  subgraph STRIPE_PLATFORM[" Stripe — Winback (Platform) "]
    direction TB
    SUB99["$99/mo Subscription\non founder's card"]
    INV["Subscription invoices\n+ win-back fee items"]
  end

  %% === Webhook router ===
  subgraph INGEST[" Webhook router "]
    direction TB
    WH["app/api/stripe/webhook\nsignature verify"]
    WH --> ROUTE{"event.account?"}
  end

  %% === Connected-side processing ===
  subgraph CONNECTED_FLOW[" Connected events "]
    direction TB
    EXTRACT["extract signals\n(decrypted OAuth token)"]
    LLM["Claude Haiku\nclassify churn"]
    CHURN_DETECT["processChurn / Recovery /\nPaymentFailed / PaymentSucceeded"]
    EXTRACT --> LLM
    LLM --> CHURN_DETECT
  end

  %% === Activation (Phase B core) ===
  subgraph ACTIVATION[" Activation "]
    direction TB
    ENSURE["ensureActivation()\nidempotent, self-healing"]
    SUB_CREATE["ensurePlatformSubscription\n(creates $99/mo sub)"]
    PERF_CHARGE["chargePerformanceFee\n(1× MRR per win-back)"]
    REFUND["refundPerformanceFee\n(14-day window)"]
    ENSURE --> SUB_CREATE
    ENSURE --> PERF_CHARGE
  end

  %% === Outbound emails ===
  subgraph OUTBOUND[" Email out "]
    direction TB
    EXIT_EMAIL["Exit email\nLLM-written, per subscriber"]
    DUNNING_EMAIL["Dunning email\ncard-save link"]
    PAY_FAIL_EMAIL["Payment-failed alert\n(to founder, billing-notifications)"]
  end

  %% === User surfaces ===
  SUBSCRIBER["Subscriber inbox"]
  FOUNDER["Founder inbox"]

  subgraph UI[" App UI "]
    direction TB
    DASHBOARD["/dashboard\nrecoveries + first-recovery banner"]
    SETTINGS["/settings\nbilling card · Cancel/Resume\npast-due banner"]
    DELETE["/settings/delete\ncancels subscription immediately"]
  end

  %% === Persistence ===
  DB[("Neon Postgres\nwb_customers · wb_recoveries\nwb_churned_subscribers · wb_events")]

  %% === Wires ===
  SCONN -- "webhook (event.account set)" --> WH
  SUB99 -- "webhook (no event.account)" --> WH
  INV --> WH

  ROUTE -- "connected" --> EXTRACT
  ROUTE -- "platform" --> ACTIVATION

  CHURN_DETECT -- "win-back / card-save" --> ENSURE
  CHURN_DETECT -- "exit email send" --> EXIT_EMAIL
  CHURN_DETECT -- "dunning send" --> DUNNING_EMAIL
  CHURN_DETECT -- "re-cancel within 14d" --> REFUND

  ENSURE --> SUB_CREATE
  SUB_CREATE -- "creates" --> SUB99
  PERF_CHARGE -- "invoice item" --> INV
  REFUND -- "delete item / credit note" --> INV

  EXIT_EMAIL -- "via Resend" --> SUBSCRIBER
  DUNNING_EMAIL -- "via Resend" --> SUBSCRIBER
  WH -. "platform invoice failed" .-> PAY_FAIL_EMAIL
  PAY_FAIL_EMAIL -- "via Resend" --> FOUNDER

  %% === Subscriber loop ===
  SUBSCRIBER -- "reactivate / update card" --> SCONN
  SUBSCRIBER -. "reply" .-> LLM

  %% === In-product ===
  SETTINGS -- "Cancel / Resume" --> SUB99
  DELETE -- "immediate cancel + prorate" --> SUB99

  %% === DB ===
  CHURN_DETECT --> DB
  ENSURE --> DB
  PERF_CHARGE --> DB
  REFUND --> DB
  DASHBOARD --> DB
  SETTINGS --> DB
  WH --> DB

  %% === Styling ===
  classDef stripe fill:#dbeafe,stroke:#3b82f6,stroke-width:2px,color:#0f172a
  classDef process fill:#f0fdf4,stroke:#22c55e,stroke-width:2px,color:#0f172a
  classDef billing fill:#fef9c3,stroke:#eab308,stroke-width:2px,color:#0f172a
  classDef email fill:#ede9fe,stroke:#8b5cf6,stroke-width:2px,color:#0f172a
  classDef db fill:#fce7f3,stroke:#ec4899,stroke-width:2px,color:#0f172a
  classDef user fill:#fef3c7,stroke:#f59e0b,stroke-width:2px,color:#0f172a
  classDef ui fill:#fff,stroke:#e2e8f0,stroke-width:1px,color:#0f172a

  class SCONN,SUB99,INV stripe
  class WH,EXTRACT,LLM,CHURN_DETECT process
  class ENSURE,SUB_CREATE,PERF_CHARGE,REFUND billing
  class EXIT_EMAIL,DUNNING_EMAIL,PAY_FAIL_EMAIL email
  class SUBSCRIBER,FOUNDER user
  class DB db
  class DASHBOARD,SETTINGS,DELETE ui
```

## Key flows

**1. Voluntary cancellation → win-back**
Subscriber cancels on the merchant's Stripe → connected webhook → `processChurn` classifies and sends an LLM-written exit email → subscriber clicks the reactivate link → connected webhook fires `customer.subscription.created` → `processRecovery` records a `win_back` recovery → `ensureActivation` charges 1× MRR (bundled onto the $99/mo subscription's first invoice if this is the first delivery, or onto the next cycle's invoice if already active).

**2. Failed payment → card save**
Stripe Smart Retries on the merchant's Connected account fails → connected webhook fires `invoice.payment_failed` → `processPaymentFailed` sends a dunning email with an update-payment link → subscriber updates card → `invoice.payment_succeeded` → `processPaymentSucceeded` records a `card_save` recovery → `ensureActivation` ensures the platform subscription exists but charges no per-recovery fee.

**3. Re-cancel within 14 days → automatic refund**
A previously-recovered subscriber cancels again → connected webhook fires `customer.subscription.deleted` → `maybeRefundRecentWinBack` finds the recovery within the window → `refundPerformanceFee` either deletes the pending invoice item (pre-finalize) or issues a credit note (post-paid).

**4. Founder-side billing**
First save or win-back triggers activation. Stripe Subscription drives all subsequent monthly billing, dunning, and retries. The founder can `Cancel` or `Resume` from `/settings`. If a platform charge fails, `processPlatformInvoiceEvent` logs the event and `sendPlatformPaymentFailedEmail` notifies the founder so they can update their card.
