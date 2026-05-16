-- Spec 78 followup — single-selected-promotion model.
--
-- Replaces the "matcher picks the best of many" selection with a merchant-
-- chosen single active promo. The merchant selects one row from the synced
-- promotion list on /reasons; the re-engagement path uses that promo (gated
-- by active/redeemBy/maxRedemptions/appliesToPriceIds) or no promo at all.
--
-- ON DELETE SET NULL: if the chosen wb_improvements row is hard-deleted
-- (rare — Stripe-archived promos stay as status='archived'), the customer
-- silently falls back to no-promo. The webhook handler also nulls this
-- column when it archives a promo row so the UI stays in sync.

ALTER TABLE wb_customers
  ADD COLUMN selected_promotion_improvement_id uuid
    REFERENCES wb_improvements(id) ON DELETE SET NULL;

COMMENT ON COLUMN wb_customers.selected_promotion_improvement_id IS
  'Spec 78 followup — the single promotion the merchant has chosen to send. NULL = no promo on outbound emails even when promotions_enabled is true.';
