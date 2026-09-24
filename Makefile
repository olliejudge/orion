# Orion build entry points. `make help` lists targets.
GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/olliejudge/orion/internal/version.Version=$(VERSION)
# Repo that `make dev` points orion at (default: this checkout).
REPO    ?= .

.PHONY: help build test lint web dev clean

help: ## List targets
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-8s %s\n", $$1, $$2}'

build: web ## Build the web UI (if present) and bin/orion
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/orion ./cmd/orion

test: ## Run Go tests (and web tests once web/ exists)
	$(GO) test ./...
	@if [ -f web/package.json ]; then pnpm -C web test; fi

lint: ## go vet + golangci-lint (and web lint once web/ exists)
	$(GO) vet ./...
	golangci-lint run
	@if [ -f web/package.json ]; then pnpm -C web lint; fi

web: ## Build web/ into internal/webassets/static (skipped when web/ is absent)
	@if [ -f web/package.json ]; then \
		pnpm -C web install --frozen-lockfile && pnpm -C web build; \
	else \
		echo "web/ not present yet: skipping UI build (the fallback page will be served)"; \
	fi

dev: ## Run the Go server with --dev plus Vite's dev server
	@if [ ! -f web/package.json ]; then echo "make dev needs web/ (added by the web scaffold task)"; exit 1; fi
	@trap 'kill 0' EXIT INT TERM; \
		$(GO) run ./cmd/orion --dev --no-open --port 7070 $(REPO) & \
		pnpm -C web dev

clean: ## Remove build output
	rm -rf bin dist
	find internal/webassets/static -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
