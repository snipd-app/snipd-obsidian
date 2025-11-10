export interface SnipdPluginSettings {
  apiKey: string;
  encryptedApiKey: string;
  snipdDir: string;
  frequency: string;
  triggerOnLoad: boolean;
  isSyncing: boolean;
  isTestSyncing: boolean;
  hasCompletedFirstSync: boolean;
  latestSyncedSnipUpdateTs: string | null;
  fileHashMap: { [filePath: string]: string };
  appendOnlyFiles: { [filePath: string]: boolean };
  baseFileHashes: { [filePath: string]: string };
  baseFileManualOverrides: { [filePath: string]: boolean };
  lastBaseFileSyncToken: string | null;
  last_updated_after: string | null;
  current_export_updated_after: string | null;
  current_export_batch_index: number;
  current_export_total_batches: number;
  current_batch_episode_count: number;
  current_batch_snip_count: number;
  lastSyncTimestamp: string | null;
  lastSyncEpisodeCount: number;
  lastSyncSnipCount: number;
  episodeTemplate: string | null;
  snipTemplate: string | null;
  episodeFileNameTemplate: string | null;
  saveDebugZips: boolean;
  onlyEditedSnips: boolean;
}

export const DEFAULT_EPISODE_TEMPLATE = `# {{episode_title}}

{{episode_image}}

## Episode metadata
- Episode title: {{episode_title}}
- Show: {{show_title}}
- Owner / Host: {{show_author}}
- Guests: {{episode_guests}}
- Episode publish date: {{episode_publish_date}}
- Episode AI description: {{episode_ai_description}}
- Mentioned books: {{episode_books}}
- Duration: {{episode_duration}}
- Episode URL: [Open in Snipd]({{episode_url}})
- Show URL: [Open in Snipd]({{show_url}})
- Export date: {{episode_export_date}}

{{snips_section}}[[## Snips]]

Created with [Snipd](https://www.snipd.com) | Highlight & Take Notes from Podcasts`;

export const DEFAULT_SNIP_TEMPLATE = `### {{snip_favorite_star}} [{{snip_title}}]({{snip_url}}) {{snip_tags}}

🎧 {{snip_start_time}} - {{snip_end_time}} ({{snip_duration}})

{{snip_note}}

{{snip_quote}}[[#### 💬 Quote]]

{{snip_transcript}}[[#### 📚 Transcript]]

---

`;

export const DEFAULT_EPISODE_FILE_NAME_TEMPLATE = `{{episode_title}}`;

export const DEFAULT_SETTINGS: SnipdPluginSettings = {
  apiKey: "",
  encryptedApiKey: "",
  snipdDir: "Snipd",
  frequency: "0",
  triggerOnLoad: true,
  isSyncing: false,
  isTestSyncing: false,
  hasCompletedFirstSync: false,
  latestSyncedSnipUpdateTs: null,
  fileHashMap: {},
  appendOnlyFiles: {},
  baseFileHashes: {},
  baseFileManualOverrides: {},
  lastBaseFileSyncToken: null,
  last_updated_after: null,
  current_export_updated_after: null,
  current_export_batch_index: 0,
  current_export_total_batches: 0,
  current_batch_episode_count: 0,
  current_batch_snip_count: 0,
  lastSyncTimestamp: null,
  lastSyncEpisodeCount: 0,
  lastSyncSnipCount: 0,
  saveDebugZips: false,
  onlyEditedSnips: false,
  episodeTemplate: null,
  snipTemplate: null,
  episodeFileNameTemplate: null,
};

export interface MetadataJson {
  latest_snip_update_ts: string;
  episodes_data: { [id: string]: EpisodeEntityData };
  shows_data: { [id: string]: ShowEntityData };
}

export interface ShowEntityData {
  name: string;
}

export interface EpisodeEntityData {
  episode_name: string;
  show_id: string;
  episode_duration: string;
  episode_publish_date: string;
  episode_url: string;
  total_snip_count?: number;
  updated_snip_count?: number;
}

export interface EpisodeSnipMetadata {
  episode_id: string;
  latest_snip_update_ts: string;
  total_snip_count: number;
  updated_snip_count: number;
}

export interface EpisodeBatch {
  index: number;
  episodes: EpisodeSnipMetadata[];
}

export interface FetchExportMetadataResponse {
  episode_batch_count: number;
  episode_batches: EpisodeBatch[];
}
