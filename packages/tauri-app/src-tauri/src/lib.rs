use tauri::{
	menu::{Menu, MenuItem},
	tray::TrayIconBuilder,
	Emitter, Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.plugin(tauri_plugin_http::init())
		.plugin(tauri_plugin_fs::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_store::Builder::default().build())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(tauri_plugin_process::init())
		.setup(|app| {
			let sync_now = MenuItem::with_id(app, "sync-now", "Sync Now", true, None::<&str>)?;
			let open_settings = MenuItem::with_id(app, "open-settings", "Open Settings", true, None::<&str>)?;
			let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
			let menu = Menu::with_items(app, &[&sync_now, &open_settings, &quit])?;

			TrayIconBuilder::new()
				.icon(app.default_window_icon().unwrap().clone())
				.menu(&menu)
				.on_menu_event(|app, event| match event.id.as_ref() {
					"sync-now" => {
						let _ = app.emit("tray-sync-now", ());
					}
					"open-settings" => {
						if let Some(window) = app.get_webview_window("main") {
							let _ = window.show();
							let _ = window.set_focus();
						}
					}
					"quit" => {
						app.exit(0);
					}
					_ => {}
				})
				.build(app)?;

			Ok(())
		})
		// Background/tray app model: closing the window hides it instead of
		// quitting the process — the app keeps syncing from the tray.
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { api, .. } = event {
				let _ = window.hide();
				api.prevent_close();
			}
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
