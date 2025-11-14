export const OBSIDIAN_ILLEGAL_SYMBOLS = ['[', ']', '#', '^', '|', ':', '\\', '/'];

const WINDOWS_CONTROL_CHARACTERS = Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1));

export const PLATFORM_ILLEGAL_SYMBOLS: Record<string, string[]> = {
  win32: ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\0', ...WINDOWS_CONTROL_CHARACTERS],
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

function removeTrailingPeriodsAndSpaces(name: string): string {
  return name.replace(/[.\s]+$/, '');
}

/// Sanitizes file names by replacing illegal characters with underscores and truncating length.
/// Uses a simple, deterministic approach to ensure consistent results across platforms and
/// avoid edge cases that could cause file system errors.
/// Includes Windows-specific fixes for trailing periods/spaces.
export function sanitizeFileName(
  name: string,
  illegalSymbols: string[] = DEFAULT_ILLEGAL_SYMBOLS,
  maxLength = 150,
): string {
  if (!name) {
    return 'untitled';
  }
  
  const escapedSymbols = illegalSymbols.map(escapeForRegexCharacterClass).join('');
  
  let sanitized = name.replace(new RegExp(`[${escapedSymbols}]`, 'g'), '_').trim();
  
  sanitized = removeTrailingPeriodsAndSpaces(sanitized);
  
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
    sanitized = removeTrailingPeriodsAndSpaces(sanitized);
  }
  
  if (!sanitized) {
    return 'untitled';
  }
  
  return sanitized;
}

