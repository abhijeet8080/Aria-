/**
 * Heuristics for caller intent in CONFIRMING and safety-net booking flows.
 */

export function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (
    /\b(no|nope|nah|not really|not yet|don't|dont|wait|hold on|actually|change|wrong|incorrect|cancel|never mind|nevermind)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return /\b(yes|yeah|yep|yup|correct|right|perfect|confirm|confirmed|ok|okay|sure|sounds good|absolutely|go ahead|please do|that'?s? (fine|great|right|good|perfect|correct))\b/i.test(
    t
  );
}

/** Model text that claims booking completed without a successful tool (Layer 1 / prompt hygiene). */
export function impliesPrematureBookingClaim(text: string): boolean {
  return /\b(all set|appointment (is )?(confirmed|booked)|you'?re (all )?set|i('?ve| have) (booked|confirmed)|booking is complete|it'?s (on the books|scheduled))\b/i.test(
    text.trim()
  );
}
