# SCF #45 RFP: x402 Facilitator with Bazaar Discovery Support

Draft submission sketch. Target: SCF Interest form → Build form, window closes August 17.

## One-line pitch

Build the reference x402 payment facilitator and Bazaar discovery layer for
Stellar/Soroban, proven against two live integrations that exercise both
required settlement schemes — Arbiter (`exact`, already deployed on testnet)
and a new metered micro-API (`upto`, the scheme this RFP asks us to spec for
Stellar for the first time).

## The existing baseline: OZ Channels

Stellar already has a working, production x402 facilitator: **OZ Channels**
(OpenZeppelin), reachable at `channels.openzeppelin.com/x402` (mainnet) /
`/testnet` (testnet), with client/server libraries already published as
`@x402/stellar`, `@x402/express`, `@x402/fetch`, `@x402/core`. It implements
`/verify` + `/settle` + `/supported`, the `exact-v2` scheme, and sponsors
network fees so buyer wallets need zero XLM.

That's real, working infrastructure — we are not re-solving a solved problem.
And it goes one step further than the hosted service: OpenZeppelin has also
published an **open-source, self-hosted x402 facilitator plugin** for
Stellar's `exact` scheme, as a working example inside their
[`openzeppelin-relayer`](https://github.com/OpenZeppelin/openzeppelin-relayer)
repo (`examples/x402-facilitator-plugin`) — a functional `/verify` +
`/settle` + `/supported` implementation you can run against your own relayer
account, no `OZ_API_KEY` required. So "does a self-hosted facilitator exist
at all" is no longer the open question — it's closer to solved than we
initially scoped it. **We should say this plainly in the submission; SCF
reviewers likely already know it exists, and presenting it as an open gap
would read as either uninformed or evasive.**

What's still genuinely missing, precisely:

- **A *permissively*-licensed option.** `openzeppelin-relayer` — and
  therefore that example plugin — is **AGPL-3.0**. AGPL is OSI-approved, but
  it is not permissive: it carries network-use copyleft obligations that a
  real slice of companies who'd want to embed or fork a payment facilitator
  into their own stack cannot or will not take on. The RFP's own wording —
  "Permissive OSI Approved License for self-hosting capability" — reads as
  deliberately distinct from "any OSI license," and this is the gap that
  distinction points at. Note this also means we can't shortcut by forking
  or relicensing their code — AGPL doesn't permit that. Our facilitator
  needs to be an independent implementation, clean-room against the public
  x402 wire protocol and the `@x402/stellar` package interfaces, not a
  derivative of OpenZeppelin's AGPL source. That's more work, but it's the
  only honest way to ship something under Apache-2.0/MIT.
- **`exact` scheme only, everywhere.** No `upto` (pay-up-to-a-cap,
  settle-actual-after) scheme exists in the ecosystem yet — not in OZ
  Channels, not in the AGPL plugin, not anywhere we could find. Confirmed by
  searching OpenZeppelin's relayer repo directly: zero references to `upto`.
- **No discovery layer, anywhere.** Same check for "bazaar" and "discovery"
  against that repo turned up nothing resembling a resource catalog or
  NL-search layer. This part of the RFP is genuinely greenfield.

So the proposal is precise, and slightly narrower than our first draft: build
a permissively-licensed, independently-implemented facilitator that speaks
the same wire protocol as OZ Channels and the existing AGPL plugin
(`@x402/stellar`'s `HTTPFacilitatorClient` interface, `exact-v2` scheme) so
existing x402 sellers/buyers can point `FACILITATOR_URL` at ours with
**zero code changes** — and then build the two pieces that don't exist under
*any* license yet: the `upto` scheme and Bazaar discovery.

## Why us

We're not proposing this from a standing start. Arbiter is a live,
Soroban-settled pay-per-request service, deployed and exercised end to end on
testnet:

- A fail-closed escrow contract (38 tests) — every path ends in a real
  `resolve()`/`refund()`, plus a permissionless `refund_timeout()` so a
  payer can never be permanently stuck even if the settling party goes dark.
- Auth-entry-based payment flows already in production use, not pre-signed
  transactions — the exact primitive this RFP calls out as a technical
  consideration.
- A sponsored, non-custodial quick-start wallet already proven live: a
  keypair that has never held a stroop of XLM can open a trustline, pay,
  and get settled, entirely fee-sponsored (`demo-agent/sponsored-demo.js`).
  This *is* the RFP's "fee sponsorship so buyers need only payment assets"
  requirement, already shipped.
- A retry/timeout-hardened Stellar RPC client, structured logging, and CI —
  i.e., the operational maturity a shared piece of payment infrastructure
  needs, not just a demo.

The gap: no prior x402-specific track record, and the `upto` scheme has no
Stellar spec yet — nobody's does. That's genuinely new design work, which is
exactly why we're proposing to do it in the open as part of this RFP rather
than presenting it as already solved.

## What we'd build

### 1. The facilitator (core deliverable)

An **Apache-2.0**, self-hostable service implementing the required surface —
independently written against the public x402 wire protocol and
`@x402/stellar`'s interfaces (not derived from OpenZeppelin's AGPL example,
for the licensing reasons above):

- `POST /verify` — validate a payment payload against a resource's stated
  requirements without settling (lets a resource server fail fast on a bad
  payment before doing any work).
- `POST /settle` — submit the verified payment on-chain and return the
  transaction result.
- `GET /supported` — advertise which schemes/assets/networks this
  facilitator instance handles.
- Implements `HTTPFacilitatorClient`'s expected interface from `@x402/core`
  so it's a **drop-in `FACILITATOR_URL` swap** for OZ Channels — an existing
  x402 server built with `@x402/express` + `ExactStellarScheme` works
  against us unmodified, just pointed at a different URL and without an
  `OZ_API_KEY`. Compatibility with the standard packages, not a fork of
  them, is the whole point — this is what makes it a genuine alternative
  rather than a competing, incompatible ecosystem.
- **`exact` scheme**: fixed-price-per-call, already well understood —
  Arbiter's own `/oracle` pricing (base price × surge multiplier, quoted
  then paid in full) is a real, non-trivial exercise of this scheme,
  since the "exact" amount is computed dynamically per request rather
  than hardcoded.
- **`upto` scheme (new)**: pay-up-to-a-cap, settle-actual-cost-after —
  needed for metered work where the final cost isn't known until the
  call completes (token-metered LLM calls, variable-effort compute).
  We'd author `scheme_upto_stellar.md` and upstream it, using our second
  reference integration as the concrete test case that keeps the spec
  honest against a real settlement flow rather than a theoretical one.
- Soroban-specific handling throughout: ledger-based expiration via
  `signatureExpirationLedger` instead of wall-clock deadlines, SEP-41
  trustline checks before attempting settlement, and resource-limit-aware
  batching so facilitator throughput doesn't fall over under real agent
  traffic.

**Security considerations specific to what a facilitator actually is** — an
off-chain service that assembles and submits Soroban transactions from
client-signed auth entries. That shape maps directly onto documented
Soroban failure classes, worth naming rather than discovering during the
RFP's required security review:
- *Auth-entry/transaction mismatch.* `/settle` must build the exact
  transaction implied by the resource's stated payment requirements
  (contract, amount, recipient) — never a client-suppliable shape. A signed
  auth entry authorizes a specific transfer; the facilitator substituting a
  different one it happens to also hold access to is the off-chain analog
  of the "auth replay through middleware" bug class.
- *Verify/settle race.* The two are separate calls; state (balance,
  trustline, an already-consumed nonce) can change between them. `/settle`
  re-validates against current chain state immediately before submission
  rather than trusting a `/verify` result that may be stale.
- *Fee-griefing.* Because the facilitator (not the client) pays network
  fees, unbounded `/verify` or repeated failed `/settle` calls are a way to
  drain the facilitator's fee account — a real DoS surface fee-sponsored
  services don't have without sponsorship. Needs the same bounded-retry,
  rate-limited posture Arbiter already applies to its own external calls.
- *Non-USDC SEP-41 assets.* "Any SEP-41 token works" (per existing x402
  Stellar docs) needs the standard token-consumer checklist applied: query
  decimals rather than assuming 7, re-check received amount after transfer
  for non-standard/fee-on-transfer tokens, and handle `AUTH_REQUIRED`/
  frozen/clawback-enabled issuers without silently misreporting settlement
  as successful.

### 2. Bazaar discovery layer

- `GET /discovery/resources` — catalog of known x402-payable resources,
  populated automatically from payment payloads the facilitator observes
  (no manual registration step required for a resource to become
  discoverable).
- `GET /discovery/search` — natural-language search over that catalog
  ("find a service that answers factual questions") returning resource +
  price + how-to-pay, so an agent can go from intent to a completed
  payment without a hardcoded integration.
- An MCP discovery server exposing search/quote/pay as first-class MCP
  tools, so an agent framework gets discovery "for free" the same way it
  gets any other tool.

### 3. Two reference integrations

**Arbiter — `exact` scheme, already live.**
Retrofit `/oracle` to speak x402 natively, concretely: swap the backend's
hand-rolled Soroban payment verification (`stellarClient.verifyPayment`) for
`@x402/express`'s `paymentMiddleware` + `HTTPFacilitatorClient`, pointed at
our facilitator instead of OZ Channels. Because we're wire-compatible, this
is a real, mechanical proof of the "drop-in" claim, not just an assertion —
and it's real dogfooding: if the facilitator can't handle Arbiter's dynamic
surge-priced `exact` payments under its own staking/quorum/reconciliation
logic, that's a design bug worth finding before anyone else hits it. We'd
also run the same conformance check the other direction — Arbiter's
existing flow tested against OZ Channels first as a baseline, then against
ours, to prove parity before claiming it.

**Second integration — `upto` scheme, new, deliberately different domain.**
A small metered API (e.g., pay-up-to-$0.05 per LLM completion, settle the
actual token cost once the response is generated) — intentionally *not*
another Arbiter-shaped service, so the facilitator and the `upto` spec are
proven to generalize beyond one team's own product rather than being
quietly Arbiter-shaped underneath.

## Rough scope & timeline (90-day tranches, matching SCF's cadence)

**Tranche 1 (days 0–90) — core facilitator, testnet**
- `/verify`, `/settle`, `/supported`, `exact-v2` scheme, testnet deployment,
  Apache-2.0, independently implemented (not derived from OpenZeppelin's
  AGPL example plugin)
- Conformance check, three-way: an unmodified `@x402/express` +
  `ExactStellarScheme` server works against our facilitator with only
  `FACILITATOR_URL` changed — validated against OZ Channels (hosted) and
  OpenZeppelin's AGPL plugin (self-hosted) as the two known-good reference
  behaviors, then against ours
- Arbiter retrofitted to consume the facilitator on testnet (parity-tested
  against OZ Channels first, then ours)
- `scheme_upto_stellar.md` draft v0, circulated for early feedback

**Tranche 2 (days 90–180) — `upto` scheme + discovery, mainnet facilitator**
- `upto` scheme finalized and upstreamed
- Second reference integration built and exercising `upto` end to end
- Bazaar `/discovery/resources` + `/discovery/search` on testnet
- Facilitator mainnet deployment (both schemes)

**Tranche 3 (days 180–270) — discovery for agents, hardening, launch**
- MCP discovery server
- SDK helpers + role-based developer guide
- Independent security review, findings resolved
- Both reference integrations live on mainnet
- Public conformance suite + telemetry dashboard; success measured by
  wire-level conformance against unmodified canonical x402 clients and
  developer time-to-integration under one hour

## Open risks to name upfront in the submission

- No prior x402-specific shipped work — mitigated by concrete Soroban
  payment-infrastructure evidence (Arbiter) rather than claims, and by
  targeting wire-compatibility with the existing `@x402/stellar` packages
  rather than inventing a parallel protocol.
- OZ Channels is a credible, funded incumbent (OpenZeppelin) — we should be
  explicit that we're proposing the open/self-hostable complement to it, not
  a claim that it's inadequate.
- OpenZeppelin has *already* shipped a working, self-hosted, open-source
  (AGPL-3.0) facilitator plugin for the `exact` scheme. We should state this
  ourselves in the submission rather than let a reviewer catch the omission
  — the differentiated ask is specifically the *permissive*-license gap
  (AGPL's copyleft is real friction for a class of self-hosters) plus `upto`
  and Bazaar, neither of which exist under any license yet. This is a
  narrower, more defensible claim than "no self-hosted option exists," and
  it's the honest one.
- Because we can't derive from AGPL source, the facilitator core is a
  clean-room implementation against the public protocol/package interfaces.
  That's a real scope cost worth pricing into Tranche 1, not something to
  wave past.
- `upto` scheme design is genuinely unsolved for Stellar; timeline assumes
  early engagement with the x402 spec maintainers during Tranche 1, not a
  solo design done in isolation.
- Second reference integration's exact domain isn't picked yet — needs to
  be simple enough to ship inside Tranche 2 but different enough from
  Arbiter to prove generality. Worth deciding early since it's on the
  critical path for the `upto` spec.
