export const PLUGIN_ID = "vaultsync";
export const VIEW_TYPE_SYNC_STATUS = "private-github-sync-status";
export const CONFLICT_STAMP = /[:.]/g;
export const GITHUB_BLOB_LIMIT = 100 * 1024 * 1024;
export const GITHUB_RECOMMENDED_BLOB_LIMIT = 50 * 1024 * 1024;
/** Local delete/overwrite backups older than this are pruned during sync. */
export const BACKUP_RETENTION_DAYS = 30;
