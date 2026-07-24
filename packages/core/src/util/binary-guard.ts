const TEXT_MIME_ALLOWLIST = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/typescript",
]);

// Guards merge2way (line-based LCS text merge) from ever touching binary
// content, which it would corrupt. NUL-byte sniff over the first 8KB is the
// same heuristic git/grep -I use — catches binary data behind unknown or
// lying extensions that guessMimeType() can't classify.
export function isProbablyText(content: ArrayBuffer, mimeType: string): boolean {
	if (mimeType.startsWith("text/") || TEXT_MIME_ALLOWLIST.has(mimeType)) return true;
	const bytes = new Uint8Array(content, 0, Math.min(content.byteLength, 8192));
	return !bytes.includes(0);
}
