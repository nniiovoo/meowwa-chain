import type { CategoryCode, Species } from './codes.js';

/**
 * The controlled catalog. Every purchasable identity in the product starts here: a policy
 * allowlist, a merchant quote, and a Shopify search query are all keyed by `productId`, so a
 * product absent from this list cannot be suggested, priced, or paid for.
 *
 * `species` scopes a product to the animals it is actually for. Without it the suggestion path
 * filtered on need and category alone and left species to the Shopify search string, so a dog was
 * offered a feather wand — and adding dog food would have offered a cat a puppy formula.
 */
type ControlledProduct = {
  readonly productId: string;
  readonly merchantId: string;
  readonly name: string;
  readonly category: CategoryCode;
  readonly priceMinor: number;
  readonly species: readonly Species[];
};

export const ALPHA_MERCHANT = {
  merchantId: 'merchant_approved_1',
  name: 'Trusted Pet Pantry',
  recipient: '0x1111111111111111111111111111111111111111',
} as const;

export const ALPHA_PRODUCT = {
  productId: 'product_usual_food_1',
  merchantId: ALPHA_MERCHANT.merchantId,
  name: 'Usual food',
  category: 'PET_FOOD',
  priceMinor: 1299,
  species: ['cat', 'dog'],
} as const;

const approved = ALPHA_MERCHANT.merchantId;

export const POC_CATALOG = [
  ALPHA_PRODUCT,
  { productId: 'product_toy_feather_1', merchantId: approved, name: 'Interactive feather wand', category: 'TOYS_ENRICHMENT', priceMinor: 899, species: ['cat'] },
  { productId: 'product_treat_1', merchantId: approved, name: 'Salmon training treats', category: 'TREATS', priceMinor: 699, species: ['cat', 'dog'] },
  { productId: 'product_litter_clumping_1', merchantId: approved, name: 'Clumping litter', category: 'CAT_LITTER', priceMinor: 1599, species: ['cat'] },

  // Dog products. Categories are limited to the three the seeded mandate already allows
  // (PET_FOOD, TREATS, TOYS_ENRICHMENT). Walking, bedding and safety gear have no CategoryCode,
  // and minting one would widen the purchasable surface past what the owner approved.
  { productId: 'product_dog_food_adult_1', merchantId: approved, name: 'Adult dog complete dry food', category: 'PET_FOOD', priceMinor: 1899, species: ['dog'] },
  { productId: 'product_dog_food_puppy_1', merchantId: approved, name: 'Puppy growth food', category: 'PET_FOOD', priceMinor: 1749, species: ['dog'] },
  { productId: 'product_dog_treat_dental_1', merchantId: approved, name: 'Dental chew sticks', category: 'TREATS', priceMinor: 1149, species: ['dog'] },
  { productId: 'product_dog_treat_training_1', merchantId: approved, name: 'Soft training treats', category: 'TREATS', priceMinor: 749, species: ['dog'] },
  { productId: 'product_dog_chew_durable_1', merchantId: approved, name: 'Durable rubber chew toy', category: 'TOYS_ENRICHMENT', priceMinor: 1299, species: ['dog'] },
  { productId: 'product_dog_puzzle_feeder_1', merchantId: approved, name: 'Slow-feed puzzle toy', category: 'TOYS_ENRICHMENT', priceMinor: 1599, species: ['dog'] },
  { productId: 'product_dog_fetch_ball_1', merchantId: approved, name: 'Fetch ball set', category: 'TOYS_ENRICHMENT', priceMinor: 899, species: ['dog'] },
  { productId: 'product_dog_rope_tug_1', merchantId: approved, name: 'Cotton rope tug toy', category: 'TOYS_ENRICHMENT', priceMinor: 649, species: ['dog'] },
  { productId: 'product_dog_snuffle_mat_1', merchantId: approved, name: 'Snuffle foraging mat', category: 'TOYS_ENRICHMENT', priceMinor: 1449, species: ['dog'] },
] as const satisfies readonly ControlledProduct[];

export type ControlledProductEntry = (typeof POC_CATALOG)[number];

/**
 * The product ids a given species may be offered. A caller keyed by this type cannot silently
 * gain or lose a product when the catalog changes: the compiler demands the entry be handled.
 */
export type ProductIdsFor<S extends Species> =
  keyof { [P in ControlledProductEntry as S extends P['species'][number] ? P['productId'] : never]: unknown } & string;

export function catalogForSpecies(species: Species): readonly ControlledProductEntry[] {
  return POC_CATALOG.filter((product) => (product.species as readonly Species[]).includes(species));
}
