/**
 * Monero's own binary archive, reading only.
 *
 * ## Which format this is, because the obvious guess is wrong
 *
 * `docs/monero-signing.md` spent a long time saying the unsigned transaction
 * set was a Boost `portable_binary_oarchive` and that reading it meant
 * matching a C++ library by its behaviour. That was wrong twice over, and the
 * correction is worth stating at the top of the file it changed:
 *
 *   - `wallet2::dump_tx_to_str` writes with `binary_archive<true>`
 *     (`wallet2.cpp:7678`), which is Monero's own framework, defined in
 *     `src/serialization/`.
 *   - `parse_unsigned_tx_from_str` reaches Boost only for version `\003`, and
 *     only when `m_load_deprecated_formats` is set, which is off by default.
 *     The current prefix is `"Monero unsigned tx set\005"`.
 *
 * So this is a small, written-down format rather than a library's behaviour,
 * and it has no object tracking, no pointers and no class-version registry.
 *
 * ## The rules, all of them
 *
 * - **fixed integers**: little-endian, `sizeof(T)` bytes. This is what a plain
 *   `FIELD(x)` produces for an integer member.
 * - **varints**: LEB128, seven bits per byte, high bit continues. This is what
 *   `VARINT_FIELD(x)` produces.
 * - **blobs**: raw bytes, no length prefix. Keys, hashes, masks.
 * - **strings**: a varint length, then that many bytes.
 * - **arrays**: a varint count, then the elements.
 * - **pairs**: a varint `2`, then the two elements.
 * - **bool**: one byte, via `serialize_blob`.
 *
 * ## The rule that will bite somebody
 *
 * An unsigned integer wider than one byte is a **varint when it is an element
 * of a container or a pair**, and **fixed-width when it is a struct field**.
 * Same type, same name, two encodings, chosen by where it sits:
 *
 *     tx_source_entry::amount        FIELD(amount)          8 fixed bytes
 *     tx_destination_entry::amount   VARINT_FIELD(amount)   varint
 *     output_entry.first             pair element           varint
 *
 * `serialize_container_element` and `serialize_pair_element` are where that is
 * decided (`src/serialization/container.h`, `pair.h`), on
 * `is_unsigned && sizeof(T) > 1`. A reader that gets it backwards still parses
 * and still produces amounts; it is simply wrong. `readVarintU64` and
 * `readU64` are separate functions here rather than one function with a flag
 * for exactly that reason: at every call site the choice is visible.
 *
 * ## Refusals
 *
 * Every method throws `ArchiveError` rather than returning a partial answer.
 * This reads a file that arrived from outside, so running off the end, a
 * non-canonical varint or an absurd array count are all conditions where the
 * only safe answer is nothing at all. The caller in monerounsigned.ts turns
 * these into a refusal.
 */

export class ArchiveError extends Error {
  constructor(message: string, readonly at: number) {
    super(`${message} (at byte ${at})`);
    this.name = 'ArchiveError';
  }
}

/**
 * A ceiling on any single array or string.
 *
 * The format states a length before the bytes that justify it, so a hostile
 * file can claim an enormous one. This is far above any real transaction set
 * and far below anything that hurts; the reader also checks the claim against
 * what is actually left, which catches the rest.
 */
export const MAX_ARRAY = 1_000_000;

export class BinaryArchive {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.at;
  }

  get remaining(): number {
    return this.bytes.length - this.at;
  }

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.at + n > this.bytes.length) {
      throw new ArchiveError(`${what} needs ${n} bytes and ${this.remaining} remain`, this.at);
    }
  }

  /** Raw bytes, no length prefix. Keys, hashes, masks. */
  readBlob(n: number): Uint8Array {
    this.need(n, 'a blob');
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }

  /** Exactly 32 bytes, which is every key and hash in this format. */
  readKey(): Uint8Array {
    return this.readBlob(32);
  }

  readU8(): number {
    this.need(1, 'a byte');
    return this.bytes[this.at++]!;
  }

  /**
   * `serialize_blob(&v, sizeof(bool))`, which is one byte.
   *
   * Anything other than 0 or 1 is refused. C++ will happily treat 0x02 as
   * true, and a file that reached this reader is a file somebody else wrote;
   * a byte that is not a bool means the offset is wrong, and continuing from a
   * wrong offset is how a parser invents a transaction.
   */
  readBool(): boolean {
    const byte = this.readU8();
    if (byte > 1) throw new ArchiveError(`a bool was ${byte}`, this.at - 1);
    return byte === 1;
  }

  /** Fixed-width little-endian, as a plain `FIELD` on an integer writes it. */
  readU32(): number {
    this.need(4, 'a uint32');
    const b = this.bytes;
    const i = this.at;
    this.at += 4;
    return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! * 0x1000000)) >>> 0;
  }

  /** Fixed-width little-endian. Returned as a bigint: Monero amounts are
   *  atomic units and exceed what a JavaScript number holds exactly. */
  readU64(): bigint {
    this.need(8, 'a uint64');
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(this.bytes[this.at + i]!);
    this.at += 8;
    return value;
  }

  /**
   * LEB128, with Monero's own canonicality rules.
   *
   * `tools::read_varint` refuses two things and so does this: a continuation
   * that would overflow the target width, and a zero byte in any position but
   * the first, which is a longer encoding of a value that had a shorter one.
   * Both are `EVARINT_*` errors upstream. Accepting them would mean two
   * different byte strings decode to the same set, which is the kind of
   * malleability that makes a signature over "the file" meaningless.
   */
  readVarintU64(): bigint {
    const start = this.at;
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (this.done) throw new ArchiveError('a varint ran off the end', start);
      const byte = this.readU8();
      if (byte === 0 && shift !== 0n) {
        throw new ArchiveError('a varint had a non-canonical trailing zero', this.at - 1);
      }
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift >= 70n) throw new ArchiveError('a varint is too long for 64 bits', start);
    }
    if (value >= 1n << 64n) throw new ArchiveError('a varint overflowed 64 bits', start);
    return value;
  }

  /** A varint that has to fit a JavaScript number, for counts and indices. */
  readVarintNumber(what = 'a count'): number {
    const value = this.readVarintU64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArchiveError(`${what} is larger than this reader will hold`, this.at);
    }
    return Number(value);
  }

  /**
   * `begin_array`: a varint count, checked against what is actually left.
   *
   * `minimumElementBytes` is how small one element could possibly be, so a
   * file claiming a million of something that cannot fit is refused before
   * anything is allocated rather than after.
   */
  readCount(what: string, minimumElementBytes = 1): number {
    const count = this.readVarintNumber(`${what} count`);
    if (count > MAX_ARRAY) throw new ArchiveError(`${what} claims ${count} entries`, this.at);
    if (count * minimumElementBytes > this.remaining) {
      throw new ArchiveError(
        `${what} claims ${count} entries and only ${this.remaining} bytes remain`,
        this.at,
      );
    }
    return count;
  }

  /** An array, with each element read by `read`. */
  readArray<T>(what: string, minimumElementBytes: number, read: (index: number) => T): T[] {
    const count = this.readCount(what, minimumElementBytes);
    const out: T[] = [];
    for (let i = 0; i < count; i++) out.push(read(i));
    return out;
  }

  /**
   * The `2` a pair writes before its elements.
   *
   * Read and checked rather than skipped. It is the one piece of redundancy
   * this format has, and a stream that has desynchronised usually shows it
   * here first.
   */
  expectPair(): void {
    const two = this.readVarintNumber('a pair');
    if (two !== 2) throw new ArchiveError(`a pair claimed ${two} elements`, this.at);
  }

  /**
   * The count a `std::tuple` writes before its elements.
   *
   * The same shape as a pair's `2`, and worth its own method because the
   * arity is part of the type: a three-element tuple that suddenly claims two
   * is a stream that has gone wrong, not a tuple that shrank.
   */
  expectTuple(arity: number): void {
    const got = this.readVarintNumber('a tuple');
    if (got !== arity) throw new ArchiveError(`a tuple claimed ${got} elements, not ${arity}`, this.at);
  }

  /** A varint length, then that many bytes, as UTF-8. */
  readString(what = 'a string'): string {
    const length = this.readCount(what);
    return new TextDecoder().decode(this.readBlob(length));
  }

  /** Everything must have been consumed; trailing bytes mean a wrong read. */
  expectEnd(): void {
    if (!this.done) {
      throw new ArchiveError(`${this.remaining} bytes left over`, this.at);
    }
  }
}
