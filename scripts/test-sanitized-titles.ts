import { readFileSync } from 'fs';
import * as path from 'path';
import {
  sanitizeFileName,
  OBSIDIAN_ILLEGAL_SYMBOLS,
  PLATFORM_ILLEGAL_SYMBOLS,
} from '../src/sanitize_file_name';

/* The json should have the following structure:

{
  "samples": [
    {
      "symbol" : "[",
      "title" : "[EP3] Interesting episode title (#SP4SJ)"
    },
    ...
  ]
}
*/
const dataPath = path.resolve('scripts/data/funky_episode_titles.json');

const payload = JSON.parse(readFileSync(dataPath, 'utf8')) as {
  samples: Array<{ symbol: string; title: string }>;
};

const platforms: Array<'linux' | 'darwin' | 'win32'> = ['linux', 'darwin', 'win32'];

const getIllegalSymbolsForPlatform = (platform: string): string[] => {
  return Array.from(
    new Set([
      ...OBSIDIAN_ILLEGAL_SYMBOLS,
      ...(PLATFORM_ILLEGAL_SYMBOLS[platform] ?? ['/', '\0']),
    ]),
  );
};

const groupedBySymbol = payload.samples.reduce(
  (acc, sample) => {
    if (!acc[sample.symbol]) {
      acc[sample.symbol] = [];
    }
    acc[sample.symbol].push(sample.title);
    return acc;
  },
  {} as Record<string, string[]>,
);

const sortedSymbols = Object.keys(groupedBySymbol).sort();

for (const symbol of sortedSymbols) {
  console.log(`\n=== Symbol: "${symbol}" ===\n`);
  
  const titles = Array.from(new Set(groupedBySymbol[symbol]));
  
  titles.forEach((title, index) => {
    console.log(`${index + 1}. "${title}"`);
    
    for (const platform of platforms) {
      const illegalSymbols = getIllegalSymbolsForPlatform(platform);
      const sanitizedPerPlatform = sanitizeFileName(title, illegalSymbols);
      console.log(`   -> ${platform}: "${sanitizedPerPlatform}"`);
    }
    const sanitizedAll = sanitizeFileName(title);
    console.log(`   -> all: "${sanitizedAll}"`);
    if (index < titles.length - 1) {
      console.log('');
    }
  });
}