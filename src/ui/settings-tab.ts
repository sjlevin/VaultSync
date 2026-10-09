import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { Settings, DEFAULT_SETTINGS } from "../types";
import type VaultSyncPlugin from "../../main";

export class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Sync Configuration").setHeading();
    const isAuthorized = Boolean(this.plugin.settings.token);

    if (isAuthorized) {
      new Setting(containerEl)
        .setName("GitHub signed in")
        .setDesc(
          "You are authenticated with GitHub on this device. Forgetting removes the tokens from this device only — to revoke them on GitHub's side, open github.com → Settings → Applications → Authorized GitHub Apps.",
        )
        .addButton((button) =>
          button
            .setButtonText("Forget on this device")
            .setWarning()
            .onClick(async () => {
              this.plugin.githubClient.authGeneration++;
              this.plugin.settings.token = "";
              this.plugin.settings.refreshToken = "";
              this.plugin.settings.tokenExpiresAt = 0;
              this.plugin.settings.owner = "";
              await this.plugin.saveSettings();
              this.plugin.refreshStatusViews();
              this.display();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("GitHub device sign-in")
        .setDesc(
          "Uses the GitHub App device flow: enter a short code at github.com/login/device. No tokens to copy.",
        )
        .addButton((button) =>
          button
            .setButtonText("Sign in with GitHub")
            .setCta()
            .onClick(() => void this.plugin.startDeviceFlowLogin()),
        );
    }
    this.repoLink();
    this.text(
      "Repository name",
      "Name of the GitHub repository holding this vault. The GitHub App must be installed on it. Syncing never creates a repository implicitly — use the button below if you need one.",
      "repo",
    );
    this.text(
      "Branch",
      "Branch to sync with (default: main).",
      "branch",
    );
    new Setting(containerEl)
      .setName("Create repository on GitHub")
      .setDesc(
        "Creates a new private repository with the name above, then install your GitHub App on it. Explicit on purpose: a typo'd name must never silently become an empty repo.",
      )
      .addButton((button) =>
        button.setButtonText("Create repository").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.githubClient.createRepository();
            new Notice(
              `Repository ${this.plugin.settings.repo} created. Install your GitHub App on it, then sync.`,
              8000,
            );
            this.display();
          } catch (error) {
            new Notice(
              `Create failed: ${error instanceof Error ? error.message : String(error)}`,
              10000,
            );
          } finally {
            button.setDisabled(false);
          }
        }),
      );
    this.text(
      "GitHub App client ID",
      "Defaults to the plugin author's GitHub App. To be independent of it, create your own app (github.com → Settings → Developer settings → GitHub Apps; Contents read/write permission, device flow enabled) and paste its client ID here.",
      "deviceFlowClientId",
    );
    this.text("Root path", "Optional subfolder inside the repo. Empty means the repository root.", "rootPath");
    this.toggle(
      "Nest under vault-name folder",
      "When off (recommended), the vault syncs to the repository root (plus the root path above). When on, files live under a <vault-name> folder, like the original SuperSync.",
      "nestUnderVaultName",
    );
    this.toggle(
      "Automatic sync",
      "Run startup/change/interval syncs",
      "autoSync",
    );
    this.toggle("Sync on startup", "", "syncOnStartup");
    this.toggle("Sync after file changes", "", "syncOnFileChange");
    new Setting(containerEl).setName("Interval minutes").addText((text) =>
      text
        .setValue(String(this.plugin.settings.intervalMinutes))
        .onChange(async (value) => {
          this.plugin.settings.intervalMinutes = Math.max(
            1,
            Number(value) || DEFAULT_SETTINGS.intervalMinutes,
          );
          await this.plugin.saveSettings();
        }),
    );
    this.toggle(
      `Sync configuration folder (${this.app.vault.configDir})`,
      "Syncs a small allowlist of Obsidian settings files (app, appearance, core plugins, hotkeys). Never syncs this plugin's own folder or any JavaScript.",
      "syncObsidianConfig",
    );
    this.toggle(
      "Sync community plugins",
      "Syncs only each plugin's data.json (its settings), and only while \"Sync plugin data.json\" below is also on. JavaScript, manifest.json, styles.css and this plugin's own folder are never synced.",
      "syncCommunityPlugins",
    );
    this.toggle(
      "Sync plugin data.json",
      "data.json often holds API keys. Off by default; with it off, community plugin sync carries nothing.",
      "syncPluginDataJson",
    );
    this.text("Commit author name", "Name recorded as the author of sync commits.", "authorName");
    this.text("Commit author email", "Email recorded as the author of sync commits.", "authorEmail");
    const ignoreSetting = new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc(
        "One glob-ish pattern per line. Supports exact paths, /** folder prefixes, * wildcards.",
      );
    ignoreSetting.settingEl.addClass("vaultsync-ignore-setting");

    ignoreSetting.addTextArea((text) => {
      text.inputEl.rows = 6;
      text.inputEl.addClass("vaultsync-ignore-textarea");
      text.setPlaceholder(".git/**\n.trash/**\n.DS_Store");
      text
        .setValue(this.plugin.settings.ignorePatterns)
        .onChange(async (value) => {
          this.plugin.settings.ignorePatterns = value;
          await this.plugin.saveSettings();
        });
    });
    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Sync now")
        .setCta()
        .onClick(() => void this.plugin.sync("settings")),
    );
    containerEl.createDiv({
      cls: "private-github-sync-status",
      text: "Safety: all files are synced as bytes. If local and remote both changed, the remote copy is saved as a conflict file and local data is preserved.",
    });
  }

  private text<K extends keyof Settings>(name: string, desc: string, key: K) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        if (key === "token") text.inputEl.type = "password";
        text
          .setValue(String(this.plugin.settings[key] ?? ""))
          .onChange(async (value) => {
            (this.plugin.settings[key] as string) = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }

  private repoLink() {
    const { owner, repo } = this.plugin.settings;
    const url = owner && repo
      ? `https://github.com/${owner}/${repo}`
      : null;

    const setting = new Setting(this.containerEl)
      .setName("Repository");

    if (url) {
      const a = setting.descEl.createEl("a", {
        text: `${owner}/${repo}`,
        href: url,
      });
      a.setAttr("target", "_blank");
      a.setAttr("rel", "noopener noreferrer");
    } else {
      setting.setDesc("No repository configured.");
    }
  }

  private toggle<K extends keyof Settings>(name: string, desc: string, key: K) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings[key]))
          .onChange(async (value) => {
            (this.plugin.settings[key] as boolean) = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
