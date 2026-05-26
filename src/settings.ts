import { App, PluginSettingTab, Setting, TextComponent } from "obsidian";
import OdysseyPlugin from "./main";
import { t } from "./i18n";
import { hashPasscode } from "./utils/security";

interface TextSettingOptions {
  name: string;
  desc?: string;
  placeholder?: string;
  value: string;
  password?: boolean;
  trim?: boolean;
  onSave: (value: string) => Promise<void>;
}

export class OdysseySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OdysseyPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t("settings_heading") });
    containerEl.createEl("p", { text: t("settings_description") });
    containerEl.createEl("p", { text: t("settingsSafetyDisclaimer") });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_rootDirName"),
      desc: t("settings_rootDirDesc"),
      value: this.plugin.settings.rootDir,
      trim: true,
      onSave: async value => {
        this.plugin.settings.rootDir = value || "Odyssey";
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_odysseyNameName"),
      desc: t("settings_odysseyNameDesc"),
      value: this.plugin.settings.odysseyName,
      trim: true,
      onSave: async value => {
        this.plugin.settings.odysseyName = value || "Odyssey";
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_userAvatarName"),
      desc: t("settings_userAvatarDesc"),
      value: this.plugin.settings.userAvatar,
      trim: true,
      onSave: async value => {
        this.plugin.settings.userAvatar = value || "Me";
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_odysseyAvatarName"),
      desc: t("settings_odysseyAvatarDesc"),
      value: this.plugin.settings.odysseyAvatar,
      trim: true,
      onSave: async value => {
        this.plugin.settings.odysseyAvatar = value || "O";
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    new Setting(containerEl)
      .setName(t("settings_modelProviderName"))
      .addDropdown(dropdown => dropdown
        .addOption("ollama", "Ollama")
        .addOption("openai-compatible", "OpenAI-compatible")
        .addOption("anthropic", "Anthropic Claude")
        .setValue(this.plugin.settings.modelProvider)
        .onChange(async value => {
          this.plugin.settings.modelProvider = value as typeof this.plugin.settings.modelProvider;
          await this.plugin.saveSettingsAndRefresh();
        }));

    new Setting(containerEl)
      .setName(t("settings_modelTierName"))
      .setDesc(t("settings_modelTierDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("auto", t("settings_modelTierAuto"))
        .addOption("constrained", t("settings_modelTierConstrained"))
        .addOption("standard", t("settings_modelTierStandard"))
        .addOption("frontier", t("settings_modelTierFrontier"))
        .setValue(this.plugin.settings.modelTier)
        .onChange(async value => {
          this.plugin.settings.modelTier = value as typeof this.plugin.settings.modelTier;
          await this.plugin.saveSettingsAndRefresh();
        }));

    new Setting(containerEl)
      .setName(t("settings_presetName"))
      .setDesc(t("settings_presetDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("", t("settings_presetPlaceholder"))
        .addOption("ollama", "Ollama llama3.1 (local)")
        .addOption("openai", "OpenAI GPT-4o mini")
        .addOption("anthropic", "Anthropic Claude Sonnet")
        .addOption("deepseek", "DeepSeek V4 Flash")
        .addOption("deepseek-pro", "DeepSeek V4 Pro")
        .addOption("siliconflow", "SiliconFlow Qwen3.6 35B-A3B")
        .addOption("groq", "Groq Llama 3.1 70B")
        .setValue("")
        .onChange(async value => {
          if (!value) return;
          this.applyModelPreset(value);
          await this.plugin.saveSettingsAndRefresh();
          this.plugin.notice(t("settings_presetApplied"));
          this.display();
        }));

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_apiBaseUrlName"),
      placeholder: "http://127.0.0.1:11434",
      value: this.plugin.settings.apiBaseUrl,
      trim: true,
      onSave: async value => {
        this.plugin.settings.apiBaseUrl = value;
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_apiKeyName"),
      desc: t("settings_apiKeyDesc"),
      value: this.plugin.settings.apiKey,
      password: true,
      onSave: async value => {
        this.plugin.settings.apiKey = value;
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_chatModelName"),
      value: this.plugin.settings.chatModel,
      trim: true,
      onSave: async value => {
        this.plugin.settings.chatModel = value;
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_summaryModelName"),
      value: this.plugin.settings.summaryModel,
      trim: true,
      onSave: async value => {
        this.plugin.settings.summaryModel = value;
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_extractionModelName"),
      desc: t("settings_extractionModelDesc"),
      value: this.plugin.settings.extractionModel,
      trim: true,
      onSave: async value => {
        this.plugin.settings.extractionModel = value;
        this.plugin.settings.extractionModelProbeStatus = "unknown";
        this.plugin.settings.extractionModelProbeMessage = t("settings_extractionModelChanged");
        this.plugin.settings.extractionModelProbeUpdatedAt = "";
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    const probeText = [
      t("settings_probeStatusLabel", { status: formatProbeStatus(this.plugin.settings.extractionModelProbeStatus) }),
      this.plugin.settings.extractionModelProbeMessage,
      this.plugin.settings.extractionModelProbeUpdatedAt
        ? t("settings_probeUpdatedAt", { time: formatProbeUpdatedAt(this.plugin.settings.extractionModelProbeUpdatedAt) })
        : ""
    ].filter(Boolean).join("\n");
    new Setting(containerEl)
      .setName(t("settings_testExtractionName"))
      .setDesc(probeText)
      .addButton(button => button
        .setButtonText(t("settings_testExtractionButton"))
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText(t("settings_testExtractionRunning"));
          try {
            await this.plugin.testExtractionModel();
          } finally {
            this.display();
          }
        }));

    const chatSpeedText = [
      t("settings_chatSpeedTierLabel", { tier: formatChatSpeedTier(this.plugin.settings.chatModelSpeedTier) }),
      this.plugin.settings.chatModelSpeedProbeUpdatedAt
        ? t("settings_probeUpdatedAt", { time: formatProbeUpdatedAt(this.plugin.settings.chatModelSpeedProbeUpdatedAt) })
        : ""
    ].filter(Boolean).join("\n");
    new Setting(containerEl)
      .setName(t("settings_testChatSpeedName"))
      .setDesc(chatSpeedText)
      .addButton(button => button
        .setButtonText(t("settings_testChatSpeedButton"))
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText(t("settings_testChatSpeedRunning"));
          try {
            await this.plugin.testChatModelSpeed();
          } finally {
            this.display();
          }
        }));

    new Setting(containerEl)
      .setName(t("settings_autoExtractName"))
      .setDesc(t("settings_autoExtractDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoExtractMemories)
        .onChange(async value => {
          this.plugin.settings.autoExtractMemories = value;
          await this.plugin.saveSettingsAndRefresh();
        }));

    new Setting(containerEl)
      .setName(t("settings_lockOnOpenName"))
      .setDesc(t("settings_lockOnOpenDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.lockOnOpen)
        .onChange(async value => {
          this.plugin.settings.lockOnOpen = value;
          await this.plugin.saveSettingsAndRefresh();
        }));

    new Setting(containerEl)
      .setName(t("settings_lockMemoryFilesName"))
      .setDesc(t("settings_lockMemoryFilesDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.lockMemoryFilesByDefault)
        .onChange(async value => {
          this.plugin.settings.lockMemoryFilesByDefault = value;
          await this.plugin.saveSettingsAndRefresh();
        }));

    new Setting(containerEl)
      .setName(t("settings_autoLockMinutesName"))
      .setDesc(t("settings_autoLockMinutesDesc"))
      .addText(text => text
        .setValue(String(this.plugin.settings.autoLockMinutes))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 0) {
            this.plugin.settings.autoLockMinutes = Math.floor(parsed);
            await this.plugin.saveSettingsAndRefresh();
          }
        }));

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_passcodeName"),
      desc: t("settings_passcodeDesc"),
      value: "",
      password: true,
      onSave: async value => {
        this.plugin.settings.privacyLockPasscodeHash = value ? hashPasscode(value) : "";
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    new Setting(containerEl)
      .setName(t("settings_maxInputCharsName"))
      .setDesc(t("settings_maxInputCharsDesc"))
      .addText(text => text
        .setValue(String(this.plugin.settings.maxInputChars))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed > 2000) {
            this.plugin.settings.maxInputChars = parsed;
            await this.plugin.saveSettingsAndRefresh();
          }
        }));

    new Setting(containerEl)
      .setName(t("settings_maxOutputTokensName"))
      .setDesc(t("settings_maxOutputTokensDesc"))
      .addText(text => text
        .setValue(String(this.plugin.settings.maxOutputTokens))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 256) {
            this.plugin.settings.maxOutputTokens = Math.floor(parsed);
            await this.plugin.saveSettingsAndRefresh();
          }
        }));

    new Setting(containerEl)
      .setName(t("settings_maxContinuationTurnsName"))
      .setDesc(t("settings_maxContinuationTurnsDesc"))
      .addText(text => text
        .setValue(String(this.plugin.settings.maxContinuationTurns))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 0) {
            this.plugin.settings.maxContinuationTurns = Math.min(Math.floor(parsed), 5);
            await this.plugin.saveSettingsAndRefresh();
          }
        }));

    new Setting(containerEl)
      .setName(t("settings_promptsDirName"))
      .setDesc(t("settings_promptsDirDesc"));

    this.addPasteFriendlyText(containerEl, {
      name: t("settings_systemPromptName"),
      desc: t("settings_systemPromptDesc"),
      value: this.plugin.settings.systemPrompt,
      trim: false,
      onSave: async value => {
        this.plugin.settings.systemPrompt = value;
        await this.plugin.saveSettingsAndRefresh();
      }
    });

    new Setting(containerEl)
      .setName(t("settings_importVaultName"))
      .setDesc(t("settings_importVaultDesc"))
      .addButton(button => button
        .setButtonText(t("settings_importVaultButton"))
        .onClick(async () => {
          const result = await this.plugin.importVaultReferencesInteractive();
          this.plugin.notice(t("settings_importVaultSuccess", { importedCount: result.importedCount, skippedCount: result.skippedCount }));
        }));
  }

  private addPasteFriendlyText(containerEl: HTMLElement, options: TextSettingOptions): void {
    let component: TextComponent | undefined;
    const setting = new Setting(containerEl).setName(options.name);
    if (options.desc) setting.setDesc(options.desc);

    setting.addText(text => {
      component = text;
      if (options.placeholder) text.setPlaceholder(options.placeholder);
      if (options.password) text.inputEl.type = "password";
      this.keepClipboardShortcutsInInput(text.inputEl);
      text
        .setValue(options.value)
        .onChange(async value => {
          await options.onSave(options.trim ? value.trim() : value);
        });
    });

    setting.addButton(button => button
      .setIcon("clipboard-paste")
      .setTooltip(t("settings_pasteFromClipboard"))
      .onClick(async () => {
        if (!component) return;
        const value = await navigator.clipboard.readText();
        component.setValue(value);
        await options.onSave(options.trim ? value.trim() : value);
        this.plugin.notice(t("settings_pasteSuccess", { name: options.name }));
      }));
  }

  private keepClipboardShortcutsInInput(inputEl: HTMLInputElement): void {
    inputEl.addEventListener("paste", event => event.stopPropagation());
    inputEl.addEventListener("copy", event => event.stopPropagation());
    inputEl.addEventListener("cut", event => event.stopPropagation());
    inputEl.addEventListener("keydown", event => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && ["a", "c", "v", "x"].includes(key)) {
        event.stopPropagation();
      }
    });
  }

  private applyModelPreset(value: string): void {
    if (value === "ollama") {
      this.plugin.settings.modelProvider = "ollama";
      this.plugin.settings.apiBaseUrl = "http://127.0.0.1:11434";
      this.plugin.settings.apiKey = "";
      this.plugin.settings.chatModel = "llama3.1";
      this.plugin.settings.summaryModel = "llama3.1";
      this.plugin.settings.extractionModel = "llama3.1";
    }
    if (value === "openai") {
      this.plugin.settings.modelProvider = "openai-compatible";
      this.plugin.settings.apiBaseUrl = "https://api.openai.com/v1";
      this.plugin.settings.chatModel = "gpt-4o-mini";
      this.plugin.settings.summaryModel = "gpt-4o-mini";
      this.plugin.settings.extractionModel = "gpt-4o-mini";
    }
    if (value === "anthropic") {
      this.plugin.settings.modelProvider = "anthropic";
      this.plugin.settings.apiBaseUrl = "https://api.anthropic.com/v1";
      this.plugin.settings.chatModel = "claude-sonnet-4-5";
      this.plugin.settings.summaryModel = "claude-sonnet-4-5";
      this.plugin.settings.extractionModel = "claude-sonnet-4-5";
    }
    if (value === "deepseek") {
      this.plugin.settings.modelProvider = "openai-compatible";
      this.plugin.settings.apiBaseUrl = "https://api.deepseek.com";
      this.plugin.settings.chatModel = "deepseek-v4-flash";
      this.plugin.settings.summaryModel = "deepseek-v4-flash";
      this.plugin.settings.extractionModel = "deepseek-v4-flash";
    }
    if (value === "deepseek-pro") {
      this.plugin.settings.modelProvider = "openai-compatible";
      this.plugin.settings.apiBaseUrl = "https://api.deepseek.com";
      this.plugin.settings.chatModel = "deepseek-v4-pro";
      this.plugin.settings.summaryModel = "deepseek-v4-pro";
      this.plugin.settings.extractionModel = "deepseek-v4-pro";
    }
    if (value === "siliconflow") {
      this.plugin.settings.modelProvider = "openai-compatible";
      this.plugin.settings.apiBaseUrl = "https://api.siliconflow.cn/v1";
      this.plugin.settings.chatModel = "Qwen/Qwen3.6-35B-A3B";
      this.plugin.settings.summaryModel = "Qwen/Qwen3.6-35B-A3B";
      this.plugin.settings.extractionModel = "Qwen/Qwen3.6-35B-A3B";
    }
    if (value === "groq") {
      this.plugin.settings.modelProvider = "openai-compatible";
      this.plugin.settings.apiBaseUrl = "https://api.groq.com/openai/v1";
      this.plugin.settings.chatModel = "llama-3.1-70b-versatile";
      this.plugin.settings.summaryModel = "llama-3.1-70b-versatile";
      this.plugin.settings.extractionModel = "llama-3.1-70b-versatile";
    }
    this.plugin.settings.extractionModelProbeStatus = "unknown";
    this.plugin.settings.extractionModelProbeMessage = t("settings_presetChanged");
    this.plugin.settings.extractionModelProbeUpdatedAt = "";
  }
}

function formatChatSpeedTier(tier: string): string {
  if (tier === "fast") return t("settings_chatSpeedFast");
  if (tier === "medium") return t("settings_chatSpeedMedium");
  if (tier === "slow") return t("settings_chatSpeedSlow");
  return t("settings_chatSpeedUnknown");
}

function formatProbeStatus(status: string): string {
  if (status === "passed") return t("settings_probeStatusPassed");
  if (status === "partial") return t("settings_probeStatusPartial");
  if (status === "failed") return t("settings_probeStatusFailed");
  return t("settings_probeStatusUnknown");
}

function formatProbeUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(date);
}
