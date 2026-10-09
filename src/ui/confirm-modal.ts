import { App, Modal, Setting } from "obsidian";

/**
 * A simple yes/no confirmation dialog. Resolves false if the user cancels,
 * closes the modal, or presses Escape.
 */
export class ConfirmModal extends Modal {
  private resolver?: (value: boolean) => void;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmLabel = "Continue",
  ) {
    super(app);
  }

  confirm(): Promise<boolean> {
    this.open();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.message });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.resolver?.(false);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(this.confirmLabel)
          .setCta()
          .onClick(() => {
            this.resolver?.(true);
            this.close();
          }),
      );
  }

  onClose() {
    this.contentEl.empty();
    this.resolver?.(false);
  }
}
