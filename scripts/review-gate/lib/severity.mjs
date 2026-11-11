// Severity, computed by the harness (never by the triage agent) so it can be recomputed and explained.
//
// Ticket severity:
//   base  = max(Impact, Fix risk); Complexity is shown but feeds into Fix risk, it does not count directly
//   floor = High (implement.reviewGate.floor.level) when the ticket's files hit an override path or the
//           agent put it in a floor category (auth, payments, migration, security)
//   bump  = +1 level per human reopen, capped at Severe (stored apart, so the base stays visible)
//
// PR severity = max ticket severity, +1 level when the PR touches `manySystems` (3) or more systems,
// at least High (`sharedFloor`) when it changes shared infrastructure or an integration-event contract.
import { atLeast, bumpLevel, levelIndex, maxLevel, normalizeLevel } from './levels.mjs';

export function ticketSeverity({ impact, complexity = null, fixRisk, floorReasons = [], reopens = 0 }, settings = {}) {
  const base = maxLevel(impact, fixRisk);
  if (!base) return { level: null, base: null, floor: null, bump: 0, explanation: 'not assessed' };
  const floor = floorReasons.length ? normalizeLevel(settings.floor?.level ?? 'High') : null;
  const floored = floor ? atLeast(base, floor) : base;
  const bump = Math.max(0, Number(reopens) || 0);
  const level = bumpLevel(floored, bump);
  const parts = [`Impact ${normalizeLevel(impact) ?? '?'}, Fix risk ${normalizeLevel(fixRisk) ?? '?'} → ${base}`];
  if (floor && levelIndex(floored) > levelIndex(base)) parts.push(`floor ${floor} (${floorReasons.join(', ')}) → ${floored}`);
  else if (floor) parts.push(`floor ${floor} (${floorReasons.join(', ')})`);
  if (bump) parts.push(`+${bump} reopen${bump > 1 ? 's' : ''} → ${level}`);
  return { level, base, floor, bump, complexity: normalizeLevel(complexity), explanation: parts.join(', ') };
}

// Why a ticket gets the floor: override paths among its files, floor categories the agent named.
export function floorReasons({ files = [], categories = [] }, settings, { overridePathsHit }) {
  const reasons = overridePathsHit(files, settings).map((h) => h.path);
  const wanted = new Set((settings.floor?.categories ?? []).map((c) => c.toLowerCase()));
  for (const c of categories ?? []) if (wanted.has(String(c).toLowerCase())) reasons.push(`category ${String(c).toLowerCase()}`);
  return [...new Set(reasons)];
}

export function prSeverity({ tickets, systems }, settings = {}) {
  const levels = tickets.map((t) => t.severity?.level ?? null);
  // A ticket that was not assessed makes the PR's severity unknown (it can never auto-merge).
  if (!levels.length || levels.some((l) => !l)) return { level: null, explanation: 'not every ticket was assessed', bumped: false, floor: null };
  const top = maxLevel(levels);
  const many = settings.manySystems ?? 3;
  const bumped = systems.names.length >= many;
  let level = bumped ? bumpLevel(top, 1) : top;
  const parts = [`max ticket severity ${top}`];
  if (bumped) parts.push(`+1 for ${systems.names.length} systems → ${level}`);
  const floor = systems.shared || systems.contract ? normalizeLevel(settings.sharedFloor ?? 'High') : null;
  if (floor) {
    const before = level;
    level = atLeast(level, floor);
    const why = [systems.shared && 'shared infrastructure', systems.contract && 'an integration-event contract'].filter(Boolean).join(' and ');
    parts.push(`floor ${floor} (${why})${levelIndex(level) > levelIndex(before) ? ` → ${level}` : ''}`);
  }
  return { level, explanation: parts.join(', '), bumped, floor };
}

// The PR class the retro groups review data by, and the approvals policy table is keyed by:
// the PR severity, plus "+shared" when it changes shared infrastructure or a contract.
export const prClass = ({ severity, shared }) => `${severity ?? 'Unassessed'}${shared ? '+shared' : ''}`;
