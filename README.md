# VaultSync

**VaultSync** syncs an Obsidian vault with a GitHub repository using the GitHub API — no Git binary needed, so it works out of the box on desktop and mobile (iOS & Android).

Forked from [rahuletto/supersync](https://github.com/rahuletto/supersync). Differences from upstream:

- **Repository-root sync.** The vault syncs to the repository root (plus an optional root-path subfolder), so repo paths mirror vault paths 1:1. The old `<vault-name>/` nesting is still available as a setting.
- **No content rewriting.** Files are synced byte-for-byte. The plugin never strips frontmatter keys, removes headings, or writes metadata sidecars into your vault.
- **GitHub App sign-in.** Sign-in uses the device flow against a GitHub App with fine-grained permissions — no broad `repo`-scope OAuth. The plugin defaults to the author's GitHub App client ID for convenience; paste your own App's client ID to be independent of it. Tokens rotate automatically (8h access / 6-month refresh).
- **No README replacement.** `README.md` at the repository root is in the default ignore rules, so your repo's README stays yours.

## Setup

### 1. Install the plugin

The easiest path is [BRAT](https://github.com/TfTHacker/obsidian42-brat) (install it from Obsidian's community plugins, then *Add Beta plugin* with this repo's URL). BRAT tracks releases here and auto-updates.

Manual install also works: download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/sjlevin/VaultSync/releases) into `<vault>/.obsidian/plugins/vaultsync/`.

### 2. Configure

In Obsidian: Settings → **VaultSync**.

1. Click **Sign in with GitHub**, enter the code at `github.com/login/device`. (This uses the default GitHub App; see below to use your own.)
2. Set **Repository name** to your vault repo (e.g. `vault`) and **Branch** to `main`. If the repo doesn't exist yet, use the **Create repository** button — syncing never creates repositories on its own, so a typo'd name fails loudly instead of becoming an empty repo.
3. Leave **Root path** empty to sync the repository root. Turn on **Nest under vault-name folder** only if you want the old SuperSync layout.
4. Hit **Sync now**. The first sync downloads the repo into the vault (or uploads the vault, if the repo is empty).

Each device signs in separately — tokens are per-device, so you can revoke one without affecting the others. The token itself is stored locally and never synced to the repo. "Forget on this device" removes the tokens locally; to revoke them on GitHub's side, open github.com → Settings → Applications → Authorized GitHub Apps.

### Optional: use your own GitHub App

If you'd rather not depend on the author's App, create your own (a few minutes, once per person):

1. Go to GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**.
2. Name it anything, homepage URL can be your profile. Uncheck webhook **Active**.
3. Permissions: **Contents → Read and write**.
4. Check **Enable Device Flow**.
5. "Where can this GitHub App be installed?" → **Only on this account** (or your org).
6. Create, then **Install** it on the repository holding your vault.
7. Paste the app's **Client ID** into the plugin's **GitHub App client ID** setting, then sign in.

## Sync behavior

- **Automatic**: on startup, after file changes (3s debounce), and on a timer (default 5 minutes). All configurable. Auto-sync pauses while GitHub rate-limits you. Background syncs never open dialogs: if one hits a conflict or a mass-delete check, it stops with a notice and waits for you to run **Sync now**.
- **Conflicts**: if a file changed on both sides, you choose per file — keep local, keep remote, or keep both (remote saved as `name.conflict-<timestamp>.ext`, which is uploaded on the next sync). Cancelling the dialog cancels the sync; it never silently picks for you. A file you edit while a sync is running is left alone and the sync stops with a notice to run **Sync now**.
- **Deletes** propagate both ways, with local backups. **File history**: browse a note's past versions from its commits and restore from the plugin (the live file is backed up first).
- **Backups**: overwritten and deleted files are copied under `.github-sync-backup/<timestamp>/` (local only, never uploaded, pruned after 30 days).
- **Ignore rules**: glob-ish patterns, one per line, matched case- and Unicode-form-insensitively. Defaults ignore `.git/`, `.trash/`, `.github-sync-backup/`, the root `README.md`, workspace state, and `.DS_Store`; the first three are also enforced in code and cannot be re-enabled.
- **Skipped files**: a remote entry whose name is unsafe, collides with another entry (differs only by case or Unicode form), is over GitHub's 100 MB limit, or is not a regular file is left untouched on both sides and reported in the console, as are local files whose names collide with each other.

## Security model

- The plugin's own folder (`.obsidian/plugins/vaultsync/`, including its token file) is **never synced**, enforced in code — not via the editable ignore list — and matched case-insensitively so `.Obsidian/…` aliases can't slip past on macOS or Windows.
- No JavaScript (`.js`, `.mjs`, `.cjs`, `.jsx`, as a file or a folder name) under the Obsidian config dir is ever downloaded or uploaded, so a hostile commit can't replace executable plugin code.
- Obsidian settings sync is an allowlist (`app.json`, `appearance.json`, `core-plugins.json`, `hotkeys.json`). Community plugin sync, if you opt in, carries only each plugin's `data.json`, and only while "Sync plugin data.json" is also on (it is off by default, since `data.json` often holds API keys): `manifest.json`, `styles.css` and everything else in a plugin folder stay local, since a synced `manifest.json` could repoint a plugin's entry file.
- Remote file paths are validated (`..`, absolute paths, control characters, Windows-reserved names, etc. are rejected), local files with such names are skipped rather than uploaded, and every local write is containment-checked against the vault root.
- Downloads — sync and version restore alike — verify the blob hash before writing, every object id taken from an API response is checked before it is used in a URL, and large-file redirects are only followed to GitHub's own hosts.
- Changing the repository/branch/path resets the sync baseline, and a sync that would delete more than 25% (or 10 or more) of the files on either side asks for confirmation first.

## Security notes

- Tokens are stored in plaintext in this plugin's `data.json` under `.obsidian/plugins/vaultsync/`. That file is excluded from this plugin's sync, but anything else that copies the vault (Obsidian Sync, iCloud/Dropbox/OneDrive, backups) will copy it too. Use "Forget on this device" before handing a vault copy to anyone, and revoke the app's authorization on GitHub if a copy may have leaked.
- Local writes are containment-checked against the vault root by path only. A symlinked folder inside the vault is followed by the filesystem and is not protected by that check.
- Backups under `.github-sync-backup/` are pruned on the next successful sync once they are older than 30 days.

## Development

```sh
bun install
bun run build   # typecheck + bundle to main.js
bun test        # sync-core unit tests
```

Cutting a release: run the *Build & Draft Release* workflow with a version number; it bumps the manifests, builds, and drafts a GitHub release with the plugin assets.

## License

GNU General Public License v3.0 — see [LICENSE](./LICENSE). Forked from [rahuletto/supersync](https://github.com/rahuletto/supersync) ( © Rahuletto, GPL-3.0 ).
