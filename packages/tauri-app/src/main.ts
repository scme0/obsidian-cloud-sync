import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { S3Provider, SyncStateStore, SyncEngine, type ConflictStrategy, type SyncResult } from "@cloud-drive-sync/core";
import { TauriHttpClient } from "./http/tauri-http-client";
import { TauriLocalFileSystem } from "./fs/tauri-local-fs";
import { TauriSyncUI } from "./sync/tauri-sync-ui";
import { watchForStableChanges } from "./fs/watch-stable";
import {
	loadSettings, saveSettings, loadSyncState, saveSyncState, deleteSyncState,
	newPairId, type SyncPair, type TauriAppSettings,
} from "./store/settings-store";

const els = {
	endpoint: document.querySelector<HTMLInputElement>("#endpoint")!,
	accessKey: document.querySelector<HTMLInputElement>("#accessKey")!,
	secretKey: document.querySelector<HTMLInputElement>("#secretKey")!,
	region: document.querySelector<HTMLInputElement>("#region")!,
	conflictStrategy: document.querySelector<HTMLSelectElement>("#conflictStrategy")!,
	syncIntervalMinutes: document.querySelector<HTMLInputElement>("#syncIntervalMinutes")!,
	pairs: document.querySelector<HTMLDivElement>("#pairs")!,
	addPair: document.querySelector<HTMLButtonElement>("#addPair")!,
	pairTemplate: document.querySelector<HTMLTemplateElement>("#pairTemplate")!,
	save: document.querySelector<HTMLButtonElement>("#save")!,
	syncNow: document.querySelector<HTMLButtonElement>("#syncNow")!,
	status: document.querySelector<HTMLParagraphElement>("#status")!,
	version: document.querySelector<HTMLParagraphElement>("#version")!,
};

let settings: TauriAppSettings;
let stopWatchers: Array<() => void> = [];
let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let syncing = false;

function setStatus(text: string): void {
	els.status.textContent = text;
}

// ---------- form <-> settings ----------

function renderPairRow(pair: SyncPair): void {
	const frag = els.pairTemplate.content.cloneNode(true) as DocumentFragment;
	const row = frag.querySelector<HTMLDivElement>(".pair")!;
	row.dataset.id = pair.id;
	row.querySelector<HTMLInputElement>(".pair-bucket")!.value = pair.bucket;
	row.querySelector<HTMLInputElement>(".pair-folder")!.value = pair.localFolder;

	row.querySelector<HTMLButtonElement>(".pair-choose")!.addEventListener("click", async () => {
		const chosen = await open({ directory: true, multiple: false });
		if (typeof chosen === "string") {
			row.querySelector<HTMLInputElement>(".pair-folder")!.value = chosen;
		}
	});
	row.querySelector<HTMLButtonElement>(".pair-remove")!.addEventListener("click", () => {
		row.remove();
	});

	els.pairs.appendChild(row);
}

function fillForm(s: TauriAppSettings): void {
	els.endpoint.value = s.s3.endpoint;
	els.accessKey.value = s.s3.accessKey;
	els.secretKey.value = s.s3.secretKey;
	els.region.value = s.s3.region;
	els.conflictStrategy.value = s.conflictStrategy;
	els.syncIntervalMinutes.value = String(s.syncIntervalMinutes);
	els.pairs.replaceChildren();
	for (const pair of s.pairs) renderPairRow(pair);
}

function readForm(): TauriAppSettings {
	const pairs: SyncPair[] = Array.from(els.pairs.querySelectorAll<HTMLDivElement>(".pair"))
		.map((row) => ({
			id: row.dataset.id || newPairId(),
			bucket: row.querySelector<HTMLInputElement>(".pair-bucket")!.value.trim(),
			localFolder: row.querySelector<HTMLInputElement>(".pair-folder")!.value,
		}))
		.filter((p) => p.bucket && p.localFolder);

	return {
		s3: {
			endpoint: els.endpoint.value.trim().replace(/\/$/, ""),
			accessKey: els.accessKey.value.trim(),
			secretKey: els.secretKey.value.trim(),
			region: els.region.value.trim() || "us-east-1",
		},
		pairs,
		conflictStrategy: (els.conflictStrategy.value || "latest-wins") as ConflictStrategy,
		syncIntervalMinutes: Number(els.syncIntervalMinutes.value) || 0,
		lastSyncTime: settings?.lastSyncTime ?? 0,
	};
}

function credsConfigured(s: TauriAppSettings): boolean {
	return !!(s.s3.endpoint && s.s3.accessKey && s.s3.secretKey);
}

// ---------- sync ----------

async function syncPair(pair: SyncPair): Promise<SyncResult> {
	const provider = new S3Provider(
		{ ...settings.s3, bucket: pair.bucket },
		new TauriHttpClient(),
	);
	const syncState = await loadSyncState(pair.id);
	const stateStore = new SyncStateStore(syncState, () => saveSyncState(pair.id, syncState));
	const engine = new SyncEngine(
		new TauriLocalFileSystem(), pair.localFolder,
		provider, stateStore,
		new TauriSyncUI(settings.conflictStrategy),
		{ conflictStrategy: settings.conflictStrategy, excludePatterns: [] },
	);
	return engine.sync();
}

async function runSync(): Promise<void> {
	if (syncing) return;
	if (!credsConfigured(settings)) {
		setStatus("Configure S3 credentials first");
		return;
	}
	if (settings.pairs.length === 0) {
		setStatus("Add at least one synced folder");
		return;
	}

	syncing = true;
	const total: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 0 };
	try {
		for (const pair of settings.pairs) {
			setStatus(`Syncing ${pair.bucket}…`);
			try {
				const r = await syncPair(pair);
				total.uploaded += r.uploaded;
				total.downloaded += r.downloaded;
				total.deleted += r.deleted;
				total.conflicts += r.conflicts;
				total.errors += r.errors;
			} catch (e) {
				total.errors++;
				console.error(`sync failed for ${pair.bucket}:`, e);
			}
		}

		settings.lastSyncTime = Date.now();
		await saveSettings(settings);

		const parts: string[] = [];
		if (total.uploaded) parts.push(`${total.uploaded} uploaded`);
		if (total.downloaded) parts.push(`${total.downloaded} downloaded`);
		if (total.deleted) parts.push(`${total.deleted} deleted`);
		if (total.errors) parts.push(`${total.errors} errors`);
		setStatus(parts.length ? `Synced: ${parts.join(", ")}` : "Everything up to date");
	} finally {
		syncing = false;
	}
}

async function restartWatchers(): Promise<void> {
	for (const stop of stopWatchers) stop();
	stopWatchers = [];
	const fs = new TauriLocalFileSystem();
	for (const pair of settings.pairs) {
		if (!pair.localFolder) continue;
		// A change under any watched folder triggers a full multi-pair sync —
		// simple, and pairs are independent so ordering doesn't matter.
		const stop = await watchForStableChanges(pair.localFolder, fs, () => void runSync());
		stopWatchers.push(stop);
	}
}

function restartInterval(): void {
	if (syncIntervalId !== null) clearInterval(syncIntervalId);
	syncIntervalId = null;
	if (settings.syncIntervalMinutes > 0) {
		syncIntervalId = setInterval(() => void runSync(), settings.syncIntervalMinutes * 60 * 1000);
	}
}

// Drop persisted sync state for pairs the user removed, so a re-added folder
// starts fresh rather than resurrecting stale deletions.
async function pruneRemovedPairState(oldPairs: SyncPair[], newPairs: SyncPair[]): Promise<void> {
	const kept = new Set(newPairs.map((p) => p.id));
	for (const old of oldPairs) {
		if (!kept.has(old.id)) await deleteSyncState(old.id);
	}
}

// ---------- init ----------

async function init(): Promise<void> {
	getVersion().then((v) => { els.version.textContent = `v${v}`; }).catch(() => {});

	settings = await loadSettings();
	fillForm(settings);
	await restartWatchers();
	restartInterval();

	els.addPair.addEventListener("click", () => {
		renderPairRow({ id: newPairId(), bucket: "", localFolder: "" });
	});

	els.save.addEventListener("click", async () => {
		const previous = settings.pairs;
		settings = readForm();
		await saveSettings(settings);
		await pruneRemovedPairState(previous, settings.pairs);
		fillForm(settings); // re-render so dropped empty rows clear
		await restartWatchers();
		restartInterval();
		setStatus("Settings saved");
	});

	els.syncNow.addEventListener("click", () => void runSync());

	await listen("tray-sync-now", () => void runSync());

	// Best-effort startup update check — GitHub Releases-backed, see
	// tauri.conf.json's updater.endpoints and the release CI.
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
