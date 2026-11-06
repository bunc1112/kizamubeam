//! Maschinenanbindung für die Oberfläche: Verbindung über USB-Seriell, Telnet (z. B. FluidNC, Port 23) oder WebSocket (ws.rs),
//! Ereignisse an das Fenster, Befehle aus dem Fenster an den Übertragungs-Thread (stream.rs).
//! Ruida-Steuerungen (CO2) haben einen eigenen Treiber-Thread (ruida.rs) mit denselben Befehlen und Ereignissen.

use crate::stream::{Cmd, Events, Protocol, Streamer};
use serde::Serialize;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Übertragungs-Thread der Verbindung: G-Code-Streamer oder Ruida-Treiber
enum Tx {
    Stream(Sender<Cmd>),
    Ruida(Sender<crate::ruida::Msg>),
}

impl Tx {
    fn send(&self, c: Cmd) -> Result<(), ()> {
        match self {
            Tx::Stream(t) => t.send(c).map_err(|_| ()),
            Tx::Ruida(t) => t.send(crate::ruida::Msg::Base(c)).map_err(|_| ()),
        }
    }
}

#[derive(Default)]
pub struct Machine {
    tx: Mutex<Option<Tx>>,
    busy: Arc<AtomicBool>,
}

impl Machine {
    fn send(&self, c: Cmd) -> Result<(), String> {
        let tx = self.tx.lock().unwrap();
        let tx = tx.as_ref().ok_or("Nicht verbunden")?;
        tx.send(c).map_err(|_| "Verbindung getrennt".to_string())
    }

    /// Nachricht an den Ruida-Treiber (Einstellungen, Aktionen)
    pub(crate) fn ruida(&self, m: crate::ruida::Msg) -> Result<(), String> {
        match self.tx.lock().unwrap().as_ref() {
            Some(Tx::Ruida(t)) => t.send(m).map_err(|_| "Verbindung getrennt".to_string()),
            Some(_) => Err("Keine Ruida-Steuerung verbunden".into()),
            None => Err("Nicht verbunden".into()),
        }
    }
}

struct WindowEvents(AppHandle);

#[derive(Serialize, Clone)]
struct Progress {
    sent: usize,
    acked: usize,
    total: usize,
    errors: usize,
}

#[derive(Serialize, Clone)]
struct Done {
    ok: bool,
    message: String,
}

impl Events for WindowEvents {
    fn line(&self, line: &str) {
        let _ = self.0.emit("machine-line", line);
    }
    fn progress(&self, sent: usize, acked: usize, total: usize, errors: usize) {
        let _ = self.0.emit("machine-progress", Progress { sent, acked, total, errors });
    }
    fn done(&self, ok: bool, message: &str) {
        let _ = self.0.emit("machine-done", Done { ok, message: message.into() });
    }
    fn closed(&self, reason: Option<String>) {
        let _ = self.0.emit("machine-closed", reason.unwrap_or_default());
    }
}

#[derive(Serialize)]
pub struct PortInfo {
    name: String,
    description: String,
}

/// Serielle Schnittstellen des Rechners
#[tauri::command]
pub async fn machine_ports() -> Vec<PortInfo> {
    let mut out: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let description = match p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    [u.manufacturer, u.product].into_iter().flatten().collect::<Vec<_>>().join(" ")
                }
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                _ => String::new(),
            };
            PortInfo { name: p.port_name, description }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn machine_connect(
    app: AppHandle,
    state: State<'_, Machine>,
    kind: String,
    port: String,
    baud: u32,
    host: String,
    tcp_port: u16,
    sync: bool,
    realtime: bool,
    poll: Option<String>,
    rx_buffer: Option<usize>,
    ruida: Option<crate::ruida::Connect>,
) -> Result<(), String> {
    // Ältere Oberflächen schicken keinen Puffer; unter 64 und über 16 KiB ist sicher ein Tippfehler
    let rx_buffer = rx_buffer.unwrap_or(crate::stream::RX_BUFFER).clamp(64, 16384);
    if let Some(tx) = state.tx.lock().unwrap().take() {
        let _ = tx.send(Cmd::Close);
    }
    let (tx, rx) = channel::<Cmd>();
    let busy = state.busy.clone();
    busy.store(false, Ordering::SeqCst);
    let events = WindowEvents(app);
    // Ruida: eigener Treiber über UDP (Ethernet) oder USB
    if let Some(rc) = ruida {
        use crate::ruida::{open, Driver, Udp, Usb};
        use kizamubeam_core::ruida::Framing;
        let (tx, rx) = channel();
        let o = rc.options.clone();
        let magic = rc.magic;
        match kind.as_str() {
            "udp" => {
                let host = host.trim().to_string();
                let link = tauri::async_runtime::spawn_blocking(move || open(Udp::open(&host)?, Framing::Udp, magic)).await.map_err(|e| e.to_string())??;
                std::thread::spawn(move || Driver::new(link, events, busy, o).run(rx));
            }
            "serial" => {
                if port.trim().is_empty() {
                    return Err("Keine Schnittstelle gewählt".into());
                }
                let name = port.trim().to_string();
                let link = tauri::async_runtime::spawn_blocking(move || open(Usb::open(&name)?, Framing::Usb, magic)).await.map_err(|e| e.to_string())??;
                std::thread::spawn(move || Driver::new(link, events, busy, o).run(rx));
            }
            _ => return Err(format!("Unbekannte Verbindungsart „{kind}“")),
        }
        *state.tx.lock().unwrap() = Some(Tx::Ruida(tx));
        return Ok(());
    }
    match kind.as_str() {
        "serial" => {
            if port.trim().is_empty() {
                return Err("Keine Schnittstelle gewählt".into());
            }
            let p = crate::serial_transport::open(port.trim(), baud)
                .map_err(|e| format!("{}: {e}", port.trim()))?;
            std::thread::spawn(move || Streamer::new(p, events, busy, Protocol { telnet: false, sync, realtime, poll, rx_buffer }).with_serial_retries().run(rx));
        }
        "tcp" => {
            let addr = (host.trim(), tcp_port)
                .to_socket_addrs()
                .map_err(|e| format!("{}: {e}", host.trim()))?
                .next()
                .ok_or_else(|| format!("{}: Adresse nicht gefunden", host.trim()))?;
            let s = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("{addr}: {e}"))?;
            s.set_read_timeout(Some(Duration::from_millis(10))).map_err(|e| e.to_string())?;
            s.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
            let _ = s.set_nodelay(true);
            std::thread::spawn(move || Streamer::new(s, events, busy, Protocol { telnet: true, sync, realtime, poll, rx_buffer }).run(rx));
        }
        "ws" => {
            let ws = crate::ws::connect(&host, tcp_port)?;
            std::thread::spawn(move || Streamer::new(ws, events, busy, Protocol { telnet: false, sync, realtime, poll, rx_buffer }).run(rx));
        }
        _ => return Err(format!("Unbekannte Verbindungsart „{kind}“")),
    }
    *state.tx.lock().unwrap() = Some(Tx::Stream(tx));
    Ok(())
}

#[tauri::command]
pub async fn machine_disconnect(state: State<'_, Machine>) -> Result<(), String> {
    if let Some(tx) = state.tx.lock().unwrap().take() {
        let _ = tx.send(Cmd::Close);
    }
    Ok(())
}

#[tauri::command]
pub async fn machine_send(state: State<'_, Machine>, line: String) -> Result<(), String> {
    if state.busy.load(Ordering::SeqCst) {
        return Err("Während ein Job läuft, sind keine Befehle möglich.".into());
    }
    state.send(Cmd::Line(line))
}

#[tauri::command]
pub async fn machine_realtime(state: State<'_, Machine>, byte: u8) -> Result<(), String> {
    state.send(Cmd::Realtime(byte))
}

#[tauri::command]
pub async fn machine_job(state: State<'_, Machine>, lines: Vec<String>) -> Result<(), String> {
    if state.busy.load(Ordering::SeqCst) {
        return Err("Es läuft bereits ein Job.".into());
    }
    state.send(Cmd::Job(lines))
}

/// Job mit G-Code, den der Rust-Kern schon vorbereitet hat (native::gcode_prepare)
#[tauri::command]
pub async fn machine_job_prepared(state: State<'_, Machine>, native: State<'_, Arc<crate::native::Native>>, id: u32) -> Result<(), String> {
    if state.busy.load(Ordering::SeqCst) {
        return Err("Es läuft bereits ein Job.".into());
    }
    let lines = native.gcode(id)?;
    state.send(Cmd::Job(lines.as_ref().clone()))
}

#[tauri::command]
pub async fn machine_pause(state: State<'_, Machine>) -> Result<(), String> {
    state.send(Cmd::Pause)
}

#[tauri::command]
pub async fn machine_resume(state: State<'_, Machine>) -> Result<(), String> {
    state.send(Cmd::Resume)
}

#[tauri::command]
pub async fn machine_stop(state: State<'_, Machine>) -> Result<(), String> {
    state.send(Cmd::Stop)
}
