export interface LocalFileEntry {
	// relative path from the sync root, posix separators
	path: string;
	mtimeMs: number;
	size: number;
}

export interface LocalFileSystem {
	// recursive listing of the sync root, relative paths, dotfiles excluded
	listFiles(root: string): Promise<LocalFileEntry[]>;
	readFile(root: string, relPath: string): Promise<Uint8Array>;
	writeFile(root: string, relPath: string, content: Uint8Array): Promise<void>;
	deleteFile(root: string, relPath: string): Promise<void>;
}
