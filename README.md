# Arbiter

*(formerly StellarSage)*

A synchronous, pay-per-question human-intelligence oracle settled on
Stellar/Soroban. A client pays 0.25 USDC (or more, for a faster/higher-confidence
tier) to `/oracle`, the question is broadcast to online human workers over
SSE, a quorum of answers is reconciled into one consensus, and matching
workers are paid automatically on-chain in the same call — or the entire
payment is refunded if consensus can't be reached. The system is designed to
**fail closed**: every code path ends in a real on-chain `resolve()` or
`refund()`, and now, even if the backend itself goes down, the contract's own
permissionless timeout refund guarantees payers are never permanently stuck.

This is a reengineered build of the original StellarSage spec, built across
four rounds — five workflow improvements, four more aimed at friction and
unit economics, thirteen fixes from a structured pressure test, and five
more starting from actual customer journeys and working backward to the
tech — each integrated end-to-end (contract → backend → frontend → demo
tooling → landing page), not just described.

## What changed, and why

**1. Async job-based `/oracle` instead of a blocking HTTP request**
The original design held the client's HTTP connection open for up to
`QUORUM_TIMEOUT_MS` (45s) while humans answered — fragile against proxies,
mobile networks, and serverless/edge request timeouts. `POST /oracle`'s
second step now returns `202` immediately once payment is confirmed
on-chain, and the caller polls `GET /oracle/:jobId` for the result.
See `backend/src/jobs.js`, `backend/src/oracle.js`.

**2. A permissionless `refund_timeout()` escape hatch in the contract itself**
v1's design made the platform's admin key the *sole* authority able to
settle (`resolve`/`refund`) escrowed funds — a liveness risk if the backend
is down or misbehaving. The contract now stores a `timeout_ledgers` window
(set at `initialize()`) after which **anyone** — no `require_auth()` at all —
can force a full refund on a still-`Pending` question. See
`contracts/oracle-escrow/src/lib.rs::refund_timeout` and its test coverage in
`src/test.rs` (before/at/after deadline, rejected once resolved, permissionless
by construction). `demo-agent/sponsored-demo.js` proves this on real testnet
when run with `PROVE_TIMEOUT_REFUND=true`.

**3. Storage abstraction — Redis-ready, in-memory by default**
`pendingQuestions`/job state/worker reputation/rate limits now go through
`backend/src/store.js`, which uses Redis when `REDIS_URL` is set (so state
survives restarts and can be shared across instances) and transparently
falls back to an in-memory `Map` otherwise. The live SSE worker registry and
per-question quorum collector in `dispatch.js` remain intentionally
process-local (they hold open sockets/timers) — see the comment at the top
of `store.js` for what a full multi-instance rollout would still need
(pub/sub fan-out).

**4. Reconciliation fast path — skip the Claude call when there's nothing to reconcile**
`reconcile.js` first runs a deterministic exact-match vote; if every worker's
answer normalizes identically, it returns immediately with
`method: 'exact-match-fastpath'` and confidence 1 — no LLM call, no added
latency or cost. Claude is only invoked when there's genuine disagreement or
paraphrasing to adjudicate, with the same deterministic vote as a fallback if
Claude errors or isn't configured. Verified in `backend/test/reconcile.test.js`.

**5. Pricing tiers + worker category routing + anti-sybil measures**
The contract was always tier-agnostic (`submit()` takes an arbitrary `i128`);
v1's flat $0.25 price was purely a backend policy gap. `backend/src/pricing.js`
now offers `standard`/`express`/`priority` tiers trading price for quorum
size and timeout. Workers can declare topic categories on connect
(`dispatch.js`), and questions route to matching specialists first, failing
open to everyone if no one matches. Two independent anti-sybil guards:
per-IP SSE connection rate limiting, and a reputation gate that quietly
excludes workers whose answers rarely match consensus once they have a
meaningful sample — both fail open rather than ever routing a question to
zero recipients. Verified in `backend/test/dispatch.test.js`.

## Round 2 — friction and unit economics

A second pass, aimed at "what would Jobs and Musk change": strip friction
from the interface, and attack the physics of settlement and pricing
directly rather than paper over them.

**6. On-chain worker staking + slashing**
Workers may now post an optional USDC bond (`stake()`/`unstake()`/`get_stake()`
in the contract). It is opt-in and punitive-only — a worker who never
stakes is never slashed, and staking is not a gate on participation (that
would require an on-chain read on every dispatch decision). When `resolve()`
runs, every losing worker (submitted an answer, didn't match consensus)
forfeits `SLASH_BPS` (5%) of their *current stake*, capped at whatever they
actually have, to the platform — in the same transaction as the fee, so
slashing can never make `resolve()` fail. This moves worker credibility from
a purely backend-owned heuristic (the reputation gate from round 1) toward
an on-chain economic fact the backend can't quietly override. See
`contracts/oracle-escrow/src/lib.rs::stake/unstake/resolve`, tests in
`src/test.rs`.

**7. Accrued-balance ("streaming") settlement instead of a transfer per worker**
`resolve()` no longer transfers USDC to each matching worker directly — it
credits an `Owed` balance instead (`get_owed()`), which a worker collects in
one `withdraw()` call whenever they choose. A worker who answers 50
questions before cashing out pays one network fee, not 50, and the contract
does 1 token transfer per `resolve()` (to the platform) instead of `N + 1`.
This is also what makes the worker's income feel like a live-accruing
balance rather than N discrete payment events. See
`lib.rs::withdraw/get_owed`, `demo-agent/worker-sim.js`'s `AUTO_WITHDRAW`
mode, which periodically sweeps accrued earnings into a single withdrawal.

**8. Live surge pricing instead of three fixed tier prices**
`pricing.js`'s tiers now set a *base* price; `priceForTier(tier, onlineWorkers)`
scales it by a multiplier that rises smoothly (capped at 2x, floored at 1x —
no discounts) as online worker supply gets scarce relative to the tier's
quorum size, the same way Uber/Supercharger pricing treats price as a
real-time control signal instead of a fixed sticker. The price is snapshotted
at `issueChallenge()` time and stashed alongside the question — payment
verification and the `/sponsor/pay` fee-bump both check against that
snapshot, never a freshly recomputed price, so a payer's quote can't move
out from under them between quote and payment. Verified in
`backend/test/pricing.test.js`.

**9. A non-custodial "quick start" wallet, alongside wallet-connect**
The worker app's biggest friction point was the extension-install step
before a wallet-connect modal even opens. Rather than building a first-party
*custodial* embedded wallet (Coinbase-Smart-Wallet-style) — which would trade
that friction for real custody and regulatory surface — `app/src/localWallet.js`
generates a keypair in the browser and holds the secret in `localStorage`.
Same non-custodial trust model as an extension (only the user holds the
key), zero install, zero XLM required, and it implements the exact same
`{getAddress, signTransaction}` shape `StellarWalletsKit` does, so the rest
of the app doesn't know or care which one is active. The disclosed tradeoff:
no hardware backing, so it's vulnerable to an XSS bug in a way a real
extension wallet isn't — appropriate for quick-start/demo use, not a
replacement for real wallet support.

## Round 3 — pressure-test fixes

A structured audit of rounds 1–2 (not just re-reading my own roadmap notes —
actually tracing exploit mechanisms and confirming behavior against the
code) turned up 13 real issues, critical to low priority. All are fixed.

**Critical**

- **Surge pricing was gameable for free.** `onlineWorkerCount()` was the
  live SSE connection count — free and instant to manipulate. A worker
  cartel could disconnect right before a question, spike the multiplier,
  then reconnect to answer and split the inflated pool. Fixed:
  `dispatch.js` now samples worker count every 5s into a 60s trailing
  window; `getSmoothedOnlineWorkerCount()` averages it, so gaming the price
  now costs real, sustained downtime instead of an instant toggle. Pure
  averaging math factored into `computeSmoothedCount()` for testability.
- **No rate limiting beyond the SSE endpoint**, while `/sponsor/*` spends a
  real network fee per call. Fixed: `rateLimit.js` is a generic, store-backed
  limiter now applied to `POST /oracle` and every `/sponsor/*` route (config
  in `config.rateLimits`), on top of the existing SSE connection limit.
- **Single admin key had no rotation path**, and compromise meant the
  attacker could `resolve()` any pending question naming themselves as the
  worker — full drain, not just delayed settlement. Fixed: `set_admin()`
  lets the current admin rotate to a new key. This doesn't shrink the
  blast radius of an *active* compromise (a stolen key can still act until
  someone with continued access rotates it away) — it just means "lost the
  key" no longer means "this contract is stuck forever."
- **The reconciliation fast path could rubber-stamp a coordinated sybil
  ring's unanimous wrong answer** with zero scrutiny. Fixed: the fast path
  now additionally requires every matching worker to be
  reputation-*established* (`isEstablishedWorker`, ≥5 prior answers by
  default) — a fresh identity forces the Claude/fallback path even on
  perfect agreement. Raises the cost of the attack (must build reputation
  first); does not eliminate it for a sufficiently patient attacker.
- **Horizontal scaling without Redis risked colliding question ids**,
  which fails a real payer's `submit()` on-chain, not just in memory.
  Fixed: `pendingQuestions.js` mints ids as `(random 32-bit process
  salt << 32) | sequence`, so two memory-only instances would need to
  independently roll the same salt to collide.
- **`refund_timeout()` racing a legitimate `resolve()`** meant a payer could
  claw back money for work already done. Not eliminated — permissionless
  means permissionless, that's the fail-safe's entire point — but
  `oracle.js` now re-checks on-chain state after a `resolve()` failure and
  tags the outcome `lost_race_to_timeout_refund` distinctly instead of
  burying it in generic error logs, so how often it actually happens is
  now observable.

**Medium**

- **No length limits on `question`/`answer`** — fixed with
  `MAX_QUESTION_LENGTH`/`MAX_ANSWER_LENGTH` (400s on `POST /oracle` and
  `POST /app/answer`).
- **`localWallet.js` had no export/backup path**, and this wallet holds real
  staked USDC and accrued earnings — clearing localStorage meant permanent,
  silent fund loss. Fixed: a dedicated "back up your key" panel with
  reveal/copy, strong warning copy, shown whenever quick-start is active.
- **`resolve()` didn't validate `workers`/`losing_workers` for
  overlap or duplicates** — a backend bug could credit and slash the same
  worker in one call. Fixed: `validate_worker_lists()` rejects any overlap
  or in-list duplicate with a new `InvalidWorkerLists` error, before any
  storage mutation.
- **CORS was wide open** with no rate limiting to compensate. Fixed:
  `ALLOWED_ORIGINS` config (defaults to `*` for local dev, lockable per
  deployment) plus the rate limiting above.

**Lower priority**

- Category matching was exact-string/case-sensitive — fixed with
  normalization (trim + lowercase) in `dispatch.js`, applied uniformly at
  both worker-registration and question-routing time.
- A user clicking "Connect wallet" and "Quick start" together could tear
  `state.activeWallet`/`state.address` — fixed with a busy-guard disabling
  both buttons the instant either is clicked.
- `TimeoutLedgers` was immutable post-`initialize()` — fixed with
  `set_timeout_ledgers()`, but carefully: the contract snapshots
  `timeout_ledgers` into each `Question` at `submit()` time rather than
  reading the live global value at `refund_timeout()` time. Naively making
  it mutable without that snapshot would have let a malicious/compromised
  admin retroactively push out the deadline on an already-pending question
  — defeating the whole point of the permissionless escape hatch. Regression
  test: `set_timeout_ledgers_does_not_affect_an_already_pending_question`.

**A bug found along the way, unrelated to the pressure-test list**:
writing a concurrency test for the new `nextQuestionId()` salting exposed
that `MemoryStore.incr()` wasn't actually atomic — `await this.get()`
followed by `await this.set()` gave concurrent callers a window to both
read the same stale value. Fixed by making the read-modify-write
synchronous inside the (still-`async`-declared) function, relying on JS's
run-to-completion guarantee for the non-awaiting portion. This was already
capable of undercounting rate limits and reputation stats under real
concurrent load, not just in the new test.

## Round 4 — working backward from customer experience

Rounds 1–3 were all internal (workflow, economics, security). This round
started from three actual people — the developer integrating the API, the
worker answering questions, and the payer wanting to see their own
history — and worked backward to what each one's journey actually breaks
on today. Five changes, in the priority order that came out of that
exercise.

**1. Sandbox mode — the single highest-leverage fix for evaluation**
The biggest drop-off point for a prospective integrator was never the API
design — it was everything *before* they could see a response: get a
Stellar wallet, find a testnet USDC faucet, understand `submit()`/signing,
*then* finally see what a resolved answer looks like. `POST /oracle/sandbox`
collapses that to one call: no payment, no chain, no LLM cost. It reuses
the real `exactMatchVote()` grouping logic (not reinvented) so the shape and
behavior genuinely matches production, and every response is unambiguously
tagged `sandbox: true` with `SANDBOX-`-prefixed fake tx hashes so nothing
here can be mistaken for a real settlement. Sandbox settlements are
deliberately excluded from the platform-wide `/stats` counters (see #2) —
mixing simulated traffic into a trust-building number would make it
meaningless. The landing page's hero CTA ("Ask a question live") now opens
a real interactive widget against this endpoint — verified live in a
browser against a running backend, including the honest failure state when
no backend is reachable. See `backend/src/sandbox.js`,
`demo-agent/sandbox-ask.js`, `landing/index.html`'s `#try-it-now` section.

**2. Worker earnings transparency**
Reputation and accrued-balance data already existed — they drove the
reputation gate and the reconciliation fast path internally — but a worker
could never see their *own* track record. `GET /workers/:address/reputation`
surfaces it directly into the console's earnings panel ("14/17 answers
matched consensus"). A new `GET /stats` endpoint (real settlements only,
never sandbox) feeds a live activity line into the landing page's trust
strip as a progressive enhancement — present when a backend is reachable,
silently absent otherwise, never a broken placeholder.

**3. Push notifications for workers — a supplement, not a fix**
The console requires an open browser tab to receive dispatch — an income
stream that needs babysitting isn't really passive. Web Push (VAPID,
`web-push`, a service worker) lets an offline-but-subscribed worker get
notified for a *matching* question. The honest limit, encoded directly in
the send logic, not just a comment: a push round-trip (deliver → notice →
tap → app loads) realistically takes several seconds, so it's skipped
entirely below `PUSH_MIN_TIMEOUT_MS` (default 20s) — the `express` tier's
12s window stays tab-only by design, because notifying for a window that's
already closed by the time anyone could act on it would be worse than not
notifying at all. Verified live up to the edge of what this environment can
prove: the service worker installs and activates in a real headless
browser, and the subscribe flow correctly reaches native
`pushManager.subscribe()` before failing on two well-documented Chromium
infrastructure limits (incognito contexts block the Push API outright;
open-source Chromium builds lack the API key needed to reach Google's push
service) — neither is a bug in this code, both are properties of the test
environment. See `backend/src/push.js`, `app/public/sw.js`.

**4. A buyer dashboard, keyed by wallet address, not an account system**
Payers are otherwise anonymous to this API by design — no signup, no API
key — until they sign a real `submit()` on-chain. Building a dashboard
meant respecting that rather than bolting on accounts: `payerIndex.js`
records `payerAddress → [questionIds]` the moment a payment is verified,
and `dashboard.html` reuses the exact same wallet-connect/quick-start
pattern the worker console already has. Spend tracking here is
*informational*, not enforced — a hard pre-payment spending cap would need
payer identity to exist *before* the first payment, which breaks the
anonymous-by-default flow; flagged as a real follow-up, not silently
half-built. Verified live: connect, empty-state render, and the aggregation
math (spend sum, success rate, filtering expired/null job records) is unit
tested directly via `summarizePayerQuestions()`.

**5. Positioning: developer-first, by explicit decision**
The UX pass surfaced a real fork — everything built so far assumes a
developer sits between Arbiter and whoever wants an answer, but a
non-technical "just ask" consumer product was never ruled out, just never
decided. The call: stay developer-first. Every surface built across all
four rounds — code-sample hero, pricing tiers, sandbox mode, the buyer
dashboard's wallet-first design — is developer/integrator-facing content;
retrofitting a consumer front door onto it would dilute both instead of
serving either well. A consumer product remains a legitimate *separate*
bet, not a rejected one — see the roadmap below.

## Architecture

```
app/ (Vite SPA)         demo-agent/ (headless scripts)
 wallet-connect OR            │ HTTP + raw signing
 local quick-start key        │
      │ HTTP + SSE            │
      ▼                       ▼
            backend (Express, Node)
  server.js → oracle.js → dispatch.js / reconcile.js
        stellarClient.js · sponsor.js · store.js · pricing.js
      │ admin-signed    │ worker-signed, fee-bumped  │ read-only sim
      │ resolve/refund  │ submit/stake/withdraw      │ get_question/
      ▼                 ▼                            │ get_owed/get_stake
  oracle-escrow (Soroban)                             ▼
  submit / resolve / refund / refund_timeout /   Claude (Anthropic,
  stake / unstake / withdraw /                   tool-forced report_consensus,
  get_question / get_owed / get_stake            skipped on exact-match)
      │ token::Client::transfer
      ▼
  USDC (Stellar Asset Contract)
```

`sandbox.js` (question-in, job-out) and `push.js` (broadcast → offline
workers) hang off the same `server.js`/`dispatch.js` core shown above but
deliberately never touch the chain/Claude column — see round 4 for why.
`stats.js` and `payerIndex.js` are thin read-side additions over the
existing `jobs.js` store.

## Repo layout

```
arbiter/
├── Cargo.toml                    # workspace: contracts/oracle-escrow
├── contracts/oracle-escrow/      # Soroban contract + tests (38 tests)
├── backend/                      # Express oracle service
│   ├── src/{server,oracle,jobs,dispatch,reconcile,
│   │         pendingQuestions,pricing,sponsor,stellarClient,
│   │         store,rateLimit,sandbox,push,stats,payerIndex,config}.js
│   └── test/{dispatch,reconcile,pricing,sponsor,pendingQuestions,
│              rateLimit,server,sandbox,push,stats,payerIndex}.test.js  (75 tests)
├── app/                          # Vite worker console + buyer dashboard (multi-page)
│   ├── index.html                # worker console
│   ├── dashboard.html            # read-only buyer dashboard
│   ├── public/{manifest.json,sw.js}
│   └── src/{main,dashboard,localWallet,contractCalls,units,style}.{js,css}
├── landing/                      # marketing site + live "try it now" sandbox widget
├── demo-agent/                   # headless buyer/worker/proof scripts (+ sandbox-ask.js)
└── e2e/                          # browser click-through harness (stubbed, see e2e/README.md)
```

## Running it

```sh
# Contract — 38 tests, no chain needed
cargo test -p oracle-escrow

# Backend — 75 tests, no chain needed (spawns real ephemeral server
# processes for the rate-limit/CORS/push/sandbox integration tests, still
# no chain access)
cd backend && npm install && npm test
cp .env.example .env   # fill in ORACLE_CONTRACT_ID / PLATFORM_SECRET etc. for real use
# optional — enables push notifications:
node -e "console.log(require('web-push').generateVAPIDKeys())"   # paste into .env
npm start

# Try it immediately with zero setup — no wallet, no chain, no .env needed:
curl -X POST localhost:4000/oracle/sandbox -d '{"question":"test"}' -H 'Content-Type: application/json'

# Frontend — worker console (index.html) + buyer dashboard (dashboard.html), multi-page build
cd app && npm install && cp .env.example .env && npm run dev    # or: npm run build

# Landing page (static — open landing/index.html directly, or serve it)
cd landing && python3 -m http.server 8123   # then visit /#try-it-now against a running backend

# Demo scripts (need a deployed contract + funded testnet keys, EXCEPT sandbox-ask.js)
cd demo-agent && npm install
cp .env.example .env
node sandbox-ask.js "What year did Stellar launch?"   # zero setup, no wallet needed
node ask.js "What is the capital of France?"
WORKER_ID=w1 WORKER_ANSWER=Paris node worker-sim.js
# staking + auto-withdraw demo (needs a funded WORKER_SECRET):
WORKER_SECRET=S... DO_STAKE=true AUTO_WITHDRAW=true node worker-sim.js
node sponsored-demo.js
PROVE_TIMEOUT_REFUND=true node sponsored-demo.js   # takes ~timeout_ledgers × 5s on testnet
```

## What's actually verified vs. what isn't

Verified in this environment:
- Contract: all 38 unit tests pass via `cargo test` — staking, slashing
  (including the "unstaked loser is a harmless no-op" edge case),
  accrued-balance withdraw (including multi-question accumulation before a
  single payout), admin rotation, the timeout-snapshot regression test
  (proving `set_timeout_ledgers()` can't retroactively extend a pending
  question's deadline), and worker-list overlap/duplicate rejection.
- Backend: all 75 unit + integration tests pass, including sandbox mode
  (deterministic outcome-simulation for all three modes, isolation from
  real `/stats` counters proven directly, not just asserted), push
  notification subscription CRUD and category-eligibility filtering
  (`notifyWorker` proven not to throw even against an unreachable push
  endpoint), and `payerIndex.js`'s aggregation math.
- Frontend: `vite build` succeeds for the now-multi-page app (worker
  console + buyer dashboard sharing a code-split vendor chunk) and for the
  landing page.
- **Live, not just unit-tested**, via a real headless browser against a real
  running backend: the sandbox "try it now" widget end to end, including
  its honest network-failure state; the buyer dashboard's connect → fetch →
  render path; the service worker's install/activate lifecycle; and the
  push subscribe flow up to two well-documented Chromium infrastructure
  limits (incognito blocks the Push API outright; open-source Chromium
  lacks the API key real Google Chrome has for reaching its push service) —
  confirmed to be environment properties, not bugs, by reproducing both
  with distinct, expected error messages.
- All `stellarClient.js`/`sponsor.js` calls (including all three fee-bump
  security checks' byte-for-byte XDR comparisons) were validated against the
  actually installed `@stellar/stellar-sdk`, not just written from memory —
  e.g. `StrKey.encodeContract()` was used to mint a valid fake contract id
  so the security-check tests could run without a live deployment.

Not verified here, because this environment has no `stellar`/`soroban` CLI,
no deployed contract, and no Redis instance:
- An actual testnet deployment and `initialize()` call.
- The full `/oracle` → payment → dispatch → reconcile → settle path end to end
  against a live chain (`oracle.js`'s chain-touching branches are exercised
  by unit tests only up to the point where a real RPC call would be made) —
  sandbox mode's parallel path IS fully verified live, precisely because it
  was built not to need a chain.
- Redis-backed `store.js` (the in-memory fallback path is what's been run).
- Real push notification *delivery* (subscribe mechanics are verified; an
  actual server → push service → device round trip needs real Chrome with a
  Google API key, which this environment doesn't have).
- A real headless-browser wallet-connect *extension* click-through (`e2e/`
  is stubbed; the local quick-start wallet path IS covered live since it
  needs no extension).

## Carried-forward roadmap (not addressed by this reengineering pass)

Genuine design tensions the pressure test surfaced that don't have a clean
code fix — worth a real conversation, not a patch:

- **The trust model checks agreement, not truth.** Nothing verifies an
  answer is *correct*, only that enough workers said the same thing. The
  established-worker fast-path gate (round 3) and the reputation/rate-limit
  guards (round 1) raise the cost of a coordinated sybil ring dictating
  consensus; none of them structurally prevent it, because identity is
  cheap on Stellar and our own zero-XLM sponsorship makes it cheaper still.
- **A compromised admin key can still drain funds for as long as it stays
  compromised.** `set_admin()` (round 3) means "lost the key" is now
  recoverable, but it's a rotation, not a kill switch — there's no way to
  freeze the contract the instant a compromise is *suspected* but the new
  key isn't ready yet.
- **`refund_timeout()` vs. a legitimate `resolve()` is a real race by
  design.** Round 3 added observability (`lost_race_to_timeout_refund`),
  not prevention — permissionless means anyone can win that race, including
  a payer trying to avoid paying for completed work.

Smaller, more mechanical follow-ups:

- Multi-instance pub/sub fan-out so dispatch works behind a load balancer
  (flagged directly in `store.js`).
- Slashed stake currently goes entirely to the platform; redistributing some
  of it to the matching workers who *did* answer correctly (instead of only
  the platform capturing it) would sharpen the staking incentive further.
- Staking is punitive-only, not a participation gate — a sybil worker with
  zero stake still routes and answers normally, just isn't slashed. Gating
  participation on stake would need a cheap on-chain read at dispatch time,
  which the current design deliberately avoids for latency reasons.
- `resolve()` still settles one question per call; batching several
  questions' worth of fee/slash bookkeeping into one transaction would cut
  chain overhead further at high volume, the same way `withdraw()` already
  batches a worker's payouts.
- The frontend bundle is ~1.4MB (unminified stellar-sdk pulled in for
  client-side stake/withdraw tx building) — code-splitting it behind a
  dynamic `import()` would help first-paint time.
- Structured logging with tx-hash correlation ids; alert on refund-rate anomalies.
- Mainnet cutover: swap network passphrase/RPC URLs/USDC issuer, independent
  contract audit, load-test concurrent dispatch.
- Wire `e2e/` into CI once implemented.
- `app/public/manifest.json` ships with empty `icons` — needs real PNG
  assets at standard sizes before "Add to Home Screen" looks finished (the
  manifest and service worker are otherwise fully functional without them).
- A non-technical, consumer-facing "just ask" front door was explicitly
  named and explicitly deferred (round 4, #5) — worth revisiting once the
  developer-first bet has enough signal to justify a second front door.
- Buyer spend tracking is informational only, not an enforced cap — a real
  pre-payment spending limit needs payer identity to exist before the first
  payment, which is a bigger, separate departure from the current
  anonymous-by-default flow.
