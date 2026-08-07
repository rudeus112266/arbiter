import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * A locally-generated, browser-held keypair as an alternative to installing
 * a wallet extension — the friction Jobs would call out first. This is
 * deliberately NOT a first-party custodial/embedded wallet (which would
 * introduce real custody and regulatory surface); the secret lives only in
 * this browser's localStorage and is never sent anywhere, so the trust
 * model is the same as a browser extension wallet, just without hardware
 * backing. That's a real, disclosed tradeoff: anyone who can run JS in this
 * origin (e.g. via an XSS bug) could read it. Fine for a quick-start/demo
 * identity; a production deployment should offer this alongside, not
 * instead of, real wallets.
 */
const STORAGE_KEY = 'arbiter_local_wallet_secret';

export function hasLocalWallet() {
  return !!localStorage.getItem(STORAGE_KEY);
}

export function clearLocalWallet() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Returns the raw secret for a one-time "back this up somewhere safe"
 * reveal — this wallet holds real staked USDC and accrued earnings, and
 * there is no recovery path if localStorage is cleared (browser reset,
 * private browsing, different device). Never logged, never sent to the
 * backend — only ever read back out for the user to copy themselves. */
export function getLocalWalletSecret() {
  return localStorage.getItem(STORAGE_KEY);
}

/** Returns an object matching the same {getAddress, signTransaction} shape
 * as StellarWalletsKit, so the rest of the app doesn't need to know which
 * wallet is active. */
export function createOrLoadLocalWallet() {
  let secret = localStorage.getItem(STORAGE_KEY);
  if (!secret) {
    secret = Keypair.random().secret();
    localStorage.setItem(STORAGE_KEY, secret);
  }
  const keypair = Keypair.fromSecret(secret);

  return {
    id: 'local-quick-start',
    async getAddress() {
      return { address: keypair.publicKey() };
    },
    async signTransaction(xdr, opts = {}) {
      const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR() };
    },
  };
}
