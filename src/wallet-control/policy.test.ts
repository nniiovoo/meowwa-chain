import { describe, expect, it } from 'vitest';
import { CHAINS, SOLANA_DEVNET_USDC_MINT, SOLANA_MAINNET_USDC_MINT, encodeBase58 } from '@meowwa/chain-domain';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  buildAgentSignerPolicy,
  evaluateAgentTransfer,
  formatUsdcAmountAtomic,
  parseUsdcAmountAtomic,
  policyDigest,
} from './policy.js';

const recipient = '0x1111111111111111111111111111111111111111' as const;
const config = {
  ownerPrivyUserId: 'did:privy:owner_123',
  petId: 'pet_mochi',
  allowedRecipients: [recipient],
  perTransactionLimitAtomic: '25000000',
  validUntil: '2026-07-15T12:00:00.000Z',
};

const allowedAction = {
  method: 'transfer',
  chainId: BASE_SEPOLIA_CHAIN_ID,
  to: BASE_SEPOLIA_USDC,
  valueAtomic: '0',
  functionName: 'transfer',
  recipient,
  amountAtomic: '12000000',
};

describe('sandbox agent signer policy', () => {
  it('uses only canonical Base Sepolia test USDC and a user-owned default-deny policy', () => {
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
    expect(BASE_SEPOLIA_USDC).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');

    const policy = buildAgentSignerPolicy(config);
    expect(policy).toMatchObject({
      chain_type: 'ethereum',
      version: '1.0',
      owner: { user_id: 'did:privy:owner_123' },
      rules: [{ method: 'transfer', action: 'ALLOW' }],
    });
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules.some((rule) => (rule.method as string) === '*')).toBe(false);
    expect(JSON.stringify(policy)).not.toContain('private_key');
  });

  it('produces a deterministic digest independent of recipient case and order', () => {
    const left = buildAgentSignerPolicy({
      ...config,
      allowedRecipients: [
        '0x2222222222222222222222222222222222222222',
        '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ],
    });
    const right = buildAgentSignerPolicy({
      ...config,
      allowedRecipients: [
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0x2222222222222222222222222222222222222222',
      ],
    });
    expect(policyDigest(left)).toBe(policyDigest(right));
    expect(policyDigest(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps provider policy names private, deterministic, and below Privy\'s 50-character limit', () => {
    const longPetId = `pet_${'a'.repeat(251)}`;
    const first = buildAgentSignerPolicy({ ...config, petId: longPetId });
    const repeated = buildAgentSignerPolicy({ ...config, petId: longPetId });
    const other = buildAgentSignerPolicy({ ...config, petId: `pet_${'b'.repeat(251)}` });

    expect(first.name.length).toBeLessThan(50);
    expect(first.name).toBe(repeated.name);
    expect(first.name).not.toBe(other.name);
    expect(first.name).not.toContain(longPetId);
  });

  it('converts USDC atomic and decimal amounts without precision loss', () => {
    expect(formatUsdcAmountAtomic('12990000')).toBe('12.99');
    expect(formatUsdcAmountAtomic('1000000')).toBe('1');
    expect(formatUsdcAmountAtomic('1')).toBe('0.000001');
    expect(parseUsdcAmountAtomic('12.990000')).toBe('12990000');
    expect(() => parseUsdcAmountAtomic('0.0000001')).toThrow('Invalid USDC amount');
  });

  it('allows only the exact configured transfer before expiry', () => {
    expect(evaluateAgentTransfer(config, allowedAction, new Date('2026-07-14T12:00:00.000Z'))).toEqual({ allowed: true });
  });

  it.each([
    ['wrong-method', { method: 'personal_sign' }],
    ['wrong-chain', { chainId: 8453 }],
    ['wrong-token', { to: '0x2222222222222222222222222222222222222222' }],
    ['native-value', { valueAtomic: '1' }],
    ['wrong-function', { functionName: 'approve' }],
    ['wrong-recipient', { recipient: '0x3333333333333333333333333333333333333333' }],
    ['amount-exceeds-limit', { amountAtomic: '25000001' }],
    ['invalid-amount', { amountAtomic: '-1' }],
  ] as const)('denies %s', (reason, patch) => {
    expect(evaluateAgentTransfer(config, { ...allowedAction, ...patch }, new Date('2026-07-14T12:00:00.000Z'))).toEqual({ allowed: false, reason });
  });

  it('denies an action at or after expiry', () => {
    expect(evaluateAgentTransfer(config, allowedAction, new Date(config.validUntil))).toEqual({ allowed: false, reason: 'authorization-expired' });
    expect(evaluateAgentTransfer(config, allowedAction, new Date(Number.NaN))).toEqual({ allowed: false, reason: 'invalid-time' });
  });

  it('rejects malformed or unsafe policy configuration', () => {
    expect(() => buildAgentSignerPolicy({ ...config, ownerPrivyUserId: '' })).toThrow('Invalid Privy user ID');
    expect(() => buildAgentSignerPolicy({ ...config, allowedRecipients: [] })).toThrow('At least one recipient');
    expect(() => buildAgentSignerPolicy({ ...config, allowedRecipients: ['not-an-address'] })).toThrow('Invalid recipient');
    expect(() => buildAgentSignerPolicy({ ...config, allowedRecipients: ['0x0000000000000000000000000000000000000000'] })).toThrow('Invalid recipient');
    expect(() => buildAgentSignerPolicy({ ...config, perTransactionLimitAtomic: '0' })).toThrow('Invalid per-transaction limit');
    expect(() => buildAgentSignerPolicy({ ...config, perTransactionLimitAtomic: String(2n ** 256n) })).toThrow('Invalid per-transaction limit');
    expect(() => buildAgentSignerPolicy({ ...config, validUntil: 'not-a-date' })).toThrow('Invalid policy expiry');
  });
});

describe('Solana devnet agent signer policy', () => {
  const solanaRecipient = encodeBase58(new Uint8Array(32).fill(0x42));
  const solanaConfig = { ...config, allowedRecipients: [solanaRecipient] };
  const solanaAction = {
    method: 'transfer', caip2: CHAINS.solana_devnet.caip2, to: SOLANA_DEVNET_USDC_MINT, valueAtomic: '0',
    functionName: 'transfer', recipient: solanaRecipient, amountAtomic: '12000000',
  };
  const at = new Date('2026-07-14T12:00:00.000Z');

  it('builds the same default-deny transfer rule for a Solana wallet, naming the Solana network and wallet type', () => {
    const policy = buildAgentSignerPolicy(solanaConfig, CHAINS.solana_devnet);
    expect(policy).toMatchObject({ chain_type: 'solana', version: '1.0', owner: { user_id: 'did:privy:owner_123' }, rules: [{ method: 'transfer', action: 'ALLOW' }] });
    expect(policy.name.length).toBeLessThan(50);
    expect(policy.rules[0]!.conditions).toEqual(expect.arrayContaining([
      { field: 'source.chain', field_source: 'action_request_body', operator: 'eq', value: 'solana_devnet' },
      { field: 'destination.address', field_source: 'action_request_body', operator: 'in', value: [solanaRecipient] },
      { field: 'source.amount', field_source: 'action_request_body', operator: 'lte', value: '25' },
    ]));
    // A Solana policy is a different policy from the Base one for the same owner and limits.
    expect(policyDigest(policy)).not.toBe(policyDigest(buildAgentSignerPolicy(config)));
    expect(policyDigest(policy)).toBe(policyDigest(buildAgentSignerPolicy(solanaConfig, CHAINS.solana_devnet)));
  });

  it('refuses recipients of the wrong family and the burn sink for the chain it is built for', () => {
    expect(() => buildAgentSignerPolicy({ ...config, allowedRecipients: [recipient] }, CHAINS.solana_devnet)).toThrow('Invalid recipient');
    expect(() => buildAgentSignerPolicy({ ...config, allowedRecipients: ['1'.repeat(32)] }, CHAINS.solana_devnet)).toThrow('Invalid recipient');
    expect(() => buildAgentSignerPolicy(solanaConfig)).toThrow('Invalid recipient');
  });

  it('allows only the exact configured Solana transfer', () => {
    expect(evaluateAgentTransfer(solanaConfig, solanaAction, at, CHAINS.solana_devnet)).toEqual({ allowed: true });
  });

  it.each([
    ['wrong-chain', { caip2: CHAINS.solana.caip2 }],
    ['wrong-chain', { caip2: undefined, chainId: 84532 }],
    ['wrong-token', { to: SOLANA_MAINNET_USDC_MINT }],
    ['wrong-recipient', { recipient: encodeBase58(new Uint8Array(32).fill(0x43)) }],
    ['wrong-recipient', { recipient: solanaRecipient.toLowerCase() }],
    ['amount-exceeds-limit', { amountAtomic: '25000001' }],
  ] as const)('denies %s on Solana', (reason, patch) => {
    expect(evaluateAgentTransfer(solanaConfig, { ...solanaAction, ...patch }, at, CHAINS.solana_devnet)).toEqual({ allowed: false, reason });
  });

  it('does not let a Base action pass a Solana policy or the reverse', () => {
    expect(evaluateAgentTransfer(solanaConfig, allowedAction, at, CHAINS.solana_devnet)).toEqual({ allowed: false, reason: 'wrong-chain' });
    expect(evaluateAgentTransfer(config, solanaAction, at)).toEqual({ allowed: false, reason: 'wrong-chain' });
    // A recipient list of the wrong family is a configuration error, not a transfer decision.
    expect(() => evaluateAgentTransfer(config, allowedAction, at, CHAINS.solana_devnet)).toThrow('Invalid recipient');
  });
});
