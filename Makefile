# pci-zkp Makefile
# Run 'make help' to see available targets

# Ensure compactc is in PATH
export PATH := $(HOME)/.compact/versions/0.26.0/x86_64-unknown-linux-musl:$(PATH)

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

.PHONY: dev
dev: ## Start Midnight local network (docker compose up -d)
	docker compose up -d

.PHONY: down
down: ## Stop Midnight network and remove volumes
	docker compose down -v

.PHONY: logs
logs: ## Tail Midnight network logs
	docker compose logs -f

.PHONY: status
status: ## Check Midnight network health
	@echo "Midnight containers:"
	@docker compose ps
	@echo ""
	@echo "Proof server:"
	@curl -s http://localhost:6300/health 2>/dev/null || echo "Not responding"
	@echo ""

.PHONY: compile
compile: ## Compile Compact contracts
	cd contract && pnpm run compact

.PHONY: build
build: compile ## Build all packages
	cd contract && pnpm run build
	cd sdk && pnpm run build

.PHONY: test
test: ## Run unit tests
	pnpm test

.PHONY: test-int
test-int: ## Run integration tests (requires Midnight network running)
	pnpm test:integration

.PHONY: lint
lint: ## Type check all packages
	cd contract && pnpm run typecheck
	cd sdk && pnpm run lint

.PHONY: clean
clean: ## Clean build artifacts
	cd contract && pnpm run clean
	cd sdk && pnpm run clean
