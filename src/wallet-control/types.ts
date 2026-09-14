type WalletControlEnvironment = 'sandbox';
export type WalletControlStatus =
  | 'requested'
  | 'provisioning'
  | 'active'
  | 'paused'
  | 'recovery_pending'
  | 'recovered'
  | 'revoked'
  | 'drifted'
  | 'failed';
export type AgentSignerStatus = 'pending' | 'attached' | 'revoked' | 'drifted';
export type OwnerEscapeStatus = 'unverified' | 'verified' | 'failed';

export interface WalletControlBinding {
  bindingId: string;
  ownerId: string;
  petId: string;
  appWalletId: string;
  privyUserId: string;
  privyEmbeddedWalletId: string | null;
  smartWalletAddress: string | null;
  environment: WalletControlEnvironment;
  chainId: 84532;
  usdcContract: string;
  smartWalletType: 'embedded_hd' | 'safe';
  ownerType: 'privy_user';
  agentSignerId: string;
  agentPolicyId: string | null;
  expectedPolicyDigest: string;
  expectedPolicyJson: string;
  status: WalletControlStatus;
  signerStatus: AgentSignerStatus;
  ownerEscapeStatus: OwnerEscapeStatus;
  provisioningVersion: 1;
  lastVerifiedAt: string | null;
  escapeVerifiedAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface WalletControlEvent {
  eventId: string;
  bindingId: string;
  kind: string;
  fromStatus: WalletControlStatus | null;
  toStatus: WalletControlStatus;
  detail: string | null;
  createdAt: string;
}

export interface AgentSignerPolicyConfig {
  ownerPrivyUserId: string;
  petId: string;
  allowedRecipients: readonly string[];
  perTransactionLimitAtomic: string;
  validUntil: string;
}

export interface AgentTransferAction {
  method: string;
  /** EVM numeric chain ID; absent on Solana, where `caip2` names the network instead. */
  chainId?: number | undefined;
  caip2?: string | undefined;
  to: string;
  valueAtomic: string;
  functionName?: string;
  recipient?: string;
  amountAtomic?: string;
}

export type AgentTransferDecision =
  | { allowed: true }
  | { allowed: false; reason:
    | 'authorization-expired'
    | 'invalid-time'
    | 'wrong-method'
    | 'wrong-chain'
    | 'wrong-token'
    | 'native-value'
    | 'wrong-function'
    | 'wrong-recipient'
    | 'invalid-amount'
    | 'amount-exceeds-limit' };
