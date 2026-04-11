#!/bin/bash
# start-stripe.sh — starts Stripe webhook listener and updates .env.local with the signing secret
cd "$(dirname "$0")"

# Get the secret first (--print-secret exits immediately)
SECRET=$(stripe listen --print-secret 2>/dev/null)

# Update .env.local
sed -i '' "s|STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=\"$SECRET\"|" .env.local
echo "Updated STRIPE_WEBHOOK_SECRET in .env.local"
echo "Secret: $SECRET"

# Now actually start listening
exec stripe listen \
  --forward-to localhost:3000/api/stripe/webhook \
  --forward-connect-to localhost:3000/api/stripe/webhook
