import 'dotenv/config';
import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE, Horizon } from '@stellar/stellar-sdk';
import {
  env,
  buildSignedSubmitXdr,
  callRefundTimeoutPermissionless,
  explorerTxLink,
  getLatestLedgerSequence,
  sleep,
} from './lib/stellar.js';

const PROVE_TIMEOUT_REFUND = process.env.PROVE_TIMEOUT_REFUND === 'true';

const horizon = new Horizon.Server(env.horizonUrl, { allowHttp: env.horizonUrl.startsWith('http://') });

async function postOracle(body, headers = {}) {
  const res = await fetch(`${env.backendUrl}/oracle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function pollJob(jobId, { intervalMs = 2000, timeoutMs = 120_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${env.backendUrl}/oracle/${jobId}`);
    const job = await res.json();
    if (job.status === 'settled') return job;
    await sleep(intervalMs);
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

async function nativeXlmBalance(address) {
  const res = await fetch(`${env.horizonUrl}/accounts/${address}`);
  if (res.status === 404) return '0'; // account doesn't even exist — trivially zero XLM
  const account = await res.json();
  const native = account.balances.find((b) => b.asset_type === 'native');
  return native ? native.balance : '0';
}

/** Step A: sponsor account creation + USDC trustline for a keypair that has
 * never held a stroop of XLM. */
async function sponsorOnboarding(freshKeypair) {
  console.log('\n[1/6] Sponsoring account creation + USDC trustline for a fresh, zero-XLM keypair…');
  console.log(`      Fresh address: ${freshKeypair.publicKey()}`);

  const buildRes = await fetch(`${env.backendUrl}/sponsor/onboard/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: freshKeypair.publicKey() }),
  });
  if (!buildRes.ok) throw new Error(`onboard/build failed: ${JSON.stringify(await buildRes.json())}`);
  const { xdr } = await buildRes.json();

  const tx = TransactionBuilder.fromXDR(xdr, env.networkPassphrase);
  tx.sign(freshKeypair);

  const submitRes = await fetch(`${env.backendUrl}/sponsor/onboard/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xdr: tx.toXDR() }),
  });
  if (!submitRes.ok) throw new Error(`onboard/submit failed: ${JSON.stringify(await submitRes.json())}`);
  const { hash } = await submitRes.json();
  console.log(`      ✓ Onboarded: ${explorerTxLink(hash)}`);
}

/** Step B: seed the fresh account with a little test USDC from a
 * separately-funded holder, who pays their own network fee. */
async function fundFreshAccountWithUsdc(freshAddress, amount) {
  console.log(`\n[2/6] Funding fresh account with ${amount} test USDC (funder pays their own fee)…`);
  if (!process.env.FUNDING_PAYER_SECRET) throw new Error('FUNDING_PAYER_SECRET is not set');
  const funder = Keypair.fromSecret(process.env.FUNDING_PAYER_SECRET);
  const funderAccount = await horizon.loadAccount(funder.publicKey());
  const usdc = new Asset(env.usdcCode, env.usdcIssuer);

  const tx = new TransactionBuilder(funderAccount, { fee: BASE_FEE, networkPassphrase: env.networkPassphrase })
    .addOperation(Operation.payment({ destination: freshAddress, asset: usdc, amount }))
    .setTimeout(60)
    .build();
  tx.sign(funder);
  const res = await horizon.submitTransaction(tx);
  console.log(`      ✓ Funded: ${explorerTxLink(res.hash)}`);
}

/** Step C: the fresh, still-XLM-less account pays for a question, with the
 * platform fee-bumping the transaction so the payer never spends XLM. */
async function paySponsoredQuestion(freshKeypair, question) {
  console.log(`\n[3/6] Asking a question and paying via sponsored fee-bump: "${question}"`);
  const challenge = await postOracle({ question, tier: 'express' });
  if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}`);

  const signedXdr = await buildSignedSubmitXdr(freshKeypair, challenge.body.questionId, challenge.body.amountStroops);

  const payRes = await fetch(`${env.backendUrl}/sponsor/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xdr: signedXdr, payerAddress: freshKeypair.publicKey(), questionId: challenge.body.questionId }),
  });
  if (!payRes.ok) throw new Error(`sponsor/pay failed: ${JSON.stringify(await payRes.json())}`);
  const { hash } = await payRes.json();
  console.log(`      ✓ Payment fee-bumped and landed: ${explorerTxLink(hash)}`);

  return { questionId: challenge.body.questionId, paymentTxHash: hash };
}

async function main() {
  if (!env.contractId) throw new Error('ORACLE_CONTRACT_ID is not set');
  const fresh = Keypair.random();

  const preBalance = await nativeXlmBalance(fresh.publicKey());
  console.log(`Fresh keypair generated. Starting XLM balance: ${preBalance} (account not yet created)`);

  await sponsorOnboarding(fresh);
  await fundFreshAccountWithUsdc(fresh.publicKey(), '5');

  const { questionId } = await paySponsoredQuestion(fresh, 'Zero-XLM proof: what does Arbiter settle in?');

  console.log(`\n[4/6] Notifying backend + polling job for question ${questionId}…`);
  const fulfil = await postOracle({ question: 'unused' }, { 'X-Payment-Tx': 'sponsored', 'X-Question-Id': questionId });
  if (fulfil.status !== 202) throw new Error(`expected 202, got ${fulfil.status}: ${JSON.stringify(fulfil.body)}`);
  const job = await pollJob(fulfil.body.jobId);

  console.log(`      Outcome: ${job.outcome}`);
  if (job.outcome === 'resolved') console.log(`      Payout tx: ${explorerTxLink(job.payoutTx)}`);
  else if (job.outcome === 'refunded') console.log(`      Refund tx: ${explorerTxLink(job.refundTx)}`);
  else console.log(`      Reason: ${job.reason} — auto-refund available after ${job.autoRefundAfterLedgers} ledgers`);

  console.log('\n[5/6] Re-checking the fresh account\'s XLM balance…');
  const postBalance = await nativeXlmBalance(fresh.publicKey());
  console.log(`      XLM balance: ${postBalance}`);
  if (Number(postBalance) !== 0) {
    throw new Error(`EXPECTED ZERO XLM but found ${postBalance} — sponsorship leaked a fee onto the payer`);
  }
  console.log('      ✓ PROVEN: this account created an account, opened a trustline, paid for a');
  console.log('        question, and got settled — all without ever holding a single stroop of XLM.');

  if (!PROVE_TIMEOUT_REFUND) {
    console.log('\n[6/6] Skipping the permissionless timeout-refund proof (set PROVE_TIMEOUT_REFUND=true to run it).');
    return;
  }

  await proveTimeoutRefund(fresh);
}

/** Proves the contract's fail-safe: pays for a question but deliberately
 * never tells the backend about it (so the backend never calls resolve() or
 * refund()), then waits out TIMEOUT_LEDGERS and has a THIRD PARTY — not the
 * original payer — force the refund via refund_timeout(), with no
 * signature from the payer or the platform admin at all. This is the
 * concrete on-chain proof that v1's single-admin-key design can delay
 * settlement but can never permanently strand payer funds. Real ledger
 * time on testnet (~5s/ledger), so this genuinely takes several minutes.
 */
async function proveTimeoutRefund(fresh) {
  console.log(`\n[6/6] Proving the permissionless refund_timeout() escape hatch (~${env.timeoutLedgers * 5}s on testnet)…`);
  const challenge = await postOracle({ question: 'This question is deliberately never fulfilled.', tier: 'express' });
  if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}`);

  const signedXdr = await buildSignedSubmitXdr(fresh, challenge.body.questionId, challenge.body.amountStroops);
  const payRes = await fetch(`${env.backendUrl}/sponsor/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xdr: signedXdr, payerAddress: fresh.publicKey(), questionId: challenge.body.questionId }),
  });
  if (!payRes.ok) throw new Error(`sponsor/pay failed: ${JSON.stringify(await payRes.json())}`);
  const { hash } = await payRes.json();
  console.log(`      Payment landed (backend deliberately not notified): ${explorerTxLink(hash)}`);

  const startLedger = await getLatestLedgerSequence();
  const deadline = startLedger + env.timeoutLedgers;
  console.log(`      Current ledger ${startLedger}, waiting for ledger ${deadline}…`);

  let current = startLedger;
  while (current < deadline) {
    await sleep(10_000);
    current = await getLatestLedgerSequence();
    process.stdout.write(`      ledger ${current}/${deadline}\r`);
  }
  console.log(`\n      Deadline reached at ledger ${current}. Calling refund_timeout() as an unrelated third party…`);

  const refundHash = await callRefundTimeoutPermissionless(challenge.body.questionId);
  console.log(`      ✓ refund_timeout() succeeded with no admin or payer signature: ${explorerTxLink(refundHash)}`);
}

main().catch((err) => {
  console.error('\nsponsored-demo.js failed:', err.message);
  process.exit(1);
});
