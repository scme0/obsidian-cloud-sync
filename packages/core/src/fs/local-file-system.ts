export interface LocalFileEntry {
	// relative path from the sync root, posix separators
	path: string;
	mtimeMs: number;
	size: number;
}

export interface LocalFileSystem {
	// recursive listing of the sync root, relative paths, dotfiles excluded
	listFiles(root: string): Promise<LocalFileEntry[]>;
	// recursive folder listing, same conventions as listFiles
	listFolders(root: string): Promise<string[]>;
	readFile(root: string, relPath: string): Promise<Uint8Array>;
	// creates parent directories as needed; overwrites an existing file
	writeFile(root: string, relPath: string, content: Uint8Array): Promise<void>;
	deleteFile(root: string, relPath: string): Promise<void>;
	createFolder(root: string, relPath: string): Promise<void>;
	deleteFolder(root: string, relPath: string): Promise<void>;
	// single-path stat; null if the file doesn't exist
	statFile(root: string, relPath: string): Promise<LocalFileEntry | null>;
}
