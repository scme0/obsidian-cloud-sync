import { describe, it, expect, beforeEach } from "vitest";
import { MirrorSyncEngine } from "../src/sync/mirror-sync-engine";
import { SyncStateStore } from "../src/sync/sync-state";
import type { CloudProvider } from "../src/providers/cloud-provider";
import type { LocalFileEntry, LocalFileSystem } from "../src/fs/local-file-system";
import type { RemoteFileInfo, SyncState } from "../src/types";

class FakeLocalFs implements LocalFileSystem {
	files = new Map<string, Uint8Array>();

	async listFiles(_root: string): Promise<LocalFileEntry[]> {
		return Array.from(this.files.entries()).map(([path, bytes]) => ({
			path,
			mtimeMs: 1000,
			size: bytes.byteLength,
		}));
	}

	async readFile(_root: string, relPath: string): Promise<Uint8Array> {
		const bytes = this.files.get(relPath);
		if (!bytes) throw new Error(`not found: ${relPath}`);
		return bytes;
	}

	async writeFile(_root: string, relPath: string, content: Uint8Array): Promise<void> {
		this.files.set(relPath, content);
	}

	async deleteFile(_root: string, relPath: string): Promise<void> {
		this.files.delete(relPath);
	}
}

class FakeCloudProvider implements CloudProvider {
	readonly name = "fake";
	objects = new Map<string, { content: ArrayBuffer; modifiedTime: number }>();

	async testConnection(): Promise<boolean> {
		return true;
	}

	async listAllFiles(): Promise<RemoteFileInfo[]> {
		return Array.from(this.objects.entries()).map(([path, obj]) => ({
			id: path,
			name: path.split("/").pop() ?? path,
			path,
			modifiedTime: obj.modifiedTime,
			md5Checksum: "",
			mimeType: "application/octet-stream",
			isFolder: false,
			parentId: "",
		}));
	}

	async downloadFile(remoteId: string): Promise<ArrayBuffer> {
		const obj = this.objects.get(remoteId);
		if (!obj) throw new Error(`not found: ${remoteId}`);
		return obj.content;
	}

	async uploadFile(parentFolderId: string, name: string, content: ArrayBuffer): Promise<string> {
		const key = parentFolderId ? `${parentFolderId}/${name}` : name;
		this.objects.set(key, { content, modifiedTime: Date.now() });
		return key;
	}

	async updateFile(remoteId: string, content: ArrayBuffer): Promise<void> {
		this.objects.set(remoteId, { content, modifiedTime: Date.now() });
	}

	async deleteFile(remoteId: string): Promise<void> {
		this.objects.delete(remoteId);
	}

	async createFolder(parentFolderId: string, name: string): Promise<string> {
		return parentFolderId ? `${parentFolderId}/${name}` : name;
	}

	async getRemoteFolderId(relativePath: string): Promise<string> {
		return relativePath;
	}
}

function makeState(): { state: SyncState; store: SyncStateStore } {
	const state: SyncState = { files: {}, lastSyncTime: 0 };
	return { state, store: new SyncStateStore(state, async () => {}) };
}

describe("MirrorSyncEngine", () => {
	let fs: FakeLocalFs;
	let provider: FakeCloudProvider;

	beforeEach(() => {
		fs = new FakeLocalFs();
		provider = new FakeCloudProvider();
	});

	it("uploads a new local file", async () => {
		fs.files.set("song.wav", new TextEncoder().encode("audio-bytes"));
		const { store } = makeState();
		const engine = new MirrorSyncEngine(provider, store, fs, "/root");

		const result = await engine.sync();

		expect(result.uploaded).toBe(1);
		expect(provider.objects.has("song.wav")).toBe(true);
		expect(store.getRecord("song.wav")).toBeDefined();
	});

	it("downloads a new remote file", async () => {
		provider.objects.set("song.wav", { content: new TextEncoder().encode("audio-bytes").buffer, modifiedTime: 123 });
		const { store } = makeState();
		const engine = new MirrorSyncEngine(provider, store, fs, "/root");

		const result = await engine.sync();

		expect(result.downloaded).toBe(1);
		expect(fs.files.has("song.wav")).toBe(true);
		expect(store.getRecord("song.wav")).toBeDefined();
	});

	it("propagates a local delete to the remote", async () => {
		const { state, store } = makeState();
		state.files["song.wav"] = {
			vaultPath: "song.wav",
			remoteId: "song.wav",
			remoteFolderId: "",
			localModTime: 1,
			remoteModTime: 1,
			contentHash: "",
		};
		provider.objects.set("song.wav", { content: new ArrayBuffer(0), modifiedTime: 1 });
		// local file absent — simulates this device having deleted it

		const engine = new MirrorSyncEngine(provider, store, fs, "/root");
		const result = await engine.sync();

		expect(result.deleted).toBe(1);
		expect(provider.objects.has("song.wav")).toBe(false);
		expect(store.getRecord("song.wav")).toBeUndefined();
	});

	it("heals by re-uploading when the remote object vanishes but the local copy and state still exist", async () => {
		const { state, store } = makeState();
		state.files["song.wav"] = {
			vaultPath: "song.wav",
			remoteId: "song.wav",
			remoteFolderId: "",
			localModTime: 1,
			remoteModTime: 1,
			contentHash: "",
		};
		fs.files.set("song.wav", new TextEncoder().encode("still-here-locally"));
		// remote object absent — never deleted here, since that would risk destroying the last copy

		const engine = new MirrorSyncEngine(provider, store, fs, "/root");
		const result = await engine.sync();

		expect(result.uploaded).toBe(1);
		expect(fs.files.has("song.wav")).toBe(true);
		expect(provider.objects.has("song.wav")).toBe(true);
	});

	it("does nothing when a stale state record has nothing left on either side", async () => {
		const { state, store } = makeState();
		state.files["gone.wav"] = {
			vaultPath: "gone.wav",
			remoteId: "gone.wav",
			remoteFolderId: "",
			localModTime: 1,
			remoteModTime: 1,
			contentHash: "",
		};

		const engine = new MirrorSyncEngine(provider, store, fs, "/root");
		const result = await engine.sync();

		expect(result.uploaded).toBe(0);
		expect(result.downloaded).toBe(0);
		expect(result.deleted).toBe(0);
		expect(store.getRecord("gone.wav")).toBeUndefined();
	});
});
