/** Parses a USDC amount string (e.g. "1.5") typed by a user into stroops
 * (7 decimal places), matching the contract's i128 stroop denomination. */
export function stroopsFromUsdcInput(value) {
  const trimmed = String(value).trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error('enter a positive amount with up to 7 decimal places');
  }
  const [whole, frac = ''] = trimmed.split('.');
  const paddedFrac = frac.padEnd(7, '0');
  return BigInt(whole) * 10_000_000n + BigInt(paddedFrac || '0');
}

export function usdcFromStroops(stroops) {
  const s = BigInt(stroops);
  const whole = s / 10_000_000n;
  const frac = (s % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}
