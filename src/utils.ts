import { DataAdapter } from 'obsidian';
import { EpisodeEntityData, SnipdPluginSettings, DEFAULT_EPISODE_FILE_NAME_TEMPLATE } from './types';
import { sanitizeFileName } from './sanitize_file_name';

export const isDev = () => {
  return process.env.NODE_ENV === 'development';
};

export const debugLog = (...args: unknown[]) => {
  if (isDev()) {
    console.log(...args);
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

  let result = template.replace(/\{\{([a-zA-Z0-9_]+)\}\}\[\[.*?\]\]/g, (_, varName) => {
    return variables[varName] || '';
  });

  result = result.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, varName) => {
    const value = variables[varName] || '';
    if (!variables[varName]) {
      console.warn(`Snipd plugin: Unknown variable {{${varName}}} in episode filename template`);
    }
    return value;
  });

  if (!result.trim()) {
    result = episodeData.episode_name || episodeId;
  }

  return sanitizeFileName(result);
}

export async function createDirForFile(filePath: string, fs: DataAdapter): Promise<void> {
  const dirPath = filePath.replace(/\/*$/, '').replace(/^(.+)\/[^\/]*?$/, '$1');
  const exists = await fs.exists(dirPath);
  if (!exists) {
    await fs.mkdir(dirPath);
  }
}
