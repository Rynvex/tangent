.PHONY: help db-up db-down sqlc vet test check serve web-check

SQLC := $(shell command -v sqlc 2>/dev/null || echo $(HOME)/go/bin/sqlc)

help:
	@echo "db-up db-down sqlc vet test check serve web-check"

db-up:
	docker compose up -d --wait postgres

db-down:
	docker compose stop postgres

sqlc:
	$(SQLC) generate

vet:
	go vet ./...

test:
	go test ./... -count=1

web-check:
	@if [ -f web/package.json ]; then \
		pnpm -C web typecheck && \
		status=0 && \
		for pkg in @tangent/fonts @tangent/client @tangent/react @tangent/demo; do \
			pnpm -C web --filter "$$pkg" test || status=$$?; \
		done && \
		test $$status -eq 0 && \
		pnpm -C web build; \
	fi

check: vet test web-check

serve:
	go run ./cmd/tangent-server
