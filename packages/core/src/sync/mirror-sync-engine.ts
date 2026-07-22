import type { CloudProvider } from "../providers/cloud-provider";
import type { RemoteFileInfo } from "../types";
import type { SyncStateStore } from "./sync-state";
import type { LocalFileEntry, LocalFileSystem } from "../fs/local-file-system";
import { computeMD5 } from "../util/hash";
import { getFileName, getParentPath, guessMimeType } from "../util/path";

export interface MirrorSyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	errors: number;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Bidirectional mirror for write-once files (e.g. Reaper audio renders):
 * content never changes after upload, so there's no content-conflict case to
 * resolve — only *existence* needs reconciling between local disk, this
 * device's sync state, and the remote.
 *
 * Known limitation, chosen deliberately: if a remote object goes missing while
 * this device's state still tracks it AND the local file is still present,
 * that's ambiguous (remote deleted intentionally elsewhere vs. remote object
 * lost/corrupted) and we always heal by re-uploading rather than deleting the
 * local copy. A local file is only ever deleted in response to an explicit
 * local deletion on *this* device (tracked + now-missing-locally). This means
 * a delete made on one device doesn't immediately vanish from another device
 * that still has its own local copy — that device will instead resurrect it
 * remotely on its next sync. Silently deleting local files from remote-absence
 * alone risks destroying the last remaining copy of an irreplaceable file,
 * which is worse than delayed convergence. To fully delete a file, remove it
 * from every device's local disk.
 */
export class MirrorSyncEngine {
	constructor(
		private provider: CloudProvider,
		private state: SyncStateStore,
		private fs: LocalFileSystem,
		private root: string,
	) {}

	async sync(): Promise<MirrorSyncResult> {
		const result: MirrorSyncResult = { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 };

		const localByPath = new Map(
			(await this.fs.listFiles(this.root)).map((e): [string, LocalFileEntry] => [e.path, e])
		);
		const remoteByPath = new Map(
			(await this.provider.listAllFiles())
				.filter((f) => !f.isFolder)
				.map((f): [string, RemoteFileInfo] => [f.path, f])
		);
		const trackedPaths = new Set(this.state.getAllTrackedPaths());
		const allPaths = new Set([...localByPath.keys(), ...remoteByPath.keys(), ...trackedPaths]);

		for (const path of allPaths) {
			try {
				await this.reconcilePath(
					path,
					localByPath.get(path),
					remoteByPath.get(path),
					trackedPaths.has(path),
					result,
				);
			} catch (e) {
				result.errors++;
				console.error(`MirrorSyncEngine: failed reconciling ${path}`, e);
			}
		}

		await this.state.save();
		return result;
	}

	private async upload(path: string, local: LocalFileEntry, result: MirrorSyncResult): Promise<void> {
		const bytes = await this.fs.readFile(this.root, path);
		const content = toArrayBuffer(bytes);
		const parentFolderId = getParentPath(path);
		const remoteId = await this.provider.uploadFile(parentFolderId, getFileName(path), content, guessMimeType(path));
		this.state.setRecord(path, {
			vaultPath: path,
			remoteId,
			remoteFolderId: parentFolderId,
			localModTime: local.mtimeMs,
			remoteModTime: Date.now(),
			contentHash: computeMD5(content),
		});
		result.uploaded++;
	}

	private async reconcilePath(
		path: string,
		local: LocalFileEntry | undefined,
		remote: RemoteFileInfo | undefined,
		tracked: boolean,
		result: MirrorSyncResult,
	): Promise<void> {
		if (local && !tracked && !remote) {
			// new local file
			await this.upload(path, local, result);
		} else if (local && !tracked && remote) {
			// exists both sides, never recorded by this device — adopt, no transfer
			this.state.setRecord(path, {
				vaultPath: path,
				remoteId: remote.id,
				remoteFolderId: remote.parentId,
				localModTime: local.mtimeMs,
				remoteModTime: remote.modifiedTime,
				contentHash: "",
			});
		} else if (local && tracked && !remote) {
			// remote missing but still tracked+local — heal by re-upload (see class doc)
			await this.upload(path, local, result);
		} else if (local && tracked && remote) {
			// already in sync
		} else if (!local && !tracked && remote) {
			// new remote file (e.g. from another device)
			const content = await this.provider.downloadFile(remote.id);
			await this.fs.writeFile(this.root, path, new Uint8Array(content));
			this.state.setRecord(path, {
				vaultPath: path,
				remoteId: remote.id,
				remoteFolderId: remote.parentId,
				localModTime: Date.now(),
				remoteModTime: remote.modifiedTime,
				contentHash: computeMD5(content),
			});
			result.downloaded++;
		} else if (!local && tracked && remote) {
			// this device deleted the local file — propagate delete to remote
			const record = this.state.getRecord(path);
			if (record) await this.provider.deleteFile(record.remoteId);
			this.state.removeRecord(path);
			result.deleted++;
		} else if (!local && tracked && !remote) {
			// already gone both sides — drop stale state record
			this.state.removeRecord(path);
		}
	}
}
