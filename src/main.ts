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
  DEFAULT_BASE_FILE_PATH,
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

  getBaseFolder(): string {
    const folder = this.settings.baseFolder?.trim() || this.settings.snipdDir || DEFAULT_SETTINGS.baseFolder;
    return normalizePath(folder);
  }

  private getBaseFileRelativePath(baseFileMetadata: BaseFileMetadata | null = null): string {
    const candidates = [
      this.settings.baseFilePath?.trim(),
      baseFileMetadata?.defaultOpenPath,
      this.settings.baseFileDefaultOpenPath,
      DEFAULT_BASE_FILE_PATH,
    ];
    const resolved = candidates.find((value): value is string => !!value) || DEFAULT_BASE_FILE_PATH;
    return normalizePath(resolved);
  }

  getPageFolder(): string {
    const folder = this.settings.pageFolder?.trim();
    if (folder) {
      return normalizePath(folder);
    }
    return normalizePath(`${this.getBaseFolder()}/Data`);
  }

  private deriveTestPageFolder(baseFolder: string, pageFolder: string): string {
    if (pageFolder.startsWith(baseFolder)) {
      const suffix = pageFolder.slice(baseFolder.length);
      return normalizePath(`${baseFolder}-TEST${suffix}`);
    }
    return normalizePath(`${pageFolder}-TEST`);
  }

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
    return await this.app.vault.adapter.exists(this.getPageFolder());
  }

  private async readZipEntryText(entry: zip.Entry): Promise<string> {
    // zip.js typings don't expose getData on the Entry union, so cast to any.
    return await (entry as any).getData(new zip.TextWriter());
  }

  private remapBaseDirectory(relativePath: string, baseFileRelativePath: string): string {
    const baseDir = baseFileRelativePath.includes('/') ? baseFileRelativePath.substring(0, baseFileRelativePath.lastIndexOf('/')) : '';
    if (!baseDir) {
      if (relativePath === 'Base') {
        return '';
      }
      if (relativePath.startsWith('Base/')) {
        return relativePath.substring('Base/'.length);
      }
      return relativePath;
    }

    if (relativePath === 'Base') {
      return baseDir;
    }

    if (relativePath.startsWith('Base/')) {
      const remainder = relativePath.substring('Base/'.length);
      return normalizePath(`${baseDir}/${remainder}`);
    }

    return relativePath;
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
    if (!this.validateSyncPreconditions()) {
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

  private validateSyncPreconditions(): boolean {
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
      debugLog('Snipd plugin: Snipd pages directory not found, clearing metadata and starting fresh sync');
      this.notice("Snipd pages folder not found, starting fresh sync...", true);
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
        await this.fetchAndSaveBaseFile(this.getBaseFolder());
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
      debugLog('Snipd plugin: Snipd pages directory not found during batch processing, restarting sync from scratch');
      this.notice("Snipd pages folder not found, restarting sync from scratch...", true);
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
    const baseFolder = this.getBaseFolder();
    const pageFolder = this.getPageFolder();
    const testBaseFolder = `${baseFolder}-TEST`;
    const testPageFolder = this.deriveTestPageFolder(baseFolder, pageFolder);
    
    const testFolders = [testBaseFolder];
    if (!testPageFolder.startsWith(testBaseFolder)) {
      testFolders.push(testPageFolder);
    }
    
    for (const folder of testFolders) {
      if (await this.app.vault.adapter.exists(folder)) {
        debugLog('Snipd plugin: removing existing test folder', folder);
        this.notice("Removing existing test folder...", true, 0, true);
        await this.app.vault.adapter.rmdir(folder, true);
      }
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
        
        const originalBaseFolderSetting = this.settings.baseFolder;
        const originalPageFolderSetting = this.settings.pageFolder;
        const originalSnipdDir = this.settings.snipdDir;
        const pageFolderForTest = originalPageFolderSetting ? testPageFolder : '';
        let stats: { episodeCount: number; snipCount: number } | null = null;
        
        try {
          this.settings.baseFolder = testBaseFolder;
          this.settings.pageFolder = pageFolderForTest;
          this.settings.snipdDir = testBaseFolder;
          
          await this.fetchAndSaveBaseFileForTest(testBaseFolder);
          
          stats = await this.processZipExport(blob);
        } finally {
          this.settings.baseFolder = originalBaseFolderSetting;
          this.settings.pageFolder = originalPageFolderSetting;
          this.settings.snipdDir = originalSnipdDir;
        }
        
        if (stats) {
          debugLog(`Snipd plugin: test sync requested ${episodeIds.length} episodes, received ${stats.episodeCount} episodes`);
          if (stats.episodeCount < episodeIds.length) {
            debugLog(`Snipd plugin: ${episodeIds.length - stats.episodeCount} episode(s) were skipped by the backend. This usually means the episode or show data is missing, or the episode has no snips for this user.`);
          }
          
          this.settings.isTestSyncing = false;
          await this.saveSettings();
          
          if (this.settingsTab) {
            this.settingsTab.display();
          }
          
          this.setStatusBarPersistentMessage(`Test sync completed (${stats.episodeCount} episodes, ${stats.snipCount} snips)`);
          this.clearStatusBarPersistentMessageAfterDelay(3000);
        } else {
          this.settings.isTestSyncing = false;
          await this.saveSettings();
          this.clearStatusBarPersistentMessage();
        }
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
      const zipEntry: zip.Entry = entry as zip.Entry;
      if (zipEntry.directory) {
        continue;
      }
      const fileContent = await this.readZipEntryText(zipEntry);

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
      let showName = showId && showsData[showId] ? showsData[showId].name : 'Unknown Show';

      // Special handling for YouTube uploads: try to use the channel name (Host/Owner) instead of "Your uploads"
      const originalShowName = showName;
      if (showName === 'Your uploads') {
        let channelName = '';
        let fetchedChannelUrl: string | null = null;
        let fetchedThumbnailUrl: string | null = null;
        let fetchedVideoUrl: string | null = null;
        let actualYouTubeUrl: string | null = null;
        
        // 1. Try to extract channel name from the note content (relies on "Owner / Host" line in template)
        if (fileData.full) {
            const ownerMatch = fileData.full.match(/- Owner \/ Host: (.*)/);
            if (ownerMatch && ownerMatch[1]) {
                const potentialChannelName = ownerMatch[1].trim();
                if (potentialChannelName && potentialChannelName !== 'Your uploads') {
                    channelName = potentialChannelName;
                }
            }
            
            // Try to extract actual YouTube URL from content
            const youtubeUrlInContent = fileData.full.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
            if (youtubeUrlInContent) {
                actualYouTubeUrl = youtubeUrlInContent[0];
            }
        }

        // 2. Fetch extended data from YouTube
        // Check if episode_url is a YouTube URL
        const isYouTubeUrl = episodeData?.episode_url && 
            (episodeData.episode_url.includes('youtube.com') || episodeData.episode_url.includes('youtu.be'));
        
        // Use episode_url if it's a YouTube URL, otherwise use the one extracted from content
        const youtubeUrlToFetch = isYouTubeUrl ? episodeData.episode_url : actualYouTubeUrl;
        
        if (youtubeUrlToFetch) {
            debugLog(`Snipd plugin: Fetching YouTube data for URL: ${youtubeUrlToFetch}`);
            const data = await this.fetchYouTubeVideoData(youtubeUrlToFetch);
            debugLog(`Snipd plugin: YouTube fetch result:`, data);
            
            if (data.channelName) {
                channelName = data.channelName;
            }
            fetchedChannelUrl = data.channelUrl;
            fetchedThumbnailUrl = data.thumbnailUrl;
            
            // Set the actual YouTube URL (this is the real YouTube watch URL)
            if (isYouTubeUrl) {
                actualYouTubeUrl = episodeData.episode_url;
            }
        }

        // 3. Fallback to Search by Title if URL fetch failed to get channel name
        if (!channelName && episodeData?.episode_name) {
            debugLog(`Snipd plugin: URL fetch failed, searching YouTube by title: ${episodeData.episode_name}`);
            const searchData = await this.searchYouTubeByTitle(episodeData.episode_name);
            debugLog(`Snipd plugin: YouTube search result:`, searchData);
            
            if (searchData.channelName) {
                channelName = searchData.channelName;
            }
            if (!fetchedChannelUrl && searchData.channelUrl) {
                fetchedChannelUrl = searchData.channelUrl;
            }
            if (!fetchedThumbnailUrl && searchData.thumbnailUrl) {
                fetchedThumbnailUrl = searchData.thumbnailUrl;
            }
            if (searchData.videoUrl) {
                fetchedVideoUrl = searchData.videoUrl;
                // Use search result URL if we don't have an actual YouTube URL yet
                if (!actualYouTubeUrl) {
                    actualYouTubeUrl = searchData.videoUrl;
                }
            }
        }

        // Update showName for folder structure
        if (channelName) {
            showName = channelName;
            debugLog(`Snipd plugin: Using channel name for folder: ${showName}`);
        }

        // Determine the final YouTube episode URL to use
        const youtubeEpisodeUrl = actualYouTubeUrl || fetchedVideoUrl;

        // MODIFY CONTENT with whatever data we found
        if (fileData.full && channelName) {
            // Update YAML frontmatter properties
            fileData.full = this.updateYouTubeFrontmatter(
                fileData.full, 
                channelName, 
                youtubeEpisodeUrl, 
                fetchedChannelUrl, 
                fetchedThumbnailUrl
            );
            
            // Update "Show" field in body
            fileData.full = fileData.full.replace(/^- Show: .*$/m, `- Show: ${channelName}`);
            // Update "Owner / Host" field in body
            fileData.full = fileData.full.replace(/^- Owner \/ Host: .*$/m, `- Owner / Host: ${channelName}`);
        }

        // Append original URLs and Image URL to metadata section in body
        if (fileData.full && (fetchedChannelUrl || fetchedThumbnailUrl || youtubeEpisodeUrl)) {
            const insertionPointRegex = /(- Episode URL:.*$)/m;
            const match = fileData.full.match(insertionPointRegex);
            
            if (match) {
                const insertionPoint = match[0];
                let extraMetadata = '';
                const contentIncludes = (text: string) => fileData.full.includes(text);

                if (fetchedChannelUrl && !contentIncludes(`- Original Show URL:`)) {
                    extraMetadata += `\n- Original Show URL: ${fetchedChannelUrl}`;
                }
                
                if (youtubeEpisodeUrl && !contentIncludes(`- Original Episode URL:`)) {
                    extraMetadata += `\n- Original Episode URL: ${youtubeEpisodeUrl}`;
                }
                
                if (fetchedThumbnailUrl && !contentIncludes(`- Image URL:`)) {
                    extraMetadata += `\n- Image URL: ${fetchedThumbnailUrl}`;
                }

                if (extraMetadata) {
                    fileData.full = fileData.full.replace(insertionPoint, insertionPoint + extraMetadata);
                    debugLog(`Snipd plugin: Added extra metadata to content`);
                }
            }
        }
      }

      // Handle File Move if show name changed (e.g. "Your uploads" -> "Channel Name")
      if (originalShowName === 'Your uploads' && showName !== 'Your uploads') {
          const sanitizedEpisodeName = sanitizeFileName(episodeName);
          const sanitizedOldShow = sanitizeFileName('Your uploads');
          const sanitizedNewShow = sanitizeFileName(showName);
          
          const oldPath = normalizePath(`${this.getPageFolder()}/${sanitizedOldShow}/${sanitizedEpisodeName}.md`);
          const newPath = normalizePath(`${this.getPageFolder()}/${sanitizedNewShow}/${sanitizedEpisodeName}.md`);
          
          if (await this.fs.exists(oldPath) && !(await this.fs.exists(newPath))) {
              try {
                await createDirForFile(newPath, this.fs);
                await this.fs.rename(oldPath, newPath);
                debugLog(`Snipd plugin: moved file from ${oldPath} to ${newPath}`);
                
                // Migrate metadata settings
                if (this.settings.fileHashMap[oldPath]) {
                    this.settings.fileHashMap[newPath] = this.settings.fileHashMap[oldPath];
                    delete this.settings.fileHashMap[oldPath];
                }
                if (this.settings.appendOnlyFiles[oldPath]) {
                    this.settings.appendOnlyFiles[newPath] = this.settings.appendOnlyFiles[oldPath];
                    delete this.settings.appendOnlyFiles[oldPath];
                }
                // We should save settings to persist the migration immediately
                await this.saveSettings(); 
              } catch (e) {
                  debugLog(`Snipd plugin: failed to move file from ${oldPath} to ${newPath}`, e);
              }
          }
      }

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

  private updateYouTubeFrontmatter(
    content: string, 
    channelName: string | null, 
    youtubeEpisodeUrl: string | null, 
    youtubeChannelUrl: string | null, 
    thumbnailUrl: string | null
  ): string {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      // No frontmatter exists, create one
      let newFrontmatter = '---\n';
      if (channelName) {
        newFrontmatter += `show_title: "${channelName}"\n`;
      }
      if (youtubeEpisodeUrl) {
        newFrontmatter += `youtube_episode_url: "${youtubeEpisodeUrl}"\n`;
      }
      if (youtubeChannelUrl) {
        newFrontmatter += `youtube_channel_url: "${youtubeChannelUrl}"\n`;
      }
      if (thumbnailUrl) {
        newFrontmatter += `image_url: "${thumbnailUrl}"\n`;
      }
      newFrontmatter += '---\n';
      return newFrontmatter + content;
    }

    let frontmatterContent = match[1];
    const restOfContent = content.slice(match[0].length);

    // Helper to update or add a property
    const updateOrAddProperty = (fm: string, key: string, value: string): string => {
      const keyRegex = new RegExp(`^${key}:.*$`, 'm');
      // Escape quotes in value
      const escapedValue = value.replace(/"/g, '\\"');
      if (keyRegex.test(fm)) {
        return fm.replace(keyRegex, `${key}: "${escapedValue}"`);
      } else {
        return fm.trimEnd() + `\n${key}: "${escapedValue}"`;
      }
    };

    // Helper to remove a property
    const removeProperty = (fm: string, key: string): string => {
      const keyRegex = new RegExp(`^${key}:.*$\\n?`, 'm');
      return fm.replace(keyRegex, '');
    };

    // Update show_title
    if (channelName) {
      frontmatterContent = updateOrAddProperty(frontmatterContent, 'show_title', channelName);
    }

    // Add youtube_episode_url
    if (youtubeEpisodeUrl) {
      frontmatterContent = updateOrAddProperty(frontmatterContent, 'youtube_episode_url', youtubeEpisodeUrl);
    }

    // Add youtube_channel_url
    if (youtubeChannelUrl) {
      frontmatterContent = updateOrAddProperty(frontmatterContent, 'youtube_channel_url', youtubeChannelUrl);
    }

    // Update image_url with thumbnail URL (and remove cover if it exists)
    if (thumbnailUrl) {
      frontmatterContent = removeProperty(frontmatterContent, 'cover');
      frontmatterContent = updateOrAddProperty(frontmatterContent, 'image_url', thumbnailUrl);
    }

    return `---\n${frontmatterContent}\n---\n${restOfContent}`;
  }

  private async fetchYouTubeVideoData(url: string): Promise<{
    channelName: string | null;
    channelUrl: string | null;
    thumbnailUrl: string | null;
  }> {
    try {
      debugLog(`Snipd plugin: Requesting YouTube URL: ${url}`);
      const response = await requestUrl({ url: url });
      const html = response.text;
      debugLog(`Snipd plugin: Received HTML length: ${html.length}`);
      
      let channelName: string | null = null;
      let channelUrl: string | null = null;
      let thumbnailUrl: string | null = null;

      // Method 1: Try to find ytInitialPlayerResponse which contains video details
      const playerResponseMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});/);
      if (playerResponseMatch && playerResponseMatch[1]) {
        try {
          const playerData = JSON.parse(playerResponseMatch[1]);
          const videoDetails = playerData.videoDetails;
          if (videoDetails) {
            channelName = videoDetails.author || null;
            if (videoDetails.channelId) {
              channelUrl = `https://www.youtube.com/channel/${videoDetails.channelId}`;
            }
            // Get highest quality thumbnail
            const thumbnails = videoDetails.thumbnail?.thumbnails;
            if (thumbnails && thumbnails.length > 0) {
              thumbnailUrl = thumbnails[thumbnails.length - 1].url;
            }
          }
          debugLog(`Snipd plugin: Parsed ytInitialPlayerResponse - channel: ${channelName}`);
        } catch (parseError) {
          debugLog(`Snipd plugin: Failed to parse ytInitialPlayerResponse`, parseError);
        }
      }

      // Method 2: Fallback to regex patterns if JSON parsing failed
      if (!channelName) {
        // Try ownerChannelName
        const ownerChannelNameMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
        if (ownerChannelNameMatch && ownerChannelNameMatch[1]) {
          channelName = ownerChannelNameMatch[1];
          debugLog(`Snipd plugin: Found ownerChannelName: ${channelName}`);
        }
      }

      if (!channelName) {
        // Try author field
        const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/);
        if (authorMatch && authorMatch[1]) {
          channelName = authorMatch[1];
          debugLog(`Snipd plugin: Found author: ${channelName}`);
        }
      }

      if (!channelUrl) {
        // Try ownerProfileUrl
        const channelUrlMatch = html.match(/"ownerProfileUrl"\s*:\s*"([^"]+)"/);
        if (channelUrlMatch && channelUrlMatch[1]) {
          channelUrl = channelUrlMatch[1];
        } else {
          // Try channelId
          const channelIdMatch = html.match(/"channelId"\s*:\s*"([^"]+)"/);
          if (channelIdMatch && channelIdMatch[1]) {
            channelUrl = `https://www.youtube.com/channel/${channelIdMatch[1]}`;
          }
        }
      }

      if (!thumbnailUrl) {
        // Try og:image meta tag
        const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
        if (ogImageMatch && ogImageMatch[1]) {
          thumbnailUrl = ogImageMatch[1];
        } else {
          // Alternative og:image format
          const ogImageAltMatch = html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/);
          if (ogImageAltMatch && ogImageAltMatch[1]) {
            thumbnailUrl = ogImageAltMatch[1];
          }
        }
      }

      debugLog(`Snipd plugin: Final YouTube data - channel: ${channelName}, url: ${channelUrl}, thumb: ${thumbnailUrl ? 'found' : 'not found'}`);
      return { channelName, channelUrl, thumbnailUrl };
    } catch (e) {
      debugLog('Snipd plugin: failed to fetch YouTube video data', e);
      return { channelName: null, channelUrl: null, thumbnailUrl: null };
    }
  }

  private async searchYouTubeByTitle(title: string): Promise<{
    channelName: string | null;
    channelUrl: string | null;
    videoUrl: string | null;
    thumbnailUrl: string | null;
  }> {
    try {
      // Search YouTube for the video title
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title)}`;
      debugLog(`Snipd plugin: Searching YouTube: ${searchUrl}`);
      const response = await requestUrl({ url: searchUrl });
      const html = response.text;

      // Extract ytInitialData which contains search results
      // The JSON can be very large, so we need a more robust extraction
      const ytInitialDataMatch = html.match(/var ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
      if (ytInitialDataMatch && ytInitialDataMatch[1]) {
        try {
          const data = JSON.parse(ytInitialDataMatch[1]);
          
          // Navigate through the JSON structure to find video results
          const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
          
          if (contents) {
            // Find the first video renderer in the results
            for (const section of contents) {
              const items = section.itemSectionRenderer?.contents;
              if (items) {
                for (const item of items) {
                  if (item.videoRenderer) {
                    const videoRenderer = item.videoRenderer;
                    const channelName = videoRenderer.ownerText?.runs?.[0]?.text || null;
                    const channelId = videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
                    const channelUrl = channelId ? `https://www.youtube.com/channel/${channelId}` : null;
                    const videoId = videoRenderer.videoId;
                    const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
                    // Get highest quality thumbnail
                    const thumbnails = videoRenderer.thumbnail?.thumbnails;
                    const thumbnailUrl = thumbnails && thumbnails.length > 0 
                      ? thumbnails[thumbnails.length - 1].url 
                      : null;

                    debugLog(`Snipd plugin: Found video in search - channel: ${channelName}, videoId: ${videoId}`);
                    return { channelName, channelUrl, videoUrl, thumbnailUrl };
                  }
                }
              }
            }
          }
        } catch (parseError) {
          debugLog(`Snipd plugin: Failed to parse ytInitialData`, parseError);
        }
      }

      debugLog(`Snipd plugin: No video found in YouTube search results`);
      return { channelName: null, channelUrl: null, videoUrl: null, thumbnailUrl: null };
    } catch (e) {
      debugLog('Snipd plugin: failed to search YouTube by title', e);
      return { channelName: null, channelUrl: null, videoUrl: null, thumbnailUrl: null };
    }
  }

  async syncFile(
    fullContent: string,
    appendContent: string | undefined,
    entityName: string,
    showName: string,
    totalSnipCount?: number
  ) {
    const targetPath = normalizePath(`${this.getPageFolder()}/${showName}/${entityName}.md`);

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
    let baseFileRelativePath = this.getBaseFileRelativePath();
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
      const entries = await zipReader.getEntries();

      const metadataEntry = entries.find((entry) => !entry.directory && entry.filename === 'metadata.json');
      if (metadataEntry) {
        const metadataContent = await this.readZipEntryText(metadataEntry as zip.Entry);
        baseFileMetadata = JSON.parse(metadataContent) as BaseFileMetadata;
        baseFileRelativePath = this.getBaseFileRelativePath(baseFileMetadata);
        const metadataPath = normalizePath(`${folderPath}/metadata.json`);
        await createDirForFile(metadataPath, this.app.vault.adapter);
        await this.app.vault.adapter.write(metadataPath, metadataContent);
        debugLog(`Snipd plugin: saved base file metadata to ${metadataPath}`);
      }

      for (const entry of entries) {
        const zipEntry: zip.Entry = entry;
        if (zipEntry.directory) {
          continue;
        }
        
        if (zipEntry.filename === 'metadata.json') {
          continue;
        }
        
        const fileContent = await this.readZipEntryText(zipEntry);
        
        let relativePath = zipEntry.filename;
        if (relativePath.startsWith('Files/')) {
          relativePath = relativePath.substring(6);
        }
        relativePath = this.remapBaseDirectory(relativePath, baseFileRelativePath);
        if (relativePath.endsWith('.base')) {
          relativePath = baseFileRelativePath;
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
      this.settings.baseFileDefaultOpenPath = baseFileRelativePath;
      await this.saveSettings();
    }
  }

  async fetchAndSaveBaseFileForTest(folderPath: string): Promise<void> {
    let zipReader: zip.ZipReader<zip.BlobReader> | null = null;
    let baseFileMetadata: BaseFileMetadata | null = null;
    let baseFileRelativePath = this.getBaseFileRelativePath();
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
      const entries = await zipReader.getEntries();

      const metadataEntry = entries.find((entry) => !entry.directory && entry.filename === 'metadata.json');
      if (metadataEntry) {
        const metadataContent = await this.readZipEntryText(metadataEntry as zip.Entry);
        baseFileMetadata = JSON.parse(metadataContent) as BaseFileMetadata;
        baseFileRelativePath = this.getBaseFileRelativePath(baseFileMetadata);
        const metadataPath = normalizePath(`${folderPath}/metadata.json`);
        await createDirForFile(metadataPath, this.app.vault.adapter);
        await this.app.vault.adapter.write(metadataPath, metadataContent);
        debugLog(`Snipd plugin: saved base file metadata to ${metadataPath} (test sync - always overwrite)`);
      }

      for (const entry of entries) {
        const zipEntry: zip.Entry = entry;
        if (zipEntry.directory) {
          continue;
        }
        if (zipEntry.filename === 'metadata.json') {
          continue;
        }
        
        const fileContent = await this.readZipEntryText(zipEntry);
        
        let relativePath = zipEntry.filename;
        if (relativePath.startsWith('Files/')) {
          relativePath = relativePath.substring(6);
        }
        relativePath = this.remapBaseDirectory(relativePath, baseFileRelativePath);
        if (relativePath.endsWith('.base')) {
          relativePath = baseFileRelativePath;
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

  configureSchedule() {
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

  async forceFullResync() {
    if (this.settings.isSyncing) {
      this.notice("Sync already in progress", true);
      return;
    }

    this.notice("Clearing sync history for full re-sync...", true);
    
    // Clear the timestamp so all episodes are fetched again
    this.settings.last_updated_after = null;
    this.settings.latestSyncedSnipUpdateTs = null;
    this.settings.current_export_updated_after = null;
    this.settings.current_export_batch_index = 0;
    this.settings.current_export_total_batches = 0;
    await this.saveSettings();
    
    // Now trigger a normal sync which will fetch everything
    await this.syncSnipd();
  }

  async migrateYouTubeUploads() {
    this.notice("Migrating YouTube uploads...", true);
    this.setStatusBarPersistentMessage("Migrating YouTube uploads...");
    
    const yourUploadsFolder = normalizePath(`${this.getPageFolder()}/${sanitizeFileName('Your uploads')}`);
    
    if (!(await this.app.vault.adapter.exists(yourUploadsFolder))) {
      this.notice("No 'Your uploads' folder found", true);
      this.clearStatusBarPersistentMessage();
      return;
    }

    const files = await this.app.vault.adapter.list(yourUploadsFolder);
    const mdFiles = files.files.filter(f => f.endsWith('.md'));
    
    if (mdFiles.length === 0) {
      this.notice("No files found in 'Your uploads' folder", true);
      this.clearStatusBarPersistentMessage();
      return;
    }

    let migratedCount = 0;
    let failedCount = 0;

    for (const filePath of mdFiles) {
      try {
        const content = await this.app.vault.adapter.read(filePath);
        
        // Try to find actual YouTube URL in the content (youtube.com/watch or youtu.be)
        // First check if there's already an "Original Episode URL" with YouTube
        const originalEpUrlMatch = content.match(/Original Episode URL:\s*(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^\s\)]+)/);
        // Then check for any YouTube watch URL in the content
        const youtubeWatchUrlMatch = content.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
        
        // Use the original episode URL if it's a YouTube URL, otherwise use any YouTube URL found
        const youtubeUrl = originalEpUrlMatch?.[1] || (youtubeWatchUrlMatch ? youtubeWatchUrlMatch[0] : null);
        
        // Also try to get episode title from content
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const episodeTitle = titleMatch?.[1];
        
        let channelName: string | null = null;
        let channelUrl: string | null = null;
        let thumbnailUrl: string | null = null;
        let fetchedVideoUrl: string | null = null;

        // Try to fetch YouTube data
        if (youtubeUrl) {
          debugLog(`Snipd plugin: Migrating file ${filePath}, found YouTube URL: ${youtubeUrl}`);
          const data = await this.fetchYouTubeVideoData(youtubeUrl);
          channelName = data.channelName;
          channelUrl = data.channelUrl;
          thumbnailUrl = data.thumbnailUrl;
        }

        // Fallback to search by title
        if (!channelName && episodeTitle) {
          debugLog(`Snipd plugin: URL fetch failed, searching by title: ${episodeTitle}`);
          const searchData = await this.searchYouTubeByTitle(episodeTitle);
          channelName = searchData.channelName;
          if (!channelUrl) channelUrl = searchData.channelUrl;
          if (!thumbnailUrl) thumbnailUrl = searchData.thumbnailUrl;
          if (searchData.videoUrl) fetchedVideoUrl = searchData.videoUrl;
        }

        if (!channelName) {
          debugLog(`Snipd plugin: Could not determine channel name for ${filePath}`);
          failedCount++;
          continue;
        }

        // Determine the final YouTube episode URL
        const finalYouTubeUrl = youtubeUrl || fetchedVideoUrl;

        // Update content
        let updatedContent = content;
        
        // Update YAML frontmatter properties
        updatedContent = this.updateYouTubeFrontmatter(updatedContent, channelName, finalYouTubeUrl, channelUrl, thumbnailUrl);
        
        // Update Show field in body
        updatedContent = updatedContent.replace(/^- Show: .*$/m, `- Show: ${channelName}`);
        // Update Owner / Host field in body
        updatedContent = updatedContent.replace(/^- Owner \/ Host: .*$/m, `- Owner / Host: ${channelName}`);

        // Add extra metadata if not present in body
        const insertionPointRegex = /(- Episode URL:.*$)/m;
        const match = updatedContent.match(insertionPointRegex);
        if (match) {
          const insertionPoint = match[0];
          let extraMetadata = '';

          if (channelUrl && !updatedContent.includes(`- Original Show URL:`)) {
            extraMetadata += `\n- Original Show URL: ${channelUrl}`;
          }
          if (youtubeUrl && !updatedContent.includes(`- Original Episode URL:`)) {
            extraMetadata += `\n- Original Episode URL: ${youtubeUrl}`;
          }
          if (thumbnailUrl && !updatedContent.includes(`- Image URL:`)) {
            extraMetadata += `\n- Image URL: ${thumbnailUrl}`;
          }

          if (extraMetadata) {
            updatedContent = updatedContent.replace(insertionPoint, insertionPoint + extraMetadata);
          }
        }

        // Move file to new location
        const fileName = filePath.split('/').pop() || '';
        const newFolderPath = normalizePath(`${this.getPageFolder()}/${sanitizeFileName(channelName)}`);
        const newFilePath = normalizePath(`${newFolderPath}/${fileName}`);

        // Create new folder if needed
        await createDirForFile(newFilePath, this.app.vault.adapter);

        // Write updated content to new location
        await this.app.vault.adapter.write(newFilePath, updatedContent);

        // Delete old file
        await this.app.vault.adapter.remove(filePath);

        // Migrate settings
        if (this.settings.fileHashMap[filePath]) {
          this.settings.fileHashMap[newFilePath] = Md5.hashStr(updatedContent).toString();
          delete this.settings.fileHashMap[filePath];
        }
        if (this.settings.appendOnlyFiles[filePath]) {
          this.settings.appendOnlyFiles[newFilePath] = this.settings.appendOnlyFiles[filePath];
          delete this.settings.appendOnlyFiles[filePath];
        }

        debugLog(`Snipd plugin: Migrated ${filePath} to ${newFilePath}`);
        migratedCount++;
        
        this.setStatusBarPersistentMessage(`Migrating... (${migratedCount}/${mdFiles.length})`);
      } catch (e) {
        debugLog(`Snipd plugin: Failed to migrate ${filePath}`, e);
        failedCount++;
      }
    }

    await this.saveSettings();

    // Try to remove the empty "Your uploads" folder
    try {
      const remainingFiles = await this.app.vault.adapter.list(yourUploadsFolder);
      if (remainingFiles.files.length === 0 && remainingFiles.folders.length === 0) {
        await this.app.vault.adapter.rmdir(yourUploadsFolder, false);
        debugLog(`Snipd plugin: Removed empty 'Your uploads' folder`);
      }
    } catch (e) {
      debugLog(`Snipd plugin: Could not remove 'Your uploads' folder`, e);
    }

    const message = `Migration complete: ${migratedCount} moved, ${failedCount} failed`;
    this.notice(message, true);
    this.setStatusBarPersistentMessage(message);
    this.clearStatusBarPersistentMessageAfterDelay(5000);
  }

  async openBaseFile() {
    let baseFileMetadata: BaseFileMetadata | null = null;

    if (!this.settings.baseFilePath) {
      const metadataPath = normalizePath(`${this.getBaseFolder()}/metadata.json`);
      const metadataExists = await this.app.vault.adapter.exists(metadataPath);
      
      if (metadataExists) {
        try {
          const metadataContent = await this.app.vault.adapter.read(metadataPath);
          baseFileMetadata = JSON.parse(metadataContent) as BaseFileMetadata;
          this.settings.baseFileDefaultOpenPath = baseFileMetadata.defaultOpenPath;
          await this.saveSettings();
        } catch (error) {
          debugLog('Snipd plugin: failed to read base file metadata:', error);
        }
      }
    }
    
    let baseFileRelativePath = this.getBaseFileRelativePath(baseFileMetadata);
    let baseFilePath = normalizePath(`${this.getBaseFolder()}/${baseFileRelativePath}`);
    let file = this.app.vault.getAbstractFileByPath(baseFilePath);
    
    if (!file || !(file instanceof TFile)) {
      this.notice('Base file not found, fetching...', true);
      await this.fetchAndSaveBaseFile(this.getBaseFolder());
      baseFileRelativePath = this.getBaseFileRelativePath();
      baseFilePath = normalizePath(`${this.getBaseFolder()}/${baseFileRelativePath}`);
      file = this.app.vault.getAbstractFileByPath(baseFilePath);
    }

    if (!file || !(file instanceof TFile)) {
      this.notice(`Base file not found: ${baseFilePath}`, true);
      return;
    }

    await this.app.workspace.openLinkText(baseFilePath, '', true);
  }

  async onload() {
    addIcon('snipd', `<path d="M30.458 18.725c-14.395 13.692-14.395 35.75 0 49.446L16.667 81.279c14.57 13.85 38.308 13.85 52.875 0 14.391-13.691 14.391-35.75 0-49.437l13.791-13.117c-14.57-13.854-38.308-13.854-52.875 0" stroke="#B2B2B2FF" stroke-width="8.33333" fill="none"/>`);
    this.addRibbonIcon('snipd', 'Open Snipd base', () => {
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
      id: 'snipd-force-full-sync',
      name: 'Force full re-sync (re-download all episodes)',
      callback: () => {
        void this.forceFullResync();
      }
    });

    this.addCommand({
      id: 'snipd-migrate-youtube-uploads',
      name: 'Migrate YouTube uploads to channel folders',
      callback: () => {
        void this.migrateYouTubeUploads();
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
        this.configureSchedule();
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
    if (loadedData?.snipdDir && !loadedData.baseFolder) {
      this.settings.baseFolder = loadedData.snipdDir;
    }
    if (!this.settings.baseFolder) {
      this.settings.baseFolder = DEFAULT_SETTINGS.baseFolder;
    }
    if (!this.settings.pageFolder && loadedData && !Object.prototype.hasOwnProperty.call(loadedData, 'pageFolder')) {
      this.settings.pageFolder = "";
    }
    this.settings.baseFolder = normalizePath(this.settings.baseFolder);
    if (this.settings.pageFolder) {
      this.settings.pageFolder = normalizePath(this.settings.pageFolder);
    }
    if (!this.settings.baseFilePath) {
      this.settings.baseFilePath = DEFAULT_BASE_FILE_PATH;
    }
    this.settings.baseFilePath = normalizePath(this.settings.baseFilePath);
    this.settings.snipdDir = this.settings.baseFolder;
    
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
    this.settings.snipdDir = this.settings.baseFolder || this.settings.snipdDir;
    this.settings.baseFilePath = normalizePath(this.settings.baseFilePath || DEFAULT_BASE_FILE_PATH);
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
