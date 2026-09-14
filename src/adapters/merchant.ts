import { ALPHA_MERCHANT, ALPHA_PRODUCT, POC_CATALOG, type CategoryCode } from '@meowwa/chain-domain';

export interface MerchantQuote {
  quoteId: string;
  merchant: { merchantId: string; name: string; recipient: string };
  product: { productId: string; merchantId: string; name: string; category: CategoryCode; priceMinor: number };
  amountMinor: number; taxMinor: number; shippingMinor: number; feesMinor: number;
  expiresAt: string; verified: boolean;
}

export function getUsualFoodQuote(now = new Date()): MerchantQuote {
  return getProductQuote(ALPHA_PRODUCT.productId, now)!;
}

/**
 * Never memoise the quote. `expiresAt` is what the request binds as `quoteExpiresAt`, and that is
 * both the owner's approval deadline (policy blocks QUOTE_EXPIRED past it) and the request-expiry
 * job's due time. A quote reused for its remaining life therefore hands each later proposal a
 * shorter approval window than the one before -- process-wide, so one owner's proposal shortened
 * the next owner's -- until an owner who did nothing wrong got seconds to reach the Mac and unlock
 * it. The price is deterministic from the catalog, so re-deriving it costs nothing.
 */
export function getProductQuote(productId: string, now = new Date()): MerchantQuote | undefined {
  const product = POC_CATALOG.find((item) => item.productId === productId);
  if (!product) return undefined;
  const quote: MerchantQuote = {
    quoteId: `quote_${product.productId}`,
    merchant: ALPHA_MERCHANT,
    // Projected field by field rather than spread. The merchant quote is a cross-service wire
    // contract validated with `.strict()`, and the catalog entry carries MeowWa-side routing
    // (`species`) a merchant has no business receiving.
    product: {
      productId: product.productId, merchantId: product.merchantId, name: product.name,
      category: product.category, priceMinor: product.priceMinor,
    },
    amountMinor: product.priceMinor, taxMinor: 0, shippingMinor: 0, feesMinor: 0,
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), verified: true,
  };
  return quote;
}

export type OrderConfirmation =
  | { status: 'confirmed'; orderId: string }
  | { status: 'pending'; reason: string }
  | { status: 'failed'; reason: string };

export type RefundConfirmation =
  | { status: 'confirmed'; refundId: string }
  | { status: 'pending'; refundId?: string; reason: string }
  | { status: 'failed'; reason: string };

type Awaitable<T> = T | Promise<T>;

export interface MerchantAdapter {
  readonly kind?: 'simulated' | 'controlled';
  getQuote?(now: Date): Awaitable<MerchantQuote>;
  getQuoteForProduct?(productId: string, now: Date): Awaitable<MerchantQuote | undefined>;
  confirmOrder(requestId: string): Awaitable<OrderConfirmation>;
  /** Verify a durable provider order proof before a later reconciliation event is accepted. */
  verifyOrder?(requestId: string, orderId: string): Awaitable<boolean>;
  refundOrder?(requestId: string): Awaitable<RefundConfirmation>;
}

export const simulatedMerchantAdapter: MerchantAdapter = {
  kind: 'simulated',
  getQuote: getUsualFoodQuote,
  getQuoteForProduct: getProductQuote,
  confirmOrder: (requestId) => ({ status: 'confirmed', orderId: `order_${requestId}` }),
  verifyOrder: (requestId, orderId) => orderId === `order_${requestId}`,
  refundOrder: (requestId) => ({ status: 'confirmed', refundId: `refund_${requestId}` }),
};
