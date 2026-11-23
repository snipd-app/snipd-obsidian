// Linking to Snipd: the plugin makes up a uuid, opens app.snipd.com/obsidian/auth
// with it and waits for the user to confirm there. The page shows a short code
// derived from the uuid and this plugin shows the same one, so the user can
// check that they are confirming the connection this Obsidian asked for.
//
// app.snipd.com computes the code the same way (snipd-backend,
// code/web/web-app/src/obsidian/pairingCode.ts): keep the two in step.

// No 0/O, 1/I: easy to compare by eye. 32 characters, so a byte maps evenly.
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 6;

export async function pairingCode(uuid: string): Promise<string> {
  const digest = new Uint8Array(
    await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(uuid.toLowerCase())),
  );
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[digest[i] % PAIRING_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// The uuid is what the wait request is keyed on, so it has to be unguessable:
// random bytes from the platform's secure generator, not Math.random.
export function randomUUIDv4(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
