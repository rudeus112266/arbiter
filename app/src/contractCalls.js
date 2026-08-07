import { Contract, TransactionBuilder, Address, nativeToScVal, rpc } from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const CONTRACT_ID = import.meta.env.VITE_ORACLE_CONTRACT_ID || '';

let server = null;
function getServer() {
  if (!server) server = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: SOROBAN_RPC_URL.startsWith('http://') });
  return server;
}

/** Builds a simulated+assembled (but unsigned) contract-call transaction
 * for `sourceAddress` to sign with their own wallet. Uses a nominal fee —
 * the worker never actually pays it, since these calls are always relayed
 * through a /sponsor/* fee-bump endpoint so a zero-XLM worker can stake and
 * withdraw just like they can answer questions. */
async function buildUnsignedCallXdr(sourceAddress, method, args) {
  const srv = getServer();
  const account = await srv.getAccount(sourceAddress);
  const contract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  const prepared = await srv.prepareTransaction(tx);
  return prepared.toXDR();
}

export async function buildStakeXdr(workerAddress, amountStroops) {
  return buildUnsignedCallXdr(workerAddress, 'stake', [
    new Address(workerAddress).toScVal(),
    nativeToScVal(BigInt(amountStroops), { type: 'i128' }),
  ]);
}

export async function buildWithdrawXdr(workerAddress) {
  return buildUnsignedCallXdr(workerAddress, 'withdraw', [new Address(workerAddress).toScVal()]);
}

export { NETWORK_PASSPHRASE };
