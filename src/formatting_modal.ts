import { App, Modal, Notice, Platform } from 'obsidian';
import type SnipdPlugin from './main';
import { DEFAULT_EPISODE_TEMPLATE, DEFAULT_SNIP_TEMPLATE, DEFAULT_EPISODE_FILE_NAME_TEMPLATE } from './types';

export class FormattingConfigModal extends Modal {
  plugin: SnipdPlugin;
  onSave: () => void;
  tempEpisodeTemplate: string;
  tempSnipTemplate: string;
  tempEpisodeFileNameTemplate: string;

  constructor(app: App, plugin: SnipdPlugin, onSave: () => void) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave;
    this.tempEpisodeTemplate = plugin.settings.episodeTemplate ?? DEFAULT_EPISODE_TEMPLATE;
    this.tempSnipTemplate = plugin.settings.snipTemplate ?? DEFAULT_SNIP_TEMPLATE;
    this.tempEpisodeFileNameTemplate = plugin.settings.episodeFileNameTemplate ?? DEFAULT_EPISODE_FILE_NAME_TEMPLATE;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    const scrollableContent = contentEl.createDiv({ cls: 'snipd-modal-scrollable' });
    
    scrollableContent.createEl('h2', { text: 'Custom formatting' });
    scrollableContent.createEl('p', { 
      text: 'Configure how your episodes and snips are formatted in Obsidian.',
      cls: 'setting-item-description'
    });
    
    const syntaxDesc = scrollableContent.createDiv({ cls: 'setting-item-description snipd-syntax-description' });
    syntaxDesc.createEl('strong', { text: 'Guide: ' });
    syntaxDesc.appendText('Use ');
    syntaxDesc.createEl('code', { text: '{{variable}}' });
    syntaxDesc.appendText(' to insert content. Add ');
    syntaxDesc.createEl('code', { text: '[[title]]' });
    syntaxDesc.appendText(' after a variable to show a section header when content is available (e.g. ');
    syntaxDesc.createEl('code', { text: '{{snip_note}}[[#### Note]]' });
    syntaxDesc.appendText(' will show "#### Note" followed by the note content if a note exists).');

    const fileNameSection = scrollableContent.createDiv({ cls: 'snipd-formatting-section' });
    fileNameSection.createEl('h3', { text: 'Episode page name' });
    
    const fileNameVarsDesc = fileNameSection.createDiv({ cls: 'snipd-template-variables' });
    fileNameVarsDesc.setText('Variables (click to copy): ');
    const fileNameVars = [
      '{{episode_title}}',
      '{{episode_duration}}',
      '{{episode_publish_date}}',
      '{{episode_url}}'
    ];
    fileNameVars.forEach((varName, index) => {
      const varSpan = fileNameVarsDesc.createSpan({ cls: 'snipd-template-variable', text: varName });
      varSpan.addEventListener('click', () => {
        void (async () => {
          if (Platform.isDesktopApp) {
            await globalThis.navigator.clipboard.writeText(varName);
          } else {
            const textArea = globalThis.document.createElement('textarea');
            textArea.value = varName;
            globalThis.document.body.appendChild(textArea);
            textArea.select();
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            globalThis.document.execCommand('copy');
            globalThis.document.body.removeChild(textArea);
          }
          new Notice(`Copied ${varName} to clipboard`);
        })();
      });
      if (index < fileNameVars.length - 1) {
        fileNameVarsDesc.appendText(', ');
      }
    });
    
    const fileNameInput = fileNameSection.createEl('input', {
      cls: 'snipd-template-input',
      type: 'text',
    });
    fileNameInput.value = this.tempEpisodeFileNameTemplate;
    fileNameInput.addEventListener('input', () => {
      this.tempEpisodeFileNameTemplate = fileNameInput.value;
    });

    const episodeSection = scrollableContent.createDiv({ cls: 'snipd-formatting-section' });
    episodeSection.createEl('h3', { text: 'Episode template' });
    
    const episodeVarsDesc = episodeSection.createDiv({ cls: 'snipd-template-variables' });
    episodeVarsDesc.setText('Variables (click to copy): ');
    const episodeVars = [
      '{{episode_title}}',
      '{{episode_image}}',
      '{{show_title}}',
      '{{show_author}}',
      '{{guests}}',
      '{{episode_publish_date}}',
      '{{episode_ai_description}}',
      '{{mentioned_books}}',
      '{{episode_duration}}',
      '{{episode_url}}',
      '{{show_url}}',
      '{{episode_export_date}}',
      '{{snips_section}}'
    ];
    episodeVars.forEach((varName, index) => {
      const varSpan = episodeVarsDesc.createSpan({ cls: 'snipd-template-variable', text: varName });
      varSpan.addEventListener('click', () => {
        void (async () => {
          if (Platform.isDesktopApp) {
            await globalThis.navigator.clipboard.writeText(varName);
          } else {
            const textArea = globalThis.document.createElement('textarea');
            textArea.value = varName;
            globalThis.document.body.appendChild(textArea);
            textArea.select();
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            globalThis.document.execCommand('copy');
            globalThis.document.body.removeChild(textArea);
          }
          new Notice(`Copied ${varName} to clipboard`);
        })();
      });
      if (index < episodeVars.length - 1) {
        episodeVarsDesc.appendText(', ');
      }
    });
    
    const episodeTextarea = episodeSection.createEl('textarea', {
      cls: 'snipd-template-textarea',
    });
    episodeTextarea.value = this.tempEpisodeTemplate;
    episodeTextarea.rows = 10;
    episodeTextarea.addEventListener('input', () => {
      this.tempEpisodeTemplate = episodeTextarea.value;
    });

    const snipSection = scrollableContent.createDiv({ cls: 'snipd-formatting-section' });
    snipSection.createEl('h3', { text: 'Snip template' });
    
    const snipVarsDesc = snipSection.createDiv({ cls: 'snipd-template-variables' });
    snipVarsDesc.setText('Variables (click to copy): ');
    const snipVars = [
      '{{snip_title}}',
      '{{snip_url}}',
      '{{snip_tags}}',
      '{{snip_favorite_star}}',
      '{{snip_start_time}}',
      '{{snip_end_time}}',
      '{{snip_duration}}',
      '{{snip_note}}',
      '{{snip_quote}}',
      '{{snip_transcript}}'
    ];
    snipVars.forEach((varName, index) => {
      const varSpan = snipVarsDesc.createSpan({ cls: 'snipd-template-variable', text: varName });
      varSpan.addEventListener('click', () => {
        void (async () => {
          if (Platform.isDesktopApp) {
            await globalThis.navigator.clipboard.writeText(varName);
          } else {
            const textArea = globalThis.document.createElement('textarea');
            textArea.value = varName;
            globalThis.document.body.appendChild(textArea);
            textArea.select();
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            globalThis.document.execCommand('copy');
            globalThis.document.body.removeChild(textArea);
          }
          new Notice(`Copied ${varName} to clipboard`);
        })();
      });
      if (index < snipVars.length - 1) {
        snipVarsDesc.appendText(', ');
      }
    });
    
    const snipTextarea = snipSection.createEl('textarea', {
      cls: 'snipd-template-textarea',
    });
    snipTextarea.value = this.tempSnipTemplate;
    snipTextarea.rows = 10;
    snipTextarea.addEventListener('input', () => {
      this.tempSnipTemplate = snipTextarea.value;
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const resetButton = buttonContainer.createEl('button', { text: 'Reset to default' });
    resetButton.addEventListener('click', () => {
      this.tempEpisodeFileNameTemplate = DEFAULT_EPISODE_FILE_NAME_TEMPLATE;
      this.tempEpisodeTemplate = DEFAULT_EPISODE_TEMPLATE;
      this.tempSnipTemplate = DEFAULT_SNIP_TEMPLATE;
      fileNameInput.value = this.tempEpisodeFileNameTemplate;
      episodeTextarea.value = this.tempEpisodeTemplate;
      snipTextarea.value = this.tempSnipTemplate;
    });

    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.close();
    });

    const saveButton = buttonContainer.createEl('button', { 
      text: 'Save',
      cls: 'mod-cta'
    });
    saveButton.addEventListener('click', () => {
      void (async () => {
        this.plugin.settings.episodeFileNameTemplate = 
          this.tempEpisodeFileNameTemplate === DEFAULT_EPISODE_FILE_NAME_TEMPLATE
            ? null
            : this.tempEpisodeFileNameTemplate;
        this.plugin.settings.episodeTemplate = 
          this.tempEpisodeTemplate === DEFAULT_EPISODE_TEMPLATE
            ? null
            : this.tempEpisodeTemplate;
        this.plugin.settings.snipTemplate = 
          this.tempSnipTemplate === DEFAULT_SNIP_TEMPLATE
            ? null
            : this.tempSnipTemplate;
        await this.plugin.saveSettings();
        this.onSave();
        this.close();
      })();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
