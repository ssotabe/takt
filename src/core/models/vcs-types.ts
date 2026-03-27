/**
 * VCS provider type constants.
 *
 * Single source of truth for supported VCS provider identifiers.
 * Used by config schemas, type definitions, and detection logic.
 */

export const VCS_PROVIDER_TYPES = ['github', 'gitlab'] as const;
export type VcsProviderType = (typeof VCS_PROVIDER_TYPES)[number];
