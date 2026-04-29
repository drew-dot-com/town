/**
 * Tests for x402 facilitator endpoints: POST /verify and POST /settle.
 *
 * Validates:
 * - /verify happy path returns { isValid: true, payer }
 * - /verify returns isValid: false on bad signature
 * - /verify returns isValid: false on wrong payTo address
 * - /verify returns isValid: false on wrong asset address
 * - /verify returns isValid: false on unsupported scheme
 * - /settle happy path returns { success: true, txHash }
 * - /settle returns success: false when settlement fails
 * - /settle re-verifies before settling (bad sig → no settlement attempt)
 * - Both endpoints return 404 when x402Enabled is false
 * - Invalid base64 paymentPayload returns isValid: false (not a 500)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createX402FacilitatorHandler } from './x402-facilitator-handler.js';
import type { X402FacilitatorHandlerConfig } from './x402-facilitator-handler.js';
import type {
  X402SignedPaymentPayload,
  X402PaymentRequirements,
  X402FacilitatorRequest,
} from './x402-types.js';

// ============================================================================
// Factories
// ============================================================================

const FACILITATOR_ADDRESS = '0x' + 'b'.repeat(40);
const USDC_ADDRESS = '0x' + 'f'.repeat(40);
const PAYER_ADDRESS = '0x' + 'a'.repeat(40);

const mockChainConfig = {
  chainId: 31337,
  name: 'anvil',
  usdcAddress: USDC_ADDRESS,
  rpcUrl: 'http://localhost:8545',
  registryAddress: '',
  tokenNetworkAddress: '',
};

function makeSignedPayload(overrides: Partial<X402SignedPaymentPayload['payload']> = {}): string {
  const payload: X402SignedPaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'base-sepolia',
    payload: {
      // 65-byte signature: r(32) + s(32) + v(1) = 64+64+2 = 130 hex chars
      signature: '0x' + 'd'.repeat(64) + 'e'.repeat(64) + '1b',
      authorization: {
        from: PAYER_ADDRESS,
        to: FACILITATOR_ADDRESS,
        value: '1000000',
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: '0x' + 'c'.repeat(64),
      },
      ...overrides,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function makeRequirements(overrides: Partial<X402PaymentRequirements> = {}): X402PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '1000000',
    resource: 'https://ar.io/some-file',
    payTo: FACILITATOR_ADDRESS,
    asset: USDC_ADDRESS,
    ...overrides,
  };
}

function makeRequest(
  payloadOverrides?: Partial<X402SignedPaymentPayload['payload']>,
  requirementsOverrides?: Partial<X402PaymentRequirements>
): X402FacilitatorRequest {
  return {
    x402Version: 1,
    paymentPayload: makeSignedPayload(payloadOverrides),
    paymentRequirements: makeRequirements(requirementsOverrides),
  };
}

// ============================================================================
// Test Setup
// ============================================================================

function makeConfig(overrides: Partial<X402FacilitatorHandlerConfig> = {}): X402FacilitatorHandlerConfig {
  return {
    x402Enabled: true,
    chainConfig: mockChainConfig,
    facilitatorAddress: FACILITATOR_ADDRESS,
    ...overrides,
  };
}

function makeApp(config: X402FacilitatorHandlerConfig) {
  const app = new Hono();
  const handler = createX402FacilitatorHandler(config);
  app.post('/verify', (c) => handler.handleVerify(c));
  app.post('/settle', (c) => handler.handleSettle(c));
  return app;
}

async function post(app: Hono, path: string, body: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return app.fetch(req);
}

// ============================================================================
// Mock verifyEip3009Auth and settleEip3009 so tests don't need real crypto
// ============================================================================

vi.mock('./x402-preflight.js', () => ({
  verifyEip3009Auth: vi.fn(),
}));

vi.mock('./x402-settlement.js', () => ({
  settleEip3009: vi.fn(),
}));

import { verifyEip3009Auth } from './x402-preflight.js';
import { settleEip3009 } from './x402-settlement.js';

const mockVerify = vi.mocked(verifyEip3009Auth);
const mockSettle = vi.mocked(settleEip3009);

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ valid: true, checksPerformed: ['eip3009-signature', 'usdc-balance', 'nonce-freshness'] });
  mockSettle.mockResolvedValue({ success: true, txHash: '0xdeadbeef' });
});

// ============================================================================
// POST /verify tests
// ============================================================================

describe('POST /verify', () => {
  it('returns isValid: true with payer on happy path', async () => {
    const app = makeApp(makeConfig());
    const res = await post(app, '/verify', makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      isValid: true,
      payer: PAYER_ADDRESS,
      invalidReason: null,
    });
  });

  it('returns 404 when x402Enabled is false', async () => {
    const app = makeApp(makeConfig({ x402Enabled: false }));
    const res = await post(app, '/verify', makeRequest());
    expect(res.status).toBe(404);
  });

  it('returns isValid: false when verifyEip3009Auth fails (bad signature)', async () => {
    mockVerify.mockResolvedValue({ valid: false, invalidReason: 'eip3009-signature', checksPerformed: ['eip3009-signature'] });
    const app = makeApp(makeConfig());
    const res = await post(app, '/verify', makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      isValid: false,
      invalidReason: 'eip3009-signature',
      payer: null,
    });
  });

  it('returns isValid: false when payTo does not match facilitator address', async () => {
    const app = makeApp(makeConfig());
    const res = await post(app, '/verify', makeRequest(undefined, { payTo: '0x' + '1'.repeat(40) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toMatch(/payTo/);
    // verifyEip3009Auth should NOT be called (requirements check happens first)
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('returns isValid: false when asset does not match USDC address', async () => {
    const app = makeApp(makeConfig());
    const res = await post(app, '/verify', makeRequest(undefined, { asset: '0x' + '9'.repeat(40) }));
    const body = await res.json();
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toMatch(/asset/);
  });

  it('returns isValid: false on unsupported scheme', async () => {
    const app = makeApp(makeConfig());
    const res = await post(app, '/verify', makeRequest(undefined, { scheme: 'streaming' }));
    const body = await res.json();
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toMatch(/scheme/);
  });

  it('returns isValid: false on invalid base64 paymentPayload', async () => {
    const app = makeApp(makeConfig());
    const req = { ...makeRequest(), paymentPayload: '!!!notbase64!!!' };
    const res = await post(app, '/verify', req);
    const body = await res.json();
    expect(body.isValid).toBe(false);
    expect(res.status).not.toBe(500);
  });
});

// ============================================================================
// POST /settle tests
// ============================================================================

describe('POST /settle', () => {
  it('returns success: true with txHash on happy path', async () => {
    const app = makeApp(makeConfig({ walletClient: {} as unknown as import('viem').WalletClient }));
    const res = await post(app, '/settle', makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      txHash: '0xdeadbeef',
      networkId: 'base-sepolia',
      errorReason: null,
    });
  });

  it('returns 404 when x402Enabled is false', async () => {
    const app = makeApp(makeConfig({ x402Enabled: false }));
    const res = await post(app, '/settle', makeRequest());
    expect(res.status).toBe(404);
  });

  it('returns success: false when verifyEip3009Auth fails (re-verify before settle)', async () => {
    mockVerify.mockResolvedValue({ valid: false, invalidReason: 'nonce-freshness', checksPerformed: ['eip3009-signature', 'usdc-balance', 'nonce-freshness'] });
    const app = makeApp(makeConfig({ walletClient: {} as unknown as import('viem').WalletClient }));
    const res = await post(app, '/settle', makeRequest());
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorReason).toBe('nonce-freshness');
    // Settlement must NOT be attempted if verification fails
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('returns success: false when settlement fails on-chain', async () => {
    mockSettle.mockResolvedValue({ success: false, error: 'Transaction reverted on-chain' });
    const app = makeApp(makeConfig({ walletClient: {} as unknown as import('viem').WalletClient }));
    const res = await post(app, '/settle', makeRequest());
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorReason).toBe('Transaction reverted on-chain');
    expect(body.txHash).toBeNull();
  });

  it('returns 500 when walletClient is not configured', async () => {
    // No walletClient provided → can't settle
    const app = makeApp(makeConfig()); // no walletClient
    const res = await post(app, '/settle', makeRequest());
    expect(res.status).toBe(500);
  });
});
