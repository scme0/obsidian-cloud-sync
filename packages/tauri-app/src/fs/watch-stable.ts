import { watch } from "@tauri-apps/plugin-fs";
import type { LocalFileSystem } from "@cloud-drive-sync/core";

// Reaper renders can still be mid-write when a fixed debounce fires, so
// instead of a fixed delay we wait for a quiet period after the last fs
// event, then compare two listFiles() snapshots STABILITY_WINDOW_MS apart —
// if nothing changed (no path/size/mtime differences), the tree is stable
// and safe to sync. If it did change, keep waiting rather than upload a
// half-written file.
const QUIET_PERIOD_MS = 3000;
const STABILITY_WINDOW_MS = 3000;

function snapshotKey(entries: { path: string; size: number; mtimeMs: number }[]): string {
	return entries
		.map((e) => `${e.path}:${e.size}:${e.mtimeMs}`)
		.sort()
		.join("|");
}

export async function watchForStableChanges(
	root: string,
	fs: LocalFileSystem,
	onStable: () => void,
): Promise<() => void> {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let checking = false;

	function scheduleCheck(): void {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void runStabilityCheck();
		}, QUIET_PERIOD_MS);
	}

	async function runStabilityCheck(): Promise<void> {
		if (checking) return;
		checking = true;
		try {
			const before = snapshotKey(await fs.listFiles(root));
			await new Promise((resolve) => setTimeout(resolve, STABILITY_WINDOW_MS));
			const after = snapshotKey(await fs.listFiles(root));
			if (before === after) {
				onStable();
			} else {
				// still changing (e.g. a large render still being written) — recheck
				scheduleCheck();
			}
		} finally {
			checking = false;
		}
	}

	return watch(root, () => scheduleCheck(), { recursive: true });
}
