/**
 * The archive rule that money-in has to honour.
 *
 * Archiving a pet is deliberately reversible and deliberately not deletion: the wallet, its
 * balance, every receipt and the durable binding all survive, and the owner keeps withdrawal and
 * export. What stops is new spending. The archive routes themselves are outside this tree; what
 * the wallet rails need from it is the notice below, so a deposit into an archived pet's wallet is
 * reported honestly rather than as the pet spending again.
 */

/** The narrowest view of the store this rule reads. Satisfied by the full application store. */
interface ArchivedPetLookup {
  pets: ReadonlyArray<{ petId: string; archivedAt?: string | null }>;
}

/**
 * Adapts a deposit notice when the money landed in an archived pet's wallet.
 *
 * The on-chain address outlives the archive and no one can stop a sender using it, so the choice
 * is not whether to accept the deposit -- refusing would lose real money -- but whether to say so
 * honestly. A plain "received" line would read as the pet spending again; this says where the
 * money actually is and that the owner can still take it out.
 *
 * The suffix names the pet once, by pronoun. `message` already opens with the name, and repeating
 * it pushed the notice past the Mac shell's 240-character message budget for any pet named 40
 * characters or more -- well inside the 80 that POST /v1/pets accepts.
 */
export function archivedDepositNotice(store: ArchivedPetLookup, petId: string, message: string): string {
  const pet = store.pets.find((candidate) => candidate.petId === petId);
  if (!pet?.archivedAt) return message;
  return `${message} This pet is archived: the money is held, not spent \u2014 withdraw it under Archived pets.`;
}
