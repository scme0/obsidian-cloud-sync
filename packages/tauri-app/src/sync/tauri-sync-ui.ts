import type {
	ConflictResolution,
	ConflictStrategy,
	FirstSyncStrategy,
	SyncIssue,
	SyncIssueResolution,
	SyncUIPort,
} from "@cloud-drive-sync/core";

// Headless SyncUIPort: no modals in the Tauri app, so everything resolves
// automatically from the configured strategy. prompt/smart-merge have no UI
// backing here and degrade to newest-side-wins; delete-conflicts always
// re-download (a resurrected file is recoverable, a destroyed one is not).
export class TauriSyncUI implements SyncUIPort {
	constructor(private conflictStrategy: ConflictStrategy) {}

	async chooseFirstSyncStrategy(): Promise<FirstSyncStrategy> {
		// Safest default: keep both sides, reconcile per-file
		return "merge";
	}

	async resolveSyncIssues(issues: SyncIssue[]): Promise<SyncIssueResolution[]> {
		return issues
			.filter((i) => i.type !== "error") // errors retry naturally on next sync
			.map((i) => ({ vaultPath: i.vaultPath, remoteId: i.remoteId, resolution: this.pick(i) }));
	}

	private pick(issue: SyncIssue): ConflictResolution {
		if (issue.type === "delete-conflict") return "remote";
		if (this.conflictStrategy === "use-local") return "local";
		if (this.conflictStrategy === "use-remote") return "remote";
		if (issue.localModTime && issue.remoteModTime) {
			return issue.localModTime >= issue.remoteModTime ? "local" : "remote";
		}
		return "skip";
	}
}
