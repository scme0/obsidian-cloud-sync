#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
	cloud_drive_sync_tauri_lib::run();
}
