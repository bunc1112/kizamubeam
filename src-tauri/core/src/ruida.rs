//! Ruida-Steuerungen (RDC6442, RDC6445, RDC6332, KT332 …), wie sie in vielen CO2-Lasern stecken.
//!
//! Ruida spricht kein G-Code: Aufträge sind Binärdateien (.rd) mit Befehlen in 7-Bit-Zahlen, jedes Byte wird
//! „verwürfelt“ (swizzle, Schlüssel je Steuerungsfamilie). Übertragung über Ethernet (UDP, Steuerung Port 50200,
//! Antworten an Port 40200, je Paket Prüfsumme und ACK) oder über USB (seriell, ohne Prüfsumme und ACK).
//! Einstellungen liegen in Speicheradressen, gelesen mit DA 00, geschrieben mit DA 01.
//!
//! Dieses Modul ist ohne Tauri und ohne Netzwerk testbar: Verwürfeln, Zahlenformate, Umrechnung der Koordinaten,
//! G-Code (die Teilmenge, die KizamuBeam erzeugt) → Ruida-Auftrag, Pakete und die Sitzung über ein `Transport`.
//!
//! Quelle für die Befehlscodes: MeerK40t (MIT-Lizenz, meerk40t/ruida/rdjob.py und controller.py), dort an
//! RDC6442S-Steuerungen erprobt. Was hier davon abweicht oder nicht erprobt ist, steht am jeweiligen Befehl.

use std::time::{Duration, Instant};

// ---------- Verwürfeln ----------

/// Bekannte Schlüssel: 0x88 (RDC644x, die meisten), 0x11 (RDC634x), 0x38 (einige ältere/OEM-Steuerungen)
pub const MAGICS: [u8; 3] = [0x88, 0x11, 0x38];

pub fn swizzle_byte(b: u8, magic: u8) -> u8 {
    let mut b = b;
    b ^= b >> 7;
    b ^= b << 7;
    b ^= b >> 7;
    b ^= magic;
    b.wrapping_add(1)
}

pub fn unswizzle_byte(b: u8, magic: u8) -> u8 {
    let mut b = b.wrapping_sub(1);
    b ^= magic;
    b ^= b >> 7;
    b ^= b << 7;
    b ^= b >> 7;
    b
}

/// Tabellen für einen Schlüssel
#[derive(Clone)]
pub struct Swizzle {
    pub magic: u8,
    enc: [u8; 256],
    dec: [u8; 256],
}

impl Swizzle {
    pub fn new(magic: u8) -> Self {
        let mut enc = [0u8; 256];
        let mut dec = [0u8; 256];
        for i in 0..256 {
            enc[i] = swizzle_byte(i as u8, magic);
            dec[i] = unswizzle_byte(i as u8, magic);
        }
        Swizzle { magic, enc, dec }
    }
    pub fn encode(&self, data: &[u8]) -> Vec<u8> {
        data.iter().map(|&b| self.enc[b as usize]).collect()
    }
    pub fn decode(&self, data: &[u8]) -> Vec<u8> {
        data.iter().map(|&b| self.dec[b as usize]).collect()
    }
}

// ---------- Zahlenformate ----------
// Jedes Byte nach dem Befehlsbyte hat Bit 7 = 0 (Befehle beginnen mit Bit 7 = 1), Zahlen bestehen aus 7-Bit-Gruppen.

/// 14 Bit (2 Byte), vorzeichenbehaftet im Zweierkomplement
pub fn enc14(v: i64) -> [u8; 2] {
    [((v >> 7) & 0x7F) as u8, (v & 0x7F) as u8]
}

/// 35 Bit (5 Byte); negative Werte als 32-Bit-Zweierkomplement wie bei RDWorks/LightBurn
pub fn enc35(v: i64) -> [u8; 5] {
    [((v >> 28) & 0x7F) as u8, ((v >> 21) & 0x7F) as u8, ((v >> 14) & 0x7F) as u8, ((v >> 7) & 0x7F) as u8, (v & 0x7F) as u8]
}

pub fn dec_u14(d: &[u8]) -> u16 {
    ((d[0] as u16 & 0x7F) << 7) | (d[1] as u16 & 0x7F)
}

pub fn dec_u35(d: &[u8]) -> u64 {
    d[..5].iter().fold(0u64, |a, &b| (a << 7) | (b as u64 & 0x7F))
}

/// 35-Bit-Wert als vorzeichenbehaftete 32-Bit-Zahl (Positionen)
pub fn dec_i32(d: &[u8]) -> i64 {
    (dec_u35(d) as u32) as i32 as i64
}

/// Leistung in Prozent → 14 Bit (100 % = 16383)
pub fn enc_power(pct: f64) -> [u8; 2] {
    enc14((pct.clamp(0.0, 100.0) * 16383.0 / 100.0).round() as i64)
}

/// Geschwindigkeit in mm/s → µm/s
pub fn enc_speed(mm_s: f64) -> [u8; 5] {
    enc35((mm_s.max(0.0) * 1000.0).round() as i64)
}

/// Speicheradresse (14 Bit, 2 Byte)
pub fn enc_addr(addr: u16) -> [u8; 2] {
    enc14(addr as i64 & 0x3FFF)
}

// ---------- Befehle ----------

pub const ACK: u8 = 0xCC;
pub const ERR: u8 = 0xCD;
pub const ENQ: u8 = 0xCE;
pub const NAK: u8 = 0xCF;

pub const START_PROCESS: [u8; 2] = [0xD8, 0x00];
pub const STOP_PROCESS: [u8; 2] = [0xD8, 0x01];
pub const PAUSE_PROCESS: [u8; 2] = [0xD8, 0x02];
pub const RESTORE_PROCESS: [u8; 2] = [0xD8, 0x03];
pub const HOME_XY: [u8; 2] = [0xD8, 0x2A];
pub const HOME_Z: [u8; 2] = [0xD8, 0x2C];
pub const HOME_U: [u8; 2] = [0xD8, 0x2D];
pub const FOCUS_Z: [u8; 2] = [0xD8, 0x2E];

/// Wichtige Speicheradressen (als 14-Bit-Zahl, wie sie im Befehl stehen)
pub mod mem {
    /// Zustandsbits (siehe `Status`)
    pub const STATUS: u16 = 0x0200;
    pub const POS_X: u16 = 0x0221;
    pub const POS_Y: u16 = 0x0231;
    pub const POS_Z: u16 = 0x0241;
    pub const POS_U: u16 = 0x0251;
    /// Fahrbereich X/Y in µm
    pub const RANGE_X: u16 = 0x0026;
    pub const RANGE_Y: u16 = 0x0036;
    pub const CARD_ID: u16 = 0x02FE;
    /// Firmware-Version als Text
    pub const VERSION: u16 = 0x02FF;
}

/// Zustandsbits aus `mem::STATUS` (bekannt aus MeerK40t an einer RDC6442S; weitere Bits sind nicht entschlüsselt)
pub mod status_bits {
    pub const JOB_RUNNING: u64 = 0x0000_0001;
    pub const PART_END: u64 = 0x0000_0002;
    pub const MOVING: u64 = 0x0100_0000;
}

pub fn get_setting(addr: u16) -> Vec<u8> {
    let a = enc_addr(addr);
    vec![0xDA, 0x00, a[0], a[1]]
}

/// Wert schreiben; die Steuerung erwartet ihn zweimal (wie RDWorks und MeerK40t)
pub fn set_setting(addr: u16, value: u64) -> Vec<u8> {
    let a = enc_addr(addr);
    let v = enc35(value as i64);
    let mut out = vec![0xDA, 0x01, a[0], a[1]];
    out.extend_from_slice(&v);
    out.extend_from_slice(&v);
    out
}

/// Laser-1-Geschwindigkeit (gilt außerhalb eines Auftrags auch für das Verfahren mit D9)
pub fn speed_laser_1(mm_s: f64) -> Vec<u8> {
    let mut out = vec![0xC9, 0x02];
    out.extend_from_slice(&enc_speed(mm_s));
    out
}

/// Eilgang auf eine absolute Maschinenposition (µm). Optionsbyte 0x00 wie bei MeerK40t (dort absolut erprobt).
/// Bit 0 der Option („Light“) würde den Laser während der Fahrt einschalten: wird hier nie gesetzt.
pub fn rapid_move_xy(x_um: i64, y_um: i64) -> Vec<u8> {
    let mut out = vec![0xD9, 0x10, 0x00];
    out.extend_from_slice(&enc35(x_um));
    out.extend_from_slice(&enc35(y_um));
    debug_assert_eq!(out[2] & 0x01, 0, "Laser beim Verfahren nie einschalten");
    out
}

/// Antwort auf DA 00: (Adresse, Rohbytes des Werts)
pub fn parse_reply(data: &[u8]) -> Option<(u16, &[u8])> {
    if data.len() >= 4 && data[0] == 0xDA && data[1] == 0x01 {
        Some((dec_u14(&data[2..4]), &data[4..]))
    } else {
        None
    }
}

/// Zahlenwert einer Antwort (erste 5 Byte)
pub fn reply_value(v: &[u8]) -> Option<u64> {
    (v.len() >= 5).then(|| dec_u35(v))
}

/// Textwert einer Antwort (z. B. Firmware-Version), bis zum ersten Nullbyte
pub fn reply_text(v: &[u8]) -> String {
    let end = v.iter().position(|&b| b == 0).unwrap_or(v.len());
    v[..end].iter().filter(|b| b.is_ascii_graphic() || **b == b' ').map(|&b| b as char).collect::<String>().trim().to_string()
}

// ---------- Koordinaten ----------

/// Ecke, an der die Steuerung ihren Nullpunkt hat (Referenzfahrt). Ruida zählt von dort aus positiv ins Bett.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, serde::Deserialize, serde::Serialize)]
pub enum Corner {
    #[default]
    #[serde(rename = "tr")]
    TopRight,
    #[serde(rename = "tl")]
    TopLeft,
    #[serde(rename = "br")]
    BottomRight,
    #[serde(rename = "bl")]
    BottomLeft,
}

/// Umrechnung KizamuBeam-Maschinenkoordinaten (mm, Ursprung unten links, y nach oben) ↔ Ruida (µm ab Nullpunkt-Ecke)
#[derive(Clone, Copy, Debug)]
pub struct Mapping {
    pub bed_w: f64,
    pub bed_h: f64,
    pub corner: Corner,
}

/// Toleranz an den Bettgrenzen (mm), wie checkBed in gcode.ts
pub const BED_TOLERANCE: f64 = 0.01;

impl Mapping {
    fn right(&self) -> bool {
        matches!(self.corner, Corner::TopRight | Corner::BottomRight)
    }
    fn top(&self) -> bool {
        matches!(self.corner, Corner::TopRight | Corner::TopLeft)
    }
    pub fn inside(&self, x: f64, y: f64) -> bool {
        x.is_finite() && y.is_finite() && x >= -BED_TOLERANCE && y >= -BED_TOLERANCE && x <= self.bed_w + BED_TOLERANCE && y <= self.bed_h + BED_TOLERANCE
    }
    /// mm → µm der Steuerung; Punkte knapp außerhalb (Toleranz) werden auf den Rand gesetzt
    pub fn to_native(&self, x: f64, y: f64) -> (i64, i64) {
        let x = x.clamp(0.0, self.bed_w);
        let y = y.clamp(0.0, self.bed_h);
        let nx = if self.right() { self.bed_w - x } else { x };
        let ny = if self.top() { self.bed_h - y } else { y };
        ((nx * 1000.0).round() as i64, (ny * 1000.0).round() as i64)
    }
    pub fn from_native(&self, nx: i64, ny: i64) -> (f64, f64) {
        let (nx, ny) = (nx as f64 / 1000.0, ny as f64 / 1000.0);
        let x = if self.right() { self.bed_w - nx } else { nx };
        let y = if self.top() { self.bed_h - ny } else { ny };
        (x, y)
    }
}

// ---------- G-Code → Bewegungen ----------

/// Eine Bewegung in Maschinenkoordinaten (mm)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Move {
    pub x: f64,
    pub y: f64,
    /// mm/s; 0 = Eilgang
    pub speed: f64,
    /// Prozent 0 … 100 (0 = Laser aus)
    pub power: f64,
    /// M4: Leistung folgt der Geschwindigkeit (Ruida: Min-Leistung in Ecken)
    pub dynamic: bool,
    pub air: bool,
    /// Index der G-Code-Zeile
    pub line: u32,
}

impl Move {
    pub fn burns(&self) -> bool {
        self.speed > 0.0 && self.power > 0.0
    }
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub bed_w: f64,
    pub bed_h: f64,
    #[serde(default)]
    pub origin: Corner,
    /// S-Wert für 100 %
    pub s_max: f64,
    /// Min-Leistung (Ecken, langsame Stellen) bei M4 als Anteil der Leistung 0 … 1; bei M3 immer gleich der Leistung
    #[serde(default = "one")]
    pub min_power: f64,
}

fn one() -> f64 {
    1.0
}

impl Options {
    pub fn mapping(&self) -> Mapping {
        Mapping { bed_w: self.bed_w, bed_h: self.bed_h, corner: self.origin }
    }
}

/// Fehler mit Zeilennummer (1-basiert) und Inhalt; Form „Ruida: Zeile 12 (G0 Z5): Grund“ (übersetzt in i18n.ts)
fn line_err(i: usize, line: &str, msg: &str) -> String {
    format!("Ruida: Zeile {} ({}): {msg}", i + 1, line.trim())
}

/// Wörter einer Zeile (Buchstabe, Zahl), ohne Kommentare
fn words(line: &str) -> Result<Vec<(char, f64)>, String> {
    let mut s = String::with_capacity(line.len());
    let mut depth = 0;
    for c in line.chars() {
        match c {
            ';' if depth == 0 => break,
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => s.push(c),
            _ => {}
        }
    }
    let mut out = Vec::new();
    let mut it = s.chars().filter(|c| !c.is_whitespace()).peekable();
    while let Some(c) = it.next() {
        let letter = c.to_ascii_uppercase();
        if !letter.is_ascii_alphabetic() {
            return Err(format!("unerwartetes Zeichen „{c}“"));
        }
        let mut num = String::new();
        while let Some(&d) = it.peek() {
            if d.is_ascii_digit() || d == '.' || d == '-' || d == '+' {
                num.push(d);
                it.next();
            } else {
                break;
            }
        }
        let v: f64 = num.parse().map_err(|_| format!("Zahl fehlt nach „{letter}“"))?;
        out.push((letter, v));
    }
    Ok(out)
}

/// G-Code eines Auftrags in Bewegungen übersetzen. Versteht genau das, was KizamuBeam für Aufträge schreibt
/// (G0/G1 X Y S F, G21, G90/G91, M3/M4/M5, M7/M8/M9, M2/M30, Kommentare); alles andere ist ein Fehler,
/// bevor ein Byte an die Steuerung geht. `offset` = Werkstück-Nullpunkt in Maschinenkoordinaten.
pub fn parse_gcode(lines: &[String], o: &Options, offset: (f64, f64)) -> Result<Vec<Move>, String> {
    if o.s_max.is_nan() || o.s_max <= 0.0 {
        return Err("Ruida: S-Wert für 100 % fehlt".into());
    }
    let mut out = Vec::new();
    let (mut x, mut y) = (f64::NAN, f64::NAN);
    let (mut abs, mut rapid) = (true, true);
    let (mut feed, mut s) = (0.0f64, 0.0f64);
    let (mut laser, mut dynamic, mut air) = (false, false, false);
    for (i, raw) in lines.iter().enumerate() {
        let w = words(raw).map_err(|e| line_err(i, raw, &e))?;
        if w.is_empty() {
            continue;
        }
        let mut target: (Option<f64>, Option<f64>) = (None, None);
        for &(c, v) in &w {
            let iv = v as i64;
            let int = v.fract() == 0.0;
            match c {
                // G0/G1 gelten modal auch für folgende Zeilen ohne G-Wort
                'G' if int && (iv == 0 || iv == 1) => rapid = iv == 0,
                'G' if int && iv == 21 => {}
                'G' if int && iv == 20 => return Err(line_err(i, raw, "Zoll (G20) wird nicht unterstützt")),
                'G' if int && iv == 90 => abs = true,
                'G' if int && iv == 91 => abs = false,
                'M' if int && (iv == 3 || iv == 4) => {
                    laser = true;
                    dynamic = iv == 4;
                }
                'M' if int && iv == 5 => laser = false,
                'M' if int && (iv == 7 || iv == 8) => air = true,
                'M' if int && iv == 9 => air = false,
                'M' if int && (iv == 2 || iv == 30) => laser = false,
                'X' => target.0 = Some(v),
                'Y' => target.1 = Some(v),
                'F' => feed = v / 60.0,
                'S' => s = (v / o.s_max * 100.0).clamp(0.0, 100.0),
                'Z' => return Err(line_err(i, raw, "Z-Bewegungen im Auftrag werden mit Ruida nicht unterstützt (Z-Versatz im Layer ausschalten, Fokus an der Steuerung einstellen)")),
                'A' | 'B' | 'C' | 'U' => return Err(line_err(i, raw, "Zusatzachsen werden mit Ruida nicht unterstützt (Drehachse am Y-Anschluss verwenden oder den Rotary-Modus der Steuerung)")),
                'M' if int && (iv == 64 || iv == 65 || iv == 62 || iv == 63) => return Err(line_err(i, raw, "Digitale Ausgänge (M62–M65) gibt es bei Ruida nicht; in den Geräteeinstellungen unter „Ausgänge im Job“ entfernen")),
                'G' if int && iv == 4 => return Err(line_err(i, raw, "Verweilzeit (G4) wird mit Ruida nicht unterstützt")),
                'G' if int && (iv == 2 || iv == 3) => return Err(line_err(i, raw, "Kreisbögen (G2/G3) werden mit Ruida nicht unterstützt")),
                'P' | 'L' | 'I' | 'J' | 'R' => return Err(line_err(i, raw, "Parameter wird nicht unterstützt")),
                _ => return Err(line_err(i, raw, "Befehl wird mit Ruida nicht unterstützt")),
            }
        }
        if target.0.is_none() && target.1.is_none() {
            continue;
        }
        let (tx, ty) = if abs {
            (target.0.map(|v| v + offset.0).unwrap_or(x), target.1.map(|v| v + offset.1).unwrap_or(y))
        } else {
            if x.is_nan() || y.is_nan() {
                return Err(line_err(i, raw, "relative Bewegung ohne bekannte Startposition"));
            }
            (x + target.0.unwrap_or(0.0), y + target.1.unwrap_or(0.0))
        };
        if tx.is_nan() || ty.is_nan() {
            return Err(line_err(i, raw, "erste Bewegung braucht X und Y"));
        }
        let m = o.mapping();
        if !m.inside(tx, ty) {
            return Err(format!("Ruida: Zeile {} ({}): Ziel X {tx:.3} Y {ty:.3} mm liegt außerhalb des Arbeitsbereichs {} × {} mm", i + 1, raw.trim(), o.bed_w, o.bed_h));
        }
        let cut = !rapid && laser && s > 0.0;
        if !rapid && feed <= 0.0 && cut {
            return Err(line_err(i, raw, "Vorschub (F) fehlt"));
        }
        out.push(Move { x: tx, y: ty, speed: if cut { feed } else { 0.0 }, power: if cut { s } else { 0.0 }, dynamic, air, line: i as u32 });
        x = tx;
        y = ty;
    }
    Ok(out)
}

// ---------- Auftrag (.rd) schreiben ----------

/// Fertiger Auftrag: Befehle unverwürfelt hintereinander, Grenzen je Befehl und der Fortschritt je Befehl
pub struct RdJob {
    pub data: Vec<u8>,
    /// Startindex jedes Befehls in `data`
    pub starts: Vec<u32>,
    /// G-Code-Zeile, die nach dem jeweiligen Befehl erledigt ist (für den Fortschritt)
    pub line_after: Vec<u32>,
    pub warnings: Vec<String>,
    /// Anzahl der Abschnitte (Ruida-Layer)
    pub parts: usize,
}

struct Writer {
    job: RdJob,
    line: u32,
}

impl Writer {
    fn cmd(&mut self, parts: &[&[u8]]) {
        self.job.starts.push(self.job.data.len() as u32);
        for p in parts {
            self.job.data.extend_from_slice(p);
        }
        self.job.line_after.push(self.line);
    }
}

/// Größte relative Bewegung, die als 14 Bit passt (µm)
const REL_MAX: i64 = 8191;
/// Höchstens so viele Abschnitte: die Nummer steht in einem Byte mit Bit 7 = 0
pub const MAX_PARTS: usize = 128;

/// Abschnitt: gleiche Air-Assist-Einstellung; Geschwindigkeit und Leistung ändern sich darin mit C9 02 / C6 01 02
struct Part {
    air: bool,
    speed: f64,
    power: f64,
    min: f64,
    bounds: [i64; 4],
}

fn min_power(m: &Move, o: &Options) -> f64 {
    if m.dynamic {
        m.power * o.min_power.clamp(0.0, 1.0)
    } else {
        m.power
    }
}

/// Bewegungen zu einem Ruida-Auftrag. Aufbau wie in MeerK40t (write_header, write_settings, write_tail).
pub fn encode_job(moves: &[Move], o: &Options, start: Option<(f64, f64)>) -> Result<RdJob, String> {
    let m = o.mapping();
    let mut w = Writer { job: RdJob { data: Vec::new(), starts: Vec::new(), line_after: Vec::new(), warnings: Vec::new(), parts: 0 }, line: 0 };
    if moves.is_empty() {
        return Err("Ruida: Der Auftrag enthält keine Bewegungen.".into());
    }
    // Doppelt geprüft (parse_gcode prüft schon): to_native darf nur Punkte im Arbeitsbereich bekommen
    if moves.iter().any(|mv| !m.inside(mv.x, mv.y)) {
        return Err("Ruida: Ein Punkt des Auftrags liegt außerhalb des Arbeitsbereichs.".into());
    }
    // Abschnitte bilden
    let mut parts: Vec<Part> = Vec::new();
    let mut part_of: Vec<usize> = Vec::with_capacity(moves.len());
    let mut cur: Option<usize> = None;
    for mv in moves {
        let (nx, ny) = m.to_native(mv.x, mv.y);
        let new_part = match cur {
            None => true,
            Some(p) => mv.burns() && parts[p].air != mv.air && parts[p].speed > 0.0,
        };
        if new_part {
            if parts.len() >= MAX_PARTS {
                return Err(format!("Ruida: Zu viele Abschnitte (mehr als {MAX_PARTS} Wechsel von Air Assist)."));
            }
            parts.push(Part { air: mv.air, speed: 0.0, power: 0.0, min: 0.0, bounds: [nx, ny, nx, ny] });
            cur = Some(parts.len() - 1);
        }
        let p = &mut parts[cur.unwrap()];
        if mv.burns() && p.speed == 0.0 {
            p.air = mv.air;
            p.speed = mv.speed;
            p.power = mv.power;
            p.min = min_power(mv, o);
        }
        p.bounds = [p.bounds[0].min(nx), p.bounds[1].min(ny), p.bounds[2].max(nx), p.bounds[3].max(ny)];
        part_of.push(cur.unwrap());
    }
    w.job.parts = parts.len();
    let b = parts.iter().fold([i64::MAX, i64::MAX, i64::MIN, i64::MIN], |a, p| [a[0].min(p.bounds[0]), a[1].min(p.bounds[1]), a[2].max(p.bounds[2]), a[3].max(p.bounds[3])]);
    let (min_x, min_y, max_x, max_y) = (b[0], b[1], b[2], b[3]);
    let low = moves.iter().filter(|mv| mv.burns()).any(|mv| mv.power < 10.0);
    if low {
        w.job.warnings.push("Leistung unter 10 %: CO2-Röhren zünden darunter oft nicht.".into());
    }

    // Kopf: Maschinen-Nullpunkt, absolute Koordinaten
    w.cmd(&[&[0xD8, 0x10]]); // Bezugspunkt: Maschinen-Nullpunkt (absolute Position)
    w.cmd(&[&[0xE6, 0x01]]); // absolut
    w.cmd(&[&[0xF0]]); // Bezugspunkt setzen
    w.cmd(&[&[0xF1, 0x02, 0x00]]); // Blockschnitt aus
    w.cmd(&[&START_PROCESS]);
    w.cmd(&[&[0xE7, 0x06], &enc35(0), &enc35(0)]); // Vorschub-Wiederholung
    w.cmd(&[&[0xE7, 0x38, 0x00]]); // Vorschub-Autopause aus
    // Reihenfolge der Werte wie bei MeerK40t (Ruida-Koordinaten, Nullpunkt oben rechts)
    w.cmd(&[&[0xE7, 0x03], &enc35(max_x), &enc35(min_y)]);
    w.cmd(&[&[0xE7, 0x07], &enc35(min_x), &enc35(max_y)]);
    w.cmd(&[&[0xE7, 0x50], &enc35(max_x), &enc35(min_y)]);
    w.cmd(&[&[0xE7, 0x51], &enc35(min_x), &enc35(max_y)]);
    w.cmd(&[&[0xE7, 0x04], &enc14(1), &enc14(1), &enc14(0), &enc14(0), &enc14(0), &enc14(0), &enc14(0)]);
    w.cmd(&[&[0xE7, 0x05, 0x00]]);
    for (i, p) in parts.iter().enumerate() {
        let n = [i as u8];
        let speed = if p.speed > 0.0 { p.speed } else { 100.0 };
        w.cmd(&[&[0xC9, 0x04], &n, &enc_speed(speed)]);
        w.cmd(&[&[0xC6, 0x31], &n, &enc_power(p.min)]);
        w.cmd(&[&[0xC6, 0x32], &n, &enc_power(p.power)]);
        w.cmd(&[&[0xC6, 0x41], &n, &enc_power(p.min)]);
        w.cmd(&[&[0xC6, 0x42], &n, &enc_power(p.power)]);
        w.cmd(&[&[0xCA, 0x06], &n, &enc35(0)]); // Farbe
        w.cmd(&[&[0xCA, 0x41], &n, &[0x00]]); // Arbeitsart
        w.cmd(&[&[0xE7, 0x52], &n, &enc35(p.bounds[0]), &enc35(p.bounds[1])]);
        w.cmd(&[&[0xE7, 0x53], &n, &enc35(p.bounds[2]), &enc35(p.bounds[3])]);
        w.cmd(&[&[0xE7, 0x61], &n, &enc35(p.bounds[0]), &enc35(p.bounds[1])]);
        w.cmd(&[&[0xE7, 0x62], &n, &enc35(p.bounds[2]), &enc35(p.bounds[3])]);
    }
    w.cmd(&[&[0xCA, 0x22, (parts.len() - 1) as u8]]);
    w.cmd(&[&[0xE7, 0x54, 0x00], &enc35(0)]);
    w.cmd(&[&[0xE7, 0x54, 0x01], &enc35(0)]);
    w.cmd(&[&[0xE7, 0x55, 0x00], &enc35(0)]);
    w.cmd(&[&[0xE7, 0x55, 0x01], &enc35(0)]);
    w.cmd(&[&[0xF1, 0x03], &enc35(0), &enc35(0)]);
    w.cmd(&[&[0xE7, 0x0A], &enc35(0)]);
    w.cmd(&[&[0xEA, 0x00]]);
    w.cmd(&[&[0xE7, 0x60, 0x00]]);
    w.cmd(&[&[0xE7, 0x0B, 0x00]]);
    w.cmd(&[&[0xE7, 0x13], &enc35(min_x), &enc35(min_y)]);
    w.cmd(&[&[0xE7, 0x17], &enc35(max_x), &enc35(max_y)]);
    w.cmd(&[&[0xE7, 0x23], &enc35(0), &enc35(0)]);
    w.cmd(&[&[0xE7, 0x24, 0x00]]);
    w.cmd(&[&[0xE7, 0x08], &enc14(1), &enc14(1), &enc14(0), &enc14(1123), &enc14(-3328), &enc14(4), &enc14(3480)]);

    // Bewegungen
    let mut pos: Option<(i64, i64)> = None;
    let (mut cur_speed, mut cur_power, mut cur_min) = (-1.0f64, -1.0f64, -1.0f64);
    let mut cur_part: Option<usize> = None;
    // Startpunkt bekannt (aktuelle Position): erst dorthin, damit die erste Bewegung kein Schnitt aus dem Nichts ist
    let first_burns = moves.first().map(|mv| mv.burns()).unwrap_or(false);
    for (k, mv) in moves.iter().enumerate() {
        let pi = part_of[k];
        if cur_part != Some(pi) {
            if cur_part.is_some() {
                w.cmd(&[&[0xE7, 0x00]]);
                w.cmd(&[&[0xCA, 0x01, 0x00]]);
                w.cmd(&[&[0xCA, 0x01, 0x30]]);
            }
            let p = &parts[pi];
            let speed = if p.speed > 0.0 { p.speed } else { 100.0 };
            w.cmd(&[&[0xCA, 0x02, pi as u8]]);
            w.cmd(&[&[0xCA, 0x01, 0x10]]);
            w.cmd(&[&[0xCA, 0x01, if p.air { 0x13 } else { 0x12 }]]);
            w.cmd(&[&[0xC9, 0x02], &enc_speed(speed)]);
            w.cmd(&[&[0xC6, 0x12], &enc35(0)]);
            w.cmd(&[&[0xC6, 0x13], &enc35(0)]);
            w.cmd(&[&[0xC6, 0x01], &enc_power(p.min)]);
            w.cmd(&[&[0xC6, 0x02], &enc_power(p.power)]);
            w.cmd(&[&[0xC6, 0x21], &enc_power(p.min)]);
            w.cmd(&[&[0xC6, 0x22], &enc_power(p.power)]);
            w.cmd(&[&[0xCA, 0x03, 0x01]]);
            cur_speed = speed;
            cur_power = p.power;
            cur_min = p.min;
            cur_part = Some(pi);
            if pos.is_none() && first_burns {
                // Die erste Bewegung schneidet: vorher ohne Laser an den Anfang (Startpunkt oder der Punkt selbst)
                let (sx, sy) = start.unwrap_or((mv.x, mv.y));
                if !m.inside(sx, sy) {
                    return Err("Ruida: Startpunkt liegt außerhalb des Arbeitsbereichs.".into());
                }
                let (nx, ny) = m.to_native(sx, sy);
                w.cmd(&[&[0x88], &enc35(nx), &enc35(ny)]);
                pos = Some((nx, ny));
            }
        }
        w.line = mv.line;
        let (nx, ny) = m.to_native(mv.x, mv.y);
        let cut = mv.burns();
        if cut {
            if (mv.power - cur_power).abs() > 1e-9 || (min_power(mv, o) - cur_min).abs() > 1e-9 {
                let mn = min_power(mv, o);
                w.cmd(&[&[0xC6, 0x01], &enc_power(mn)]);
                w.cmd(&[&[0xC6, 0x02], &enc_power(mv.power)]);
                cur_power = mv.power;
                cur_min = mn;
            }
            if (mv.speed - cur_speed).abs() > 1e-9 {
                w.cmd(&[&[0xC9, 0x02], &enc_speed(mv.speed)]);
                cur_speed = mv.speed;
            }
        }
        let Some((px, py)) = pos else {
            // erste Bewegung immer absolut
            w.cmd(&[&[if cut { 0xA8 } else { 0x88 }], &enc35(nx), &enc35(ny)]);
            pos = Some((nx, ny));
            continue;
        };
        let (dx, dy) = (nx - px, ny - py);
        if dx == 0 && dy == 0 {
            continue;
        }
        let base = if cut { 0xA8 } else { 0x88 };
        if dx.abs() > REL_MAX || dy.abs() > REL_MAX {
            w.cmd(&[&[base], &enc35(nx), &enc35(ny)]);
        } else if dy == 0 {
            w.cmd(&[&[base + 2], &enc14(dx)]);
        } else if dx == 0 {
            w.cmd(&[&[base + 3], &enc14(dy)]);
        } else {
            w.cmd(&[&[base + 1], &enc14(dx), &enc14(dy)]);
        }
        pos = Some((nx, ny));
    }
    if let Some(last) = moves.last() {
        w.line = last.line;
    }
    // Ende
    w.cmd(&[&[0xE7, 0x00]]);
    w.cmd(&[&[0xCA, 0x01, 0x00]]);
    w.cmd(&[&[0xCA, 0x01, 0x30]]);
    let sum: u64 = w.job.data.iter().map(|&b| b as u64).sum::<u64>() + 0xD7;
    w.cmd(&[&[0xE5, 0x05], &enc35(sum as i64)]);
    w.cmd(&[&[0xD7]]);
    Ok(w.job)
}

/// Befehle in Pakete von höchstens `max` Byte aufteilen (nie mitten in einem Befehl).
/// Ergebnis: (Bereich in `data`, erledigte G-Code-Zeile nach dem Paket)
pub fn packets(job: &RdJob, max: usize) -> Vec<(std::ops::Range<usize>, u32)> {
    let mut out = Vec::new();
    let n = job.starts.len();
    // Ende des Befehls k
    let end = |k: usize| if k + 1 < n { job.starts[k + 1] as usize } else { job.data.len() };
    let mut i = 0;
    while i < n {
        let from = job.starts[i] as usize;
        // Befehle i..j; mindestens einer, auch wenn er allein größer als max ist
        let mut j = i + 1;
        while j < n && end(j) - from <= max {
            j += 1;
        }
        out.push((from..end(j - 1), job.line_after[j - 1]));
        i = j;
    }
    out
}

/// Auftrag als .rd-Datei (verwürfelt mit dem Schlüssel der Steuerung)
pub fn rd_file(job: &RdJob, magic: u8) -> Vec<u8> {
    Swizzle::new(magic).encode(&job.data)
}

// ---------- Sitzung ----------

/// Übertragungsweg: UDP-Socket oder serielle USB-Verbindung
pub trait Transport: Send {
    fn send(&mut self, data: &[u8]) -> std::io::Result<()>;
    /// UDP: das nächste Paket; USB: die bis dahin gelesenen Bytes. None = nichts innerhalb von `timeout`.
    fn recv(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Framing {
    /// Prüfsumme vor jedem Paket, die Steuerung bestätigt mit ACK
    Udp,
    /// Rohdaten ohne Prüfsumme und ohne ACK
    Usb,
}

/// Größte Nutzlast je UDP-Paket (MeerK40t: um 1000 Byte; Steuerungen nehmen bis etwa 1470)
pub const PACKET_MAX: usize = 1000;

pub struct Link<T: Transport> {
    pub t: T,
    pub framing: Framing,
    pub sw: Swizzle,
    /// Wartezeit auf ACK bzw. Antwort
    pub timeout: Duration,
    pub naks: u32,
}

/// Gesamtwartezeit auf ACK/Antwort im Normalbetrieb
pub const TIMEOUT: Duration = Duration::from_millis(1500);
const NAK_RETRIES: u32 = 5;

impl<T: Transport> Link<T> {
    pub fn new(t: T, framing: Framing, magic: u8) -> Self {
        Link { t, framing, sw: Swizzle::new(magic), timeout: TIMEOUT, naks: 0 }
    }

    fn package(&self, raw: &[u8]) -> Vec<u8> {
        let body = self.sw.encode(raw);
        match self.framing {
            Framing::Udp => {
                let sum = body.iter().map(|&b| b as u32).sum::<u32>() & 0xFFFF;
                let mut out = Vec::with_capacity(body.len() + 2);
                out.extend_from_slice(&(sum as u16).to_be_bytes());
                out.extend_from_slice(&body);
                out
            }
            Framing::Usb => body,
        }
    }

    /// Alte Antworten verwerfen (z. B. verspätete ACKs)
    pub fn purge(&mut self) {
        while let Ok(Some(_)) = self.t.recv(Duration::ZERO) {}
    }

    /// Befehle senden. UDP: auf ACK warten; NAK = Paket erneut senden. Ohne Antwort wird NICHT erneut gesendet,
    /// denn ein schon angekommenes Paket (verlorenes ACK) würde sonst doppelt ausgeführt.
    pub fn send(&mut self, raw: &[u8]) -> Result<(), String> {
        let pkt = self.package(raw);
        self.t.send(&pkt).map_err(|e| e.to_string())?;
        if self.framing == Framing::Usb {
            return Ok(());
        }
        let deadline = Instant::now() + self.timeout;
        let mut naks = 0;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("Ruida: Keine Bestätigung von der Steuerung (Zeitüberschreitung).".into());
            }
            let Some(p) = self.t.recv(left).map_err(|e| e.to_string())? else { continue };
            let d = self.sw.decode(&p);
            match d.as_slice() {
                [ACK] => return Ok(()),
                [NAK] => {
                    naks += 1;
                    self.naks += 1;
                    if naks > NAK_RETRIES {
                        return Err("Ruida: Die Steuerung hat das Paket mehrfach abgelehnt (NAK).".into());
                    }
                    self.t.send(&pkt).map_err(|e| e.to_string())?;
                }
                [ERR] => return Err("Ruida: Die Steuerung meldet einen Fehler (ERR).".into()),
                // ENQ oder eine verspätete Antwort: weiter auf ACK warten
                _ => {}
            }
        }
    }

    /// Wert lesen (DA 00). Antwort: Rohbytes des Werts nach der Adresse.
    pub fn query(&mut self, addr: u16) -> Result<Vec<u8>, String> {
        self.purge();
        let raw = get_setting(addr);
        let deadline = Instant::now() + self.timeout;
        match self.framing {
            Framing::Udp => {
                let pkt = self.package(&raw);
                self.t.send(&pkt).map_err(|e| e.to_string())?;
                let mut naks = 0;
                loop {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(format!("Ruida: Keine Antwort auf Adresse 0x{addr:04X}."));
                    }
                    let Some(p) = self.t.recv(left).map_err(|e| e.to_string())? else { continue };
                    let d = self.sw.decode(&p);
                    if d == [NAK] {
                        naks += 1;
                        if naks > NAK_RETRIES {
                            return Err("Ruida: Die Steuerung hat die Anfrage mehrfach abgelehnt (NAK).".into());
                        }
                        self.t.send(&pkt).map_err(|e| e.to_string())?;
                        continue;
                    }
                    if let Some((a, v)) = parse_reply(&d) {
                        if a == addr {
                            return Ok(v.to_vec());
                        }
                    }
                }
            }
            Framing::Usb => {
                self.t.send(&self.package(&raw)).map_err(|e| e.to_string())?;
                let mut buf: Vec<u8> = Vec::new();
                loop {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(format!("Ruida: Keine Antwort auf Adresse 0x{addr:04X}."));
                    }
                    if let Some(p) = self.t.recv(left.min(Duration::from_millis(50))).map_err(|e| e.to_string())? {
                        buf.extend(self.sw.decode(&p));
                    }
                    // Antwort beginnt mit DA 01; Zahlenwerte haben 5 Byte, Text endet mit 0
                    if let Some(k) = buf.windows(2).position(|w| w == [0xDA, 0x01]) {
                        let r = &buf[k..];
                        if let Some((a, v)) = parse_reply(r) {
                            if a == addr && (v.len() >= 5 || v.contains(&0)) {
                                return Ok(v.to_vec());
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn query_value(&mut self, addr: u16) -> Result<u64, String> {
        let v = self.query(addr)?;
        reply_value(&v).ok_or_else(|| format!("Ruida: Unvollständige Antwort auf Adresse 0x{addr:04X}."))
    }
}

/// Schlüssel erkennen. UDP: ENQ (ein Byte) mit jedem Schlüssel senden; das ACK der Steuerung ist mit IHREM Schlüssel
/// verwürfelt, daraus ergibt er sich. Mit falschem Schlüssel wird ENQ zu einem Datenbyte (0x57, 0x66) oder zu 0xFF,
/// nie zu einem Befehl mit Wirkung (siehe Test `enq_with_wrong_magic_is_harmless`).
/// USB: Zustand lesen (DA 00 02 00), die Antwort muss sich mit dem Schlüssel zu DA 01 entschlüsseln.
pub fn detect_magic<T: Transport>(t: &mut T, framing: Framing, per_try: Duration) -> Option<u8> {
    for &m in &MAGICS {
        let sw = Swizzle::new(m);
        while let Ok(Some(_)) = t.recv(Duration::ZERO) {}
        match framing {
            Framing::Udp => {
                let body = sw.encode(&[ENQ]);
                let sum = body.iter().map(|&b| b as u32).sum::<u32>() as u16;
                let mut pkt = sum.to_be_bytes().to_vec();
                pkt.extend_from_slice(&body);
                if t.send(&pkt).is_err() {
                    return None;
                }
                let deadline = Instant::now() + per_try;
                while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                    let Ok(Some(p)) = t.recv(left) else { break };
                    if p.len() == 1 {
                        if let Some(&found) = MAGICS.iter().find(|&&c| unswizzle_byte(p[0], c) == ACK) {
                            return Some(found);
                        }
                    }
                }
            }
            Framing::Usb => {
                if t.send(&sw.encode(&get_setting(mem::STATUS))).is_err() {
                    return None;
                }
                let deadline = Instant::now() + per_try;
                let mut buf = Vec::new();
                while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                    match t.recv(left.min(Duration::from_millis(50))) {
                        Ok(Some(p)) => buf.extend(p),
                        Ok(None) => {}
                        Err(_) => break,
                    }
                    if sw.decode(&buf).windows(2).any(|w| w == [0xDA, 0x01]) {
                        return Some(m);
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn swizzle_roundtrip_all_magics() {
        for m in 0..=255u8 {
            for b in 0..=255u8 {
                assert_eq!(unswizzle_byte(swizzle_byte(b, m), m), b);
            }
        }
    }

    #[test]
    fn swizzle_matches_meerk40t() {
        // meerk40t: encode_bytes(b"\xda\x00\x05\x7e", magic=0x88)
        let sw = Swizzle::new(0x88);
        let e = sw.encode(&[0xDA, 0x00, 0x05, 0x7E]);
        // Werte aus derselben Formel in Python nachgerechnet
        let expect: Vec<u8> = [0xDAu8, 0x00, 0x05, 0x7E].iter().map(|&b| swizzle_byte(b, 0x88)).collect();
        assert_eq!(e, expect);
        assert_eq!(swizzle_byte(0x00, 0x88), 0x89, "0 wird zu magic + 1 (Histogramm-Erkennung in MeerK40t)");
        assert_eq!(swizzle_byte(0x00, 0x11), 0x12);
    }

    #[test]
    fn enq_with_wrong_magic_is_harmless() {
        // Mit falschem Schlüssel gesendet, entschlüsselt die Steuerung ENQ zu einem anderen Byte.
        // Es darf kein Befehl mit Wirkung sein (Start, Stopp, Home, Bewegung …).
        let dangerous = [0xD7u8, 0xD8, 0xD9, 0x88, 0x89, 0x8A, 0x8B, 0xA8, 0xA9, 0xAA, 0xAB, 0xDA, 0xE5, 0xE8, 0xC6, 0xC7, 0xC9, 0xCA];
        for &sent in &MAGICS {
            for &ctrl in &MAGICS {
                if sent == ctrl {
                    continue;
                }
                let got = unswizzle_byte(swizzle_byte(ENQ, sent), ctrl);
                assert!(!dangerous.contains(&got), "ENQ mit 0x{sent:02X} an 0x{ctrl:02X}-Steuerung ergibt 0x{got:02X}");
            }
        }
    }

    #[test]
    fn numbers() {
        assert_eq!(enc14(1), [0, 1]);
        assert_eq!(enc14(-1), [0x7F, 0x7F]);
        assert_eq!(enc14(8191), [0x3F, 0x7F]);
        assert_eq!(enc35(100_000), [0, 0, 6, 0x0D, 0x20]);
        assert_eq!(dec_u35(&enc35(123_456_789)), 123_456_789);
        assert_eq!(dec_i32(&enc35(-5000)), -5000);
        assert_eq!(enc_power(100.0), [0x7F, 0x7F]);
        assert_eq!(enc_power(50.0), enc14(8192));
        assert_eq!(enc_speed(100.0), enc35(100_000));
        for b in enc35(-123456).iter().chain(enc14(-77).iter()) {
            assert!(*b < 0x80, "Datenbytes haben Bit 7 = 0");
        }
    }

    #[test]
    fn addresses_like_meerk40t() {
        // MeerK40t: MEM_CURRENT_X = b'\x04\x21', MEM_CARD_ID = b'\x05\x7E', MEM_MACHINE_STATUS = b'\x04\x00'
        assert_eq!(get_setting(mem::POS_X), vec![0xDA, 0x00, 0x04, 0x21]);
        assert_eq!(get_setting(mem::CARD_ID), vec![0xDA, 0x00, 0x05, 0x7E]);
        assert_eq!(get_setting(mem::STATUS), vec![0xDA, 0x00, 0x04, 0x00]);
        assert_eq!(get_setting(mem::RANGE_X), vec![0xDA, 0x00, 0x00, 0x26]);
        let s = set_setting(0x0026, 600_000);
        assert_eq!(&s[..4], &[0xDA, 0x01, 0x00, 0x26]);
        assert_eq!(&s[4..9], &s[9..14]);
        assert_eq!(dec_u35(&s[4..9]), 600_000);
    }

    #[test]
    fn rapid_never_fires() {
        let r = rapid_move_xy(1000, 2000);
        assert_eq!(&r[..3], &[0xD9, 0x10, 0x00]);
        assert_eq!(r[2] & 0x01, 0);
        assert_eq!(dec_i32(&r[3..8]), 1000);
        assert_eq!(dec_i32(&r[8..13]), 2000);
    }

    #[test]
    fn corner_mapping() {
        let tr = Mapping { bed_w: 600.0, bed_h: 400.0, corner: Corner::TopRight };
        assert_eq!(tr.to_native(600.0, 400.0), (0, 0));
        assert_eq!(tr.to_native(0.0, 0.0), (600_000, 400_000));
        assert_eq!(tr.to_native(100.0, 50.5), (500_000, 349_500));
        assert_eq!(tr.from_native(500_000, 349_500), (100.0, 50.5));
        let bl = Mapping { corner: Corner::BottomLeft, ..tr };
        assert_eq!(bl.to_native(100.0, 50.5), (100_000, 50_500));
        let tl = Mapping { corner: Corner::TopLeft, ..tr };
        assert_eq!(tl.to_native(100.0, 50.0), (100_000, 350_000));
        let br = Mapping { corner: Corner::BottomRight, ..tr };
        assert_eq!(br.to_native(100.0, 50.0), (500_000, 50_000));
        for m in [tr, bl, tl, br] {
            let (x, y) = m.from_native(m.to_native(123.456, 78.9).0, m.to_native(123.456, 78.9).1);
            assert!((x - 123.456).abs() < 1e-9 && (y - 78.9).abs() < 1e-9);
        }
        assert!(tr.inside(600.005, 0.0));
        assert!(!tr.inside(600.5, 0.0));
        assert!(!tr.inside(f64::NAN, 0.0));
    }

    fn opts() -> Options {
        Options { bed_w: 600.0, bed_h: 400.0, origin: Corner::TopRight, s_max: 1000.0, min_power: 1.0 }
    }

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(|l| l.to_string()).collect()
    }

    #[test]
    fn parse_kizamubeam_job() {
        // So sieht ein Job von KizamuBeam aus (Kopf, M4, S und F modal, Air Assist, Ende)
        let g = lines("; KizamuBeam\nG21\nG90\nM4 S0\nG0 X10 Y10\nM8\nG1 X20 S500 F1200\nY20\nG0 X30\nM9\nM5\nM2");
        let mv = parse_gcode(&g, &opts(), (0.0, 0.0)).unwrap();
        assert_eq!(mv.len(), 4);
        assert_eq!(mv[0], Move { x: 10.0, y: 10.0, speed: 0.0, power: 0.0, dynamic: true, air: false, line: 4 });
        assert_eq!(mv[1], Move { x: 20.0, y: 10.0, speed: 20.0, power: 50.0, dynamic: true, air: true, line: 6 });
        assert_eq!(mv[2].y, 20.0);
        assert!(mv[2].burns());
        assert!(!mv[3].burns(), "G0 schneidet nie");
    }

    #[test]
    fn parse_offset_and_relative() {
        let g = lines("G90\nG0 X0 Y0\nG91\nG0 X5 Y-2\nG90");
        let mv = parse_gcode(&g, &opts(), (100.0, 50.0)).unwrap();
        assert_eq!((mv[0].x, mv[0].y), (100.0, 50.0));
        assert_eq!((mv[1].x, mv[1].y), (105.0, 48.0));
    }

    #[test]
    fn parse_rejects_unsupported_and_out_of_bed() {
        let o = opts();
        for bad in ["G0 Z5", "M64 P1", "G2 X1 Y1 I1 J0", "G4 P1", "G0 A10", "$H", "G20", "G92 A0", "M3 S10\nG1 X1 Y1"] {
            let r = parse_gcode(&lines(bad), &o, (0.0, 0.0));
            assert!(r.is_err(), "{bad} sollte abgelehnt werden");
        }
        let r = parse_gcode(&lines("G0 X610 Y10"), &o, (0.0, 0.0));
        assert!(r.unwrap_err().contains("außerhalb"));
        let r = parse_gcode(&lines("G0 X590 Y10"), &o, (20.0, 0.0));
        assert!(r.is_err(), "Werkstück-Nullpunkt verschiebt aus dem Bett");
        // M5: G1 brennt nicht mehr
        let mv = parse_gcode(&lines("M3 S1000\nG0 X1 Y1\nM5\nG1 X5 F600"), &o, (0.0, 0.0)).unwrap();
        assert!(!mv[1].burns());
    }

    /// Befehle eines Auftrags wieder auftrennen (wie parse_commands in MeerK40t)
    fn commands(data: &[u8]) -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = Vec::new();
        for &b in data {
            if b >= 0x80 || out.is_empty() {
                out.push(vec![b]);
            } else {
                out.last_mut().unwrap().push(b);
            }
        }
        out
    }

    #[test]
    fn encode_simple_job() {
        let o = opts();
        let g = lines("G21\nG90\nM3 S0\nG0 X100 Y100\nG1 X110 S800 F600\nG1 Y105\nG0 X300 Y300\nG1 X300.5 S400\nM5\nM2");
        let mv = parse_gcode(&g, &o, (0.0, 0.0)).unwrap();
        let job = encode_job(&mv, &o, None).unwrap();
        let cmds = commands(&job.data);
        assert_eq!(cmds.len(), job.starts.len(), "jeder Befehl beginnt mit Bit 7 = 1, Daten haben Bit 7 = 0");
        assert_eq!(cmds[0], vec![0xD8, 0x10]);
        assert!(cmds.contains(&START_PROCESS.to_vec()));
        assert_eq!(cmds.last().unwrap(), &vec![0xD7]);
        // Prüfsumme: alle Bytes vor E5 05 plus 0xD7
        let e5 = cmds.iter().position(|c| c.starts_with(&[0xE5, 0x05])).unwrap();
        let sum: u64 = cmds[..e5].iter().flatten().map(|&b| b as u64).sum::<u64>() + 0xD7;
        assert_eq!(dec_u35(&cmds[e5][2..]), sum);
        // erste Bewegung absolut: X 100 → 500 mm vom rechten Rand, Y 100 → 300 mm von oben
        let first = cmds.iter().find(|c| c[0] == 0x88).unwrap();
        assert_eq!((dec_i32(&first[1..6]), dec_i32(&first[6..11])), (500_000, 300_000));
        // Schnitt 10 mm nach rechts = −10000 µm in Ruida-X, relativ (passt in 14 Bit? nein: 10000 > 8191 → absolut)
        assert!(cmds.iter().any(|c| c[0] == 0xA8 && dec_i32(&c[1..6]) == 490_000));
        // 5 mm in Y = −5000 µm relativ (AB)
        assert!(cmds.iter().any(|c| c[0] == 0xAB && c[1..3] == enc14(-5000)));
        // 0,5 mm in X = −500 µm relativ (AA), mit neuer Leistung davor
        let k = cmds.iter().position(|c| c[0] == 0xAA).unwrap();
        assert_eq!(cmds[k][1..3], enc14(-500));
        assert!(cmds[..k].iter().rev().take(3).any(|c| c.starts_with(&[0xC6, 0x02]) && c[2..4] == enc_power(40.0)));
        // Teil-Einstellungen: 10 mm/s, 80 %
        assert!(cmds.iter().any(|c| c.starts_with(&[0xC9, 0x04, 0x00]) && dec_u35(&c[3..8]) == 10_000));
        assert!(cmds.iter().any(|c| c.starts_with(&[0xC6, 0x32, 0x00]) && c[3..5] == enc_power(80.0)));
        assert_eq!(job.parts, 1);
    }

    #[test]
    fn first_cut_starts_with_jump() {
        let o = opts();
        let g = lines("M3 S500\nG1 X10 Y10 F600");
        let mv = parse_gcode(&g, &o, (0.0, 0.0)).unwrap();
        assert!(mv[0].burns());
        let job = encode_job(&mv, &o, Some((5.0, 5.0))).unwrap();
        let cmds = commands(&job.data);
        let first_move = cmds.iter().position(|c| matches!(c[0], 0x88..=0x8B | 0xA8..=0xAB)).unwrap();
        assert_eq!(cmds[first_move][0], 0x88, "erst ohne Laser zum Startpunkt");
        assert_eq!((dec_i32(&cmds[first_move][1..6]), dec_i32(&cmds[first_move][6..11])), (595_000, 395_000));
    }

    #[test]
    fn air_assist_parts_and_dynamic_min_power() {
        let mut o = opts();
        o.min_power = 0.5;
        let g = lines("M4 S0\nG0 X10 Y10\nM8\nG1 X20 S600 F600\nM9\nG0 X30 Y30\nG1 X40 S300 F1200\nM5");
        let mv = parse_gcode(&g, &o, (0.0, 0.0)).unwrap();
        let job = encode_job(&mv, &o, None).unwrap();
        assert_eq!(job.parts, 2);
        let cmds = commands(&job.data);
        assert!(cmds.iter().any(|c| *c == vec![0xCA, 0x01, 0x13]), "Air an im ersten Abschnitt");
        assert!(cmds.iter().any(|c| *c == vec![0xCA, 0x01, 0x12]), "Air aus im zweiten");
        // M4: Min-Leistung = 50 % der Leistung
        assert!(cmds.iter().any(|c| c.starts_with(&[0xC6, 0x31, 0x00]) && c[3..5] == enc_power(30.0)));
        assert!(cmds.iter().any(|c| c.starts_with(&[0xC6, 0x32, 0x00]) && c[3..5] == enc_power(60.0)));
        assert!(cmds.iter().any(|c| c.starts_with(&[0xC6, 0x31, 0x01]) && c[3..5] == enc_power(15.0)));
    }

    #[test]
    fn packets_split_on_command_boundaries() {
        let o = opts();
        let mut g = vec!["M3 S500".to_string(), "G0 X1 Y1".to_string()];
        for i in 0..3000 {
            g.push(format!("G1 X{} Y{} F6000", 1.0 + (i % 2) as f64 * 0.5, 1.0 + i as f64 * 0.1));
        }
        let mv = parse_gcode(&g, &o, (0.0, 0.0)).unwrap();
        let job = encode_job(&mv, &o, None).unwrap();
        let p = packets(&job, PACKET_MAX);
        assert!(p.len() > 5);
        let starts: std::collections::HashSet<usize> = job.starts.iter().map(|&s| s as usize).collect();
        let mut end = 0;
        let mut last_line = 0;
        for (r, line) in &p {
            assert_eq!(r.start, end, "lückenlos");
            assert!(r.len() <= PACKET_MAX);
            assert!(starts.contains(&r.start), "Paket beginnt mit einem Befehl");
            assert!(*line >= last_line);
            last_line = *line;
            end = r.end;
        }
        assert_eq!(end, job.data.len());
        assert_eq!(p.last().unwrap().1 as usize, g.len() - 1);
    }

    /// Nachgebildete Steuerung für die Sitzungstests
    struct FakeCtrl {
        magic: u8,
        framing: Framing,
        inbox: VecDeque<Vec<u8>>,
        received: Vec<Vec<u8>>,
        values: std::collections::HashMap<u16, u64>,
        nak_next: u32,
        silent: bool,
    }

    impl Transport for FakeCtrl {
        fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
            let sw = Swizzle::new(self.magic);
            let body = match self.framing {
                Framing::Udp => {
                    let sum = u16::from_be_bytes([data[0], data[1]]);
                    assert_eq!(sum as u32, data[2..].iter().map(|&b| b as u32).sum::<u32>() & 0xFFFF, "Prüfsumme");
                    &data[2..]
                }
                Framing::Usb => data,
            };
            let d = sw.decode(body);
            if self.silent {
                return Ok(());
            }
            if self.nak_next > 0 {
                self.nak_next -= 1;
                self.inbox.push_back(sw.encode(&[NAK]));
                return Ok(());
            }
            self.received.push(d.clone());
            if self.framing == Framing::Udp {
                self.inbox.push_back(sw.encode(&[ACK]));
            }
            if d.len() == 4 && d[0] == 0xDA && d[1] == 0x00 {
                let a = dec_u14(&d[2..4]);
                let mut r = vec![0xDA, 0x01, d[2], d[3]];
                r.extend_from_slice(&enc35(*self.values.get(&a).unwrap_or(&0) as i64));
                self.inbox.push_back(sw.encode(&r));
            }
            if d.len() == 14 && d[0] == 0xDA && d[1] == 0x01 {
                self.values.insert(dec_u14(&d[2..4]), dec_u35(&d[4..9]));
            }
            Ok(())
        }
        fn recv(&mut self, _timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
            Ok(self.inbox.pop_front())
        }
    }

    fn fake(magic: u8, framing: Framing) -> FakeCtrl {
        FakeCtrl { magic, framing, inbox: VecDeque::new(), received: Vec::new(), values: Default::default(), nak_next: 0, silent: false }
    }

    #[test]
    fn link_udp_ack_nak_and_query() {
        let mut c = fake(0x88, Framing::Udp);
        c.values.insert(mem::POS_X, 123_000);
        c.nak_next = 1;
        let mut l = Link::new(c, Framing::Udp, 0x88);
        l.send(&HOME_XY).unwrap();
        assert_eq!(l.naks, 1, "NAK → erneut gesendet");
        assert_eq!(l.t.received, vec![HOME_XY.to_vec()]);
        assert_eq!(l.query_value(mem::POS_X).unwrap(), 123_000);
        l.send(&set_setting(0x0026, 650_000)).unwrap();
        assert_eq!(l.query_value(0x0026).unwrap(), 650_000);
    }

    #[test]
    fn link_timeout_does_not_resend() {
        let mut c = fake(0x88, Framing::Udp);
        c.silent = true;
        let mut l = Link::new(c, Framing::Udp, 0x88);
        l.timeout = Duration::from_millis(30);
        assert!(l.send(&START_PROCESS).is_err());
        assert!(l.query(mem::STATUS).is_err());
    }

    #[test]
    fn link_usb_query() {
        let mut c = fake(0x11, Framing::Usb);
        c.values.insert(mem::STATUS, status_bits::JOB_RUNNING);
        let mut l = Link::new(c, Framing::Usb, 0x11);
        assert_eq!(l.query_value(mem::STATUS).unwrap(), 1);
    }

    #[test]
    fn detect_magic_udp_and_usb() {
        for &m in &MAGICS {
            let mut c = fake(m, Framing::Udp);
            // Die nachgebildete Steuerung bestätigt jedes Paket mit gültiger Prüfsumme
            assert_eq!(detect_magic(&mut c, Framing::Udp, Duration::from_millis(10)), Some(m));
            let mut c = fake(m, Framing::Usb);
            assert_eq!(detect_magic(&mut c, Framing::Usb, Duration::from_millis(10)), Some(m));
        }
        let mut c = fake(0x88, Framing::Udp);
        c.silent = true;
        assert_eq!(detect_magic(&mut c, Framing::Udp, Duration::from_millis(5)), None);
    }

    #[test]
    fn reply_parsing() {
        let mut r = vec![0xDA, 0x01, 0x05, 0x7F];
        r.extend_from_slice(b"RDC6445G\0junk");
        let (a, v) = parse_reply(&r).unwrap();
        assert_eq!(a, mem::VERSION);
        assert_eq!(reply_text(v), "RDC6445G");
        assert!(parse_reply(&[0xCC]).is_none());
    }
}
