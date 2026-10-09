
export interface Settings {
  token: string;
  /** Rotating refresh token from the GitHub App device flow (empty for PATs). */
  refreshToken: string;
  /** Epoch ms when `token` expires (0 = unknown / non-expiring). */
  tokenExpiresAt: number;
  deviceFlowClientId: string;
  owner: string;
  repo: string;
  branch: string;
  /**
   * Fingerprint of {owner, repo, branch, rootPath, nestUnderVaultName} from
   * the last sync. When it changes, the manifest is reset: the old manifest
   * describes a different remote, and reusing it could plan a mass delete.
   */
  syncScope: string;
  rootPath: string;
  nestUnderVaultName: boolean;
  authorName: string;
  authorEmail: string;
  autoSync: boolean;
  syncOnStartup: boolean;
  syncOnFileChange: boolean;
  intervalMinutes: number;
  syncObsidianConfig: boolean;
  syncCommunityPlugins: boolean;
  /** When community-plugin sync is on, also sync plugins' data.json files. */
  syncPluginDataJson: boolean;
  ignorePatterns: string;
}

export interface VersionEntry {
  sha: string;
  message: string;
  date: string;
}

export interface SyncLogEntry {
  startedAt: string;
  endedAt: string;
  reason: string;
  status: "success" | "error";
  changes: number;
  uploads: number;
  downloads: number;
  deletes: number;
  conflicts: number;
  commitSha?: string;
  error?: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Token response from the GitHub App device / refresh flow. */
export interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export type ConflictResolution = "local" | "remote" | "both";

export const DEFAULT_SETTINGS: Settings = {
  token: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  deviceFlowClientId: "Iv23liCtNaUnNil38AO1",
  owner: "",
  repo: "",
  branch: "main",
  syncScope: "",
  rootPath: "",
  nestUnderVaultName: false,
  authorName: "Shaun Levin",
  authorEmail: "sjlevin@users.noreply.github.com",
  autoSync: true,
  syncOnStartup: true,
  syncOnFileChange: true,
  intervalMinutes: 5,
  syncObsidianConfig: true,
  syncCommunityPlugins: false,
  syncPluginDataJson: false,
  ignorePatterns: "",
};
