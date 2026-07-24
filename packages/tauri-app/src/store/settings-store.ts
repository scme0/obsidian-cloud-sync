import { load, type Store } from "@tauri-apps/plugin-store";
import type { ConflictStrategy, SyncState } from "@cloud-drive-sync/core";

// One local-folder ↔ remote-bucket mapping. Endpoint + credentials are shared
// across all pairs (same rclone instance / same keys); only the bucket (a
// top-level dir under the Drive root) and the local folder differ per pair.
export const DEFAULT_CONFLICT_STRATEGY: ConflictStrategy = "latest-wins";

export interface SyncPair {
	id: string;
	bucket: string;
	localFolder: string;
	// Per-pair override; undefined = DEFAULT_CONFLICT_STRATEGY (latest-wins)
	conflictStrategy?: ConflictStrategy;
}

export interface TauriAppSettings {
	s3: {
		endpoint: string;
		accessKey: string;
		secretKey: string;
		region: string;
	};
	pairs: SyncPair[];
	paused: boolean;
	syncIntervalMinutes: number;
	lastSyncTime: number;
}

export const DEFAULT_SETTINGS: TauriAppSettings = {
	s3: { endpoint: "", accessKey: "", secretKey: "", region: "us-east-1" },
	pairs: [],
	paused: false,
	syncIntervalMinutes: 15,
	lastSyncTime: 0,
};

export function newPairId(): string {
	return `pair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Old single-bucket/single-folder settings shape, for one-time migration.
interface LegacySettings {
	s3?: { endpoint?: string; bucket?: string; accessKey?: string; secretKey?: string; region?: string };
	bucket?: string;
	localFolder?: string;
	pairs?: SyncPair[];
	paused?: boolean;
	syncIntervalMinutes?: number;
	lastSyncTime?: number;
}

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
	if (!storePromise) storePromise = load("settings.json", { autoSave: true });
	return storePromise;
}

export async function loadSettings(): Promise<TauriAppSettings> {
	const store = await getStore();
	const saved = (await store.get<LegacySettings>("settings")) ?? {};

	const s3 = {
		endpoint: saved.s3?.endpoint ?? DEFAULT_SETTINGS.s3.endpoint,
		accessKey: saved.s3?.accessKey ?? DEFAULT_SETTINGS.s3.accessKey,
		secretKey: saved.s3?.secretKey ?? DEFAULT_SETTINGS.s3.secretKey,
		region: saved.s3?.region ?? DEFAULT_SETTINGS.s3.region,
	};

	let pairs = saved.pairs ?? [];
	// Migrate a legacy single bucket+folder into one pair.
	if (pairs.length === 0 && saved.localFolder && (saved.s3?.bucket || saved.bucket)) {
		pairs = [{
			id: newPairId(),
			bucket: (saved.s3?.bucket ?? saved.bucket)!,
			localFolder: saved.localFolder,
		}];
	}

	return {
		s3,
		pairs,
		paused: saved.paused ?? false,
		syncIntervalMinutes: saved.syncIntervalMinutes ?? DEFAULT_SETTINGS.syncIntervalMinutes,
		lastSyncTime: saved.lastSyncTime ?? 0,
	};
}

export async function saveSettings(settings: TauriAppSettings): Promise<void> {
	const store = await getStore();
	await store.set("settings", settings);
}

// Sync state is per-pair (paths from different folders must not collide in one
// state map), keyed by pair id.
export async function loadSyncState(pairId: string): Promise<SyncState> {
	const store = await getStore();
	const saved = await store.get<SyncState>(`syncState:${pairId}`);
	return saved ?? { files: {}, lastSyncTime: 0 };
}

export async function saveSyncState(pairId: string, state: SyncState): Promise<void> {
	const store = await getStore();
	await store.set(`syncState:${pairId}`, state);
}

export async function deleteSyncState(pairId: string): Promise<void> {
	const store = await getStore();
	await store.delete(`syncState:${pairId}`);
}
