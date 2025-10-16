import { App, Notice, normalizePath, PluginSettingTab, Setting } from 'obsidian';
import type SnipdPlugin from './main';
import { FormattingConfigModal } from './formatting_modal';
import { DEFAULT_SETTINGS } from './types';
import { isDev } from './utils';
import { API_BASE_URL, AUTH_URL } from './main';

export class SnipdSettingModal extends PluginSettingTab {
  plugin: SnipdPlugin;
  refreshInterval: number | null = null;

  constructor(app: App, plugin: SnipdPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide() {
    if (this.refreshInterval !== null) {
      window.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.plugin.settingsTab = null;
  }

  generateUUIDv4(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async connectToSnipd(button: HTMLElement, container: HTMLElement, uuid?: string): Promise<void> {
    if (!uuid) {
      uuid = this.generateUUIDv4();
    }

    container.empty();
    container.style.display = 'none';
    window.open(`${AUTH_URL}?uuid=${uuid}`);

    let response, data: { token?: string };

    try {
      response = await fetch(
        `${API_BASE_URL}/obsidian/auth?uuid=${uuid}`
      );
    } catch (e) {
      console.log("Snipd plugin: fetch failed in connectToSnipd: ", e);
      button.textContent = 'Connect';
      button.removeAttribute('disabled');
      this.showInfoStatus(container, "Connection failed. Try again", "snipd-error");
      return;
    }

    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("Snipd plugin: bad response in connectToSnipd: ", response);
      button.textContent = 'Connect';
      button.removeAttribute('disabled');
      this.showInfoStatus(container, "Connection failed. Try again", "snipd-error");
      return;
    }

    if (data.token) {
      console.log("Snipd plugin: successfully authenticated with Snipd");
      this.plugin.settings.apiKey = data.token;
      await this.plugin.saveSettings();
      this.display();
      new Notice("Successfully connected to Snipd");
    } else {
      console.log("Snipd plugin: didn't get token data");
      button.textContent = 'Connect';
      button.removeAttribute('disabled');
      this.showInfoStatus(container, "Authorization failed. Please try again", "snipd-error");
    }
  }

  showInfoStatus(container: HTMLElement | null, message: string, cls: string): void {
    if (!container) {
      return;
    }
    container.empty();
    container.style.display = 'block';
    const statusEl = container.createDiv({ cls });
    statusEl.textContent = message;
    statusEl.style.color = 'var(--text-error, #e74c3c)';
    statusEl.style.fontSize = '0.9em';
  }

  display(): void {
    this.plugin.settingsTab = this;
    let { containerEl } = this;

    containerEl.empty();
    containerEl.createEl('h1', { text: 'Snipd Official' });
    containerEl.createEl('p', { text: 'Sync your Snipd content to Obsidian' });

    if (!this.plugin.settings.apiKey) {
      const authSection = containerEl.createDiv({ cls: 'snipd-auth-section' });
      authSection.style.backgroundColor = 'var(--background-secondary, rgba(0, 0, 0, 0.05))';
      authSection.style.padding = '1.5rem';
      authSection.style.borderRadius = '8px';
      authSection.style.marginTop = '1rem';
      const title = authSection.createEl('h3', { text: 'Connect Obsidian to Snipd' });
      title.style.marginTop = '0';
      
      const subtitleRow = authSection.createDiv();
      subtitleRow.style.display = 'flex';
      subtitleRow.style.alignItems = 'center';
      subtitleRow.style.justifyContent = 'space-between';
      subtitleRow.style.gap = '1rem';
      
      const subtitle = subtitleRow.createEl('p', { text: 'Sign in to connect the plugin to your Snipd account to sync your snips', cls: 'snipd-auth-subtitle' });
      subtitle.style.margin = '0';
      subtitle.style.flex = '1';
      
      const connectButton = subtitleRow.createEl('button', { 
        text: 'Connect',
        cls: 'mod-cta'
      });
      connectButton.style.flexShrink = '0';
      
      const errorContainer = authSection.createDiv({ cls: 'snipd-error-container' });
      errorContainer.style.display = 'none';
      errorContainer.style.marginTop = '0.75rem';
      
      connectButton.addEventListener('click', async () => {
        connectButton.textContent = 'Connecting...';
        connectButton.setAttribute('disabled', 'true');
        await this.connectToSnipd(connectButton, errorContainer);
      });
      return;
    }

    const syncStatusContainer = containerEl.createDiv({ cls: 'snipd-sync-status' });
    
    const syncStatusHeader = syncStatusContainer.createDiv({ cls: 'snipd-sync-status-header' });
    syncStatusHeader.createEl('div', { text: 'Sync Status', cls: 'snipd-sync-status-title' });
    
    if (this.plugin.settings.isSyncing) {
      const stopButton = syncStatusHeader.createEl('button', { 
        text: 'Stop syncing',
      });
      stopButton.addEventListener('click', async () => {
        await this.plugin.stopSync();
      });
    } else {
      const syncButtonText = this.plugin.settings.hasCompletedFirstSync ? 'Sync now' : 'Start syncing';
      const syncButton = syncStatusHeader.createEl('button', { 
        text: syncButtonText,
        cls: 'mod-cta'
      });
      syncButton.addEventListener('click', async () => {
        await this.plugin.syncSnipd();
      });
    }

    const syncStatusBody = syncStatusContainer.createDiv({ cls: 'snipd-sync-status-body' });

    if (this.plugin.settings.isSyncing) {
      if (this.plugin.settings.current_export_total_batches > 0) {
        const currentBatch = this.plugin.settings.current_export_batch_index;
        const totalBatches = this.plugin.settings.current_export_total_batches;
        const displayBatch = Math.min(currentBatch + 1, totalBatches);
        const remainingBatches = Math.max(totalBatches - currentBatch, 0);
        const progressPercent = totalBatches > 0 ? Math.round((currentBatch / totalBatches) * 100) : 0;
        
        const episodeCount = this.plugin.settings.current_batch_episode_count;
        const snipCount = this.plugin.settings.current_batch_snip_count;
        
        syncStatusBody.createEl('div', { 
          text: `Syncing: Batch ${displayBatch} of ${totalBatches} (${remainingBatches} remaining)`,
          cls: 'snipd-sync-status-text'
        });
        
        if (episodeCount > 0 || snipCount > 0) {
          syncStatusBody.createEl('div', { 
            text: `Current batch: ${episodeCount} episode${episodeCount !== 1 ? 's' : ''}, ${snipCount} snip${snipCount !== 1 ? 's' : ''}`,
            cls: 'snipd-sync-status-text'
          });
        }
        
        syncStatusBody.createEl('div', { 
          text: `Progress: ${progressPercent}%`,
          cls: 'snipd-sync-status-text'
        });
      } else {
        syncStatusBody.createEl('div', { 
          text: 'Preparing sync...',
          cls: 'snipd-sync-status-text'
        });
      }
    } else if (this.plugin.settings.lastSyncTimestamp) {
      const lastSyncDate = new Date(this.plugin.settings.lastSyncTimestamp);
      const formattedDate = lastSyncDate.toLocaleString();
      
      syncStatusBody.createEl('div', { 
        text: `Last sync: ${formattedDate}`,
        cls: 'snipd-sync-status-text'
      });
      
      if (this.plugin.settings.lastSyncEpisodeCount > 0 || this.plugin.settings.lastSyncSnipCount > 0) {
        syncStatusBody.createEl('div', { 
          text: `Last synced: ${this.plugin.settings.lastSyncEpisodeCount} episodes, ${this.plugin.settings.lastSyncSnipCount} snips`,
          cls: 'snipd-sync-status-text'
        });
      }
    } else {
      syncStatusBody.createEl('div', { 
        text: 'No sync performed yet',
        cls: 'snipd-sync-status-text'
      });
    }

    containerEl.createEl('h2', { text: 'Settings' });

    new Setting(containerEl)
      .setName('Base folder')
      .setDesc('Folder where Snipd content will be saved')
      .addText(text => text
        .setPlaceholder('Snipd')
        .setValue(this.plugin.settings.snipdDir)
        .onChange(async (value) => {
          this.plugin.settings.snipdDir = normalizePath(value || "Snipd");
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync frequency')
      .setDesc('Automatically sync at the specified interval')
      .addDropdown(dropdown => {
        dropdown.addOption("0", "Manual");
        if(isDev()) {
          dropdown.addOption("1", "Every 1 minute (DEV ONLY)");
        }
        dropdown.addOption("60", "Every 1 hour");
        dropdown.addOption((12 * 60).toString(), "Every 12 hours");
        dropdown.addOption((24 * 60).toString(), "Every 24 hours");
        dropdown.addOption((7 * 24 * 60).toString(), "Every week");

        dropdown.setValue(this.plugin.settings.frequency);

        dropdown.onChange(async (newValue) => {
          this.plugin.settings.frequency = newValue;
          await this.plugin.saveSettings();
          if (this.plugin.settings.hasCompletedFirstSync) {
            this.plugin.configureSchedule();
          }
        });
      });

    new Setting(containerEl)
      .setName("Sync on app launch")
      .setDesc("Automatically sync when Obsidian opens")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.triggerOnLoad);
        toggle.onChange(async (val) => {
          this.plugin.settings.triggerOnLoad = val;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Sync only edited snips")
      .setDesc("Only starred, edited or tagged snips will be synced")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.onlyEditedSnips);
        toggle.onChange(async (val) => {
          this.plugin.settings.onlyEditedSnips = val;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Custom formatting")
      .setDesc("Configure how episodes and snips are formatted")
      .addButton((button) => {
        button.setButtonText("Configure");
        button.onClick(() => {
          new FormattingConfigModal(this.app, this.plugin, () => {
            new Notice("Formatting settings saved");
          }).open();
        });
      });

    const testSyncDesc = this.plugin.settings.isTestSyncing 
      ? "Test sync in progress..." 
      : "Test the sync with 5 random episodes from your snips to validate your configuration. The result will be saved in the configured Base folder with a -TEST suffix.";
    
    new Setting(containerEl)
      .setName("Test sync 5 random episodes")
      .setDesc(testSyncDesc)
      .addButton((button) => {
        if (this.plugin.settings.isTestSyncing) {
          button.setButtonText("Syncing...");
          button.setDisabled(true);
        } else {
          button.setButtonText("Test sync");
          button.onClick(async () => {
            await this.plugin.testSyncRandomEpisodes();
          });
        }
      });

    if (this.refreshInterval !== null) {
      window.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    if (this.plugin.settings.isSyncing || this.plugin.settings.isTestSyncing) {
      this.refreshInterval = window.setInterval(() => {
        this.display();
      }, 1000);
    }

    if (isDev()) {
      containerEl.createEl('h2', { text: 'DEV options' });

      new Setting(containerEl)
        .setName('Save debug zips')
        .setDesc('Save all downloaded data (JSON and zip files) from each sync to snipd_plugin_debug/sync_{timestamp} folders for debugging purposes')
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.saveDebugZips);
          toggle.onChange(async (val) => {
            this.plugin.settings.saveDebugZips = val;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName('Reset settings state')
        .setDesc('Remove all existing settings state (basically revert to the initial state when the plugin is installed)')
        .addButton((button) => {
          button.setButtonText('Reset');
          button.buttonEl.style.backgroundColor = '#e74c3c';
          button.buttonEl.style.color = 'white';
          button.onClick(async () => {
            this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
            await this.plugin.saveSettings();
            this.display();
            new Notice('Settings have been reset to initial state');
          });
        });
    }
  }
}
