/**
 * The pasteboard, as one string.
 *
 * Both directions matter to a screen here. `Receive` copies an address out and
 * `Send` pastes one in, and the paste path is where a hostile string arrives:
 * `Send` reads whatever is on the board and hands it to the address parser.
 * A test that wants to know what the parser does with a payment URI, a Monero
 * integrated address or a line of somebody's email puts it here first.
 */

let board = '';

export function reset(): void {
  board = '';
}

/** What a test wants on the pasteboard before a screen reads it. */
export function put(text: string): void {
  board = text;
}

export async function setStringAsync(text: string): Promise<boolean> {
  board = text;
  return true;
}

export async function getStringAsync(): Promise<string> {
  return board;
}
