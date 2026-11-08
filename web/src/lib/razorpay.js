/**
 * Razorpay Checkout, loaded only when someone subscribes. The server's
 * Content-Security-Policy allows this script and the frames it opens.
 */
const SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let loading = null;

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Checkout did not load.')));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Couldn't reach Razorpay. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Opens Checkout for a subscription the server created ({ keyId, subscriptionId,
 * name, description, prefill }). Resolves with Razorpay's three response fields
 * when the customer authorises it, or null when they close it. Rejects if an
 * attempt failed and they then closed it, with Razorpay's reason.
 */
export async function openCheckout(order) {
  const Razorpay = await loadCheckout();
  return new Promise((resolve, reject) => {
    let failure = null;
    const checkout = new Razorpay({
      key: order.keyId,
      subscription_id: order.subscriptionId,
      name: order.name,
      description: order.description,
      prefill: order.prefill,
      theme: { color: '#0369a1' },
      handler: (response) => resolve(response),
      modal: {
        ondismiss: () => (failure ? reject(new Error(failure)) : resolve(null)),
      },
    });
    // Checkout stays open after a failed attempt so the customer can retry.
    checkout.on('payment.failed', (response) => {
      failure = response?.error?.description || 'The payment did not go through.';
    });
    checkout.open();
  });
}
