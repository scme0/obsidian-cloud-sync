export interface HttpRequest {
	url: string;
	method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
	headers?: Record<string, string>;
	body?: Uint8Array;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	bytes: Uint8Array;
}

// Requests are dispatched by the host shell (Obsidian's requestUrl/Node https,
// or Tauri's Rust-side fetch) so callers never touch a webview fetch() directly —
// both hosts need to bypass their runtime's CORS enforcement to reach a
// self-hosted rclone-serve-s3 endpoint that sends no CORS headers.
export interface HttpClient {
	request(req: HttpRequest): Promise<HttpResponse>;
}

export function bytesToText(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
