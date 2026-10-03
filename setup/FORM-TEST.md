# Weekly Form Test

Every Sunday night this submits each client's website contact form with a clearly labelled test message, so the client gets a "your form works" email Monday morning. Monday morning it checks that a copy of each notification actually arrived and emails Steve a report of any form that's broken.

## How it works

| When | What | File |
|---|---|---|
| Once, then as needed | **Discovery** finds each site's contact form (never submits) and writes `forms.json` + `data/forms-discovery-report.md` | `monitor/forms/discover.mjs`, workflow `form-discover` |
| Sunday ~9pm Eastern | **Submit**: fills and sends each enabled form with a unique Test ID; asks the helper plugin whether WordPress sent the email | `monitor/forms/test.mjs submit`, workflow `form-test` |
| Monday ~8am Eastern | **Verify**: reads the formcheck inbox, matches Test IDs, emails the weekly report | `monitor/forms/test.mjs verify`, workflow `form-test` |
| Always on, each client site | **Helper plugin** (WordPress must-use plugin): blind-copies *only* the test email to formcheck@, records whether it sent, skips CAPTCHA + Mailchimp/CRM feeds for the authenticated test only, trashes the test entry | `wordpress/bofill-form-test.php` |

Results per site: ✅ Delivered · ✅ Sent by website · 🟡 Submitted (no helper plugin, so delivery can't be confirmed) · 🔴 Not received / Website could not send email / Form rejected · 🟠 No confirmation / Form not found / Test error · ⚪ Blocked by site security.

Screenshots after each submit: `shots/forms/<site>.png`. Status: `data/forms-status.json`. 26-week history: `data/forms-history.json`.

**Note:** this repository is public, so test results and form screenshots are public. They contain only the test data, never client email addresses.

## Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | What |
|---|---|
| `FORMTEST_SECRET` | Long random string. Must match `BOFILL_FT_SECRET` in the helper plugin on every site. |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `ALERT_TO` | Brevo SMTP, same ones the uptime monitor uses. Needed for the Monday report email. |
| `FORMCHECK_IMAP_USER`, `FORMCHECK_IMAP_PASS` | The formcheck mailbox login (Gmail: an app password). Needed for "Delivered" / "Not received". |
| `FORMCHECK_IMAP_HOST` | Optional. Defaults to `imap.gmail.com`. |

## Controlling which sites are tested (`forms.json`)

- `settings.mode`: `"pilot"` tests only the site IDs in `settings.pilot`; `"all"` tests every found form.
- On a site: `"skip": true` excludes it (client opted out, etc.). `"locked": true` stops discovery from changing an entry you corrected by hand (e.g. a different `form_url`).

## Running by hand

GitHub → Actions → **form-test** → Run workflow. `dry_run` is on by default: it fills the forms and screenshots them without submitting. Use `only` to test a few site IDs.

## Known limits

- Forms hosted by another service (JotForm, HubSpot, Typeform, Google Forms…) are listed but not tested.
- CAPTCHA bypass covers Gravity Forms, Contact Form 7, WPForms and the Simple Cloudflare Turnstile plugin. Other CAPTCHA setups will show as "Form rejected" until handled.
- Marketing integrations are suppressed for Gravity Forms feeds and Flamingo; Contact Form 7 add-ons that push to mailing lists may still receive the test entry.
- Without the helper plugin a site can only reach 🟡 Submitted.
