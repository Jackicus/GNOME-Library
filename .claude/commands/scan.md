---
description: Re-index the user's enabled media sections and download artwork, into the real cache (only when the user asks)
disable-model-invocation: true
allowed-tools: Bash(make scan), Bash(./scripts/dev.sh scan), Bash(./scripts/dev.sh status)
---

Re-index the user's own media library. This is real, not a test: it writes
`~/.cache/library@jackicus/`, which the user's own shell (and a nested shell without
`--stand-in`) rebuilds from, and every section whose `<prefix>-online` switch is on
goes to the network with the user's own keys. Run it only because the user asked
(typing this command is that); a change is tried against
`./scripts/nested.sh start --stand-in`, which needs no scan.

1. Run `make scan`. It reads each enabled section's folders from GSettings (TV
   Shows, Films; neither has a default, so "not set" means the section is off
   until pointed at a folder), walks them, looks items up online through each
   section's ordered source list (`<prefix>-sources`: TVmaze, TMDB and
   Wikipedia for shows; TMDB and Wikipedia for films), trying them in turn
   until one has the artwork, and writes `~/.cache/library@jackicus/library.json`.
   A section whose `<prefix>-online` switch is off reads the cache and stays
   off the network. API keys are credential slots in the `credentials`
   setting, which the scanner reads itself: never print them. "no credential
   set, skipping it" in the output is a source without a key stepping aside,
   not an error.
2. Report the per-section counts from the scanner's output; never paste the
   titles or the user's folders into a commit or a public place.
3. Nothing else is needed: a running Library watches `library.json` and
   rebuilds itself when the file lands (the user's own shell, if they have it
   enabled; a nested shell under `--stand-in` reads its own made-up cache and
   does not change).

A section reported as "is not a folder" means its path is unreachable — check the
drive is mounted, or ask the user to fix the folder in Settings, rather than treating it as empty.
Film lookups can log `HTTP Error 429`; that is Wikipedia rate-limiting and the
film will be retried on the next scan.
