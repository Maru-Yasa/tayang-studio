pub mod acp;
pub mod ai_proxy;
pub mod auth;
pub mod claude_account;
pub mod billing;
pub mod cloud;
pub mod commands;
pub mod db;
pub mod device;
pub mod files;
pub mod media;
pub mod projects;
pub mod scheduler;
pub mod styles_sync;
pub mod system;
pub mod telemetry;
pub mod types;
pub mod trace;
pub mod usage;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // First, so a second launch is caught before anything else starts: it shows the running window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| scheduler::show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Launch at login is switched on and off from Settings (the JS plugin API), only while background mode is on.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![scheduler::HIDDEN_ARG])))
        // Updates come from the signed latest.json on GitHub Releases (endpoints and public key in tauri.conf.json);
        // the webview checks, downloads and installs, then relaunches through the process plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            let app = window.app_handle();
            scheduler::on_window_event(window, event, || {
                app.try_state::<AppState>().is_some_and(|s| s.db.get_settings(&s.home).background_mode)
            });
        })
        .setup(|app| {
            let home = app.path().home_dir()?;
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let db = db::Db::open(&data.join("tayang.db"))?;
            // No agent survives a restart, so nothing can still be working.
            let _ = db.fail_stale_jobs("Tayang was closed while this was running");
            // Also records the real home so later settings updates resolve defaults against it.
            let settings = db.get_settings(&home);
            let working = settings.working_folder.clone();
            commands::allow_asset_folders(app.handle(), &db, &working);
            commands::allow_style_media(app.handle());
            media::sweep_study_dirs(std::path::Path::new(&working));
            app.manage(usage::UsageCache::default());
            app.manage(commands::ClaudeSignIn::default());
            let api_url = styles_sync::effective_api_url(&settings);
            app.manage(AppState {
                db,
                acp: acp::AcpManager::new(),
                media: media::MediaTools::from_env_or_path(),
                home,
                study_working: Default::default(),
            });
            // Signed in? Checked against the API in the background; the UI listens for the answer.
            let auth = commands::auth_manager(app.handle(), &data)?;
            app.manage(auth.clone());
            tauri::async_runtime::spawn(async move { auth.refresh(&api_url).await });
            // A tray that can't be made never crashes the start: background mode goes off, the window stays.
            if scheduler::sync_tray(app.handle(), &settings).is_err() {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = scheduler::background_off(&state.db);
                }
            }
            // A login launch starts in the tray, when there is one.
            let args: Vec<String> = std::env::args().collect();
            if scheduler::launched_hidden(&args) && scheduler::has_tray(app.handle()) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            scheduler::start_ticker(app.handle());
            // The agents' AI images and voice, paid with the user's credits (see ai_proxy).
            tauri::async_runtime::spawn(commands::start_ai_proxy(app.handle().clone()));
            // Anonymous install ping, in the background; never blocks the UI, failures are ignored.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let info = tauri::async_runtime::spawn_blocking(|| system::system_info(&system::RealExec)).await;
                if let (Ok(info), Some(state)) = (info, handle.try_state::<AppState>()) {
                    telemetry::ping_if_due(&state.db, &state.home, &info, chrono::Utc::now()).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_system_info,
            commands::system_locale,
            commands::detect_agents,
            commands::check_tools,
            commands::claude_account,
            commands::claude_sign_in,
            commands::claude_sign_in_cancel,
            commands::claude_sign_out,
            commands::get_settings,
            commands::update_settings,
            commands::pick_folder,
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::set_project_status,
            commands::set_schedule,
            commands::set_posted,
            commands::approve_project,
            commands::list_autopilots,
            commands::list_niches,
            commands::list_voices,
            commands::save_autopilot,
            commands::delete_autopilot,
            commands::set_autopilot_status,
            commands::list_slots,
            commands::upsert_slot,
            commands::update_slot,
            commands::list_chats,
            commands::project_files,
            commands::find_project_files,
            commands::read_project_file,
            commands::set_agent_model,
            commands::agent_models,
            commands::api_url_override,
            commands::cloud_usage,
            commands::social_accounts,
            commands::social_connect,
            commands::social_disconnect,
            commands::social_post,
            commands::social_post_status,
            commands::redeem_gift_code,
            commands::list_recent_chats,
            commands::list_archived_chats,
            commands::set_thread_archived,
            commands::purge_archive,
            commands::get_chat,
            commands::create_chat,
            commands::update_chat_agent,
            commands::list_messages,
            commands::add_message,
            commands::list_styles,
            commands::save_style,
            commands::delete_style,
            commands::read_style_result,
            commands::study_dir,
            commands::remove_study_dir,
            commands::make_style_preview,
            commands::make_style_sheets,
            commands::keep_style_refs,
            commands::copy_style_refs,
            commands::list_jobs,
            commands::upsert_job,
            commands::delete_job,
            commands::set_jobs_archived,
            commands::attach_file,
            commands::agent_start,
            commands::agent_prompt,
            commands::agent_set_auto,
            commands::agent_cancel,
            commands::agent_stop,
            commands::agent_respond_permission,
            commands::agent_respond_question,
            commands::media_latest_render,
            commands::latest_render_info,
            commands::newest_video_info,
            commands::video_thumbnail,
            commands::recent_images,
            commands::schedule_videos,
            commands::media_probe,
            commands::media_extract_frame,
            commands::media_thumbnails,
            commands::media_render,
            commands::get_agent_usage,
            commands::get_chat_trace,
            commands::sync_styles,
            commands::install_style_template,
            commands::render_command,
            commands::write_brief,
            commands::auth_start,
            commands::auth_cancel,
            commands::auth_status,
            commands::auth_logout,
            commands::billing_checkout,
            commands::billing_open,
            commands::billing_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tayang Studio");
    app.run(|handle, event| {
        // Clicking the dock icon brings back a window hidden by background mode.
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            scheduler::show_main(handle);
        }
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            if let Some(auth) = handle.try_state::<std::sync::Arc<auth::Auth>>() {
                auth.shutdown();
            }
            // Don't leave agent processes behind.
            if let Some(state) = handle.try_state::<AppState>() {
                tauri::async_runtime::block_on(state.acp.stop_all());
            }
        }
    });
}
