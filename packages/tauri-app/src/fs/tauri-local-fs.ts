import { readDir, readFile, writeFile, remove, mkdir, stat, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import type { LocalFileEntry, LocalFileSystem } from "@cloud-drive-sync/core";

function isDotSegment(relPath: string): boolean {
	return relPath.split("/").some((seg) => seg.startsWith("."));
}

export class TauriLocalFileSystem implements LocalFileSystem {
	async listFiles(root: string): Promise<LocalFileEntry[]> {
		const files: LocalFileEntry[] = [];
		await this.walk(root, "", files, null);
		return files;
	}

	async listFolders(root: string): Promise<string[]> {
		const folders: string[] = [];
		await this.walk(root, "", null, folders);
		return folders;
	}

	private async walk(
		root: string,
		relDir: string,
		files: LocalFileEntry[] | null,
		folders: string[] | null,
	): Promise<void> {
		const dirPath = relDir ? await join(root, relDir) : root;
		const entries = await readDir(dirPath);
		for (const entry of entries) {
			const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (!relPath || isDotSegment(relPath)) continue;

			if (entry.isDirectory) {
				folders?.push(relPath);
				await this.walk(root, relPath, files, folders);
			} else if (entry.isFile && files) {
				const fullPath = await join(root, relPath);
				const info = await stat(fullPath);
				files.push({
					path: relPath,
					mtimeMs: info.mtime ? info.mtime.getTime() : 0,
					size: info.size,
				});
			}
		}
	}

	async readFile(root: string, relPath: string): Promise<Uint8Array> {
		return readFile(await join(root, relPath));
	}

	async writeFile(root: string, relPath: string, content: Uint8Array): Promise<void> {
		const fullPath = await join(root, relPath);
		const parentRel = relPath.split("/").slice(0, -1).join("/");
		const parentPath = parentRel ? await join(root, parentRel) : root;
		if (!(await exists(parentPath))) {
			await mkdir(parentPath, { recursive: true });
		}
		await writeFile(fullPath, content);
	}

	async deleteFile(root: string, relPath: string): Promise<void> {
		const fullPath = await join(root, relPath);
		if (await exists(fullPath)) {
			await remove(fullPath);
		}
	}

	async createFolder(root: string, relPath: string): Promise<void> {
		const fullPath = await join(root, relPath);
		if (!(await exists(fullPath))) {
			await mkdir(fullPath, { recursive: true });
		}
	}

	async deleteFolder(root: string, relPath: string): Promise<void> {
		const fullPath = await join(root, relPath);
		if (await exists(fullPath)) {
			await remove(fullPath, { recursive: true });
		}
	}

	async statFile(root: string, relPath: string): Promise<LocalFileEntry | null> {
		const fullPath = await join(root, relPath);
		if (!(await exists(fullPath))) return null;
		const info = await stat(fullPath);
		if (info.isDirectory) return null;
		return {
			path: relPath,
			mtimeMs: info.mtime ? info.mtime.getTime() : 0,
			size: info.size,
		};
	}
}
