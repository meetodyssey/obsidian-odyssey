import { App, Modal } from "obsidian";
import { t } from "../i18n";

export interface PromptForTextOptions {
  title: string;
  description: string;
  placeholder: string;
  submitText: string;
  optional?: boolean;
  password?: boolean;
  trim?: boolean;
}

export function promptForText(app: App, options: PromptForTextOptions): Promise<string | null> {
  return new Promise(resolve => {
    new OdysseyTextPromptModal(app, options, resolve).open();
  });
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
