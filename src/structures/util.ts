import type { PropSide } from '../props/rules';

export function sidesOfSafe(v: unknown): PropSide {
  return v === 'left' || v === 'right' || v === 'both' ? v : 'both';
}
