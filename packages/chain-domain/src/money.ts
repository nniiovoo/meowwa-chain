export interface Money {
  minor: number;
  currency: typeof import('./codes.js').TEST_USDC;
}

export function money(minor: number): Money {
  if (!Number.isInteger(minor)) throw new TypeError('money must use integer minor units');
  if (!Number.isSafeInteger(minor)) throw new RangeError('money must be a safe integer');
  if (minor < 0) throw new RangeError('money must be non-negative');
  return { minor, currency: 'USDC' };
}

export function quoteTotalMatchesBasePrice(
  basePriceMinor: number,
  quote: { amountMinor: number; taxMinor?: number; shippingMinor?: number; feesMinor?: number },
): boolean {
  const parts = [basePriceMinor, quote.taxMinor ?? 0, quote.shippingMinor ?? 0, quote.feesMinor ?? 0];
  return Number.isSafeInteger(quote.amountMinor) && quote.amountMinor > 0 &&
    parts.every((part) => Number.isSafeInteger(part) && part >= 0) &&
    parts.reduce((total, part) => total + part, 0) === quote.amountMinor;
}

/**
 * The approval gate every client uses before offering "Approve and pay" or "Complete payment":
 * the owner may only authorize money against an exact, still-purchasable product whose price
 * accounts for the whole amount. One definition, because a gate that is looser on one screen than
 * another is a hole on the looser screen, not a convenience.
 *
 * `availableForSale === false` blocks: a catalog entry that says the product cannot be bought is
 * the controlled-catalog form of the rule the Shopify half already enforces, since a suggestion is
 * only ever emitted for a live variant, and the server refuses a checkout without one.
 */
export function exactProductAvailable(
  product: {
    controlled: boolean; merchantId: string; priceMinor: number; availableForSale?: boolean | undefined;
  } | undefined,
  request: {
    merchantId: string; amountMinor: number; taxMinor?: number; shippingMinor?: number; feesMinor?: number;
    shopifyReference?: unknown;
  },
  shopifySuggestion?: { priceMinor: number },
): boolean {
  // A Shopify-linked request is exact only while the live listing still verifies; the suggestion's
  // price, not the controlled list price, is what the owner is being asked to pay.
  if (request.shopifyReference && !shopifySuggestion) return false;
  const quotedProductPriceMinor = shopifySuggestion?.priceMinor ?? product?.priceMinor;
  return Boolean(product?.controlled && product.merchantId === request.merchantId &&
    product.availableForSale !== false &&
    quotedProductPriceMinor !== undefined && quoteTotalMatchesBasePrice(quotedProductPriceMinor, request));
}
