# Self-hosting

Run your own copy for yourself and your household, in two steps: **start it**
somewhere, then **set it up** in the browser. You need a Gmail account for
everyone and a Claude API key for the owner. Your data never touches anyone
else's server.

## 1. Start it

The app is one container that keeps everything in one folder, `/data`:
accounts, ledgers, settings made in the app, and secrets it makes for itself.
Anywhere that runs a container with a disk will do. There is nothing to
configure before it starts.

### On your computer

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/),
download this repository, open a terminal in its folder, and run:

```bash
./setup.sh
```

It starts the app at <http://localhost:8080> and prints a one-time **setup
code**. On Windows, run `docker compose up -d --build` instead; `docker compose
logs app` shows the code. To update later: `git pull && ./setup.sh`.

A laptop that sleeps is fine: when it wakes, or whenever someone opens the app,
it reads everything it missed.

### On a home server, NAS or VPS

The same container with a volume at `/data` and port 8080:

```bash
docker run -d --name expenses --restart unless-stopped \
  -p 8080:8080 -v expenses-data:/data ghcr.io/pinninti-venkatesh/expense-tracker-oss
```

That image is published from this repository; `docker build -t expenses .`
makes your own. `docker logs expenses` shows the setup code. To reach it from your
phone, put it behind HTTPS: a reverse proxy such as Caddy with a domain, or a
private network such as Tailscale or a Cloudflare Tunnel.

### On Google Cloud Run (free tier, `https://` address included)

Open [Google Cloud Shell](https://shell.cloud.google.com) (it already has the
`gcloud` tool, signed in), then:

```bash
git clone https://github.com/Pinninti-Venkatesh/expense-tracker-oss.git expenses && cd expenses
./scripts/deploy-cloud-run.sh
```

It asks for a project name and a region (Enter accepts the defaults), and then:

- creates the project and turns on what it needs;
- creates a **private storage bucket** and mounts it as the app's `/data`
  folder, so nothing is lost when Cloud Run restarts the app;
- deploys the app with **one instance at most** (each ledger's writes are kept
  in order in memory), scaling to zero between visits;
- schedules an **email check every 10 minutes**;
- prints the `https://…run.app` address and the setup code.

Google requires a **billing account** (a card) on the project for Cloud Run,
even though a household stays within the free tier. If you don't have one, the
script opens the page to add it and waits. Run the script again any time to
update the app; everyone's data stays in the bucket.

**Your own domain.** Cloud Run maps custom domains in some regions only
(`asia-southeast1` but not `asia-south1`). Verify the domain once (`gcloud
domains verify example.com`), then:

```bash
gcloud beta run domain-mappings create --service expenses \
  --domain expenses.example.com --region REGION
```

and add the `CNAME` it prints (for a subdomain, `ghs.googlehosted.com.`) at your
DNS provider.

### Anywhere else

Any host that runs a container works if it gives you:

- a **persistent volume at `/data`** (without one, everything is lost on restart);
- **one instance** only;
- port 8080 (or the `PORT` it sets), ideally behind HTTPS.

Hosts that sleep between visits are fine. The setup code is in the app's logs:
"enter this setup code".

## 2. Set it up in the browser

Open the address. The first-run screen asks for three things.

1. **The setup code.** It proves you're the one who started the app, so a new
   install on a public address can't be claimed by whoever finds it first.
2. **Your Claude API key.** Make one at
   [console.anthropic.com](https://console.anthropic.com) → **Settings → API
   keys**, and add a little credit. It's checked with Anthropic as you paste it.
   Reading two months of alerts the first time costs roughly ₹50–100; after
   that, the app has learned your banks' formats and it costs a few rupees a
   month. The owner can change it later in **You → Household**.
3. **Your Gmail.** Your address and a Gmail **app password**, which the screen
   shows you how to make: Google account → App passwords → name it "Expenses" →
   copy the 16 letters. No Google Cloud project is involved.

You're now the owner, and the first sync reads your alerts from the 1st of last
month.

**Your household.** In **You → Household**, make an invite link and send it (it
works once, for 7 days). Each person opens it on their phone and connects their
own Gmail the same way. Everyone sees only their own spends. The owner can
remove someone there too; their access stops at once.

**Statement passwords.** UPI payments often never get an alert email, but
they're in your bank's monthly statement PDF, which is password-protected. In
**You → Add UPI spends**, tick **Remember** when you type a bank's password and
new statements are then read by themselves. It's kept encrypted, for you alone;
**You → Remembered statement passwords → Forget** removes it.

### About Gmail app passwords

- Google offers app passwords only with **2-Step Verification** on. Some work
  and school accounts turn them off; those can use the Google sign-in path below.
- An app password opens the whole mailbox over IMAP, not only reading it. The
  app only ever searches for bank alerts and statements, keeps the password
  encrypted, and never sends, changes or deletes mail.
- Removing it at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
  ends the app's access. The app pauses that person's account and asks them to
  reconnect, then catches up.

## Backups and moving

Everyone's spends live in the data folder. **You → Household → Back up
everything** downloads all of it as one file locked with a passphrase you
choose. Keep one somewhere else, and keep the passphrase too: without it, nobody
can open the file.

To move to another computer or to the cloud, start a fresh install there, and on
its first screen choose **Restore a backup** (with that install's setup code,
the file and its passphrase). Accounts, spends, settings and everyone's saved
Gmail access come back, and email checking carries on straight away. Each person
signs in once on the new address.

## How it keeps up

- With Docker it checks everyone's email every 10 minutes; on Cloud Run, Cloud
  Scheduler does.
- Opening the app checks too, if nobody has for a few minutes.
- After any time away (a sleeping laptop, an outage) it reads everything since
  its last good check, in batches, so nothing is missed.

Each scheduled check logs one `cron complete` line with `accounts`, `ok`,
`failed` and `needsReauth`, so a logs-based alert on it tells you if checking
ever stops.

## The Google sign-in path (advanced)

Instead of app passwords: read-only Gmail access (`gmail.readonly`), and each
person's ledger in a file in their own Google Drive that the app can reach and
nothing else (`drive.file`). It needs a private Google "sign-in app" of your own,
so it takes about 10 minutes more, and it's set up in the terminal rather than
the browser:

```bash
npm run setup:google      # needs Node 20+
```

It asks who will use it, where you'll open it, and your Claude key, and walks
you through the sign-in app.

If the [`gcloud`](https://cloud.google.com/sdk/docs/install) tool is installed,
the setup signs you in to Google Cloud in your browser, creates a project and
turns on the Gmail and Drive APIs for you. Google doesn't let a script do the
rest, so it then opens four console pages one at a time and says exactly what to
do on each:

1. **Get started:** app name, your email, audience **External**.
2. **Data access:** add `gmail.readonly` and `drive.file` (it prints both).
3. **Audience → Test users:** add everyone who will use it (it prints them).
4. **Create client → Web application:** paste the redirect address it prints.

Then paste the **Client ID** and **Client secret** back into the setup. Google
shows the secret only once. Without `gcloud`, the setup first opens a page that
creates the project and turns on both APIs in one go.

Because only your household signs in, Google doesn't need to review the app.
Everyone sees a "Google hasn't verified this app" warning at sign-in, and the
welcome screens walk them through it.

> **Keep background syncing alive.** While the app's publishing status is
> *Testing*, Google expires its sign-in after 7 days and the app stops reading
> email until you sign in again. To avoid that, fill in the **Branding** page
> (home page, privacy policy and terms links on a domain you own), then
> **Audience → Publish app**. It stays unverified, which is fine for personal
> use, but sign-ins no longer expire.

**On Cloud Run** without a bucket, accounts live in Firestore and secrets in
Secret Manager:

```bash
PROJECT=your-project-id
REGION=asia-southeast1   # offers custom domains; asia-south1 does not
gcloud config set project $PROJECT

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com

gcloud firestore databases create --location=$REGION
```

**Secrets** (paste each value, then Ctrl-D):

```bash
for s in google-client-secret session-secret token-encryption-key cron-secret anthropic-api-key; do
  gcloud secrets create $s --replication-policy=automatic
  echo "Paste value for $s, then Ctrl-D:"
  gcloud secrets versions add $s --data-file=-
done

PROJECT_NUM=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SA="${PROJECT_NUM}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA" --role="roles/datastore.user"
for s in google-client-secret session-secret token-encryption-key cron-secret anthropic-api-key; do
  gcloud secrets add-iam-policy-binding $s --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
done
```

**Deploy:**

```bash
gcloud run deploy expenses --source . --region $REGION \
  --allow-unauthenticated --max-instances=1 --timeout=900 \
  --set-env-vars "USER_STORE=firestore,ALLOWED_EMAILS=you@gmail.com,GOOGLE_CLIENT_ID=YOUR_CLIENT_ID,GOOGLE_REDIRECT_URI=https://YOUR_DOMAIN/api/login/callback" \
  --set-secrets "GOOGLE_CLIENT_SECRET=google-client-secret:latest,SESSION_SECRET=session-secret:latest,TOKEN_ENCRYPTION_KEY=token-encryption-key:latest,CRON_SECRET=cron-secret:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest"
```

- `--allow-unauthenticated` lets your browser reach the sign-in page; every
  data route still needs a signed-in, allowlisted account.
- `--max-instances=1` is required: each ledger's writes are serialised in the
  server's memory, so two instances could overwrite each other.

**Check email every 10 minutes:**

```bash
gcloud scheduler jobs create http expenses-poll \
  --schedule "*/10 * * * *" --time-zone "Asia/Kolkata" \
  --uri "https://YOUR_DOMAIN/api/cron/poll" --http-method POST \
  --headers "X-Cron-Key=$(gcloud secrets versions access latest --secret=cron-secret)" \
  --location $REGION --attempt-deadline=900s
```

**Your own domain.** Verify the domain once (`gcloud domains verify
example.com`), then map a subdomain:

```bash
gcloud beta run domain-mappings create --service expenses \
  --domain expenses.example.com --region $REGION
```

Add the `CNAME` it prints (for a subdomain, `ghs.googlehosted.com.`) at your
DNS provider, using just the subdomain part as the name. The certificate usually
appears within 15 minutes. Then add
`https://expenses.example.com/api/login/callback` to the OAuth client and
`GOOGLE_REDIRECT_URI`.

## Claude on Amazon Bedrock

AWS runs inference with no operator access and doesn't store prompts or share
them with Anthropic.

1. In the Bedrock console, submit the one-time Anthropic use-case form.
2. Create an IAM user (or role) whose only permission is
   `bedrock-mantle:CreateInference` on the Claude Haiku 4.5 model. Check the
   exact action and resource names in the current AWS documentation.
3. Set `AI_PROVIDER=bedrock`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
   Nothing else changes, and the welcome screens name Bedrock.

`ap-south-1` serves Claude through Bedrock's global endpoint, so a request may
be processed in another AWS region.

## Troubleshooting

| You see | Fix |
|---|---|
| "That setup code isn't right" | It's in the terminal where you started the app, or in its logs: "enter this setup code". It's 8 digits. |
| "Anthropic says this key is not valid" | Copy the key again from the Claude console; check the account has credit. |
| "Gmail didn't accept that address and app password" | Check the address, or make a new app password and paste it exactly. |
| Google says app passwords "aren't available for your account" | Turn on 2-Step Verification first. Work and school accounts may have them turned off by their admin; use Google sign-in. |
| "This app only lets in people its owner has invited" | Ask the owner for an invite link (You → Household). |
| Gmail's "All Mail" is not visible over IMAP | Gmail settings → Labels → tick **Show in IMAP** for All Mail. |
| Server exits: "…keeps ledgers in the data folder, which Cloud Run wipes" | Mount a bucket at `/data` and set `PERSISTENT_DATA_DIR=true`; `scripts/deploy-cloud-run.sh` does both. |
| `Error 400: redirect_uri_mismatch` (Google sign-in) | `GOOGLE_REDIRECT_URI` isn't an authorized redirect URI on the OAuth client, character for character. |
| Email stopped updating after a week (Google sign-in) | The sign-in app is still in *Testing*; publish it (see the note above). |
| "Gmail access needs to be reconnected" | Someone removed their app password (or revoked Google access); they sign in again and missed alerts are caught up. |

## Configuring by hand

Nothing needs to be configured. Every setting can still be set in the
environment (or a `.env` file next to `docker-compose.yml`), and wins over what
was set in the app; `.env.example` lists them all with a comment, including the
optional features for running the app as a public service
([hosted-mode.md](hosted-mode.md)).
