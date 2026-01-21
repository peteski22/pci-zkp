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
 * Options for date parsing functions
 */
export interface DateParseOptions {
  /** Use UTC methods instead of local time (default: false) */
  useUTC?: boolean;
}

/**
 * Create witness functions for age verification
 *
 * These functions provide the private birth date to the ZK circuit.
 * The actual date is never revealed - only the proof that age >= threshold.
 *
 * @param birthDate - The user's birth date
 * @param opts - Options for date parsing (useUTC: boolean)
 * @returns Witness functions compatible with the compiled Compact contract
 * @throws TypeError if birthDate is invalid
 */
export function createAgeWitnesses<T>(birthDate: Date, opts: DateParseOptions = {}) {
  if (Number.isNaN(birthDate.getTime())) {
    throw new TypeError("Invalid Date provided to createAgeWitnesses");
  }

  const useUTC = opts.useUTC ?? false;
  const birthYear = useUTC ? birthDate.getUTCFullYear() : birthDate.getFullYear();
  const birthMonth = (useUTC ? birthDate.getUTCMonth() : birthDate.getMonth()) + 1; // JavaScript months are 0-indexed
  const birthDay = useUTC ? birthDate.getUTCDate() : birthDate.getDate();

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
 *
 * @param date - The date to parse
 * @param opts - Options for date parsing (useUTC: boolean)
 * @returns Object with year, month, day as bigint values
 * @throws TypeError if date is invalid
 */
export function parseDateForCircuit(
  date: Date,
  opts: DateParseOptions = {}
): {
  year: bigint;
  month: bigint;
  day: bigint;
} {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Invalid Date provided to parseDateForCircuit");
  }

  const useUTC = opts.useUTC ?? false;
  return {
    year: BigInt(useUTC ? date.getUTCFullYear() : date.getFullYear()),
    month: BigInt((useUTC ? date.getUTCMonth() : date.getMonth()) + 1),
    day: BigInt(useUTC ? date.getUTCDate() : date.getDate()),
  };
}
