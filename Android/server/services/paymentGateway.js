// Payment provider abstraction. Every gateway (mock today; Razorpay, Stripe,
// Apple Pay, Google Play Billing later) implements the same two-method
// interface, so subscriptionService.js's checkout flow never needs to change
// when a real provider is plugged in -- only a new class gets added to
// `gateways` below and selected via the `provider` column on payment_sessions.
//
//   createSession({ plan, amountInr, user }) -> { providerReference, clientData }
//     Creates the provider-side order/payment-intent. `clientData` is
//     whatever the frontend needs to actually pay (e.g. a Razorpay order id
//     + key, or a Stripe client secret) -- the mock gateway just returns
//     instructions text since there's nothing to redirect to yet.
//
//   confirmSession(session) -> { success, providerReference }
//     Verifies the payment actually went through. For a real gateway this
//     is where you'd verify a webhook signature or call the provider's
//     "retrieve payment" API -- never trust a client-supplied "it worked".
//     The mock gateway auto-approves since there's no real money moving.

class MockGateway {
  name = 'mock';

  async createSession({ plan, amountInr, user }) {
    return {
      providerReference: `mock_${Date.now()}_${user.id}`,
      clientData: {
        instructions: amountInr > 0
          ? `Mock gateway -- tap Pay to simulate a successful ₹${amountInr} payment.`
          : 'Mock gateway -- tap Pay to simulate activation.',
      },
    };
  }

  async confirmSession(session) {
    // Real gateways: verify the payment with the provider here before
    // returning success. Nothing to verify against for the mock gateway.
    return { success: true, providerReference: session.provider_reference };
  }
}

// The live Premium path: no remote gateway to call at all -- createSession
// just records a reference for our own bookkeeping and hands back
// instructions text. There is no automated confirmSession for this
// provider by design: a manual UPI payment can only ever be marked
// 'succeeded' by an admin approval (not yet implemented), never by the
// client calling /confirm. confirmCheckoutSession() in subscriptionService.js
// already refuses to run this gateway's confirmSession() at all (it
// whitelists 'mock' only), so this method is unreachable in practice --
// it exists purely as a second, defense-in-depth guard against ever
// wiring the generic confirm path back up to this provider by accident.
class ManualUpiGateway {
  name = 'upi_manual';

  async createSession({ amountInr, user }) {
    return {
      providerReference: `upi_manual_${Date.now()}_${user.id}`,
      clientData: {
        instructions: `Pay ₹${amountInr} via UPI, then submit your transaction ID and a payment screenshot for verification.`,
      },
    };
  }

  async confirmSession() {
    return { success: false, reason: 'MANUAL_REVIEW_REQUIRED' };
  }
}

const gateways = {
  mock: new MockGateway(),
  upi_manual: new ManualUpiGateway(),
  // razorpay: new RazorpayGateway(),
  // stripe: new StripeGateway(),
};

export function getGateway(providerName = 'mock') {
  return gateways[providerName] || gateways.mock;
}
