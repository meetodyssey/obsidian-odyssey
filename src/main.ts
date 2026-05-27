import { FuzzySuggestModal, MarkdownView, Menu, Notice, normalizePath, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, OdysseySettings, ReferenceImportResult, normalizeSettings } from "./types";
import { t, setLanguage } from "./i18n";

function platformModKey(): string {
  return navigator.platform?.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
}
import { MarkdownStore } from "./store/markdown-store";
import { LocalIndex } from "./index/local-index";
import { ShadowIndexStore } from "./index/shadow-index-store";
import { RetrievalService } from "./retrieval/retrieval-service";
import { ContextBuilder } from "./context/context-builder";
import { ModelGateway } from "./model/model-gateway";
import { runChatModelSpeedProbe, runExtractionModelProbe } from "./model/model-probe";
import { MemoryExtractor } from "./memory/memory-extractor";
import { CorrectionDetector } from "./memory/correction-detector";
import { PluginLocalRuntime } from "./runtime/plugin-local-runtime";
import { ODYSSEY_VIEW_TYPE, OdysseyChatView } from "./ui/chat-view";
import { OdysseySettingTab } from "./settings";
import { generateSecret } from "./utils/security";
import { verifyPasscode } from "./utils/security";
import { promptForText } from "./ui/prompt";

export default class OdysseyPlugin extends Plugin {
  settings!: OdysseySettings;
  store!: MarkdownStore;
  shadowIndex!: ShadowIndexStore;
  index!: LocalIndex;
  retrieval!: RetrievalService;
  runtime!: PluginLocalRuntime;
  modelGateway!: ModelGateway;
  private memoryFilesUnlockedUntil = 0;

  async onload(): Promise<void> {
    try {
      await this.loadSettings();
      this.detectAndSetLanguage();
      await this.initializeServices();
      await this.registerPluginUi();
      this.closeProtectedMemoryLeaves();
      await this.writeRuntimeStatus("loaded");
      this.notice(t("notices_pluginLoaded"));
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      console.error("Odyssey failed to load", error);
      await this.writeBootError(message);
      this.notice(t("notices_pluginLoadFailed"));
      throw error;
    }
  }

  private detectAndSetLanguage(): void {
    try {
      const lang = localStorage.getItem("language") ?? navigator.language;
      setLanguage(lang);
    } catch {
      // keep default
    }
  }

  private async registerPluginUi(): Promise<void> {
    this.app.workspace.detachLeavesOfType(ODYSSEY_VIEW_TYPE);
    this.registerView(ODYSSEY_VIEW_TYPE, (leaf: WorkspaceLeaf) => new OdysseyChatView(leaf, this));
    this.addSettingTab(new OdysseySettingTab(this.app, this));
    this.addCommand({
      id: "open-odyssey",
      name: t("commands_openOdyssey"),
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "import-vault-as-odyssey-references",
      name: t("commands_importVaultReference"),
      callback: async () => {
        const result = await this.importVaultReferencesInteractive();
        this.notice(t("settings_importVaultSuccess", { importedCount: result.importedCount, skippedCount: result.skippedCount }));
      }
    });
    this.addCommand({
      id: "unlock-odyssey-memory-files",
      name: t("commands_unlockMemoryFiles"),
      callback: async () => {
        if (!await this.unlockMemoryFilesForViewing()) return;
        this.showMemoryFilePicker();
      }
    });
    this.addCommand({
      id: "arrange-odyssey-workspace",
      name: t("commands_arrangeWorkspace"),
      callback: () => this.arrangeWorkspace()
    });
    this.registerEvent(this.app.workspace.on("file-open", file => this.guardProtectedMemoryFile(file)));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.addProtectedFileMenu(menu, file)));
    await this.registerRibbonIcon();
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        if (this.app.workspace.getLeavesOfType(ODYSSEY_VIEW_TYPE).length === 0) {
          void this.activateView();
        }
      }, 0);
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(ODYSSEY_VIEW_TYPE);
  }

  async activateView(): Promise<void> {
    this.closeProtectedMemoryLeaves();
    await this.applyOdysseyLayout();
    const leaf = this.app.workspace.getLeavesOfType(ODYSSEY_VIEW_TYPE)[0];
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      await this.app.workspace.revealLeaf(leaf);
    }
    this.scheduleWorkspaceCleanup(leaf);
  }

  async saveSettingsAndRefresh(): Promise<void> {
    await this.saveData(this.settings);
    await this.writeSettingsBackup(this.settings);
    await this.initializeServices();
  }

  notice(message: string): void {
    new Notice(message);
  }

  async importVaultReferences(limit = 200, filter = ""): Promise<ReferenceImportResult> {
    const candidates = await this.filterReferenceCandidates(await this.store.listReferenceCandidateFiles(), filter);
    let importedCount = 0;
    let skippedCount = 0;
    const changedPaths: string[] = [];
    for (const file of candidates.slice(0, limit)) {
      const content = await this.app.vault.read(file);
      const summary = content.replace(/^---[\s\S]*?---\s*/m, "").replace(/\s+/g, " ").trim().slice(0, 600);
      if (!summary) {
        skippedCount += 1;
        continue;
      }
      const id = await this.store.writeReference(file.path, file.basename, summary);
      changedPaths.push(this.store.referencePath(id));
      importedCount += 1;
    }
    skippedCount += Math.max(0, candidates.length - limit);
    await this.index.refreshPaths(changedPaths);
    return { scannedCount: candidates.length, importedCount, skippedCount };
  }

  async testExtractionModel(): Promise<void> {
    this.notice(t("notices_testingExtractionModel"));
    const result = await runExtractionModelProbe(this.modelGateway);
    this.settings.extractionModelProbeStatus = result.status;
    this.settings.extractionModelProbeMessage = result.message;
    this.settings.extractionModelProbeUpdatedAt = new Date().toISOString();
    await this.saveSettingsAndRefresh();
    if (result.status === "failed") {
      this.notice(t("notices_extractionModelFailed"));
      return;
    }
    if (result.status === "partial") {
      this.notice(t("notices_extractionModelPartial"));
      return;
    }
    this.notice(t("notices_extractionModelPassed"));
  }

  async testChatModelSpeed(): Promise<void> {
    this.notice(t("notices_testingChatModelSpeed"));
    const result = await runChatModelSpeedProbe(this.modelGateway);
    this.settings.chatModelSpeedTier = result.tier;
    this.settings.chatModelSpeedProbeUpdatedAt = new Date().toISOString();
    await this.saveSettingsAndRefresh();
    if (result.tier === "fast") {
      this.notice(t("notices_chatModelSpeedFast", { time: (result.totalDurationMs / 1000).toFixed(1) }));
    } else if (result.tier === "medium") {
      this.notice(t("notices_chatModelSpeedMedium", { time: (result.totalDurationMs / 1000).toFixed(1) }));
    } else if (result.tier === "slow") {
      this.notice(t("notices_chatModelSpeedSlow", { time: (result.totalDurationMs / 1000).toFixed(1) }));
    } else {
      this.notice(t("notices_chatModelSpeedFailed"));
    }
  }

  async importVaultReferencesInteractive(): Promise<ReferenceImportResult> {
    const filter = window.prompt(t("notices_importVaultPrompt"), "")?.trim() ?? "";
    if (!filter) {
      this.notice(t("notices_importVaultCancelled"));
      return { scannedCount: 0, importedCount: 0, skippedCount: 0 };
    }
    const candidates = await this.filterReferenceCandidates(await this.store.listReferenceCandidateFiles(), filter);
    const preview = candidates.slice(0, 12).map(file => `- ${file.path}`).join("\n");
    const more = candidates.length > 12 ? `\n... 另有 ${candidates.length - 12} 个文件` : "";
    if (!window.confirm(`将导入 ${Math.min(candidates.length, 200)} / ${candidates.length} 个文件为低优先级 Reference，不会自动进入人格记忆。\n\n${preview}${more}`)) {
      return { scannedCount: candidates.length, importedCount: 0, skippedCount: candidates.length };
    }
    return this.importVaultReferences(200, filter);
  }

  async flagMemoryAsInaccurate(memoryId: string, reason = "用户在 UI 中标记该记忆不准确。"): Promise<string | null> {
    const memory = this.index.memories.find(item => item.id === memoryId);
    if (!memory) return null;
    const id = await this.store.writeCorrection(
      [this.store.anchorFor(memory.path, memory.id)],
      "用户标记该记忆或摘要不准确，不应在后续回答中继续直接采用。",
      reason,
      `UI feedback for ${memory.id}`
    );
    await this.index.refreshPaths([this.store.correctionRecordPath(id)]);
    return id;
  }

  private async filterReferenceCandidates(files: TFile[], filter: string): Promise<TFile[]> {
    const normalized = filter.trim();
    if (!normalized) return files;
    if (normalized.toLowerCase() === "daily") {
      return files.filter(file => /daily|日记|journal|diary/i.test(file.path) || /\d{4}-\d{2}-\d{2}/.test(file.basename));
    }
    if (normalized.startsWith("folder:")) {
      const folder = normalizePath(normalized.slice("folder:".length).trim()).replace(/\/$/, "");
      return files.filter(file => normalizePath(file.path).startsWith(`${folder}/`));
    }
    if (normalized.startsWith("tag:")) {
      const tag = normalized.slice("tag:".length).trim().replace(/^#/, "");
      const matched: TFile[] = [];
      for (const file of files) {
        const content = await this.app.vault.read(file);
        if (new RegExp(`(^|\\s)#${escapeRegExp(tag)}(\\s|$)`, "i").test(content) || content.includes(`- ${tag}`)) {
          matched.push(file);
        }
      }
      return matched;
    }
    return files.filter(file => file.path.toLowerCase().includes(normalized.toLowerCase()));
  }

  async unlockMemoryFilesForViewing(minutes = 10): Promise<boolean> {
    const expectedHash = this.settings.privacyLockPasscodeHash;
    if (expectedHash) {
      const passcode = await promptForText(this.app, {
        title: t("chat_unlockTitle"),
        description: t("chat_unlockDesc"),
        placeholder: t("chat_unlockPlaceholder"),
        submitText: t("chat_unlockSubmit"),
        password: true,
        trim: false
      });
      if (!passcode || !verifyPasscode(passcode, expectedHash)) {
        this.notice(t("notices_wrongPasscode"));
        return false;
      }
    }
    this.memoryFilesUnlockedUntil = Date.now() + minutes * 60 * 1000;
    this.notice(t("notices_memoryFilesUnlocked", { minutes }));
    return true;
  }

  private showMemoryFilePicker(): void {
    const root = normalizePath(this.settings.rootDir || "Odyssey");
    const files = this.app.vault.getMarkdownFiles()
      .filter(f => {
        const p = normalizePath(f.path);
        return p.startsWith(root + "/") && !p.includes("Prompts/");
      });
    if (files.length === 0) {
      this.notice("No Odyssey memory files found.");
      return;
    }
    new MemoryFileSuggestModal(this.app, files, async (file) => {
      const leaf = this.findEmptyLeaf() ?? this.app.workspace.getLeaf();
      await leaf.openFile(file, { active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }).open();
  }

  private addProtectedFileMenu(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (!this.isProtectedMemoryFile(file)) return;
    menu.addItem(item => item
      .setTitle(t("commands_unlockMemoryFiles"))
      .setIcon("unlock")
      .onClick(async () => {
        if (!await this.unlockMemoryFilesForViewing()) return;
        const emptyLeaf = this.findEmptyLeaf();
        const odysseyLeaf = this.app.workspace.getLeavesOfType(ODYSSEY_VIEW_TYPE)[0];
        const leaf = emptyLeaf ?? (odysseyLeaf
          ? this.app.workspace.createLeafBySplit(odysseyLeaf, "vertical", false)
          : this.app.workspace.createLeafInParent(this.app.workspace.rootSplit, 1));
        await leaf.openFile(file, { active: true });
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        this.scheduleWorkspaceCleanup(leaf);
      }));
  }

  private guardProtectedMemoryFile(file: TFile | null): void {
    if (!file || !this.isProtectedMemoryFile(file)) return;
    if (this.isMemoryFileUnlocked()) return;
    window.setTimeout(() => {
      if (this.isMemoryFileUnlocked()) return;
      this.closeProtectedMemoryLeaves();
      this.scheduleWorkspaceCleanup();
      this.notice(t("notices_memoryFilesLocked", { modKey: platformModKey() }));
    }, 0);
  }

  private arrangeWorkspace(): void {
    void this.applyOdysseyLayout();
  }

  private async applyOdysseyLayout(): Promise<void> {
    const layout = this.app.workspace.getLayout() as WorkspaceLayoutData;
    const currentMain = sanitizeWorkspaceNode(layout.main);
    layout.main = buildMainWithOdyssey(currentMain);
    layout.right = sanitizeWorkspaceNode(layout.right) ?? layout.right;
    layout.left = sanitizeWorkspaceNode(layout.left) ?? layout.left;
    layout.active = findFirstLeafId(layout.main) ?? layout.active;
    await this.app.workspace.changeLayout(layout);
    const odysseyLeaf = this.app.workspace.getLeavesOfType(ODYSSEY_VIEW_TYPE)[0];
    if (odysseyLeaf) {
      this.app.workspace.setActiveLeaf(odysseyLeaf, { focus: true });
      void this.app.workspace.revealLeaf(odysseyLeaf);
    }
  }

  private closeProtectedMemoryLeaves(): void {
    if (!this.settings.lockMemoryFilesByDefault) return;
    if (this.isMemoryFileUnlocked()) return;
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && this.isProtectedMemoryFile(view.file)) {
        leaf.detach();
      }
    });
  }

  private isMemoryFileUnlocked(): boolean {
    return Date.now() < this.memoryFilesUnlockedUntil;
  }

  private isProtectedMemoryFile(file: TFile): boolean {
    if (!this.settings.lockMemoryFilesByDefault) return false;
    const root = normalizePath(this.settings.rootDir || "Odyssey");
    const path = normalizePath(file.path);
    return path === root || path.startsWith(`${root}/`);
  }

  private getPreferredCenterLeaf(): WorkspaceLeaf {
    const active = this.app.workspace.activeLeaf;
    if (active && this.isEmptyLeaf(active)) return active;

    const emptyLeaf = this.findEmptyLeaf();
    if (emptyLeaf) return emptyLeaf;

    const recent = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    if (recent && recent.view.getViewType() !== ODYSSEY_VIEW_TYPE) return recent;

    return this.app.workspace.createLeafInParent(this.app.workspace.rootSplit, 0);
  }

  private findEmptyLeaf(): WorkspaceLeaf | null {
    let emptyLeaf: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (!emptyLeaf && this.isEmptyLeaf(leaf)) emptyLeaf = leaf;
    });
    return emptyLeaf;
  }

  private closeEmptyLeavesExcept(keep?: WorkspaceLeaf): void {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf !== keep && this.isEmptyLeaf(leaf)) leaf.detach();
    });
  }

  private isEmptyLeaf(leaf: WorkspaceLeaf): boolean {
    const view = leaf.view;
    const viewType = view.getViewType();
    const stateType = leaf.getViewState()?.type;
    const displayText = safeCall(() => view.getDisplayText()) ?? "";
    const text = view.containerEl?.textContent ?? "";
    return viewType === "empty"
      || stateType === "empty"
      || displayText === "新标签页"
      || displayText.toLowerCase() === "new tab"
      || (text.includes("创建新文件") && text.includes("打开文件") && text.includes("关闭标签页"))
      || (text.includes("Create new file") && text.includes("Open file") && text.includes("Close"));
  }

  private scheduleWorkspaceCleanup(keep?: WorkspaceLeaf): void {
    for (const delay of [0, 100, 500]) {
      window.setTimeout(() => this.closeEmptyLeavesExcept(keep), delay);
    }
  }

  private async loadSettings(): Promise<void> {
    const rawSettings = await this.loadData();
    const backupSettings = await this.readSettingsBackup();
    const normalizedRaw = normalizeSettings(rawSettings);
    const normalizedBackup = backupSettings ? normalizeSettings(backupSettings) : null;
    const shouldRestoreBackup = Boolean(
      normalizedBackup
      && this.hasUserModelConfig(normalizedBackup)
      && !this.hasUserModelConfig(normalizedRaw)
    );
    this.settings = shouldRestoreBackup && normalizedBackup ? normalizedBackup : normalizedRaw;
    if (!this.settings.shadowIndexSecret) {
      this.settings.shadowIndexSecret = generateSecret();
    }
    await this.saveData(this.settings);
    await this.writeSettingsBackup(this.settings);
    if (shouldRestoreBackup) {
      this.notice(t("notices_settingsResetRestored"));
    }
  }

  private async readSettingsBackup(): Promise<unknown | null> {
    const path = this.settingsBackupPath();
    try {
      if (!await this.app.vault.adapter.exists(path)) return null;
      return JSON.parse(await this.app.vault.adapter.read(path));
    } catch (error) {
      console.warn("Odyssey settings backup could not be read", error);
      return null;
    }
  }

  private async writeSettingsBackup(settings: OdysseySettings): Promise<void> {
    const path = this.settingsBackupPath();
    try {
      await this.ensureVaultFolder(path.split("/").slice(0, -1).join("/"));
      await this.app.vault.adapter.write(path, JSON.stringify(settings, null, 2));
    } catch (error) {
      console.warn("Odyssey settings backup could not be written", error);
    }
  }

  private settingsBackupPath(): string {
    return normalizePath(`.obsidian/plugins/${this.manifest.id}/settings-backup.json`);
  }

  private hasUserModelConfig(settings: OdysseySettings): boolean {
    return Boolean(
      settings.apiKey
      || settings.modelProvider !== DEFAULT_SETTINGS.modelProvider
      || settings.apiBaseUrl !== DEFAULT_SETTINGS.apiBaseUrl
      || settings.chatModel !== DEFAULT_SETTINGS.chatModel
      || settings.summaryModel !== DEFAULT_SETTINGS.summaryModel
      || settings.extractionModel !== DEFAULT_SETTINGS.extractionModel
    );
  }

  private async registerRibbonIcon(): Promise<void> {
    const candidates = ["bot", "message-circle", "message-square", "brain-circuit", "sparkles"];
    const errors: string[] = [];
    for (const icon of candidates) {
      try {
        const ribbonIcon = this.addRibbonIcon(icon, "Odyssey", () => this.activateView());
        this.pinRibbonIconToTop(ribbonIcon);
        await this.store.writeTextFile(this.store.path("Index/plugin-ribbon-status.json"), JSON.stringify({
          status: "registered",
          icon,
          updatedAt: new Date().toISOString()
        }, null, 2));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${icon}: ${message}`);
      }
    }
    await this.store.writeTextFile(this.store.path("Index/plugin-ribbon-status.json"), JSON.stringify({
      status: "failed",
      errors,
      updatedAt: new Date().toISOString()
    }, null, 2));
    console.warn("Odyssey ribbon icon failed to register", errors);
  }

  private pinRibbonIconToTop(ribbonIcon: HTMLElement): void {
    ribbonIcon.classList.add("odyssey-ribbon-icon");
    window.setTimeout(() => {
      const parent = ribbonIcon.parentElement;
      if (!parent) return;
      const firstRibbonAction = Array.from(parent.children)
        .find(child => child.classList.contains("side-dock-ribbon-action"));
      if (firstRibbonAction && firstRibbonAction !== ribbonIcon) {
        parent.insertBefore(ribbonIcon, firstRibbonAction);
      }
    }, 0);
  }

  private async initializeServices(): Promise<void> {
    this.store = new MarkdownStore(this.app, this.settings);
    await this.store.ensureInitialized();
    this.shadowIndex = new ShadowIndexStore(this.app, this.settings.shadowIndexDir, this.settings.shadowIndexSecret);
    await this.shadowIndex.ensureInitialized();
    await this.writeRuntimeStatus("services-initialized");
    this.index = new LocalIndex(this.store, this.shadowIndex, this.settings.retrievalWeights);
    await this.index.load();
    if (this.index.documents.length === 0 || this.index.memories.length === 0) await this.index.rebuild();
    // If any correction files exist but their targets are still "active" in
    // the index, the correction wasn't applied — rebuild to pick them up.
    if (await this.index.hasUnappliedCorrections(this.store)) await this.index.rebuild();
    this.retrieval = new RetrievalService(this.index);
    this.modelGateway = new ModelGateway(() => this.settings);
    const contextBuilder = new ContextBuilder(this.settings, this.store, this.retrieval);
    const memoryExtractor = new MemoryExtractor(this.store, this.modelGateway);
    const correctionDetector = new CorrectionDetector(this.store);
    this.runtime = new PluginLocalRuntime(
      () => this.settings,
      this.store,
      this.index,
      this.retrieval,
      contextBuilder,
      this.modelGateway,
      memoryExtractor,
      correctionDetector
    );
  }

  private async writeRuntimeStatus(phase: string): Promise<void> {
    await this.store.writeTextFile(this.store.path("Index/plugin-runtime-status.json"), JSON.stringify({
      phase,
      loadedAt: new Date().toISOString(),
      pluginVersion: this.manifest.version
    }, null, 2));
  }

  private async writeBootError(message: string): Promise<void> {
    if (this.store) {
      await this.store.writeTextFile(this.store.path("Index/plugin-load-error.txt"), message);
      return;
    }
    const path = normalizePath("Odyssey/Index/plugin-load-error.txt");
    await this.ensureVaultFolder("Odyssey/Index");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, message);
    } else {
      try {
        await this.app.vault.create(path, message);
      } catch (error) {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, message);
          return;
        }
        if (isAlreadyExistsError(error)) {
          await this.app.vault.adapter.write(path, message);
          return;
        }
        throw error;
      }
    }
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.app.vault.adapter.exists(normalized)) return;
    if (this.app.vault.getAbstractFileByPath(normalized)) return;
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureVaultFolder(parent);
    try {
      await this.app.vault.createFolder(normalized);
    } catch (error) {
      if (isAlreadyExistsError(error)) return;
      if (await this.app.vault.adapter.exists(normalized)) return;
      if (this.app.vault.getAbstractFileByPath(normalized)) return;
      throw error;
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists/i.test(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

interface WorkspaceLayoutData {
  main?: WorkspaceNodeData;
  left?: WorkspaceNodeData;
  right?: WorkspaceNodeData;
  active?: string;
  [key: string]: unknown;
}

interface WorkspaceNodeData {
  id?: string;
  type?: string;
  children?: WorkspaceNodeData[];
  state?: {
    type?: string;
    state?: Record<string, unknown>;
    icon?: string;
    title?: string;
  };
  direction?: string;
  currentTab?: number;
  [key: string]: unknown;
}

function sanitizeWorkspaceNode(node: WorkspaceNodeData | undefined): WorkspaceNodeData | undefined {
  if (!node) return undefined;
  if (node.type === "leaf") {
    const viewType = node.state?.type;
    if (viewType === "empty" || viewType === ODYSSEY_VIEW_TYPE) return undefined;
    return node;
  }
  if (!Array.isArray(node.children)) return node;
  const children = node.children
    .map(child => sanitizeWorkspaceNode(child))
    .filter((child): child is WorkspaceNodeData => Boolean(child));
  if (children.length === 0) return undefined;
  return {
    ...node,
    children,
    currentTab: typeof node.currentTab === "number" ? Math.min(node.currentTab, children.length - 1) : node.currentTab
  };
}

function buildMainWithOdyssey(previousMain?: WorkspaceNodeData): WorkspaceNodeData {
  const odysseyTabs: WorkspaceNodeData = {
    id: makeWorkspaceId(),
    type: "tabs",
    children: [odysseyLeafNode()],
    currentTab: 0
  };
  const children = [odysseyTabs];
  if (previousMain && Array.isArray(previousMain.children)) {
    children.push(...previousMain.children);
  }
  return {
    id: previousMain?.id ?? makeWorkspaceId(),
    type: "split",
    children,
    direction: "vertical"
  };
}

function odysseyLeafNode(): WorkspaceNodeData {
  return {
    id: makeWorkspaceId(),
    type: "leaf",
    state: {
      type: ODYSSEY_VIEW_TYPE,
      state: {},
      icon: "bot",
      title: "Odyssey"
    }
  };
}

function findFirstLeafId(node: WorkspaceNodeData | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "leaf") return node.id;
  if (!Array.isArray(node.children)) return undefined;
  for (const child of node.children) {
    const id = findFirstLeafId(child);
    if (id) return id;
  }
  return undefined;
}

function makeWorkspaceId(): string {
  return Math.random().toString(16).slice(2, 18).padEnd(16, "0");
}

class MemoryFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: import("obsidian").App,
    private readonly files: TFile[],
    private readonly onChoose: (file: TFile) => void
  ) {
    super(app);
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}
