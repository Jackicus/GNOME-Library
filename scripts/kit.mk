# The make targets every extension shares, included by its Makefile
# (`include scripts/kit.mk`), which adds its own after the include.
#
# Copied from the GNOME-EXTENSIONS kit (template/scripts/kit.mk) by its
# scripts/sync.sh: change it there. Every target is a front door: the work is
# in scripts/dev.sh and scripts/nested.sh.

DEV := ./scripts/dev.sh
NESTED := ./scripts/nested.sh

.DEFAULT_GOAL := help
.PHONY: link install reload logs pack schema check lint uninstall status clean help \
        nested nested-headless nested-stop nested-status preview

link install reload pack schema uninstall status clean:
	@$(DEV) $@

# make logs                      follow
# make logs SINCE='5 min ago'    what is there since then (make cannot take it as
#                                a second word: that would be a second goal)
logs:
	@$(DEV) logs $(if $(SINCE),'$(SINCE)')

# Everything that needs no GNOME Shell, and what CI runs.
check: lint
	@$(DEV) check

lint: node_modules
	@npx --no-install eslint .

node_modules: package.json package-lock.json
	npm ci --no-audit --no-fund
	@touch $@

nested:
	@$(NESTED) start
nested-headless:
	@$(NESTED) start --headless
nested-stop:
	@$(NESTED) stop
nested-status:
	@$(NESTED) status
preview:
	@$(NESTED) preview

help:
	@$(DEV) help
	@echo
	@$(NESTED) help
	@echo
	@echo "make check     ESLint, then './scripts/dev.sh check': what CI runs"
	@echo "make logs SINCE='5 min ago'   the journal since then, instead of following it"
	@awk -v name='$(notdir $(CURDIR))' ' \
	    /^#/ { sub(/^# ?/, ""); note = note (note == "" ? "" : " ") $$0; next } \
	    /^[a-z][a-z0-9_-]*:/ && !/:=/ { t = $$1; sub(/:.*/, "", t); \
	        if (!seen++) print "\n" name "'"'"'s own targets:"; \
	        printf "make %-12s %s\n", t, note } \
	    { note = "" }' $(firstword $(MAKEFILE_LIST))
