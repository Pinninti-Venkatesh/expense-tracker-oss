# Running it as a public service

A self-hosted install needs none of this. These switches exist for running one
copy for many unrelated people, with sign-up, payments and a privacy policy.
They are all **off by default**, and each is covered by the end-to-end suite in
`e2e/app.e2e.test.js`, which runs with every one of them on.

| Setting | What it turns on |
|---|---|
| `OPEN_SIGNUP=true` | Anyone with a Google account can sign up, instead of `ALLOWED_EMAILS`. |
| `MAX_USERS` | Stops new sign-ups past this many accounts. |
| `BILLING_ENABLED=true` | A free trial, then a paywall with Razorpay subscriptions. |
| `SHARED_TEMPLATES_ENABLED=true` | Bank email formats shared across accounts once enough learn the same one. |
| `LEGAL_PAGES_ENABLED=true` | `/privacy` and `/terms`, and the consent line at sign-in. |

## Google's limits

An app requesting `gmail.readonly` for the public must pass Google's
restricted-scope verification, including an annual third-party security
assessment, if it stores or transmits Gmail data on its servers. Until then:

- at most **100 users can ever sign up**, trials included, over the project's
  lifetime; set `MAX_USERS` below that,
- everyone sees the "unverified app" warning (`GOOGLE_APP_VERIFIED=false` keeps
  the welcome step that explains it),
- use a separate Cloud project for development, so testing doesn't use up
  places.

## Payments (`BILLING_ENABLED`)

Razorpay Subscriptions, monthly or yearly (`server/billing/`,
`server/routes/billing.js`).

- **Access comes from dates, not status names.** An account may use the app
  during its trial (`TRIAL_DAYS`), or until the end of the last billing cycle
  Razorpay charged for. Cancelling keeps the paid days; a failed renewal ends
  access when they run out (`billing/entitlement.js`).
- **Subscribing early costs no free days.** A subscription started during the
  trial, or during paid days after cancelling, begins when those days end.
- **Trust.** Checkout's signature is verified against the subscription this
  server created for the account, and the outcome is then read back from
  Razorpay's API. Webhooks are verified against their raw body, applied once
  per event id, and ignored when they name another account's subscription.
- **The paywall** (`billing/gate.js`) answers 402 on every data route once
  access ends, except the subscribe screen, CSV export and account deletion.
  The scheduled poll skips those accounts; when one comes back, the first sync
  runs again to read what it missed.

With billing on, production refuses to start until Razorpay is configured,
because the paywall would otherwise lock people out with no way to pay.

**Setting up Razorpay** (Test mode first, then Live after KYC):

1. Razorpay asks for a website with a privacy policy, terms, a refund policy and
   contact details: turn on `LEGAL_PAGES_ENABLED` and fill the `[SET …]` gaps in
   `server/legal/`.
2. Enable Subscriptions, then create a monthly and a yearly plan. Prices live
   only in Razorpay; the app reads them. Put the plan ids in
   `RAZORPAY_PLAN_MONTHLY` and `RAZORPAY_PLAN_YEARLY`.
3. Generate an API key (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
4. Add a webhook to `https://YOUR_DOMAIN/api/billing/webhook` with a secret
   (`RAZORPAY_WEBHOOK_SECRET`) and these events:
   `subscription.authenticated`, `.activated`, `.charged`, `.pending`,
   `.halted`, `.cancelled`, `.completed`, `.updated`, `.paused`, `.resumed`.
5. Check in Test mode: Checkout opens from the Plan screen (the
   Content-Security-Policy allows Razorpay's hosts only while billing is on), a
   test subscription shows "Paid until …", and cancelling keeps access until
   that date.

## Shared bank email formats (`SHARED_TEMPLATES_ENABLED`)

A format learned by several accounts helps the rest (`templates/library.js`).

- Only a template's fixed wording and field positions are shared. Words from
  the contributor's own name and email are removed first.
- A format is published only after `TEMPLATE_LIBRARY_MIN_ACCOUNTS` (default 3)
  accounts learned exactly the same form independently. Until then the library
  keeps only keyed hashes, never readable text.
- Only live templates from DKIM-verified senders at known bank domains, with no
  card number fixed in them, are offered.
- An adopted format starts on a two-agreement trial graded by the receiving
  account's own model. One disagreement retires it there; two accounts
  disputing it withdraw it for everyone.

## Legal pages (`LEGAL_PAGES_ENABLED`)

Drafts live in `server/legal/`. Values such as the operator's name come from
`.env`; anything unset renders as a highlighted `[SET …]` so a draft never
passes for final. The privacy page names whichever Claude provider
`AI_PROVIDER` selects, and only that one. Have both pages reviewed before
taking real users.
