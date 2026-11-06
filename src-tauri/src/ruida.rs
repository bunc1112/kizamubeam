//! Ruida-Steuerung (CO2-Laser) an der Oberfläche: Verbindung über Ethernet (UDP) oder USB, Zustand abfragen,
//! Aufträge als Ruida-Datei senden, Einstellungen der Steuerung lesen und schreiben.
//!
//! Die Oberfläche spricht mit allen Steuerungen gleich (stream::Cmd, Ereignisse machine-line/-progress/-done).
//! Damit Bewegen, Referenzfahrt, Ursprung, Rahmen und Start ohne eigene Wege funktionieren, versteht der Treiber die
//! wenigen GRBL-artigen Zeilen, die KizamuBeam dafür schickt ($H, $J=…, G10 L20/L2), und meldet den Zustand als
//! GRBL-Statuszeile (<Idle|MPos:…|WCO:…>). Aufträge (G-Code von KizamuBeam) werden vor dem Senden vollständig
//! übersetzt und geprüft (kizamubeam_core::ruida); was Ruida nicht kann, wird abgelehnt, bevor sich etwas bewegt.

use crate::stream::{Cmd, Events};
use kizamubeam_core::ruida::{self as rd, mem, status_bits, Framing, Link, Options, Transport};
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Feste Ports der Steuerung (nicht einstellbar): sie empfängt auf 50200 und antwortet an 40200
pub const CTRL_PORT: u16 = 50200;
pub const LISTEN_PORT: u16 = 40200;

const POLL: Duration = Duration::from_millis(250);
const POLL_UPLOAD: Duration = Duration::from_millis(1000);
const PROGRESS: Duration = Duration::from_millis(200);
/// Während der Referenzfahrt antworten manche Steuerungen nicht (MeerK40t: bis zu 40 s)
const HOMING_QUIET: Duration = Duration::from_secs(60);
/// So viele Abfragen hintereinander dürfen ohne Antwort bleiben, dann gilt die Verbindung als verloren
const MAX_FAILS: u32 = 6;
/// Verfahrgeschwindigkeit (mm/s) für Eilgänge per D9, wenn die Zeile kein F hat, und Obergrenze
const JOG_DEFAULT: f64 = 100.0;
const JOG_MAX: f64 = 1000.0;

/// Einstellungen für die Verbindung, von der Oberfläche
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Connect {
    /// Schlüssel (0x88, 0x11, 0x38); 0 = erkennen
    #[serde(default)]
    pub magic: u8,
    #[serde(flatten)]
    pub options: Options,
}

/// Nachrichten an den Treiber-Thread
pub enum Msg {
    Base(Cmd),
    Read(Vec<u16>, Sender<Vec<ReadResult>>),
    Write(u16, u64, Sender<Result<u64, String>>),
    Action(String, Sender<Result<(), String>>),
}

#[derive(Serialize, Clone, Debug)]
pub struct ReadResult {
    pub addr: u16,
    /// Zahlenwert (35 Bit), falls die Antwort einen hat
    pub value: Option<u64>,
    /// Antwort als Text (z. B. Firmware-Version)
    pub text: String,
    pub error: Option<String>,
}

// ---------- Übertragungswege ----------

pub struct Udp {
    sock: UdpSocket,
    peer: SocketAddr,
}

impl Udp {
    pub fn open(host: &str) -> Result<Self, String> {
        let peer = (host.trim(), CTRL_PORT)
            .to_socket_addrs()
            .map_err(|e| format!("{}: {e}", host.trim()))?
            .find(|a| a.is_ipv4())
            .ok_or_else(|| format!("{}: Adresse nicht gefunden", host.trim()))?;
        // Beim schnellen Neuverbinden gibt der alte Treiber-Thread den Port erst nach einigen Millisekunden frei
        let mut tries = 0;
        let sock = loop {
            match UdpSocket::bind(("0.0.0.0", LISTEN_PORT)) {
                Ok(s) => break s,
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && tries < 10 => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("Port {LISTEN_PORT} nicht verfügbar: {e}")),
            }
        };
        Ok(Udp { sock, peer })
    }
}

impl Transport for Udp {
    fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.sock.send_to(data, self.peer).map(|_| ())
    }
    fn recv(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        self.sock.set_read_timeout(Some(timeout.max(Duration::from_millis(1))))?;
        let mut buf = [0u8; 2048];
        let deadline = Instant::now() + timeout;
        loop {
            match self.sock.recv_from(&mut buf) {
                // Nur Antworten der eigenen Steuerung
                Ok((n, from)) if from.ip() == self.peer.ip() => return Ok(Some(buf[..n].to_vec())),
                Ok(_) => {
                    if Instant::now() >= deadline {
                        return Ok(None);
                    }
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Ok(None),
                // Windows meldet ICMP „Port nicht erreichbar“ beim nächsten Empfang als Fehler
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    }
}

pub struct Usb(Box<dyn serialport::SerialPort>);

impl Usb {
    /// RDC-Steuerungen haben einen FTDI-Wandler; MeerK40t: 115200 Baud, RTS/CTS und DTR
    pub fn open(name: &str) -> Result<Self, String> {
        let p = serialport::new(name, 115_200)
            .flow_control(serialport::FlowControl::Hardware)
            .timeout(Duration::from_millis(10))
            .open()
            .map_err(|e| format!("{name}: {e}"))?;
        let mut u = Usb(p);
        let _ = u.0.write_data_terminal_ready(true);
        Ok(u)
    }
}

impl Transport for Usb {
    fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        self.0.write_all(data)?;
        self.0.flush()
    }
    fn recv(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        use std::io::Read;
        let _ = self.0.set_timeout(timeout.max(Duration::from_millis(1)));
        let mut buf = [0u8; 256];
        match self.0.read(&mut buf) {
            Ok(0) => Ok(None),
            Ok(n) => Ok(Some(buf[..n].to_vec())),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(e) => Err(e),
        }
    }
}

/// Verbindung herstellen: Schlüssel erkennen (oder den eingestellten prüfen), Zustand einmal lesen
pub fn open<T: Transport>(mut t: T, framing: Framing, magic: u8) -> Result<Link<T>, String> {
    let magic = if magic == 0 {
        rd::detect_magic(&mut t, framing, Duration::from_millis(400)).ok_or_else(|| {
            "Die Ruida-Steuerung antwortet nicht. IP-Adresse bzw. Schnittstelle prüfen; LightBurn oder RDWorks dürfen nicht gleichzeitig verbunden sein, und bei Ethernet muss die Firewall UDP-Port 40200 für KizamuBeam zulassen.".to_string()
        })?
    } else {
        magic
    };
    let mut link = Link::new(t, framing, magic);
    link.query_value(mem::STATUS).map_err(|_| "Die Ruida-Steuerung antwortet nicht. IP-Adresse bzw. Schnittstelle und Schlüssel prüfen; LightBurn oder RDWorks dürfen nicht gleichzeitig verbunden sein, und bei Ethernet muss die Firewall UDP-Port 40200 für KizamuBeam zulassen.".to_string())?;
    Ok(link)
}

// ---------- Treiber ----------

struct Run {
    data: Vec<u8>,
    packets: Vec<(std::ops::Range<usize>, u32)>,
    next: usize,
    total: usize,
    /// Zeilen bis zum zuletzt bestätigten Paket
    sent: usize,
    started: Instant,
    uploaded: Option<Instant>,
    seen_running: bool,
    idle_polls: u32,
}

pub struct Driver<T: Transport, E: Events> {
    link: Link<T>,
    events: E,
    busy: Arc<AtomicBool>,
    o: Options,
    /// Maschinenposition (mm, KizamuBeam-Koordinaten); None bis zur ersten Antwort
    pos: Option<(f64, f64)>,
    z: f64,
    /// Werkstück-Nullpunkt (mm). Ruida kennt keinen G10; der Treiber rechnet ihn selbst ein.
    wco: (f64, f64),
    bits: u64,
    moving: bool,
    paused: bool,
    homing: Option<Instant>,
    run: Option<Run>,
    last_poll: Instant,
    last_progress: Instant,
    fails: u32,
    polls: u64,
}

fn fmt3(v: f64) -> String {
    format!("{v:.3}")
}

impl<T: Transport, E: Events> Driver<T, E> {
    pub fn new(link: Link<T>, events: E, busy: Arc<AtomicBool>, o: Options) -> Self {
        let now = Instant::now();
        Driver {
            link,
            events,
            busy,
            o,
            pos: None,
            z: 0.0,
            wco: (0.0, 0.0),
            bits: 0,
            moving: false,
            paused: false,
            homing: None,
            run: None,
            last_poll: now.checked_sub(POLL).unwrap_or(now),
            last_progress: now,
            fails: 0,
            polls: 0,
        }
    }

    /// Hauptschleife bis Close oder Verbindungsverlust
    pub fn run(mut self, rx: Receiver<Msg>) {
        self.info();
        let reason = loop {
            match self.messages(&rx) {
                Ok(true) => break None,
                Ok(false) => {}
                Err(e) => break Some(e),
            }
            if let Err(e) = self.pump() {
                break Some(e);
            }
        };
        if self.run.take().is_some() {
            self.events.done(false, "Verbindung getrennt");
        }
        self.busy.store(false, Ordering::SeqCst);
        self.events.closed(reason);
    }

    fn messages(&mut self, rx: &Receiver<Msg>) -> Result<bool, String> {
        // Ohne laufendes Hochladen kurz auf Nachrichten warten, sonst nur nachsehen
        let first = if self.uploading() {
            match rx.try_recv() {
                Ok(m) => Some(m),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return Ok(true),
            }
        } else {
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return Ok(true),
            }
        };
        let mut next = first;
        while let Some(m) = next {
            if self.handle(m)? {
                return Ok(true);
            }
            next = match rx.try_recv() {
                Ok(m) => Some(m),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return Ok(true),
            };
        }
        Ok(false)
    }

    fn uploading(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.next < r.packets.len())
    }

    /// true = Verbindung schließen
    pub fn handle(&mut self, m: Msg) -> Result<bool, String> {
        match m {
            Msg::Base(Cmd::Close) => return Ok(true),
            Msg::Base(Cmd::Line(l)) => {
                if self.run.is_none() {
                    match self.line(&l) {
                        Ok(()) => self.events.line("ok"),
                        Err(e) => self.events.line(&format!("error: {e}")),
                    }
                }
            }
            Msg::Base(Cmd::Realtime(b)) => self.realtime(b)?,
            Msg::Base(Cmd::Job(lines)) => self.start_job(&lines),
            Msg::Base(Cmd::Pause) => self.realtime(b'!')?,
            Msg::Base(Cmd::Resume) => self.realtime(b'~')?,
            Msg::Base(Cmd::Stop) => self.realtime(0x18)?,
            Msg::Read(addrs, reply) => {
                let out = addrs.into_iter().map(|a| self.read(a)).collect();
                let _ = reply.send(out);
            }
            Msg::Write(addr, value, reply) => {
                let _ = reply.send(self.write(addr, value));
            }
            Msg::Action(a, reply) => {
                let _ = reply.send(self.action(&a));
            }
        }
        Ok(false)
    }

    fn read(&mut self, addr: u16) -> ReadResult {
        match self.link.query(addr) {
            Ok(v) => ReadResult { addr, value: rd::reply_value(&v), text: rd::reply_text(&v), error: None },
            Err(e) => ReadResult { addr, value: None, text: String::new(), error: Some(e) },
        }
    }

    /// Einstellung schreiben und zur Kontrolle zurücklesen
    fn write(&mut self, addr: u16, value: u64) -> Result<u64, String> {
        if self.run.is_some() || self.moving || self.homing.is_some() {
            return Err("Während die Maschine arbeitet, lassen sich keine Einstellungen schreiben.".into());
        }
        if value >= 1 << 35 {
            return Err("Wert zu groß".into());
        }
        self.link.send(&rd::set_setting(addr, value))?;
        let back = self.link.query_value(addr)?;
        if back != value {
            return Err(format!("Die Steuerung hat den Wert nicht übernommen (gelesen: {back})"));
        }
        Ok(back)
    }

    /// Ruida-eigene Aktionen aus dem Einstellungsfenster (immer vom Benutzer ausgelöst)
    fn action(&mut self, a: &str) -> Result<(), String> {
        if self.run.is_some() {
            return Err("Während ein Job läuft, sind keine Befehle möglich.".into());
        }
        let cmd: &[u8] = match a {
            "homeXY" => {
                self.homing = Some(Instant::now());
                &rd::HOME_XY
            }
            "homeZ" => {
                self.homing = Some(Instant::now());
                &rd::HOME_Z
            }
            "homeU" => {
                self.homing = Some(Instant::now());
                &rd::HOME_U
            }
            "focusZ" => &rd::FOCUS_Z,
            _ => return Err(format!("Unbekannte Aktion „{a}“")),
        };
        self.link.send(cmd)
    }

    /// Zeilen von Konsole, Bewegen-Fenster und Kalibrierung
    fn line(&mut self, l: &str) -> Result<(), String> {
        let t = l.trim();
        let up = t.to_ascii_uppercase();
        if t.is_empty() || up == "?" {
            return Ok(());
        }
        if up == "$H" {
            self.homing = Some(Instant::now());
            return self.link.send(&rd::HOME_XY);
        }
        // Ruida hat keinen Alarm-Zustand zum Entsperren
        if up == "$X" {
            return Ok(());
        }
        if up == "$I" {
            self.info();
            return Ok(());
        }
        if let Some(rest) = up.strip_prefix("$J=") {
            return self.jog(rest);
        }
        let w = words(&up)?;
        let has = |c: char, v: f64| w.iter().any(|&(k, x)| k == c && x == v);
        if has('G', 10.0) {
            // G10 L20 P1 X0 Y0: aktuelle Position wird zu (X, Y); G10 L2 P1 X Y: Nullpunkt direkt setzen
            let x = w.iter().find(|p| p.0 == 'X').map(|p| p.1);
            let y = w.iter().find(|p| p.0 == 'Y').map(|p| p.1);
            if has('L', 20.0) {
                let p = self.pos.ok_or("Position der Maschine unbekannt")?;
                if let Some(x) = x {
                    self.wco.0 = p.0 - x;
                }
                if let Some(y) = y {
                    self.wco.1 = p.1 - y;
                }
                return Ok(());
            }
            if has('L', 2.0) {
                if let Some(x) = x {
                    self.wco.0 = x;
                }
                if let Some(y) = y {
                    self.wco.1 = y;
                }
                return Ok(());
            }
            return Err("G10 nur mit L2 oder L20".into());
        }
        // Harmlose Modalbefehle ohne Wirkung bei Ruida
        if w.iter().all(|&(k, v)| (k == 'G' && [21.0, 90.0].contains(&v)) || (k == 'M' && [5.0, 9.0].contains(&v))) {
            return Ok(());
        }
        // G0 X Y (absolut, Werkstückkoordinaten): Eilgang ohne Laser
        if has('G', 0.0) && w.iter().all(|&(k, v)| matches!(k, 'X' | 'Y' | 'F') || (k == 'G' && (v == 0.0 || v == 90.0 || v == 21.0))) {
            return self.jog(&up);
        }
        Err("Befehl wird mit Ruida nicht unterstützt (Konsole: $H, $J=…, G0 X Y, G10 L20/L2)".into())
    }

    /// $J=G91 G21 X.. Y.. F.. (relativ) oder G90 (absolut, Werkstückkoordinaten). Ziel muss im Arbeitsbereich liegen.
    fn jog(&mut self, s: &str) -> Result<(), String> {
        let w = words(s)?;
        let mut rel = false;
        let (mut x, mut y, mut f) = (None, None, None);
        for &(k, v) in &w {
            match k {
                'G' if v == 91.0 => rel = true,
                'G' if v == 90.0 || v == 21.0 || v == 0.0 => {}
                'G' if v == 53.0 => return Err("G53 wird nicht unterstützt".into()),
                'X' => x = Some(v),
                'Y' => y = Some(v),
                'F' => f = Some(v),
                'Z' => return Err("Z lässt sich bei Ruida hier nicht verfahren (Z-Achse an der Steuerung bedienen)".into()),
                _ => return Err(format!("„{k}“ wird beim Verfahren nicht unterstützt")),
            }
        }
        let p = self.pos.ok_or("Position der Maschine unbekannt")?;
        let target = if rel {
            (p.0 + x.unwrap_or(0.0), p.1 + y.unwrap_or(0.0))
        } else {
            (x.map(|v| v + self.wco.0).unwrap_or(p.0), y.map(|v| v + self.wco.1).unwrap_or(p.1))
        };
        let m = self.o.mapping();
        if !m.inside(target.0, target.1) {
            // wie GRBL error:15
            return Err(format!("Ziel X {:.2} Y {:.2} mm liegt außerhalb des Arbeitsbereichs", target.0, target.1));
        }
        let speed = f.map(|v| v / 60.0).unwrap_or(JOG_DEFAULT).clamp(1.0, JOG_MAX);
        let (nx, ny) = m.to_native(target.0, target.1);
        self.link.send(&rd::speed_laser_1(speed))?;
        self.link.send(&rd::rapid_move_xy(nx, ny))?;
        self.moving = true;
        Ok(())
    }

    fn realtime(&mut self, b: u8) -> Result<(), String> {
        match b {
            b'!' => {
                if self.run.is_some() && !self.paused {
                    self.link.send(&rd::PAUSE_PROCESS)?;
                    self.paused = true;
                }
            }
            b'~' => {
                if self.paused {
                    self.link.send(&rd::RESTORE_PROCESS)?;
                    self.paused = false;
                }
            }
            // Reset/Stopp und Jog abbrechen: Bewegung beenden. Hochladen bricht ab, nichts weiteres wird gesendet.
            0x18 | 0x85 => {
                if b == 0x85 && self.run.is_some() {
                    return Ok(());
                }
                let r = self.link.send(&rd::STOP_PROCESS);
                self.paused = false;
                self.homing = None;
                if self.run.take().is_some() {
                    self.busy.store(false, Ordering::SeqCst);
                    self.events.done(false, "Abgebrochen");
                }
                r?;
            }
            _ => {}
        }
        Ok(())
    }

    fn start_job(&mut self, lines: &[String]) {
        if self.run.is_some() {
            return;
        }
        let built = rd::parse_gcode(lines, &self.o, self.wco).and_then(|mv| rd::encode_job(&mv, &self.o, self.pos));
        let job = match built {
            Ok(j) => j,
            Err(e) => {
                self.events.done(false, &e);
                return;
            }
        };
        for w in &job.warnings {
            self.events.line(&format!("[MSG:Ruida: {w}]"));
        }
        let packets = rd::packets(&job, rd::PACKET_MAX);
        self.busy.store(true, Ordering::SeqCst);
        self.paused = false;
        self.events.progress(0, 0, lines.len(), 0);
        self.run = Some(Run { data: job.data, packets, next: 0, total: lines.len(), sent: 0, started: Instant::now(), uploaded: None, seen_running: false, idle_polls: 0 });
    }

    /// Hochladen weiterführen, Zustand abfragen, Ende erkennen
    fn pump(&mut self) -> Result<(), String> {
        if self.uploading() {
            // Einige Pakete am Stück, dann wieder Nachrichten (Stopp) annehmen
            for _ in 0..8 {
                let Some(r) = self.run.as_mut() else { break };
                if r.next >= r.packets.len() {
                    break;
                }
                let (range, line) = r.packets[r.next].clone();
                let chunk = r.data[range].to_vec();
                if let Err(e) = self.link.send(&chunk) {
                    self.run = None;
                    self.busy.store(false, Ordering::SeqCst);
                    // Der Rest des Auftrags fehlt: Steuerung anhalten, soweit sie noch erreichbar ist
                    let _ = self.link.send(&rd::STOP_PROCESS);
                    self.events.done(false, &e);
                    return Err(e);
                }
                let r = self.run.as_mut().unwrap();
                r.next += 1;
                r.sent = (line as usize + 1).min(r.total);
                if r.next == r.packets.len() {
                    r.uploaded = Some(Instant::now());
                }
            }
            self.progress(false);
        }
        let every = if self.uploading() { POLL_UPLOAD } else { POLL };
        if self.last_poll.elapsed() >= every {
            self.last_poll = Instant::now();
            self.poll()?;
            self.check_done();
        }
        Ok(())
    }

    fn progress(&mut self, force: bool) {
        if !force && self.last_progress.elapsed() < PROGRESS {
            return;
        }
        self.last_progress = Instant::now();
        if let Some(r) = &self.run {
            self.events.progress(r.sent, r.sent, r.total, 0);
        }
    }

    /// Zustand und Position lesen, als GRBL-Statuszeile melden
    fn poll(&mut self) -> Result<(), String> {
        self.polls += 1;
        let mut addrs = vec![mem::STATUS, mem::POS_X, mem::POS_Y];
        if self.polls.is_multiple_of(4) {
            addrs.push(mem::POS_Z);
        }
        let mut vals = Vec::with_capacity(addrs.len());
        for &a in &addrs {
            match self.link.query_value(a) {
                Ok(v) => vals.push(v),
                Err(e) => {
                    // Während der Referenzfahrt schweigt die Steuerung oft
                    let homing = self.homing.is_some_and(|t| t.elapsed() < HOMING_QUIET);
                    if !homing {
                        self.fails += 1;
                        if self.fails >= MAX_FAILS {
                            return Err(format!("Die Ruida-Steuerung antwortet nicht mehr ({e})"));
                        }
                    }
                    return Ok(());
                }
            }
        }
        self.fails = 0;
        let m = self.o.mapping();
        let (nx, ny) = ((vals[1] as u32) as i32 as i64, (vals[2] as u32) as i32 as i64);
        let p = m.from_native(nx, ny);
        let moved = self.pos.is_some_and(|q| (q.0 - p.0).abs() > 0.01 || (q.1 - p.1).abs() > 0.01);
        self.pos = Some(p);
        if let Some(&z) = vals.get(3) {
            self.z = ((z as u32) as i32 as f64) / 1000.0;
        }
        self.bits = vals[0];
        self.moving = self.bits & status_bits::MOVING != 0 || moved;
        if let Some(t) = self.homing {
            // Referenzfahrt zu Ende, sobald sich nichts mehr bewegt (frühestens nach 1 s)
            if t.elapsed() > Duration::from_secs(1) && !self.moving {
                self.homing = None;
            }
        }
        self.status();
        Ok(())
    }

    fn status(&self) {
        let running = self.bits & status_bits::JOB_RUNNING != 0;
        let state = if self.homing.is_some() {
            "Home"
        } else if self.paused {
            "Hold:0"
        } else if self.run.is_some() || running {
            "Run"
        } else if self.moving {
            "Jog"
        } else {
            "Idle"
        };
        let Some(p) = self.pos else { return };
        self.events.line(&format!(
            "<{state}|MPos:{},{},{}|WCO:{},{},0.000>",
            fmt3(p.0),
            fmt3(p.1),
            fmt3(self.z),
            fmt3(self.wco.0),
            fmt3(self.wco.1)
        ));
    }

    /// Auftrag fertig, wenn alles gesendet ist und die Steuerung nicht mehr arbeitet
    fn check_done(&mut self) {
        let busy = self.bits & status_bits::JOB_RUNNING != 0 || self.moving;
        let Some(r) = self.run.as_mut() else { return };
        let Some(up) = r.uploaded else { return };
        if self.paused {
            return;
        }
        if busy {
            r.seen_running = true;
            r.idle_polls = 0;
            return;
        }
        r.idle_polls += 1;
        // Kurze Aufträge können zwischen zwei Abfragen fertig werden: dann nach 2 s Stillstand
        let done = (r.seen_running && r.idle_polls >= 2) || (up.elapsed() > Duration::from_secs(2) && r.idle_polls >= 4);
        if !done {
            return;
        }
        let secs = r.started.elapsed().as_secs();
        let total = r.total;
        self.run = None;
        self.busy.store(false, Ordering::SeqCst);
        self.events.progress(total, total, total, 0);
        self.events.done(true, &format!("Fertig nach {}:{:02} min", secs / 60, secs % 60));
    }

    /// Kennung, Firmware und Arbeitsbereich der Steuerung in die Konsole
    fn info(&mut self) {
        let card = self.link.query_value(mem::CARD_ID).ok();
        let version = self.link.query(mem::VERSION).ok().map(|v| rd::reply_text(&v)).unwrap_or_default();
        let rx = self.link.query_value(mem::RANGE_X).ok();
        let ry = self.link.query_value(mem::RANGE_Y).ok();
        let mut s = format!("[MSG:Ruida-Steuerung, Schlüssel 0x{:02X}", self.link.sw.magic);
        if let Some(c) = card {
            s += &format!(", Karte 0x{c:08X}");
        }
        if !version.is_empty() {
            s += &format!(", Firmware {version}");
        }
        s += "]";
        self.events.line(&s);
        if let (Some(x), Some(y)) = (rx, ry) {
            let (x, y) = (x as f64 / 1000.0, y as f64 / 1000.0);
            self.events.line(&format!("[MSG:Ruida: Arbeitsbereich laut Steuerung {x:.1} × {y:.1} mm]"));
            if x > 0.0 && y > 0.0 && ((x - self.o.bed_w).abs() > 1.0 || (y - self.o.bed_h).abs() > 1.0) {
                self.events.line(&format!(
                    "[MSG:Ruida: Achtung, im Gerät sind {:.1} × {:.1} mm eingestellt. Bitte in den Geräteeinstellungen anpassen.]",
                    self.o.bed_w, self.o.bed_h
                ));
            }
        }
    }
}

// ---------- Befehle für die Oberfläche ----------

/// Auf die Antwort des Treiber-Threads warten, ohne den Ereignis-Thread zu blockieren
async fn answer<T: Send + 'static>(rx: std::sync::mpsc::Receiver<T>, secs: u64) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(secs)).map_err(|_| "Zeitüberschreitung beim Warten auf die Antwort".to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Speicheradressen der Steuerung lesen
#[tauri::command]
pub async fn ruida_read(state: tauri::State<'_, crate::machine::Machine>, addrs: Vec<u16>) -> Result<Vec<ReadResult>, String> {
    let n = addrs.len() as u64;
    let (tx, rx) = std::sync::mpsc::channel();
    state.ruida(Msg::Read(addrs, tx))?;
    answer(rx, 10 + n * 2).await
}

/// Eine Einstellung schreiben; Antwort ist der zurückgelesene Wert
#[tauri::command]
pub async fn ruida_write(state: tauri::State<'_, crate::machine::Machine>, addr: u16, value: u64) -> Result<u64, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    state.ruida(Msg::Write(addr, value, tx))?;
    answer(rx, 10).await?
}

/// Aktion der Steuerung: homeXY, homeZ, homeU, focusZ
#[tauri::command]
pub async fn ruida_action(state: tauri::State<'_, crate::machine::Machine>, action: String) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    state.ruida(Msg::Action(action, tx))?;
    answer(rx, 10).await?
}

/// Auftrag als .rd-Datei speichern (für den USB-Stick an der Steuerung).
/// G-Code aus dem Rust-Kern (id) oder als Zeilen; offset = Werkstück-Nullpunkt, start = aktuelle Position.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ruida_save(
    app: tauri::AppHandle,
    native: tauri::State<'_, Arc<crate::native::Native>>,
    id: Option<u32>,
    lines: Option<Vec<String>>,
    connect: Connect,
    offset: (f64, f64),
    start: Option<(f64, f64)>,
    default_name: String,
    filter_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let lines = match (id, lines) {
        (Some(id), _) => native.gcode(id)?.as_ref().clone(),
        (None, Some(l)) => l,
        _ => return Err("Kein G-Code".into()),
    };
    let o = connect.options;
    let job = rd::parse_gcode(&lines, &o, offset).and_then(|mv| rd::encode_job(&mv, &o, start))?;
    let magic = if connect.magic == 0 { rd::MAGICS[0] } else { connect.magic };
    let picked = app.dialog().file().set_file_name(&default_name).add_filter(&filter_name, &["rd"]).blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, rd::rd_file(&job, magic)).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Wörter einer Zeile (wie im Kern, ohne Kommentare)
fn words(s: &str) -> Result<Vec<(char, f64)>, String> {
    let mut out = Vec::new();
    let mut it = s.chars().filter(|c| !c.is_whitespace()).peekable();
    while let Some(c) = it.next() {
        if c == ';' || c == '(' {
            break;
        }
        let k = c.to_ascii_uppercase();
        if !k.is_ascii_alphabetic() {
            return Err(format!("unerwartetes Zeichen „{c}“"));
        }
        let mut n = String::new();
        while let Some(&d) = it.peek() {
            if d.is_ascii_digit() || matches!(d, '.' | '-' | '+') {
                n.push(d);
                it.next();
            } else {
                break;
            }
        }
        out.push((k, n.parse().map_err(|_| format!("Zahl fehlt nach „{k}“"))?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rd::{Swizzle, ACK};
    use std::collections::{HashMap, VecDeque};
    use std::sync::mpsc::channel;
    use std::sync::Mutex;

    /// Nachgebildete Ruida-Steuerung (UDP): bestätigt Pakete, beantwortet DA 00, führt Bewegungen sofort aus
    #[derive(Clone, Default)]
    struct Sim(Arc<Mutex<SimState>>);
    #[derive(Default)]
    struct SimState {
        inbox: VecDeque<Vec<u8>>,
        cmds: Vec<Vec<u8>>,
        values: HashMap<u16, u64>,
        silent: bool,
    }

    impl Transport for Sim {
        fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
            let sw = Swizzle::new(0x88);
            let mut s = self.0.lock().unwrap();
            if s.silent {
                return Ok(());
            }
            let d = sw.decode(&data[2..]);
            s.inbox.push_back(sw.encode(&[ACK]));
            // Befehle trennen
            let mut cmds: Vec<Vec<u8>> = Vec::new();
            for b in d {
                if b >= 0x80 || cmds.is_empty() {
                    cmds.push(vec![b]);
                } else {
                    cmds.last_mut().unwrap().push(b);
                }
            }
            for c in cmds {
                if c.len() == 4 && c[0] == 0xDA && c[1] == 0 {
                    let a = rd::dec_u14(&c[2..4]);
                    let mut r = vec![0xDA, 0x01, c[2], c[3]];
                    r.extend_from_slice(&rd::enc35(*s.values.get(&a).unwrap_or(&0) as i64));
                    s.inbox.push_back(sw.encode(&r));
                    continue;
                }
                if c.len() == 14 && c[0] == 0xDA && c[1] == 1 {
                    let v = rd::dec_u35(&c[4..9]);
                    s.values.insert(rd::dec_u14(&c[2..4]), v);
                }
                if c.len() == 13 && c[0] == 0xD9 && c[1] == 0x10 {
                    // Eilgang sofort ausführen
                    s.values.insert(mem::POS_X, rd::dec_u35(&c[3..8]));
                    s.values.insert(mem::POS_Y, rd::dec_u35(&c[8..13]));
                }
                s.cmds.push(c);
            }
            Ok(())
        }
        fn recv(&mut self, _t: Duration) -> std::io::Result<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().inbox.pop_front())
        }
    }

    #[derive(Clone, Default)]
    struct Ev(Arc<Mutex<Vec<String>>>);
    impl Events for Ev {
        fn line(&self, l: &str) {
            self.0.lock().unwrap().push(l.to_string());
        }
        fn progress(&self, sent: usize, acked: usize, total: usize, _e: usize) {
            self.0.lock().unwrap().push(format!("progress {sent} {acked} {total}"));
        }
        fn done(&self, ok: bool, m: &str) {
            self.0.lock().unwrap().push(format!("done {ok} {m}"));
        }
        fn closed(&self, r: Option<String>) {
            self.0.lock().unwrap().push(format!("closed {r:?}"));
        }
    }

    fn opts() -> Options {
        Options { bed_w: 600.0, bed_h: 400.0, origin: rd::Corner::TopRight, s_max: 1000.0, min_power: 1.0 }
    }

    /// Steuerung steht oben rechts am Nullpunkt
    fn driver() -> (Driver<Sim, Ev>, Sim, Ev) {
        let sim = Sim::default();
        sim.0.lock().unwrap().values.insert(mem::RANGE_X, 600_000);
        sim.0.lock().unwrap().values.insert(mem::RANGE_Y, 400_000);
        let ev = Ev::default();
        let link = open(sim.clone(), Framing::Udp, 0).unwrap();
        let d = Driver::new(link, ev.clone(), Arc::new(AtomicBool::new(false)), opts());
        (d, sim, ev)
    }

    fn lines(ev: &Ev) -> Vec<String> {
        std::mem::take(&mut *ev.0.lock().unwrap())
    }

    #[test]
    fn status_line_in_kizamubeam_coordinates() {
        let (mut d, sim, ev) = driver();
        sim.0.lock().unwrap().values.insert(mem::POS_X, 100_000);
        sim.0.lock().unwrap().values.insert(mem::POS_Y, 50_000);
        d.poll().unwrap();
        // Nullpunkt oben rechts: 100 mm vom rechten Rand, 50 mm vom oberen
        assert!(lines(&ev).contains(&"<Idle|MPos:500.000,350.000,0.000|WCO:0.000,0.000,0.000>".to_string()));
    }

    #[test]
    fn jog_origin_and_bounds() {
        let (mut d, sim, ev) = driver();
        d.poll().unwrap();
        lines(&ev);
        // Relativ von (600, 400) nach links unten
        d.handle(Msg::Base(Cmd::Line("$J=G91 G21 X-100 Y-50 F6000".into()))).unwrap();
        assert_eq!(lines(&ev), vec!["ok"]);
        let s = sim.0.lock().unwrap();
        let c = s.cmds.iter().rev().find(|c| c[0] == 0xD9).unwrap().clone();
        assert_eq!(c[2] & 1, 0, "nie mit Laser");
        assert_eq!((rd::dec_i32(&c[3..8]), rd::dec_i32(&c[8..13])), (100_000, 50_000));
        assert!(s.cmds.iter().any(|c| c.starts_with(&[0xC9, 0x02]) && rd::dec_u35(&c[2..7]) == 100_000), "6000 mm/min = 100 mm/s");
        drop(s);
        d.poll().unwrap();
        // Ursprung hier setzen, dann absolut in Werkstückkoordinaten fahren
        d.handle(Msg::Base(Cmd::Line("G10 L20 P1 X0 Y0".into()))).unwrap();
        assert_eq!(d.wco, (500.0, 350.0));
        d.handle(Msg::Base(Cmd::Line("$J=G90 G21 X10 Y20 F3000".into()))).unwrap();
        let c = sim.0.lock().unwrap().cmds.iter().rev().find(|c| c[0] == 0xD9).unwrap().clone();
        assert_eq!((rd::dec_i32(&c[3..8]), rd::dec_i32(&c[8..13])), (90_000, 30_000));
        lines(&ev);
        // Außerhalb des Betts: abgelehnt, nichts gesendet
        let before = sim.0.lock().unwrap().cmds.len();
        d.handle(Msg::Base(Cmd::Line("$J=G91 G21 X200 F3000".into()))).unwrap();
        let l = lines(&ev);
        assert!(l[0].starts_with("error:") && l[0].contains("außerhalb"), "{l:?}");
        assert_eq!(sim.0.lock().unwrap().cmds.len(), before);
        // Unbekanntes und Laser außerhalb eines Auftrags: abgelehnt
        for bad in ["M3 S100", "G1 X10 F100", "$$", "M8"] {
            d.handle(Msg::Base(Cmd::Line(bad.into()))).unwrap();
            assert!(lines(&ev)[0].starts_with("error:"), "{bad}");
        }
        assert_eq!(sim.0.lock().unwrap().cmds.len(), before);
    }

    #[test]
    fn job_runs_and_finishes() {
        let (mut d, sim, ev) = driver();
        d.poll().unwrap();
        let job: Vec<String> = "G21\nG90\nM4 S0\nG0 X100 Y100\nG1 X120 S500 F1200\nM5\nM2".lines().map(String::from).collect();
        d.handle(Msg::Base(Cmd::Job(job))).unwrap();
        assert!(d.busy.load(Ordering::SeqCst));
        // Neue Zeilen während des Jobs werden nicht ausgeführt
        d.handle(Msg::Base(Cmd::Line("$H".into()))).unwrap();
        d.pump().unwrap();
        assert!(!d.uploading());
        let s = sim.0.lock().unwrap();
        assert!(s.cmds.iter().any(|c| *c == vec![0xD8, 0x00]), "Start im Auftrag");
        assert!(!s.cmds.iter().any(|c| *c == rd::HOME_XY.to_vec()), "kein Home während des Jobs");
        assert_eq!(s.cmds.last().unwrap(), &vec![0xD7]);
        drop(s);
        // Steuerung arbeitet …
        sim.0.lock().unwrap().values.insert(mem::STATUS, status_bits::JOB_RUNNING);
        d.poll().unwrap();
        d.check_done();
        assert!(d.run.is_some());
        // … und ist fertig
        sim.0.lock().unwrap().values.insert(mem::STATUS, 0);
        for _ in 0..2 {
            d.poll().unwrap();
            d.check_done();
        }
        assert!(d.run.is_none());
        assert!(!d.busy.load(Ordering::SeqCst));
        assert!(lines(&ev).iter().any(|l| l.starts_with("done true Fertig nach")));
    }

    #[test]
    fn bad_job_is_rejected_before_sending() {
        let (mut d, sim, ev) = driver();
        d.poll().unwrap();
        let before = sim.0.lock().unwrap().cmds.len();
        d.handle(Msg::Base(Cmd::Job(vec!["G0 X700 Y10".into()]))).unwrap();
        assert!(lines(&ev).iter().any(|l| l.starts_with("done false Ruida: Zeile 1")));
        assert_eq!(sim.0.lock().unwrap().cmds.len(), before);
        assert!(d.run.is_none());
    }

    #[test]
    fn stop_and_pause() {
        let (mut d, sim, ev) = driver();
        d.poll().unwrap();
        let mut job = vec!["M3 S500".to_string(), "G0 X1 Y1".to_string()];
        for i in 0..20000 {
            job.push(format!("G1 X{} Y{} F6000", 1.0 + (i % 2) as f64, 1.0 + (i as f64) * 0.01));
        }
        d.handle(Msg::Base(Cmd::Job(job))).unwrap();
        d.pump().unwrap();
        assert!(d.uploading(), "großer Auftrag: noch nicht ganz gesendet");
        d.handle(Msg::Base(Cmd::Pause)).unwrap();
        d.handle(Msg::Base(Cmd::Resume)).unwrap();
        d.handle(Msg::Base(Cmd::Stop)).unwrap();
        assert!(d.run.is_none());
        let n = sim.0.lock().unwrap().cmds.len();
        d.pump().unwrap();
        let s = sim.0.lock().unwrap();
        let tail: Vec<_> = s.cmds.iter().filter(|c| c[0] == 0xD8).cloned().collect();
        assert!(tail.ends_with(&[rd::PAUSE_PROCESS.to_vec(), rd::RESTORE_PROCESS.to_vec(), rd::STOP_PROCESS.to_vec()]));
        assert!(s.cmds[n..].iter().all(|c| c[0] == 0xDA), "nach dem Stopp nur noch Abfragen");
        assert!(lines(&ev).contains(&"done false Abgebrochen".to_string()));
    }

    #[test]
    fn settings_write_reads_back() {
        let (mut d, sim, _ev) = driver();
        assert_eq!(d.write(0x0005, 300_000).unwrap(), 300_000);
        assert_eq!(sim.0.lock().unwrap().values[&0x0005], 300_000);
        let r = d.read(0x0005);
        assert_eq!(r.value, Some(300_000));
        // Während des Verfahrens gesperrt
        d.moving = true;
        assert!(d.write(0x0005, 1).is_err());
    }

    /// Echter UDP-Weg über 127.0.0.1: nachgebildete Steuerung auf Port 50200, Antworten an Port 40200
    #[test]
    fn udp_loopback() {
        let ctrl = UdpSocket::bind(("127.0.0.1", CTRL_PORT)).expect("Port 50200 frei");
        ctrl.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let h = std::thread::spawn(move || {
            let sw = Swizzle::new(0x38);
            let mut buf = [0u8; 2048];
            let mut got = Vec::new();
            for _ in 0..3 {
                let (n, from) = ctrl.recv_from(&mut buf).unwrap();
                assert_eq!(from.port(), LISTEN_PORT, "Antworten gehen an Port 40200");
                let sum = u16::from_be_bytes([buf[0], buf[1]]) as u32;
                assert_eq!(sum, buf[2..n].iter().map(|&b| b as u32).sum::<u32>() & 0xFFFF);
                let d = sw.decode(&buf[2..n]);
                ctrl.send_to(&sw.encode(&[ACK]), from).unwrap();
                if d.len() == 4 && d[0] == 0xDA {
                    let mut r = vec![0xDA, 0x01, d[2], d[3]];
                    r.extend_from_slice(&rd::enc35(42));
                    ctrl.send_to(&sw.encode(&r), from).unwrap();
                }
                got.push(d);
            }
            got
        });
        // Schlüssel erkennen (ENQ), Zustand lesen, dann Home
        let mut link = open(Udp::open("127.0.0.1").unwrap(), Framing::Udp, 0).unwrap();
        assert_eq!(link.sw.magic, 0x38);
        link.send(&rd::HOME_XY).unwrap();
        let got = h.join().unwrap();
        // Erste Probe mit 0x88: eine 0x38-Steuerung liest sie als einzelnes Byte 0xFF (kein Befehl mit Wirkung),
        // bestätigt aber; aus ihrem ACK ergibt sich der Schlüssel 0x38
        assert_eq!(got[0], vec![0xFF]);
        assert_eq!(got[1], rd::get_setting(mem::STATUS));
        assert_eq!(got[2], rd::HOME_XY.to_vec());
    }

    #[test]
    fn lost_connection_closes() {
        let (d, sim, ev) = driver();
        sim.0.lock().unwrap().silent = true;
        let mut d = d;
        d.link.timeout = Duration::from_millis(5);
        let (tx, rx) = channel();
        let h = std::thread::spawn(move || d.run(rx));
        let t0 = Instant::now();
        while !ev.0.lock().unwrap().iter().any(|l| l.starts_with("closed Some")) {
            assert!(t0.elapsed() < Duration::from_secs(10), "Verbindungsverlust nicht erkannt");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(tx);
        h.join().unwrap();
    }
}
