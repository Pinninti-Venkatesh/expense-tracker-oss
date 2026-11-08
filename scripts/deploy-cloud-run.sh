#!/usr/bin/env bash
# Puts your own copy of Expense Tracker on Google Cloud Run, with an https://
# address that works on your phone. Made for Google Cloud Shell, which already
# has gcloud and is signed in: open this repository there and run
#
#   ./scripts/deploy-cloud-run.sh
#
# It works on any computer with gcloud too. Run it again to update the app.
#
# What it makes, in a project of its own:
#   - a private storage bucket, mounted as the app's data folder (/data), so
#     accounts, ledgers and settings survive Cloud Run's restarts;
#   - the Cloud Run service, one instance at most (the app's writes are
#     serialised in memory), scaling to zero between visits;
#   - a Cloud Scheduler job that checks everyone's email every 10 minutes.
# A household stays within Google Cloud's free tier, but Google requires a
# billing account (a card) on the project for Cloud Run.
#
# Answers can be given ahead, for scripted use:
#   EXPENSES_PROJECT=my-project EXPENSES_REGION=asia-south1 EXPENSES_YES=1 ./scripts/deploy-cloud-run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE=expenses
JOB=expenses-email-check

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

ask() { # ask "Question" default -> answer
  local answer
  if [ -n "${EXPENSES_YES:-}" ]; then echo "$2"; return; fi
  read -r -p "  $1 [$2]: " answer </dev/tty
  echo "${answer:-$2}"
}

yes_no() { # yes_no "Question" -> 0 for yes (the default)
  local answer
  if [ -n "${EXPENSES_YES:-}" ]; then return 0; fi
  read -r -p "  $1 [Y/n] " answer </dev/tty
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

command -v gcloud >/dev/null 2>&1 || fail "This needs the gcloud tool. The easiest place to run it is Google Cloud Shell (shell.cloud.google.com), which has it already."

bold "Expense Tracker on Google Cloud Run"

# --- who ---------------------------------------------------------------------
ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1)
if [ -z "$ACCOUNT" ]; then
  say "Sign in to Google Cloud in the browser window that opens."
  gcloud auth login --brief
  ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)
fi
say "Signed in as $ACCOUNT."

# --- which project -----------------------------------------------------------
PROJECT=${EXPENSES_PROJECT:-}
if [ -z "$PROJECT" ]; then
  EXISTING=$(gcloud projects list --filter="labels.app=expense-tracker" --format='value(projectId)' 2>/dev/null | head -n 1 || true)
  if [ -n "$EXISTING" ]; then
    PROJECT=$(ask "Update the copy in project" "$EXISTING")
  else
    PROJECT=$(ask "Project to create for it" "expenses-$(openssl rand -hex 3)")
  fi
fi
if ! gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  say "Creating project ${PROJECT}…"
  gcloud projects create "$PROJECT" --name="Expenses" --labels=app=expense-tracker >/dev/null \
    || fail "Google didn't create the project. If it says the terms haven't been accepted, open console.cloud.google.com once, accept them, and run this again."
fi
gcloud config set project "$PROJECT" >/dev/null 2>&1

# --- billing -----------------------------------------------------------------
if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  ACCOUNTS=$(gcloud billing accounts list --filter=open=true --format='value(name)' 2>/dev/null || true)
  if [ -z "$ACCOUNTS" ]; then
    say "Cloud Run needs a billing account on the project, even within the free tier."
    say "Add one at https://console.cloud.google.com/billing/create, then come back."
    [ -n "${EXPENSES_YES:-}" ] && fail "No billing account to use."
    read -r -p "  Press Enter once it's added. " _ </dev/tty
    ACCOUNTS=$(gcloud billing accounts list --filter=open=true --format='value(name)')
    [ -n "$ACCOUNTS" ] || fail "Still no billing account. Add one, then run this again."
  fi
  BILLING=$(echo "$ACCOUNTS" | head -n 1)
  if [ "$(echo "$ACCOUNTS" | wc -l | tr -d ' ')" -gt 1 ]; then
    say "Billing accounts:"
    gcloud billing accounts list --filter=open=true --format='table(name,displayName)'
    BILLING=$(ask "Use billing account" "$BILLING")
  fi
  say "Linking billing account ${BILLING}…"
  gcloud billing projects link "$PROJECT" --billing-account="${BILLING#billingAccounts/}" >/dev/null
fi

# --- where -------------------------------------------------------------------
REGION=${EXPENSES_REGION:-$(gcloud run services list --project "$PROJECT" --filter="metadata.name=$SERVICE" --format='value(region)' 2>/dev/null | head -n 1 || true)}
REGION=${REGION:-$(ask "Region (asia-south1 is Mumbai)" asia-south1)}
BUCKET="$PROJECT-expenses-data"

say "Turning on Cloud Run, Cloud Build, Cloud Storage and Cloud Scheduler (a minute or two the first time)…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com cloudscheduler.googleapis.com --project "$PROJECT" >/dev/null

# --- the data folder ---------------------------------------------------------
if ! gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  say "Creating the private bucket that holds everyone's data…"
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention >/dev/null
fi
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
RUNNER="$NUMBER-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$RUNNER" --role=roles/storage.objectUser >/dev/null

# --- the service -------------------------------------------------------------
FIRST_DEPLOY=1
gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 && FIRST_DEPLOY=0

ENV_FLAGS=(--update-env-vars "PERSISTENT_DATA_DIR=true,POLL_INTERVAL_MINUTES=0")
# A new revision keeps the previous one's volumes, so they're only added once.
VOLUME_FLAGS=()
if [ "$FIRST_DEPLOY" = 1 ]; then
  # The bucket as /data, owned by the image's "node" user (uid 1000) so the
  # app can write to it.
  VOLUME_FLAGS=(--add-volume "name=data,type=cloud-storage,bucket=$BUCKET,mount-options=uid=1000;gid=1000"
    --add-volume-mount "volume=data,mount-path=/data")
  # Made here so this script can print them: the setup code for the first-run
  # screen, and the key the scheduled check presents.
  DIGITS=$(printf '%08d' $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 100000000 )))
  SETUP_CODE="${DIGITS:0:4}-${DIGITS:4:4}"
  CRON_SECRET=$(openssl rand -hex 32)
  ENV_FLAGS=(--set-env-vars "PERSISTENT_DATA_DIR=true,POLL_INTERVAL_MINUTES=0,SETUP_CODE=$SETUP_CODE,CRON_SECRET=$CRON_SECRET")
else
  CRON_SECRET=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
    --format=json | python3 -c "import json,sys; e=json.load(sys.stdin)['spec']['template']['spec']['containers'][0].get('env',[]); print(next((v['value'] for v in e if v['name']=='CRON_SECRET'),''))")
fi

say "Building and deploying the app (about five minutes the first time)…"
gcloud run deploy "$SERVICE" --source . --project "$PROJECT" --region "$REGION" --quiet \
  --allow-unauthenticated --max-instances 1 --min-instances 0 --memory 512Mi --cpu 1 --timeout 900 \
  --execution-environment gen2 \
  ${VOLUME_FLAGS[@]+"${VOLUME_FLAGS[@]}"} "${ENV_FLAGS[@]}" >/dev/null

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')

# --- the email check every 10 minutes ----------------------------------------
if [ -n "$CRON_SECRET" ]; then
  SCHEDULE=(--schedule "*/10 * * * *" --time-zone "Asia/Kolkata" --uri "$URL/api/cron/poll" --http-method POST
    --headers "X-Cron-Key=$CRON_SECRET" --attempt-deadline 900s --location "$REGION" --project "$PROJECT")
  if gcloud scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$JOB" "${SCHEDULE[@]}" >/dev/null
  else
    gcloud scheduler jobs create http "$JOB" "${SCHEDULE[@]}" >/dev/null
  fi
fi

echo ""
bold "Running at $URL"
if [ "$FIRST_DEPLOY" = 1 ]; then
  say "Open it and enter this setup code: $SETUP_CODE"
  say "Moving from another computer? Choose \"Restore a backup\" there instead."
else
  say "Updated. Everyone's data is where it was."
fi
