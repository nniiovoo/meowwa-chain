import { z } from 'zod';
import { EVM_ADDRESS_PATTERN } from './chain.js';
import {
  ACTOR_CODES, BASE_SEPOLIA_CHAIN_ID, CATEGORY_CODES,
  MANDATE_STATES, NEED_CODES, REQUEST_STATES, TEST_USDC,
} from './codes.js';

const id = z.string().regex(/^[a-z][a-z0-9_:-]{2,127}$/i);
const isoDate = z.iso.datetime({ offset: true });
const address = z.string().regex(EVM_ADDRESS_PATTERN);
const minorUnits = z.number().int().safe().nonnegative();

export const mandateSchema = z.object({
  mandateId: id, ownerId: id, petId: id, agentId: id,
  purposeCode: z.enum(['RECURRING_ESSENTIALS', 'OWNER_ASSISTED_PURCHASE']),
  allowedNeedCodes: z.array(z.enum(NEED_CODES)).min(1),
  allowedCategoryCodes: z.array(z.enum(CATEGORY_CODES)).min(1),
  allowedMerchantIds: z.array(id).min(1), allowedProductIds: z.array(id).min(1),
  token: z.literal(TEST_USDC), chainId: z.literal(BASE_SEPOLIA_CHAIN_ID),
  perTransactionLimitMinor: minorUnits, periodLimitMinor: minorUnits,
  period: z.literal('P30D'), maxTransactions: z.number().int().positive(),
  approvalAboveMinor: minorUnits,
  validFrom: isoDate, validUntil: isoDate, nonce: z.string().min(8), policyVersion: z.string().min(1),
  state: z.enum(MANDATE_STATES), signature: z.string().min(8), mandateHash: z.string().min(8),
  signer: address, signedAt: isoDate, displayedApprovalText: z.string().min(1),
});

/**
 * One request for money, as the owner approved it and as the chain rail settles it.
 *
 * `interpretationId`, `interpretationVersion` and `taxonomyVersion` are recorded, never produced:
 * they are opaque identifiers carried onto the payment record so a settled transaction can be
 * traced back to whatever authorized it. Nothing in this package reads their contents.
 */
export const paymentRequestSchema = z.object({
  requestId: id, petId: id, ownerId: id, agentId: id, mandateId: id,
  interpretationId: id, interpretationVersion: z.string().min(1), taxonomyVersion: z.string().min(1),
  ownerConfirmationStatus: z.enum(['confirmed', 'mandate_preapproved']), need: z.enum(NEED_CODES), category: z.enum(CATEGORY_CODES),
  merchantId: id, productId: id, quantity: z.number().int().positive(), amountMinor: minorUnits,
  currency: z.literal(TEST_USDC), chainId: z.literal(BASE_SEPOLIA_CHAIN_ID), recipient: address, contract: address,
  quoteId: id, quoteExpiresAt: isoDate, taxMinor: minorUnits, shippingMinor: minorUnits, feesMinor: minorUnits,
  evidenceRefs: z.array(id).min(1), idempotencyKey: z.string().min(8), requestNonce: z.string().min(8),
  createdAt: isoDate, emergencyMode: z.boolean(), requestedApprovalMode: z.enum(['EVERY_REQUEST', 'LIMITED_AUTONOMY']),
  policyVersion: z.string().min(1), state: z.enum(REQUEST_STATES), approvedBy: id.optional(),
  shopifyReference: z.object({
    productId: z.string().regex(/^gid:\/\/shopify\/p\/[A-Za-z0-9]+$/),
    variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/),
    merchantId: z.string().regex(/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/).optional(),
    merchantDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/).optional(),
  }).strict().refine((reference) => Boolean(reference.merchantId) === Boolean(reference.merchantDomain), {
    message: 'Shopify seller identity must be complete',
  }).optional(),
});

export const auditEventSchema = z.object({
  eventId: id, eventType: z.string().min(1), aggregateId: id,
  actorType: z.enum(ACTOR_CODES), actorId: id, occurredAt: isoDate,
  versions: z.record(z.string(), z.string()), summary: z.string().min(1),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export type Mandate = z.infer<typeof mandateSchema>;
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
