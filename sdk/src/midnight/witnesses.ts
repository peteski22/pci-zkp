/**
 * Witness Functions for Age Verification
 *
 * Witnesses are TypeScript functions that provide private data to Compact circuits.
 * The private data never leaves the user's device - only the ZK proof is shared.
 */

import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";

/**
 * Private birth date state (never shared, only used locally for proof generation)
 */
export interface BirthDateState {
  birthYear: number;
  birthMonth: number;
  birthDay: number;
}

/**
 * Ledger state from the contract
 */
export interface AgeVerificationLedger {
  verified: boolean;
  lastMinAge: bigint;
  verificationCount: bigint;
}

/**
 * Create witness functions for age verification
 *
 * These functions provide the private birth date to the ZK circuit.
 * The actual date is never revealed - only the proof that age >= threshold.
 *
 * @param birthDate - The user's birth date
 * @returns Witness functions compatible with the compiled Compact contract
 */
export function createAgeWitnesses<T>(birthDate: Date) {
  const birthYear = birthDate.getFullYear();
  const birthMonth = birthDate.getMonth() + 1; // JavaScript months are 0-indexed
  const birthDay = birthDate.getDate();

  return {
    birthYear(context: WitnessContext<AgeVerificationLedger, T>): [T, bigint] {
      return [context.privateState, BigInt(birthYear)];
    },
    birthMonth(context: WitnessContext<AgeVerificationLedger, T>): [T, bigint] {
      return [context.privateState, BigInt(birthMonth)];
    },
    birthDay(context: WitnessContext<AgeVerificationLedger, T>): [T, bigint] {
      return [context.privateState, BigInt(birthDay)];
    },
  };
}

/**
 * Parse a date into circuit-compatible format
 */
export function parseDateForCircuit(date: Date): {
  year: bigint;
  month: bigint;
  day: bigint;
} {
  return {
    year: BigInt(date.getFullYear()),
    month: BigInt(date.getMonth() + 1),
    day: BigInt(date.getDate()),
  };
}
