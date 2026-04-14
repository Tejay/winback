# Records of Processing Activities (ROPA)

**GDPR Art. 30**. Filled in during Tier 1 execution.

> Stub — populated as part of Tier 1. Use the ICO template:
> https://ico.org.uk/for-organisations/documentation/

## 1. Controller / processor details
- Processor: Winback Ltd
- Controller: each SaaS customer (see `wb_customers`)
- Contact: privacy@winbackflow.co

## 2. Processing activities
| Activity | Data categories | Subjects | Purpose | Lawful basis | Recipients | Retention | Transfers |
|---|---|---|---|---|---|---|---|
| Churn email generation | email, name, cancellation reason | churned subscribers | Re-engagement | Legitimate interest (Art. 6(1)(f)) | Anthropic (zero-retention), Resend | 2y | US (SCCs) |
| Dunning email | email, name, invoice amount | payment-failed subscribers | Revenue recovery | Legitimate interest | Resend | 2y | US (SCCs) |
| Classification | cancellation text | churned subscribers | Tier/copy generation | Legitimate interest | Anthropic | Zero-retention | US (SCCs) |

## 3. Security measures
See `docs/gdpr/security.md` (filled in at Tier 3).
