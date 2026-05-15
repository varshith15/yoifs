# YOIFS Architecture — v1

This document records the architectural decisions for YOIFS v1, the rationale behind each one, and the alternatives considered. The goal is to make the design legible to an evaluator without requiring them to reverse-engineer it from code.

v1 scope is **Levels 1 + 2** of the assignment (basic operations + corruption detection). Level 3 (fault-tolerant recovery) is deferred to v2 and discussed only at the end, in the migration-path section.

---

## 1. Scope split: detection now, recovery later

**Decision.** v1 implements operations (`writeFile`, `readFile`, `listFiles`) and *detects* corruption via checksums. It does **not** repair or recover corrupted data. v2 adds replication / erasure coding for recovery.

**Why.**
- The test harness grades on three buckets: `successfulReads`, `detectedCorruptions`, `dataIntegrityFailures`. The only unforgivable bucket is `dataIntegrityFailures` (silently returning wrong data). A detection-only system never lands in that bucket — corrupted files land in `detectedCorruptions`, which still counts toward the README's "fault tolerance rate."
- Recovery design is significantly more invasive (replica placement, reconciliation logic, possibly ECC). Coupling it with the basic plumbing risks not finishing either.
- A working v1 is also a safety net: if v2 stalls, v1 still passes Levels 1 and 2.

**Alternatives considered.** All-in-one (build recovery in v1). Rejected — too much surface area at once, and the design of recovery should be informed by *measuring* where detection-only breaks under stress, which requires v1 to exist first.

---

## 2. Disk layout: fixed-region FAT + append-only data log

```
Offset 0 ───────────────────────────────────────────────
  FAT region (32 KB):
    256 slots × 80 bytes each = 20,480 bytes used
    padded to 32,768 bytes for round numbers and headroom

Offset 32 KB ───────────────────────────────────────────
  Data region (rest of disk, ~992 KB):
    Append-only log
    nextOffset starts at 32 KB and only grows

Offset 1 MB ────────────────────────────────────────────
```

**Why fixed-region FAT (vs superblock + pointer).**
- Real filesystems (ext4, ZFS) use a superblock with replicated backups. That's the more "correct" design, but it introduces an extra indirection layer that itself needs fault tolerance — multiplying the redundancy work in v2.
- The disk is 1 MB and the workload is ~100 files of 10–500 bytes (~25 KB payload). Flexibility from a superblock buys nothing.
- Fixed offsets are simpler to reason about for v2 replica placement.

**Why append-only data log (vs contiguous-with-free-list, or block-based).**
- **The test harness never deletes or truncates files.** Free-space reclamation is solving a problem that does not exist in this workload.
- Append-only is ~3 lines of allocation logic: maintain a `nextOffset`, advance after each write.
- Cost: rewriting the same filename leaves old bytes orphaned in the log. With 25 KB of payload on a 1 MB disk, the wasted space is irrelevant.

**Alternatives considered.**
- Block-based allocation (e.g., 128 B fixed blocks). Better for v2 *block-level* replica swapping, worse for v1 simplicity. Decision: stay simple in v1; if v2 needs block-level recovery, migrate then.
- Contiguous allocation with free-space tracking. Identical to append-only for this workload (no deletes), but adds dead code (a free-list nothing ever populates).

**Why 32 KB / 256-slot budget.**
- 256 slots gives 2.5× headroom over the 100-file test workload.
- 32 KB is 3.2% of the disk — negligible overhead.

---

## 3. FAT entry format: binary packed, 80 bytes

```
[ name           : 64 bytes ]   UTF-8, zero-padded
[ offset         :  4 bytes ]   uint32, big-endian
[ length         :  4 bytes ]   uint32, big-endian
[ dataChecksum   :  4 bytes ]   CRC32 of file content, big-endian
[ entryChecksum  :  4 bytes ]   CRC32 of preceding 76 bytes, big-endian
```

**Why binary packed (vs JSON blob).**
- JSON's failure mode is catastrophic: one corrupt byte anywhere in the blob makes the whole table unparseable, losing every file. That's the exact "data integrity failure" mode the test punishes.
- Binary entries are independently checksummed, so corruption in one slot doesn't blast the others.
- Random access: writing entry 47 means seeking to `47 * 80` and writing 80 bytes — no whole-table re-serialization required.
- Easier replication in v2: replicas can be entry-aligned at fixed offsets.

**Why a 64-byte filename cap.**
- Test workload uses names up to ~17 chars (`test_file_99.txt`). 64 bytes is 4× headroom.
- Fixed-size names enable random-access lookup by slot index.

**Why no `valid` byte.**
- With two-layer checksums, the entry checksum is the single source of truth for "is this slot in use." A fresh disk's zero-filled slot has an `entryChecksum` field of `0x00000000` but the CRC32 of 76 zero bytes is *not* zero, so the check fails naturally and the slot is treated as empty.
- An explicit `valid` byte introduces ambiguity: what should we do if `valid=1` but the checksum is bad? Eliminating the field eliminates the question.

**Why CRC32 (vs SHA-256, MD5).**
- For *random* byte-flip corruption (the only failure mode the simulator produces), CRC32's 1-in-4-billion false-match rate is indistinguishable from SHA-256's.
- CRC32 is what real filesystems use for metadata (ext4, zlib, Ethernet frames) — matching the domain convention.
- 4 bytes per checksum × ~200 checksums = ~800 B overhead. SHA-256 would be 32 bytes × 200 = 6.4 KB. Neither matters on a 1 MB disk, but smaller is cleaner.
- Trade-off: requires the `crc-32` npm dependency. The starter code's `crypto.createHash('crc32')` is broken (Node's crypto module does not support CRC32), so a checksum library change is required regardless.

---

## 4. Two-layer checksums

Every read path validates **two** checksums:

1. **Entry checksum** — covers the entry's `name + offset + length + dataChecksum`. Verifies that the FAT entry itself was not corrupted.
2. **Data checksum** — covers the file's actual bytes in the data region. Verifies that the content was not corrupted.

**Why both layers.**
- Without the entry-level checksum, a corrupted `offset` field would silently send `readFile` to the wrong region of disk, where it would read someone else's bytes (or zeros) and possibly return them as if they were the requested file. The data checksum would catch the mismatch *for the actual content*, but not the fact that we were looking in the wrong place. Both layers together mean: if either tier of metadata is wrong, we fail closed.

---

## 5. FAT lifecycle: lazy-load, in-memory cache, write-through

**Decision.**
- On first operation (not in constructor — constructors are sync, async loads aren't), read the FAT region from disk, decode entries, validate entry checksums, populate an in-memory `FATEntry[]`.
- Subsequent reads of file *metadata* hit the cache. Reads of file *data* always hit the disk.
- Every `writeFile` updates the in-memory cache and immediately rewrites the full 32 KB FAT region to disk.

**Why caching is correct (and how real filesystems do it).**
- The "disk-only, re-read every time" model is *not* how real filesystems work. ext4 uses the Linux inode/dentry cache; ZFS uses the ARC; FAT32 caches the FAT. The disk is the source of truth on *mount*, after which a cache serves operations and is flushed back on changes.
- In this assignment, each `new FileSystem(disk)` is conceptually one mount: the test harness constructs a fresh `FileSystem` for Levels 2 and 3, which forces a fresh disk-read on every "remount." That mirrors reboot semantics.

**Why full-FAT rewrite on every change (vs single-slot updates).**
- With 80-byte slots and ~100 writes per test run, the total rewrite traffic is ~3 MB over the run — trivially cheap.
- Single-slot updates are fiddlier (offset math, partial writes) for a workload that doesn't need the optimization.

**Why file data is never cached.**
- The whole point of Level 2 is detecting corruption on disk. Caching file data would mean the cache could serve a "correct" copy while the disk has rotted, defeating the test.

---

## 6. Allocation: next-offset derived from FAT

**Decision.** `nextOffset` is a single in-memory integer initialized to `max(entry.offset + entry.length)` across all valid FAT entries (or the start of the data region if the FAT is empty). Advances by `content.length` after each successful write.

**Why derived (vs stored as a separate header).**
- Storing it explicitly creates another piece of state to fault-tolerate. A corrupt `nextOffset` field could redirect future writes into the middle of existing files — a worse failure than any in v1.
- The FAT entries already encode the information needed to reconstruct `nextOffset`. Derived state has no truth-divergence risk.

**Half-write failure policy.** If a write throws partway through (e.g., disk write fails after the data was written but before the FAT was updated), the half-written bytes become orphaned in the data region but no FAT entry points at them. `nextOffset` is **only advanced after the FAT update succeeds**, so the next write goes to the same offset and overwrites the orphans. Correctness is preserved; a small amount of space leaks per failure. No transactional rollback in v1 — too much machinery for a workload that has no observed failure mode.

---

## 7. API contract

| Call | Behavior |
|---|---|
| `writeFile(name, content)` with new name | Allocate slot, append data, update FAT, persist |
| `writeFile(name, content)` with existing name | **Overwrite**: update the existing FAT entry to point at the new bytes. Old bytes become orphan junk in the data region. |
| `writeFile(empty name)` | Reject: `"Filename cannot be empty"` |
| `writeFile` with name > 64 bytes (UTF-8) | Reject: `"Filename too long (max 64 bytes)"` |
| `writeFile` with content too big for remaining data region | Reject: `"Insufficient disk space"` |
| `writeFile` when all 256 FAT slots are used | Reject: `"File table full"` |
| `readFile(name)` non-existent | Error: `"File not found: <name>"` |
| `readFile` with corrupted FAT entry | Error: `"Metadata corruption detected for <name>"` |
| `readFile` with corrupted data | Error: `"Data corruption detected in <name>"` |
| `listFiles()` | Return names from valid FAT entries; silently skip entries whose checksum fails |

**Why overwrite by default (vs reject + flag).**
- Every modern filesystem overwrites on the equivalent operation (POSIX `open(O_TRUNC)`, shell `>` redirection, `cp`). Forcing callers to pass a flag would be a surprising API.
- The README's "Advanced Challenges" section describes self-healing as *"reads and writes happen over time to same files"* — i.e., the same filename is written multiple times to refresh against corruption. Rejecting duplicate writes would make self-healing impossible to implement on top of this filesystem.
- Accidental-clobber protection is the caller's responsibility (analogous to `cp -i`), not the filesystem's.

**Why `listFiles` skips corrupt entries (vs failing).**
- A user with 100 files where 3 entries got hit by corruption is better served by a list of the 97 surviving names than by a hard failure. Listing and reading are different operations; failing the easy one because of a tiny bit of damage is a bad trade.

---

## 8. v2 migration path (Level 3, recovery)

The v1 design is intentionally friendly to a v2 that adds redundancy:

- **FAT replication.** Store 2–3 copies of the FAT region at fixed offsets (e.g., immediately following the primary, and another near disk end). On load, read all copies, prefer entries whose checksums verify, fall back to other copies when one is corrupt.
- **Data replication.** Store each file at multiple offsets (e.g., `offset` and `offset + Δ` where Δ is chosen to spread copies across the disk). FAT entry can grow a second `(offset, checksum)` pair, or the second copy can be derived deterministically.
- **Erasure coding (optional).** If naive replication doesn't survive 30% corruption rates, Reed-Solomon over data blocks gives more correction power per byte of overhead — at the cost of significantly more implementation complexity.

The append-only log + binary FAT format is compatible with all three: replica placement is just additional fixed offsets; encoding can be layered into the FAT entry without breaking v1 entries (versioned format byte, etc.).
