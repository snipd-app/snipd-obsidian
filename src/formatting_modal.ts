import { App, Modal, Notice } from 'obsidian';
import type SnipdPlugin from './main';
import { DEFAULT_EPISODE_TEMPLATE, DEFAULT_SNIP_TEMPLATE, DEFAULT_EPISODE_FILE_NAME_TEMPLATE } from './types';

interface AdditionalProperty {
  name: string;
  template: string;
  displayName?: string;
}

const ADDITIONAL_PROPERTIES_VARS = [
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
];

export class FormattingConfigModal extends Modal {
  plugin: SnipdPlugin;
  onSave: () => void;
  tempEpisodeTemplate: string;
  tempSnipTemplate: string;
  tempEpisodeFileNameTemplate: string;
  tempAdditionalProperties: AdditionalProperty[];
  additionalPropertyErrors: Array<{ name: boolean; template: boolean; }>;

  constructor(app: App, plugin: SnipdPlugin, onSave: () => void) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave;
    this.tempEpisodeTemplate = plugin.settings.episodeTemplate ?? DEFAULT_EPISODE_TEMPLATE;
    this.tempSnipTemplate = plugin.settings.snipTemplate ?? DEFAULT_SNIP_TEMPLATE;
    this.tempEpisodeFileNameTemplate = plugin.settings.episodeFileNameTemplate ?? DEFAULT_EPISODE_FILE_NAME_TEMPLATE;
    const savedProps: Array<{ name: string; template: string; displayName?: string; }> | null = plugin.settings.additionalProperties as Array<{ name: string; template: string; displayName?: string; }> | null;
    if (savedProps !== null && savedProps !== undefined && Array.isArray(savedProps)) {
      this.tempAdditionalProperties = savedProps.map((p) => ({ name: p.name, template: p.template, displayName: p.displayName ?? '' }));
    } else {
      this.tempAdditionalProperties = [];
    }
    this.additionalPropertyErrors = this.tempAdditionalProperties.map(() => ({ name: false, template: false }));
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('snipd-formatting-modal');
    contentEl.empty();
    
    const scrollableContent = contentEl.createDiv({ cls: 'snipd-modal-scrollable' });
    
    scrollableContent.createEl('h2', { text: 'Custom formatting' });
    scrollableContent.createEl('p', { 
      text: 'Configure how your episodes and snips are formatted.',
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
          try {
            await globalThis.navigator.clipboard.writeText(varName);
            new Notice(`Copied ${varName} to clipboard`);
          } catch {
            new Notice(`Failed to copy ${varName} to clipboard`);
          }
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
          try {
            await globalThis.navigator.clipboard.writeText(varName);
            new Notice(`Copied ${varName} to clipboard`);
          } catch {
            new Notice(`Failed to copy ${varName} to clipboard`);
          }
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
      '{{snip_clipping_time}}',
      '{{snip_created_time}}',
      '{{snip_duration}}',
      '{{snip_note}}',
      '{{snip_quote}}',
      '{{snip_transcript}}',
      '{{snip_audio_player}}'
    ];
    snipVars.forEach((varName, index) => {
      const varSpan = snipVarsDesc.createSpan({ cls: 'snipd-template-variable', text: varName });
      varSpan.addEventListener('click', () => {
        void (async () => {
          try {
            await globalThis.navigator.clipboard.writeText(varName);
            new Notice(`Copied ${varName} to clipboard`);
          } catch {
            new Notice(`Failed to copy ${varName} to clipboard`);
          }
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

    const additionalPropertiesSection = scrollableContent.createDiv({ cls: 'snipd-formatting-section' });
    additionalPropertiesSection.createEl('h3', { text: 'Additional properties' });
    
    const additionalPropertiesDesc = additionalPropertiesSection.createDiv({ cls: 'setting-item-description' });
    additionalPropertiesDesc.setText('Add custom yaml frontmatter properties to episode files. These will be appended to the episode properties header.');

    const additionalPropertiesVarsDesc = additionalPropertiesSection.createDiv({ cls: 'snipd-template-variables' });
    additionalPropertiesVarsDesc.setText('Available variables (click to copy):');
    ADDITIONAL_PROPERTIES_VARS.forEach((varName, index) => {
      const varSpan = additionalPropertiesVarsDesc.createSpan({ cls: 'snipd-template-variable', text: varName });
      varSpan.addEventListener('click', () => {
        void (async () => {
          try {
            await globalThis.navigator.clipboard.writeText(varName);
            new Notice(`Copied ${varName} to clipboard`);
          } catch {
            new Notice(`Failed to copy ${varName} to clipboard`);
          }
        })();
      });
      if (index < ADDITIONAL_PROPERTIES_VARS.length - 1) {
        additionalPropertiesVarsDesc.appendText(', ');
      }
    });

    const additionalPropertiesContainer = additionalPropertiesSection.createDiv({ cls: 'snipd-additional-properties-container' });
    this.renderAdditionalProperties(additionalPropertiesContainer);

    const addPropertyButton = additionalPropertiesSection.createEl('button', { 
      text: 'Add property',
      cls: 'snipd-add-property-button'
    });
    addPropertyButton.addEventListener('click', () => {
      this.tempAdditionalProperties.push({ name: '', template: '', displayName: '' });
      this.additionalPropertyErrors.push({ name: false, template: false });
      this.renderAdditionalProperties(additionalPropertiesContainer);
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const resetButton = buttonContainer.createEl('button', { text: 'Reset to default' });
    resetButton.addEventListener('click', () => {
      this.tempEpisodeFileNameTemplate = DEFAULT_EPISODE_FILE_NAME_TEMPLATE;
      this.tempEpisodeTemplate = DEFAULT_EPISODE_TEMPLATE;
      this.tempSnipTemplate = DEFAULT_SNIP_TEMPLATE;
      this.tempAdditionalProperties = [];
      this.additionalPropertyErrors = [];
      fileNameInput.value = this.tempEpisodeFileNameTemplate;
      episodeTextarea.value = this.tempEpisodeTemplate;
      snipTextarea.value = this.tempSnipTemplate;
      this.renderAdditionalProperties(additionalPropertiesContainer);
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
        const hasValidationErrors = this.validateAdditionalProperties();
        this.renderAdditionalProperties(additionalPropertiesContainer);
        if (hasValidationErrors) {
          new Notice('Please provide a name and template for each additional property.');
          return;
        }
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
        this.plugin.settings.additionalProperties = 
          this.tempAdditionalProperties.length > 0
            ? this.tempAdditionalProperties
                .map(p => ({
                  name: p.name.trim(),
                  template: p.template.trim(),
                  displayName: p.displayName?.trim() ? p.displayName.trim() : undefined,
                }))
            : null;
        await this.plugin.saveSettings();
        this.onSave();
        this.close();
      })();
    });
  }

  private validateAdditionalProperties(): boolean {
    let hasErrors = false;
    this.additionalPropertyErrors = this.tempAdditionalProperties.map((prop) => {
      const nameMissing = !prop.name || !prop.name.trim();
      const templateMissing = !prop.template || !prop.template.trim();
      if (nameMissing || templateMissing) {
        hasErrors = true;
      }
      return { name: nameMissing, template: templateMissing };
    });
    return hasErrors;
  }

  private renderAdditionalProperties(container: HTMLElement) {
    container.empty();
    
    if (this.tempAdditionalProperties.length === 0) {
      const emptyMessage = container.createDiv({ cls: 'snipd-empty-properties-message' });
      emptyMessage.setText('No additional properties configured, click "add property" to add one.');
      return;
    }

    this.tempAdditionalProperties.forEach((prop, index) => {
      const propertyErrors = this.additionalPropertyErrors[index] ?? { name: false, template: false };
      const propertyItem = container.createDiv({ cls: 'snipd-additional-property-item' });
      
      const propertyHeader = propertyItem.createDiv({ cls: 'snipd-additional-property-header' });
      propertyHeader.createEl('h4', { text: `Property ${index + 1}` });
      
      const removeButton = propertyHeader.createEl('button', { 
        text: 'Remove',
        cls: 'snipd-remove-property-button'
      });
      removeButton.addEventListener('click', () => {
        this.tempAdditionalProperties.splice(index, 1);
        this.additionalPropertyErrors.splice(index, 1);
        this.renderAdditionalProperties(container);
      });

      propertyItem.createEl('label', { 
        text: 'Property name:',
        cls: 'snipd-property-label'
      });
      
      const nameInput = propertyItem.createEl('input', {
        cls: 'snipd-template-input',
        type: 'text',
        placeholder: 'e.g., category, tags, custom_field',
      });
      nameInput.value = prop.name;
      nameInput.addEventListener('input', () => {
        prop.name = nameInput.value;
        if (this.additionalPropertyErrors[index]?.name && prop.name.trim()) {
          this.additionalPropertyErrors[index].name = false;
          nameInput.removeClass('snipd-input-error');
          nameErrorEl.addClass('snipd-hidden');
        }
      });
      const nameErrorEl = propertyItem.createDiv({ 
        text: 'Property name is required',
        cls: 'snipd-error-text snipd-property-error snipd-hidden'
      });
      if (propertyErrors.name) {
        nameInput.addClass('snipd-input-error');
        nameErrorEl.removeClass('snipd-hidden');
      }

      propertyItem.createEl('label', { 
        text: 'Display name (optional):',
        cls: 'snipd-property-label'
      });
      
      const displayNameInput = propertyItem.createEl('input', {
        cls: 'snipd-template-input',
        type: 'text',
        placeholder: 'e.g., Category, Tags, Custom Field',
      });
      displayNameInput.value = prop.displayName ?? '';
      displayNameInput.addEventListener('input', () => {
        prop.displayName = displayNameInput.value;
      });

      propertyItem.createEl('label', { 
        text: 'Template:',
        cls: 'snipd-property-label'
      });
      
      const templateInput = propertyItem.createEl('input', {
        cls: 'snipd-template-input',
        type: 'text',
        placeholder: 'e.g., {{episode_title}} - {{show_title}}',
      });
      templateInput.value = prop.template;
      templateInput.addEventListener('input', () => {
        prop.template = templateInput.value;
        if (this.additionalPropertyErrors[index]?.template && prop.template.trim()) {
          this.additionalPropertyErrors[index].template = false;
          templateInput.removeClass('snipd-input-error');
          templateErrorEl.addClass('snipd-hidden');
        }
      });
      const templateErrorEl = propertyItem.createDiv({ 
        text: 'Template is required',
        cls: 'snipd-error-text snipd-property-error snipd-hidden'
      });
      if (propertyErrors.template) {
        templateInput.addClass('snipd-input-error');
        templateErrorEl.removeClass('snipd-hidden');
      }
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
