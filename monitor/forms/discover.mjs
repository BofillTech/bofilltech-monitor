// BofillTech VisualMonitor — Weekly Form Test: DISCOVERY PASS
// Visits every site in sites.json, looks for its contact/inquiry form, and records it in forms.json.
// Never submits anything.
//
// Usage: node monitor/forms/discover.mjs [--only slug1,slug2] [--refresh]
//   --only     limit to some sites
//   --refresh  re-discover sites already in forms.json (locked entries are never touched)
// Writes: forms.json, data/forms-discovery-report.md

import path from 'path';
import fs from 'fs';
import { ROOT, readJson, loadForms, saveForms, openPage, gotoSettled, inspectFormsInPage, contactLinksInPage, closeBrowser, pool, siteHost } from './lib.mjs';

const args = process.argv.slice(2);
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : (process.env.ONLY || '');
const ONLY = new Set(onlyArg.split(',').map(s => s.trim()).filter(Boolean));
const REFRESH = args.includes('--refresh') || process.env.REFRESH === 'true';

const sitesCfg = readJson(path.join(ROOT, 'sites.json'));
const forms = loadForms();

let targets = sitesCfg.sites;
if (ONLY.size) targets = targets.filter(s => ONLY.has(s.slug));
else if (!REFRESH) targets = targets.filter(s => !forms.sites[s.slug]);
targets = targets.filter(s => !forms.sites[s.slug]?.locked);

console.log(`Discovering forms on ${targets.length} site(s)…`);

async function discover(site) {
  const entry = { name: site.name, url: site.url, discovered_at: new Date().toISOString() };
  const page = await openPage(site.url);
  try {
    const home = await gotoSettled(page, site.url);
    if (home.challenged) return { ...entry, status: 'blocked', note: 'Security challenge never cleared' };
    if (home.error) return { ...entry, status: 'error', note: home.error };

    const candidates = [page.url()];
    const links = await page.evaluate(contactLinksInPage).catch(() => []);
    for (const l of links) if (!candidates.includes(l)) candidates.push(l);
    const origin = new URL(page.url()).origin;
    for (const p of ['/contact/', '/contact-us/']) { const u = origin + p; if (!candidates.some(c => c.replace(/\/$/, '') === u.replace(/\/$/, ''))) candidates.push(u); }

    let best = null;
    const captchaSeen = new Set(), externalSeen = new Set();
    let wordpress = false;
    for (const url of candidates.slice(0, 8)) {
      if (url !== page.url()) {
        const r = await gotoSettled(page, url);
        if (r.status >= 400 || r.error || r.challenged) continue;
        if (siteHost(page.url()) !== siteHost(site.url)) continue; // redirected off-site (booking engine etc.)
      }
      const info = await page.evaluate(inspectFormsInPage).catch(() => null);
      if (!info) continue;
      wordpress ||= info.wordpress;
      info.external_forms.forEach(x => externalSeen.add(x));
      for (const f of info.forms) {
        if (f.score <= 0) continue;
        // a form on a contact page beats the same form in a homepage footer
        const s = f.score + (/contact|inquir|enquir/i.test(page.url()) ? 1 : 0);
        if (!best || s > best.s) best = { s, form: f, page_url: page.url().split('#')[0], captcha: info.captcha };
      }
      info.captcha.forEach(c => captchaSeen.add(c));
      if (best && best.s >= 9 && /contact/i.test(best.page_url)) break; // good enough, stop crawling
    }

    if (!best) {
      if (externalSeen.size) return { ...entry, wordpress, status: 'external', note: `Form hosted by another service: ${[...externalSeen].join(', ')}` };
      return { ...entry, wordpress, status: 'no_form', note: 'No contact form found on homepage or likely contact pages' };
    }
    const f = best.form;
    const out = {
      ...entry,
      status: f.has_email ? 'found' : 'found_no_email',
      wordpress,
      form_url: best.page_url,
      form_selector: f.selector,
      form_index: f.index,
      plugin: f.plugin,
      captcha: best.captcha,
      has_textarea: f.has_textarea,
      fields: f.fields,
    };
    if (!f.has_textarea) out.note = 'No message box — test ID goes in another text field';
    if (externalSeen.size) out.note = (out.note ? out.note + '. ' : '') + `Also embeds: ${[...externalSeen].join(', ')}`;
    // Is the Bofill Weekly Form Test plugin installed?
    out.helper_plugin = await page.evaluate(async () => {
      try { const r = await fetch('/wp-json/bofill-formtest/v1/ping', { credentials: 'omit' }); if (!r.ok) return false; const j = await r.json(); return j?.ok ? (j.version || true) : false; } catch { return false; }
    }).catch(() => false);
    return out;
  } catch (e) {
    return { ...entry, status: 'error', note: e.message.slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}

const results = await pool(targets, Number(process.env.CONCURRENCY || 3), async (site) => {
  const r = await discover(site);
  console.log(`[${r.status.padEnd(14)}] ${site.name}${r.plugin ? ' — ' + r.plugin : ''}${r.captcha?.length ? ' (captcha: ' + r.captcha.join('+') + ')' : ''}${r.note ? ' — ' + r.note : ''}`);
  return [site.slug, r];
});
await closeBrowser();

for (const [slug, r] of results) {
  const prev = forms.sites[slug] || {};
  // keep Steve's manual fields; replace everything discovered
  forms.sites[slug] = { ...r, skip: prev.skip || undefined, notes: prev.notes || undefined };
}
// drop entries for sites no longer monitored
const valid = new Set(sitesCfg.sites.map(s => s.slug));
for (const k of Object.keys(forms.sites)) if (!valid.has(k)) delete forms.sites[k];
// stable ordering
forms.sites = Object.fromEntries(Object.entries(forms.sites).sort(([a], [b]) => a.localeCompare(b)));
saveForms(forms);

// ---------- human-readable report ----------
const all = Object.entries(forms.sites);
const group = st => all.filter(([, v]) => v.status === st);
const line = ([slug, v]) => `| ${v.name} | \`${slug}\` | ${v.form_url ? `[form page](${v.form_url})` : '—'} | ${v.plugin || '—'} | ${v.captcha?.length ? v.captcha.join(', ') : '—'} | ${v.helper_plugin ? 'yes' : 'no'} | ${(v.note || '').replace(/\|/g, '/')} |`;
const table = rows => rows.length ? ['| Site | ID | Form | Form plugin | CAPTCHA | Helper plugin | Note |', '|---|---|---|---|---|---|---|', ...rows.map(line)].join('\n') : '_None_';
const byPlugin = {};
for (const [, v] of all) if (v.plugin) byPlugin[v.plugin] = (byPlugin[v.plugin] || 0) + 1;

const md = `# Weekly Form Test — Discovery Report
Generated ${new Date().toISOString()}

**${all.length}** sites inspected · **${group('found').length}** forms found · **${group('found_no_email').length}** forms without an email field · **${group('external').length}** hosted by another service · **${group('no_form').length}** no form · **${group('blocked').length}** blocked by security · **${group('error').length}** errors

Form plugins: ${Object.entries(byPlugin).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}

To exclude a site, set \`"skip": true\` on it in forms.json. To stop discovery from changing a site you corrected by hand, set \`"locked": true\`.

## Forms found
${table(group('found'))}

## Forms with no email field
${table(group('found_no_email'))}

## Hosted by another form service (can't be tested this way)
${table(group('external'))}

## No form found
${table(group('no_form'))}

## Blocked by security / errors
${table([...group('blocked'), ...group('error')])}
`;
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'forms-discovery-report.md'), md);
console.log(`\nDone. ${group('found').length} forms found. Report: data/forms-discovery-report.md`);
