import { defineConfig } from "vite";

// Tauri-recommended vite setup: fixed dev port, ignore src-tauri from the
// watcher (Rust rebuilds are handled by `tauri dev` itself), and don't
// minify/clear-screen so Rust build errors stay visible in the same terminal.
export default defineConfig({
	clearScreen: false,
	server: {
		port: 1421,
		strictPort: true,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
	envPrefix: ["VITE_", "TAURI_"],
	build: {
		target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
		minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
		sourcemap: !!process.env.TAURI_ENV_DEBUG,
	},
});
