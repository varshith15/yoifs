import CRC32 from 'crc-32';
import { Disk } from './index';

// Result type for file system operations
interface FileSystemResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * YOIFS v2 — Fault-Tolerant File System with Recovery
 *
 * Layers on top of v1's detection foundation to add *recovery* via
 * 4-way zoned replication with byte-wise plurality voting and
 * automatic self-healing on read.
 *
 * v1 (Levels 1+2): operations + detection only. Corrupted files were
 *   reported as detected corruption.
 * v2 (Level 3):    same operations + same detection, plus recovery.
 *   At 10% byte corruption, ~95% of files now read successfully
 *   instead of v1's ~1%. Zero data integrity failures preserved.
 *
 * See DESIGN.md for the full architectural rationale.
 *   Part 1 (§§1-7): v1 foundation (still in force where unchanged).
 *   Part 2 (§§8-14): v2 — what this file implements.
 *   Part 3 (§15): v3 migration path to Reed-Solomon.
 */

// --- v2 layout constants (DESIGN.md §9) -------------------------------------
// The 1 MB disk is divided into 4 equal zones. Each zone is a self-contained
// replica: 32 KB FAT copy at zone start, then 224 KB data region. Files live
// at the same relative offset in every zone, so a single shared nextOffset
// suffices and no per-file offset list is needed in the FAT entry.
const N_ZONES = 4;
const ZONE_SIZE = 256 * 1024;                       // 4 × 256 KB = 1 MB exactly
const FAT_OFFSET_IN_ZONE = 0;
const FAT_SIZE = 32 * 1024;                         // unchanged from v1
const DATA_OFFSET_IN_ZONE = FAT_SIZE;
const DATA_SIZE_PER_ZONE = ZONE_SIZE - FAT_SIZE;    // 224 KB available per file copy

// --- FAT entry constants (unchanged from v1, see DESIGN.md §3 and §10) -----
const MAX_FILES = 256;
const ENTRY_SIZE = 80;
const NAME_SIZE = 64;
const OFF_NAME = 0;
const OFF_OFFSET = 64;
const OFF_LENGTH = 68;
const OFF_DATA_CHECKSUM = 72;
const OFF_ENTRY_CHECKSUM = 76;
const ENTRY_CHECKED_BYTES = 76;

interface FATEntry {
  name: string;
  offset: number;        // zone-relative offset in [0, DATA_SIZE_PER_ZONE) — see DESIGN.md §10
  length: number;
  dataChecksum: Buffer;  // 4-byte CRC32 of file content
}

export class FileSystem {
  private disk: Disk;
  private fat: (FATEntry | null)[] | null = null;
  private fatPromise: Promise<void> | null = null;
  // Zone-relative offset of the next free byte in any zone's data region.
  // Shared across zones because every file lives at the same relative
  // offset in every zone (DESIGN.md §9, §12).
  private nextOffset: number = 0;

  constructor(disk: Disk) {
    this.disk = disk;
  }

  /** Write a file. Replicated to all 4 zones; all-or-nothing per DESIGN.md §12. */
  async writeFile(filename: string, content: Buffer): Promise<FileSystemResult<void>> {
    try {
      await this.ensureFAT();

      if (filename.length === 0) {
        return { success: false, error: 'Filename cannot be empty' };
      }
      const nameBytes = Buffer.byteLength(filename, 'utf8');
      if (nameBytes > NAME_SIZE) {
        return { success: false, error: `Filename too long (max ${NAME_SIZE} bytes UTF-8)` };
      }
      // Data must fit in one zone's data region (it's mirrored to all 4 zones).
      if (this.nextOffset + content.length > DATA_SIZE_PER_ZONE) {
        return { success: false, error: 'Insufficient disk space' };
      }

      const fat = this.fat!;
      let slotIndex = fat.findIndex(e => e !== null && e.name === filename);
      if (slotIndex < 0) {
        slotIndex = fat.findIndex(e => e === null);
        if (slotIndex < 0) {
          return { success: false, error: 'File table full' };
        }
      }

      const writeOffset = this.nextOffset;

      // Fan-out: write content to all 4 zones at the same relative offset.
      // All-or-nothing: any throw rolls the whole call back; orphan bytes in
      // succeeded zones are tolerated and overwritten by the next write
      // because nextOffset has not been advanced yet (DESIGN.md §12).
      await Promise.all(
        Array.from({ length: N_ZONES }, (_, z) =>
          this.disk.write(this.zoneDataOffset(z, writeOffset), content)
        )
      );

      const newEntry: FATEntry = {
        name: filename,
        offset: writeOffset,
        length: content.length,
        dataChecksum: this.calculateChecksum(content),
      };

      const prevSlot = fat[slotIndex];
      fat[slotIndex] = newEntry;
      try {
        await this.saveFAT();
      } catch (err) {
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
   * Read a file. Fast path tries zone 0 alone; on CRC failure, falls back to
   * byte-wise plurality voting across all 4 zones. Successful slow-path
   * recovery triggers self-healing of disagreeing zones (DESIGN.md §11, §13).
   */
  async readFile(filename: string): Promise<FileSystemResult<Buffer>> {
    try {
      await this.ensureFAT();

      const entry = this.fat!.find(e => e !== null && e.name === filename);
      if (!entry) {
        return { success: false, error: `File not found: ${filename}` };
      }
      if (entry.offset < 0 || entry.offset + entry.length > DATA_SIZE_PER_ZONE) {
        return { success: false, error: `Metadata corruption detected for ${filename}` };
      }

      // Fast path: read only zone 0 and verify CRC. ~99% of reads at low
      // corruption land here and skip the slow path entirely.
      const zone0 = await this.disk.read(this.zoneDataOffset(0, entry.offset), entry.length);
      if (this.calculateChecksum(zone0).equals(entry.dataChecksum)) {
        return { success: true, data: Buffer.from(zone0) };
      }

      // Slow path: read remaining 3 zones, byte-vote across all 4, verify CRC.
      const others = await Promise.all(
        [1, 2, 3].map(z => this.disk.read(this.zoneDataOffset(z, entry.offset), entry.length))
      );
      const copies = [zone0, ...others];
      const { result, disagreeMask } = this.voteBytes(copies);

      if (!this.calculateChecksum(result).equals(entry.dataChecksum)) {
        // Vote failed too — corruption beyond what 4-way voting can fix.
        // Same v1 contract: report detection, never silently return bad bytes.
        return { success: false, error: `Data corruption detected in ${filename}` };
      }

      // Self-heal: write the reconstructed bytes back to every zone whose
      // copy disagreed with the vote. Fire-and-forget — failures here are
      // non-fatal because the recovered data is already in memory
      // (DESIGN.md §13).
      this.healDataZones(entry.offset, Buffer.from(result), disagreeMask);

      return { success: true, data: Buffer.from(result) };
    } catch (error) {
      return { success: false, error: `Read error: ${error}` };
    }
  }

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

  /**
   * Iterate every known file and attempt to read it. Healthy = read succeeded
   * (possibly after recovery via byte-vote). Corrupted = read failed beyond
   * what voting could recover.
   */
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
      return { success: true, data: { healthy, corrupted } };
    } catch (error) {
      return { success: false, error: `Health check error: ${error}` };
    }
  }

  // --- Checksum + FAT entry ser/de (UNCHANGED from v1, DESIGN.md §3, §4) ----

  private calculateChecksum(data: Buffer): Buffer {
    const out = Buffer.alloc(4);
    out.writeInt32BE(CRC32.buf(data), 0);
    return out;
  }

  private encodeEntry(entry: FATEntry): Buffer {
    const buf = Buffer.alloc(ENTRY_SIZE);
    buf.write(entry.name, OFF_NAME, NAME_SIZE, 'utf8');
    buf.writeUInt32BE(entry.offset, OFF_OFFSET);
    buf.writeUInt32BE(entry.length, OFF_LENGTH);
    entry.dataChecksum.copy(buf, OFF_DATA_CHECKSUM, 0, 4);
    const entryChecksum = this.calculateChecksum(buf.subarray(0, ENTRY_CHECKED_BYTES));
    entryChecksum.copy(buf, OFF_ENTRY_CHECKSUM, 0, 4);
    return buf;
  }

  private decodeEntry(buf: Buffer): FATEntry | null {
    const expected = this.calculateChecksum(buf.subarray(0, ENTRY_CHECKED_BYTES));
    const stored = buf.subarray(OFF_ENTRY_CHECKSUM, OFF_ENTRY_CHECKSUM + 4);
    if (!expected.equals(stored)) return null;

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

  // --- Zone arithmetic (DESIGN.md §9) ---------------------------------------

  private zoneFatOffset(z: number): number {
    return z * ZONE_SIZE + FAT_OFFSET_IN_ZONE;
  }

  private zoneDataOffset(z: number, relative: number): number {
    return z * ZONE_SIZE + DATA_OFFSET_IN_ZONE + relative;
  }

  // --- Byte-wise plurality voting (DESIGN.md §8) ----------------------------
  //
  // Why this works under random byte corruption: a corrupted byte becomes a
  // random value (0-255). N copies' votes for corrupted positions are scattered
  // across 255 wrong values; if even one copy is uncorrupted at a position,
  // the correct value almost always wins because corrupted votes rarely agree
  // with each other (P ≈ 1/256 per pair).
  //
  // Tie-breaking: when two values are tied at the current max count, the one
  // that *reached* that count first wins. This is deterministic and order-
  // sensitive in copy index, which is fine — at low corruption, zone 0 wins
  // most ties (preserving "fast path correctness equivalence"); at high
  // corruption, ties at the max are rare anyway.

  private voteBytes(copies: Buffer[]): { result: Buffer; disagreeMask: boolean[] } {
    const N = copies.length;
    const len = copies[0].length;
    const result = Buffer.alloc(len);
    const disagreeMask = new Array<boolean>(N).fill(false);
    const counts = new Uint8Array(256);

    for (let i = 0; i < len; i++) {
      counts.fill(0);
      let winner = 0;
      let winnerCount = 0;
      for (let z = 0; z < N; z++) {
        const v = copies[z][i];
        counts[v]++;
        if (counts[v] > winnerCount) {
          winner = v;
          winnerCount = counts[v];
        }
      }
      result[i] = winner;
      for (let z = 0; z < N; z++) {
        if (copies[z][i] !== winner) {
          disagreeMask[z] = true;
        }
      }
    }

    return { result, disagreeMask };
  }

  // --- Self-healing writes (DESIGN.md §13) ----------------------------------
  // Fire-and-forget. The recovered bytes are already in memory and returned
  // to the caller; failure to heal a zone just means the next read will heal
  // it instead.

  private healDataZones(relativeOffset: number, bytes: Buffer, disagreeMask: boolean[]): void {
    const writes: Promise<void>[] = [];
    for (let z = 0; z < N_ZONES; z++) {
      if (disagreeMask[z]) {
        writes.push(this.disk.write(this.zoneDataOffset(z, relativeOffset), bytes));
      }
    }
    if (writes.length > 0) {
      Promise.all(writes).catch(() => { /* non-fatal */ });
    }
  }

  private healFATSlot(slotIdx: number, slotBytes: Buffer, disagreeMask: boolean[]): void {
    const writes: Promise<void>[] = [];
    for (let z = 0; z < N_ZONES; z++) {
      if (disagreeMask[z]) {
        writes.push(this.disk.write(this.zoneFatOffset(z) + slotIdx * ENTRY_SIZE, slotBytes));
      }
    }
    if (writes.length > 0) {
      Promise.all(writes).catch(() => { /* non-fatal */ });
    }
  }

  // --- FAT lifecycle (DESIGN.md §14, replaces v1 §5) ------------------------

  private async ensureFAT(): Promise<void> {
    if (this.fat !== null) return;
    if (!this.fatPromise) {
      this.fatPromise = this.loadFAT();
    }
    await this.fatPromise;
  }

  /**
   * Read all 4 zones' FAT regions, reconstruct each slot. Fast path: try
   * zone 0's slot; if it decodes, take it. Slow path: byte-vote across all
   * 4 zones' slot bytes, then try decoding the result. Slots that fail both
   * paths are treated as empty (same v1 semantics).
   */
  private async loadFAT(): Promise<void> {
    // Read all FAT regions upfront — total 128 KB, trivial cost, and any
    // non-trivial corruption rate will require voting on most slots anyway.
    const fatBuffers = await Promise.all(
      Array.from({ length: N_ZONES }, (_, z) =>
        this.disk.read(this.zoneFatOffset(z), FAT_SIZE)
      )
    );

    const slots: (FATEntry | null)[] = new Array(MAX_FILES);
    let maxEnd = 0;

    for (let i = 0; i < MAX_FILES; i++) {
      const slotStart = i * ENTRY_SIZE;
      const slotEnd = slotStart + ENTRY_SIZE;

      // Fast path
      const zone0Slot = fatBuffers[0].subarray(slotStart, slotEnd);
      const fast = this.decodeEntry(zone0Slot);
      if (fast !== null) {
        slots[i] = fast;
        const end = fast.offset + fast.length;
        if (end > maxEnd) maxEnd = end;
        continue;
      }

      // Slow path: byte-vote across all 4 zones' slots
      const slotCopies = fatBuffers.map(buf => buf.subarray(slotStart, slotEnd));
      const { result, disagreeMask } = this.voteBytes(slotCopies);
      const recovered = this.decodeEntry(result);
      if (recovered !== null) {
        slots[i] = recovered;
        const end = recovered.offset + recovered.length;
        if (end > maxEnd) maxEnd = end;
        // Self-heal disagreeing zones for this slot
        this.healFATSlot(i, Buffer.from(result), disagreeMask);
      } else {
        slots[i] = null;
      }
    }

    this.fat = slots;
    this.nextOffset = maxEnd;
  }

  /** Build the canonical 32 KB FAT buffer and write it to all 4 zones. */
  private async saveFAT(): Promise<void> {
    const buf = Buffer.alloc(FAT_SIZE);
    const fat = this.fat!;
    for (let i = 0; i < MAX_FILES; i++) {
      const entry = fat[i];
      if (entry === null) continue;
      const encoded = this.encodeEntry(entry);
      encoded.copy(buf, i * ENTRY_SIZE);
    }
    await Promise.all(
      Array.from({ length: N_ZONES }, (_, z) =>
        this.disk.write(this.zoneFatOffset(z), buf)
      )
    );
  }
}
