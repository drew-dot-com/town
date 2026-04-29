/**
 * EIP-3009 types and constants for the x402 publish endpoint.
 *
 * EIP-3009 (`transferWithAuthorization`) allows gasless USDC transfers:
 * the user signs an off-chain authorization, and the facilitator (node
 * operator) submits it on-chain, paying gas. The user pays only the
 * USDC transfer amount.
 *
 * @module
 */

import type { NostrEvent } from 'nostr-tools/pure';

/**
 * EIP-3009 `transferWithAuthorization` signed authorization.
 *
 * The user signs this off-chain (EIP-712 typed data). The facilitator
 * submits the signature on-chain to execute the USDC transfer.
 */
export interface Eip3009Authorization {
  /** Sender's EVM address ('0x...'). */
  from: string;
  /** Recipient's EVM address ('0x...' -- facilitator). */
  to: string;
  /** USDC amount in micro-units (bigint). */
  value: bigint;
  /** Unix timestamp: authorization valid after this time. */
  validAfter: number;
  /** Unix timestamp: authorization expires at this time. */
  validBefore: number;
  /** 32-byte nonce ('0x...' hex string). */
  nonce: string;
  /** ECDSA recovery id (27 or 28). */
  v: number;
  /** ECDSA r component ('0x...' 32 bytes). */
  r: string;
  /** ECDSA s component ('0x...' 32 bytes). */
  s: string;
}

/**
 * EIP-712 typed data structure for `transferWithAuthorization`.
 *
 * This is the type definition used for off-chain signature verification
 * and on-chain contract calls.
 *
 * NOTE: The EIP-712 domain for USDC's `transferWithAuthorization` is
 * different from the EIP-712 domain for TokenNetwork's balance proofs.
 * The x402 handler must use the USDC contract's domain.
 */
export const EIP_3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * EIP-712 domain separator for USDC's `transferWithAuthorization`.
 *
 * Uses the USDC contract's name and version, NOT the TokenNetwork's.
 */
export const USDC_EIP712_DOMAIN = {
  name: 'USD Coin',
  version: '2',
} as const;

/**
 * Minimal EventStore interface for destination reachability checks.
 * Uses structural typing to avoid importing @toon-protocol/relay directly.
 * The query method accepts Filter[] (array) per the relay's EventStore interface.
 */
export interface EventStoreLike {
  query(filters: { kinds?: number[]; authors?: string[] }[]): unknown[];
}

/**
 * Request body for the x402 `/publish` endpoint.
 *
 * The client sends a signed Nostr event and a destination ILP address.
 * The handler TOON-encodes the event before routing.
 */
export interface X402PublishRequest {
  /** Signed Nostr event. */
  event: NostrEvent;
  /** Target ILP address (e.g., "g.toon.target-relay"). */
  destination: string;
}

/**
 * Response body for a successful x402 `/publish` request (HTTP 200).
 */
export interface X402PublishResponse {
  /** Nostr event ID (64-char hex). */
  eventId: string;
  /** On-chain settlement transaction hash. */
  settlementTxHash: string;
  /** Whether the ILP PREPARE was fulfilled or rejected by the destination. */
  deliveryStatus: 'fulfilled' | 'rejected';
  /** Always false -- no refunds on REJECT per protocol design. */
  refundInitiated: false;
}

/**
 * Response body for the 402 pricing negotiation.
 */
export interface X402PricingResponse {
  /** Price in USDC micro-units (as string for BigInt serialization). */
  amount: string;
  /** Node operator's EVM address that will receive the USDC. */
  facilitatorAddress: string;
  /** Payment network identifier. */
  paymentNetwork: 'eip-3009';
  /** EVM chain ID. */
  chainId: number;
  /** USDC contract address on this chain. */
  usdcAddress: string;
}

/**
 * Minimal USDC ABI for EIP-3009 operations.
 *
 * Includes only the functions needed by the x402 handler:
 * - `balanceOf`: Read sender's USDC balance (pre-flight check #2)
 * - `authorizationState`: Check nonce freshness (pre-flight check #3)
 * - `transferWithAuthorization`: Execute gasless USDC transfer (settlement)
 */
export const USDC_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'authorizationState',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'transferWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/**
 * Decoded payload from the x402 `paymentPayload` field (base64-encoded JSON).
 * Used by the facilitator /verify and /settle endpoints.
 * Follows the Coinbase x402 "exact" scheme format.
 */
export interface X402SignedPaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    /** Combined 65-byte ECDSA signature: 0x + r(64 hex) + s(64 hex) + v(2 hex). */
    signature: string;
    authorization: {
      from: string;
      to: string;
      /** USDC amount as decimal string (e.g., "1000000"). */
      value: string;
      /** Unix timestamp as string. */
      validAfter: string;
      /** Unix timestamp as string. */
      validBefore: string;
      nonce: string;
    };
  };
}

/**
 * Payment requirements from an x402-enabled server's request to the facilitator.
 * Specifies which chain, asset, recipient, and amount are expected.
 */
export interface X402PaymentRequirements {
  /** Must be "exact" — the only scheme TOON supports. */
  scheme: string;
  /** Network identifier string (e.g., "base", "base-sepolia"). */
  network: string;
  /** Maximum USDC amount allowed (as decimal string). */
  maxAmountRequired: string;
  /** The resource URI being gated. */
  resource: string;
  description?: string;
  mimeType?: string;
  /** EVM address that must receive the payment (facilitator). */
  payTo: string;
  maxTimeoutSeconds?: number;
  /** USDC contract address for this chain. */
  asset: string;
  outputSchema?: unknown;
  extra?: unknown;
}

/**
 * Request body for POST /verify and POST /settle (Coinbase x402 spec).
 */
export interface X402FacilitatorRequest {
  x402Version: number;
  /** Base64-encoded X402SignedPaymentPayload JSON. */
  paymentPayload: string;
  paymentRequirements: X402PaymentRequirements;
}

/**
 * Response body for POST /verify.
 */
export interface X402VerifyResponse {
  isValid: boolean;
  invalidReason: string | null;
  /** Payer EVM address (0x...) on success, null on failure. */
  payer: string | null;
}

/**
 * Response body for POST /settle.
 */
export interface X402SettleResponse {
  success: boolean;
  txHash: string | null;
  /** Network identifier string echoed from paymentRequirements. */
  networkId: string | null;
  errorReason: string | null;
}
