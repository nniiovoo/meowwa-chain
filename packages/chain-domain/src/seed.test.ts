import { describe, expect, it } from 'vitest';
import { POC_CATALOG } from './seed.js';

describe('proof-of-concept catalog', () => {
  it('does not expose duplicate products under different identifiers', () => {
    const productKeys = POC_CATALOG.map((product) =>
      [product.merchantId, product.name, product.category, product.priceMinor].join('|'),
    );

    expect(new Set(productKeys).size).toBe(productKeys.length);
  });
});
