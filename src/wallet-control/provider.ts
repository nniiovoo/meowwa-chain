import type { PrivyAgentSignerPolicy } from './policy.js';

export interface WalletControlProviderInspection {
  privyUserId: string;
  embeddedWalletId: string;
  smartWalletAddress: string;
  smartWalletType: 'embedded_hd' | 'safe' | 'unknown';
  userLinked: boolean;
  ownerResourceId?: string | null;
  agentSigners: Array<{ signerId: string; overridePolicyIds: string[] }>;
  policy: {
    policyId: string;
    digest: string;
    ownerType: 'privy_user' | 'key_quorum' | 'unknown';
    ownerResourceId?: string | null;
  };
}

export interface WalletControlAttestationProvider {
  verifyAttestedControl(input: {
    embeddedWalletId: string;
    smartWalletAddress: string;
    ownerResourceId: string;
    agentSignerId: string;
    agentPolicyId: string;
    expectedPolicy: PrivyAgentSignerPolicy;
    /**
     * The Privy user the owning key quorum must resolve to. Required, and deliberately not
     * optional: without it the quorum's sole member can be swapped after provisioning and the
     * wallet still attests as owner-controlled. Pass null only where the expected identity is
     * genuinely unavailable — attestation then fails closed.
     */
    expectedPrivyUserId: string | null;
  }): Promise<boolean>;
}

export interface WalletControlProvider {
  createUserOwnedPolicy(input: {
    privyUserId: string;
    policy: PrivyAgentSignerPolicy;
    idempotencyKey: string;
  }): Promise<{ policyId: string; digest: string; ownerType: 'privy_user' | 'key_quorum' | 'unknown' }>;
  provisionUserWallet(input: {
    privyUserId: string;
    externalId: string;
    agentSignerId: string;
    agentPolicyId: string;
    idempotencyKey: string;
  }): Promise<{ embeddedWalletId: string; smartWalletAddress: string }>;
  rotateUserWalletPolicy?(input: {
    privyUserId: string;
    authorizationToken: string;
    embeddedWalletId: string;
    agentSignerId: string;
    agentPolicyId: string;
  }): Promise<void>;
  inspectBinding(input: {
    privyUserId: string;
    embeddedWalletId: string;
    smartWalletAddress: string;
    agentPolicyId: string;
    expectedPolicy: PrivyAgentSignerPolicy;
  }): Promise<WalletControlProviderInspection>;
  /**
   * Reports whether a wallet already exists for a binding's write-once external ID. A policy
   * only ever reaches the agent signer through wallet creation with that external ID, so no
   * wallet proves an abandoned policy is orphaned; a surviving wallet means the policy may
   * still govern a live signer. Providers that cannot answer leave this undefined and the
   * service fails closed.
   */
  findProvisionedWallet?(input: { externalId: string; privyUserId?: string }): Promise<
    {
      embeddedWalletId: string;
      smartWalletAddress?: string;
      ownerResourceId?: string | null;
      userLinked?: boolean;
      agentSigners: Array<{ signerId: string; overridePolicyIds: string[] }>;
    } | undefined
  >;
}
