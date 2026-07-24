use tauri::{
	image::Image,
	menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder},
	tray::TrayIconBuilder,
	Emitter, Manager, WindowEvent,
};

const TRAY_ID: &str = "main-tray";
const TRAY_ACTIVE: &[u8] = include_bytes!("../icons/tray-active.png");
const TRAY_PAUSED: &[u8] = include_bytes!("../icons/tray-paused.png");

// Swap the menu-bar icon to reflect paused/active state. Called from JS, which
// owns the persisted paused flag.
#[tauri::command]
fn set_tray_paused(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
	let tray = app.tray_by_id(TRAY_ID).ok_or("tray not found")?;
	let bytes = if paused { TRAY_PAUSED } else { TRAY_ACTIVE };
	let icon = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
	tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
	tray.set_icon_as_template(true).map_err(|e| e.to_string())?;
	Ok(())
}

fn build_app_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
	let check_updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
	// App (first) submenu — its label is shown as the app name on macOS.
	let app_menu = SubmenuBuilder::new(app, "Cloud Drive Sync")
		.about(None)
		.item(&check_updates)
		.separator()
		.services()
		.separator()
		.hide()
		.hide_others()
		.show_all()
		.separator()
		.quit()
		.build()?;
	// Standard Edit menu so text fields get copy/paste/select-all + shortcuts.
	let edit_menu = SubmenuBuilder::new(app, "Edit")
		.undo()
		.redo()
		.separator()
		.cut()
		.copy()
		.paste()
		.select_all()
		.build()?;
	MenuBuilder::new(app).items(&[&app_menu, &edit_menu]).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.plugin(tauri_plugin_http::init())
		.plugin(tauri_plugin_fs::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_store::Builder::default().build())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(tauri_plugin_process::init())
		.invoke_handler(tauri::generate_handler![set_tray_paused])
		// App-menu events (the tray has its own handler below). Distinct IDs, so
		// no double-handling even if both handlers see an event.
		.on_menu_event(|app, event| {
			if event.id.as_ref() == "check-updates" {
				let _ = app.emit("menu-check-updates", ());
				if let Some(window) = app.get_webview_window("main") {
					let _ = window.show();
					let _ = window.set_focus();
				}
			}
		})
		.setup(|app| {
			let menu = build_app_menu(app)?;
			app.set_menu(menu)?;

			let sync_now = MenuItem::with_id(app, "sync-now", "Sync Now", true, None::<&str>)?;
			let toggle_pause = MenuItem::with_id(app, "toggle-pause", "Pause / Resume syncing", true, None::<&str>)?;
			let open_settings = MenuItem::with_id(app, "open-settings", "Open Settings", true, None::<&str>)?;
			let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
			let tray_menu = Menu::with_items(app, &[&sync_now, &toggle_pause, &open_settings, &quit])?;

			let tray = TrayIconBuilder::with_id(TRAY_ID)
				.icon(Image::from_bytes(TRAY_ACTIVE)?)
				.icon_as_template(true)
				.menu(&tray_menu)
				.on_menu_event(|app, event| match event.id.as_ref() {
					"sync-now" => {
						let _ = app.emit("tray-sync-now", ());
					}
					"toggle-pause" => {
						let _ = app.emit("tray-toggle-pause", ());
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
			let _ = tray;

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
