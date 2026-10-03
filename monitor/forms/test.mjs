// BofillTech VisualMonitor — Weekly Form Test: SUBMIT + VERIFY
//
//   node monitor/forms/test.mjs submit [--only a,b] [--dry-run]
//       Sunday night. Fills and submits each enabled site's contact form with a clearly-labelled
//       test message carrying a unique Test ID, then asks the Bofill helper plugin (if installed)
//       whether WordPress handed the email off successfully.
//       --dry-run fills the form and screenshots it but does NOT submit.
//
//   node monitor/forms/test.mjs verify
//       Monday morning. Reads the formcheck inbox (IMAP, optional), matches Test IDs, and emails
//       Steve the weekly report.
//
// Secrets (env): FORMTEST_SECRET (must match the helper plugin), SMTP_* + ALERT_TO (report email),
//                FORMCHECK_IMAP_USER / FORMCHECK_IMAP_PASS [/ FORMCHECK_IMAP_HOST] (delivery check)

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { ROOT, readJson, writeJson, loadForms, openPage, gotoSettled, inspectFormsInPage, closeBrowser, pool, sleep, sendEmail, TOKEN_RE } from './lib.mjs';

const args = process.argv.slice(2);
const MODE = args[0] || 'submit';
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : (process.env.ONLY || '');
const ONLY = new Set(onlyArg.split(',').map(s => s.trim()).filter(Boolean));
const DRY = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const SECRET = process.env.FORMTEST_SECRET || '';

const forms = loadForms();
const S = forms.settings;
const statusPath = path.join(ROOT, 'data', 'forms-status.json');
const historyPath = path.join(ROOT, 'data', 'forms-history.json');
const shotDir = path.join(ROOT, 'shots', 'forms');

const LABEL = {
  pass: '✅ Delivered',
  handed_off: '✅ Sent by website',
  submitted: '🟡 Submitted (delivery not confirmed)',
  not_received: '🔴 Not received',
  mail_failed: '🔴 Website could not send email',
  rejected: '🔴 Form rejected the submission',
  no_response: '🟠 No confirmation after submitting',
  no_form: '🟠 Form not found',
  blocked: '⚪ Blocked by site security',
  error: '🟠 Test error',
  dry_run: '⚪ Dry run (not submitted)',
};
const FAILING = new Set(['not_received', 'mail_failed', 'rejected', 'no_response', 'no_form', 'error']);

function ymd(d = new Date()) {
  // date in US Eastern so a Sunday-night run is stamped with Sunday's date
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p.replace(/-/g, '');
}

function enabledSites() {
  return Object.entries(forms.sites).filter(([slug, v]) => {
    if (ONLY.size) return ONLY.has(slug);
    if (v.skip) return false;
    if (!['found', 'found_no_email'].includes(v.status)) return false;
    return S.mode === 'all' || (S.pilot || []).includes(slug);
  });
}

// ---------- filling ----------
function valueFor(meta, token, message) {
  const h = meta.hint, t = meta.type;
  const future = n => { const d = new Date(Date.now() + n * 864e5); return d; };
  const iso = d => d.toISOString().slice(0, 10);
  const us = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  if (meta.tag === 'textarea') return message;
  if (t === 'email' || /e-?mail/.test(h)) return S.formcheck_email;
  if (t === 'tel' || /phone|tel\b|mobile|cell/.test(h)) return S.phone || '2035550100';
  if (t === 'date') return iso(future(/depart|check-?out|end/.test(h) ? 32 : 30));
  if (/arriv|check-?in|start date|event date|date/.test(h) && t === 'text') return us(future(/depart|check-?out/.test(h) ? 32 : 30));
  if (/depart|check-?out/.test(h)) return us(future(32));
  if (t === 'number') return meta.min && +meta.min > 1 ? meta.min : (/guest|adult|people|party/.test(h) ? '2' : '1');
  if (t === 'url' || /website|url/.test(h)) return 'https://bofilltech.com';
  if (/first/.test(h)) return S.sender_name_first || 'Bofill';
  if (/last|surname/.test(h)) return S.sender_name_last || 'Form Test';
  if (/subject|topic|regarding/.test(h)) return 'Weekly website form test – no action needed';
  if (/company|business|organi[sz]ation/.test(h)) return 'Bofill Technologies';
  if (/zip|postal/.test(h)) return '06901';
  if (/\bstate\b|province/.test(h)) return 'CT';
  if (/city|town/.test(h)) return 'Stamford';
  if (/address|street/.test(h)) return '1 Test Street';
  if (/name/.test(h)) return `${S.sender_name_first || 'Bofill'} ${S.sender_name_last || 'Form Test'}`;
  if (/comment|message|question|details|inquiry|enquiry|note/.test(h)) return message;
  return meta.required ? 'Test' : null;
}

async function fieldMeta(el) {
  return el.evaluate(e => {
    const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    const visible = s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0 && r.width > 1 && r.height > 1 && (e.offsetParent !== null || s.position === 'fixed');
    let hint = '';
    if (e.id) { const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l) hint += l.innerText + ' '; }
    const pl = e.closest('label'); if (pl) hint += pl.innerText + ' ';
    const wrap = e.closest('.gfield, .wpforms-field, .nf-field-container, .elementor-field-group, .frm_form_field, .ff-el-group, .form-group, p');
    if (wrap) { const l = wrap.querySelector('label, legend, .gfield_label'); if (l) hint += l.innerText + ' '; }
    hint += ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.placeholder || '') + ' ' + (e.name || '') + ' ' + (e.id || '');
    return {
      tag: e.tagName.toLowerCase(), type: (e.type || '').toLowerCase(), name: e.name || '', visible,
      disabled: e.disabled || e.readOnly, required: e.required || e.getAttribute('aria-required') === 'true',
      hint: hint.replace(/\s+/g, ' ').trim().toLowerCase(), min: e.min || '', value: e.value || '', checked: !!e.checked,
    };
  });
}

async function fillForm(form, token, message) {
  const els = await form.$$('input, textarea, select');
  const metas = [];
  for (const el of els) metas.push({ el, m: await fieldMeta(el) });
  let tokenPlaced = false, filled = 0;
  const radiosDone = new Set();
  for (const { el, m } of metas) {
    if (!m.visible || m.disabled) continue;
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password', 'search'].includes(m.type)) continue;
    try {
      if (m.tag === 'select') {
        const v = await el.evaluate(s => { const o = Array.from(s.options).find((o, i) => o.value && !o.disabled && (i > 0 || s.options.length === 1)); return o ? o.value : null; });
        if (v !== null) { await el.select(v); filled++; }
        continue;
      }
      if (m.type === 'checkbox') {
        if (!m.checked && (m.required || /consent|agree|terms|privacy|accept|acknowledge|human/.test(m.hint))) { await el.click(); filled++; }
        continue;
      }
      if (m.type === 'radio') {
        if (m.required && m.name && !radiosDone.has(m.name)) { await el.click(); radiosDone.add(m.name); filled++; }
        continue;
      }
      let v = valueFor(m, token, message);
      if (v === null) continue;
      if (v === message) { if (tokenPlaced) v = 'See message above.'; else tokenPlaced = true; }
      if (m.type === 'date') { await el.evaluate((e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); }
      else {
        await el.click({ clickCount: 3 }).catch(() => {});
        await el.evaluate(e => { e.value = ''; });
        await el.type(String(v), { delay: 5 });
      }
      filled++;
    } catch { /* one stubborn field shouldn't kill the run */ }
  }
  // No message box: put the Test ID into the last free-text field we can find so delivery can still be matched
  if (!tokenPlaced) {
    for (const { el, m } of metas.slice().reverse()) {
      if (m.visible && !m.disabled && m.tag === 'input' && m.type === 'text' && !/e-?mail|phone|date|zip|first|last/.test(m.hint)) {
        await el.click({ clickCount: 3 }).catch(() => {}); await el.type(` ${token}`, { delay: 3 }).catch(() => {}); tokenPlaced = true; break;
      }
    }
  }
  return { filled, tokenPlaced };
}

async function findForm(page, cfg) {
  if (cfg.form_selector) { const f = await page.$(cfg.form_selector); if (f) return f; }
  const all = await page.$$('form');
  if (Number.isInteger(cfg.form_index) && all[cfg.form_index]) {
    const info = await page.evaluate(inspectFormsInPage);
    if (info.forms[cfg.form_index]?.score > 0) return all[cfg.form_index];
  }
  // layout changed: pick the best-looking form again
  const info = await page.evaluate(inspectFormsInPage);
  const best = info.forms.filter(f => f.score > 0).sort((a, b) => b.score - a.score)[0];
  return best ? all[best.index] : null;
}

async function clickSubmit(page, form) {
  // multi-step forms (Gravity Forms pages, WPForms page breaks): click Next up to 4 times
  for (let i = 0; i < 4; i++) {
    const next = await form.$('.gform_next_button:not([style*="none"]), .wpforms-page-next, .nf-next, .frm_next_page');
    if (!next || !(await next.isVisible().catch(() => false))) break;
    await next.click().catch(() => {}); await sleep(1500);
  }
  const btn = await form.$('[type=submit]:not([disabled]), .gform_button, .wpforms-submit, .wpcf7-submit, button:not([type=button]):not([type=reset])');
  if (btn) { await btn.evaluate(b => b.scrollIntoView({ block: 'center' })); await sleep(300); await btn.click(); return true; }
  await form.evaluate(f => f.requestSubmit ? f.requestSubmit() : f.submit());
  return true;
}

async function waitOutcome(page, startUrl) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const r = await page.evaluate((startUrl) => {
      const q = s => Array.from(document.querySelectorAll(s)).find(e => e.offsetParent !== null && (e.innerText || '').trim());
      const ok = q('.gform_confirmation_message, .wpforms-confirmation-container, .wpforms-confirmation-container-full, .nf-response-msg, .elementor-message-success, .frm_message, .ff-message-success, .forminator-success, .et-pb-contact-message p, .contact-form-submission, .kb-form-success');
      if (ok) return { state: 'ok', text: ok.innerText.trim().slice(0, 160) };
      const cf7 = document.querySelector('form.wpcf7-form');
      if (cf7?.classList.contains('sent')) return { state: 'ok', text: (cf7.querySelector('.wpcf7-response-output')?.innerText || 'sent').trim().slice(0, 160) };
      if (cf7 && /invalid|failed|spam|aborted/.test(cf7.className)) return { state: 'bad', text: (cf7.className.match(/invalid|failed|spam|aborted/)[0] + ': ' + (cf7.querySelector('.wpcf7-response-output')?.innerText || '')).trim().slice(0, 160) };
      const bad = q('.gform_validation_errors, .validation_error, .wpforms-error-container, .wpforms-error, .elementor-message-danger, .frm_error_style, .ff-errors-in-stack, .forminator-error-message, .nf-error-msg');
      if (bad) return { state: 'bad', text: bad.innerText.trim().slice(0, 160) };
      const body = (document.body?.innerText || '').toLowerCase();
      if (location.href.split('#')[0] !== startUrl.split('#')[0] && /thank|success|confirm|received|sent/.test(location.href + ' ' + document.title.toLowerCase() + ' ' + body.slice(0, 2000))) return { state: 'ok', text: 'Redirected to ' + location.pathname };
      if (/thank you for (contacting|your (message|inquiry|enquiry|submission|request))|message (has been|was) sent|we('ve| have) received your|we will be in touch|will get back to you/.test(body)) return { state: 'ok', text: 'Thank-you message shown' };
      return null;
    }, startUrl).catch(() => null);
    if (r) return r;
  }
  return { state: 'none', text: 'No success or error message within 25 seconds' };
}

async function helperStatus(page, token) {
  if (!SECRET) return null;
  for (let i = 0; i < 6; i++) {
    const r = await page.evaluate(async (token) => {
      try {
        const res = await fetch('/wp-json/bofill-formtest/v1/status?token=' + encodeURIComponent(token), { credentials: 'omit', cache: 'no-store' });
        if (res.status === 404) return { installed: false };
        if (!res.ok) return { installed: true, error: 'HTTP ' + res.status };
        return { installed: true, ...(await res.json()) };
      } catch (e) { return { installed: false, error: String(e) }; }
    }, token).catch(() => null);
    if (!r || !r.installed) return r;
    if (r.state && r.state !== 'pending') return r;
    await sleep(3000); // mail may go out a few seconds after the confirmation renders
  }
  return { installed: true, state: 'pending' };
}

async function testSite(slug, cfg, runDate) {
  const token = `BOFILL-FORMTEST:${slug}:${runDate}:${crypto.randomBytes(3).toString('hex').slice(0, 4)}`;
  const message = [
    'This is the automatic weekly test of your website contact form, sent by Bofill Technologies.',
    'If you are reading this, your contact form is working. No action is needed, and please do not reply.',
    'This message will never ask you to click a link or make a payment.',
    `Test ID: ${token}`,
  ].join('\n\n');
  const base = { slug, name: cfg.name, form_url: cfg.form_url, plugin: cfg.plugin, token, tested_at: new Date().toISOString() };
  const page = await openPage(cfg.form_url, { secret: SECRET || null });
  try {
    const nav = await gotoSettled(page, cfg.form_url);
    if (nav.challenged) return { ...base, result: 'blocked', detail: 'Security challenge never cleared' };
    if (nav.error || nav.status >= 400) return { ...base, result: 'error', detail: nav.error || `Form page returned HTTP ${nav.status}` };
    const form = await findForm(page, cfg);
    if (!form) return { ...base, result: 'no_form', detail: 'Contact form no longer found on ' + cfg.form_url };
    await form.evaluate(f => f.scrollIntoView({ block: 'center' }));
    const { filled, tokenPlaced } = await fillForm(form, token, message);
    fs.mkdirSync(shotDir, { recursive: true });
    if (DRY) {
      await form.screenshot({ path: path.join(shotDir, `${slug}.png`) }).catch(() => page.screenshot({ path: path.join(shotDir, `${slug}.png`) }));
      return { ...base, result: 'dry_run', detail: `Filled ${filled} field(s)${tokenPlaced ? '' : ' — nowhere to put the Test ID'}` };
    }
    const startUrl = page.url();
    await clickSubmit(page, form);
    const outcome = await waitOutcome(page, startUrl);
    await page.screenshot({ path: path.join(shotDir, `${slug}.png`) }).catch(() => {});
    if (outcome.state === 'bad') return { ...base, result: 'rejected', detail: outcome.text };
    const helper = await helperStatus(page, token);
    const r = { ...base, helper_installed: !!helper?.installed, confirmation: outcome.text, token_placed: tokenPlaced };
    if (helper?.installed && helper.state === 'failed') return { ...r, result: 'mail_failed', detail: helper.error || 'WordPress reported the email failed to send' };
    if (helper?.installed && helper.state === 'sent') return { ...r, result: 'handed_off', detail: `Email accepted for ${helper.recipients || '?'} recipient(s)` };
    if (outcome.state === 'none') return { ...r, result: 'no_response', detail: outcome.text };
    return { ...r, result: 'submitted', detail: helper?.installed ? 'Form confirmed; email hand-off not seen by helper plugin' : 'Form confirmed; helper plugin not installed' };
  } catch (e) {
    return { ...base, result: 'error', detail: e.message.slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- verify: read the formcheck inbox ----------
async function readInbox(sinceDate) {
  const { FORMCHECK_IMAP_USER: user, FORMCHECK_IMAP_PASS: pass } = process.env;
  if (!user || !pass) { console.log('IMAP secrets not set — delivery check skipped.'); return null; }
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: process.env.FORMCHECK_IMAP_HOST || 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  const found = {}; // token -> { notification: bool, autoreply: bool }
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const me = user.toLowerCase();
    const formcheck = (S.formcheck_email || '').toLowerCase();
    for await (const msg of client.fetch({ since: sinceDate }, { envelope: true, source: true })) {
      const src = msg.source.toString('utf8');
      const toList = (msg.envelope?.to || []).map(a => (a.address || '').toLowerCase());
      const toUs = toList.length && toList.every(a => a === me || a === formcheck);
      for (const m of src.matchAll(TOKEN_RE)) {
        const t = m[0];
        found[t] ||= { notification: false, autoreply: false };
        if (toUs) found[t].autoreply = true; else found[t].notification = true;
      }
    }
  } finally { lock.release(); await client.logout().catch(() => {}); }
  return found;
}

function reportHtml(results, runDate) {
  const rows = results.map(r => `<tr><td style="padding:4px 10px">${r.name}</td><td style="padding:4px 10px">${LABEL[r.result] || r.result}</td><td style="padding:4px 10px;color:#555">${(r.detail || '').replace(/</g, '&lt;')}</td><td style="padding:4px 10px"><a href="${r.form_url}">form</a></td></tr>`).join('');
  const failing = results.filter(r => FAILING.has(r.result)).length;
  return `<div style="font-family:Arial,sans-serif;font-size:14px">
<h2 style="margin:0 0 6px">Weekly Form Test — ${runDate.slice(0, 4)}-${runDate.slice(4, 6)}-${runDate.slice(6)}</h2>
<p style="margin:0 0 12px">${results.length} forms tested · <b>${failing} need attention</b></p>
<table style="border-collapse:collapse" border="1" cellspacing="0">${rows}</table>
<p style="color:#777;font-size:12px">Screenshots: https://github.com/BofillTech/bofilltech-monitor/tree/main/shots/forms · Details: data/forms-status.json</p></div>`;
}

// ---------- main ----------
if (MODE === 'submit') {
  const list = enabledSites();
  const runDate = ymd();
  if (!list.length) { console.log('No sites enabled — add site IDs to "pilot" in forms.json (or set mode to "all").'); process.exit(0); }
  console.log(`${DRY ? 'DRY RUN — ' : ''}Testing ${list.length} form(s) (mode: ${ONLY.size ? 'only' : S.mode})${SECRET ? '' : ' — FORMTEST_SECRET not set, helper plugin checks off'}`);
  const results = await pool(list, Number(process.env.CONCURRENCY || 3), async ([slug, cfg]) => {
    const r = await testSite(slug, cfg, runDate);
    console.log(`${(LABEL[r.result] || r.result).padEnd(38)} ${cfg.name} — ${r.detail || ''}`);
    return r;
  });
  await closeBrowser();
  if (!DRY) {
    const prev = readJson(statusPath, {});
    const status = { run_date: runDate, submitted_at: new Date().toISOString(), verified_at: null, sites: { ...(ONLY.size ? prev.sites : {}) } };
    for (const r of results) status.sites[r.slug] = r;
    writeJson(statusPath, status);
  }
  const bad = results.filter(r => FAILING.has(r.result));
  console.log(`\nDone: ${results.length} tested, ${bad.length} need attention.`);
} else if (MODE === 'verify') {
  const status = readJson(statusPath);
  if (!status?.sites || !Object.keys(status.sites).length) { console.log('No submit run on record — nothing to verify.'); process.exit(0); }
  const since = new Date(status.submitted_at); since.setDate(since.getDate() - 1);
  const inbox = await readInbox(since).catch(e => { console.error('IMAP check failed:', e.message); return null; });
  const results = Object.values(status.sites);
  for (const r of results) {
    if (!inbox) continue;
    const hit = inbox[r.token];
    r.inbox = hit || { notification: false, autoreply: false };
    if (['handed_off', 'submitted'].includes(r.result)) {
      if (hit?.notification) { r.result = 'pass'; r.detail = 'Copy of the client notification arrived'; }
      else if (r.helper_installed) { r.result = 'not_received'; r.detail = 'Website accepted the form but no copy of the notification arrived by Monday morning'; }
      // without the helper plugin there is no copy to look for — leave as "submitted"
    }
  }
  status.verified_at = new Date().toISOString();
  writeJson(statusPath, status);
  // history: one row per site per week, last 26 weeks
  const hist = readJson(historyPath, {});
  for (const r of results) { const h = (hist[r.slug] ||= []); if (!h.length || h[h.length - 1].d !== status.run_date) h.push({ d: status.run_date, r: r.result }); hist[r.slug] = h.slice(-26); }
  writeJson(historyPath, hist);

  results.sort((a, b) => (FAILING.has(b.result) - FAILING.has(a.result)) || a.name.localeCompare(b.name));
  const failing = results.filter(r => FAILING.has(r.result));
  const text = results.map(r => `${LABEL[r.result] || r.result} — ${r.name}\n   ${r.detail || ''}\n   ${r.form_url}`).join('\n\n');
  for (const r of results) console.log(`${(LABEL[r.result] || r.result).padEnd(38)} ${r.name}`);
  await sendEmail({
    subject: `[Form Test] ${failing.length ? `${failing.length} form(s) need attention` : 'All forms OK'} — week of ${status.run_date.slice(4, 6)}/${status.run_date.slice(6)}`,
    text: `${text}\n\nScreenshots: https://github.com/BofillTech/bofilltech-monitor/tree/main/shots/forms`,
    html: reportHtml(results, status.run_date),
  });
} else {
  console.error('Usage: node monitor/forms/test.mjs submit|verify [--only a,b] [--dry-run]');
  process.exit(1);
}
