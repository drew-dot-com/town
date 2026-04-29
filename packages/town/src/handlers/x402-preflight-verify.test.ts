import { describe, it, expect, vi } from 'vitest';
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

// Mock viem so verifyTypedData is controllable across all tests
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, verifyTypedData: vi.fn() };
});

describe('verifyEip3009Auth', () => {
  it('returns invalid when signature check fails', async () => {
    const { verifyTypedData } = await import('viem');
    vi.mocked(verifyTypedData).mockResolvedValueOnce(false);

    const { verifyEip3009Auth } = await import('./x402-preflight.js');
    const result = await verifyEip3009Auth(mockAuth, mockChainConfig, undefined);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe('eip3009-signature');
    expect(result.checksPerformed).toEqual(['eip3009-signature']);
  });

  it('skips on-chain checks when publicClient is not provided', async () => {
    const { verifyTypedData } = await import('viem');
    vi.mocked(verifyTypedData).mockResolvedValueOnce(true);

    const { verifyEip3009Auth } = await import('./x402-preflight.js');
    // With no publicClient, balance and nonce checks are skipped (no eth_call)
    const result = await verifyEip3009Auth(mockAuth, mockChainConfig, undefined);
    // Signature passed, no client checks — should pass
    expect(result.valid).toBe(true);
    expect(result.checksPerformed).toEqual(['eip3009-signature']);
  });

  it('returns invalid with low balance when publicClient says insufficient funds', async () => {
    const { verifyTypedData } = await import('viem');
    vi.mocked(verifyTypedData).mockResolvedValueOnce(true);

    const mockPublicClient = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return Promise.resolve(0n);
        if (functionName === 'authorizationState') return Promise.resolve(false);
        return Promise.resolve(null);
      }),
    } as unknown as import('viem').PublicClient;

    const { verifyEip3009Auth } = await import('./x402-preflight.js');
    const result = await verifyEip3009Auth(mockAuth, mockChainConfig, mockPublicClient);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe('usdc-balance');
    expect(result.checksPerformed).toContain('eip3009-signature');
    expect(result.checksPerformed).toContain('usdc-balance');
  });

  it('returns invalid when nonce is already used', async () => {
    const { verifyTypedData } = await import('viem');
    vi.mocked(verifyTypedData).mockResolvedValueOnce(true);

    const mockPublicClient = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return Promise.resolve(1000000n);
        if (functionName === 'authorizationState') return Promise.resolve(true);
        return Promise.resolve(null);
      }),
    } as unknown as import('viem').PublicClient;

    const { verifyEip3009Auth } = await import('./x402-preflight.js');
    const result = await verifyEip3009Auth(mockAuth, mockChainConfig, mockPublicClient);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe('nonce-freshness');
    expect(result.checksPerformed).toContain('eip3009-signature');
    expect(result.checksPerformed).toContain('usdc-balance');
    expect(result.checksPerformed).toContain('nonce-freshness');
  });
});
