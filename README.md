# PCI ZKP

Layer 4: Zero-knowledge proofs via Midnight for Personal Context Infrastructure.

## Overview

PCI ZKP provides:

- **Zero-Knowledge Proofs** - Prove facts without revealing data
- **Ephemeral Identities** - Single-use DIDs for unlinkable interactions
- **Selective Disclosure** - Share only what's necessary
- **Privacy Circuits** - Common PCI proof patterns

## Structure

This is a pnpm workspace containing:

```
pci-zkp/
├── contract/           # Compact contracts (Midnight)
│   └── src/
│       └── proofs.compact
├── sdk/                # TypeScript SDK
│   └── src/
│       └── proofs/
└── tests/              # Integration tests
```

## Installation

```bash
pnpm add @peteski22/pci-zkp-sdk
```

## Quick Start

```typescript
import { AgeVerification, ProofGenerator } from "pci-zkp-sdk";

// Create a proof generator
const generator = new ProofGenerator();

// Generate an age verification proof
const proof = await generator.generateAgeProof({
  birthDate: new Date("1990-01-01"),
  minAge: 18,
});

// The proof proves age >= 18 without revealing birth date
console.log(proof.publicSignals); // { ageOver: 18, verified: true }
console.log(proof.proof);         // ZK proof data
```

## Available Proofs

| Proof Type | What it proves | What stays private |
|------------|---------------|-------------------|
| `AgeVerification` | Age >= threshold | Exact birth date |
| `LocationProof` | In region/country | Exact coordinates |
| `CredentialProof` | Has valid credential | Credential details |
| `IncomeRange` | Income in range | Exact amount |

## Midnight Integration

This package uses Midnight's Compact language for ZK circuits:

```compact
// contract/src/proofs.compact
export circuit proveAgeOver(
  @secret birthDate: Field,
  @public minAge: Field,
  @public currentDate: Field
) -> Bool {
  let age = (currentDate - birthDate) / 365;
  return age >= minAge;
}
```

## Development

### Prerequisites

1. **Node.js 18+** and **pnpm**
2. **Docker** and **Docker Compose** (for local Midnight network)
3. **Compact Compiler** (Midnight's contract language)

### Install Compact Compiler

```bash
# Via npm (requires Node 18+)
pnpm add -D @aspect-build/compactc

# Or download from Midnight's releases for your platform
```

### Run Local Midnight Network

```bash
# Start the Midnight development network
docker compose up -d

# This starts:
# - Midnight node (localhost:9944)
# - Proof server (localhost:6300)
# - Indexer (localhost:8088)
```

### Build and Test

```bash
# Install dependencies
pnpm install

# Compile Compact contract to TypeScript
pnpm --filter pci-zkp-contract compact

# Build all packages
pnpm build

# Run tests
pnpm test

# Build contract only
pnpm --filter pci-zkp-contract build

# Build SDK only
pnpm --filter pci-zkp-sdk build
```

### Verify Midnight Network is Running

```bash
# Check node
curl http://localhost:9944/health

# Check proof server
curl http://localhost:6300/health

# Check indexer
curl http://localhost:8088/api/v1/graphql
```

## Related Packages

- [pci-spec](https://github.com/peteski22/pci-spec) - S-PAL schema and protocols
- [pci-context-store](https://github.com/peteski22/pci-context-store) - Layer 1: Context Store
- [pci-agent](https://github.com/peteski22/pci-agent) - Layer 2: Personal Agent
- [pci-contracts](https://github.com/peteski22/pci-contracts) - Layer 3: Smart Contracts

## License

Apache 2.0
