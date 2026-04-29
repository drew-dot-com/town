/**
 * x402 facilitator endpoints: POST /verify and POST /settle.
 *
 * Implements the Coinbase x402 facilitator spec, allowing any x402-enabled
 * server (ARIO, Anyone Protocol, etc.) to use this TOON node as a drop-in
 * payment facilitator without custom integration.
 *
 * Flow:
 *   Server → POST /verify (check sig/balance/nonce) → { isValid, payer }
 *   Server serves resource
 *   Server → POST /settle (same checks + on-chain tx) → { success, txHash }
 *
 * @module
 */

import type { Context } from 'hono';
import { verifyEip3009Auth } from './x402-preflight.js';
import { settleEip3009 } from './x402-settlement.js';
import type { X402SettlementConfig } from './x402-settlement.js';
import type {
  Eip3009Authorization,
  X402FacilitatorRequest,
  X402SignedPaymentPayload,
  X402PaymentRequirements,
  X402VerifyResponse,
  X402SettleResponse,
} from './x402-types.js';
import type { ChainPreset } from '@toon-protocol/core';
import type { PublicClient, WalletClient } from 'viem';

export interface X402FacilitatorHandlerConfig {
  /** Whether x402 is enabled for this node. Gates both /verify and /settle. */
  x402Enabled: boolean;
  /** Resolved chain configuration (chain ID, USDC address, RPC URL). */
  chainConfig: ChainPreset;
  /** Facilitator EVM address — must match paymentRequirements.payTo. */
  facilitatorAddress: string;
  /** viem public client for balance/nonce read-only checks (optional). */
  publicClient?: PublicClient;
  /** viem wallet client for submitting transferWithAuthorization (required for /settle). */
  walletClient?: WalletClient;
}

export interface X402FacilitatorHandler {
  handleVerify: (c: Context) => Promise<Response>;
  handleSettle: (c: Context) => Promise<Response>;
}

export function createX402FacilitatorHandler(
  config: X402FacilitatorHandlerConfig
): X402FacilitatorHandler {
  return {
    async handleVerify(c: Context): Promise<Response> {
      if (!config.x402Enabled) {
        return c.json({ error: 'x402 not enabled' }, 404);
      }

      let body: X402FacilitatorRequest;
      try {
        body = (await c.req.json()) as X402FacilitatorRequest;
      } catch {
        return c.json(
          { isValid: false, invalidReason: 'Invalid request body', payer: null } satisfies X402VerifyResponse
        );
      }

      const requirementsError = validateRequirements(body.paymentRequirements, config);
      if (requirementsError) {
        return c.json(
          { isValid: false, invalidReason: requirementsError, payer: null } satisfies X402VerifyResponse
        );
      }

      let auth: Eip3009Authorization;
      try {
        auth = decodePaymentPayload(body.paymentPayload);
      } catch {
        return c.json(
          { isValid: false, invalidReason: 'Invalid paymentPayload', payer: null } satisfies X402VerifyResponse
        );
      }

      const result = await verifyEip3009Auth(auth, config.chainConfig, config.publicClient);

      return c.json({
        isValid: result.valid,
        invalidReason: result.invalidReason ?? null,
        payer: result.valid ? auth.from : null,
      } satisfies X402VerifyResponse);
    },

    async handleSettle(c: Context): Promise<Response> {
      if (!config.x402Enabled) {
        return c.json({ error: 'x402 not enabled' }, 404);
      }

      let body: X402FacilitatorRequest;
      try {
        body = (await c.req.json()) as X402FacilitatorRequest;
      } catch {
        return c.json(
          {
            success: false,
            txHash: null,
            networkId: null,
            errorReason: 'Invalid request body',
          } satisfies X402SettleResponse,
          400
        );
      }

      const network = body.paymentRequirements?.network ?? null;

      const requirementsError = validateRequirements(body.paymentRequirements, config);
      if (requirementsError) {
        return c.json({
          success: false,
          txHash: null,
          networkId: network,
          errorReason: requirementsError,
        } satisfies X402SettleResponse);
      }

      let auth: Eip3009Authorization;
      try {
        auth = decodePaymentPayload(body.paymentPayload);
      } catch {
        return c.json({
          success: false,
          txHash: null,
          networkId: network,
          errorReason: 'Invalid paymentPayload',
        } satisfies X402SettleResponse);
      }

      // Re-verify before settling — never trust that /verify was called first.
      const verifyResult = await verifyEip3009Auth(auth, config.chainConfig, config.publicClient);
      if (!verifyResult.valid) {
        return c.json({
          success: false,
          txHash: null,
          networkId: network,
          errorReason: verifyResult.invalidReason ?? 'Verification failed',
        } satisfies X402SettleResponse);
      }

      if (!config.walletClient) {
        console.error('[x402-facilitator] Settlement attempted but walletClient not configured');
        return c.json(
          {
            success: false,
            txHash: null,
            networkId: network,
            errorReason: 'Internal server error',
          } satisfies X402SettleResponse,
          500
        );
      }

      const settlementConfig: X402SettlementConfig = {
        chainConfig: config.chainConfig,
        walletClient: config.walletClient,
        publicClient: config.publicClient,
      };

      const result = await settleEip3009(auth, settlementConfig);

      return c.json({
        success: result.success,
        txHash: result.txHash ?? null,
        networkId: network,
        errorReason: result.error ?? null,
      } satisfies X402SettleResponse);
    },
  };
}

/**
 * Validate paymentRequirements against this node's configuration.
 * Returns an error string if validation fails, null if valid.
 */
function validateRequirements(
  requirements: X402PaymentRequirements | undefined,
  config: X402FacilitatorHandlerConfig
): string | null {
  if (!requirements) return 'Missing paymentRequirements';
  if (requirements.scheme !== 'exact') {
    return `Unsupported scheme "${requirements.scheme}": only "exact" is supported`;
  }
  if (!requirements.payTo || requirements.payTo.toLowerCase() !== config.facilitatorAddress.toLowerCase()) {
    return 'payTo address does not match this facilitator address';
  }
  if (!requirements.asset || requirements.asset.toLowerCase() !== config.chainConfig.usdcAddress.toLowerCase()) {
    return 'asset does not match USDC address for this chain';
  }
  return null;
}

/**
 * Decode a base64-encoded X402SignedPaymentPayload and extract an
 * Eip3009Authorization with split v/r/s components.
 *
 * The x402 spec uses a combined 65-byte signature (r+s+v ordering),
 * while our existing EIP-3009 infrastructure uses split v, r, s fields.
 */
function decodePaymentPayload(paymentPayload: string): Eip3009Authorization {
  const json = Buffer.from(paymentPayload, 'base64').toString('utf-8');
  const parsed = JSON.parse(json) as X402SignedPaymentPayload;

  const { signature, authorization } = parsed.payload;

  // Signature is 65 bytes: r (32 bytes = 64 hex) + s (32 bytes = 64 hex) + v (1 byte = 2 hex)
  const sig = signature.startsWith('0x') ? signature.slice(2) : signature;
  if (sig.length !== 130) {
    throw new Error(`Invalid signature length: expected 130 hex chars, got ${sig.length}`);
  }
  const r = `0x${sig.slice(0, 64)}`;
  const s = `0x${sig.slice(64, 128)}`;
  const v = parseInt(sig.slice(128, 130), 16);

  return {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: Number(authorization.validAfter),
    validBefore: Number(authorization.validBefore),
    nonce: authorization.nonce,
    v,
    r,
    s,
  };
}
