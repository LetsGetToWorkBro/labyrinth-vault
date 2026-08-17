/**
 * A filesystem, in memory, with the synchronous API the app actually uses.
 *
 * Three call sites: the settings a wallet keeps between launches, the key
 * image file it writes for somebody to carry to Cake or Feather, and the file
 * picker on the way back in. All three went through the legacy module until
 * recently and now go through `File` and `Directory`, which is a migration
 * whose failure mode is a method that does not exist on the new object.
 *
 * The methods here are the ones those call sites use and no others, so a
 * fourth call site reaching for `copy` or `move` fails loudly rather than
 * getting `undefined` and writing nothing.
 *
 * Paths are strings under two roots. There is no real directory tree: a path
 * is a key, and a directory exists if it was created or if something under it
 * was written. That is enough for `fileStore`, whose whole question is whether
 * the documents directory is there before it writes into it.
 */

const files = new Map<string, Uint8Array>();
const directories = new Set<string>();

const DOCUMENT = 'file:///harness/document';
const CACHE = 'file:///harness/cache';

export function reset(): void {
  files.clear();
  directories.clear();
  directories.add(DOCUMENT);
  directories.add(CACHE);
}

reset();

/** What is on this filesystem, for a test that wants to seed one or read one. */
export function written(): Map<string, Uint8Array> {
  return new Map(files);
}

function join(parts: (string | { uri: string })[]): string {
  const segments = parts.map((part) => (typeof part === 'string' ? part : part.uri));
  return segments.reduce((left, right) =>
    right.startsWith('file://') ? right : `${left.replace(/\/$/, '')}/${right.replace(/^\//, '')}`,
  );
}

export class Directory {
  readonly uri: string;

  constructor(...parts: (string | Directory)[]) {
    this.uri = join(parts);
  }

  get exists(): boolean {
    return directories.has(this.uri);
  }

  create(options?: { intermediates?: boolean }): void {
    void options;
    directories.add(this.uri);
  }
}

export class File {
  readonly uri: string;

  constructor(...parts: (string | Directory | File)[]) {
    this.uri = join(parts);
  }

  get exists(): boolean {
    return files.has(this.uri);
  }

  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf('/') + 1);
  }

  create(options?: { overwrite?: boolean }): void {
    /*
     * Strict about `overwrite`, and strict on purpose rather than on evidence.
     *
     * Expo's types say `CreateOptions.overwrite` means "whether to overwrite
     * the file if it exists"; what the native side does when it is absent and
     * the file is already there is not written down anywhere that can be read
     * from here, and asserting it in a comment would be the kind of confident
     * sentence this project keeps finding to be wrong.
     *
     * So this refuses, because of the two ways to be wrong that is the safe
     * one. If the real `create` silently overwrites, a test fails here against
     * code that works on a phone, and somebody investigates. If it throws and
     * this shrugged, the deliberate delete-first line in `vaultFileStore.ts`
     * could be removed with every test still green, and the failure would show
     * up as a key image export that stops working on a device.
     */
    if (files.has(this.uri) && options?.overwrite !== true) {
      throw new Error(`${this.uri} exists and create was not told to overwrite`);
    }
    files.set(this.uri, new Uint8Array(0));
  }

  write(content: string | Uint8Array): void {
    files.set(this.uri, typeof content === 'string' ? new TextEncoder().encode(content) : content);
  }

  textSync(): string {
    const bytes = files.get(this.uri);
    if (bytes === undefined) throw new Error(`${this.uri} does not exist`);
    return new TextDecoder().decode(bytes);
  }

  bytesSync(): Uint8Array {
    const bytes = files.get(this.uri);
    if (bytes === undefined) throw new Error(`${this.uri} does not exist`);
    return bytes;
  }

  delete(): void {
    files.delete(this.uri);
  }
}

export const Paths = {
  document: new Directory(DOCUMENT),
  cache: new Directory(CACHE),
};
