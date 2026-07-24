import { App, TFile, TFolder } from "obsidian";
import type { LocalFileEntry, LocalFileSystem } from "@cloud-drive-sync/core";

// Vault-backed LocalFileSystem. `root` is unused — vault paths are already
// relative to the vault root. Deletes go through vault.trash() so files land
// in Obsidian's recoverable trash, preserving the plugin's historical
// soft-delete behavior.
export class ObsidianLocalFileSystem implements LocalFileSystem {
	constructor(private app: App) {}

	async listFiles(_root: string): Promise<LocalFileEntry[]> {
		return this.app.vault.getFiles().map((f) => ({
			path: f.path,
			mtimeMs: f.stat.mtime,
			size: f.stat.size,
		}));
	}

	async listFolders(_root: string): Promise<string[]> {
		const paths: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					paths.push(child.path);
					walk(child);
				}
			}
		};
		walk(this.app.vault.getRoot());
		return paths;
	}

	async readFile(_root: string, relPath: string): Promise<Uint8Array> {
		const file = this.app.vault.getAbstractFileByPath(relPath);
		if (!(file instanceof TFile)) throw new Error(`not a file: ${relPath}`);
		return new Uint8Array(await this.app.vault.readBinary(file));
	}

	async writeFile(_root: string, relPath: string, content: Uint8Array): Promise<void> {
		const buffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
		const existing = this.app.vault.getAbstractFileByPath(relPath);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, buffer);
			return;
		}
		const parentPath = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
		if (parentPath) await this.ensureFolder(parentPath);
		await this.app.vault.createBinary(relPath, buffer);
	}

	async deleteFile(_root: string, relPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(relPath);
		if (file instanceof TFile) {
			await this.app.vault.trash(file, true);
		}
	}

	async createFolder(_root: string, relPath: string): Promise<void> {
		await this.ensureFolder(relPath);
	}

	async deleteFolder(_root: string, relPath: string): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(relPath);
		if (folder instanceof TFolder) {
			await this.app.vault.trash(folder, true);
		}
	}

	async statFile(_root: string, relPath: string): Promise<LocalFileEntry | null> {
		const file = this.app.vault.getAbstractFileByPath(relPath);
		if (!(file instanceof TFile)) return null;
		return { path: relPath, mtimeMs: file.stat.mtime, size: file.stat.size };
	}

	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) return;
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (parent) {
			await this.ensureFolder(parent);
		}
		await this.app.vault.createFolder(path);
	}
}
