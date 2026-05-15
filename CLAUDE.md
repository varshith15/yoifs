# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

```bash
pnpm dev   # runs the test harness (index.ts) end-to-end via ts-node
```

There is no separate build, lint, or unit-test command. `pnpm dev` is everything — it executes Levels 1, 2, and 3 of the grading harness against the `FileSystem` in `solution.ts`.

## Architectural shape

Two files matter, and they cycle-import:

- **`index.ts`** — the assignment-provided test harness. Defines the `Disk` interface, `MemoryDisk` (1 MB Buffer-backed disk), `CorruptionSimulator`, and the `TestHarness` that grades the implementation. **Do not modify this file.** Treat it as a fixed spec.
- **`solution.ts`** — the implementation. Exports a `FileSystem` class that `index.ts` imports. `solution.ts` in turn imports the `Disk` type from `index.ts`.

The `Disk` abstraction is the only thing standing between `FileSystem` and the raw byte array. All file-system structure — naming, allocation, metadata, checksums — is invented on top of `read(offset, length)` / `write(offset, data)`. There is no folder concept, no delete API, no inode-style indirection unless you build it.

## What's been built (v1) and what's deferred (v2)

The implementation is split into two versions on purpose:

- **v1 = Levels 1 + 2.** Basic file operations (`writeFile`, `readFile`, `listFiles`) plus two-layer CRC32 checksums that *detect* corruption. Currently in `master`.
- **v2 = Level 3.** *Recovery* via replication / erasure coding. Not yet implemented.

This split is load-bearing for the test harness: the only unforgivable bucket is `dataIntegrityFailures` (silent return of wrong data). v1 makes that bucket deterministically zero by failing closed on any checksum mismatch. v2 will trade some `detectedCorruptions` for `successfulReads` by recovering from replicas.

When extending into v2, the v1 design (fixed-offset FAT, independent per-entry checksums, append-only data log) is intentionally friendly to replica placement — see DESIGN.md §8.

## Source of truth for rationale

**DESIGN.md** at the repo root documents every architectural choice and the alternatives that were rejected. This is the file an evaluator (or a future Claude) should read before proposing changes. Code comments in `solution.ts` cite section numbers in DESIGN.md rather than re-explaining the rationale inline.

User preference for this repo: **every non-trivial design choice gets a "why this, not the alternative" note** — both in DESIGN.md and as a brief code comment. This overrides the usual "minimize comments" default for this codebase. When adding code, follow the existing comment style: short comment, points at DESIGN.md, no restating obvious mechanics.

## Test harness behavior worth knowing

- The corruption simulator flips random bytes. Successful-read counts will vary across runs at every corruption rate. **`dataIntegrityFailures` should be 0 deterministically** — that is the contract, not a sample.
- Levels 2 and 3 each instantiate a fresh `FileSystem` and `MemoryDisk`. Each instantiation is effectively a "remount" — any persistent state must be on disk, not in field initializers.
- The harness writes ~100 files of 10–500 bytes each on a 1 MB disk. The workload uses unique filenames and never deletes — design choices in v1 leaned on this (append-only log, no free-space tracking).
- To check stability, run `pnpm dev` a few times. A single run is not enough to draw conclusions about the random buckets.

## Remotes

- `origin` → `varshith15/yoifs` (working fork, push here)
- `upstream` → `y-gupta/yoifs` (original assignment repo, pull from here for upstream changes)
