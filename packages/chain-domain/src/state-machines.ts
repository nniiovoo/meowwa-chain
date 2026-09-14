import type { Actor, MandateState, RequestState } from './codes.js';

type Transition<S extends string> = { to: S; actors: readonly Actor[] };

const mandateTransitions: Record<MandateState, readonly Transition<MandateState>[]> = {
  DRAFT: [{ to: 'PENDING_APPROVAL', actors: ['owner'] }],
  PENDING_APPROVAL: [{ to: 'ACTIVE', actors: ['owner'] }],
  ACTIVE: [
    { to: 'EXHAUSTED', actors: ['system'] }, { to: 'EXPIRED', actors: ['system'] },
    { to: 'REVOKED', actors: ['owner'] }, { to: 'SUSPENDED', actors: ['owner', 'system'] },
  ],
  SUSPENDED: [{ to: 'ACTIVE', actors: ['owner'] }, { to: 'REVOKED', actors: ['owner'] }],
  EXHAUSTED: [], EXPIRED: [], REVOKED: [],
};

const requestTransitions: Record<RequestState, readonly Transition<RequestState>[]> = {
  DRAFT: [{ to: 'EVALUATING', actors: ['agent', 'system'] }, { to: 'CANCELLED', actors: ['owner'] }],
  EVALUATING: [
    { to: 'BLOCKED', actors: ['system'] }, { to: 'AWAITING_APPROVAL', actors: ['system'] },
    { to: 'AUTHORIZED', actors: ['system'] },
  ],
  AWAITING_APPROVAL: [
    { to: 'AUTHORIZED', actors: ['owner'] }, { to: 'DECLINED', actors: ['owner'] },
    { to: 'EXPIRED', actors: ['system'] }, { to: 'CANCELLED', actors: ['owner', 'system'] },
  ],
  AUTHORIZED: [{ to: 'SUBMITTING', actors: ['system'] }, { to: 'CANCELLED', actors: ['owner', 'system'] }],
  SUBMITTING: [
    { to: 'CONFIRMED', actors: ['provider', 'system'] },
    { to: 'FAILED', actors: ['provider', 'system'] },
    { to: 'DISPUTED', actors: ['provider', 'system'] },
  ],
  CONFIRMED: [{ to: 'REFUNDED', actors: ['provider', 'system'] }, { to: 'DISPUTED', actors: ['owner', 'provider'] }],
  REFUNDED: [{ to: 'DISPUTED', actors: ['provider', 'system'] }],
  // A dispute is a claim, not an outcome. Leaving DISPUTED terminal made the order the owner
  // happened to press the buttons in decide whether the money could ever come back: dispute first
  // and every refund answered 409 forever, while the contested amount kept consuming the pet's
  // rolling 30-day allowance. The refund gates still require a reconciled receipt, so this only
  // admits the owner-opened dispute -- a reorg or authorization review cannot reach it.
  DISPUTED: [{ to: 'REFUNDED', actors: ['provider', 'system'] }],
  BLOCKED: [], DECLINED: [], EXPIRED: [], FAILED: [], CANCELLED: [],
};

function transition<S extends string>(kind: string, map: Record<S, readonly Transition<S>[]>, from: S, to: S, actor: Actor): S {
  const candidate = map[from].find((item) => item.to === to);
  if (!candidate) throw new Error(`Invalid ${kind} transition: ${from} -> ${to}`);
  if (!candidate.actors.includes(actor)) throw new Error(`Invalid actor ${actor} for ${from} -> ${to}`);
  return to;
}

export const transitionMandate = (from: MandateState, to: MandateState, actor: Actor) =>
  transition('mandate', mandateTransitions, from, to, actor);

export const transitionRequest = (from: RequestState, to: RequestState, actor: Actor) =>
  transition('request', requestTransitions, from, to, actor);
