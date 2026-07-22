import { fetch } from "@tauri-apps/plugin-http";
import type { HttpClient, HttpRequest, HttpResponse } from "@cloud-drive-sync/core";

// @tauri-apps/plugin-http's fetch executes the request from the Rust side
// (via reqwest), so it isn't subject to the webview's CORS enforcement — the
// Tauri analog of Obsidian's requestUrl. Needed because the self-hosted
// rclone-serve-s3 endpoint sends no CORS headers.
export class TauriHttpClient implements HttpClient {
	async request(req: HttpRequest): Promise<HttpResponse> {
		const res = await fetch(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body,
		});
		const bytes = new Uint8Array(await res.arrayBuffer());
		return {
			status: res.status,
			headers: Object.fromEntries(res.headers.entries()),
			bytes,
		};
	}
}
