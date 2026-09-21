/**
 * Fiat rails — drives SEP-10 auth and the SEP-24 interactive withdraw flow
 * directly against whichever anchor the backend is configured with (see
 * backend/src/anchorClient.js). This has to happen in the browser: the
 * anchor's JWT is gated by the account holder signing a SEP-10 challenge
 * themselves, so the backend has no authority to do this on a user's
 * behalf.
 *
 * Scope note: this gets a user from "click Withdraw to bank" through the
 * anchor's hosted KYC/deposit-details UI and back to "here is the exact
 * destination account, memo, and amount the anchor wants." It deliberately
 * stops there rather than auto-sending that payment — a memo-carrying
 * transfer to a per-anchor collection account is real, hard-to-undo money
 * movement, and different anchors have different memo requirements. Wiring
 * that into the existing withdraw_to() fee-bump relay (sponsor.js) is a
 * real next step, not something to guess at without testing against a live
 * anchor's actual behavior end to end.
 */

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function getAnchorConfig() {
  const res = await fetch(`${BACKEND_URL}/anchor/config`);
  if (res.status === 503) return null; // no anchor configured on this backend
  if (!res.ok) throw new Error(`failed to load anchor config (${res.status})`);
  return res.json();
}

async function sep10Auth(anchorConfig, address, wallet, networkPassphrase) {
  const challengeUrl = new URL(anchorConfig.webAuthEndpoint);
  challengeUrl.searchParams.set('account', address);
  const challengeRes = await fetch(challengeUrl);
  if (!challengeRes.ok) throw new Error(`anchor rejected the SEP-10 challenge request (${challengeRes.status})`);
  const { transaction } = await challengeRes.json();

  const { signedTxXdr } = await wallet.signTransaction(transaction, { address, networkPassphrase });

  const verifyRes = await fetch(anchorConfig.webAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: signedTxXdr }),
  });
  if (!verifyRes.ok) throw new Error(`anchor rejected the signed SEP-10 challenge (${verifyRes.status})`);
  const { token } = await verifyRes.json();
  return token;
}

async function startInteractiveWithdraw(anchorConfig, jwt, address, assetCode) {
  const res = await fetch(`${anchorConfig.transferServerSep24}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ asset_code: assetCode, account: address }),
  });
  if (!res.ok) throw new Error(`anchor rejected the withdraw request (${res.status})`);
  return res.json(); // { type: 'interactive_customer_info_needed', url, id }
}

async function pollTransaction(anchorConfig, jwt, id, onUpdate) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = null;

  while (Date.now() < deadline) {
    const url = new URL(`${anchorConfig.transferServerSep24}/transaction`);
    url.searchParams.set('id', id);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
    if (res.ok) {
      const { transaction } = await res.json();
      if (transaction.status !== lastStatus) {
        lastStatus = transaction.status;
        onUpdate(transaction);
      }
      if (['pending_user_transfer_start', 'completed', 'error', 'refunded'].includes(transaction.status)) {
        return transaction;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('timed out waiting for the anchor to reach a payment-ready state');
}

async function reportToArbiter({ address, arbiterSessionToken, transaction }) {
  await fetch(`${BACKEND_URL}/anchor/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      token: arbiterSessionToken,
      kind: 'withdrawal',
      status: transaction.status,
      amount: transaction.amount_in || null,
      assetCode: transaction.amount_in_asset || null,
      anchorTransactionId: transaction.id,
    }),
  }).catch(() => {}); // best-effort — the admin console cache is a convenience, not the source of truth
}

/**
 * Wires up a "Withdraw to bank" button. Hides it entirely if the backend
 * has no anchor configured. `deps` needs: button element, status element,
 * getAddress()/getWallet() (same shape main.js already uses for the
 * on-chain withdraw button), getArbiterSessionToken() (from ensureSession()
 * — reused here purely to authenticate the /anchor/report call, not the
 * anchor itself), networkPassphrase, and assetCode.
 */
export function initBankWithdraw({ button, status, getAddress, getWallet, getArbiterSessionToken, networkPassphrase, assetCode }) {
  let anchorConfigPromise = null;

  async function ensureAnchorConfig() {
    if (!anchorConfigPromise) anchorConfigPromise = getAnchorConfig();
    return anchorConfigPromise;
  }

  ensureAnchorConfig()
    .then((cfg) => {
      if (cfg) button.classList.remove('hidden');
    })
    .catch(() => {}); // no anchor configured, or unreachable — button stays hidden either way

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      const anchorConfig = await ensureAnchorConfig();
      if (!anchorConfig) throw new Error('no fiat anchor is configured on this backend');

      const address = getAddress();
      const wallet = getWallet();

      status.textContent = 'Authenticating with the anchor (one signature)…';
      const jwt = await sep10Auth(anchorConfig, address, wallet, networkPassphrase);

      status.textContent = 'Opening the anchor\'s withdrawal form…';
      const { url, id } = await startInteractiveWithdraw(anchorConfig, jwt, address, assetCode);
      window.open(url, 'arbiter-anchor-withdraw', 'width=480,height=720');

      status.textContent = 'Waiting for you to finish the anchor\'s form…';
      const transaction = await pollTransaction(anchorConfig, jwt, id, (t) => {
        status.textContent = `Anchor status: ${t.status}`;
      });

      await reportToArbiter({ address, arbiterSessionToken: await getArbiterSessionToken(), transaction });

      if (transaction.status === 'pending_user_transfer_start') {
        // Built with createElement/textContent, not innerHTML — amount_in,
        // withdraw_anchor_account, and withdraw_memo all come straight from
        // the configured anchor's own SEP-24 API response, a third party
        // this backend doesn't control. A malicious or compromised anchor
        // could otherwise inject markup here.
        status.textContent = '';
        status.append('Send ');
        const amountStrong = document.createElement('strong');
        amountStrong.textContent = `${transaction.amount_in} ${assetCode}`;
        status.append(amountStrong, ' to ');
        const accountCode = document.createElement('code');
        accountCode.textContent = transaction.withdraw_anchor_account;
        status.append(accountCode);
        if (transaction.withdraw_memo) {
          const memoCode = document.createElement('code');
          memoCode.textContent = transaction.withdraw_memo;
          status.append(' with memo ', memoCode);
        }
        status.append(' to complete this withdrawal — the anchor is now waiting for that on-chain payment.');
      } else if (transaction.status === 'completed') {
        status.textContent = 'Withdrawal completed by the anchor.';
      } else {
        status.textContent = `Anchor reported: ${transaction.status}`;
      }
    } catch (err) {
      status.textContent = `Bank withdrawal failed: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });
}
