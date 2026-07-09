import type { RemoteFileInfo } from "../types";

/**
 * Thrown when a remote file listed earlier no longer exists at fetch time
 * (deleted or moved between list and download). The sync engine treats this
 * as "remote state is stale" and skips the file; the next sync sees a fresh
 * listing and resolves it properly, instead of surfacing an error to the user.
 */
export class RemoteNotFoundError extends Error {
	constructor(remoteId: string) {
		super(`Remote file not found: ${remoteId}`);
		this.name = "RemoteNotFoundError";
	}
}

export interface CloudProvider {
	readonly name: string;

	testConnection(): Promise<boolean>;

	listAllFiles(): Promise<RemoteFileInfo[]>;

	downloadFile(remoteId: string): Promise<ArrayBuffer>;

	uploadFile(
		parentFolderId: string,
		name: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<string>;

	updateFile(
		remoteId: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<void>;

	deleteFile(remoteId: string): Promise<void>;

	createFolder(parentFolderId: string, name: string): Promise<string>;

	getRemoteFolderId(relativePath: string): Promise<string>;
}
