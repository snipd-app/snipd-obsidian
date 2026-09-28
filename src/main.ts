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
  BaseFileMetadata,
  CheckTranscriptEligibilityResponse
} from './types';

function isValidAdditionalProperties(
  props: Array<{ name: string; template: string; displayName?: string }> | null
): props is Array<{ name: string; template: string; displayName?: string }> {
  return Array.isArray(props) && props.length > 0 && props.every((p) => !!p.name?.trim() && !!p.template?.trim());
}
import { generateEpisodeFileName, createDirForFile, isDev, debugLog, formatSyncCounts } from './utils';
import { sanitizeFileName } from './sanitize_file_name';
import { SnipdSettingModal } from './settings_modal';
import { SecureStorage } from './secure_storage';

const TRANSCRIPT_HEADER = '## Full episode transcript';
const SNIPD_FOOTER = 'Created with [Snipd](https://www.snipd.com) | Highlight & Take Notes from Podcasts';

export const AUTH_URL = "https://app.snipd.com/obsidian/auth";
export const API_BASE_URL = isDev() ? "http://0.0.0.0:8080/v1/public/api" : "https://api.snipd.com/v1/public/api";

const TRANSCRIPT_ELIGIBILITY_RECHECK_MS = 24 * 60 * 60 * 1000;
// check-transcript-eligibility rejects requests with more ids than this.
const TRANSCRIPT_ELIGIBILITY_MAX_IDS = 1000;
// A full transcript is ~100 KB of markdown; small batches keep each zip, and the memory it is
// unpacked into, bounded.
const TRANSCRIPT_EXPORT_BATCH_SIZE = 50;

type ExportRequestBody = {
  episode_ids: string[];
  episode_template: string;
  snip_template: string;
  additional_properties?: Array<{ name: string; template: string; displayName?: string; }>;
  updated_after?: string;
  only_edited_snips?: boolean;
  include_transcript?: boolean;
  transcript_only?: boolean;
};

type SyncStats = { episodeCount: number; snipCount: number; transcriptCount: number };

/**
 * `signal` belongs to this run, not to `syncAbortController`: Stop clears the controller and a new
 * sync installs its own, so only the captured signal still tells this run it was stopped.
 */
type SyncRun = { signal: AbortSignal; debugFolderPath: string | null };

export type TranscriptSyncProgress =
  | { phase: 'checking'; episodeCount: number }
  | { phase: 'exporting'; batchIndex: number; totalBatches: number; episodeCount: number };

export default class SnipdPlugin extends Plugin {
  settings: SnipdPluginSettings;
  fs: DataAdapter;
  scheduleInterval: null | number = null;
  statusBar: StatusBar;
  settingsTab: SnipdSettingModal | null = null;
  syncAbortController: AbortController | null = null;
  /** Not in settings: an interrupted transcript phase restarts from the pending list, it never resumes. */
  transcriptSyncProgress: TranscriptSyncProgress | null = null;
  /** Episodes whose note was written without a transcript section during the current sync. */
  private transcriptSectionNeeded = new Set<string>();
  /**
   * Vault id + key that `encryptedApiKey` currently encrypts. Encryption runs 100k PBKDF2
   * iterations (~100 ms) and saveSettings is called once per synced note.
   */
  private encryptedApiKeySource: string | null = null;

  private formatAuthorizationToken(apiKey: string): string {
    return `Bearer ${apiKey}`;
  }

  private extractResponseFromError(error: unknown): { status: number } | null {
    if (error && typeof error === 'object' && error !== null) {
      const errorObj = error as Record<string, unknown>;
      const responseObj = errorObj.response;
      if (responseObj && 
          typeof responseObj === 'object' &&
          'status' in responseObj) {
        const status = (responseObj as Record<string, unknown>).status;
        if (typeof status === 'number') {
          return { status };
        }
      } else if ('status' in errorObj) {
        const status = errorObj.status;
        if (typeof status === 'number') {
          return { status };
        }
      }
    }
    return null;
  }

  private formatApiErrorMessage(
    error: unknown,
    response: { status: number } | null = null,
    context: string = "Sync"
  ): string {
    if (response) {
      const statusCode = response.status;
      let statusMessage = "";
      
      if (statusCode === 401) {
        statusMessage = "Authentication failed. Please check your API key in settings.";
      } else if (statusCode === 403) {
        statusMessage = "Access forbidden. Your account may not have permission for this operation.";
      } else if (statusCode === 404) {
        statusMessage = "Resource not found.";
      } else if (statusCode === 429) {
        statusMessage = "Rate limit exceeded. Please try again later.";
      } else if (statusCode >= 500) {
        statusMessage = "Server error. Please try again later.";
      } else if (statusCode >= 400) {
        statusMessage = "Request error.";
      } else {
        statusMessage = "Unexpected response.";
      }
      
      return `${context} failed (${statusCode}): ${statusMessage}`;
    }
    
    if (error instanceof Error) {
      const errorMessage = error.message || String(error);
      const errorName = error.name || "Error";
      
      if (errorName === "AbortError" || errorMessage.includes("aborted")) {
        return `${context} cancelled.`;
      }
      
      if (errorMessage.includes("network") || errorMessage.includes("fetch") || errorMessage.includes("ECONNREFUSED")) {
        return `${context} failed: Network error - unable to connect to server.`;
      }
      
      if (errorMessage.includes("timeout")) {
        return `${context} failed: Request timeout - server took too long to respond.`;
      }
      
      if (isDev()) {
        return `${context} failed: ${errorName} - ${errorMessage}`;
      }
      
      return `${context} failed: ${errorName}.`;
    }
    
    const errorString = String(error);
    if (isDev()) {
      return `${context} failed: ${errorString}`;
    }
    
    return `${context} failed: Unable to connect to server.`;
  }

  async handleSyncError(msg: string) {
    await this.clearSettingsAfterRun();
    this.notice(msg, true, 4, true);
    this.clearStatusBarPersistentMessage();
  }

  async clearSettingsAfterRun() {
    this.settings.isSyncing = false;
    this.syncAbortController = null;
    this.transcriptSyncProgress = null;
    await this.saveSettings();
    if (this.settingsTab) {
      this.settingsTab.refresh();
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
      window.setTimeout(() => {
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
    this.settings.episodeTranscriptsSyncedTs = {};
    this.settings.pendingTranscriptEpisodeIds = [];
    this.settings.transcriptEligibilityCheckedTs = {};
    await this.deleteMetadataFile();
    await this.saveSettings();
  }

  async resetSyncAndResync(): Promise<void> {
    if (this.settings.isSyncing || this.settings.isTestSyncing) {
      this.notice("Please wait for the current sync to finish or stop it before resetting", true);
      return;
    }

    if (!this.settings.apiKey) {
      this.notice("Please connect with your Snipd account in settings", true);
      return;
    }

    this.notice("Resetting sync data...", true, 0, true);

    try {
      const snipdDirExists = await this.app.vault.adapter.exists(this.settings.snipdDir);
      if (snipdDirExists) {
        await this.app.vault.adapter.rmdir(this.settings.snipdDir, true);
        debugLog(`Snipd plugin: removed Snipd base folder at ${this.settings.snipdDir}`);
      }
    } catch (error) {
      debugLog('Snipd plugin: failed to remove Snipd base folder during reset:', error);
      this.notice("Reset failed: unable to remove Snipd folder. Check logs for details.", true, 4, true);
      return;
    }

    this.settings.isSyncing = false;
    this.settings.isTestSyncing = false;
    this.syncAbortController = null;

    await this.clearSyncMetadata();

    this.settings.lastSyncTimestamp = null;
    this.settings.lastSyncEpisodeCount = 0;
    this.settings.lastSyncSnipCount = 0;
    this.settings.lastSyncTranscriptCount = 0;
    this.settings.hasCompletedFirstSync = false;
    await this.saveSettings();

    if (this.settingsTab) {
      this.settingsTab.refresh();
    }

    this.notice("Sync data reset. Starting fresh sync...", true, 0, true);
    await this.syncSnipd();
  }

  /** `force` ignores the re-check throttle for pending transcripts. */
  async syncSnipd(options: { force?: boolean } = {}) {
    if (!this.validateSyncPreconditions()) {
      return;
    }

    await this.checkAndHandleMissingDirectory();

    const run: SyncRun = {
      signal: await this.initializeSync(),
      debugFolderPath: this.settings.saveDebugZips ? `snipd_plugin_debug/sync_${Date.now()}` : null,
    };

    const metadata = await this.fetchOrLoadMetadata(run);
    if (!metadata || run.signal.aborted) {
      return;
    }

    const stats = await this.processAllBatches(metadata, run);
    if (!stats || run.signal.aborted) {
      return;
    }

    const pendingTranscriptCount = await this.syncPendingTranscripts(options.force === true, run);
    if (pendingTranscriptCount === null || run.signal.aborted) {
      return;
    }

    await this.finalizeSync({ ...stats, transcriptCount: stats.transcriptCount + pendingTranscriptCount });
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
      debugLog('Snipd plugin: Snipd directory not found, clearing metadata and starting fresh sync');
      this.notice("Snipd base folder not found, starting fresh sync...", true);
      await this.clearSyncMetadata();
    }
  }

  private async initializeSync(): Promise<AbortSignal> {
    debugLog('Snipd plugin: starting sync...');
    this.settings.isSyncing = true;
    const abortController = new AbortController();
    this.syncAbortController = abortController;
    this.transcriptSectionNeeded.clear();
    await this.saveSettings();
    
    if (this.settingsTab) {
      this.settingsTab.refresh();
    }

    this.notice("Snipd sync started...", true, 0, true);
    this.setStatusBarPersistentMessage("Snipd sync in progress...");
    return abortController.signal;
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

  private async fetchMetadataFromApi(run: SyncRun): Promise<FetchExportMetadataResponse | null> {
    const url = this.buildMetadataUrl();

    let response;
    try {
      debugLog(`Snipd plugin: fetching metadata from ${url}`);
      this.setStatusBarPersistentMessage("Fetching metadata...");
      response = await requestUrl({
        url: url,
        method: 'GET',
        headers: {
          'Authorization': this.formatAuthorizationToken(this.settings.apiKey),
        },
      });
      debugLog(`Snipd plugin: metadata response status: ${response.status}`);
    } catch (e) {
      if (run.signal.aborted) {
        return null;
      }
      debugLog("Snipd plugin: request failed in syncSnipd: ", e);
      const errorResponse = this.extractResponseFromError(e);
      const errorMsg = this.formatApiErrorMessage(e, errorResponse, "Sync");
      await this.handleSyncError(errorMsg);
      return null;
    }

    if (run.signal.aborted) {
      return null;
    }

    if (response && response.status >= 200 && response.status < 300) {
      const metadata = response.json as FetchExportMetadataResponse;

      await this.saveMetadataToFile(metadata);

      if (run.debugFolderPath) {
        await createDirForFile(`${run.debugFolderPath}/metadata.json`, this.app.vault.adapter);
        await this.app.vault.adapter.write(
          `${run.debugFolderPath}/metadata.json`,
          JSON.stringify(metadata, null, 2)
        );
        debugLog(`Snipd plugin: saved debug metadata to ${run.debugFolderPath}/metadata.json`);
      }

      this.settings.current_export_updated_after = this.settings.latestSyncedSnipUpdateTs || null;
      this.settings.current_export_batch_index = 0;
      this.settings.current_export_total_batches = metadata.episode_batch_count;
      await this.saveSettings();
      
      if (this.settingsTab) {
        this.settingsTab.refresh();
      }

      debugLog(`Snipd plugin: fetched metadata with ${metadata.episode_batch_count} batches`);
      
      if (metadata.episode_batch_count > 0 || !this.settings.baseFileDefaultOpenPath) {
        if (metadata.episode_batch_count > 0) {
          this.setStatusBarPersistentMessage(`Syncing ${metadata.episode_batch_count} batch${metadata.episode_batch_count > 1 ? 'es' : ''}...`);
        }
        await this.fetchAndSaveBaseFile(this.settings.snipdDir);
      }
      
      return metadata;
    } else {
      debugLog("Snipd plugin: bad response in syncSnipd: ", response);
      const errorMsg = this.formatApiErrorMessage(null, response, "Sync");
      await this.handleSyncError(errorMsg);
      return null;
    }
  }

  private async fetchOrLoadMetadata(run: SyncRun): Promise<FetchExportMetadataResponse | null> {
    if (!this.settings.current_export_updated_after) {
      return await this.fetchMetadataFromApi(run);
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

  private buildExportRequestBody(
    episodeIds: string[],
    options: { updatedAfter: string | null; includeTranscript: boolean; transcriptOnly?: boolean },
  ): ExportRequestBody {
    const requestBody: ExportRequestBody = {
      episode_ids: episodeIds,
      episode_template: this.settings.episodeTemplate ?? DEFAULT_EPISODE_TEMPLATE,
      snip_template: this.settings.snipTemplate ?? DEFAULT_SNIP_TEMPLATE,
    };

    const additionalProps = this.settings.additionalProperties;
    if (isValidAdditionalProperties(additionalProps)) {
      requestBody.additional_properties = additionalProps.map((prop) => ({
        name: prop.name.trim(),
        template: prop.template.trim(),
        ...(prop.displayName?.trim() ? { displayName: prop.displayName.trim() } : {}),
      }));
    }

    if (options.updatedAfter) {
      requestBody.updated_after = options.updatedAfter;
    }

    if (this.settings.onlyEditedSnips) {
      requestBody.only_edited_snips = true;
    }

    if (options.includeTranscript) {
      requestBody.include_transcript = true;
    }

    // Backends without this flag ignore it and return the snips too, which the merge handles.
    if (options.transcriptOnly) {
      requestBody.transcript_only = true;
    }

    return requestBody;
  }

  /**
   * Returns null after reporting the failure through handleSyncError, or silently when the run was
   * stopped meanwhile: a response that arrives after Stop must neither be written nor reported,
   * since the error handling would also reset a sync started after the stop.
   */
  private async requestExportZip(
    requestBody: ExportRequestBody,
    context: string,
    run: SyncRun,
    debugFileName: string,
  ): Promise<Blob | null> {
    let response;
    try {
      response = await requestUrl({
        url: `${API_BASE_URL}/obsidian/export-episode-snips`,
        method: 'POST',
        headers: {
          'Authorization': this.formatAuthorizationToken(this.settings.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (e) {
      if (run.signal.aborted) {
        return null;
      }
      debugLog(`Snipd plugin: request failed (${context}): `, e);
      const errorResponse = this.extractResponseFromError(e);
      await this.handleSyncError(this.formatApiErrorMessage(e, errorResponse, context));
      return null;
    }

    if (run.signal.aborted) {
      return null;
    }

    if (!response || response.status < 200 || response.status >= 300) {
      debugLog(`Snipd plugin: bad response (${context}): `, response);
      await this.handleSyncError(this.formatApiErrorMessage(null, response, context));
      return null;
    }

    const blob = new Blob([response.arrayBuffer]);
    if (run.debugFolderPath) {
      const debugFilePath = `${run.debugFolderPath}/${debugFileName}`;
      await createDirForFile(debugFilePath, this.app.vault.adapter);
      await this.app.vault.adapter.writeBinary(debugFilePath, await blob.arrayBuffer());
      debugLog(`Snipd plugin: saved debug export to ${debugFilePath}`);
    }
    return blob;
  }

  private async checkTranscriptEligibility(episodeIds: string[]): Promise<CheckTranscriptEligibilityResponse | null> {
    if (episodeIds.length === 0) {
      return { episodes: {} };
    }
    try {
      const response = await requestUrl({
        url: `${API_BASE_URL}/obsidian/check-transcript-eligibility`,
        method: 'POST',
        headers: {
          'Authorization': this.formatAuthorizationToken(this.settings.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ episode_ids: episodeIds }),
      });
      if (response.status < 200 || response.status >= 300) {
        debugLog('Snipd plugin: check-transcript-eligibility bad response:', response);
        return null;
      }
      return response.json as CheckTranscriptEligibilityResponse;
    } catch (e) {
      debugLog('Snipd plugin: check-transcript-eligibility request failed:', e);
      return null;
    }
  }

  /**
   * Transcripts are synced after the snip batches, not inside them, so a snip batch never
   * carries hundreds of full transcripts. The pending list holds every snipped episode whose
   * transcript is not known to be current; the eligibility check says which of those have a
   * newer transcript the user may export, and only those are exported, in small batches.
   * `force` ignores the re-check throttle. Returns the number of transcripts written, or null
   * when the sync failed or was stopped.
   */
  private async syncPendingTranscripts(force: boolean, run: SyncRun): Promise<number | null> {
    if (!this.settings.syncTranscripts) {
      return 0;
    }
    const pending = this.settings.pendingTranscriptEpisodeIds ?? [];
    if (pending.length === 0) {
      return 0;
    }

    const checkedTs = this.settings.transcriptEligibilityCheckedTs ?? {};
    const now = Date.now();
    const lastChecked = (id: string) => (checkedTs[id] ? new Date(checkedTs[id]).getTime() : 0);
    const toCheck = pending
      .filter(id => force || now - lastChecked(id) >= TRANSCRIPT_ELIGIBILITY_RECHECK_MS)
      .sort((a, b) => lastChecked(a) - lastChecked(b));
    if (toCheck.length === 0) {
      debugLog(`Snipd plugin: ${pending.length} pending transcripts, none due for re-check`);
      return 0;
    }

    debugLog(`Snipd plugin: checking transcript eligibility for ${toCheck.length} of ${pending.length} pending episodes`);
    this.setTranscriptSyncProgress({ phase: 'checking', episodeCount: toCheck.length });
    this.setStatusBarPersistentMessage(`Checking transcripts for ${toCheck.length} episodes...`);
    const results: CheckTranscriptEligibilityResponse['episodes'] = {};
    for (let i = 0; i < toCheck.length; i += TRANSCRIPT_ELIGIBILITY_MAX_IDS) {
      const result = await this.checkTranscriptEligibility(toCheck.slice(i, i + TRANSCRIPT_ELIGIBILITY_MAX_IDS));
      if (run.signal.aborted) {
        return null;
      }
      if (!result) {
        debugLog('Snipd plugin: transcript eligibility check failed, retrying next sync');
        return 0;
      }
      Object.assign(results, result.episodes);
    }

    const syncedTs = this.settings.episodeTranscriptsSyncedTs ?? {};
    const pendingSet = new Set(pending);
    const toExport: string[] = [];
    const nowIso = new Date(now).toISOString();
    for (const episodeId of toCheck) {
      const entry = results[episodeId];
      if (!entry) {
        continue;
      }
      const ts = entry.transcript_update_ts;
      if (ts) {
        const localTs = syncedTs[episodeId];
        if (localTs && new Date(ts) <= new Date(localTs)) {
          pendingSet.delete(episodeId);
          delete checkedTs[episodeId];
        } else {
          // Left unstamped and pending: a failed export is retried on the next sync.
          toExport.push(episodeId);
        }
        continue;
      }
      // The callout ("premium only" / "not listened") goes only into notes that have no section
      // yet; `no_transcript` ids get nothing but stay pending for when the episode is processed.
      if (this.transcriptSectionNeeded.has(episodeId) && (entry.status === 'not_premium' || entry.status === 'not_listened')) {
        toExport.push(episodeId);
      }
      checkedTs[episodeId] = nowIso;
    }
    // Stamps of ids that left the pending list would otherwise accumulate forever.
    for (const episodeId of Object.keys(checkedTs)) {
      if (!pendingSet.has(episodeId)) {
        delete checkedTs[episodeId];
      }
    }
    this.settings.pendingTranscriptEpisodeIds = Array.from(pendingSet);
    this.settings.transcriptEligibilityCheckedTs = checkedTs;
    await this.saveSettings();

    if (toExport.length === 0) {
      debugLog('Snipd plugin: no pending transcripts to export');
      return 0;
    }

    const batchCount = Math.ceil(toExport.length / TRANSCRIPT_EXPORT_BATCH_SIZE);
    debugLog(`Snipd plugin: exporting transcripts for ${toExport.length} episodes in ${batchCount} batches`);
    // Snips changed since the last sync were already written by the snip batches; asking only
    // for snips after the newest one seen keeps the export from appending them a second time.
    const updatedAfter = this.settings.latestSyncedSnipUpdateTs ?? this.settings.last_updated_after;
    let transcriptCount = 0;
    for (let i = 0; i < batchCount; i++) {
      if (run.signal.aborted) {
        return null;
      }
      const episodeIds = toExport.slice(i * TRANSCRIPT_EXPORT_BATCH_SIZE, (i + 1) * TRANSCRIPT_EXPORT_BATCH_SIZE);
      this.setTranscriptSyncProgress({ phase: 'exporting', batchIndex: i, totalBatches: batchCount, episodeCount: episodeIds.length });
      this.setStatusBarPersistentMessage(`Syncing transcripts batch ${i + 1}/${batchCount} (${episodeIds.length} episodes)...`);
      const blob = await this.requestExportZip(
        this.buildExportRequestBody(episodeIds, { updatedAfter, includeTranscript: true, transcriptOnly: true }),
        `Transcript sync at batch ${i + 1}`,
        run,
        `transcripts_${i}_${Date.now()}.zip`,
      );
      if (!blob) {
        return null;
      }
      transcriptCount += (await this.processZipExport(blob)).transcriptCount;
    }
    return transcriptCount;
  }

  private setTranscriptSyncProgress(progress: TranscriptSyncProgress): void {
    this.transcriptSyncProgress = progress;
    if (this.settingsTab) {
      this.settingsTab.refresh();
    }
  }

  private async processSingleBatch(
    batchIndex: number,
    batch: { episodes: EpisodeSnipMetadata[] },
    totalBatches: number,
    run: SyncRun,
  ): Promise<SyncStats | null> {
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

    const stats: SyncStats = { episodeCount: 0, snipCount: 0, transcriptCount: 0 };
    const requests = this.splitBatchRequests(episodeIds);
    for (let i = 0; i < requests.length; i++) {
      if (run.signal.aborted) {
        return null;
      }
      const request = requests[i];
      if (requests.length > 1) {
        this.setStatusBarPersistentMessage(`Syncing batch ${batchIndex + 1}/${totalBatches}, part ${i + 1}/${requests.length} (${request.episodeIds.length} episodes${request.includeTranscript ? ', with transcripts' : ''})...`);
      }
      const blob = await this.requestExportZip(
        this.buildExportRequestBody(request.episodeIds, { updatedAfter: this.settings.last_updated_after, includeTranscript: request.includeTranscript }),
        `Sync at batch ${batchIndex + 1}`,
        run,
        `batch_${batchIndex}_${i}_${Date.now()}.zip`,
      );
      if (!blob) {
        return null;
      }
      const partStats = await this.processZipExport(blob);
      stats.episodeCount += partStats.episodeCount;
      stats.snipCount += partStats.snipCount;
      stats.transcriptCount += partStats.transcriptCount;
    }

    this.settings.current_export_batch_index = batchIndex + 1;
    await this.saveSettings();

    if (this.settingsTab) {
      this.settingsTab.refresh();
    }

    return stats;
  }

  /**
   * Episodes the plugin has never written get their transcript in the same zip as their snips,
   * so a new note is written once; those requests are kept small because each carries full
   * transcripts. Episodes with an existing note get snips only, and the transcript phase
   * afterwards handles the transcript separately.
   */
  private splitBatchRequests(episodeIds: string[]): Array<{ episodeIds: string[]; includeTranscript: boolean }> {
    if (!this.settings.syncTranscripts) {
      return [{ episodeIds, includeTranscript: false }];
    }
    const synced = this.settings.episodeTranscriptsSyncedTs ?? {};
    const pending = new Set(this.settings.pendingTranscriptEpisodeIds ?? []);
    const known = episodeIds.filter(id => synced[id] !== undefined || pending.has(id));
    const unseen = episodeIds.filter(id => synced[id] === undefined && !pending.has(id));
    const requests: Array<{ episodeIds: string[]; includeTranscript: boolean }> = [];
    if (known.length > 0) {
      requests.push({ episodeIds: known, includeTranscript: false });
    }
    for (let i = 0; i < unseen.length; i += TRANSCRIPT_EXPORT_BATCH_SIZE) {
      requests.push({ episodeIds: unseen.slice(i, i + TRANSCRIPT_EXPORT_BATCH_SIZE), includeTranscript: true });
    }
    return requests;
  }

  private async processAllBatches(
    metadata: FetchExportMetadataResponse,
    run: SyncRun,
  ): Promise<SyncStats | null> {
    const totals: SyncStats = { episodeCount: 0, snipCount: 0, transcriptCount: 0 };

    try {
      for (let i = this.settings.current_export_batch_index; i < metadata.episode_batch_count; i++) {
        if (run.signal.aborted) {
          return null;
        }
        const batch = metadata.episode_batches[i];
        const stats = await this.processSingleBatch(i, batch, metadata.episode_batch_count, run);
        
        if (!stats) {
          return null;
        }

        totals.episodeCount += stats.episodeCount;
        totals.snipCount += stats.snipCount;
        totals.transcriptCount += stats.transcriptCount;
      }

      return totals;
    } catch (e) {
      debugLog("Snipd plugin: error processing batches: ", e);
      const errorMsg = "Sync failed: error processing data." + (isDev() ? ` Detail: ${e}` : "");
      await this.handleSyncError(errorMsg);
      return null;
    }
  }

  private async finalizeSync(stats: SyncStats): Promise<void> {
    this.settings.last_updated_after = this.settings.latestSyncedSnipUpdateTs || null;
    this.settings.current_export_updated_after = null;
    this.settings.current_export_batch_index = 0;
    this.settings.current_export_total_batches = 0;
    this.settings.current_batch_episode_count = 0;
    this.settings.current_batch_snip_count = 0;
    this.settings.lastSyncTimestamp = new Date().toISOString();
    this.settings.lastSyncEpisodeCount = stats.episodeCount;
    this.settings.lastSyncSnipCount = stats.snipCount;
    this.settings.lastSyncTranscriptCount = stats.transcriptCount;
    this.settings.hasCompletedFirstSync = true;
    await this.deleteMetadataFile();
    await this.saveSettings();

    await this.clearSettingsAfterRun();
    
    const summary = formatSyncCounts(stats.episodeCount, stats.snipCount, stats.transcriptCount);
    if (!summary) {
      debugLog('Snipd plugin: sync completed (no new data)');
      this.notice("No new data to sync", true, 2, true);
      this.setStatusBarPersistentMessage("Snipd sync completed (no new data)");
    } else {
      debugLog(`Snipd plugin: sync completed (${summary})`);
      this.setStatusBarPersistentMessage(`Snipd sync completed (${summary})`);
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
      this.settingsTab.refresh();
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
          'Authorization': this.formatAuthorizationToken(this.settings.apiKey),
        },
      });
      debugLog(`Snipd plugin: test metadata response status: ${response.status}`);
    } catch (e) {
      debugLog("Snipd plugin: request failed in testSyncRandomEpisodes: ", e);
      const errorResponse = this.extractResponseFromError(e);
      const errorMsg = this.formatApiErrorMessage(e, errorResponse, "Test sync");
      this.settings.isTestSyncing = false;
      await this.saveSettings();
      if (this.settingsTab) {
        this.settingsTab.refresh();
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
          this.settingsTab.refresh();
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
        const exportRequestBody = this.buildExportRequestBody(episodeIds, {
          updatedAfter: null,
          includeTranscript: this.settings.syncTranscripts,
        });

        exportResponse = await requestUrl({
          url: `${API_BASE_URL}/obsidian/export-episode-snips`,
          method: 'POST',
          headers: {
            'Authorization': this.formatAuthorizationToken(this.settings.apiKey),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(exportRequestBody),
        });
      } catch (e) {
        debugLog("Snipd plugin: export request failed: ", e);
        const errorResponse = this.extractResponseFromError(e);
        const errorMsg = this.formatApiErrorMessage(e, errorResponse, "Test sync");
        this.settings.isTestSyncing = false;
        await this.saveSettings();
        if (this.settingsTab) {
          this.settingsTab.refresh();
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

        const stats = await this.processZipExport(blob, { trackTranscriptState: false });
        
        
        debugLog(`Snipd plugin: test sync requested ${episodeIds.length} episodes, received ${stats.episodeCount} episodes`);
        if (stats.episodeCount < episodeIds.length) {
          debugLog(`Snipd plugin: ${episodeIds.length - stats.episodeCount} episode(s) were skipped by the backend. This usually means the episode or show data is missing, or the episode has no snips for this user.`);
        }
        
        this.settings.snipdDir = originalSnipdDir;
        this.settings.isTestSyncing = false;
        await this.saveSettings();
        
        if (this.settingsTab) {
          this.settingsTab.refresh();
        }
        
        this.setStatusBarPersistentMessage(`Test sync completed (${formatSyncCounts(stats.episodeCount, stats.snipCount, stats.transcriptCount) || 'no data'})`);
        this.clearStatusBarPersistentMessageAfterDelay(3000);
      } else {
        debugLog("Snipd plugin: bad response for test export: ", exportResponse);
        const errorMsg = this.formatApiErrorMessage(null, exportResponse, "Test sync");
        this.settings.isTestSyncing = false;
        await this.saveSettings();
        if (this.settingsTab) {
          this.settingsTab.refresh();
        }
        this.notice(errorMsg, true, 4, true);
        this.clearStatusBarPersistentMessage();
      }
    } else {
      debugLog("Snipd plugin: bad response in testSyncRandomEpisodes: ", response);
      const errorMsg = this.formatApiErrorMessage(null, response, "Test sync");
      this.settings.isTestSyncing = false;
      await this.saveSettings();
      if (this.settingsTab) {
        this.settingsTab.refresh();
      }
      this.notice(errorMsg, true, 4, true);
      this.clearStatusBarPersistentMessage();
    }
  }

  /** Test syncs write outside the real folder, so they must not record transcript sync state. */
  async processZipExport(
    blob: Blob,
    options: { trackTranscriptState?: boolean } = {},
  ): Promise<SyncStats> {
    const trackTranscriptState = options.trackTranscriptState !== false;
    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();

    let metadata: MetadataJson | null = null;
    const episodeFiles: Map<string, { full: string; append?: string; transcriptBlock?: string }> = new Map();

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
      } else if (zipEntry.filename.startsWith('transcripts/')) {
        const filename = zipEntry.filename.replace('transcripts/', '');
        const match = filename.match(/^(.+?)_transcript_block\.md$/);
        if (match) {
          const [, id] = match;
          if (!episodeFiles.has(id)) {
            episodeFiles.set(id, { full: '' });
          }
          episodeFiles.get(id)!.transcriptBlock = fileContent;
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

    if (metadata) {
      let withTranscriptTs = 0;
      let withTranscriptBlockFile = 0;
      let withoutTranscriptTs = 0;
      for (const epId of Object.keys(episodesData)) {
        const epData = episodesData[epId];
        if (epData?.transcript_update_ts) {
          withTranscriptTs++;
        } else {
          withoutTranscriptTs++;
        }
        if (epData?.has_transcript_block_file) {
          withTranscriptBlockFile++;
        }
      }
      debugLog(`Snipd plugin: zip metadata transcript stats - ${withTranscriptTs} episodes with transcript_update_ts, ${withoutTranscriptTs} without, ${withTranscriptBlockFile} with has_transcript_block_file flag`);
    }

    let episodeCount = 0;
    let snipCount = 0;
    let settingsDirty = false;
    let transcriptsWrittenCount = 0;
    let transcriptBlocksReceivedCount = 0;

    if (!this.settings.pendingTranscriptEpisodeIds) {
      this.settings.pendingTranscriptEpisodeIds = [];
    }
    const pendingSet = new Set<string>(this.settings.pendingTranscriptEpisodeIds);
    const pendingBefore = pendingSet.size;

    for (const [episodeId, fileData] of episodeFiles) {
      const episodeData = episodesData[episodeId];
      if (!episodeData) {
        debugLog(`Snipd plugin: No metadata found for episode ${episodeId}`);
      }

      const hasTranscriptBlock = !!fileData.transcriptBlock;
      if (hasTranscriptBlock) {
        transcriptBlocksReceivedCount++;
      }

      const episodeName = generateEpisodeFileName(episodeData, episodeId, this.settings);
      const showId = episodeData?.show_id;
      const showName = showId && showsData[showId] ? showsData[showId].name : 'Unknown Show';

      // Callouts ("premium only", "not listened") arrive under the same transcripts/ file
      // name as real transcripts; only has_transcript_block_file tells them apart.
      const isFullTranscript = episodeData?.has_transcript_block_file === true;
      const transcriptWriteResult = await this.syncFile(
        fileData.full,
        fileData.append,
        sanitizeFileName(episodeName),
        sanitizeFileName(showName),
        episodeData?.total_snip_count,
        isFullTranscript ? fileData.transcriptBlock : undefined,
        isFullTranscript ? undefined : fileData.transcriptBlock,
      );

      if (transcriptWriteResult.transcriptWritten) {
        transcriptsWrittenCount++;
      }

      const epTranscriptTs = episodeData?.transcript_update_ts ?? null;
      if (!trackTranscriptState) {
        // Test sync: the transcript went to the -TEST folder, the real note still needs it.
      } else if (transcriptWriteResult.transcriptWritten && epTranscriptTs) {
        if (!this.settings.episodeTranscriptsSyncedTs) {
          this.settings.episodeTranscriptsSyncedTs = {};
        }
        this.settings.episodeTranscriptsSyncedTs[episodeId] = epTranscriptTs;
        settingsDirty = true;
        if (pendingSet.delete(episodeId)) {
          settingsDirty = true;
        }
        if (this.settings.transcriptEligibilityCheckedTs?.[episodeId]) {
          delete this.settings.transcriptEligibilityCheckedTs[episodeId];
        }
      } else if (this.settings.syncTranscripts && (episodeData?.updated_snip_count ?? 0) > 0) {
        if (!pendingSet.has(episodeId)) {
          pendingSet.add(episodeId);
          settingsDirty = true;
        }
        if (!transcriptWriteResult.hasTranscriptSection) {
          // The note is new or was recreated: forget what was synced for it so the transcript
          // phase fetches the transcript or callout again.
          this.transcriptSectionNeeded.add(episodeId);
          if (this.settings.episodeTranscriptsSyncedTs?.[episodeId]) {
            delete this.settings.episodeTranscriptsSyncedTs[episodeId];
            settingsDirty = true;
          }
          if (this.settings.transcriptEligibilityCheckedTs?.[episodeId]) {
            delete this.settings.transcriptEligibilityCheckedTs[episodeId];
            settingsDirty = true;
          }
        }
      }

      if (episodeData?.updated_snip_count) {
        snipCount += episodeData.updated_snip_count;
        episodeCount++;
      }
    }

    if (pendingSet.size !== pendingBefore) {
      this.settings.pendingTranscriptEpisodeIds = Array.from(pendingSet);
      debugLog(`Snipd plugin: pending transcript list changed ${pendingBefore} -> ${pendingSet.size}`);
    }

    debugLog(`Snipd plugin: batch processed - ${episodeFiles.size} episodes in zip, ${episodeCount} with updated snips, ${snipCount} snips, ${transcriptBlocksReceivedCount} transcript blocks received, ${transcriptsWrittenCount} transcripts written`);

    if (settingsDirty) {
      await this.saveSettings();
    }

    return { episodeCount, snipCount, transcriptCount: transcriptsWrittenCount };
  }

  private spliceBeforeTranscriptHeader(existingContent: string, newSnipsBlock: string): string {
    const idx = this.findTranscriptHeaderIndex(existingContent);
    if (idx < 0) {
      return existingContent.trimEnd() + '\n' + newSnipsBlock;
    }
    return existingContent.slice(0, idx) + newSnipsBlock + (newSnipsBlock.endsWith('\n') ? '' : '\n') + existingContent.slice(idx);
  }

  /** Replaces everything from the transcript header to EOF; the Snipd footer stays the last line. */
  private replaceTranscriptSection(existingContent: string, newBlock: string): string {
    const existingWithoutFooter = this.extractSnipdFooter(existingContent);
    const newBlockWithoutFooter = this.extractSnipdFooter(newBlock);
    const footer = existingWithoutFooter.footer ?? newBlockWithoutFooter.footer;
    const idx = this.findTranscriptHeaderIndex(existingWithoutFooter.body);
    const beforeTranscript = idx < 0 ? existingWithoutFooter.body : existingWithoutFooter.body.slice(0, idx);
    const beforeStripped = this.stripTrailingDividers(beforeTranscript);
    const newBlockStripped = this.stripTrailingDividers(newBlockWithoutFooter.body);
    let result = beforeStripped + '\n\n---\n\n' + newBlockStripped;
    if (footer) {
      result += '\n\n---\n\n' + footer;
    }
    return result + '\n';
  }

  /**
   * A full rewrite from the server carries no transcript section when the transcript was
   * already synced, or only a callout when the user lost access (premium lapsed);
   * keep the transcript in the existing file instead of silently dropping it.
   */
  private preserveExistingTranscript(newContent: string, existingContent: string): string {
    const existingIdx = this.findTranscriptHeaderIndex(existingContent);
    if (existingIdx < 0) {
      return newContent;
    }
    const existingTranscriptSection = existingContent.slice(existingIdx);
    if (this.isTranscriptCallout(existingTranscriptSection)) {
      return newContent;
    }
    const newIdx = this.findTranscriptHeaderIndex(newContent);
    if (newIdx >= 0 && !this.isTranscriptCallout(newContent.slice(newIdx))) {
      return newContent;
    }
    debugLog('Snipd plugin: preserving existing transcript section during full rewrite');
    return this.replaceTranscriptSection(newContent, existingTranscriptSection);
  }

  /** Returns null when the file holds a real transcript, which a callout must never replace. */
  private applyTranscriptCallout(content: string, callout: string): string | null {
    const idx = this.findTranscriptHeaderIndex(content);
    if (idx >= 0 && !this.isTranscriptCallout(content.slice(idx))) {
      return null;
    }
    return this.replaceTranscriptSection(content, callout);
  }

  /**
   * The backend renders "premium only" / "not listened" placeholders as the transcript header
   * followed by a single blockquote; transcript lines never start with `>`.
   */
  private isTranscriptCallout(transcriptSection: string): boolean {
    const body = this.stripTrailingDividers(this.extractSnipdFooter(transcriptSection).body);
    const lines = body.split('\n').slice(1).map(line => line.trim()).filter(line => line !== '');
    return lines.length > 0 && lines.every(line => line.startsWith('>'));
  }

  private findTranscriptHeaderIndex(content: string): number {
    // Whole-line match only: the header text can also occur inside snip content.
    const lines = content.split('\n');
    let offset = 0;
    for (const line of lines) {
      if (line.trim() === TRANSCRIPT_HEADER) {
        return offset;
      }
      offset += line.length + 1;
    }
    return -1;
  }

  private extractSnipdFooter(content: string): { body: string; footer: string | null } {
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === SNIPD_FOOTER) {
        lines.splice(i, 1);
        return { body: lines.join('\n'), footer: SNIPD_FOOTER };
      }
    }
    return { body: content, footer: null };
  }

  private stripTrailingDividers(content: string): string {
    const lines = content.replace(/\s+$/, '').split('\n');
    let i = lines.length - 1;
    while (i >= 0) {
      const trimmed = lines[i].trim();
      if (trimmed === '' || trimmed === '---') {
        i--;
      } else {
        break;
      }
    }
    return lines.slice(0, i + 1).join('\n');
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
    totalSnipCount?: number,
    transcriptBlock?: string,
    transcriptCallout?: string,
  ): Promise<{ transcriptWritten: boolean; hasTranscriptSection: boolean }> {
    const targetPath = normalizePath(`${this.settings.snipdDir}/Data/${showName}/${entityName}.md`);

    await createDirForFile(targetPath, this.fs);

    let contentToWrite: string;
    let transcriptWritten = false;
    const isAppendOnlyFile = this.settings.appendOnlyFiles[targetPath];
    const targetExists = await this.fs.exists(targetPath);

    if (targetExists) {
      const existingContent = await this.fs.read(targetPath);
      const existingHash = Md5.hashStr(existingContent).toString();
      const storedHash = this.settings.fileHashMap[targetPath];

      if (fullContent && existingHash === storedHash && !isAppendOnlyFile) {
        contentToWrite = transcriptBlock ? fullContent : this.preserveExistingTranscript(fullContent, existingContent);
        transcriptWritten = !!transcriptBlock;
        debugLog(`Snipd plugin: syncFile full-rewrite path for ${entityName} (hasTranscriptBlock=${!!transcriptBlock})`);
      } else if (appendContent) {
        if (!isAppendOnlyFile) {
          this.settings.appendOnlyFiles[targetPath] = true;
        }
        const merged = this.spliceBeforeTranscriptHeader(existingContent, appendContent);
        contentToWrite = totalSnipCount !== undefined
          ? this.updateSnipsCountInFrontmatter(merged, totalSnipCount)
          : merged;

        if (transcriptBlock) {
          contentToWrite = this.replaceTranscriptSection(contentToWrite, transcriptBlock);
          transcriptWritten = true;
        } else if (transcriptCallout) {
          contentToWrite = this.applyTranscriptCallout(contentToWrite, transcriptCallout) ?? contentToWrite;
        }
        debugLog(`Snipd plugin: syncFile append path for ${entityName} (hasTranscriptBlock=${!!transcriptBlock})`);
      } else if (transcriptBlock) {
        contentToWrite = this.replaceTranscriptSection(existingContent, transcriptBlock);
        transcriptWritten = true;
        debugLog(`Snipd plugin: syncFile transcript-only path for ${entityName}`);
      } else if (transcriptCallout) {
        const withCallout = this.applyTranscriptCallout(existingContent, transcriptCallout);
        if (withCallout === null) {
          debugLog(`Snipd plugin: syncFile keeping existing transcript over callout for ${entityName}`);
          return { transcriptWritten: false, hasTranscriptSection: true };
        }
        contentToWrite = withCallout;
        debugLog(`Snipd plugin: syncFile callout-only path for ${entityName}`);
      } else if (fullContent) {
        contentToWrite = this.preserveExistingTranscript(fullContent, existingContent);
        debugLog(`Snipd plugin: syncFile full-rewrite fallback for ${entityName} (hashMismatch=${existingHash !== storedHash}, isAppendOnly=${!!isAppendOnlyFile})`);
      } else {
        debugLog(`Snipd plugin: syncFile nothing to write for ${entityName}`);
        return { transcriptWritten: false, hasTranscriptSection: this.findTranscriptHeaderIndex(existingContent) >= 0 };
      }
    } else if (fullContent) {
      contentToWrite = fullContent;
      transcriptWritten = !!transcriptBlock;
      debugLog(`Snipd plugin: syncFile new-file path for ${entityName} (hasTranscriptBlock=${!!transcriptBlock})`);
    } else {
      // A transcript block alone has no note to attach to.
      if (transcriptBlock || transcriptCallout) {
        debugLog(`Snipd plugin: skipping transcript-only write for missing target ${targetPath}`);
      }
      return { transcriptWritten: false, hasTranscriptSection: false };
    }

    await this.fs.write(targetPath, contentToWrite);

    const newHash = Md5.hashStr(contentToWrite).toString();
    this.settings.fileHashMap[targetPath] = newHash;
    await this.saveSettings();

    return { transcriptWritten, hasTranscriptSection: this.findTranscriptHeaderIndex(contentToWrite) >= 0 };
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
      
      const requestOptions: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      } = {
        url: `${API_BASE_URL}/obsidian/export-base-file`,
        method: 'POST',
        headers: {
          'Authorization': this.formatAuthorizationToken(this.settings.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      };

      const additionalProps = this.settings.additionalProperties;
      if (isValidAdditionalProperties(additionalProps)) {
        requestOptions.body = JSON.stringify({
          additional_properties: additionalProps.map((prop) => ({
            name: prop.name.trim(),
            template: prop.template.trim(),
            ...(prop.displayName?.trim() ? { displayName: prop.displayName.trim() } : {}),
          })),
        });
      }

      const response = await requestUrl(requestOptions);

      if (response.status < 200 || response.status >= 300) {
        debugLog("Snipd plugin: bad response for base file: ", response);
        const errorMsg = this.formatApiErrorMessage(null, response, "Base file sync");
        debugLog(`Snipd plugin: ${errorMsg}`);
        return;
      }

      const arrayBuffer = response.arrayBuffer;
      const blob = new Blob([arrayBuffer]);
      const blobReader = new zip.BlobReader(blob);
      zipReader = new zip.ZipReader(blobReader);
      const entries = await zipReader.getEntries();

      for (const entry of entries) {
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
      const errorResponse = this.extractResponseFromError(e);
      const errorMsg = this.formatApiErrorMessage(e, errorResponse, "Base file sync");
      debugLog(`Snipd plugin: ${errorMsg}`);
      this.notice(errorMsg, true, 4, false);
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
      debugLog(`Snipd plugin: base file sync completed - ${updatedFileCount} files updated, ${removedFileCount} removed`);
    } else {
      debugLog('Snipd plugin: base file sync completed but no files were updated');
    }
  }

  async fetchAndSaveBaseFileForTest(folderPath: string): Promise<void> {
    let zipReader: zip.ZipReader<zip.BlobReader> | null = null;
    try {
      debugLog('Snipd plugin: fetching base file for test sync...');
      
      const requestOptions: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      } = {
        url: `${API_BASE_URL}/obsidian/export-base-file`,
        method: 'POST',
        headers: {
          'Authorization': this.formatAuthorizationToken(this.settings.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      };

      const additionalProps = this.settings.additionalProperties;
      if (isValidAdditionalProperties(additionalProps)) {
        requestOptions.body = JSON.stringify({
          additional_properties: additionalProps.map((prop) => ({
            name: prop.name.trim(),
            template: prop.template.trim(),
            ...(prop.displayName?.trim() ? { displayName: prop.displayName.trim() } : {}),
          })),
        });
      }

      const response = await requestUrl(requestOptions);

      if (response.status < 200 || response.status >= 300) {
        debugLog("Snipd plugin: bad response for base file in test sync: ", response);
        const errorMsg = this.formatApiErrorMessage(null, response, "Base file sync (test)");
        debugLog(`Snipd plugin: ${errorMsg}`);
        return;
      }

      const arrayBuffer = response.arrayBuffer;
      const blob = new Blob([arrayBuffer]);
      const blobReader = new zip.BlobReader(blob);
      zipReader = new zip.ZipReader(blobReader);
      const entries = await zipReader.getEntries();

      for (const entry of entries) {
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
      const errorResponse = this.extractResponseFromError(e);
      const errorMsg = this.formatApiErrorMessage(e, errorResponse, "Base file sync (test)");
      debugLog(`Snipd plugin: ${errorMsg}`);
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
      window.clearInterval(this.scheduleInterval);
      this.scheduleInterval = null;
    }
    if (!milliseconds) {
      return;
    }
    this.scheduleInterval = window.setInterval(() => {
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
    this.addRibbonIcon('snipd', 'Open Snipd base', () => {
      void this.openBaseFile();
    });

    await this.loadSettings();

    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar = new StatusBar(this.addStatusBarItem());
      this.registerInterval(
        window.setInterval(() => {
          this.statusBar.display();
        }, 1000)
      );
    }

    this.addCommand({
      id: 'snipd-sync',
      name: 'Sync now',
      callback: () => {
        void this.syncSnipd({ force: true });
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
    
    if (this.settings.encryptedApiKey) {
      try {
        this.settings.apiKey = await SecureStorage.decryptApiKey(
          this.settings.encryptedApiKey,
          this.getVaultIdentifier()
        );
        if (this.settings.apiKey) {
          this.encryptedApiKeySource = `${this.getVaultIdentifier()}\n${this.settings.apiKey}`;
        }
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
    const source = `${this.getVaultIdentifier()}\n${this.settings.apiKey}`;
    if (this.settings.apiKey && source !== this.encryptedApiKeySource) {
      try {
        this.settings.encryptedApiKey = await SecureStorage.encryptApiKey(
          this.settings.apiKey,
          this.getVaultIdentifier()
        );
        this.encryptedApiKeySource = source;
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