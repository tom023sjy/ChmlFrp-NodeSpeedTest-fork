mod commands;
mod crypto;
mod db;
mod migration;
mod models;
mod utils;

use commands::dns_config::{DnsRuntimeState, UserTokenState};
use commands::dns_monitor;
use commands::ddns_monitor;
use commands::update::{launch_installer_silent, take_pending_installer, PendingInstaller};
use models::FrpcProcesses;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(FrpcProcesses::new())
        .manage(PendingInstaller::new())
        .manage(DnsRuntimeState::new())
        .manage(UserTokenState::new())
        // 拦截窗口关闭事件：阻止直接关闭，通知前端弹出关闭确认对话框
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.app_handle().emit("window-close-requested", ());
            }
        })
        .setup(|app| {
            // 初始化 SQLite 数据库（替代 JSON 文件存储）
            if let Err(e) = db::init(app.handle()) {
                log::error!("数据库初始化失败: {}", e);
                return Err(e.into());
            }
            // 自动迁移旧 JSON 数据到数据库
            migration::run(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    if let Err(e) = window.set_title("") {
                        eprintln!("Failed to set window title: {:?}", e);
                    }
                }
                // 非 macOS/Windows 平台下 window 不会被读取，显式标记避免警告
                let _ = &window;

                #[cfg(target_os = "windows")]
                {
                    if let Err(e) = window.set_decorations(false) {
                        eprintln!("Failed to set decorations: {:?}", e);
                    }
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 创建系统托盘图标及菜单
            let show_item = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .tooltip("ChmlFrp社区工具箱")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "tray-show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.unminimize();
                            }
                        }
                        "tray-quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标时显示主窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.unminimize();
                        }
                    }
                });

            // 使用应用默认窗口图标作为托盘图标
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            tray_builder.build(app)?;

            // 启动 DNS 容灾监控常驻任务
            dns_monitor::start_monitor(app.handle().clone());
            // 启动 DDNS 动态解析调度器
            ddns_monitor::start_monitor(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::http_request,
            commands::http_request_raw,
            commands::tcping_host,
            commands::ping_host,
            commands::start_tcp_speed_server,
            commands::stop_tcp_speed_server,
            commands::check_tcp_speed_server,
            commands::tcp_speed_test,
            commands::copy_background_image,
            commands::copy_background_video,
            commands::get_background_video_path,
            commands::start_file_server,
            commands::stop_file_server,
            commands::get_file_server_port,
            commands::is_file_server_running,
            commands::start_frpc,
            commands::stop_frpc,
            commands::stop_all_frpc,
            commands::is_frpc_running,
            commands::check_frpc_exists,
            commands::get_frpc_download_url,
            commands::download_frpc,
            commands::check_app_update,
            commands::download_app_update,
            commands::install_app_update,
            commands::get_pending_installer,
            commands::clear_pending_installer,
            // DNS 容灾相关命令
            commands::list_dns_credentials,
            commands::save_dns_credential,
            commands::delete_dns_credential,
            commands::dns_verify_credential,
            commands::dns_list_all_txt_records,
            commands::dns_delete_txt_record,
            commands::list_dns_tasks,
            commands::save_dns_task,
            commands::delete_dns_task,
            commands::list_dns_logs,
            commands::clear_dns_logs,
            commands::list_dns_runtime,
            commands::trigger_dns_check,
            commands::trigger_dns_check_task,
            commands::set_user_token,
            // DDNS 动态解析相关命令（基于 ChmlFrp 免费域名 API）
            commands::ddns_list_available_domains,
            commands::ddns_list_records,
            commands::ddns_list_interfaces,
            commands::list_ddns_tasks,
            commands::save_ddns_task,
            commands::delete_ddns_task,
            commands::list_ddns_logs,
            commands::clear_ddns_logs,
            // SSL 证书自动申请相关命令
            commands::ssl_list,
            commands::ssl_detail,
            commands::ssl_request,
            commands::ssl_verify,
            commands::ssl_delete,
            commands::ssl_auto_request,
            commands::ssl_auto_request_async,
            commands::ssl_save_log,
            commands::ssl_list_logs,
            commands::ssl_clear_logs,
            // 安全存储命令（敏感数据加密存储）
            commands::secure_store,
            commands::secure_load,
            commands::secure_delete,
            // 窗口与托盘相关命令
            commands::minimize_to_tray,
            commands::exit_app,
            commands::open_system_url,
            // 系统信息（设备互联注册用）
            commands::get_system_info,
            // 设备互联 RPC 统一入口（防止单独命令被 XSS 直接调用）
            commands::relay_dispatch_rpc,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            // 应用退出时：若有已下载完成的待安装更新，自动启动安装程序
            tauri::RunEvent::ExitRequested { .. } => {
                if let Some(installer_path) = take_pending_installer(app_handle) {
                    log::info!("检测到待安装更新，退出时自动启动安装程序");
                    launch_installer_silent(app_handle, &installer_path);
                }
            }
            _ => {
                #[cfg(not(target_os = "macos"))]
                let _ = app_handle;
            }
        });
}
