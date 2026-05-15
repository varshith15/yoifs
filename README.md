# YOIFS

Welcome to Your Own Indestructible File System.

This project seeds the idea of a simple fault-tolerant file system that can handle disk corruption and maintain data integrity. It doesn't compete with zfs, but it's your own!

## Getting started

To start, you need to implement YOIFS. In an ideal world, an industructible file system should -

1. **Basic Operations**: Store, retrieve, and list files on a simulated disk
2. **Corruption Detection**: Detect when data has been corrupted on disk
3. **Fault Tolerance**: Maintain functionality even when parts of the disk are corrupted

YOIFS does ship with a test harness that will help you tell how indestructible your file system is, by testing against increasing levels of data corruption to determine its fault tolerance limits.


## Architecture

The project consists of several key components:

- **`FileSystem`** (`solution.ts`): The main file system implementation (your code goes here)
- **`Disk`** interface: Abstraction for disk operations (read/write at offsets)
- **`MemoryDisk`**: In-memory disk implementation for testing
- **`CorruptionSimulator`**: Introduces controlled corruption for testing
- **`TestHarness`**: Comprehensive test suite with three levels of testing

## Design (this implementation — v1)

This implementation ships **Levels 1 + 2**: full file operations and reliable corruption *detection* via two-layer CRC32 checksums. Level 3 (recovery via replication / erasure coding) is intentionally deferred to v2.

The full architectural rationale — disk layout, FAT format, checksum strategy, allocation policy, edge-case handling, and the v2 migration path — lives in **[`DESIGN.md`](./DESIGN.md)**. Every non-trivial choice in `solution.ts` cites the section there.

v1 result against the test harness: 100% fault tolerance rate (successful + detected) at every corruption rate from 0.01% through 10%, with **zero** silent data integrity failures.

## Implementation Levels

### Level 1: Basic File System Operations
- Implement `writeFile()`, `readFile()`, and `listFiles()` methods
- Design a file allocation scheme (e.g., File Allocation Table)
- Handle multiple files and proper metadata storage

### Level 2: Corruption Detection
- Add checksums or other integrity verification mechanisms
- Detect corrupted data during read operations
- Return appropriate error messages when corruption is detected

### Level 3: Fault Tolerance Optimization
- Implement redundancy (e.g., data replication, error correction codes)
- Optimize for maximum fault tolerance under various corruption rates
- Handle partial corruption gracefully

## Getting Started

### Prerequisites
- Node.js (v16 or higher)
- pnpm package manager

### Installation

```bash
# Install dependencies
pnpm install
```

### Running the Tests

```bash
# Run the complete test suite
pnpm dev
```

## Test Suite Overview

The test harness runs three levels of tests:

1. **Basic Functionality**: Tests file operations without corruption
2. **Corruption Detection**: Introduces 1% corruption and tests detection capabilities
3. **Fault Tolerance Rate**: Tests system resilience across corruption rates from 0.1% to 30%

### Test Results Interpretation

- **Fault Tolerance Rate**: Percentage of files that are either read correctly or have corruption properly detected
- **Data Integrity Failures**: Cases where corrupted data is returned without detection (this is bad!)
- **Detection Rate**: How well the system identifies corrupted files

## Success Criteria

A successful implementation should:

- ✅ Pass all Level 1 tests (basic functionality)
- ✅ Detect corruption reliably (Level 2)
- ✅ Maintain >90% fault tolerance up to reasonable corruption rates
- ✅ Never return corrupted data without detection
- ✅ Gracefully degrade performance under high corruption

## Advanced Challenges

Once you have a working solution, consider:

- **Error Correction Codes**: Can you repair corrupted data instead of just detecting it?
- **Self healing**: In real life, reads and writes happen over time to same files. If you can fix errors at some frequency, you can keep the file system healthy.
- **Compression**: Reduce storage overhead while maintaining fault tolerance. Detect duplicate blocks maybe?
- **Concurrency**: How do you handle concurrent reads and writes, how does your system behave under different patterns?
- **Efficiency**: How much extra space do you need to store? How much extra time do you need to read and write?