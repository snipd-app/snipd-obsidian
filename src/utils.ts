import { DataAdapter } from 'obsidian';
import { EpisodeEntityData, SnipdPluginSettings, DEFAULT_EPISODE_FILE_NAME_TEMPLATE } from './types';
import { sanitizeFileName } from './sanitize_file_name';

export const isDev = (): boolean => {
  return false;
};

export const debugLog = (...args: unknown[]): void => {
  if (isDev()) {
    console.debug('[Snipd]', ...args);
  }
};

export function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function toSnakeCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

export function toCamelCase(str: string): string {
  const words = str.split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
  if (words.length === 0) return '';
  return words[0].toLowerCase() + words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

export function toPascalCase(str: string): string {
  const words = str.split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

export function toLowerCase(str: string): string {
  return str.toLowerCase();
}

export function toUpperCase(str: string): string {
  return str.toUpperCase();
}

function applyFilter(value: string, filterName: string): string {
  switch (filterName) {
    case 'kebab':
      return toKebabCase(value);
    case 'snake':
      return toSnakeCase(value);
    case 'camel':
      return toCamelCase(value);
    case 'pascal':
      return toPascalCase(value);
    case 'lowercase':
      return toLowerCase(value);
    case 'uppercase':
      return toUpperCase(value);
    default:
      return value;
  }
}

export function generateEpisodeFileName(
  episodeData: EpisodeEntityData | undefined, 
  episodeId: string,
  settings: SnipdPluginSettings
): string {
  if (!episodeData) {
    debugLog(`Snipd plugin: No episode data found for ${episodeId}, using ID as fallback`);
    return sanitizeFileName(episodeId);
  }

  let template = settings.episodeFileNameTemplate ?? DEFAULT_EPISODE_FILE_NAME_TEMPLATE;
  
  const variables: Record<string, string> = {
    'episode_title': episodeData.episode_name || '',
    'episode_duration': episodeData.episode_duration || '',
    'episode_publish_date': episodeData.episode_publish_date || '',
    'episode_url': episodeData.episode_url || '',
  };

  let result = template.replace(/\{\{([a-zA-Z0-9_]+)(?:\s*\|\s*([a-zA-Z0-9_]+))?\}\}\[\[.*?\]\]/g, (_, varName: string, filterName: string | undefined) => {
    let value = variables[varName] || '';
    if (value && filterName) {
      value = applyFilter(value, filterName);
    }
    return value;
  });

  result = result.replace(/\{\{([a-zA-Z0-9_]+)(?:\s*\|\s*([a-zA-Z0-9_]+))?\}\}/g, (_, varName: string, filterName: string | undefined) => {
    let value = variables[varName] || '';
    if (!(varName in variables)) {
      debugLog(`Snipd plugin: Unknown variable {{${varName}}} in episode filename template`);
    }
    if (value && filterName) {
      value = applyFilter(value, filterName);
    }
    return value;
  });

  if (!result.trim()) {
    result = episodeData.episode_name || episodeId;
  }

  return sanitizeFileName(result);
}

export async function createDirForFile(filePath: string, fs: DataAdapter): Promise<void> {
  const dirPath = filePath.replace(/\/+$/, '').replace(/^(.+)\/[^/]*?$/, '$1');
  const exists = await fs.exists(dirPath);
  if (!exists) {
    await fs.mkdir(dirPath);
  }
}
