import { load, type Store } from "@tauri-apps/plugin-store";
import type { ConflictStrategy, SyncState } from "@cloud-drive-sync/core";

export interface TauriAppSettings {
	s3: {
		endpoint: string;
		bucket: string;
		accessKey: string;
		secretKey: string;
		region: string;
	};
	localFolder: string;
	// prompt/smart-merge have no UI here and degrade to latest-wins behavior
	conflictStrategy: ConflictStrategy;
	syncIntervalMinutes: number;
	lastSyncTime: number;
}

export const DEFAULT_SETTINGS: TauriAppSettings = {
	s3: { endpoint: "", bucket: "", accessKey: "", secretKey: "", region: "us-east-1" },
	localFolder: "",
	conflictStrategy: "latest-wins",
	syncIntervalMinutes: 15,
	lastSyncTime: 0,
};

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
	if (!storePromise) storePromise = load("settings.json", { autoSave: true });
	return storePromise;
}

export async function loadSettings(): Promise<TauriAppSettings> {
	const store = await getStore();
	const saved = await store.get<TauriAppSettings>("settings");
	return { ...DEFAULT_SETTINGS, ...saved, s3: { ...DEFAULT_SETTINGS.s3, ...saved?.s3 } };
}

export async function saveSettings(settings: TauriAppSettings): Promise<void> {
	const store = await getStore();
	await store.set("settings", settings);
}

// State file for MirrorSyncEngine's SyncStateStore — kept separate from user
// settings since it's per-file sync bookkeeping, not configuration.
export async function loadSyncState(): Promise<SyncState> {
	const store = await getStore();
	const saved = await store.get<SyncState>("syncState");
	return saved ?? { files: {}, lastSyncTime: 0 };
}

export async function saveSyncState(state: SyncState): Promise<void> {
	const store = await getStore();
	await store.set("syncState", state);
}
