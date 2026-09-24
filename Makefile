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

# Vite is stopped whenever the Go server exits (it failed, or Ctrl-C). Ctrl-C
# reaches orion and Vite through the terminal; the shell keeps waiting until
# orion has shut down, and counts that as success because `go run` exits 1
# after any interrupt. On TERM, orion (go run's child) is stopped directly, as
# go run does not forward it.
dev: ## Run the Go server with --dev plus Vite's dev server
	@if [ ! -f web/package.json ]; then echo "make dev needs web/ (added by the web scaffold task)"; exit 1; fi
	@pnpm -C web dev & vite=$$!; \
		trap 'kill $$vite 2>/dev/null' EXIT; \
		$(GO) run ./cmd/orion --dev --no-open --port 7070 "$(REPO)" & server=$$!; \
		interrupted=; trap 'interrupted=1' INT; \
		trap 'pkill -TERM -P $$server 2>/dev/null' TERM; \
		status=0; wait $$server || status=$$?; \
		while kill -0 $$server 2>/dev/null; do wait $$server; status=$$?; done; \
		if [ -n "$$interrupted" ]; then status=0; fi; \
		exit $$status

clean: ## Remove build output
	rm -rf bin dist
	find internal/webassets/static -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
