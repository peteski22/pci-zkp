/**
 * Test age verification circuit execution
 *
 * This tests the compiled Compact contract locally (simulation mode)
 * before deploying to the Midnight network.
 */

import { Contract, ledger, type Witnesses } from '../managed/contract/index.cjs';
import {
  constructorContext,
  emptyZswapLocalState,
  sampleContractAddress,
  dummyContractAddress,
  NetworkId,
  QueryContext,
  type CircuitContext,
  type WitnessContext,
  type ConstructorResult,
  type ContractState,
} from '@midnight-ntwrk/compact-runtime';

// Sample coin public key for testing (64-char hex string = 32 bytes)
const SAMPLE_COIN_PUBLIC_KEY = '0101010101010101010101010101010101010101010101010101010101010101';

// Our private state type (empty for this contract)
type PrivateState = Record<string, never>;

// Create witness functions that provide the secret birth date
function createWitnesses(birthYear: number, birthMonth: number, birthDay: number): Witnesses<PrivateState> {
  return {
    birthYear: (ctx: WitnessContext<ReturnType<typeof ledger>, PrivateState>): [PrivateState, bigint] => {
      return [ctx.privateState, BigInt(birthYear)];
    },
    birthMonth: (ctx: WitnessContext<ReturnType<typeof ledger>, PrivateState>): [PrivateState, bigint] => {
      return [ctx.privateState, BigInt(birthMonth)];
    },
    birthDay: (ctx: WitnessContext<ReturnType<typeof ledger>, PrivateState>): [PrivateState, bigint] => {
      return [ctx.privateState, BigInt(birthDay)];
    },
  };
}

// Create a circuit context from contract state
function createCircuitContext(
  contractState: ContractState,
  privateState: PrivateState
): CircuitContext<PrivateState> {
  // QueryContext constructor takes (StateValue, ContractAddress)
  const queryCtx = new QueryContext(
    contractState.data,
    dummyContractAddress(NetworkId.Undeployed)
  );

  return {
    originalState: contractState,
    currentPrivateState: privateState,
    currentZswapLocalState: emptyZswapLocalState(SAMPLE_COIN_PUBLIC_KEY),
    transactionContext: queryCtx,
  };
}

async function runTest() {
  console.log('=== Age Verification Circuit Test ===\n');

  // Test Case 1: Person born in 1990 (34 years old in Dec 2024)
  console.log('Test 1: Person born Jan 15, 1990');
  console.log('  Checking if age >= 21...');

  const witnesses1 = createWitnesses(1990, 1, 15); // Jan 15, 1990
  const contract1 = new Contract(witnesses1);

  // Initialize the contract state
  const initialPrivateState: PrivateState = {};
  const initCtx = constructorContext(initialPrivateState, SAMPLE_COIN_PUBLIC_KEY);
  const initResult: ConstructorResult<PrivateState> = contract1.initialState(initCtx);

  console.log('  Contract initialized');

  // Get the ledger state (ContractState has .data which is StateValue)
  const ledgerState = ledger(initResult.currentContractState.data);
  console.log('  Initial ledger state:', {
    verified: ledgerState.verified,
    lastMinAge: ledgerState.lastMinAge,
    verificationCount: ledgerState.verificationCount,
  });

  // Create circuit context with current state
  const ctx1 = createCircuitContext(initResult.currentContractState, initResult.currentPrivateState);

  // Execute the verifyAge circuit
  // Args: minAge, currentYear, currentMonth, currentDay
  const result1 = contract1.circuits.verifyAge(
    ctx1,
    21n,      // minAge
    2024n,    // currentYear
    12n,      // currentMonth (December)
    4n        // currentDay
  );

  // Check ledger state after circuit execution (result.context holds updated state)
  const newLedger1 = ledger(result1.context.transactionContext.state);
  console.log('  Result:', {
    verified: newLedger1.verified,
    lastMinAge: newLedger1.lastMinAge,
    verificationCount: newLedger1.verificationCount,
  });

  if (newLedger1.verified) {
    console.log('  ✓ PASS: Person is verified (34 >= 21)\n');
  } else {
    console.log('  ✗ FAIL: Expected verified=true\n');
  }

  // Test Case 2: Person born in 2010 (14 years old)
  console.log('Test 2: Person born March 20, 2010');
  console.log('  Checking if age >= 21...');

  const witnesses2 = createWitnesses(2010, 3, 20); // March 20, 2010
  const contract2 = new Contract(witnesses2);

  const initResult2 = contract2.initialState(constructorContext({}, SAMPLE_COIN_PUBLIC_KEY));
  const ctx2 = createCircuitContext(initResult2.currentContractState, initResult2.currentPrivateState);

  const result2 = contract2.circuits.verifyAge(ctx2, 21n, 2024n, 12n, 4n);

  const newLedger2 = ledger(result2.context.transactionContext.state);
  console.log('  Result:', {
    verified: newLedger2.verified,
    lastMinAge: newLedger2.lastMinAge,
  });

  if (!newLedger2.verified) {
    console.log('  ✓ PASS: Person is NOT verified (14 < 21)\n');
  } else {
    console.log('  ✗ FAIL: Expected verified=false\n');
  }

  // Test Case 3: Boundary case - exactly 21
  console.log('Test 3: Person who just turned 21 (Dec 4, 2003)');
  console.log('  Checking if age >= 21...');

  const witnesses3 = createWitnesses(2003, 12, 4); // Dec 4, 2003
  const contract3 = new Contract(witnesses3);

  const initResult3 = contract3.initialState(constructorContext({}, SAMPLE_COIN_PUBLIC_KEY));
  const ctx3 = createCircuitContext(initResult3.currentContractState, initResult3.currentPrivateState);

  const result3 = contract3.circuits.verifyAge(ctx3, 21n, 2024n, 12n, 4n);

  const newLedger3 = ledger(result3.context.transactionContext.state);
  console.log('  Result:', {
    verified: newLedger3.verified,
    lastMinAge: newLedger3.lastMinAge,
  });

  if (newLedger3.verified) {
    console.log('  ✓ PASS: Person is verified (exactly 21 today)\n');
  } else {
    console.log('  ✗ FAIL: Expected verified=true\n');
  }

  // Test Case 4: Car rental (25+)
  console.log('Test 4: Same 34-year-old, checking for car rental (25+)');

  const witnesses4 = createWitnesses(1990, 1, 15);
  const contract4 = new Contract(witnesses4);

  const initResult4 = contract4.initialState(constructorContext({}, SAMPLE_COIN_PUBLIC_KEY));
  const ctx4 = createCircuitContext(initResult4.currentContractState, initResult4.currentPrivateState);

  const result4 = contract4.circuits.verifyAge(ctx4, 25n, 2024n, 12n, 4n);

  const newLedger4 = ledger(result4.context.transactionContext.state);
  console.log('  Result:', {
    verified: newLedger4.verified,
    lastMinAge: newLedger4.lastMinAge,
  });

  if (newLedger4.verified) {
    console.log('  ✓ PASS: Person is verified for car rental (34 >= 25)\n');
  } else {
    console.log('  ✗ FAIL: Expected verified=true\n');
  }

  console.log('=== All Tests Complete ===');
}

runTest().catch(console.error);
