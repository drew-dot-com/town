# x402 Facilitator Endpoints Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add spec-compliant `POST /verify` and `POST /settle` endpoints to the TOON Town node, making it a drop-in x402 facilitator that any x402-compatible client (ARIO, Anyone Protocol, etc.) can use without custom integration.

**Architecture:** Extract the first 3 EIP-3009 checks from the existing `runPreflight` pipeline into a shared `verifyEip3009Auth` function, then build a new `x402-facilitator-handler.ts` that wraps those checks in the Coinbase x402 spec request/response envelope. Wire both routes into the Hono server in `town.ts` alongside the existing `/publish` and `/health` routes, gated by the existing `x402Enabled` flag.

**Tech Stack:** TypeScript, Hono (HTTP framework), viem (EVM), vitest (tests). All in `packages/town/src/handlers/`.

---

## First step before coding

Save this plan to the project:
```bash
mkdir -p /Users/drewpierson/src/TOON/town/docs/plans
cp /Users/drewpierson/.claude/plans/hi-i-d-like-to-wondrous-cupcake.md \
   /Users/drewpierson/src/TOON/town/docs/plans/2026-04-29-x402-facilitator-endpoints.md
```

---

## Task 1: Extract `verifyEip3009Auth` from preflight (refactor)

**Files:**
- Modify: `packages/town/src/handlers/x402-preflight.ts`

The existing `runPreflight` runs 6 checks. Checks 1–3 (EIP-712 sig, USDC balance, nonce freshness) are generic EIP-3009 checks needed by the new facilitator endpoints. Checks 4–6 are TOON-specific. Extract 1–3 into a standalone exported function so both the existing `runPreflight` and the new facilitator handler can call it without duplication.

**Step 1: Write the failing test**

Add to a NEW file `packages/town/src/handlers/x402-preflight-verify.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { verifyEip3009Auth } from './x402-preflight.js';
import type { Eip3009Authorization } from './x402-types.js';

const mockAuth: Eip3009Authorization = {
  from: '0x' + 'a'.repeat(40),
  to: '0x' + 'b'.repeat(40),
  value: 1000000n,
  validAfter: 0,
  validBefore: Math.floor(Date.now() / 1000) + 3600,
  nonce: '0x' + 'c'.repeat(64),
  v: 27,
  r: '0x' + 'd'.repeat(64),
  s: '0x' + 'e'.repeat(64),
};

const mockChainConfig = {
  chainId: 31337,
  name: 'anvil',
  usdcAddress: '0x' + 'f'.repeat(40),
  rpcUrl: 'http://localhost:8545',
  registryAddress: '',
  tokenNetworkAddress: '',
};

describe('verifyEip3009Auth', () => {
  it('returns invalid when signature check fails', async () => {
    // verifyTypedData will fail because signature is mock/invalid
    const result = await verifyEip3009Auth(mockAuth, mockChainConfig, undefined);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe('eip3009-signature');
  });

  it('skips on-chain checks when publicClient is not provided', async () => {
    // With no publicClient, only signature is checked
    // Signature will fail because mock values are not real
    const result = await verifyEip3009Auth(mockAuth, mockChainConfig, undefined);
    expect(result).toMatchObject({ valid: false });
  });

  it('returns invalid with low balance when publicClient says insufficient funds', async () => {
    const mockPublicClient = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return Promise.resolve(0n);
        if (functionName === 'authorizationState') return Promise.resolve(false);
        return Promise.resolve(null);
      }),
    } as unknown as import('viem').PublicClient;

    // We need a valid sig for this test — mock verifyTypedData
    vi.mock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return { ...actual, verifyTypedData: vi.fn().mockResolvedValue(true) };
    });

    const result = await verifyEip3009Auth(mockAuth, mockChainConfig, mockPublicClient);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe('usdc-balance');
  });
});
```

**Step 2: Run test to confirm it fails**
```bash
cd /Users/drewpierson/src/TOON/town
pnpm --filter @toon-protocol/town test -- x402-preflight-verify
```
Expected: `Error: verifyEip3009Auth is not exported` or similar.

**Step 3: Implement `verifyEip3009Auth` in `x402-preflight.ts`**

Add this export ABOVE `runPreflight`. The `encodeSignature` helper already exists in the file (private) — keep it, just move it above this new function:

```typescript
/**
 * Result of EIP-3009 on-chain authorization checks (checks 1-3).
 * Shared by runPreflight and the x402 facilitator handler.
 */
export interface Eip3009VerifyResult {
  valid: boolean;
  invalidReason?: string;
}

/**
 * Run EIP-3009 authorization checks 1-3 (signature, balance, nonce freshness).
 * All checks are free (no gas). Used by both runPreflight and the facilitator
 * /verify and /settle endpoints.
 */
export async function verifyEip3009Auth(
  authorization: Eip3009Authorization,
  chainConfig: ChainPreset,
  publicClient: PublicClient | undefined
): Promise<Eip3009VerifyResult> {
  // Check 1: EIP-3009 signature verification (off-chain, ~1ms)
  try {
    const domain = {
      ...USDC_EIP712_DOMAIN,
      chainId: chainConfig.chainId,
      verifyingContract: chainConfig.usdcAddress as `0x${string}`,
    };
    const valid = await verifyTypedData({
      address: authorization.from as `0x${string}`,
      domain,
      types: EIP_3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: authorization.value,
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: encodeSignature(authorization),
    });
    if (!valid) return { valid: false, invalidReason: 'eip3009-signature' };
  } catch {
    return { valid: false, invalidReason: 'eip3009-signature' };
  }

  // Check 2: USDC balance check (read-only eth_call, ~50ms)
  if (publicClient) {
    try {
      const balance = await publicClient.readContract({
        address: chainConfig.usdcAddress as `0x${string}`,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [authorization.from as `0x${string}`],
      });
      if ((balance as bigint) < authorization.value) {
        return { valid: false, invalidReason: 'usdc-balance' };
      }
    } catch {
      return { valid: false, invalidReason: 'usdc-balance' };
    }
  }

  // Check 3: Nonce freshness check (read-only eth_call, ~50ms)
  if (publicClient) {
    try {
      const used = await publicClient.readContract({
        address: chainConfig.usdcAddress as `0x${string}`,
        abi: USDC_ABI,
        functionName: 'authorizationState',
        args: [
          authorization.from as `0x${string}`,
          authorization.nonce as `0x${string}`,
        ],
      });
      if (used) return { valid: false, invalidReason: 'nonce-freshness' };
    } catch {
      return { valid: false, invalidReason: 'nonce-freshness' };
    }
  }

  return { valid: true };
}
```

**Step 4: Replace checks 1-3 in `runPreflight` with a call to `verifyEip3009Auth`**

In `runPreflight`, replace the three check blocks (lines ~86–162) with:

```typescript
  // --- Checks 1-3: EIP-3009 signature, balance, nonce freshness ---
  checksPerformed.push('eip3009-signature', 'usdc-balance', 'nonce-freshness');
  const eip3009Result = await verifyEip3009Auth(
    authorization,
    config.chainConfig,
    config.publicClient
  );
  if (!eip3009Result.valid) {
    return {
      passed: false,
      failedCheck: eip3009Result.invalidReason,
      checksPerformed,
    };
  }
```

Then continue with the original checks 4–6 (TOON shallow parse, Schnorr, destination reachability) unchanged.

**Step 5: Run ALL existing preflight/publish tests to confirm no regression**
```bash
cd /Users/drewpierson/src/TOON/town
pnpm --filter @toon-protocol/town test -- x402
```
Expected: All existing tests pass.

**Step 6: Commit**
```bash
cd /Users/drewpierson/src/TOON/town
git add packages/town/src/handlers/x402-preflight.ts \
        packages/town/src/handlers/x402-preflight-verify.test.ts
git commit -m "refactor: extract verifyEip3009Auth from runPreflight for reuse in facilitator"
```

---

## Task 2: Add x402 facilitator types to `x402-types.ts`

**Files:**
- Modify: `packages/town/src/handlers/x402-types.ts`

**Step 1: Add the types** at the bottom of the file (after `USDC_ABI`):

```typescript
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
```

**Step 2: Run all x402 tests to confirm nothing broke**
```bash
cd /Users/drewpierson/src/TOON/town
pnpm --filter @toon-protocol/town test -- x402
```
Expected: All pass (types-only change, no behavior change).

**Step 3: Commit**
```bash
cd /Users/drewpierson/src/TOON/town
git add packages/town/src/handlers/x402-types.ts
git commit -m "feat: add x402 facilitator request/response types"
```

---

## Task 3: Write failing tests for the facilitator handler

**Files:**
- Create: `packages/town/src/handlers/x402-facilitator-handler.test.ts`

Write these tests FIRST so they drive the implementation in Task 4.

**Step 1: Create the test file**

```typescript
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
import type { X402SettlementResult } from './x402-settlement.js';

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
// Mock verifyEip3009Auth so tests don't need real crypto
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
  mockVerify.mockResolvedValue({ valid: true });
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
    mockVerify.mockResolvedValue({ valid: false, invalidReason: 'eip3009-signature' });
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
    mockVerify.mockResolvedValue({ valid: false, invalidReason: 'nonce-freshness' });
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
```

**Step 2: Run tests to confirm they fail**
```bash
cd /Users/drewpierson/src/TOON/town
pnpm --filter @toon-protocol/town test -- x402-facilitator
```
Expected: `Error: Cannot find module './x402-facilitator-handler.js'`

**Step 3: Commit the test file**
```bash
cd /Users/drewpierson/src/TOON/town
git add packages/town/src/handlers/x402-facilitator-handler.test.ts
git commit -m "test: add failing tests for x402 facilitator handler"
```

---

## Task 4: Implement `x402-facilitator-handler.ts`

**Files:**
- Create: `packages/town/src/handlers/x402-facilitator-handler.ts`

**Step 1: Create the file**

```typescript
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
```

**Step 2: Run the failing tests**
```bash
cd /Users/drewpierson/src/TOON/town
pnpm --filter @toon-protocol/town test -- x402-facilitator
```
Expected: All tests pass.

**Step 3: Run the full x402 test suite to confirm no regression**
```bash
cd /Users/drewpierson/src/TOON/town
pnpm --filter @toon-protocol/town test -- x402
```
Expected: All pass.

**Step 4: Commit**
```bash
cd /Users/drewpierson/src/TOON/town
git add packages/town/src/handlers/x402-facilitator-handler.ts
git commit -m "feat: implement x402 facilitator handler (POST /verify, POST /settle)"
```

---

## Task 5: Wire routes into `town.ts` and update service discovery

**Files:**
- Modify: `packages/town/src/town.ts`

**Step 1: Import the new handler** (add near the existing `createX402Handler` import, around line 42):

```typescript
import { createX402FacilitatorHandler } from './handlers/x402-facilitator-handler.js';
```

**Step 2: Create the facilitator handler** (add immediately after the existing `x402Handler` creation block, around line 903):

```typescript
  // --- 10e. x402 facilitator /verify and /settle routes ---
  const facilitatorHandler = createX402FacilitatorHandler({
    x402Enabled,
    chainConfig,
    facilitatorAddress: config.facilitatorAddress ?? identity.evmAddress,
    walletClient: x402WalletClient,
    publicClient: x402PublicClient,
  });

  app.post('/verify', (c: Context) => facilitatorHandler.handleVerify(c));
  app.post('/settle', (c: Context) => facilitatorHandler.handleSettle(c));
```

Place this block BEFORE the `serve()` call (line ~909).

**Step 3: Update service discovery** to advertise the facilitator endpoints.

Find the block around line 1120 that builds `serviceDiscoveryContent.x402`:

```typescript
      if (x402Enabled) {
        serviceDiscoveryContent.x402 = {
          enabled: true,
          endpoint: '/publish',
        };
      }
```

Replace with:

```typescript
      if (x402Enabled) {
        serviceDiscoveryContent.x402 = {
          enabled: true,
          endpoint: '/publish',
          facilitatorEndpoints: {
            verify: '/verify',
            settle: '/settle',
          },
        };
      }
```

**Step 4: Run the full test suite**
```bash
cd /Users/drewpierson/src/TOON/town
pnpm --filter @toon-protocol/town test
```
Expected: All pass (including existing town lifecycle tests).

**Step 5: Smoke test the routes manually** (optional but recommended if running locally):
```bash
# Start a node with x402 enabled (see CLAUDE.md for sdk-e2e-infra setup)
curl -s -X POST http://localhost:3100/verify \
  -H 'Content-Type: application/json' \
  -d '{"x402Version":1,"paymentPayload":"e30=","paymentRequirements":{"scheme":"exact","network":"base","maxAmountRequired":"1","resource":"test","payTo":"0x0000000000000000000000000000000000000000","asset":"0x0000000000000000000000000000000000000000"}}' | jq .
# Expected: { isValid: false, invalidReason: "payTo address does not match..." }
```

**Step 6: Commit**
```bash
cd /Users/drewpierson/src/TOON/town
git add packages/town/src/town.ts
git commit -m "feat: wire /verify and /settle routes + update service discovery"
```

---

## Final verification

```bash
cd /Users/drewpierson/src/TOON/town
pnpm build && pnpm test
```

Expected: Clean build, all tests pass.

---

## What was NOT built (YAGNI)

- No separate `x402FacilitatorEnabled` flag — the existing `x402Enabled` covers it
- No network string mapping (base/base-sepolia/etc.) — USDC address pins the chain unambiguously
- No separate facilitator package — can be extracted later if operators want facilitator-only nodes
- No `maxAmountRequired` enforcement — that's the gated server's job, not the facilitator's
