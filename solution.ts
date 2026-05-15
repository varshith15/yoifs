import CRC32 from 'crc-32';
import { Disk } from './index';

// Result type for file system operations
interface FileSystemResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * YOIFS v1 — Fault-Tolerant File System (Levels 1 + 2)
 *
 * Implements basic file operations and corruption *detection* via two-layer
 * CRC32 checksums. Recovery / replication is deferred to v2 (Level 3).
 *
 * See DESIGN.md at the repo root for the full architectural rationale.
 *
 * High-level layout on a 1 MB disk:
 *
 *   [0 .. 32 KB)           FAT region — 256 fixed-size slots × 80 bytes
 *   [32 KB .. disk end)    Data region — append-only log
 *
 * Each FAT slot is independently checksummed, and each file's data has its
 * own checksum stored in its FAT slot. A read failure in either layer
 * surfaces as a *detected* corruption rather than a silent data integrity
 * failure (the unforgivable failure mode the test harness grades for).
 */

// --- On-disk format constants -----------------------------------------------
// Chosen to give plenty of headroom on the 1 MB test disk (workload is
// ~100 files × 10–500 B = ~25 KB payload). See DESIGN.md §2.
const FAT_OFFSET = 0;
const FAT_SIZE = 32 * 1024;          // 32 KB reserved; 256 slots × 80 B = 20.5 KB used, padded to a round 32 KB
const MAX_FILES = 256;               // 2.5× headroom over the 100-file test workload
const ENTRY_SIZE = 80;               // bytes per FAT slot (see encodeEntry layout)
const NAME_SIZE = 64;                // bytes reserved for filename (UTF-8, zero-padded)
const DATA_OFFSET = FAT_SIZE;        // data region begins immediately after FAT

// FAT entry on-disk byte offsets inside a single 80-byte slot.
// Layout: [name 64][offset 4 BE][length 4 BE][dataChecksum 4][entryChecksum 4]
const OFF_NAME = 0;
const OFF_OFFSET = 64;
const OFF_LENGTH = 68;
const OFF_DATA_CHECKSUM = 72;
const OFF_ENTRY_CHECKSUM = 76;
const ENTRY_CHECKED_BYTES = 76;      // entryChecksum covers the first 76 bytes of the slot

interface FATEntry {
  name: string;
  offset: number;        // byte offset in data region where the file's bytes live
  length: number;        // file size in bytes
  dataChecksum: Buffer;  // 4-byte CRC32 of the file's content bytes
}

export class FileSystem {
  private disk: Disk;

  // FAT cache. `null` slot = empty or unreadable (entry-checksum mismatch).
  //
  // Why cached: every modern filesystem caches its metadata (ext4 inode cache,
  // ZFS ARC, FAT32 in-memory copy). The disk is the source of truth on mount
  // (constructor / first op), the cache serves subsequent operations, and
  // changes are written through. File *data* is never cached — that would
  // defeat corruption detection on disk. See DESIGN.md §5.
  private fat: (FATEntry | null)[] | null = null;
  private fatPromise: Promise<void> | null = null;

  // Next free byte in the data region (append-only log).
  // Why derived from the FAT instead of stored separately: storing it on disk
  // would create another single point of failure whose corruption could
  // redirect writes into the middle of existing files. The FAT already
  // contains everything needed to reconstruct this. See DESIGN.md §6.
  private nextOffset: number = DATA_OFFSET;

  constructor(disk: Disk) {
    this.disk = disk;
  }

  /** Write a file to the disk. Overwrites if the name already exists. */
  async writeFile(filename: string, content: Buffer): Promise<FileSystemResult<void>> {
    try {
      await this.ensureFAT();

      // Input validation. Failing fast here keeps the on-disk format sane.
      if (filename.length === 0) {
        return { success: false, error: 'Filename cannot be empty' };
      }
      const nameBytes = Buffer.byteLength(filename, 'utf8');
      if (nameBytes > NAME_SIZE) {
        return { success: false, error: `Filename too long (max ${NAME_SIZE} bytes UTF-8)` };
      }
      if (this.nextOffset + content.length > this.disk.size()) {
        return { success: false, error: 'Insufficient disk space' };
      }

      // Locate slot: overwrite existing entry if name matches, else first empty slot.
      // Overwrite-by-default matches POSIX semantics (open(O_TRUNC), shell `>`, cp)
      // and is what the README's self-healing concept requires. Accidental-clobber
      // protection belongs in the caller, not the filesystem. See DESIGN.md §7.
      const fat = this.fat!;
      let slotIndex = fat.findIndex(e => e !== null && e.name === filename);
      if (slotIndex < 0) {
        slotIndex = fat.findIndex(e => e === null);
        if (slotIndex < 0) {
          return { success: false, error: 'File table full' };
        }
      }

      // Write data first. If this throws, no FAT entry will point to the
      // half-written bytes, so they remain harmless orphans. nextOffset is
      // only advanced *after* the FAT save succeeds, so a retry would
      // overwrite them. See DESIGN.md §6 (half-write policy).
      const writeOffset = this.nextOffset;
      await this.disk.write(writeOffset, content);

      const newEntry: FATEntry = {
        name: filename,
        offset: writeOffset,
        length: content.length,
        dataChecksum: this.calculateChecksum(content),
      };

      // Commit to FAT (in-memory) then persist the whole region (write-through).
      // Full-region rewrite is simple and the cost is trivial on this disk
      // (256 × 80 B = 20 KB per write, ~100 writes per test run = ~2 MB total).
      const prevSlot = fat[slotIndex];
      fat[slotIndex] = newEntry;
      try {
        await this.saveFAT();
      } catch (err) {
        // Roll back in-memory change so future ops see consistent state.
        fat[slotIndex] = prevSlot;
        throw err;
      }

      this.nextOffset = writeOffset + content.length;
      return { success: true };
    } catch (error) {
      return { success: false, error: `Write error: ${error}` };
    }
  }

  /**
   * Read a file from the disk.
   *
   * Returns a detected-corruption error if either the FAT entry's metadata
   * or the file's data fails its checksum. Never returns silently-corrupted
   * bytes — that is the v1 contract.
   */
  async readFile(filename: string): Promise<FileSystemResult<Buffer>> {
    try {
      await this.ensureFAT();

      // Corrupted FAT entries are filtered out during load (decodeEntry
      // returns null on checksum mismatch), so a lookup miss covers both
      // "file never existed" and "metadata corrupted beyond use".
      const entry = this.fat!.find(e => e !== null && e.name === filename);
      if (!entry) {
        return { success: false, error: `File not found: ${filename}` };
      }

      // Defensive bounds check before reading. A surviving (checksum-validated)
      // entry pointing outside the disk would mean simultaneous corruption that
      // collided to a valid CRC32 — astronomically unlikely (~1/2^32), but we
      // fail closed rather than throw a low-level disk error.
      if (entry.offset < DATA_OFFSET || entry.offset + entry.length > this.disk.size()) {
        return { success: false, error: `Metadata corruption detected for ${filename}` };
      }

      const data = await this.disk.read(entry.offset, entry.length);
      const actualChecksum = this.calculateChecksum(data);
      if (!actualChecksum.equals(entry.dataChecksum)) {
        return { success: false, error: `Data corruption detected in ${filename}` };
      }

      // Return a defensive copy so callers can't mutate disk-backed buffers.
      return { success: true, data: Buffer.from(data) };
    } catch (error) {
      return { success: false, error: `Read error: ${error}` };
    }
  }

  /**
   * List all files known to be valid. Entries whose FAT slot failed its
   * checksum are silently skipped — partial results are more useful than a
   * hard failure, and reading individual files separately re-surfaces any
   * data-level corruption. See DESIGN.md §7.
   */
  async listFiles(): Promise<FileSystemResult<string[]>> {
    try {
      await this.ensureFAT();
      const names = this.fat!
        .filter((e): e is FATEntry => e !== null)
        .map(e => e.name);
      return { success: true, data: names };
    } catch (error) {
      return { success: false, error: `List error: ${error}` };
    }
  }

  /** Optional: report counts of healthy vs corrupted files. */
  async checkSystemHealth(): Promise<FileSystemResult<{ healthy: number, corrupted: number; }>> {
    try {
      await this.ensureFAT();
      let healthy = 0;
      let corrupted = 0;
      for (const entry of this.fat!) {
        if (entry === null) continue;
        const res = await this.readFile(entry.name);
        if (res.success) healthy++;
        else corrupted++;
      }
      // FAT slots that failed entry-checksum are also "corrupted" but unnamed,
      // so we just count what we can identify. A more complete v2 would scan
      // FAT replicas to recover names too.
      return { success: true, data: { healthy, corrupted } };
    } catch (error) {
      return { success: false, error: `Health check error: ${error}` };
    }
  }

  // --- Checksums -------------------------------------------------------------
  //
  // CRC32 chosen over SHA-256 because:
  //  1. For *random* byte-flip corruption (the only failure mode the simulator
  //     produces), CRC32's 1-in-2^32 false-match rate is indistinguishable from
  //     SHA-256's stronger guarantees.
  //  2. CRC32 is what real filesystems use for metadata (ext4, zlib, Ethernet).
  //  3. 4 bytes vs 32 bytes per stored checksum — smaller is cleaner, though
  //     neither matters on a 1 MB disk.
  // The starter code's `crypto.createHash('crc32')` is broken (Node's crypto
  // does not support CRC32), so a library swap was required anyway. See
  // DESIGN.md §3 for the full algorithm comparison.
  private calculateChecksum(data: Buffer): Buffer {
    const out = Buffer.alloc(4);
    out.writeInt32BE(CRC32.buf(data), 0);
    return out;
  }

  // --- FAT entry serialization -----------------------------------------------
  //
  // Binary packed (vs JSON) because a single byte flip in a JSON FAT blob makes
  // the whole table unparseable — losing every file. Binary slots are
  // independently checksummed, so corruption in one slot doesn't contaminate
  // neighbors. See DESIGN.md §3.

  private encodeEntry(entry: FATEntry): Buffer {
    const buf = Buffer.alloc(ENTRY_SIZE);
    // Filename: UTF-8, zero-padded to NAME_SIZE bytes. Validated <= NAME_SIZE upstream.
    buf.write(entry.name, OFF_NAME, NAME_SIZE, 'utf8');
    buf.writeUInt32BE(entry.offset, OFF_OFFSET);
    buf.writeUInt32BE(entry.length, OFF_LENGTH);
    entry.dataChecksum.copy(buf, OFF_DATA_CHECKSUM, 0, 4);
    // entryChecksum covers everything before it. Computing last means any later
    // change to the entry requires recomputing, which we always do in encode.
    const entryChecksum = this.calculateChecksum(buf.subarray(0, ENTRY_CHECKED_BYTES));
    entryChecksum.copy(buf, OFF_ENTRY_CHECKSUM, 0, 4);
    return buf;
  }

  private decodeEntry(buf: Buffer): FATEntry | null {
    // Verify the entry checksum first. A failure here means either:
    //  (a) the slot has never been written (fresh disk: zeros, whose CRC32 is
    //      non-zero, so the stored zero checksum mismatches), or
    //  (b) the slot was corrupted on disk.
    // Both cases are handled identically: the slot is unusable, treat as null.
    // This obviates a separate `valid` byte. See DESIGN.md §3.
    const expected = this.calculateChecksum(buf.subarray(0, ENTRY_CHECKED_BYTES));
    const stored = buf.subarray(OFF_ENTRY_CHECKSUM, OFF_ENTRY_CHECKSUM + 4);
    if (!expected.equals(stored)) return null;

    // Filename: trim trailing zero padding.
    const nameBuf = buf.subarray(OFF_NAME, OFF_NAME + NAME_SIZE);
    const firstZero = nameBuf.indexOf(0);
    const nameEnd = firstZero === -1 ? NAME_SIZE : firstZero;
    const name = nameBuf.subarray(0, nameEnd).toString('utf8');

    return {
      name,
      offset: buf.readUInt32BE(OFF_OFFSET),
      length: buf.readUInt32BE(OFF_LENGTH),
      dataChecksum: Buffer.from(buf.subarray(OFF_DATA_CHECKSUM, OFF_DATA_CHECKSUM + 4)),
    };
  }

  // --- FAT lifecycle ---------------------------------------------------------

  /** Lazy-load FAT on first operation; single-flight via fatPromise. */
  private async ensureFAT(): Promise<void> {
    if (this.fat !== null) return;
    if (!this.fatPromise) {
      this.fatPromise = this.loadFAT();
    }
    await this.fatPromise;
  }

  private async loadFAT(): Promise<void> {
    const region = await this.disk.read(FAT_OFFSET, FAT_SIZE);
    const slots: (FATEntry | null)[] = new Array(MAX_FILES);
    let maxEnd = DATA_OFFSET;
    for (let i = 0; i < MAX_FILES; i++) {
      const slotBuf = region.subarray(i * ENTRY_SIZE, (i + 1) * ENTRY_SIZE);
      const entry = this.decodeEntry(slotBuf);
      slots[i] = entry;
      if (entry !== null) {
        const end = entry.offset + entry.length;
        if (end > maxEnd) maxEnd = end;
      }
    }
    this.fat = slots;
    this.nextOffset = maxEnd;
  }

  /** Write the entire FAT region to disk (write-through). */
  private async saveFAT(): Promise<void> {
    const buf = Buffer.alloc(FAT_SIZE);
    const fat = this.fat!;
    for (let i = 0; i < MAX_FILES; i++) {
      const entry = fat[i];
      if (entry === null) continue;            // empty slots stay zero-filled
      const encoded = this.encodeEntry(entry);
      encoded.copy(buf, i * ENTRY_SIZE);
    }
    await this.disk.write(FAT_OFFSET, buf);
  }
}
