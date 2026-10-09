# VaultSync

**VaultSync** syncs an Obsidian vault with a GitHub repository using the GitHub API — no Git binary needed, so it works out of the box on desktop and mobile (iOS & Android).

Forked from [rahuletto/supersync](https://github.com/rahuletto/supersync). Differences from upstream:

- **Repository-root sync.** The vault syncs to the repository root (plus an optional root-path subfolder), so repo paths mirror vault paths 1:1. The old `<vault-name>/` nesting is still available as a setting.
- **No content rewriting.** Files are synced byte-for-byte. The plugin never strips frontmatter keys, removes headings, or writes metadata sidecars into your vault.
- **Bring-your-own GitHub App.** Sign-in uses the device flow against a GitHub App *you* create, with fine-grained permissions — no broad `repo`-scope OAuth, no stranger's client ID. Tokens rotate automatically (8h access / 6-month refresh).
- **No README replacement.** Your repo's README is yours; the plugin never touches it.

## Setup

### 1. Create a GitHub App (a few minutes, once per person)

1. Go to GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**.
2. Name it anything, homepage URL can be your profile. Uncheck webhook **Active**.
3. Permissions: **Contents → Read and write**.
4. Check **Enable Device Flow**.
5. "Where can this GitHub App be installed?" → **Only on this account** (or your org).
6. Create, then **Install** it on the repository holding your vault.
7. Note the **Client ID** on the app's settings page.

### 2. Install the plugin

The easiest path is [BRAT](https://github.com/TfTHacker/obsidian42-brat) (install it from Obsidian's community plugins, then *Add Beta plugin* with this repo's URL). BRAT tracks releases here and auto-updates.

Manual install also works: download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/sjlevin/VaultSync/releases) into `<vault>/.obsidian/plugins/vaultsync/`.

### 3. Configure

In Obsidian: Settings → **VaultSync**.

1. Paste your GitHub App **client ID**.
2. Click **Sign in with GitHub**, enter the code at `github.com/login/device`.
3. Set **Repository** to your vault repo (e.g. `vault`), **Branch** to `main`.
4. Leave **Root path** empty to sync the repository root. Turn on **Nest under vault-name folder** only if you want the old SuperSync layout.
5. Hit **Sync now**. The first sync downloads the repo into the vault (or uploads the vault, if the repo is empty).

Each device signs in separately — tokens are per-device, so you can revoke one without affecting the others. The token itself is stored locally and never synced to the repo.

## Sync behavior

- **Automatic**: on startup, after file changes (3s debounce), and on a timer (default 5 minutes). All configurable.
- **Conflicts**: if a file changed on both sides, you choose per file — keep local, keep remote, or keep both (remote saved as `name.conflict-<timestamp>.ext`). Nothing is ever silently overwritten.
- **Deletes** propagate both ways. **File history**: browse a note's past versions from its commits and restore from the plugin.
- **Ignore rules**: glob-ish patterns, one per line. Defaults ignore `.git/`, `.trash/`, workspace state, the plugin's own token file, and `.DS_Store`.

## Development

```sh
bun install
bun run build   # typecheck + bundle to main.js
bun test        # sync-core unit tests
```

Cutting a release: run the *Build & Draft Release* workflow with a version number; it bumps the manifests, builds, and drafts a GitHub release with the plugin assets.

## License

GNU General Public License v3.0 — see [LICENSE](./LICENSE). Forked from [rahuletto/supersync](https://github.com/rahuletto/supersync) ( © Rahuletto, GPL-3.0 ).
