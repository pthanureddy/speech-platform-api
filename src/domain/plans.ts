import { badRequest } from './errors.js';
import type { PlanId, PlanPolicy } from './types.js';

export const PLAN_POLICIES: Readonly<Record<PlanId, PlanPolicy>> = Object.freeze({
  free: Object.freeze({
    id: 'free',
    displayName: 'Free',
    monthlyCharacterLimit: 10_000,
    maxCharactersPerJob: 5_000,
  }),
  starter: Object.freeze({
    id: 'starter',
    displayName: 'Starter',
    monthlyCharacterLimit: 100_000,
    maxCharactersPerJob: 25_000,
  }),
  business: Object.freeze({
    id: 'business',
    displayName: 'Business',
    monthlyCharacterLimit: 1_000_000,
    maxCharactersPerJob: 50_000,
  }),
});

export function getPlanPolicy(planId: PlanId): PlanPolicy {
  const policy = PLAN_POLICIES[planId];
  if (policy === undefined) {
    throw badRequest('UNKNOWN_PLAN', `No policy is configured for plan '${planId}'.`);
  }
  return policy;
}
