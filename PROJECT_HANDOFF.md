# مُهل (Muhl / MOHL) — Project Handoff Document
## For starting a fresh Claude Code session

This document exists so a new Claude Code session (or any new Claude conversation)
can understand the full state of this project without re-reading a massive chat
history. Paste this as your first message, or point Claude Code at this file.

Site: **https://mohl.coffee** (also reachable at the Vercel default domain
`coffee-site-mpsr.vercel.app`).

---

## 1. CORE PRODUCT CONCEPT

مُهل (Muhl) is an Arabic-language web app: the customer photographs a coffee bag,
and the AI (Claude, via the Anthropic API) identifies the bean and generates a
full V60 brewing recipe (hot or iced), with educational "why" explanations for
every number — the goal is to teach the customer about coffee, not just hand
them instructions.

The whole site is Arabic-first, RTL layout.

---

## 2. TECH STACK & INFRASTRUCTURE

- **Hosting:** Vercel (Hobby/free tier), auto-deploys from GitHub `main` branch.
- **Repo:** GitHub repo named `coffee-site` (owner account: `A7MDx` / `ahmed111998`).
- **AI:** Anthropic API, model string `claude-sonnet-4-6`, called server-side only
  from `/api/analyze.js` (key never touches the browser).
- **Database:** Upstash Redis (`@upstash/redis` npm package), connected to the
  Vercel project as an integration — env vars are auto-injected as
  `KV_REST_API_URL` / `KV_REST_API_TOKEN` (also duplicated under
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — code checks both).
- **Email:** Resend (for password-reset emails only, sender domain `mohl.coffee`
  is verified there). Env var: `RESEND_API_KEY`.
- **Domain:** `mohl.coffee`, purchased via Cloudflare Registrar, DNS managed in
  Cloudflare (A record `@` → `76.76.21.21`, CNAME `www` → `cname.vercel-dns.com`,
  both set to "DNS only" / not proxied).
- **Frontend:** No build step. Plain HTML files using React 18 + Babel Standalone
  loaded from CDN (`<script type="text/babel">` inline in `index.html`). This is
  intentional — keeps deployment to "edit file on GitHub, Vercel redeploys."
- **Backend:** Vercel Serverless Functions, one file per endpoint under `/api`.

### Required environment variables (set in Vercel → Settings → Environment Variables)
```
ANTHROPIC_API_KEY          — Anthropic API key
KV_REST_API_URL            — Upstash (auto-added by integration)
KV_REST_API_TOKEN          — Upstash (auto-added by integration)
OWNER_BOOTSTRAP_SECRET     — one-time secret to promote the first account to "owner" role
RESEND_API_KEY             — Resend API key, for password-reset emails
```

---

## 3. FILE STRUCTURE (repo root)

```
coffee-site/
├── index.html          — the entire main site (UI + all client logic)
├── stats.html           — separate stats dashboard page (public + owner-only sections)
├── package.json         — { "@upstash/redis": "^1.34.0" }
└── api/
    ├── analyze.js        — Anthropic API calls (identify / recipe / refine / freshness modes)
    ├── auth.js            — signup / login / logout / session / roles / password reset
    ├── favorites.js       — save/remove favorites + auto history log
    ├── rate.js            — star ratings + comments (+ global comment feed for owner)
    ├── record.js          — analytics counters (origin, process, roastery, temp, grinder, cupcount...)
    └── stats.js           — aggregates everything above for stats.html
```

Each file has its own internal version counter in a header comment
(`// Version: N`), and `index.html` displays a combined version string at the
bottom of the page, built from all the individual file versions concatenated
in this order:
`analyze.record.rate.package.(unused-slot).index.auth.favorites`
(the exact APP_VERSION string is hardcoded near the top of the `<script>` block
in `index.html` — just bump the relevant segment whenever you edit a file, and
increment index.html's own segment on every index.html change).

**Deploy workflow (current, manual):** edit file on GitHub web UI → commit to
`main` → Vercel auto-deploys. Claude Code should be able to replace this whole
manual loop by editing files locally and pushing directly.

---

## 4. `api/analyze.js` — AI logic (the most important backend file)

Four modes, dispatched via `req.body.mode`:

1. **`identify`** — takes `imageBase64` only. Vision call. Returns bean
   identification WITHOUT recipe numbers: `coffee_type` (brand name as printed
   on bag, but transliterated to Arabic script if only Latin is printed — never
   translate the meaning, e.g. "Hambela Buku" → "هامبيلا بوكو"), `roast_level`,
   `origin` (English standard country name, e.g. "Ethiopia"), `process`,
   `roastery_name` (prefers Arabic if bilingual, else `unknown`), `altitude`
   (meters, number or null), `description` (2-3 sentence flavor blurb),
   `confidence_note` (one short sentence), `sensory` object
   (`acidity`/`sweetness`/`body`/`bitterness`, each 0-100).
   This is deliberately a *cheap, image-only* call so re-adjusting cup count /
   grinder later doesn't require re-sending the photo.

2. **`recipe`** — takes the `beanProfile` (the identify output), `tempChoice`
   (`hot`/`cold`), `grinderInfo` (string or null), `cupCount`, `cupSize`
   (`small`/`medium`/`large`), and `targetWaterMl` (pre-computed by the
   frontend — see cup-size table below). Text-only call (no image, cheaper).
   Returns the numeric recipe: `amount_grams`, `why_amount`, `brew_ratio`,
   `why_ratio`, `temperature_c`, `why_temperature`, `pours_count`, `why_pours`,
   `ice_amount` (grams, only if cold — must be a bare number+unit, explanation
   goes in `why_ice` not inside the value itself), `why_ice`, `pours_breakdown`
   (array of `{label, amount, time}` — labels must be exactly "الصبة الأولى" /
   "الصبة الثانية" / "الصبة الثالثة" / "الصبة الرابعة", nothing else), `grind_setting`,
   `why_grind`, `notes`.
   The prompt explicitly tells the model `targetWaterMl` is the **total for all
   cups combined already** (not per-cup, don't multiply again), and that ±20ml
   is fine — it's a flexible target, not an exact number to hit.

3. **`refine`** — "تحسين الوصفة" / cup personalization. Takes original bean
   profile + original recipe + `targetSensory` (the four slider values the
   user dragged to). Rebuilds the full recipe respecting the bean's real
   character — explicitly forbidden from pushing sensory values past what the
   actual bean can realistically deliver (e.g. can't turn a naturally
   low-acidity bean into a very-high-acidity cup).

4. **`freshness`** — "متى أفضل وقت لشرب هذا البن؟" Takes bean profile +
   `roastDate`. Reasons about the bean's own characteristics (roast level,
   process, altitude) to produce a *bean-specific* peak-flavor window — never a
   fixed universal number. Returns 4 possible `current_status` values: "لسه
   مبكر" / "بالنافذة المثلى" / "بدأ يتراجع تدريجيًا" / "بدأ يفقد نكهته", plus
   `window_start_days`, `window_end_days`, `bar_position` (0-100, position on a
   4-zone colored bar the frontend renders), and `why`. The prompt is tuned to
   be *optimistic by default* — it should rarely land on "بدأ يفقد نكهته"
   unless there's a clear, strong signal, because early testing showed the
   model defaulting to alarming the user too easily.

Rate limiting: in-memory Map, 20 requests/hour per IP (resets on cold start —
known limitation, acceptable for current scale).

### Cup size system (frontend-computed, sent to backend as `targetWaterMl`)
```js
const CUP_SIZES = {
  small:  { label: "صغير",  oz: 9,  ml: 260 },
  medium: { label: "متوسط", oz: 10, ml: 300 },
  large:  { label: "كبير",  oz: 12, ml: 360 }
};
// total = CUP_SIZES[size].ml * cupCount
```
These ml values are deliberately rounded UP to clean numbers per explicit user
instruction (e.g. 12oz is labeled 360ml, not the "real" 355ml conversion).

---

## 5. `api/auth.js` — accounts, roles, sessions, password reset

- Email + password signup, **no email verification required** — logs the user
  in immediately after signup (explicit product decision: minimize friction).
- Passwords hashed with Node's built-in `crypto.pbkdf2Sync` (no external deps).
- Sessions: random token in an `HttpOnly` cookie (`mohal_session`), the token
  maps to a userId in Redis with a 30-day TTL.
- **Roles: 3 tiers** — `owner` (full access + stats), `admin` (stats view
  only), `user` (default/regular). The `role` field is **never written to
  Redis for a regular user** — its absence just means "user". This was a
  deliberate storage-cost optimization. It's only written when someone is
  promoted to admin/owner.
- **First owner bootstrap:** a `promote` action checks `OWNER_BOOTSTRAP_SECRET`
  against the env var; it self-disables after first successful use (writes an
  `owner_bootstrap_used` flag) so it can't be reused even if the secret leaks
  later. After that, the owner can promote other accounts without the secret.
- **Password reset (new):** `request-password-reset` action generates a
  one-hour, single-use token, emails a reset link via Resend
  (`https://mohl.coffee/?reset=TOKEN`), and — deliberately — returns the exact
  same generic response whether or not the email exists, to prevent account
  enumeration. `reset-password` consumes the token and updates the password
  hash. Both login and password-reset-request have a basic in-memory
  brute-force rate limit (10 attempts/hour per key).
- Frontend: `index.html` reads `?reset=` from the URL on load and shows a
  "set new password" modal if present, then strips the query param from the
  visible URL.

---

## 6. `api/favorites.js` — favorites + auto history log

- **Favorites** (manual, heart button): stores the full recipe JSON exactly as
  it was shown (no re-calling the AI later) under
  `favorite:{userId}:{beansId}`, tracked in a set `user_favorites:{userId}`.
  A global counter `favorites:total` increments/decrements only on genuinely
  new adds/removes (checked via `SISMEMBER` first, to avoid double-counting).
- **History (دفتر القهوة)** — automatic, separate from favorites. Every
  successful analysis by a logged-in user gets pushed (unprompted) to a Redis
  list `user_history:{userId}`, capped at 200 items (oldest trimmed
  automatically). This is a deliberate product distinction from favorites:
  "favorites = the user chose to keep this" vs "history = everything they've
  ever brewed, automatically."
- Opening a favorite or history entry re-renders the exact saved recipe
  client-side — no new AI call — and lets the user re-rate/re-comment/update
  cup settings/etc. exactly as if it were a fresh result.

---

## 7. `api/rate.js` — ratings & comments

- **Rating requires login** — this was tightened over the course of
  development; anonymous rating was removed entirely.
- **One rating per user per product**, enforced via a
  `user_rated:{userId}:{beansId}` marker. Trying to rate again returns a clear
  error telling them to delete their existing rating first.
- Deleting a comment/rating **properly reverses the stats** — decrements
  `beans_rating_sum`/`beans_rating_count` (and roastery equivalents), and
  clears the `user_rated` marker so the user can rate again. (Earlier version
  had a bug here — comment text was deleted but the rating average never
  corrected. Fixed.)
- Comments are optional, capped at 500 chars, stored per-product
  (`beans_comments:{beansId}`, a hash keyed by a random commentId) AND pushed
  to a capped global feed (`global_comments_feed`, last 200) for the
  owner-only "recent comments across the whole site" panel in stats.html.
- `comments:total` is a simple running counter.

---

## 8. `api/record.js` — analytics counters

Every successful search bumps a family of Redis hash counters, each with both
a `:day:YYYY-MM-DD` key and a permanent `:all` key: `beans`, `roastery`,
`origin` (normalized via an alias map — Arabic/English variants collapse to
one English key), `process` (same normalization), `temp` (hot/cold split),
`cupcount` (1/2/3 split), `grinder_brand`, `grinder_model`, `grinder_custom`
(free-typed grinder names — meant to reveal which grinders should be added to
the dropdown list), `grinder_mode_choice` (list/custom/none split — shows what
% of users actually know their grinder).

**Correction mode:** if a bag's roastery was first recorded as "unknown" and
the user later types the real name, `correction: true` transfers the counter
from the old key to the new one (no double-counting). This same
correction-transfer pattern is used for a separate `update-settings` action
that fixes temp/cupcount stats when a user changes hot↔cold or cup count via
the "🔄 تحديث الوصفة" button on an already-generated result (again, to avoid
inflating the search count for what's really just an edit, not a new search).

**Known unresolved issue (see section 11):** the same roastery written in
Arabic vs English (e.g. "صواع" vs "Suwaa Coffee Roastery") currently registers
as two separate entries. A fix was *designed but not yet implemented* — see
section 11.

---

## 9. `api/stats.js` + `stats.html`

Single GET endpoint, aggregates everything above. Two sections:
- **Public** (anyone): top beans this month / all-time, top roastery/origin/
  process/grinder brand & model, hot-vs-cold split, top-rated beans/roasteries.
- **Owner/admin only** (session role-checked server-side): total accounts,
  total searches, unique beans count, total comments, cup-count split, "how
  many people used تحسين الوصفة / متى أفضل وقت" feature-usage counters,
  favorites total, grinder-mode split, manually-typed grinder names list (with
  counts), and the recent global comments feed.

Currently **not linked from the main site's UI for regular users** — the
public section exists in the API/page but there's no nav link to it yet; it's
meant to eventually feed the future homepage redesign. Owner/admin see a link
to `/stats.html` in the account dropdown menu; a "إدارة الحسابات" item is
also visible to the owner only but is a placeholder ("قريبًا") — not built.

---

## 10. `index.html` — frontend flow (current, as of last edit)

**Screen flow (this was redesigned multiple times — this is the FINAL state):**
1. First screen: hot/cold toggle (defaults to "hot" so no forced choice),
   **cup count/size selector** (1/2/3 cups × small/medium/large, each button
   showing live oz×count and ml×count), **grinder selector** (list / free-text
   / none), then a single "📷 صوّر كيس القهوة" button.
2. Button triggers the device's **native camera app** via
   `<input type="file" accept="image/*" capture="environment">` — NOT a custom
   in-page `getUserMedia` video stream (that was the original approach; it was
   replaced because it gave no manual focus control on iOS, hurting photo
   quality). This also fixed a later bug where the captured image was
   force-cropped into a 4:3 box — the display box now has no fixed
   aspect-ratio and shows the photo at its true proportions, `object-fit:
   contain`, capped at `max-height: 420px`.
3. On file selection: `identifyAndBuildRecipe()` runs the `identify` call then
   immediately the `recipe` call using whatever the user picked on screen 1 —
   feels like one step to the user even though it's two API calls under the
   hood (this split is what makes the "🔄 تحديث الوصفة" button cheap later:
   changing cup size/grinder/temp re-calls `recipe` only, never re-sends the
   photo).
4. Result screen: identification header (roastery/origin bits mixed with the
   coffee name), metrics grid, dynamic pour table, "🔄 تحديث الوصفة" edit
   panel (same cup/grinder/temp selectors, now editable in place), rating +
   comments, "خصّص كوبك" sensory sliders (4 dual-arrow sliders — black arrow
   = fixed AI-estimated baseline, gold arrow = actual result after clicking
   "✨ تحسين الوصفة"; range clamped to baseline±30; button usable multiple
   times per photo), "متى أفضل وقت لشرب هذا البن؟" (optional roast-date input
   → 4-zone colored freshness bar), and **"📸 احفظ بالاستوديو"** — renders a
   hidden, fully-branded, print-quality recipe card (see section 12) with
   `html2canvas` and triggers either the native share sheet (mobile,
   preferred — lets the user "save to Photos" directly) or a plain download.

**Account UI:** email/dropdown in the top-right when logged in ("محاصيلي
المفضلة", "دفتر قهوتي", "الإحصائيات" [owner/admin only], "إدارة الحسابات"
[owner only, placeholder], "خروج"), or a "تسجيل الدخول" link when logged out.
Auth modal supports login / signup / forgot-password in one component.

---

## 11. THE MUHL BRAND IDENTITY (locked in, apply everywhere)

Colors (CSS custom properties, already applied across `index.html` and the
recipe-card template — do NOT reintroduce the old palette):
```css
--olive: #575E40;
--olive-dark: #3D4027;   /* body text, dark elements */
--terracotta: #B36739;   /* accent — NEVER as a large solid background for the
                             "وصفة حارة" badge specifically, it competes with
                             the brand color there; use a softer supporting
                             tone instead */
--cream-bg: #E6DECA;      /* page background */
--card-light: #F5F1DF;    /* elevated card background, NOT pure white */
--text-darker: #16180B;
```
Fonts: **Aref Ruqaa** (700) for the "مُهل" wordmark/logo only, **Tajawal**
(400/500/700) for everything else. Both loaded from Google Fonts.

The main `index.html` UI was fully re-skinned to this palette (see the
`#coffee-app { --ink: ...; }` CSS variable block near the top of the file —
that's the single source of truth; almost every component references these
vars, so re-theming again later should mostly mean editing that one block +
grepping for any stray hardcoded hex codes in inline `style={{...}}` JSX,
which happens in a couple of places, e.g. the hot/cold temp-card title color).

### Recipe-card visual template (for "احفظ بالاستوديو")
This was designed iteratively as a standalone artifact before being ported
into `index.html` as the `RecipeCard` React component. Locked-in rules:
- 1080×1920 target (9:16, mobile/story-shareable), but implemented as
  `min-height` + auto-growing content rather than a hard-clipped fixed height
  (a real bug: fixed height + `overflow:hidden` was silently cutting off the
  bottom sections on longer real recipes — fixed by switching to
  `min-height` and removing the clip).
- Botanical coffee-leaf branch illustration, **top-left only**, elongated
  pointed leaf shapes (not round/olive-tree-like), small cream flower dots
  with a tiny terracotta center — kept intentionally small/tucked into the
  true corner so it never overlaps body text.
- **No geometric shapes anywhere in the decoration** — the bottom-corner
  "torn paper" accents were redesigned multiple times to be pure organic
  bezier-curve blobs, never straight-edged triangles.
- Both bottom corners use the **same two-color treatment** (olive base layer +
  a semi-transparent terracotta layer on top, with two thin accent lines) —
  explicitly NOT color-coded by hot/cold (an earlier version wrongly used
  blue for cold; corrected — always olive+terracotta, never blue).
- Header: `{origin (Arabic, translated via an ORIGIN_AR lookup map since the
  backend stores origin in English)} | {coffee_type}` — origin text color is
  plain dark ink, NOT terracotta (was terracotta in an earlier draft, changed
  on request).
- Top info grid, RTL order (rightmost → leftmost): **الأكواب, النسبة,
  الحرارة, كمية الثلج (cold only, conditionally rendered), الماء, كمية البن**
  — "كمية البن" is deliberately the LEFTMOST item now (was flipped from an
  earlier "rightmost" version per explicit request). Water ml is *computed*
  client-side from `amount_grams × ratio`, since the API doesn't return a
  standalone water field.
- Dynamic pour table: `justify-content: center` with `flex-wrap: nowrap` and
  shrinkable cards (`min-width: 0`) so it always renders as one row, centered,
  for any pour count 1-4 — never wraps to two rows, never looks lopsided.
- Section dividers: all identical style now (thin line + small terracotta
  diamond dot, centered) — an earlier "no dot on the first divider" exception
  was tried and then explicitly reverted.
- "معلومات المحصول" section: labels bold, values light, **no decorative leaf
  icon here anymore** (removed on request) and **no card background box**
  (also removed — the flavor-bars section above it keeps its light card
  background, but crop-info does not; this asymmetry is intentional, per
  explicit user feedback that the crop-info box "felt illogical").
- Never write "وصفة قهوتك" / "حفظ الوصفة" / "تحميل الوصفة" / a year / a
  copyright line anywhere on the card — these are website UI actions, not
  part of the saved artifact.
- Logo "مُهل" appears small at both the very top and very bottom (footer
  wordmark with thin flanking lines) — this exact treatment is the one visual
  element the user has repeatedly said not to touch/redesign.

---

## 12. MASCOT / LOGO — status: UNRESOLVED, explore next

Many rounds of exploration, no final pick yet:
- Original: a smiling walking mug character (still used as the loading
  spinner throughout the site, `MugLoader` component) — user now wants this
  **replaced**, found the smile unsettling.
- Explored and rejected: humanoid mug mascots (20 variants), 3D-gradient mug
  mascots with arms (8 variants) — none landed.
- Latest direction (as of last request): a simple **hand-drawn sketch-style
  duck** holding a coffee cup (inspired by a Pinterest reference of a similar
  elephant-with-coffee sketch, and a bird logo called "SOLTO" the user liked
  the linework of) — 20 duck variants were designed but **not yet picked**.
  Intended eventual use: an animated brand mascot for marketing video content
  where it "talks" and explains the site — this is explicitly a *future*
  goal, not needed for the current site.
- **Do not assume the crocodile design from one intermediate round is
  correct** — that was a misunderstanding corrected immediately; the duck
  direction is the current one.

---

## 13. PENDING / KNOWN GAPS (in rough priority order)

1. **Roastery name deduplication via AI** — designed, not implemented. Plan:
   on `identify`, do the normal (cheap) call unchanged. Client-side, compare
   the returned `roastery_name` against the list of already-known roastery
   names (same list already used for the autocomplete dropdown). If it's an
   exact match, done, zero extra cost. If it's NOT an exact match, make one
   additional *cheap, text-only* call (no image) asking Claude "is this new
   name actually the same roastery as one of these known ones, written
   differently (including cross-language, e.g. Arabic vs English), or is it
   genuinely new?" — and if it matches, use the canonical stored name instead
   of creating a duplicate. Combine this with a manual merge tool in the owner
   stats dashboard as a fallback for anything the AI misses.
2. **Homepage / landing page redesign** — not started. Intended to surface
   the public stats (top searched beans, top roastery, etc.) to anonymous
   visitors, with product images the owner uploads manually for top items.
   Blocked on: finalizing the mascot/logo (section 12).
3. **Payment integration** — deferred until after accounts proved stable.
   Plan discussed: Stripe as the payment processor (handles Apple Pay too,
   avoids dealing with card data directly). Pricing model discussed: 5 free
   searches per account, then $1 per additional 10 searches. Not designed in
   detail yet — needs a real spec pass before implementation.
4. **"Share recipe" feature** (shareable link to a recipe/customization) —
   explicitly deferred until after the visual identity work is done.
5. **Privacy policy page** — flagged as a real gap before any public launch,
   not written yet.
6. **Terms/contact/support page** — not started.
7. Community-sourced recipe learning (using our own ratings/comments data to
   bias future `refine` calls toward what real users have liked for that
   specific product) — discussed as a good future direction *once* enough
   rating data accumulates; deliberately NOT wired to any external dataset.
8. Minor: `handleRefine` in `analyze.js` does not currently accept
   `cupSize`/`targetWaterMl` (only the main `recipe` mode does) — low
   priority since refine only touches sensory targets, not cup size.
9. Minor: `record.js` does not yet track `cupSize` as its own stat dimension
   (only `cupCount`) — not requested yet, flagged as easy to add later.

---

## 14. THINGS TO NOT RE-LITIGATE (already decided, with reasons)

- No email verification on signup (friction reduction) — but password reset
  DOES use email now (Resend), since that's an unavoidable need.
- No anonymous/device-based free-trial gating was ever implemented — it was
  discussed at length, explicitly deprioritized in favor of building the full
  accounts system directly.
- No "cache identical searches" optimization was implemented (discussed,
  intentionally deferred until real repeat-usage data exists to justify it).
- Comments/ratings require login, full stop — anonymous rating existed
  briefly and was removed.
- `FLUSHDB`-style wipes are dangerous on this database because accounts and
  analytics share the same Redis instance — a scoped `purge-data` action
  exists in `auth.js` (owner-only, requires `confirm: true`) that wipes
  analytics/ratings/etc. while explicitly protecting `user:`, `user_by_email:`,
  `session:`, `user_favorites:`, `favorite:`, `accounts:` key prefixes. Use
  that, never a raw flush, once real users exist.

---

## 15. HOW TO CONNECT THIS TO CLAUDE CODE FOR FAST PUSHES

See the chat reply this file was delivered alongside for step-by-step GitHub
connection instructions (installing Claude Code, cloning `coffee-site`,
authenticating with GitHub, and pushing directly instead of the old
copy-paste-into-GitHub-web-UI workflow).
