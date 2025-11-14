import {
  addIcon,
  DataAdapter,
  normalizePath,
  Notice,
  Plugin,
  TFile,
  requestUrl
} from 'obsidian';
// @ts-ignore
import * as zip from "@zip.js/zip.js";
// @ts-ignore
import { Md5 } from "ts-md5";
import { 
  SnipdPluginSettings, 
  DEFAULT_SETTINGS,
  DEFAULT_EPISODE_TEMPLATE,
  DEFAULT_SNIP_TEMPLATE,
  MetadataJson,
  EpisodeSnipMetadata,
  FetchExportMetadataResponse,
  BaseFileMetadata
} from './types';
import { generateEpisodeFileName, createDirForFile, isDev, debugLog } from './utils';
import { sanitizeFileName } from './sanitize_file_name';
import { SnipdSettingModal } from './settings_modal';
import { SecureStorage } from './secure_storage';

export const AUTH_URL = "https://app.snipd.com/obsidian/auth";
export const API_BASE_URL = isDev() ? "http://0.0.0.0:8080/v1/public/api" : "https://api.snipd.com/v1/public/api";

export default class SnipdPlugin extends Plugin {
  settings: SnipdPluginSettings;
  fs: DataAdapter;
  scheduleInterval: null | number = null;
  statusBar: StatusBar;
  settingsTab: SnipdSettingModal | null = null;
  syncAbortController: AbortController | null = null;

  async handleSyncError(msg: string) {
    await this.clearSettingsAfterRun();
    this.notice(msg, true, 4, true);
    this.clearStatusBarPersistentMessage();
  }

  async clearSettingsAfterRun() {
    this.settings.isSyncing = false;
    this.syncAbortController = null;
    await this.saveSettings();
    if (this.settingsTab) {
      this.settingsTab.display();
    }
  }

  async stopSync() {
    if (!this.settings.isSyncing) {
      return;
    }
    
    if (this.syncAbortController) {
      this.syncAbortController.abort();
    }
    
    await this.clearSettingsAfterRun();
    this.notice("Sync stopped by user", true, 4, true);
    this.clearStatusBarPersistentMessage();
  }

  notice(msg: string, show = false, timeout = 0, forcing: boolean = false) {
    if (show) {
      new Notice(msg);
    }
    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar.displayMessage(msg.toLowerCase(), timeout, forcing);
    } else {
      if (!show) {
        new Notice(msg);
      }
    }
  }

  private setStatusBarPersistentMessage(message: string): void {
    // @ts-ignore
    if (this.app.isMobile) {
      new Notice(message);
    } else if (this.statusBar) {
      this.statusBar.setPersistentMessage(message);
    }
  }

  private clearStatusBarPersistentMessage(): void {
    // @ts-ignore
    if (!this.app.isMobile && this.statusBar) {
      this.statusBar.clearPersistentMessage();
    }
  }

  private clearStatusBarPersistentMessageAfterDelay(delayMs: number): void {
    this.registerInterval(
      globalThis.window.setTimeout(() => {
        this.clearStatusBarPersistentMessage();
      }, delayMs)
    );
  }

  async checkSnipdDirectoryExists(): Promise<boolean> {
    return await this.app.vault.adapter.exists(this.settings.snipdDir);
  }

  async clearSyncMetadata() {
    debugLog('Snipd plugin: clearing sync metadata...');
    this.settings.fileHashMap = {};
    this.settings.appendOnlyFiles = {};
    this.settings.baseFileHashes = {};
    this.settings.baseFileManualOverrides = {};
    this.settings.lastBaseFileSyncToken = null;
    this.settings.baseFileDefaultOpenPath = null;
    this.settings.last_updated_after = null;
    this.settings.current_export_updated_after = null;
    this.settings.current_export_batch_index = 0;
    this.settings.current_export_total_batches = 0;
    this.settings.current_batch_episode_count = 0;
    this.settings.current_batch_snip_count = 0;
    this.settings.latestSyncedSnipUpdateTs = null;
    await this.deleteMetadataFile();
    await this.saveSettings();
  }

  async syncSnipd() {
    if (!(await this.validateSyncPreconditions())) {
      return;
    }

    await this.checkAndHandleMissingDirectory();

    const debugFolderPath = this.settings.saveDebugZips ? `snipd_plugin_debug/sync_${Date.now()}` : null;
    await this.initializeSync();

    const metadata = await this.fetchOrLoadMetadata(debugFolderPath);
    if (!metadata) {
      return;
    }

    const stats = await this.processAllBatches(metadata, debugFolderPath);
    if (!stats) {
      return;
    }

    await this.finalizeSync(stats.episodeCount, stats.snipCount);
  }

  private async validateSyncPreconditions(): Promise<boolean> {
    if (this.settings.isSyncing) {
      this.notice("Snipd sync already in progress", true);
      return false;
    }

    if (!this.settings.apiKey) {
      this.notice("Please connect with your Snipd account in settings", true);
      return false;
    }

    return true;
  }

  private async checkAndHandleMissingDirectory(): Promise<void> {
    const snipdDirExists = await this.checkSnipdDirectoryExists();
    if (!snipdDirExists && (this.settings.fileHashMap && Object.keys(this.settings.fileHashMap).length > 0)) {
      debugLog('Snipd plugin: Snipd directory not found, clearing metadata and starting fresh sync');
      this.notice("Snipd base folder not found, starting fresh sync...", true);
      await this.clearSyncMetadata();
    }
  }

  private async initializeSync(): Promise<void> {
    debugLog('Snipd plugin: starting sync...');
    this.settings.isSyncing = true;
    this.syncAbortController = new AbortController();
    await this.saveSettings();
    
    if (this.settingsTab) {
      this.settingsTab.display();
    }

    this.notice("Snipd sync started...", true, 0, true);
    this.setStatusBarPersistentMessage("Snipd sync in progress...");
  }

  private buildMetadataUrl(): string {
    let url = `${API_BASE_URL}/obsidian/fetch-export-metadata`;
    const queryParams = [];
    if (this.settings.last_updated_after) {
      queryParams.push(`updated_after=${encodeURIComponent(this.settings.last_updated_after)}`);
    }
    if (this.settings.onlyEditedSnips) {
      queryParams.push('only_edited_snips=true');
    }
    if (queryParams.length > 0) {
      url += `?${queryParams.join('&')}`;
    }
    return url;
  }

  private async fetchMetadataFromApi(debugFolderPath: string | null): Promise<FetchExportMetadataResponse | null> {
    const url = this.buildMetadataUrl();

    let response;
    try {
      debugLog(`Snipd plugin: fetching metadata from ${url}`);
      this.setStatusBarPersistentMessage("Fetching metadata...");
      response = await requestUrl({
        url: url,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.settings.apiKey}`,
        },
      });
      debugLog(`Snipd plugin: metadata response status: ${response.status}`);
    } catch (e) {
      debugLog("Snipd plugin: request failed in syncSnipd: ", e);
      const errorMsg = "Sync failed: unable to connect to server." + (isDev() ? ` Detail: ${e}` : "");
      await this.handleSyncError(errorMsg);
      return null;
    }

    if (response && response.status >= 200 && response.status < 300) {
      const metadata = response.json as FetchExportMetadataResponse;
      await this.saveMetadataToFile(metadata);
      
      if (debugFolderPath) {
        await createDirForFile(`${debugFolderPath}/metadata.json`, this.app.vault.adapter);
        await this.app.vault.adapter.write(
          `${debugFolderPath}/metadata.json`,
          JSON.stringify(metadata, null, 2)
        );
        debugLog(`Snipd plugin: saved debug metadata to ${debugFolderPath}/metadata.json`);
      }
      
      this.settings.current_export_updated_after = this.settings.latestSyncedSnipUpdateTs || null;
      this.settings.current_export_batch_index = 0;
      this.settings.current_export_total_batches = metadata.episode_batch_count;
      await this.saveSettings();
      
      if (this.settingsTab) {
        this.settingsTab.display();
      }

      debugLog(`Snipd plugin: fetched metadata with ${metadata.episode_batch_count} batches`);
      
      if (metadata.episode_batch_count > 0) {
        this.setStatusBarPersistentMessage(`Syncing ${metadata.episode_batch_count} batch${metadata.episode_batch_count > 1 ? 'es' : ''}...`);
        await this.fetchAndSaveBaseFile(this.settings.snipdDir);
      }
      
      return metadata;
    } else {
      debugLog("Snipd plugin: bad response in syncSnipd: ", response);
      const statusCode = response ? response.status : 0;
      const errorMsg = `Sync failed${statusCode ? ` (${statusCode})` : ""}` + (isDev() && response ? ` Detail: ${response.status}` : "");
      await this.handleSyncError(errorMsg);
      return null;
    }
  }

  private async fetchOrLoadMetadata(debugFolderPath: string | null): Promise<FetchExportMetadataResponse | null> {
    if (!this.settings.current_export_updated_after) {
      return await this.fetchMetadataFromApi(debugFolderPath);
    } else {
      const loadedMetadata = await this.loadMetadataFromFile();
      if (!loadedMetadata) {
        debugLog("Snipd plugin: metadata file not found, resetting sync state");
        this.settings.current_export_updated_after = null;
        this.settings.current_export_batch_index = 0;
        this.settings.current_export_total_batches = 0;
        this.settings.current_batch_episode_count = 0;
        this.settings.current_batch_snip_count = 0;
        await this.saveSettings();
        await this.syncSnipd();
        return null;
      }
      this.settings.current_export_total_batches = loadedMetadata.episode_batch_count;
      await this.saveSettings();
      debugLog(`Snipd plugin: resuming sync from batch ${this.settings.current_export_batch_index}`);
      return loadedMetadata;
    }
  }

  private buildBatchRequestBody(episodeIds: string[]): {
    episode_ids: string[];
    episode_template?: string;
    snip_template?: string;
    updated_after?: string;
    only_edited_snips?: boolean;
  } {
    const requestBody: {
      episode_ids: string[];
      episode_template?: string;
      snip_template?: string;
      updated_after?: string;
      only_edited_snips?: boolean;
    } = {
      episode_ids: episodeIds,
      episode_template: this.settings.episodeTemplate ?? DEFAULT_EPISODE_TEMPLATE,
      snip_template: this.settings.snipTemplate ?? DEFAULT_SNIP_TEMPLATE,
    };
    
    if (this.settings.last_updated_after) {
      requestBody.updated_after = this.settings.last_updated_after;
    }
    
    if (this.settings.onlyEditedSnips) {
      requestBody.only_edited_snips = true;
    }
    
    return requestBody;
  }

  private async processSingleBatch(
    batchIndex: number,
    batch: { episodes: EpisodeSnipMetadata[] },
    totalBatches: number,
    debugFolderPath: string | null
  ): Promise<{ episodeCount: number; snipCount: number } | null> {
    const snipdDirExists = await this.checkSnipdDirectoryExists();
    if (!snipdDirExists && (this.settings.fileHashMap && Object.keys(this.settings.fileHashMap).length > 0)) {
      debugLog('Snipd plugin: Snipd directory not found during batch processing, restarting sync from scratch');
      this.notice("Snipd folder not found, restarting sync from scratch...", true);
      await this.clearSyncMetadata();
      await this.clearSettingsAfterRun();
      await this.syncSnipd();
      return null;
    }

    const episodeIds = batch.episodes.map(ep => ep.episode_id);
    const batchSnipCount = batch.episodes.reduce((sum, ep) => sum + ep.updated_snip_count, 0);
    
    this.settings.current_batch_episode_count = episodeIds.length;
    this.settings.current_batch_snip_count = batchSnipCount;
    await this.saveSettings();
    
    debugLog(`Snipd plugin: processing batch ${batchIndex + 1}/${totalBatches} with ${episodeIds.length} episodes`);
    this.setStatusBarPersistentMessage(`Syncing batch ${batchIndex + 1}/${totalBatches} (${episodeIds.length} episodes, ${batchSnipCount} snips)...`);

    let response;
    try {
      const requestBody = this.buildBatchRequestBody(episodeIds);
      response = await requestUrl({
        url: `${API_BASE_URL}/obsidian/export-episode-snips`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (e) {
      debugLog("Snipd plugin: request failed for batch: ", e);
      const errorMsg = "Sync failed: unable to connect to server." + (isDev() ? ` Detail: ${e}` : "");
      await this.handleSyncError(errorMsg);
      return null;
    }

    if (response && response.status >= 200 && response.status < 300) {
      const arrayBuffer = response.arrayBuffer;
      const blob = new Blob([arrayBuffer]);
      
      if (debugFolderPath) {
        const batchFileName = `batch_${batchIndex}_${Date.now()}.zip`;
        const batchFilePath = `${debugFolderPath}/${batchFileName}`;
        await createDirForFile(batchFilePath, this.app.vault.adapter);
        const arrayBuffer = await blob.arrayBuffer();
        await this.app.vault.adapter.writeBinary(batchFilePath, arrayBuffer);
        debugLog(`Snipd plugin: saved debug batch to ${batchFilePath}`);
      }
      
      const stats = await this.processZipExport(blob);
      
      this.settings.current_export_batch_index = batchIndex + 1;
      await this.saveSettings();
      
      if (this.settingsTab) {
        this.settingsTab.display();
      }

      return stats;
    } else {
      debugLog("Snipd plugin: bad response for batch: ", response);
      const statusCode = response ? response.status : 0;
      const errorMsg = `Sync failed at batch ${batchIndex + 1}${statusCode ? ` (${statusCode})` : ""}` + (isDev() && response ? ` Detail: ${response.status}` : "");
      await this.handleSyncError(errorMsg);
      return null;
    }
  }

  private async processAllBatches(
    metadata: FetchExportMetadataResponse,
    debugFolderPath: string | null
  ): Promise<{ episodeCount: number; snipCount: number } | null> {
    let totalEpisodes = 0;
    let totalSnips = 0;

    try {
      if (metadata.episode_batch_count === 0) {
        debugLog('Snipd plugin: no new data to sync');
        this.notice("No new data to sync", true, 2, true);
      }

      for (let i = this.settings.current_export_batch_index; i < metadata.episode_batch_count; i++) {
        const batch = metadata.episode_batches[i];
        const stats = await this.processSingleBatch(i, batch, metadata.episode_batch_count, debugFolderPath);
        
        if (!stats) {
          return null;
        }

        totalEpisodes += stats.episodeCount;
        totalSnips += stats.snipCount;
      }

      return { episodeCount: totalEpisodes, snipCount: totalSnips };
    } catch (e) {
      debugLog("Snipd plugin: error processing batches: ", e);
      const errorMsg = "Sync failed: error processing data." + (isDev() ? ` Detail: ${e}` : "");
      await this.handleSyncError(errorMsg);
      return null;
    }
  }

  private async finalizeSync(totalEpisodes: number, totalSnips: number): Promise<void> {
    this.settings.last_updated_after = this.settings.latestSyncedSnipUpdateTs || null;
    this.settings.current_export_updated_after = null;
    this.settings.current_export_batch_index = 0;
    this.settings.current_export_total_batches = 0;
    this.settings.current_batch_episode_count = 0;
    this.settings.current_batch_snip_count = 0;
    this.settings.lastSyncTimestamp = new Date().toISOString();
    this.settings.lastSyncEpisodeCount = totalEpisodes;
    this.settings.lastSyncSnipCount = totalSnips;
    this.settings.hasCompletedFirstSync = true;
    await this.deleteMetadataFile();
    await this.saveSettings();

    await this.clearSettingsAfterRun();
    
    if (totalEpisodes === 0 && totalSnips === 0) {
      this.setStatusBarPersistentMessage("Snipd sync completed (no new data)");
    } else {
      this.setStatusBarPersistentMessage(`Snipd sync completed (${totalEpisodes} episodes, ${totalSnips} snips)`);
    }
    
    this.clearStatusBarPersistentMessageAfterDelay(3000);
  }

  async testSyncRandomEpisodes() {
    if (this.settings.isTestSyncing) {
      this.notice("Test sync already in progress", true);
      return;
    }

    if (!this.settings.apiKey) {
      this.notice("Please configure your Snipd API key in settings", true);
      return;
    }

    debugLog('Snipd plugin: starting test sync...');
    this.settings.isTestSyncing = true;
    await this.saveSettings();
    
    if (this.settingsTab) {
      this.settingsTab.display();
    }

    this.notice("Test sync started...", true, 0, true);
    this.setStatusBarPersistentMessage("Test sync in progress...");

    const debugFolderPath = this.settings.saveDebugZips ? `snipd_plugin_debug/sync_${Date.now()}` : null;

    const testDir = `${this.settings.snipdDir}-TEST`;
    
    if (await this.app.vault.adapter.exists(testDir)) {
      debugLog('Snipd plugin: removing existing test folder');
      this.notice("Removing existing test folder...", true, 0, true);
      await this.app.vault.adapter.rmdir(testDir, true);
    }

    let response;
    try {
      debugLog('Snipd plugin: fetching test metadata');
      this.setStatusBarPersistentMessage("Fetching test metadata...");
      let url = `${API_BASE_URL}/obsidian/fetch-export-metadata`;
      if (this.settings.onlyEditedSnips) {
        url += '?only_edited_snips=true';
      }
      response = await requestUrl({
        url: url,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.settings.apiKey}`,
        },
      });
      debugLog(`Snipd plugin: test metadata response status: ${response.status}`);
    } catch (e) {
      debugLog("Snipd plugin: request failed in testSyncRandomEpisodes: ", e);
      const errorMsg = "Test sync failed: unable to connect to server." + (isDev() ? ` Detail: ${e}` : "");
      this.settings.isTestSyncing = false;
      await this.saveSettings();
      if (this.settingsTab) {
        this.settingsTab.display();
      }
      this.notice(errorMsg, true, 4, true);
      this.clearStatusBarPersistentMessage();
      return;
    }

    if (response && response.status >= 200 && response.status < 300) {
      const metadata = response.json as FetchExportMetadataResponse;
      
      if (debugFolderPath) {
        await createDirForFile(`${debugFolderPath}/test_metadata.json`, this.app.vault.adapter);
        await this.app.vault.adapter.write(
          `${debugFolderPath}/test_metadata.json`,
          JSON.stringify(metadata, null, 2)
        );
        debugLog(`Snipd plugin: saved debug test metadata to ${debugFolderPath}/test_metadata.json`);
      }
      
      const allEpisodes: EpisodeSnipMetadata[] = [];
      for (const batch of metadata.episode_batches) {
        allEpisodes.push(...batch.episodes);
      }

      const episodesWithSnips = allEpisodes.filter(ep => ep.total_snip_count > 0);

      if (episodesWithSnips.length === 0) {
        debugLog('Snipd plugin: no episodes with snips found for test sync');
        this.notice("No episodes with snips found to test", true, 4, true);
        this.settings.isTestSyncing = false;
        await this.saveSettings();
        if (this.settingsTab) {
          this.settingsTab.display();
        }
        this.clearStatusBarPersistentMessage();
        return;
      }

      const randomCount = Math.min(5, episodesWithSnips.length);
      const shuffled = [...episodesWithSnips].sort(() => 0.5 - Math.random());
      const selectedEpisodes = shuffled.slice(0, randomCount);
      const episodeIds = selectedEpisodes.map(ep => ep.episode_id);
      const totalSnips = selectedEpisodes.reduce((sum, ep) => sum + ep.updated_snip_count, 0);

      debugLog(`Snipd plugin: selected ${randomCount} random episodes for test sync`);
      debugLog('Snipd plugin: selected episode IDs:', episodeIds);
      debugLog('Snipd plugin: selected episodes with snip counts:', selectedEpisodes.map(ep => ({
        id: ep.episode_id,
        total_snip_count: ep.total_snip_count,
        updated_snip_count: ep.updated_snip_count
      })));
      this.setStatusBarPersistentMessage(`Test syncing ${randomCount} episodes (${totalSnips} snips)...`);

      let exportResponse;
      try {
        const exportRequestBody: {
          episode_ids: string[];
          episode_template: string;
          snip_template: string;
          only_edited_snips?: boolean;
        } = {
          episode_ids: episodeIds,
          episode_template: this.settings.episodeTemplate ?? DEFAULT_EPISODE_TEMPLATE,
          snip_template: this.settings.snipTemplate ?? DEFAULT_SNIP_TEMPLATE,
        };
        
        if (this.settings.onlyEditedSnips) {
          exportRequestBody.only_edited_snips = true;
        }
        
        exportResponse = await requestUrl({
          url: `${API_BASE_URL}/obsidian/export-episode-snips`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.settings.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(exportRequestBody),
        });
      } catch (e) {
        debugLog("Snipd plugin: export request failed: ", e);
        const errorMsg = "Test sync failed: unable to connect to server." + (isDev() ? ` Detail: ${e}` : "");
        this.settings.isTestSyncing = false;
        await this.saveSettings();
        if (this.settingsTab) {
          this.settingsTab.display();
        }
        this.notice(errorMsg, true, 4, true);
        this.clearStatusBarPersistentMessage();
        return;
      }

      if (exportResponse && exportResponse.status >= 200 && exportResponse.status < 300) {
        const arrayBuffer = exportResponse.arrayBuffer;
        const blob = new Blob([arrayBuffer]);
        
        if (debugFolderPath) {
          const testExportFileName = `test_export_${Date.now()}.zip`;
          const testExportFilePath = `${debugFolderPath}/${testExportFileName}`;
          await createDirForFile(testExportFilePath, this.app.vault.adapter);
          const arrayBuffer = await blob.arrayBuffer();
          await this.app.vault.adapter.writeBinary(testExportFilePath, arrayBuffer);
          debugLog(`Snipd plugin: saved debug test export to ${testExportFilePath}`);
        }
        
        const originalSnipdDir = this.settings.snipdDir;
        this.settings.snipdDir = testDir;
        
        await this.fetchAndSaveBaseFileForTest(testDir);
        
        const stats = await this.processZipExport(blob);
        
        
        debugLog(`Snipd plugin: test sync requested ${episodeIds.length} episodes, received ${stats.episodeCount} episodes`);
        if (stats.episodeCount < episodeIds.length) {
          debugLog(`Snipd plugin: ${episodeIds.length - stats.episodeCount} episode(s) were skipped by the backend. This usually means the episode or show data is missing, or the episode has no snips for this user.`);
        }
        
        this.settings.snipdDir = originalSnipdDir;
        this.settings.isTestSyncing = false;
        await this.saveSettings();
        
        if (this.settingsTab) {
          this.settingsTab.display();
        }
        
        this.setStatusBarPersistentMessage(`Test sync completed (${stats.episodeCount} episodes, ${stats.snipCount} snips)`);
        this.clearStatusBarPersistentMessageAfterDelay(3000);
      } else {
        debugLog("Snipd plugin: bad response for test export: ", exportResponse);
        const statusCode = exportResponse ? exportResponse.status : 0;
        const errorMsg = `Test sync failed${statusCode ? ` (${statusCode})` : ""}` + (isDev() && exportResponse ? ` Detail: ${exportResponse.status}` : "");
        this.settings.isTestSyncing = false;
        await this.saveSettings();
        if (this.settingsTab) {
          this.settingsTab.display();
        }
        this.notice(errorMsg, true, 4, true);
        this.clearStatusBarPersistentMessage();
      }
    } else {
      debugLog("Snipd plugin: bad response in testSyncRandomEpisodes: ", response);
      const statusCode = response ? response.status : 0;
      const errorMsg = `Test sync failed${statusCode ? ` (${statusCode})` : ""}` + (isDev() && response ? ` Detail: ${response.status}` : "");
      this.settings.isTestSyncing = false;
      await this.saveSettings();
      if (this.settingsTab) {
        this.settingsTab.display();
      }
      this.notice(errorMsg, true, 4, true);
      this.clearStatusBarPersistentMessage();
    }
  }

  async processZipExport(blob: Blob): Promise<{ episodeCount: number; snipCount: number }> {
    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();

    let metadata: MetadataJson | null = null;
    const episodeFiles: Map<string, { full: string; append?: string }> = new Map();

    for (const entry of entries) {
      // @ts-ignore - zip.js types are incomplete
      const zipEntry: zip.Entry = entry;
      if (zipEntry.directory) {
        continue;
      }
      // @ts-ignore
      const fileContent = await zipEntry.getData(new zip.TextWriter());

      if (zipEntry.filename === 'metadata.json') {
        metadata = JSON.parse(fileContent) as MetadataJson;
      } else if (zipEntry.filename.startsWith('episodes/')) {
        const filename = zipEntry.filename.replace('episodes/', '');
        const match = filename.match(/^(.+?)_(full_content|append_only_content)\.md$/);
        if (match) {
          const [, id, type] = match;
          if (!episodeFiles.has(id)) {
            episodeFiles.set(id, { full: '' });
          }
          const fileData = episodeFiles.get(id)!;
          if (type === 'full_content') {
            fileData.full = fileContent;
          } else {
            fileData.append = fileContent;
          }
        }
      }
    }

    await zipReader.close();

    if (metadata && metadata.latest_snip_update_ts) {
      const batchTimestamp = metadata.latest_snip_update_ts;
      if (!this.settings.latestSyncedSnipUpdateTs || batchTimestamp > this.settings.latestSyncedSnipUpdateTs) {
        this.settings.latestSyncedSnipUpdateTs = batchTimestamp;
      }
      await this.saveSettings();
    }

    const showsData = metadata?.shows_data || {};
    const episodesData = metadata?.episodes_data || {};

    let episodeCount = 0;
    let snipCount = 0;

    for (const [episodeId, fileData] of episodeFiles) {
      const episodeData = episodesData[episodeId];
      if (!episodeData) {
        debugLog(`Snipd plugin: No metadata found for episode ${episodeId}`);
      }
      const episodeName = generateEpisodeFileName(episodeData, episodeId, this.settings);
      const showId = episodeData?.show_id;
      const showName = showId && showsData[showId] ? showsData[showId].name : 'Unknown Show';

      await this.syncFile(
        fileData.full,
        fileData.append,
        sanitizeFileName(episodeName),
        sanitizeFileName(showName),
        episodeData?.total_snip_count
      );
      
      if (episodeData?.updated_snip_count) {
        snipCount += episodeData.updated_snip_count;
        episodeCount++;
      }
    }

    return { episodeCount, snipCount };
  }

  private updateSnipsCountInFrontmatter(content: string, snipsCount: number): string {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return content;
    }

    const frontmatterContent = match[1];
    const restOfContent = content.slice(match[0].length);

    const snipsCountRegex = /^snips_count:\s*\d+\s*$/m;
    
    if (!snipsCountRegex.test(frontmatterContent)) {
      return content;
    }

    const updatedFrontmatter = frontmatterContent.replace(snipsCountRegex, `snips_count: ${snipsCount}`);

    return `---\n${updatedFrontmatter}\n---\n${restOfContent}`;
  }

  async syncFile(
    fullContent: string,
    appendContent: string | undefined,
    entityName: string,
    showName: string,
    totalSnipCount?: number
  ) {
    const targetPath = normalizePath(`${this.settings.snipdDir}/Data/${showName}/${entityName}.md`);

    await createDirForFile(targetPath, this.fs);

    let contentToWrite: string;
    const isAppendOnlyFile = this.settings.appendOnlyFiles[targetPath];

    if (await this.fs.exists(targetPath)) {
      const existingContent = await this.fs.read(targetPath);
      const existingHash = Md5.hashStr(existingContent).toString();
      const storedHash = this.settings.fileHashMap[targetPath];

      if (existingHash === storedHash && !isAppendOnlyFile) {
        contentToWrite = fullContent;
      } else {
        if (!isAppendOnlyFile) {
          this.settings.appendOnlyFiles[targetPath] = true;
        }
        
        if (appendContent) {
          contentToWrite = existingContent.trimEnd() + "\n" + appendContent;
          
          if (totalSnipCount !== undefined) {
            contentToWrite = this.updateSnipsCountInFrontmatter(contentToWrite, totalSnipCount);
          }
        } else {
          contentToWrite = fullContent;
        }
      }
    } else {
      contentToWrite = fullContent;
    }

    await this.fs.write(targetPath, contentToWrite);

    const newHash = Md5.hashStr(contentToWrite).toString();
    this.settings.fileHashMap[targetPath] = newHash;
    await this.saveSettings();
  }

  async saveMetadataToFile(metadata: FetchExportMetadataResponse): Promise<void> {
    const metadataPath = 'current_export_metadata.json';
    const metadataContent = JSON.stringify(metadata, null, 2);
    await this.app.vault.adapter.write(metadataPath, metadataContent);
  }

  async loadMetadataFromFile(): Promise<FetchExportMetadataResponse | null> {
    const metadataPath = 'current_export_metadata.json';
    const exists = await this.app.vault.adapter.exists(metadataPath);
    if (!exists) {
      return null;
    }
    const content = await this.app.vault.adapter.read(metadataPath);
    return JSON.parse(content) as FetchExportMetadataResponse;
  }

  async deleteMetadataFile(): Promise<void> {
    const metadataPath = 'current_export_metadata.json';
    const exists = await this.app.vault.adapter.exists(metadataPath);
    if (exists) {
      await this.app.vault.adapter.remove(metadataPath);
    }
  }

  async fetchAndSaveBaseFile(folderPath: string): Promise<void> {
    this.settings.baseFileManualOverrides = this.settings.baseFileManualOverrides || {};
    const manualOverrides = this.settings.baseFileManualOverrides;
    const existingHashes = { ...(this.settings.baseFileHashes || {}) };
    let zipReader: zip.ZipReader<zip.BlobReader> | null = null;
    let updatedFileCount = 0;
    let removedFileCount = 0;
    let baseFileMetadata: BaseFileMetadata | null = null;
    const filesInZip = new Set<string>();
    try {
      debugLog('Snipd plugin: fetching base file...');
      
      const response = await requestUrl({
        url: `${API_BASE_URL}/obsidian/export-base-file`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.apiKey}`,
        },
      });

      if (response.status < 200 || response.status >= 300) {
        debugLog("Snipd plugin: bad response for base file: ", response);
        debugLog(`Snipd plugin: failed to fetch base file (${response.status})`);
        return;
      }

      const arrayBuffer = response.arrayBuffer;
      const blob = new Blob([arrayBuffer]);
      const blobReader = new zip.BlobReader(blob);
      zipReader = new zip.ZipReader(blobReader);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const entries = await zipReader.getEntries();

      for (const entry of entries) {
        // @ts-ignore - zip.js types are incomplete
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const zipEntry: zip.Entry = entry;
        if (zipEntry.directory) {
          continue;
        }
        
        // @ts-ignore
         
        const fileContent = await zipEntry.getData(new zip.TextWriter());
        
        if (zipEntry.filename === 'metadata.json') {
          baseFileMetadata = JSON.parse(fileContent) as BaseFileMetadata;
          const metadataPath = normalizePath(`${folderPath}/metadata.json`);
          await createDirForFile(metadataPath, this.app.vault.adapter);
          await this.app.vault.adapter.write(metadataPath, fileContent);
          debugLog(`Snipd plugin: saved base file metadata to ${metadataPath}`);
          continue;
        }
        
        let relativePath = zipEntry.filename;
        if (relativePath.startsWith('Files/')) {
          relativePath = relativePath.substring(6);
        }
        const baseFilePath = normalizePath(`${folderPath}/${relativePath}`);
        filesInZip.add(baseFilePath);
        
        if (manualOverrides[baseFilePath]) {
          debugLog(`Snipd plugin: skipping base file ${baseFilePath} - manual override detected.`);
          continue;
        }

        const storedHash = existingHashes[baseFilePath];
        const fileExists = await this.app.vault.adapter.exists(baseFilePath);
        
        if (fileExists && storedHash) {
          try {
            const existingContent = await this.app.vault.adapter.read(baseFilePath);
            const currentHash = Md5.hashStr(existingContent).toString();
            
            if (currentHash !== storedHash) {
              manualOverrides[baseFilePath] = true;
              debugLog(`Snipd plugin: base file ${baseFilePath} hash mismatch - marking as manually overridden.`);
              continue;
            }
          } catch (error) {
            manualOverrides[baseFilePath] = true;
            debugLog(`Snipd plugin: failed to validate base file ${baseFilePath} - marking as manually overridden.`);
            debugLog('Snipd plugin: failed to validate base file integrity:', error);
            continue;
          }
        }

        await createDirForFile(baseFilePath, this.app.vault.adapter);
        await this.app.vault.adapter.write(baseFilePath, fileContent);

        existingHashes[baseFilePath] = Md5.hashStr(fileContent).toString();
        
        debugLog(`Snipd plugin: saved base file to ${baseFilePath}`);
        updatedFileCount++;
      }

      for (const filePath in existingHashes) {
        if (!filesInZip.has(filePath)) {
          if (manualOverrides[filePath]) {
            delete manualOverrides[filePath];
            debugLog(`Snipd plugin: removed manual override for ${filePath} - file no longer in zip.`);
          }
          delete existingHashes[filePath];
          debugLog(`Snipd plugin: removed hash for ${filePath} - file no longer in zip.`);
          removedFileCount++;
        }
      }
    } catch (e) {
      debugLog("Snipd plugin: error fetching base file: ", e);
      debugLog(`Snipd plugin: failed to fetch base file: ${e}`);
    } finally {
      if (zipReader) {
        try {
          await zipReader.close();
        } catch (closeError) {
          debugLog('Snipd plugin: failed to close base file zip reader:', closeError);
        }
      }
    }

    if (updatedFileCount > 0 || removedFileCount > 0 || baseFileMetadata) {
      this.settings.baseFileHashes = existingHashes;
      this.settings.baseFileManualOverrides = manualOverrides;
      this.settings.lastBaseFileSyncToken = this.settings.current_export_updated_after ?? null;
      if (baseFileMetadata) {
        this.settings.baseFileDefaultOpenPath = baseFileMetadata.defaultOpenPath;
      }
      await this.saveSettings();
    }
  }

  async fetchAndSaveBaseFileForTest(folderPath: string): Promise<void> {
    let zipReader: zip.ZipReader<zip.BlobReader> | null = null;
    try {
      debugLog('Snipd plugin: fetching base file for test sync...');
      
      const response = await requestUrl({
        url: `${API_BASE_URL}/obsidian/export-base-file`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.apiKey}`,
        },
      });

      if (response.status < 200 || response.status >= 300) {
        debugLog("Snipd plugin: bad response for base file in test sync: ", response);
        debugLog(`Snipd plugin: failed to fetch base file for test sync (${response.status})`);
        return;
      }

      const arrayBuffer = response.arrayBuffer;
      const blob = new Blob([arrayBuffer]);
      const blobReader = new zip.BlobReader(blob);
      zipReader = new zip.ZipReader(blobReader);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const entries = await zipReader.getEntries();

      for (const entry of entries) {
        // @ts-ignore - zip.js types are incomplete
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const zipEntry: zip.Entry = entry;
        if (zipEntry.directory) {
          continue;
        }
        
        // @ts-ignore
         
        const fileContent = await zipEntry.getData(new zip.TextWriter());
        
        if (zipEntry.filename === 'metadata.json') {
          const metadataPath = normalizePath(`${folderPath}/metadata.json`);
          await createDirForFile(metadataPath, this.app.vault.adapter);
          await this.app.vault.adapter.write(metadataPath, fileContent);
          debugLog(`Snipd plugin: saved base file metadata to ${metadataPath} (test sync - always overwrite)`);
          continue;
        }
        
        let relativePath = zipEntry.filename;
        if (relativePath.startsWith('Files/')) {
          relativePath = relativePath.substring(6);
        }
        const baseFilePath = normalizePath(`${folderPath}/${relativePath}`);
        
        await createDirForFile(baseFilePath, this.app.vault.adapter);
        await this.app.vault.adapter.write(baseFilePath, fileContent);
        
        debugLog(`Snipd plugin: saved base file to ${baseFilePath} (test sync - always overwrite)`);
      }
    } catch (e) {
      debugLog("Snipd plugin: error fetching base file for test sync: ", e);
      debugLog(`Snipd plugin: failed to fetch base file for test sync: ${e}`);
    } finally {
      if (zipReader) {
        try {
          await zipReader.close();
        } catch (closeError) {
          debugLog('Snipd plugin: failed to close base file zip reader in test sync:', closeError);
        }
      }
    }
  }

  async configureSchedule() {
    const minutes = parseInt(this.settings.frequency);
    const milliseconds = minutes * 60 * 1000;
    debugLog('Snipd plugin: setting interval to ', milliseconds, 'milliseconds');
    if (this.scheduleInterval !== null) {
      globalThis.window.clearInterval(this.scheduleInterval);
      this.scheduleInterval = null;
    }
    if (!milliseconds) {
      return;
    }
    this.scheduleInterval = globalThis.window.setInterval(() => {
      void this.syncSnipd();
    }, milliseconds);
    this.registerInterval(this.scheduleInterval);
  }

  async openBaseFile() {
    let defaultOpenPath = this.settings.baseFileDefaultOpenPath;
    
    if (!defaultOpenPath) {
      const metadataPath = normalizePath(`${this.settings.snipdDir}/metadata.json`);
      const metadataExists = await this.app.vault.adapter.exists(metadataPath);
      
      if (metadataExists) {
        try {
          const metadataContent = await this.app.vault.adapter.read(metadataPath);
          const metadata = JSON.parse(metadataContent) as BaseFileMetadata;
          defaultOpenPath = metadata.defaultOpenPath;
          this.settings.baseFileDefaultOpenPath = defaultOpenPath;
          await this.saveSettings();
        } catch (error) {
          debugLog('Snipd plugin: failed to read base file metadata:', error);
        }
      }
      
      if (!defaultOpenPath) {
        this.notice('Base file not found, fetching...', true);
        await this.fetchAndSaveBaseFile(this.settings.snipdDir);
        defaultOpenPath = this.settings.baseFileDefaultOpenPath;
      }
    }
    
    if (!defaultOpenPath) {
      defaultOpenPath = 'Base/Snipd.base';
    }
    
    const baseFilePath = normalizePath(`${this.settings.snipdDir}/${defaultOpenPath}`);
    let file = this.app.vault.getAbstractFileByPath(baseFilePath);
    
    if (!file || !(file instanceof TFile)) {
      this.notice(`Base file not found: ${baseFilePath}`, true);
      return;
    }

    await this.app.workspace.openLinkText(baseFilePath, '', true);
  }

  async onload() {
    addIcon('snipd', `<path d="M30.458 18.725c-14.395 13.692-14.395 35.75 0 49.446L16.667 81.279c14.57 13.85 38.308 13.85 52.875 0 14.391-13.691 14.391-35.75 0-49.437l13.791-13.117c-14.57-13.854-38.308-13.854-52.875 0" stroke="#B2B2B2FF" stroke-width="8.33333" fill="none"/>`);
    this.addRibbonIcon('snipd', 'Open Snipd Base', () => {
      void this.openBaseFile();
    });

    await this.loadSettings();

    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar = new StatusBar(this.addStatusBarItem());
      this.registerInterval(
        globalThis.window.setInterval(() => {
          this.statusBar.display();
        }, 1000)
      );
    }

    this.addCommand({
      id: 'snipd-sync',
      name: 'Sync now',
      callback: () => {
        void this.syncSnipd();
      }
    });

    this.addCommand({
      id: 'snipd-open-base',
      name: 'Open base file',
      callback: () => {
        void this.openBaseFile();
      }
    });

    const settingsTab = new SnipdSettingModal(this.app, this);
    this.addSettingTab(settingsTab);

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.isSyncing) {
        this.settings.isSyncing = false;
        await this.saveSettings();
      }
      
      if (this.settings.isTestSyncing) {
        this.settings.isTestSyncing = false;
        await this.saveSettings();
      }

      if (this.settings.hasCompletedFirstSync && this.settings.triggerOnLoad) {
        await this.syncSnipd();
      }

      if (this.settings.hasCompletedFirstSync) {
        await this.configureSchedule();
      }
    });
  }

  onunload() {
    return;
  }

  getVaultIdentifier(): string {
    return this.app.vault.getName() + '-' + this.manifest.id;
  }

  private async persistSettings(): Promise<void> {
    const { apiKey, ...settingsWithoutApiKey } = this.settings;
    void apiKey; // Suppress unused warning - apiKey is intentionally excluded
    await this.saveData(settingsWithoutApiKey);
  }

  async loadSettings() {
    const loadedData = await this.loadData() as Partial<SnipdPluginSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    
    if (this.settings.encryptedApiKey) {
      try {
        this.settings.apiKey = await SecureStorage.decryptApiKey(
          this.settings.encryptedApiKey,
          this.getVaultIdentifier()
        );
      } catch (error) {
        debugLog('Snipd plugin: Failed to decrypt API key:', error);
        this.settings.apiKey = '';
      }
    } else if (this.settings.apiKey) {
      try {
        this.settings.encryptedApiKey = await SecureStorage.encryptApiKey(
          this.settings.apiKey,
          this.getVaultIdentifier()
        );
        await this.persistSettings();
      } catch (error) {
        debugLog('Snipd plugin: Failed to encrypt existing API key:', error);
      }
    }
  }

  async saveSettings() {
    if (this.settings.apiKey) {
      try {
        this.settings.encryptedApiKey = await SecureStorage.encryptApiKey(
          this.settings.apiKey,
          this.getVaultIdentifier()
        );
      } catch (error) {
        debugLog('Snipd plugin: Failed to encrypt API key:', error);
      }
    }
    
    await this.persistSettings();
  }
}


class StatusBar {
  private messages: StatusBarMessage[] = [];
  private currentMessage: StatusBarMessage | null = null;
  private lastMessageTimestamp: number | null = null;
  private persistentMessage: string | null = null;
  private statusBarEl: HTMLElement;

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
  }

  displayMessage(message: string, timeout: number, forcing: boolean = false) {
    if (this.messages[0]?.message === message) {
      return;
    }
    this.messages.push({
      message: `snipd: ${message.slice(0, 100)}`,
      timeout: timeout * 1000,
    });
    if (forcing) {
      this.clearCurrent();
    }
    this.display();
  }

  setPersistentMessage(message: string) {
    this.persistentMessage = `Snipd: ${message.slice(0, 100)}`;
    this.statusBarEl.setText(this.persistentMessage);
  }

  clearPersistentMessage() {
    this.persistentMessage = null;
    this.display();
  }

  display() {
    if (this.persistentMessage) {
      this.statusBarEl.setText(this.persistentMessage);
      return;
    }

    if (this.currentMessage && this.lastMessageTimestamp) {
      const messageAge = Date.now() - this.lastMessageTimestamp;
      if (messageAge >= this.currentMessage.timeout) {
        this.clearCurrent();
      } else {
        return;
      }
    }
    
    if (this.messages.length > 0) {
      const nextMessage = this.messages.shift()!;
      this.currentMessage = nextMessage;
      this.lastMessageTimestamp = Date.now();
      this.statusBarEl.setText(nextMessage.message);
    } else {
      this.statusBarEl.setText("");
    }
  }

  private clearCurrent() {
    this.currentMessage = null;
    this.lastMessageTimestamp = null;
    if (!this.persistentMessage) {
      this.statusBarEl.setText("");
    }
  }
}

interface StatusBarMessage {
  message: string;
  timeout: number;
}