// BofillTech VisualMonitor — Weekly Form Test: shared helpers
// Used by discover.mjs (find each site's contact form) and test.mjs (submit + verify weekly).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const TOKEN_RE = /BOFILL-FORMTEST:([a-z0-9-]+):(\d{8}):([a-z0-9]{4})/g;

export function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
export function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function loadForms() {
  return readJson(path.join(ROOT, 'forms.json'), null) || {
    settings: {
      mode: 'pilot',            // 'pilot' = only slugs in "pilot"; 'all' = every found form not marked skip
      pilot: [],
      formcheck_email: 'formcheck@bofilltech.com',
      sender_name_first: 'Bofill',
      sender_name_last: 'Form Test',
      phone: '2035550100',
    },
    sites: {},
  };
}
export function saveForms(f) { writeJson(path.join(ROOT, 'forms.json'), f); }

export function siteHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---------- browser ----------
let browserP = null;
export function getBrowser() {
  if (!browserP) {
    browserP = (async () => {
      const puppeteer = (await import('puppeteer-extra')).default;
      const stealth = (await import('puppeteer-extra-plugin-stealth')).default;
      puppeteer.use(stealth());
      return puppeteer.launch({
        protocolTimeout: 120000,
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });
    })();
  }
  return browserP;
}
export async function closeBrowser() { if (browserP) await browserP.then(b => b.close()).catch(() => {}); browserP = null; }

/**
 * Open a page. If `secret` is given, every request to the site's own host carries
 * X-Bofill-FormTest: <secret> so the Bofill must-use plugin can recognise the test
 * (CAPTCHA bypass, integration suppression). Third-party requests never get the header.
 */
export async function openPage(url, { secret = null, timeout = 30000 } = {}) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(UA);
  page.setDefaultTimeout(timeout);
  if (secret) {
    const host = siteHost(url);
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (req.isInterceptResolutionHandled()) return;
      const h = siteHost(req.url());
      if (h && (h === host || h.endsWith('.' + host))) {
        req.continue({ headers: { ...req.headers(), 'x-bofill-formtest': secret } }).catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  }
  return page;
}

const CHALLENGE_MARKERS = ['performing security verification', 'verify you are human', 'just a moment', 'checking your browser', 'verifying you are not a bot'];
export async function looksLikeChallenge(page) {
  try {
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000).toLowerCase());
    return CHALLENGE_MARKERS.some(m => text.includes(m));
  } catch { return false; }
}

/** Navigate, wait out Cloudflare-style challenges. Returns { ok, challenged, status, error } */
export async function gotoSettled(page, url, timeout = 30000) {
  let status = 0, error = null;
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle2', timeout });
    status = res?.status() || 0;
  } catch (e) {
    if (!/timeout/i.test(e.message)) error = e.message.slice(0, 160);
  }
  let challenged = await looksLikeChallenge(page);
  for (let w = 0; w < 8 && challenged; w++) { await sleep(2000); challenged = await looksLikeChallenge(page); }
  await sleep(1500); // late JS (form plugins often render or hydrate after load)
  return { ok: !error && !challenged, challenged, status, error };
}

// ---------- form inspection (runs inside the page) ----------
// Returns a description of every <form> (plus known non-<form> widgets) on the page.
export function inspectFormsInPage() {
  const vis = el => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right < 0 || r.bottom < -2000 || r.left > innerWidth + 50) return false;
    return el.offsetParent !== null || s.position === 'fixed';
  };
  const pluginOf = f => {
    const c = (f.className + ' ' + (f.closest('[class]')?.className || '') + ' ' + (f.id || '')).toLowerCase();
    if (f.closest('.gform_wrapper') || /gform/.test(c)) return 'gravityforms';
    if (f.closest('.wpcf7') || /wpcf7/.test(c)) return 'contactform7';
    if (/wpforms/.test(c) || f.closest('.wpforms-container')) return 'wpforms';
    if (f.closest('.nf-form-cont') || /nf-form/.test(c)) return 'ninjaforms';
    if (/elementor-form/.test(c) || f.closest('.elementor-widget-form')) return 'elementor';
    if (/frm_forms|frm-show-form/.test(c) || f.closest('.frm_forms')) return 'formidable';
    if (/fluentform|ff-el-form/.test(c) || f.closest('.fluentform')) return 'fluentforms';
    if (/forminator/.test(c)) return 'forminator';
    if (/et_pb_contact/.test(c) || f.closest('.et_pb_contact_form_container')) return 'divi';
    if (/kb-form|kadence/.test(c)) return 'kadence';
    if (/jetpack|contact-form/.test(c) && f.closest('.wp-block-jetpack-contact-form, .contact-form')) return 'jetpack';
    return 'custom';
  };
  const labelOf = el => {
    let t = '';
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) t += l.innerText + ' '; }
    const pl = el.closest('label'); if (pl) t += pl.innerText + ' ';
    const wrap = el.closest('.gfield, .wpforms-field, .nf-field-container, .elementor-field-group, .frm_form_field, .ff-el-group, .form-group, p');
    if (wrap) { const l = wrap.querySelector('label, legend, .gfield_label'); if (l) t += l.innerText + ' '; }
    t += ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.placeholder || '') + ' ' + (el.name || '') + ' ' + (el.id || '');
    return t.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 140);
  };
  const forms = Array.from(document.querySelectorAll('form'));
  const out = forms.map((f, index) => {
    const fields = Array.from(f.querySelectorAll('input, textarea, select'))
      .filter(el => !['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes((el.type || '').toLowerCase()))
      .map(el => ({ tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(), name: el.name || '', visible: vis(el), required: el.required || el.getAttribute('aria-required') === 'true', hint: labelOf(el) }));
    const visFields = fields.filter(x => x.visible);
    const role = (f.getAttribute('role') || '') + ' ' + (f.className || '') + ' ' + (f.action || '');
    const onlySearch = visFields.length <= 2 && visFields.some(x => x.name === 's' || x.type === 'search' || /search/.test(x.hint));
    const login = visFields.some(x => x.type === 'password');
    const hasEmail = visFields.some(x => x.type === 'email' || /e-?mail/.test(x.hint));
    const hasText = visFields.some(x => x.tag === 'textarea');
    const newsletter = hasEmail && !hasText && visFields.length <= 3 && /newsletter|subscribe|mailchimp|mc4wp|klaviyo|sign ?up|join/i.test(role + ' ' + f.innerText);
    let externalAction = false;
    try { const a = new URL(f.getAttribute('action') || location.href, location.href); externalAction = a.hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, ''); } catch {}
    let selector = null;
    if (f.id) selector = `form#${CSS.escape(f.id)}`;
    else if (f.getAttribute('name')) selector = `form[name="${f.getAttribute('name')}"]`;
    let score = 0;
    if (hasEmail) score += 3; if (hasText) score += 3; if (pluginOf(f) !== 'custom') score += 2;
    score += Math.min(visFields.length, 6) * 0.5;
    if (onlySearch || login || newsletter) score = -1;
    if (externalAction && pluginOf(f) === 'custom') score -= 3; // booking-engine widgets, mailing-list posts
    if (!vis(f) && !visFields.length) score = -1;
    return { index, selector, plugin: pluginOf(f), score, has_email: hasEmail, has_textarea: hasText, newsletter, external_action: externalAction,
      visible_fields: visFields.length, fields: visFields.map(x => `${x.tag}${x.type && x.tag === 'input' ? ':' + x.type : ''}${x.required ? '*' : ''} ${x.hint.slice(0, 40)}`) };
  });
  const html = document.documentElement.outerHTML;
  const captcha = [];
  if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], script[src*="recaptcha"], .grecaptcha-badge')) captcha.push('recaptcha');
  if (document.querySelector('.cf-turnstile, script[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]')) captcha.push('turnstile');
  if (document.querySelector('.h-captcha, script[src*="hcaptcha"]')) captcha.push('hcaptcha');
  const externalForms = Array.from(document.querySelectorAll('iframe, script'))
    .map(e => e.src || '')
    .filter(s => /jotform|hsforms|hubspot|typeform|docs\.google\.com\/forms|wufoo|formstack|cognitoforms|123formbuilder|formsite|zohopublic|forms\.office/.test(s))
    .map(s => { try { return new URL(s).hostname; } catch { return s; } });
  return {
    forms: out,
    captcha,
    external_forms: [...new Set(externalForms)],
    wordpress: /wp-content|wp-includes/.test(html),
  };
}

// Links on the page that probably lead to a contact/inquiry form (same host only).
export function contactLinksInPage() {
  const re = /contact|inquir|enquir|get-in-touch|reach-us|request-info|request-a|rfp|info-request|questions|book-a-tour|group-sales|weddings?-inquiry|events?-inquiry/i;
  const host = location.hostname.replace(/^www\./, '');
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== host) continue;
    if (/\.(pdf|jpg|png|docx?)$/i.test(u.pathname)) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    if (re.test(u.pathname) || re.test(a.innerText || '')) { seen.add(key); out.push({ url: key, contact: /contact/i.test(u.pathname + ' ' + a.innerText) }); }
  }
  out.sort((a, b) => (b.contact - a.contact));
  return out.slice(0, 6).map(x => x.url);
}

// ---------- mailer ----------
export async function sendEmail({ subject, text, html }) {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_TO } = process.env;
  if (!(SMTP_HOST && SMTP_USER && SMTP_PASS && ALERT_TO)) { console.log('SMTP secrets not set — email skipped.'); return false; }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const tx = nodemailer.createTransport({ host: SMTP_HOST, port: 587, secure: false, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    await tx.sendMail({ from: `"VisualMonitor Form Test" <${process.env.ALERT_FROM || ALERT_TO}>`, to: ALERT_TO, subject, text, html });
    console.log('Summary email sent.');
    return true;
  } catch (e) { console.error('Email FAILED:', e.message); return false; }
}
