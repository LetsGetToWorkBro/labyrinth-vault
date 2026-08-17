/**
 * The file picker, scriptable, with the cancel case first.
 *
 * `MoneroFile` opens this to take a key image file back from a vault. The two
 * answers a screen has to handle are a person picking a file and a person
 * dismissing the sheet, and the second is the one that is easy to write as a
 * crash: `result.assets[0]` on a cancelled pick is an index into a list that
 * is not there.
 *
 * So the default is a cancel, and a test that wants a file says so.
 */

interface Picked {
  uri: string;
  name: string;
  mimeType?: string;
}

let next: Picked | null = null;

export function reset(): void {
  next = null;
}

/** The file the next pick returns. Without this the sheet is dismissed. */
export function offer(file: Picked): void {
  next = file;
}

export async function getDocumentAsync(options?: {
  type?: string | string[];
  copyToCacheDirectory?: boolean;
}): Promise<
  | { canceled: true; assets: null }
  | { canceled: false; assets: Picked[] }
> {
  void options;
  return next === null ? { canceled: true, assets: null } : { canceled: false, assets: [next] };
}
