# Thin front door; all logic lives in scripts/: dev.sh for the extension
# itself, nested.sh for the throwaway shell the visual checks run in.
DEV := ./scripts/dev.sh
NESTED := ./scripts/nested.sh

.PHONY: all link install reload logs pack scan prune uninstall status stalls clean help \
        nested nested-headless nested-stop nested-status preview lint

all: install

link install reload logs pack scan prune uninstall status stalls clean:
	@$(DEV) $@

# gjs.guide's ESLint rules over the GJS code (eslint.config.mjs).
lint: node_modules
	@npx --no-install eslint .

node_modules: package.json
	npm install --no-audit --no-fund
	@touch $@

# Nested shell -- a throwaway second GNOME Shell for visual testing. Opens a live
# mirror window on the desktop so you can watch; nested-headless skips that.
nested:
	@$(NESTED) start

nested-headless:
	@$(NESTED) start --headless

nested-stop:
	@$(NESTED) stop

nested-status:
	@$(NESTED) status

preview:
	@$(NESTED) start >/dev/null && $(NESTED) shot

help:
	@$(DEV) help
	@echo
	@$(NESTED) help
