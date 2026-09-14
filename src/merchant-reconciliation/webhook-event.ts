import { z } from 'zod';
import { EVM_HASH_PATTERN } from '@meowwa/chain-domain';

const merchantOrderEventSchema = z.object({
  type: z.enum(['order.confirmed', 'order.fulfilled', 'order.cancelled', 'order.failed']),
  providerReference: z.string().regex(/^mwo_[a-f0-9]{61}$/),
  providerOrderId: z.string().min(3).max(255),
  reason: z.string().min(1).max(500).optional(),
}).strict();

const merchantRefundEventSchema = z.object({
  type: z.enum(['refund.confirmed', 'refund.failed']),
  providerReference: z.string().regex(/^mwr_[a-f0-9]{61}$/),
  providerRefundId: z.string().min(3).max(255),
  transactionHash: z.string().regex(EVM_HASH_PATTERN).optional(),
  reason: z.string().min(1).max(500).optional(),
}).strict();

export const merchantEventSchema = z.union([merchantOrderEventSchema, merchantRefundEventSchema]);
