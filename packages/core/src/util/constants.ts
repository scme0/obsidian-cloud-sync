// Above this, a suspected-change is trusted from mtime+size alone instead of
// spending an extra full-file read to hash-verify it — for large files that
// verification read (not the unavoidable transfer read) is the costly part.
export const HASH_VERIFY_THRESHOLD_BYTES = 50 * 1024 * 1024;

// Single-PUT ceiling: Cloudflare's free-tier request-body limit is ~100MB, so
// anything at/above this goes through multipart upload instead.
export const MULTIPART_THRESHOLD_BYTES = 80 * 1024 * 1024;

// Part size balances request overhead vs retry granularity. It does NOT bound
// memory on either side: the client holds the whole file buffer regardless,
// and rclone serve s3 buffers the whole object server-side (rclone/rclone#7453).
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
