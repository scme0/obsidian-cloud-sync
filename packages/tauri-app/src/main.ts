import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { S3Provider, SyncStateStore, SyncEngine, type ConflictStrategy } from "@cloud-drive-sync/core";
import { TauriHttpClient } from "./http/tauri-http-client";
import { TauriLocalFileSystem } from "./fs/tauri-local-fs";
import { TauriSyncUI } from "./sync/tauri-sync-ui";
import { watchForStableChanges } from "./fs/watch-stable";
import { loadSettings, saveSettings, loadSyncState, saveSyncState, type TauriAppSettings } from "./store/settings-store";

const els = {
	endpoint: document.querySelector<HTMLInputElement>("#endpoint")!,
	bucket: document.querySelector<HTMLInputElement>("#bucket")!,
	accessKey: document.querySelector<HTMLInputElement>("#accessKey")!,
	secretKey: document.querySelector<HTMLInputElement>("#secretKey")!,
	region: document.querySelector<HTMLInputElement>("#region")!,
	conflictStrategy: document.querySelector<HTMLSelectElement>("#conflictStrategy")!,
	localFolder: document.querySelector<HTMLInputElement>("#localFolder")!,
	syncIntervalMinutes: document.querySelector<HTMLInputElement>("#syncIntervalMinutes")!,
	chooseFolder: document.querySelector<HTMLButtonElement>("#chooseFolder")!,
	save: document.querySelector<HTMLButtonElement>("#save")!,
	syncNow: document.querySelector<HTMLButtonElement>("#syncNow")!,
	status: document.querySelector<HTMLParagraphElement>("#status")!,
};

let settings: TauriAppSettings;
let stopWatching: (() => void) | null = null;
let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let syncing = false;

function fillForm(s: TauriAppSettings): void {
	els.endpoint.value = s.s3.endpoint;
	els.bucket.value = s.s3.bucket;
	els.accessKey.value = s.s3.accessKey;
	els.secretKey.value = s.s3.secretKey;
	els.region.value = s.s3.region;
	els.conflictStrategy.value = s.conflictStrategy;
	els.localFolder.value = s.localFolder;
	els.syncIntervalMinutes.value = String(s.syncIntervalMinutes);
}

function readForm(): TauriAppSettings {
	return {
		s3: {
			endpoint: els.endpoint.value.trim().replace(/\/$/, ""),
			bucket: els.bucket.value.trim(),
			accessKey: els.accessKey.value.trim(),
			secretKey: els.secretKey.value.trim(),
			region: els.region.value.trim() || "us-east-1",
		},
		localFolder: els.localFolder.value,
		conflictStrategy: (els.conflictStrategy.value || "latest-wins") as ConflictStrategy,
		syncIntervalMinutes: Number(els.syncIntervalMinutes.value) || 0,
		lastSyncTime: settings?.lastSyncTime ?? 0,
	};
}

function setStatus(text: string): void {
	els.status.textContent = text;
}

function isConfigured(s: TauriAppSettings): boolean {
	return !!(s.s3.endpoint && s.s3.bucket && s.s3.accessKey && s.s3.secretKey && s.localFolder);
}

async function runSync(): Promise<void> {
	if (syncing) return;
	if (!isConfigured(settings)) {
		setStatus("Configure S3 + local folder first");
		return;
	}

	syncing = true;
	setStatus("Syncing…");
	try {
		const provider = new S3Provider(settings.s3, new TauriHttpClient());
		const syncState = await loadSyncState();
		const stateStore = new SyncStateStore(syncState, () => saveSyncState(syncState));
		const engine = new SyncEngine(
			new TauriLocalFileSystem(), settings.localFolder,
			provider, stateStore,
			new TauriSyncUI(settings.conflictStrategy),
			{ conflictStrategy: settings.conflictStrategy, excludePatterns: [] },
		);
		engine.onNotice = (msg) => setStatus(msg);

		const result = await engine.sync();

		settings.lastSyncTime = Date.now();
		await saveSettings(settings);

		const parts: string[] = [];
		if (result.uploaded) parts.push(`${result.uploaded} uploaded`);
		if (result.downloaded) parts.push(`${result.downloaded} downloaded`);
		if (result.deleted) parts.push(`${result.deleted} deleted`);
		if (result.errors) parts.push(`${result.errors} errors`);
		setStatus(parts.length ? `Synced: ${parts.join(", ")}` : "Everything up to date");
	} catch (e) {
		setStatus(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		syncing = false;
	}
}

async function restartWatcher(): Promise<void> {
	stopWatching?.();
	stopWatching = null;
	if (!settings.localFolder) return;
	stopWatching = await watchForStableChanges(settings.localFolder, new TauriLocalFileSystem(), () => {
		void runSync();
	});
}

function restartInterval(): void {
	if (syncIntervalId !== null) clearInterval(syncIntervalId);
	syncIntervalId = null;
	if (settings.syncIntervalMinutes > 0) {
		syncIntervalId = setInterval(() => void runSync(), settings.syncIntervalMinutes * 60 * 1000);
	}
}

async function init(): Promise<void> {
	settings = await loadSettings();
	fillForm(settings);
	await restartWatcher();
	restartInterval();

	els.chooseFolder.addEventListener("click", async () => {
		const chosen = await open({ directory: true, multiple: false });
		if (typeof chosen === "string") els.localFolder.value = chosen;
	});

	els.save.addEventListener("click", async () => {
		settings = readForm();
		await saveSettings(settings);
		await restartWatcher();
		restartInterval();
		setStatus("Settings saved");
	});

	els.syncNow.addEventListener("click", () => void runSync());

	await listen("tray-sync-now", () => void runSync());

	// Best-effort startup update check — GitHub Releases-backed, see
	// tauri.conf.json's updater.endpoints and packages/tauri-app/../release CI.
	try {
		const update = await check();
		if (update) {
			setStatus(`Updating to ${update.version}…`);
			await update.downloadAndInstall();
			await relaunch();
		}
	} catch (e) {
		console.error("Update check failed:", e);
	}
}

void init();
