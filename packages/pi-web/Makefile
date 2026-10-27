.DEFAULT_GOAL := build

.PHONY: binary-path e2e-stub build setup frontend-setup go-setup root-setup frontend-build frontend-test frontend-knip frontend-lint frontend-format-check extension-test go-test install-test vet test check clean dev e2e e2e-setup

ifeq ($(OS),Windows_NT)
BINARY ?= build/pi-web.exe
else
BINARY ?= build/pi-web
endif
WEB_DIR := web
E2E_DIR := e2e
NODE_MODULES := $(WEB_DIR)/node_modules
ROOT_NODE_MODULES := node_modules

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

binary-path:
	@node -e "console.log(require('node:path').resolve(process.argv[1]))" "$(BINARY)"

build: setup frontend-build
	mkdir -p "$$(dirname "$(BINARY)")"
	go build -ldflags="-s -w -X main.version=$(VERSION)" -o "$(BINARY)" ./cmd/pi-web

setup: frontend-setup go-setup

frontend-setup:
	@if [ ! -d "$(NODE_MODULES)/vite" ] || [ ! -f "$(NODE_MODULES)/.package-lock.json" ] || [ "$(WEB_DIR)/package-lock.json" -nt "$(NODE_MODULES)/.package-lock.json" ] || [ "$(WEB_DIR)/package.json" -nt "$(NODE_MODULES)/.package-lock.json" ]; then \
		echo "Installing frontend dependencies..."; \
		cd $(WEB_DIR) && npm ci --include=dev; \
	else \
		echo "Frontend dependencies already installed."; \
	fi

go-setup:
	go mod download

root-setup:
	@if [ ! -f "$(ROOT_NODE_MODULES)/.package-lock.json" ] || [ "package-lock.json" -nt "$(ROOT_NODE_MODULES)/.package-lock.json" ] || [ "package.json" -nt "$(ROOT_NODE_MODULES)/.package-lock.json" ]; then \
		echo "Installing root dependencies..."; \
		npm ci --ignore-scripts; \
	else \
		echo "Root dependencies already installed."; \
	fi

frontend-build: frontend-setup
	cd $(WEB_DIR) && npm run build

frontend-test: frontend-setup
	cd $(WEB_DIR) && npm run test

frontend-knip: frontend-setup
	cd $(WEB_DIR) && npm run knip

frontend-lint: frontend-setup
	cd $(WEB_DIR) && npm run lint

frontend-format-check: frontend-setup
	cd $(WEB_DIR) && npm run format:check

extension-test: root-setup
	npm run test:extensions

go-test: go-setup frontend-build
	go test ./...

install-test:
	bash tests/install/inplace_test.sh
	node --test tests/install/*.test.mjs

vet: go-setup frontend-build
	go vet ./...

test: frontend-test extension-test go-test install-test

check: frontend-lint frontend-format-check frontend-knip frontend-test extension-test frontend-build go-test install-test vet

dev: frontend-setup go-setup
	@echo "Starting secondary dev instance at http://127.0.0.1:31416 (frontend watcher + Go hot-reloader)..."
	@rm -f $(WEB_DIR)/dist/.vite/manifest.json; \
	cd $(WEB_DIR) && npm run dev & \
	VITE_PID=$$!; \
	trap "kill $$VITE_PID 2>/dev/null; exit" INT TERM EXIT; \
	until [ -f $(WEB_DIR)/dist/.vite/manifest.json ]; do \
		kill -0 $$VITE_PID 2>/dev/null || exit 1; \
		sleep 0.1; \
	done; \
	PI_WEB_DEV=1 air

version:
	@echo $(VERSION)

# End-to-end browser tests (Playwright). Kept out of `test`/`check` because they
# need browser binaries and the built server. See docs/testing.md.
e2e-setup:
	cd $(E2E_DIR) && npm ci && npx playwright install --with-deps chromium firefox webkit

e2e-stub:
ifeq ($(OS),Windows_NT)
	mkdir -p build/e2e/stub-pi
	go build -o build/e2e/stub-pi/pi.exe ./e2e/lib/stub-pi
endif

e2e: build e2e-stub
	cd $(E2E_DIR) && node --test --test-concurrency=1 native/*.test.mjs
	cd $(E2E_DIR) && npx playwright test

clean:
	rm -rf build $(WEB_DIR)/dist
