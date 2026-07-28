# Exploration: Focus Presenter as a Chrome Web Store extension

Goal: distribute the tool through a store so (a) security scrutiny is handled by a known
review process users trust, (b) you control versions/rollout centrally, and (c) you can
charge money. This document covers feasibility (proven — see `extension/`), store
mechanics, monetization options, what stays hard, and a recommended path.

## 1. Technical feasibility — proven, scaffold included

The repo now contains a working **Manifest V3** extension (`extension/`, built from the
same `src/` by `build-ext.sh`) that was loaded and exercised in Chromium: PDF rendering,
curtain, tear/seam all work as an extension page.

Two MV3 constraints required changes, both already handled:

| MV3 rule | Impact on us | Resolution |
|---|---|---|
| No inline `<script>` on extension pages | The single-file build inlines everything | `build-ext.sh` ships `app.js` / `vendor/*.js` as separate packaged files |
| No remotely hosted code | None — we already bundle pdf.js | Worker loads from the packaged `vendor/pdf.worker.min.js` instead of an inlined blob (auto-detected in `app.js`) |

Everything else (canvas tiling, SVG masks, backdrop blur, fullscreen) is ordinary web
platform and works identically. `offline_enabled: true` declares what's already true:
zero network use.

**Our permission footprint is the best case for review**: no host permissions, no content
scripts, no `tabs`/`activeTab`, no data collection — just a toolbar button that opens a
packaged page. That lands the extension in the fast automated-review track.

## 2. Chrome Web Store mechanics

- **Cost & account**: one-time $5 developer registration fee.
- **Review time**: first submission from a new account ~7–14 business days; established
  accounts 2–5 days; **updates typically 24–48 h**; minimal-permission MV3 extensions can
  clear automated review in under an hour. (Times fluctuate with submission surges.)
- **What you must provide**: a single clear purpose, a privacy policy URL (ours is one
  sentence: "no data leaves your device"), data-use disclosures in the dashboard, store
  assets (screenshots, promo tile), and — for paid products in the EU — a trader
  declaration (name/address shown publicly, per the DSA).
- **What you get**: the "store-reviewed" trust signal, automatic silent updates to all
  users, staged percentage rollouts, listed/unlisted/private visibility, and usage stats
  (installs, uninstalls, impressions) in the developer dashboard.
- **Same codebase, more stores**: Edge Add-ons (free registration) and Firefox AMO accept
  near-identical MV3 packages; pdf.js is Mozilla's own library.

Control angle (your "manage performance" point): CWS auto-update means every user runs
the version you shipped; you can also fetch remote *configuration* (feature flags, kill
switches, announcement banners) at runtime — remote **data** is allowed, remote **code**
is not. Analytics are allowed with disclosure; a self-hosted, anonymous event counter
keeps the privacy story intact ("we count feature usage, nothing else").

## 3. Charging money — the real landscape

Google **shut down Chrome Web Store's native payments** (Feb 2021). There is no "set a
price in the store" anymore; every paid extension brings its own billing. The store
allows paid extensions as long as pricing is transparent. Practical options:

| Option | Fees (approx) | Pros | Cons |
|---|---|---|---|
| **ExtensionPay** (extpay.js + Stripe) | 5% + Stripe ~2.9% + 30¢ | Built for extensions; hours to integrate; subscriptions, one-time, trials; no monthly fee | You are the merchant (handle VAT/sales tax); 5% forever |
| **Stripe direct** (own landing page + license key API) | ~2.9% + 30¢ | Cheapest at scale; full control | You build checkout, licensing server, key validation, tax handling |
| **Paddle / Lemon Squeezy** (merchant of record) | ~5% + 50¢ | They handle global VAT/tax/invoices — big deal for solo devs selling worldwide | Slightly higher fees; checkout redirects to their page |
| **Freemium + license unlock** (any of the above) | — | Free tier drives installs (store ranking loves installs); Pro unlocks | Needs a sensible free/Pro split |

Architecture that fits our offline-first promise: the extension stays fully functional
offline; on Pro purchase the user signs in once (or pastes a license key), the extension
validates against your API and **caches the entitlement with a ~7-day offline grace
window**. Presenters must never be blocked mid-meeting by a license check — that's a
product principle worth keeping explicit.

Honest caveat: MV3's local-code rule means Pro gating lives in shipped JS — a determined
user can crack it. Every paid extension has this property. For a productivity tool priced
$5–15, convenience + updates + conscience is what actually converts; don't over-invest in
DRM.

A sensible free/Pro split for this tool:
- **Free**: open PDF/images, one slate or curtain, spotlight, zoom.
- **Pro**: unlimited slates, tear/seam, frosted style, saved slate layouts per file,
  presenter shortcuts — the "I present for a living" features.

## 4. What an extension does NOT solve — and a phase-2 superpower

- The store does **not** vouch for quality, only policy compliance; "works seamlessly on
  PPT" still means "export to PDF first" unless we build overlay mode (next point).
- An extension page cannot cover other applications' windows (OS-level fullscreen
  PowerPoint). That would need a desktop app (Electron/Tauri) — different product.

**Phase 2 worth exploring**: a content-script *overlay mode* that injects slates /
spotlight / tears **on top of any web page** — Google Slides in present view, Figma,
Miro, dashboards, live products. That is something the standalone file can never do, it's
a genuine differentiator, and it's the natural Pro feature. Cost: it needs `activeTab`
(or host) permissions → slower, stricter review and a heavier privacy story. Ship v1
without it; add it once the listing has reviews and installs.

## 5. Selling from Israel — payment reality check

- **Stripe does not operate in Israel**, so ExtensionPay (which requires your own Stripe
  account) is off the table without a US entity. This removes the "default" extension
  payment route.
- **Paddle is the practical choice**: it acts as merchant of record, explicitly supports
  Israel-based sellers, and pays out worldwide via wire transfer or **Payoneer** (an
  Israeli-founded service, widely used locally). ~5% + 50¢ per transaction, and Paddle —
  not you — is the seller toward end customers, so it handles US sales tax, EU VAT, etc.
- **Lemon Squeezy** is comparable on paper but was acquired by Stripe and is being folded
  into Stripe's stack — a riskier bet for an Israeli seller specifically.
- **Later, at scale**: a US LLC via Stripe Atlas (+ US bank) reopens Stripe/ExtensionPay
  and cuts fees to ~3%, at the cost of ~$500 setup plus yearly US filings — not worth it
  before real revenue.
- **Tax notes (verify with an Israeli accountant)**: with a merchant of record, your
  income is B2B service revenue from a foreign company (Paddle, UK), which is typically
  zero-rated for Israeli VAT as an export of services — you don't touch the 18% VAT
  charged to end buyers, Paddle handles buyers' taxes in their countries. Business
  registration as *osek patur* works up to roughly ₪120k/year turnover; above that,
  *osek murshe*. The Chrome Web Store's EU trader rules still require your name/address
  on the listing when charging EU users.

## 6. Recommendation

1. **Ship the MV3 extension now** (scaffold is ready): free, minimal permissions, fast
   review track. Keep the single HTML file as the frictionless demo / fallback channel.
2. **Add payments in v1.1** with ExtensionPay (fastest) or Lemon Squeezy (if you want
   taxes handled); freemium split as above.
3. **List on Edge Add-ons + Firefox AMO** with the same package for free extra reach.
4. **Phase 2**: overlay-on-any-tab mode as the flagship Pro feature.

### Publish checklist (when ready)
- [ ] $5 developer account, verified email, 2FA
- [ ] Zip `extension/` → upload in dashboard
- [ ] Store listing: 1280×800 screenshots (we have real ones), 440×280 promo tile, description
- [ ] Privacy policy URL (a page in the repo's GitHub Pages works)
- [ ] Data-use disclosure: "does not collect user data"
- [ ] EU trader declaration if charging
- [ ] Unlisted first → share link with pilot users → flip to public
