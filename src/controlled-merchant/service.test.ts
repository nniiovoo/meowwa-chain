import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { MerchantIdentityConflictError } from '../merchant-reconciliation/repository.js';
import { ControlledMerchantRepository } from './repository.js';
import { FirstPartyControlledMerchantService } from './service.js';

const merchant = `0x${'4'.repeat(40)}` as const;
const pet = `0x${'5'.repeat(40)}` as const;
const paymentHash = `0x${'1'.repeat(64)}` as const;
const refundHash = keccak256('0x1234');
const blockHash = `0x${'3'.repeat(64)}` as const;
const orderReference = `mwo_${'a'.repeat(61)}`;
const refundReference = `mwr_${'b'.repeat(61)}`;
const now = new Date('2026-07-17T12:01:00.000Z');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(
  prepared = { transactionHash: refundHash, serializedTransaction: '0x1234' as `0x${string}` },
  paymentBlockTimestamp = now.toISOString(),
) {
  let currentNow = now;
  const repository = new ControlledMerchantRepository(':memory:', { now: () => currentNow });
  let status: 'pending' | 'confirmed' | 'failed' = 'pending';
  const paymentReader = {
    verifyPayment: vi.fn(async () => ({
      sender: pet,
      transactionHash: paymentHash,
      blockHash,
      blockNumber: 100,
      blockTimestamp: paymentBlockTimestamp,
      logIndex: 2,
    })),
  };
  const refundExecutor = {
    prepareRefund: vi.fn(async () => prepared),
    broadcastAndConfirm: vi.fn(async () => {
      const persisted = repository.getRefund(refundReference);
      expect(persisted).toMatchObject({ transactionHash: refundHash, serializedTransaction: '0x1234' });
      return status;
    }),
  };
  const service = new FirstPartyControlledMerchantService({
    repository,
    paymentReader,
    refundExecutor,
    merchantRecipient: merchant,
    providerRevision: 'poc-merchant-2026-07-17',
    confirmations: 2,
    now: () => currentNow,
  });
  return {
    repository, service, paymentReader, refundExecutor,
    setRefundStatus(value: typeof status) { status = value; },
    setNow(value: Date) { currentNow = value; },
  };
}

it('journals the controlled merchant schema migration', () => {
  const repository = new ControlledMerchantRepository(':memory:', { now: () => now });
  expect(repository.appliedMigrationVersions()).toEqual([1]);
  repository.close();
});

it('rejects a controlled merchant database created by a newer binary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meowwa-controlled-merchant-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'merchant.sqlite');
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE controlled_merchant_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    );
    INSERT INTO controlled_merchant_schema_migrations VALUES (2, '${'a'.repeat(64)}', '${now.toISOString()}');
  `);
  database.close();

  expect(() => new ControlledMerchantRepository(path, { now: () => now }))
    .toThrow('unsupported newer schema');
});

it('rejects malformed controlled-merchant quote evidence before persistence', () => {
  const repository = new ControlledMerchantRepository(':memory:', { now: () => now });
  expect(() => repository.putQuote({
    quoteId: 'quote_invalid', providerRevision: 'revision_1', merchantId: 'merchant_1', merchantName: 'Merchant',
    merchantRecipient: merchant, productId: 'product_usual_food_1', productName: 'Usual Food', amountMinor: 1299,
    taxMinor: 0, shippingMinor: 0, feesMinor: 0, verifiedAt: 'not-a-time', expiresAt: 'also-not-a-time',
  })).toThrow(/quote timestamp/i);
  expect(repository.getQuote('quote_invalid')).toBeUndefined();
  repository.close();
});

async function confirmedOrder(service: FirstPartyControlledMerchantService) {
  const quotes = await service.fetchQuotes();
  const quote = quotes[0]!;
  return service.createOrder({
    providerReference: orderReference,
    quoteId: quote.quoteId,
    requestId: 'request_1',
    amountMinor: quote.amountMinor,
    paymentTransactionHash: paymentHash,
  });
}

describe('first-party controlled merchant service', () => {
  it('verifies one exact Base payment and idempotently confirms the matching order', async () => {
    const { repository, service, paymentReader } = fixture();
    const first = await confirmedOrder(service);
    const replay = await confirmedOrder(service);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ providerReference: orderReference, status: 'confirmed' });
    expect(paymentReader.verifyPayment).toHaveBeenCalledTimes(1);
    expect(paymentReader.verifyPayment).toHaveBeenCalledWith({
      transactionHash: paymentHash,
      recipient: merchant,
      amountAtomic: '12990000',
      confirmations: 2,
    });
    expect(repository.getOrder(orderReference)).toMatchObject({
      petWalletAddress: pet,
      paymentBlockHash: blockHash,
      paymentBlockNumber: 100,
      paymentLogIndex: 2,
    });
    repository.close();
  });

  it('honors the quote when the confirmed payment block predates expiry', async () => {
    const accepted = fixture(undefined, '2026-07-17T12:14:59.000Z');
    const quote = (await accepted.service.fetchQuotes())[0]!;
    accepted.setNow(new Date('2026-07-17T12:16:00.000Z'));
    await expect(accepted.service.createOrder({
      providerReference: orderReference, quoteId: quote.quoteId, requestId: 'request_1',
      amountMinor: quote.amountMinor, paymentTransactionHash: paymentHash,
    })).resolves.toMatchObject({ status: 'confirmed' });
    accepted.repository.close();

    const rejected = fixture(undefined, '2026-07-17T12:15:00.000Z');
    const expired = (await rejected.service.fetchQuotes())[0]!;
    rejected.setNow(new Date('2026-07-17T12:16:00.000Z'));
    await expect(rejected.service.createOrder({
      providerReference: orderReference, quoteId: expired.quoteId, requestId: 'request_1',
      amountMinor: expired.amountMinor, paymentTransactionHash: paymentHash,
    })).rejects.toThrow('expired');
    rejected.repository.close();
  });

  it('rejects malformed durable quote timestamps even if legacy data bypassed repository validation', async () => {
    const { repository, service } = fixture();
    const quote = (await service.fetchQuotes())[0]!;
    repository.getQuote = () => ({ ...quote, verifiedAt: 'not-a-time', expiresAt: 'also-not-a-time' });

    await expect(service.createOrder({
      providerReference: orderReference, quoteId: quote.quoteId, requestId: 'request_1',
      amountMinor: quote.amountMinor, paymentTransactionHash: paymentHash,
    })).rejects.toThrow('expired, or inconsistent');
    repository.close();
  });

  it('persists the signed raw refund before broadcast and reuses it across retries', async () => {
    const { repository, service, refundExecutor, setRefundStatus } = fixture();
    const order = await confirmedOrder(service);
    const input = {
      providerReference: refundReference,
      providerOrderId: order.providerOrderId,
      requestId: 'request_1',
      amountMinor: 1299,
    };

    await expect(service.createRefund(input)).resolves.toMatchObject({
      providerReference: refundReference,
      status: 'pending',
      transactionHash: refundHash,
    });
    setRefundStatus('confirmed');
    await expect(service.getRefund(refundReference)).resolves.toMatchObject({
      status: 'confirmed',
      transactionHash: refundHash,
    });
    expect(refundExecutor.prepareRefund).toHaveBeenCalledTimes(1);
    expect(refundExecutor.broadcastAndConfirm).toHaveBeenCalledTimes(2);
    repository.close();
  });

  it('keeps refund endpoints working when another signed refund cannot be re-broadcast', async () => {
    const { repository, service, refundExecutor } = fixture();
    const order = await confirmedOrder(service);
    // A stranded signed refund from an earlier request, still awaiting its first confirmation.
    const stranded = `mwr_${'c'.repeat(61)}`;
    repository.listSignedPendingRefunds = () => [{
      providerReference: stranded,
      transactionHash: `0x${'e'.repeat(64)}`,
      serializedTransaction: '0xdead',
    }] as never;
    // Re-broadcasting a transaction already in the mempool rejects at the RPC.
    refundExecutor.broadcastAndConfirm.mockRejectedValue(new Error('already known'));

    // The endpoint must still answer instead of failing for every pet...
    await expect(service.createRefund({
      providerReference: refundReference, providerOrderId: order.providerOrderId,
      requestId: 'request_1', amountMinor: 1299,
    })).resolves.toMatchObject({ providerReference: refundReference, status: 'pending' });
    // ...and must not sign a second refund at a nonce the stranded one still holds.
    expect(repository.getRefund(refundReference)?.transactionHash).toBeUndefined();
    expect(refundExecutor.prepareRefund).not.toHaveBeenCalled();
    repository.close();
  });

  it('rejects idempotency conflicts and refunds that do not match the confirmed order', async () => {
    const { repository, service } = fixture();
    const quotes = await service.fetchQuotes();
    await confirmedOrder(service);
    await expect(service.createOrder({
      providerReference: orderReference,
      quoteId: quotes[1]!.quoteId,
      requestId: 'request_2',
      amountMinor: quotes[1]!.amountMinor,
      paymentTransactionHash: `0x${'9'.repeat(64)}`,
    })).rejects.toBeInstanceOf(MerchantIdentityConflictError);
    await expect(service.createRefund({
      providerReference: refundReference,
      providerOrderId: 'order_missing',
      requestId: 'request_1',
      amountMinor: 1299,
    })).rejects.toThrow('does not match');
    repository.close();
  });

  it('never persists or broadcasts a signer response whose hash does not match its raw transaction', async () => {
    const { repository, service, refundExecutor } = fixture({
      transactionHash: `0x${'9'.repeat(64)}`,
      serializedTransaction: '0x1234',
    });
    const order = await confirmedOrder(service);
    await expect(service.createRefund({
      providerReference: refundReference,
      providerOrderId: order.providerOrderId,
      requestId: 'request_1',
      amountMinor: 1299,
    })).rejects.toThrow('invalid transaction data');
    expect(repository.getRefund(refundReference)).toMatchObject({ status: 'pending' });
    expect(repository.getRefund(refundReference)?.transactionHash).toBeUndefined();
    expect(refundExecutor.broadcastAndConfirm).not.toHaveBeenCalled();
    repository.close();
  });
});
