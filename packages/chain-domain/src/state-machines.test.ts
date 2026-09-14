import { describe, expect, it } from 'vitest';
import { transitionMandate, transitionRequest } from './index.js';

describe('mandate state machine', () => {
  it('allows the documented activation and revocation path', () => {
    expect(transitionMandate('DRAFT', 'PENDING_APPROVAL', 'owner')).toBe('PENDING_APPROVAL');
    expect(transitionMandate('PENDING_APPROVAL', 'ACTIVE', 'owner')).toBe('ACTIVE');
    expect(transitionMandate('ACTIVE', 'SUSPENDED', 'owner')).toBe('SUSPENDED');
    expect(transitionMandate('SUSPENDED', 'REVOKED', 'owner')).toBe('REVOKED');
  });

  it('prevents the agent from activating a mandate', () => {
    expect(() => transitionMandate('PENDING_APPROVAL', 'ACTIVE', 'agent')).toThrow('actor');
  });
});

describe('payment request state machine', () => {
  it('requires an owner to authorize an approval request', () => {
    expect(transitionRequest('DRAFT', 'EVALUATING', 'agent')).toBe('EVALUATING');
    expect(transitionRequest('EVALUATING', 'AWAITING_APPROVAL', 'system')).toBe('AWAITING_APPROVAL');
    expect(() => transitionRequest('AWAITING_APPROVAL', 'AUTHORIZED', 'agent')).toThrow('actor');
    expect(transitionRequest('AWAITING_APPROVAL', 'AUTHORIZED', 'owner')).toBe('AUTHORIZED');
  });

  it('rejects transitions not present in the documented state machine', () => {
    expect(() => transitionRequest('DRAFT', 'CONFIRMED', 'owner')).toThrow('DRAFT -> CONFIRMED');
  });

  it('lets the financial harness cancel an authorized request when revalidation fails', () => {
    expect(transitionRequest('AUTHORIZED', 'CANCELLED', 'system')).toBe('CANCELLED');
  });

  it('moves a refunded request into dispute when its refund confirmation is reorged', () => {
    expect(transitionRequest('REFUNDED', 'DISPUTED', 'provider')).toBe('DISPUTED');
    expect(() => transitionRequest('REFUNDED', 'DISPUTED', 'owner')).toThrow('actor');
  });

  it('leaves a disputed request an exit to refunded so a dispute is not a money dead end', () => {
    expect(transitionRequest('CONFIRMED', 'DISPUTED', 'owner')).toBe('DISPUTED');
    expect(transitionRequest('DISPUTED', 'REFUNDED', 'provider')).toBe('REFUNDED');
    expect(() => transitionRequest('DISPUTED', 'REFUNDED', 'owner')).toThrow('actor');
  });
});
