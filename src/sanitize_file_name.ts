export const OBSIDIAN_ILLEGAL_SYMBOLS = ['[', ']', '#', '^', '|', ':', '\\', '/'];

export const PLATFORM_ILLEGAL_SYMBOLS: Record<string, string[]> = {
  win32: ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\0'],
  darwin: ['/', ':', '\0'],
  linux: ['/', '\0'],
};

export const DEFAULT_ILLEGAL_SYMBOLS = Array.from(
  new Set([
    ...OBSIDIAN_ILLEGAL_SYMBOLS,
    // strip everything so it's the safest possible
    ...PLATFORM_ILLEGAL_SYMBOLS.win32,
    ...PLATFORM_ILLEGAL_SYMBOLS.darwin,
    ...PLATFORM_ILLEGAL_SYMBOLS.linux,
  ]),
);

function escapeForRegexCharacterClass(char: string): string {
  if (char === ']' || char === '\\' || char === '-' || char === '^') {
    return `\\${char}`;
  }
  return char;
}

/// Sanitizes file names by replacing illegal characters with underscores and truncating length.
/// Uses a simple, deterministic approach to ensure consistent results across platforms and
/// avoid edge cases that could cause file system errors.
export function sanitizeFileName(
  name: string,
  illegalSymbols: string[] = DEFAULT_ILLEGAL_SYMBOLS,
  maxLength = 150,
): string {
  const escapedSymbols = illegalSymbols.map(escapeForRegexCharacterClass).join('');
  return name.replace(new RegExp(`[${escapedSymbols}]`, 'g'), '_').slice(0, maxLength);
}

