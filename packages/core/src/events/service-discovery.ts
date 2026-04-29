/**
 * Event builder and parser for kind:10035 Service Discovery events.
 *
 * Kind 10035 is a NIP-16 replaceable event (kind 10000-19999) published to
 * the local relay and optionally to peers. Relays store only the latest event
 * per `pubkey + kind`. The `d` tag with value `toon-service-discovery` is
 * included as a content marker for filtering.
 *
 * Service discovery events advertise a node's capabilities, pricing, and
 * endpoints so that clients and AI agents can programmatically discover
 * available services.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { SERVICE_DISCOVERY_KIND } from '../constants.js';
import type { ReputationScore } from './reputation.js';

// Re-export the constant for convenient co-located imports
export { SERVICE_DISCOVERY_KIND };

// ---------- Types ----------

/**
 * Structured skill descriptor for DVM service discovery.
 *
 * Embedded in kind:10035 events to advertise DVM capabilities.
 * Enables programmatic agent-to-agent service discovery: agents
 * can read `inputSchema` to construct valid Kind 5xxx job requests
 * without prior knowledge of the provider's capabilities.
 *
 * The `attestation` field is a placeholder for Epic 6 TEE integration
 * (Story 6.3: TEE-attested DVM results).
 */
export interface SkillDescriptor {
  /** Service identifier (e.g., 'toon-dvm'). */
  name: string;
  /** Schema version (e.g., '1.0'). */
  version: string;
  /** Supported DVM Kind 5xxx numbers (e.g., [5100, 5200]). */
  kinds: number[];
  /** Capability list (e.g., ['text-generation', 'streaming']). */
  features: string[];
  /** JSON Schema draft-07 object describing job request parameters. */
  inputSchema: Record<string, unknown>;
  /** Kind number (as string) -> USDC micro-units cost (as string). */
  pricing: Record<string, string>;
  /** Available AI models (e.g., ['gpt-4', 'claude-3']). */
  models?: string[];
  /** Placeholder for Epic 6 TEE attestation integration. */
  attestation?: Record<string, unknown>;
  /** Composite reputation score with individual signal values (Story 6.4). */
  reputation?: ReputationScore;
}

/** Content payload for a kind:10035 Service Discovery event. */
export interface ServiceDiscoveryContent {
  /** Service type identifier (e.g., 'relay', 'rig'). */
  serviceType: string;
  /** ILP address of the node's connector. */
  ilpAddress: string;
  /** Pricing configuration. */
  pricing: {
    /** Base price per byte in smallest token unit. */
    basePricePerByte: number;
    /** Payment token symbol (e.g., 'USDC'). */
    currency: string;
  };
  /**
   * x402 endpoint configuration.
   * Omitted entirely when x402 is disabled (not set to `{ enabled: false }`).
   */
  x402?: {
    /** Whether x402 is enabled. */
    enabled: boolean;
    /** HTTP endpoint path (e.g., '/publish'). */
    endpoint?: string;
    /** Facilitator endpoint paths for verify and settle operations. */
    facilitatorEndpoints?: {
      /** HTTP path for the /verify endpoint. */
      verify: string;
      /** HTTP path for the /settle endpoint. */
      settle: string;
    };
  };
  /** Nostr event kinds this node accepts for storage. */
  supportedKinds: number[];
  /** Capabilities advertised by this node (e.g., ['relay', 'x402']). */
  capabilities: string[];
  /** Chain preset name (e.g., 'anvil', 'arbitrum-one'). */
  chain: string;
  /** Node software version. */
  version: string;
  /**
   * Optional DVM skill descriptor.
   * Present when the node has DVM handlers registered; omitted otherwise
   * (backward compatible with pre-DVM kind:10035 events).
   */
  skill?: SkillDescriptor;
}

// ---------- Builder ----------

/**
 * Builds a kind:10035 Service Discovery event (NIP-16 replaceable).
 * Kind 10035 is in the 10000-19999 replaceable range (NIP-16).
 * Relays store only the latest event per pubkey + kind.
 * Includes 'd' tag with value 'toon-service-discovery' as a content marker.
 *
 * @param content - The service discovery payload.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 */
export function buildServiceDiscoveryEvent(
  content: ServiceDiscoveryContent,
  secretKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: SERVICE_DISCOVERY_KIND,
      content: JSON.stringify(content),
      tags: [['d', 'toon-service-discovery']],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parser ----------

/**
 * Parses a kind:10035 event content into ServiceDiscoveryContent.
 * Validates required fields. Returns null for malformed content.
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed content, or null if invalid.
 */
export function parseServiceDiscovery(
  event: NostrEvent
): ServiceDiscoveryContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }

  // Must be a non-null object (not an array)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  // Validate required string fields
  const serviceType = record['serviceType'];
  if (typeof serviceType !== 'string') return null;

  const ilpAddress = record['ilpAddress'];
  if (typeof ilpAddress !== 'string') return null;

  const chain = record['chain'];
  if (typeof chain !== 'string') return null;

  const version = record['version'];
  if (typeof version !== 'string') return null;

  // Validate pricing object (must be a plain object, not an array)
  const pricing = record['pricing'];
  if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing))
    return null;
  const pricingRecord = pricing as Record<string, unknown>;

  const basePricePerByte = pricingRecord['basePricePerByte'];
  if (typeof basePricePerByte !== 'number') return null;
  if (!isFinite(basePricePerByte) || basePricePerByte < 0) return null;

  const currency = pricingRecord['currency'];
  if (typeof currency !== 'string') return null;

  // Validate supportedKinds array
  const supportedKinds = record['supportedKinds'];
  if (!Array.isArray(supportedKinds)) return null;
  // Ensure all elements are finite non-negative integers (valid Nostr event kinds)
  if (
    !supportedKinds.every(
      (k): k is number => typeof k === 'number' && Number.isInteger(k) && k >= 0
    )
  ) {
    return null;
  }

  // Validate capabilities array
  const capabilities = record['capabilities'];
  if (!Array.isArray(capabilities)) return null;
  if (!capabilities.every((c): c is string => typeof c === 'string')) {
    return null;
  }

  // Build result
  const result: ServiceDiscoveryContent = {
    serviceType,
    ilpAddress,
    pricing: { basePricePerByte, currency },
    supportedKinds,
    capabilities,
    chain,
    version,
  };

  // Validate optional x402 field
  const x402 = record['x402'];
  if (x402 !== undefined) {
    if (typeof x402 !== 'object' || x402 === null || Array.isArray(x402))
      return null;
    const x402Record = x402 as Record<string, unknown>;

    const enabled = x402Record['enabled'];
    if (typeof enabled !== 'boolean') return null;

    const x402Result: ServiceDiscoveryContent['x402'] = { enabled };

    const endpoint = x402Record['endpoint'];
    if (endpoint !== undefined) {
      if (typeof endpoint !== 'string') return null;
      x402Result.endpoint = endpoint;
    }

    const facilitatorEndpoints = x402Record['facilitatorEndpoints'];
    if (facilitatorEndpoints !== undefined) {
      if (
        typeof facilitatorEndpoints !== 'object' ||
        facilitatorEndpoints === null ||
        Array.isArray(facilitatorEndpoints)
      )
        return null;
      const feRecord = facilitatorEndpoints as Record<string, unknown>;
      const verify = feRecord['verify'];
      const settle = feRecord['settle'];
      if (typeof verify !== 'string' || typeof settle !== 'string') return null;
      x402Result.facilitatorEndpoints = { verify, settle };
    }

    result.x402 = x402Result;
  }

  // Validate optional skill field (Story 5.4: DVM skill descriptor)
  const skill = record['skill'];
  if (skill !== undefined) {
    if (typeof skill !== 'object' || skill === null || Array.isArray(skill))
      return null;
    const skillRecord = skill as Record<string, unknown>;

    // Validate required string fields
    const skillName = skillRecord['name'];
    if (typeof skillName !== 'string') return null;

    const skillVersion = skillRecord['version'];
    if (typeof skillVersion !== 'string') return null;

    // Validate kinds array (non-negative integers)
    const kinds = skillRecord['kinds'];
    if (!Array.isArray(kinds)) return null;
    if (
      !kinds.every(
        (k): k is number =>
          typeof k === 'number' && Number.isInteger(k) && k >= 0
      )
    ) {
      return null;
    }

    // Validate features array (strings)
    const features = skillRecord['features'];
    if (!Array.isArray(features)) return null;
    if (!features.every((f): f is string => typeof f === 'string')) {
      return null;
    }

    // Validate inputSchema (must be a non-null object)
    const inputSchema = skillRecord['inputSchema'];
    if (
      typeof inputSchema !== 'object' ||
      inputSchema === null ||
      Array.isArray(inputSchema)
    )
      return null;

    // Validate pricing (must be a non-null object with string keys and string values)
    // Named `skillPricing` to avoid shadowing the top-level `pricing` variable (line 159).
    const skillPricing = skillRecord['pricing'];
    if (
      typeof skillPricing !== 'object' ||
      skillPricing === null ||
      Array.isArray(skillPricing)
    )
      return null;
    const pricingEntries = Object.entries(
      skillPricing as Record<string, unknown>
    );
    if (!pricingEntries.every(([, v]) => typeof v === 'string')) {
      return null;
    }

    // Build skill descriptor
    const skillResult: SkillDescriptor = {
      name: skillName,
      version: skillVersion,
      kinds,
      features,
      inputSchema: inputSchema as Record<string, unknown>,
      pricing: skillPricing as Record<string, string>,
    };

    // Validate optional models array (strings)
    const models = skillRecord['models'];
    if (models !== undefined) {
      if (!Array.isArray(models)) return null;
      if (!models.every((m): m is string => typeof m === 'string')) {
        return null;
      }
      skillResult.models = models;
    }

    // Validate optional attestation (must be a non-null object when present)
    const attestation = skillRecord['attestation'];
    if (attestation !== undefined) {
      if (
        typeof attestation !== 'object' ||
        attestation === null ||
        Array.isArray(attestation)
      )
        return null;
      skillResult.attestation = attestation as Record<string, unknown>;
    }

    // Validate optional reputation field (Story 6.4: Reputation scoring)
    const reputation = skillRecord['reputation'];
    if (reputation !== undefined) {
      if (
        typeof reputation !== 'object' ||
        reputation === null ||
        Array.isArray(reputation)
      )
        return null;
      const repRecord = reputation as Record<string, unknown>;

      const repScore = repRecord['score'];
      if (typeof repScore !== 'number' || !isFinite(repScore)) return null;

      const signals = repRecord['signals'];
      if (
        typeof signals !== 'object' ||
        signals === null ||
        Array.isArray(signals)
      )
        return null;
      const sigRecord = signals as Record<string, unknown>;

      const trustedBy = sigRecord['trustedBy'];
      if (typeof trustedBy !== 'number' || !isFinite(trustedBy)) return null;

      const channelVolumeUsdc = sigRecord['channelVolumeUsdc'];
      if (typeof channelVolumeUsdc !== 'number' || !isFinite(channelVolumeUsdc))
        return null;

      const jobsCompleted = sigRecord['jobsCompleted'];
      if (typeof jobsCompleted !== 'number' || !isFinite(jobsCompleted))
        return null;

      const avgRating = sigRecord['avgRating'];
      if (typeof avgRating !== 'number' || !isFinite(avgRating)) return null;

      skillResult.reputation = {
        score: repScore,
        signals: { trustedBy, channelVolumeUsdc, jobsCompleted, avgRating },
      };
    }

    result.skill = skillResult;
  }

  return result;
}
