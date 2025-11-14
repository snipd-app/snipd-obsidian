import { DataAdapter } from 'obsidian';
import { EpisodeEntityData, SnipdPluginSettings, DEFAULT_EPISODE_FILE_NAME_TEMPLATE } from './types';
import { sanitizeFileName } from './sanitize_file_name';

export const isDev = (): boolean => {
  // In Obsidian plugin context, check for development mode differently
  // Since process.env is not available, we'll use a different approach
  return false;
};

export const debugLog = (...args: unknown[]): void => {
  if (isDev()) {
    // eslint-disable-next-line no-undef
    console.debug(...args);
  }
};

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

  let result = template.replace(/\{\{([a-zA-Z0-9_]+)\}\}\[\[.*?\]\]/g, (_, varName: string) => {
    return variables[varName] || '';
  });

  result = result.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, varName: string) => {
    const value = variables[varName] || '';
    if (!variables[varName]) {
      debugLog(`Snipd plugin: Unknown variable {{${varName}}} in episode filename template`);
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
