import fs from 'fs';
import path from 'path';

/**
 * Host URLs of the test stack slot the specs run against: slot 0 (ports 18xxx) unless TESTSTACK_SLOT
 * names an isolated copy (base + slotStride * slot, from scripts/stack/config.json). Specs that build
 * URLs from here run on any slot, so the QE stage can run them on a leased slot in parallel with other
 * stories (docs/ai-pipeline/qe.md#stack-slots); specs with hard-coded 18xxx ports stay on slot 0.
 */
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'stack', 'config.json'), 'utf8')) as {
  slotStride: number;
  ports: Record<string, { base: number }>;
};

export const SLOT = Number.parseInt(process.env.TESTSTACK_SLOT ?? '0', 10) || 0;

/** Host port of a stack service on this slot (webapp, identity, catalog, basket, ordering, ...). */
export function port(name: string): number {
  const p = config.ports[name];
  if (!p) throw new Error(`unknown test stack port "${name}"`);
  return p.base + config.slotStride * SLOT;
}

export const WEBAPP_URL = `http://localhost:${port('webapp')}`;
/** The issuer the containers trust; the host does not resolve it, so requests are pinned to 127.0.0.1. */
export const IDENTITY_URL = `http://host.docker.internal:${port('identity')}`;
export const CATALOG_URL = `http://localhost:${port('catalog')}`;
export const BASKET_GRPC_URL = `http://localhost:${port('basket')}`;
export const ORDERING_URL = `http://localhost:${port('ordering')}`;
export const MOBILE_BFF_URL = `http://localhost:${port('mobileBff')}`;
