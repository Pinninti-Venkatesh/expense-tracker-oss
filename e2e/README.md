# End-to-end tests

The real server runs in-process with fakes only where the app meets the outside
world. Every route, store, template, library and billing rule is the real code.

| Outside service | Faked by | How |
|---|---|---|
| Google sign-in, Gmail, Drive | `fakes.js` → `fakeGoogle` | replaces the `googleapis` module |
| Claude (either provider) | `fakes.js` → `FakeClaude` | replaces `@anthropic-ai/sdk` and `@anthropic-ai/bedrock-sdk`; reads the fake alerts deterministically. `E2E_AI_PROVIDER=bedrock` runs the other path |
| Razorpay | `fakes.js` → `installFetch` | answers `https://api.razorpay.com/v1/*` like the API reference |
| FX rates | `fakes.js` → `installFetch` | fixed rate |

Any other network call throws, so a test can't quietly reach the internet.

## Run

```bash
npm run test:e2e   # builds the web app, then runs the three suites below
npm run demo       # the public demo: http://localhost:8080
npm run mock       # every optional feature on, with admin helpers: http://localhost:8080
```

All need Node 22.3 or later (`--experimental-test-module-mocks`).

| Suite | Configuration |
|---|---|
| `selfhost.e2e.test.js` | The default self-hosted install: no optional features, a household allowlist (5 scenarios) |
| `app.e2e.test.js` | A public paid service: `BILLING_ENABLED`, `SHARED_TEMPLATES_ENABLED` and `LEGAL_PAGES_ENABLED` on (21 scenarios, listed below) |
| `demo.e2e.test.js` | `demo.js` started as its own process: the website, and visitors in separate sandboxes (4 scenarios) |

## The demo (`demo.js`)

`npm run demo`. One port: it serves the project website (`site/`), a stand-in for
Google's account chooser at `/__demo/auth` and proxies everything else to the
app. Each visitor who "signs in" gets a private copy of a persona, with its own
Google id, inbox and Drive and six weeks of alerts, so visitors never see or
lock each other's data. Sandboxes are deleted after `SANDBOX_TTL_MINUTES`
(default 60), and at most `MAX_SANDBOXES` (default 200) exist at once. It needs
no API keys.

`scripts/screenshots.mjs` takes the README screenshots from it, so they only
ever show fake data.

## People in the fake world

| Persona | Bank | Card | Role in the scenarios |
|---|---|---|---|
| Asha Rao | HDFC | 4417 | First to sign up; learns the HDFC format |
| Vikram Mehta | HDFC | 8812 | Second to learn it; subscribes in the trial; deletes the account |
| Meera Iyer | HDFC | 1034 | Third to learn it (publishes it); trial runs out; pays, cancels, renewal fails |
| Dev Shah | HDFC | 7730 | Adopts the shared format; model outage; Google access revoked |
| Nisha Pillai | ICICI | 2210 | A format nobody else has |
| Ravi Kumar | — | — | Unticks Gmail and Drive on the consent screen |

Each inbox holds 14 spends from the 2nd of last month to an hour ago, plus an
alert at 00:10 India time on the 1st of last month (in), one at 23:10 the night
before (out), an OTP, a bank offer, and a double-sent alert.

## Scenarios (`app.e2e.test.js`)

1. A signed-out visitor gets the app shell, manifest, icons and legal pages, but no data; the screens and the privacy policy name the model provider in use, and only that one.
2. Signing up stores the Google token encrypted; a partial grant is refused with no account created.
3. A new account starts a 14-day trial and sees the trial intro once, with prices from Razorpay.
4. The first sync reads all of last month and this month so far, in batches, and nothing older; OTPs, offers and double-sends are not spends.
5. An account learns its bank's format and then reads known merchants with no model calls.
6. Three accounts learning the same format independently publish it; the library holds no names, emails, cards, merchants or amounts.
7. A fourth account adopts the shared format on a two-agreement trial and uses fewer model calls.
8. A format only one account uses is learned there but never published.
9. Checking email now (pull to refresh) picks up a new alert exactly once.
10. The scheduled poll needs its key, reads trial accounts, and skips unpaid ones.
11. Past the trial, every data route answers 402 except the subscribe screen, account details and CSV export.
12. Subscribing after the trial charges now; a forged confirmation opens nothing; paying reopens the app and catches up on missed alerts.
13. Webhooks are signature-checked, applied once per event id, and can't pay for another account.
14. Subscribing during the trial starts billing at the trial's end; cancelling the mandate keeps the trial.
15. Cancelling a paid plan keeps the paid days; subscribing again starts when they end.
16. A renewal that fails after the paid days end locks the app again.
17. A PIN locks every data route, billing included, until the right PIN is entered.
18. Each account sees only its own spends.
19. When the model is unavailable, alerts wait and are read on the next try.
20. When Google access is revoked, polling stops for that account and reconnecting queues a catch-up.
21. Deleting an account cancels a renewing plan, revokes Google, and removes the record and the ledger.

## Clicking through (`npm run mock`)

Open http://localhost:8080 and choose a persona on the fake Google screen.
Helpers on the fake Google port:

- `GET http://localhost:8081/admin/mail/asha?merchant=ZEPTO%20MARKETPLACE%20PVT&amount=450`: a new alert
- `GET http://localhost:8081/admin/expire/meera`: end Meera's trial
- `GET http://localhost:8081/admin/charge/meera`: Razorpay charges her subscription and sends the webhook
- `GET http://localhost:8081/admin/state`: accounts, billing and model calls

Razorpay Checkout can't open with fake keys. Before tapping Subscribe, paste
this in the browser console. It stands in for Checkout and signs its answer
with the mock server's test key secret:

```js
window.Razorpay = class {
  constructor(o) { this.o = o; }
  on() {}
  async open() {
    const id = `pay_ui_${Date.now()}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode('e2e_key_secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${id}|${this.o.subscription_id}`));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.o.handler({ razorpay_payment_id: id, razorpay_subscription_id: this.o.subscription_id, razorpay_signature: hex });
  }
};
```

The mock server's fake Razorpay treats a subscription as paid the first time
the app reads it back, as it would be after a real Checkout.
