# Colab eligibility probe — user guide

This sets up the **read-only** eligibility check approved 2026-11-17 (ADR-002 open item 1). It answers two questions for your Google account:

1. What is my Colab subscription tier (`free` / `Pro` / `Pro+`)?
2. Which runtime specs (GPU/TPU/accelerator, shape) am I eligible for right now?

**It never creates, starts, stops or deletes a runtime.** The only OAuth scope it uses is `colaboratory.readonly`. No quota-consuming calls are made. The probe writes results to `docs/colab-eligibility-result.json`, which is gitignored.

**Important (repeated from ADR-002):** whatever this probe returns, the owner decision stands — **manual-only indefinitely; no unattended automation on any provider.** Eligibility ≠ permission for an external-inference service. Eligibility results are recorded for the M0 record only.

## Steps (all in your own account, by hand)

1. Go to <https://console.cloud.google.com/> and create (or pick) a Cloud project.
2. Enable the Colab API: <https://console.cloud.google.com/apis/library/colaboratory.googleapis.com> → **Enable**.
   - Check your project's quotas page afterwards if you want visibility: <https://console.cloud.google.com/apis/api/colaboratory.googleapis.com/quotas>
3. OAuth consent screen: APIs & Services → OAuth consent screen → External → fill required fields (app name, support email). Add your own Google account as a **Test user** if the app remains in "Testing" mode.
4. Credentials → Create Credentials → OAuth client ID → **Desktop app** → create → **Download JSON**.
5. Save the file as `tools/client_secret.json` in this repository (it is gitignored — do not commit, paste, or share it).
6. Install dependencies (a venv keeps things tidy):
   ```bash
   python -m venv .venv
   .venv\Scripts\activate            # Windows
   pip install google-auth-oauthlib requests
   ```
7. Run:
   ```bash
   .venv\Scripts\python tools\colab-eligibility-check.py
   ```
   A browser opens; authorize the `colaboratory.readonly` scope with the account whose Colab eligibility you want to measure.
8. The probe prints:
   - your subscription tier,
   - each runtime spec with an `eligible` flag (e.g. T4/L4/A100, STANDARD/HIGHMEM).
9. If you want the outcome in the M0 record, tell the developer — `docs/colab-eligibility-result.json` stays on your machine unless you choose to share it (it can contain your account identifiers).
10. To revoke access afterwards: <https://myaccount.google.com/permissions> → remove the app.

## What the developer needs from you

Just the tier and the ELIGIBLE/not-eligible rows (you can paste them), or nothing at all — the decision is already made (manual-only). The probe is an evidence artifact, not an unblock.
