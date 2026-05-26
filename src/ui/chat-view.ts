import { App, ItemView, MarkdownRenderer, Modal, setIcon, WorkspaceLeaf } from "obsidian";
import OdysseyPlugin from "../main";
import { AttachedReference, ChatMessage } from "../types";
import { verifyPasscode } from "../utils/security";
import { includesAny } from "../utils/text";
import { t } from "../i18n";

export const ODYSSEY_VIEW_TYPE = "odyssey-chat-view";

interface AlignmentFeedbackPrompt {
  prompt: string;
  response: string;
}

interface PendingSend {
  message: ChatMessage;
  attachedReferences: AttachedReference[];
  ephemeral: boolean;
  ephemeralEpoch: number;
  options: {
    alignmentTest?: boolean;
  };
}

export class OdysseyChatView extends ItemView {
  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private fileInputEl!: HTMLInputElement;
  private setupEl!: HTMLElement;
  private safetyNoteEl!: HTMLElement;
  private lockOverlayEl!: HTMLElement;
  private lockButtonEl!: HTMLButtonElement;
  private messages: ChatMessage[] = [];
  private selectedMessageKeys = new Set<string>();
  private attachedReferences: AttachedReference[] = [];
  private attachmentImportJob: Promise<void> = Promise.resolve();
  private pendingAlignmentFeedback: AlignmentFeedbackPrompt | null = null;
  private pendingSends: PendingSend[] = [];
  private sending = false;
  private composing = false;
  private locked = false;
  private ephemeralMode = false;
  private ephemeralEpoch = 0;
  private ephemeralButtonEl!: HTMLButtonElement;
  private ephemeralBannerEl!: HTMLElement;
  private autoLockTimer: number | undefined;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OdysseyPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return ODYSSEY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.settings.odysseyName;
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("odyssey-chat");

    const toolbar = root.createDiv({ cls: "odyssey-toolbar" });
    toolbar.createEl("strong", { text: this.plugin.settings.odysseyName });
    const actions = toolbar.createDiv({ cls: "odyssey-toolbar-actions" });
    this.ephemeralButtonEl = actions.createEl("button", { attr: { "aria-label": t("chat_ephemeralButtonLabel"), title: t("chat_ephemeralButtonTitle") } });
    setIcon(this.ephemeralButtonEl, "flame");
    this.ephemeralButtonEl.onclick = () => this.toggleEphemeralMode();
    this.lockButtonEl = actions.createEl("button", { attr: { "aria-label": t("chat_lockButtonLabel") } });
    setIcon(this.lockButtonEl, "lock");
    this.lockButtonEl.onclick = () => this.lock();
    const exportButton = actions.createEl("button", { attr: { "aria-label": t("chat_exportButtonLabel") } });
    setIcon(exportButton, "file-output");
    exportButton.onclick = async () => {
      if (this.locked) return;
      const selected = this.selectedMessages();
      if (selected.length === 0) {
        this.plugin.notice(t("chat_exportNoSelection"));
        return;
      }
      const path = await this.plugin.store.writeConversationExport(selected, t("chat_exportDefaultTitle"));
      this.plugin.notice(t("chat_exportSuccess", { path }));
    };
    const alignmentButton = actions.createEl("button", { attr: { "aria-label": t("chat_alignmentButtonLabel"), title: t("chat_alignmentButtonTitle") } });
    setIcon(alignmentButton, "badge-check");
    alignmentButton.onclick = () => this.startAlignmentTest();
    const issueButton = actions.createEl("button", { attr: { "aria-label": t("chat_issueButtonLabel"), title: t("chat_issueButtonTitle") } });
    setIcon(issueButton, "bug");
    issueButton.onclick = () => this.openIssueReport();
    this.lockOverlayEl = root.createDiv({ cls: "odyssey-lock-overlay" });
    this.lockOverlayEl.createEl("h3", { text: t("chat_lockOverlayTitle") });
    this.lockOverlayEl.createEl("p", { text: t("chat_lockOverlayBody") });
    const unlockButton = this.lockOverlayEl.createEl("button", { text: t("chat_unlockButton") });
    unlockButton.onclick = () => this.unlock();

    this.messagesEl = root.createDiv({ cls: "odyssey-messages" });
    this.setupEl = root.createDiv({ cls: "odyssey-setup-panel" });
    this.ephemeralBannerEl = root.createDiv({ cls: "odyssey-ephemeral-banner odyssey-hidden" });
    this.ephemeralBannerEl.createSpan({ text: t("chat_ephemeralBanner") });
    this.safetyNoteEl = root.createDiv({
      cls: "odyssey-safety-note",
      text: t("chatSafetyDisclaimer")
    });
    this.attachmentsEl = root.createDiv({ cls: "odyssey-attachments odyssey-hidden" });
    this.inputRowEl = root.createDiv({ cls: "odyssey-input-row" });
    const attachButton = this.inputRowEl.createEl("button", { attr: { "aria-label": t("chat_attachButtonLabel"), title: t("chat_attachButtonTitle") } });
    setIcon(attachButton, "plus");
    attachButton.onclick = () => {
      if (this.locked) return;
      this.fileInputEl.click();
    };
    this.fileInputEl = this.inputRowEl.createEl("input", {
      cls: "odyssey-file-input",
      attr: {
        type: "file",
        multiple: "true",
        accept: ".md,.markdown,.txt,.csv,.json,.yaml,.yml,.log,text/*,application/json"
      }
    });
    this.fileInputEl.onchange = () => {
      const files = Array.from(this.fileInputEl.files ?? []);
      this.attachmentImportJob = this.attachmentImportJob
        .then(() => this.addAttachedFiles(files))
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          this.plugin.notice(t("chat_attachFailed", { message }));
        });
    };
    this.inputEl = this.inputRowEl.createEl("textarea", { cls: "odyssey-input" });
    this.inputEl.placeholder = t("chat_inputPlaceholder");
    const sendButton = this.inputRowEl.createEl("button", { cls: "odyssey-send-button", attr: { "aria-label": t("chat_sendButton"), title: t("chat_sendButton") } });
    setIcon(sendButton, "send-horizontal");
    sendButton.onclick = () => this.send();
    this.inputEl.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.inputEl.addEventListener("compositionend", () => {
      this.composing = false;
    });
    this.inputEl.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        if (this.composing || event.isComposing) return;
        event.preventDefault();
        this.send();
      }
    });
    root.addEventListener("mousemove", () => this.resetAutoLock());
    root.addEventListener("keydown", () => this.resetAutoLock());

    this.locked = this.plugin.settings.lockOnOpen;
    this.messages = await this.plugin.store.readRecentConversationMessages(40);
    this.plugin.runtime.hydrateRecentMessages(this.messages);
    this.renderLockState();
    this.renderEphemeralState();
    this.renderSetupPanel();
    this.renderAttachedReferences();
    this.resetAutoLock();
    await this.render();
    this.scheduleScrollMessagesToBottom();
  }

  async onClose(): Promise<void> {
    this.messages = [];
    this.ephemeralMode = false;
    this.ephemeralEpoch += 1;
    this.plugin.runtime.endSession();
    if (this.autoLockTimer !== undefined) window.clearTimeout(this.autoLockTimer);
  }

  private async send(contentOverride?: string, options: { alignmentTest?: boolean } = {}): Promise<void> {
    if (this.locked) return;
    const content = (contentOverride ?? this.inputEl.value).trim();
    if (!content) return;
    await this.attachmentImportJob;
    if (!contentOverride) this.inputEl.value = "";
    const command = this.detectEphemeralCommand(content);
    if (command && !await this.confirmEphemeralCommand(command)) {
      await this.render();
      return;
    }
    const message: ChatMessage = { role: "user", content, created: new Date().toISOString(), ephemeral: this.ephemeralMode };
    this.messages.push(message);
    this.pendingSends.push({
      message,
      attachedReferences: this.attachedReferences.map(reference => ({ ...reference })),
      ephemeral: this.ephemeralMode,
      ephemeralEpoch: this.ephemeralEpoch,
      options
    });
    await this.render();
    await this.processPendingSends();
  }

  private async processPendingSends(): Promise<void> {
    if (this.sending) return;
    const next = this.pendingSends.shift();
    if (!next) return;
    this.sending = true;
    try {
      await this.render();
      const result = await this.plugin.runtime.sendMessage({
        message: next.message.content,
        attachedReferences: next.attachedReferences,
        ephemeral: next.ephemeral
      });
      if (next.ephemeral && next.ephemeralEpoch !== this.ephemeralEpoch) {
        this.plugin.runtime.endSession();
        return;
      }
      this.messages.push(...result.assistantMessages);
      if (next.options.alignmentTest && result.assistantMessages.length > 0) {
        this.pendingAlignmentFeedback = {
          prompt: next.message.content,
          response: result.assistantMessages.map(message => message.content).join("\n\n")
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.messages.push({ role: "assistant", content: t("chat_modelCallFailed", { message }), created: new Date().toISOString() });
    } finally {
      this.sending = false;
      await this.render();
      await this.processPendingSends();
    }
  }

  private waitForPaint(): Promise<void> {
    return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
  }

  private async addAttachedFiles(files: File[] | FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    if (this.locked) return;
    let added = 0;
    for (const file of Array.from(files).slice(0, 6)) {
      if (!isTextLikeFile(file)) {
        this.plugin.notice(t("chat_attachUnsupported", { name: file.name }));
        continue;
      }
      const text = await file.text();
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized) continue;
      const title = file.name;
      const summary = normalized.slice(0, 1200);
      const excerpt = text.trim().slice(0, 50000);
      const sourcePath = localFilePath(file);
      const id = attachmentId(file, sourcePath);
      this.attachedReferences = [
        ...this.attachedReferences.filter(reference => reference.id !== id),
        { id, title, path: sourcePath, summary, excerpt }
      ].slice(-6);
      added += 1;
    }
    this.fileInputEl.value = "";
    this.renderAttachedReferences();
    if (added > 0) this.plugin.notice(t("chat_attachAdded", { count: added }));
  }

  private renderAttachedReferences(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.empty();
    if (this.attachedReferences.length === 0) {
      this.attachmentsEl.addClass("odyssey-hidden");
      return;
    }
    this.attachmentsEl.removeClass("odyssey-hidden");
    this.attachmentsEl.createDiv({ cls: "odyssey-attachments-label", text: t("chat_attachmentsLabel") });
    const chips = this.attachmentsEl.createDiv({ cls: "odyssey-attachment-chips" });
    for (const reference of this.attachedReferences) {
      const chip = chips.createDiv({ cls: "odyssey-attachment-chip" });
      chip.createSpan({ text: reference.title });
      const remove = chip.createEl("button", { attr: { "aria-label": t("chat_removeAttachmentLabel", { title: reference.title }) } });
      setIcon(remove, "x");
      remove.onclick = () => {
        this.attachedReferences = this.attachedReferences.filter(item => item.id !== reference.id);
        this.renderAttachedReferences();
      };
    }
  }

  private scrollMessagesToBottom(): void {
    if (!this.messagesEl) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async render(): Promise<void> {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    for (const [index, message] of this.messages.entries()) {
      const key = this.messageKey(message, index);
      const errorPrefix = t("chat_modelCallFailed", { message: "" });
      const cls = message.content.startsWith(errorPrefix) ? " odyssey-message-error" : "";
      const row = this.messagesEl.createDiv({ cls: `odyssey-message-row odyssey-message-row-${message.role}` });
      row.createDiv({ cls: `odyssey-avatar odyssey-avatar-${message.role}`, text: this.avatarFor(message.role) });
      const item = row.createDiv({ cls: `odyssey-message odyssey-message-${message.role}${cls}` });
      const meta = item.createDiv({ cls: "odyssey-message-meta" });
      const select = meta.createEl("input", { cls: "odyssey-select-message", attr: { type: "checkbox", "aria-label": t("chat_selectMessageLabel") } });
      select.checked = this.selectedMessageKeys.has(key);
      select.onchange = () => {
        if (select.checked) this.selectedMessageKeys.add(key);
        else this.selectedMessageKeys.delete(key);
      };
      meta.createDiv({ cls: "odyssey-role", text: `${this.roleLabel(message.role)} ${this.formatTime(message.created)}` });
      if (message.ephemeral) meta.createDiv({ cls: "odyssey-ephemeral-mark", text: t("chat_ephemeralMessageMark") });
      const copyButton = meta.createEl("button", { cls: "odyssey-copy-button", attr: { "aria-label": t("chat_copyButtonLabel") } });
      setIcon(copyButton, "copy");
      copyButton.onclick = async () => {
        await navigator.clipboard.writeText(message.content);
        this.plugin.notice(t("chat_messageCopied"));
      };
      const contentEl = item.createDiv({ cls: "odyssey-message-content markdown-rendered" });
      if (message.role === "assistant" && !message.content.startsWith(t("chat_modelCallFailed", { message: "" }))) {
        await MarkdownRenderer.render(this.app, message.content, contentEl, this.plugin.settings.rootDir, this);
      } else {
        contentEl.setText(message.content);
      }
    }
    if (this.sending) this.renderPendingAssistantMessage();
    if (this.pendingAlignmentFeedback) this.renderAlignmentFeedbackPanel(this.pendingAlignmentFeedback);
    this.scheduleScrollMessagesToBottom();
  }

  private renderPendingAssistantMessage(): void {
    const row = this.messagesEl.createDiv({ cls: "odyssey-message-row odyssey-message-row-assistant odyssey-message-row-pending" });
    row.createDiv({ cls: "odyssey-avatar odyssey-avatar-assistant", text: this.avatarFor("assistant") });
    const item = row.createDiv({ cls: "odyssey-message odyssey-message-assistant odyssey-message-pending" });
    item.createDiv({ cls: "odyssey-message-meta" }).createDiv({ cls: "odyssey-role", text: `${this.roleLabel("assistant")} ${t("chat_thinking")}` });
    item.createDiv({ cls: "odyssey-message-content", text: this.pendingSends.length > 0 ? t("chat_thinkingQueued", { count: this.pendingSends.length }) : t("chat_thinking") });
  }

  private async startAlignmentTest(): Promise<void> {
    if (this.locked) {
      this.plugin.notice(t("chat_alignmentLocked"));
      return;
    }
    if (this.sending) {
      this.plugin.notice(t("chat_alignmentBusy"));
      return;
    }
    const question = await promptForText(this.app, {
      title: t("chat_alignmentTitle"),
      description: t("chat_alignmentDesc"),
      placeholder: t("chat_alignmentPlaceholder"),
      submitText: t("chat_alignmentSubmit")
    });
    if (!question?.trim()) return;
    await this.send(`${t("chat_alignmentPrefix")}${question.trim()}${t("chat_alignmentMessageSuffix")}`, { alignmentTest: true });
  }

  private renderAlignmentFeedbackPanel(feedbackPrompt: AlignmentFeedbackPrompt): void {
    const row = this.messagesEl.createDiv({ cls: "odyssey-feedback-row" });
    const panel = row.createDiv({ cls: "odyssey-feedback-panel" });
    panel.createEl("strong", { text: t("chat_alignmentFeedbackTitle") });
    panel.createEl("p", { text: t("chat_alignmentFeedbackDesc") });
    const textarea = panel.createEl("textarea", {
      cls: "odyssey-feedback-textarea",
      attr: { placeholder: t("chat_alignmentFeedbackPlaceholder") }
    });
    const actions = panel.createDiv({ cls: "odyssey-feedback-actions" });
    const skip = actions.createEl("button", { text: t("chat_alignmentFeedbackSkip") });
    const save = actions.createEl("button", { text: t("chat_alignmentFeedbackSave"), cls: "mod-cta" });
    skip.onclick = async () => {
      this.pendingAlignmentFeedback = null;
      await this.render();
    };
    save.onclick = async () => {
      const feedback = textarea.value.trim();
      if (!feedback) {
        textarea.focus();
        return;
      }
      const feedbackMessage: ChatMessage = {
        role: "user",
        content: `${t("chat_alignmentFeedbackPrefix")}${feedback}`,
        created: new Date().toISOString()
      };
      const conversationPath = await this.plugin.store.appendConversationMessage(feedbackMessage);
      this.messages.push(feedbackMessage);
      this.plugin.runtime.hydrateRecentMessages(this.messages);
      const id = await this.plugin.store.writeFeedback(
        "alignment_test",
        feedbackPrompt.prompt,
        feedbackPrompt.response,
        feedback,
        [this.plugin.store.anchorFor(conversationPath)]
      );
      this.pendingAlignmentFeedback = null;
      this.plugin.notice(t("chat_alignmentFeedbackSaved", { id }));
      await this.render();
    };
  }

  private async openIssueReport(): Promise<void> {
    if (this.locked) {
      this.plugin.notice(t("chat_issueLocked"));
      return;
    }
    const confirmed = await confirmText(this.app, {
      title: t("chat_issueTitle"),
      description: t("chat_issueDesc"),
      submitText: t("chat_issueSubmit")
    });
    if (!confirmed) return;
    window.open("https://github.com/meetodyssey/obsidian-odyssey/issues/new/choose", "_blank");
  }

  private lock(): void {
    this.locked = true;
    this.endEphemeralInterval(true);
    this.renderLockState();
  }

  private async unlock(): Promise<void> {
    const expectedHash = this.plugin.settings.privacyLockPasscodeHash;
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
        this.plugin.notice(t("chat_wrongPasscode"));
        return;
      }
    }
    this.locked = false;
    this.renderLockState();
    this.resetAutoLock();
    this.scheduleScrollMessagesToBottom();
    this.inputEl.focus();
  }

  private renderLockState(): void {
    if (!this.lockOverlayEl) return;
    this.lockOverlayEl.toggleClass("odyssey-hidden", !this.locked);
    this.messagesEl?.toggleClass("odyssey-hidden", this.locked);
    this.setupEl?.toggleClass("odyssey-hidden", this.locked || !this.shouldShowSetupPanel());
    this.safetyNoteEl?.toggleClass("odyssey-hidden", this.locked);
    this.ephemeralBannerEl?.toggleClass("odyssey-hidden", this.locked || !this.ephemeralMode);
    this.inputRowEl?.toggleClass("odyssey-hidden", this.locked);
    if (this.lockButtonEl) {
      this.lockButtonEl.disabled = this.locked;
      this.lockButtonEl.setAttr("aria-label", this.locked ? t("chat_lockedLabel") : t("chat_lockButtonLabel"));
    }
    this.renderEphemeralState();
  }

  private renderSetupPanel(): void {
    if (!this.setupEl) return;
    this.setupEl.empty();
    this.setupEl.toggleClass("odyssey-hidden", !this.shouldShowSetupPanel() || this.locked);
    if (!this.shouldShowSetupPanel()) return;

    this.setupEl.createEl("strong", { text: t("chat_setupTitle") });
    this.setupEl.createEl("p", { text: t("chat_setupDesc") });
    const actions = this.setupEl.createDiv({ cls: "odyssey-setup-actions" });
    const testButton = actions.createEl("button", { text: t("chat_setupTestButton") });
    testButton.onclick = async () => {
      testButton.setText(t("chat_setupTestingButton"));
      testButton.setAttr("disabled", "true");
      try {
        await this.plugin.testExtractionModel();
      } finally {
        testButton.removeAttribute("disabled");
        this.renderSetupPanel();
      }
    };
  }

  private shouldShowSetupPanel(): boolean {
    return this.plugin.settings.extractionModelProbeStatus === "unknown";
  }

  private resetAutoLock(): void {
    if (this.autoLockTimer !== undefined) window.clearTimeout(this.autoLockTimer);
    const minutes = this.plugin.settings.autoLockMinutes;
    if (!minutes || minutes <= 0 || this.locked) return;
    this.autoLockTimer = window.setTimeout(() => this.lock(), minutes * 60 * 1000);
  }

  private toggleEphemeralMode(): void {
    if (this.locked) return;
    this.ephemeralMode = !this.ephemeralMode;
    this.renderEphemeralState();
    this.plugin.notice(this.ephemeralMode ? t("chat_ephemeralEnabled") : t("chat_ephemeralDisabled"));
  }

  private endEphemeralInterval(endSession: boolean): void {
    if (!this.ephemeralMode && !this.messages.some(message => message.ephemeral)) return;
    this.ephemeralMode = false;
    if (endSession) this.ephemeralEpoch += 1;
    this.messages = this.messages.filter(message => !message.ephemeral);
    this.selectedMessageKeys.clear();
    if (endSession) this.plugin.runtime.endSession();
    this.renderEphemeralState();
  }

  private renderEphemeralState(): void {
    if (this.ephemeralButtonEl) {
      this.ephemeralButtonEl.toggleClass("is-active", this.ephemeralMode);
      this.ephemeralButtonEl.setAttr("aria-label", this.ephemeralMode ? t("chat_ephemeralButtonActiveLabel") : t("chat_ephemeralButtonLabel"));
      this.ephemeralButtonEl.setAttr("title", this.ephemeralMode ? t("chat_ephemeralButtonActiveTitle") : t("chat_ephemeralButtonTitle"));
    }
    this.ephemeralBannerEl?.toggleClass("odyssey-hidden", this.locked || !this.ephemeralMode);
  }

  private detectEphemeralCommand(content: string): "enable" | "disable" | null {
    const normalized = content.replace(/\s+/g, "").toLowerCase();
    if (includesAny(normalized, [
      "现在可以记录了", "可以记录了", "恢复记录", "恢复保存", "开始记录",
      "关闭阅后即焚", "结束阅后即焚", "退出阅后即焚", "不再阅后即焚",
      "youcansavethis", "youcanrecordthis", "startrecording", "stopephemeral"
    ])) return "disable";
    if (includesAny(normalized, [
      "这个不记录", "这段不记录", "这句不记录", "不要记录", "别记录",
      "这个不要保存", "这段不要保存", "不要保存", "别保存",
      "阅后即焚", "不保存的小秘密", "不要保存的小秘密", "小秘密别保存",
      "donotsavethis", "dontsavethis", "don'tsavethis", "donotrecordthis",
      "dontrecordthis", "keepthisephemeral", "ephemeralmode"
    ])) return "enable";
    return null;
  }

  private async confirmEphemeralCommand(command: "enable" | "disable"): Promise<boolean> {
    if (command === "enable") {
      if (this.ephemeralMode) return true;
      const confirmed = await confirmText(this.app, {
        title: t("chat_ephemeralConfirmEnableTitle"),
        description: t("chat_ephemeralConfirmEnableDesc"),
        submitText: t("chat_ephemeralConfirmEnableSubmit")
      });
      if (!confirmed) return false;
      this.ephemeralMode = true;
      this.renderEphemeralState();
      this.plugin.notice(t("chat_ephemeralEnabled"));
      return true;
    }
    if (!this.ephemeralMode) return true;
    const confirmed = await confirmText(this.app, {
      title: t("chat_ephemeralConfirmDisableTitle"),
      description: t("chat_ephemeralConfirmDisableDesc"),
      submitText: t("chat_ephemeralConfirmDisableSubmit")
    });
    if (!confirmed) return false;
    this.ephemeralMode = false;
    this.renderEphemeralState();
    this.plugin.notice(t("chat_ephemeralDisabled"));
    return true;
  }

  private roleLabel(role: ChatMessage["role"]): string {
    if (role === "user") return t("chat_roleMe");
    if (role === "assistant") return this.plugin.settings.odysseyName;
    return t("chat_roleSystem");
  }

  private scheduleScrollMessagesToBottom(): void {
    this.scrollMessagesToBottom();
    window.requestAnimationFrame(() => this.scrollMessagesToBottom());
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => this.scrollMessagesToBottom());
    });
    for (const delay of [50, 150, 350]) {
      window.setTimeout(() => this.scrollMessagesToBottom(), delay);
    }
  }

  private avatarFor(role: ChatMessage["role"]): string {
    if (role === "user") return this.compactAvatar(this.plugin.settings.userAvatar || "我");
    if (role === "assistant") return this.compactAvatar(this.plugin.settings.odysseyAvatar || "O");
    return "S";
  }

  private compactAvatar(value: string): string {
    const trimmed = value.trim();
    const chars = Array.from(trimmed);
    return chars.length > 3 ? chars.slice(0, 3).join("") : trimmed;
  }

  private formatTime(created?: string): string {
    if (!created) return "";
    const date = new Date(created);
    if (Number.isNaN(date.getTime())) return created;
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  private selectedMessages(): ChatMessage[] {
    return this.messages.filter((message, index) => this.selectedMessageKeys.has(this.messageKey(message, index)));
  }

  private messageKey(message: ChatMessage, index: number): string {
    return `${index}:${message.created ?? ""}:${message.role}`;
  }
}

interface PromptForTextOptions {
  title: string;
  description: string;
  placeholder: string;
  submitText: string;
  optional?: boolean;
  password?: boolean;
  trim?: boolean;
}

function promptForText(app: App, options: PromptForTextOptions): Promise<string | null> {
  return new Promise(resolve => {
    new OdysseyTextPromptModal(app, options, resolve).open();
  });
}

function confirmText(app: App, options: { title: string; description: string; submitText: string }): Promise<boolean> {
  return new Promise(resolve => {
    new OdysseyConfirmModal(app, options, resolve).open();
  });
}

function isTextLikeFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json") return true;
  return /\.(md|markdown|txt|csv|json|ya?ml|log)$/i.test(name);
}

function localFilePath(file: File): string {
  const maybePath = (file as unknown as { path?: unknown }).path;
  return typeof maybePath === "string" && maybePath.trim()
    ? maybePath
    : `attachment:${file.name}:${file.lastModified}`;
}

function attachmentId(file: File, sourcePath: string): string {
  const base = `${sourcePath}:${file.size}:${file.lastModified}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash + base.charCodeAt(i)) | 0;
  }
  return `att_${Math.abs(hash).toString(36)}`;
}

class OdysseyTextPromptModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly options: PromptForTextOptions,
    private readonly resolveValue: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("odyssey-prompt-modal");
    contentEl.createEl("h2", { text: this.options.title });
    contentEl.createEl("p", { text: this.options.description });
    const input = this.options.password
      ? contentEl.createEl("input", {
        cls: "odyssey-prompt-password",
        attr: {
          placeholder: this.options.placeholder,
          type: "password",
          autocomplete: "current-password",
          inputmode: "text"
        }
      })
      : contentEl.createEl("textarea", {
        cls: "odyssey-prompt-textarea",
        attr: { placeholder: this.options.placeholder }
      });
    const actions = contentEl.createDiv({ cls: "odyssey-prompt-actions" });
    const cancel = actions.createEl("button", { text: t("chat_cancel") });
    const submit = actions.createEl("button", { text: this.options.submitText, cls: "mod-cta" });

    const finish = (value: string | null) => {
      if (this.resolved) return;
      this.resolved = true;
      this.resolveValue(value);
      this.close();
    };

    cancel.onclick = () => finish(null);
    submit.onclick = () => {
      const value = this.options.trim === false ? input.value : input.value.trim();
      if (!value && !this.options.optional) return;
      finish(value);
    };
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      const shouldSubmit = this.options.password
        ? event.key === "Enter"
        : (event.ctrlKey || event.metaKey) && event.key === "Enter";
      if (shouldSubmit) {
        event.preventDefault();
        submit.click();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolveValue(null);
    }
  }
}

class OdysseyConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly options: { title: string; description: string; submitText: string },
    private readonly resolveValue: (value: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("odyssey-prompt-modal");
    contentEl.createEl("h2", { text: this.options.title });
    contentEl.createEl("p", { text: this.options.description });
    const actions = contentEl.createDiv({ cls: "odyssey-prompt-actions" });
    const cancel = actions.createEl("button", { text: t("chat_cancel") });
    const submit = actions.createEl("button", { text: this.options.submitText, cls: "mod-cta" });

    const finish = (value: boolean) => {
      if (this.resolved) return;
      this.resolved = true;
      this.resolveValue(value);
      this.close();
    };

    cancel.onclick = () => finish(false);
    submit.onclick = () => finish(true);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolveValue(false);
    }
  }
}
