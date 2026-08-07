import 'dotenv/config';
import { Keypair } from '@stellar/stellar-sdk';
import { env, submitPaymentDirect, explorerTxLink, sleep } from './lib/stellar.js';

const question = process.argv.slice(2).join(' ') || 'What is the capital of France?';
const tier = process.env.TIER || 'standard';
const category = process.env.CATEGORY || undefined;

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
    process.stdout.write(`  … job ${jobId} status=${job.status} (${job.totalAnswers ?? 0} answers so far)\r`);
    await sleep(intervalMs);
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

async function main() {
  if (!env.contractId) throw new Error('ORACLE_CONTRACT_ID is not set');
  if (!process.env.DEMO_PAYER_SECRET) throw new Error('DEMO_PAYER_SECRET is not set');
  const payer = Keypair.fromSecret(process.env.DEMO_PAYER_SECRET);

  console.log(`Asking: "${question}" (tier=${tier}${category ? `, category=${category}` : ''})`);
  console.log(`Payer: ${payer.publicKey()}`);

  // Step 1 — expect a 402 with no payment proof supplied.
  const challenge = await postOracle({ question, tier, category });
  if (challenge.status !== 402) {
    throw new Error(`expected 402 on first call, got ${challenge.status}: ${JSON.stringify(challenge.body)}`);
  }
  const surgeNote =
    challenge.body.surgeMultiplier && challenge.body.surgeMultiplier !== 1
      ? ` (surge ${challenge.body.surgeMultiplier}x — worker supply is scarce right now)`
      : '';
  console.log(`✓ Got 402 as expected. questionId=${challenge.body.questionId} price=${challenge.body.amount} USDC${surgeNote}`);

  // Step 2 — pay on-chain for real.
  console.log('Submitting payment on-chain…');
  const paymentTxHash = await submitPaymentDirect(payer, challenge.body.questionId, challenge.body.amountStroops);
  console.log(`✓ Payment landed: ${explorerTxLink(paymentTxHash)}`);

  // Step 3 — retry with payment proof headers. This now returns 202
  // immediately rather than blocking for up to the quorum timeout.
  const fulfil = await postOracle(
    { question },
    { 'X-Payment-Tx': paymentTxHash, 'X-Question-Id': challenge.body.questionId },
  );
  if (fulfil.status !== 202) {
    throw new Error(`expected 202 after payment, got ${fulfil.status}: ${JSON.stringify(fulfil.body)}`);
  }
  console.log(`✓ Payment verified, job dispatched: ${fulfil.body.jobId} (poll ${fulfil.body.statusUrl})`);

  // Step 4 — poll for the async result.
  const job = await pollJob(fulfil.body.jobId);
  console.log(); // clear the \r progress line

  if (job.outcome === 'resolved') {
    console.log(`✓ RESOLVED — answer: "${job.answer}" (confidence ${job.confidence}, via ${job.reconciliationMethod})`);
    console.log(`  Matching workers: ${job.matchingWorkers.join(', ')}`);
    console.log(`  Payout tx: ${explorerTxLink(job.payoutTx)}`);
  } else if (job.outcome === 'refunded') {
    console.log(`✓ REFUNDED — reason: ${job.reason}`);
    console.log(`  Refund tx: ${explorerTxLink(job.refundTx)}`);
  } else {
    console.log(`⚠ Backend could not settle on-chain (outcome=${job.outcome}): ${job.reason}`);
    console.log(
      `  You are not stuck — after ${job.autoRefundAfterLedgers} ledgers you (or anyone) may call ` +
        `refund_timeout(${challenge.body.questionId}) on contract ${env.contractId} directly to reclaim the payment.`,
    );
  }
}

main().catch((err) => {
  console.error('\nask.js failed:', err.message);
  process.exit(1);
});
