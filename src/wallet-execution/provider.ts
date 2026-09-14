export interface WalletExecutionProviderInput {
  embeddedWalletId: string;
  smartWalletAddress: string;
  /** CAIP-2 identifier of the chain the intent was prepared for; the provider refuses any other. */
  caip2: string;
  contract: string;
  calldata: `0x${string}`;
  referenceId: string;
  sign(payload: Uint8Array): Promise<string>;
}

export interface WalletExecutionProviderResult {
  providerTransactionId: string;
  transactionHash: `0x${string}` | null;
  userOperationHash: `0x${string}` | null;
}

export interface WalletExecutionProvider {
  submit(input: WalletExecutionProviderInput): Promise<WalletExecutionProviderResult>;
}

export type WalletExecutionProviderStatus =
  | 'broadcasted'
  | 'confirmed'
  | 'execution_reverted'
  | 'failed'
  | 'replaced'
  | 'finalized'
  | 'provider_error'
  | 'pending';

export interface WalletExecutionProviderTransaction {
  providerTransactionId: string;
  status: WalletExecutionProviderStatus;
  caip2: string;
  providerWalletId: string;
  referenceId: string | null;
  transactionHash: `0x${string}` | null;
}

export interface WalletExecutionStatusProvider {
  getTransaction(input: {
    providerTransactionId: string;
    providerWalletId: string;
    referenceId: string;
    recipient: string;
    amountAtomic: string;
  }): Promise<WalletExecutionProviderTransaction>;
}
