export type WalletExecutionStatus =
  | 'prepared'
  | 'submitting'
  | 'submitted'
  | 'provider_confirmed'
  | 'confirmed'
  | 'unknown'
  | 'failed'
  | 'review_required';

export interface WalletExecutionSubmission {
  submissionId: string;
  requestId: string;
  ownerId: string;
  petId: string;
  bindingId: string;
  providerWalletId: string;
  intentHash: string;
  referenceId: string;
  chainId: 84532;
  contract: string;
  sender: string;
  recipient: string;
  amountAtomic: string;
  valueAtomic: '0';
  calldata: `0x${string}`;
  status: WalletExecutionStatus;
  providerTransactionId: string | null;
  userOperationHash: `0x${string}` | null;
  transactionHash: `0x${string}` | null;
  blockHash: `0x${string}` | null;
  blockNumber: number | null;
  logIndex: number | null;
  failureCode: string | null;
  confirmedAt: string | null;
  applicationSettledAt: string | null;
  reviewRequiredAt: string | null;
  reviewReason: string | null;
  /** Blind re-submissions already attempted: replays with no provider transaction id to poll. */
  blindSubmitAttempts: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface WalletExecutionEvent {
  eventId: string;
  submissionId: string;
  kind: string;
  fromStatus: WalletExecutionStatus | null;
  toStatus: WalletExecutionStatus;
  detail: string | null;
  createdAt: string;
}

export type PrepareWalletExecutionInput = Pick<WalletExecutionSubmission,
  | 'submissionId'
  | 'requestId'
  | 'ownerId'
  | 'petId'
  | 'bindingId'
  | 'providerWalletId'
  | 'intentHash'
  | 'referenceId'
  | 'chainId'
  | 'contract'
  | 'sender'
  | 'recipient'
  | 'amountAtomic'
  | 'valueAtomic'
  | 'calldata'
>;
