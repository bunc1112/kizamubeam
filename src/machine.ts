// Verbindung zur Maschine (FluidNC/GRBL). Die eigentliche Kommunikation läuft im Rust-Kern (src-tauri/src/machine.rs);
// hier liegen Zustand, Statusauswertung und die Befehle für die Oberfläche.
import { Device, FIRMWARES, PreparedGCode, ruidaConnect } from './gcode';
import { t, tBackend } from './i18n';
import { configText, FluidFs, OVERRIDE, overrideSteps, parseConfigFile, runCmd } from './fluidnc';
import { parseFluidConfig } from './setup';

export const isTauri = () => '__TAURI_INTERNALS__' in window;

export interface MachineStatus {
  /** Idle, Run, Hold, Jog, Alarm, Door, Home, Check, Sleep */
  state: string;
  /** Maschinenposition */
  mpos: [number, number, number] | null;
  /** Werkstückposition (Maschinenposition minus Werkstück-Nullpunkt) */
  wpos: [number, number, number] | null;
  feed: number;
  power: number;
  /** Overrides in Prozent: Vorschub, Eilgang, Leistung (GRBL/FluidNC melden sie nur ab und zu, Ov:) */
  ov: [number, number, number] | null;
  /** Aktive Eingänge, z. B. „XP“ = Endschalter X und Taster (Pn:) */
  pins: string;
  /** Zubehör: S/C Laser an, F Flood, M Mist (A:) */
  acc: string;
  /** FluidNC: Job läuft von SD-Karte oder Flash (SD:Prozent,Datei) */
  sd: { pct: number; file: string } | null;
  /** Freie Plätze: Planer-Blöcke und Empfangspuffer in Bytes (Bf:), nur wenn die Steuerung es meldet */
  bf: [number, number] | null;
}

export const emptyStatus = (): MachineStatus => ({ state: '', mpos: null, wpos: null, feed: 0, power: 0, ov: null, pins: '', acc: '', sd: null, bf: null });

export interface Progress {
  sent: number;
  acked: number;
  total: number;
  errors: number;
}

export type MachineEvent =
  | { type: 'line'; line: string; dir: 'in' | 'out' | 'info' | 'error' }
  | { type: 'status' }
  | { type: 'connection' }
  | { type: 'progress' }
  | { type: 'done'; ok: boolean; message: string }
  /** FluidNC-Konfiguration wurde (neu) gelesen */
  | { type: 'config' };

/** Gelesene FluidNC-Konfiguration: Pfade (axes/x/max_travel_mm …), Text für Sicherungen, Dateiname */
export interface FluidConfig {
  values: Record<string, string>;
  text: string;
  file: string;
}

/** Steuerung mit FluidNC, gefunden bei der Suche im Netzwerk */
export interface FoundController {
  host: string;
  info: string;
}

export interface PortInfo {
  name: string;
  description: string;
}

/** Gelesener Wert einer Ruida-Speicheradresse */
export interface RuidaValue {
  addr: number;
  value: number | null;
  text: string;
  error: string | null;
}

/** Klartext für FluidNC-/GRBL-Alarme und häufige Fehler */
const ALARMS: Record<string, string> = {
  '1': t('Endschalter ausgelöst, Position unsicher. Neu referenzieren (Home).'),
  '2': t('Ziel außerhalb des Arbeitsbereichs (Soft-Limit).'),
  '3': t('Zurückgesetzt während der Bewegung, Position unsicher. Neu referenzieren.'),
  '4': t('Sonde nicht im erwarteten Zustand.'),
  '5': t('Sonde hat nicht ausgelöst.'),
  '6': t('Referenzfahrt abgebrochen.'),
  '7': t('Referenzfahrt: Tür geöffnet.'),
  '8': t('Referenzfahrt: Endschalter nicht freigefahren.'),
  '9': t('Referenzfahrt: Endschalter nicht gefunden.'),
  '10': t('Referenzfahrt: Endschalter doppelt ausgelöst.'),
};
const ERRORS: Record<string, string> = {
  '1': t('Befehl ohne Buchstaben'),
  '2': t('Zahl fehlt oder ist ungültig'),
  '3': t('Unbekannter $-Befehl'),
  '9': t('Gesperrt (Alarm). Mit $X entsperren oder Home fahren.'),
  '15': t('Fahrweg außerhalb des Arbeitsbereichs'),
  '20': t('Nicht unterstützter G-Code-Befehl'),
  '22': t('Vorschub fehlt'),
  '24': t('Zwei G-Code-Befehle derselben Gruppe in einer Zeile'),
  '33': t('Ziel ungültig'),
};

export function explain(line: string): string | null {
  let m = /^ALARM:(\d+)/i.exec(line);
  if (m) return ALARMS[m[1]] ?? null;
  m = /^error:(\d+)/i.exec(line);
  if (m) return ERRORS[m[1]] ?? null;
  return null;
}

/** Werkstück-Nullpunkt in Maschinenkoordinaten; known = von der Steuerung gemeldet (WCO oder MPos und WPos zugleich) */
export interface WorkOffset {
  v: [number, number, number];
  known: boolean;
}

/** Statusbericht auswerten, z. B. <Idle|MPos:1.000,2.000,0.000|FS:0,0|WCO:0.000,0.000,0.000> */
export function parseStatus(line: string, prev: MachineStatus, wco: WorkOffset): MachineStatus {
  const body = line.replace(/^<|>$/g, '').split('|');
  // Pn, A und SD fehlen, wenn nichts aktiv ist; Ov und Bf bleiben bis zur nächsten Meldung
  const st: MachineStatus = { ...prev, state: body[0].split(':')[0], pins: '', acc: '', sd: null };
  const vec = (s: string) => {
    const v = s.split(',').map(Number);
    return [v[0] || 0, v[1] || 0, v[2] || 0] as [number, number, number];
  };
  let mpos: [number, number, number] | null = null,
    wpos: [number, number, number] | null = null;
  for (const f of body.slice(1)) {
    const [k, v] = f.split(':');
    if (k === 'MPos') mpos = vec(v);
    else if (k === 'WPos') wpos = vec(v);
    else if (k === 'WCO') {
      wco.v = vec(v);
      wco.known = true;
    } else if (k === 'FS' || k === 'F') {
      const p = v.split(',').map(Number);
      st.feed = p[0] || 0;
      st.power = p[1] || 0;
    } else if (k === 'Ov') {
      const p = v.split(',').map(Number);
      st.ov = [p[0] || 100, p[1] || 100, p[2] || 100];
    } else if (k === 'Pn') st.pins = v;
    else if (k === 'A') st.acc = v;
    else if (k === 'Bf') {
      const p = v.split(',').map(Number);
      st.bf = [p[0] || 0, p[1] || 0];
    } else if (k === 'SD') {
      // Dateiname kann Kommas und Doppelpunkte enthalten: nur am ersten Komma trennen
      const rest = f.slice(3);
      const i = rest.indexOf(',');
      st.sd = { pct: Number(i < 0 ? rest : rest.slice(0, i)) || 0, file: i < 0 ? '' : rest.slice(i + 1) };
    }
  }
  const o = wco.v;
  if (mpos && wpos) {
    // z. B. Smoothieware meldet beide: daraus ergibt sich der Nullpunkt
    st.mpos = mpos;
    st.wpos = wpos;
    wco.v = [mpos[0] - wpos[0], mpos[1] - wpos[1], mpos[2] - wpos[2]];
    wco.known = true;
  } else if (mpos) {
    st.mpos = mpos;
    st.wpos = [mpos[0] - o[0], mpos[1] - o[1], mpos[2] - o[2]];
  } else if (wpos) {
    st.wpos = wpos;
    st.mpos = [wpos[0] + o[0], wpos[1] + o[1], wpos[2] + o[2]];
  }
  return st;
}

type Unlisten = () => void;

class Machine {
  connected = false;
  connecting = false;
  /** Beschreibung der Verbindung, z. B. „COM3“ oder „fluidnc.local:23“ */
  where = '';
  status: MachineStatus = emptyStatus();
  progress: Progress | null = null;
  /** Geschätzte Zeiten je Zeile des laufenden Jobs */
  jobTimes: Float64Array | null = null;
  jobStarted = 0;
  /** Laufender Auftrag ist eine Rahmenfahrt (keine Fortschrittsanzeige) */
  jobIsFrame = false;
  private wco: WorkOffset = { v: [0, 0, 0], known: false };
  /** Firmware der aktuellen Verbindung */
  fw = FIRMWARES.fluidnc;
  /** Verbunden mit einer Ruida-Steuerung (eigener Treiber, Einstellungen über ruidaRead/ruidaWrite) */
  isRuida = false;
  /** Konfiguration der verbundenen FluidNC-Steuerung (nach dem Verbinden still gelesen); null = unbekannt */
  fluid: FluidConfig | null = null;
  /** Job, der auf der Steuerung von SD-Karte oder Flash läuft (FluidNC meldet SD: im Status) */
  storedJob: { file: string; started: number; seen: boolean; aborted?: boolean } | null = null;
  private listeners = new Set<(e: MachineEvent) => void>();
  /** Läuft gerade eine Abfrage (query), gehen die Antworten an sie; quiet = nicht in die Konsole */
  private capture: { fn: (line: string) => void; quiet: boolean } | null = null;
  private queryChain: Promise<unknown> = Promise.resolve();
  private unlisten: Unlisten[] = [];

  on(fn: (e: MachineEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: MachineEvent) {
    this.listeners.forEach((f) => f(e));
  }
  log(line: string, dir: 'in' | 'out' | 'info' | 'error' = 'info') {
    this.emit({ type: 'line', line, dir });
  }

  get busy() {
    return !!this.progress;
  }

  /** Ein Job läuft, gesendet von hier oder von SD-Karte/Flash der Steuerung */
  get running() {
    return !!this.progress || !!this.storedJob;
  }

  async ports(): Promise<PortInfo[]> {
    if (!isTauri()) return [];
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<PortInfo[]>('machine_ports');
  }

  private async listen() {
    if (this.unlisten.length) return;
    const { listen } = await import('@tauri-apps/api/event');
    this.unlisten.push(
      await listen<string>('machine-line', (e) => this.onLine(e.payload)),
      await listen<Progress>('machine-progress', (e) => {
        this.progress = e.payload;
        this.emit({ type: 'progress' });
      }),
      await listen<{ ok: boolean; message: string }>('machine-done', (e) => {
        const frame = this.jobIsFrame;
        this.progress = null;
        this.jobTimes = null;
        this.jobIsFrame = false;
        this.emit({ type: 'progress' });
        if (!frame || !e.payload.ok) this.emit({ type: 'done', ok: e.payload.ok, message: tBackend(e.payload.message) });
      }),
      await listen<string>('machine-closed', (e) => {
        this.connected = false;
        this.progress = null;
        this.fluid = null;
        this.storedJob = null;
        this.status = emptyStatus();
        if (e.payload) this.log(tBackend(e.payload), 'error');
        this.log(t('Verbindung getrennt.'));
        this.emit({ type: 'connection' });
      }),
    );
  }

  private onLine(line: string) {
    // Ruida-Treiber: Fehlertexte kommen aus dem Rust-Teil (deutsch)
    if (this.isRuida && line.startsWith('error: ')) line = `error: ${tBackend(line.slice(7))}`;
    // Marlin: Antwort auf M114 („X:10.00 Y:20.00 Z:0.00 E:0.00 Count …“)
    const m114 = /^X:(-?[\d.]+)\s*Y:(-?[\d.]+)(?:\s*Z:(-?[\d.]+))?/.exec(line);
    if (m114) {
      const p: [number, number, number] = [+m114[1], +m114[2], +(m114[3] ?? 0)];
      // M114 meldet Werkstückkoordinaten; einen G92-Versatz verrät Marlin nicht (wco bleibt unbekannt)
      this.status = { ...this.status, mpos: p, wpos: p };
      this.emit({ type: 'status' });
      return;
    }
    if (line.startsWith('<')) {
      this.status = parseStatus(line, this.status, this.wco);
      this.trackStoredJob();
      this.emit({ type: 'status' });
      return;
    }
    if (this.capture) {
      this.capture.fn(line);
      if (this.capture.quiet) return;
    }
    const isErr = /^(error|alarm)/i.test(line);
    const why = explain(line);
    this.log(why ? `${line}  (${why})` : line, isErr ? 'error' : 'in');
  }

  /** Verbinden; `home` = danach referenzieren (Standard: Einstellung des Geräts) */
  async connect(d: Device, home = d.homeOnConnect) {
    if (!isTauri()) {
      this.log(t('Die Maschinenanbindung gibt es nur in der Desktop-App.'), 'error');
      return;
    }
    if (this.connected || this.connecting) return;
    this.connecting = true;
    this.wco = { v: [0, 0, 0], known: false };
    this.emit({ type: 'connection' });
    try {
      await this.listen();
      const { invoke } = await import('@tauri-apps/api/core');
      const ruida = d.fw === 'ruida';
      // Ruida: Ethernet (UDP, feste Ports 50200/40200) oder USB; Telnet/WebSocket gibt es dort nicht
      const conn = ruida && d.conn !== 'serial' ? 'udp' : d.conn;
      const netPort = conn === 'ws' ? d.wsPort : d.tcpPort;
      const where = conn === 'serial' ? d.port : conn === 'udp' ? `${d.host} (UDP)` : `${conn === 'ws' ? 'ws://' : ''}${d.host}:${netPort}`;
      this.log(t('Verbinde mit {where} …', { where }));
      const fw = FIRMWARES[d.fw];
      this.fw = fw;
      this.isRuida = ruida;
      await invoke('machine_connect', {
        kind: conn, port: d.port, baud: d.baud, host: d.host, tcpPort: netPort,
        sync: fw.sync, realtime: fw.realtime, poll: fw.poll, rxBuffer: d.rxBuffer || 127,
        ruida: ruida ? ruidaConnect(d) : null,
      });
      this.connected = true;
      this.where = where;
      this.log(t('Verbunden mit {where}.', { where }));
      // Ohne Endschalter nie referenzieren, die Achsen würden bis zum Anschlag fahren
      if (home && d.limitSwitches !== 'no') await this.send(fw.home);
      // FluidNC: Konfiguration im Hintergrund lesen (Kühlmittel, Ausgänge, Dateiname)
      if (fw.read === 'fluidnc') this.readFluidConfig().catch(() => {});
    } catch (e) {
      this.log(t('Verbindung fehlgeschlagen: {error}', { error: tBackend(String(e)) }), 'error');
    } finally {
      this.connecting = false;
      this.emit({ type: 'connection' });
    }
  }

  async disconnect() {
    if (!isTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('machine_disconnect');
  }

  /** Werkstück-Nullpunkt (X, Y) in Maschinenkoordinaten, wie ihn die Steuerung zuletzt gemeldet hat; null = unbekannt */
  workOffset(): { x: number; y: number } | null {
    return this.connected && this.wco.known ? { x: this.wco.v[0], y: this.wco.v[1] } : null;
  }

  /** Eine Zeile senden (Konsole, Bewegen, Home …). Wird abgelehnt, solange ein Job läuft. */
  async send(line: string, quiet = false) {
    if (!this.connected) return this.log(t('Nicht verbunden.'), 'error');
    const { invoke } = await import('@tauri-apps/api/core');
    if (!quiet) this.log(line, 'out');
    // Nullpunkt oder Koordinatensystem ändert sich: bis zur nächsten Meldung der Steuerung gilt er als unbekannt
    if (/G\s*(10|92|5[4-9])\b/i.test(line)) this.wco.known = false;
    try {
      await invoke('machine_send', { line });
    } catch (e) {
      this.log(tBackend(String(e)), 'error');
    }
  }

  /**
   * Befehle senden und die Antworten sammeln, bis jede Zeile mit ok/error beantwortet ist oder die Zeit abläuft.
   * quiet = Antworten nicht in die Konsole schreiben (z. B. die lange Ausgabe von $CD). Abfragen laufen nacheinander.
   */
  query(cmds: string[], ms = 2500, quiet = false): Promise<string[]> {
    const run = () =>
      new Promise<string[]>((resolve) => {
        const got: string[] = [];
        let answered = 0;
        let timer = 0;
        const done = () => {
          this.capture = null;
          clearTimeout(timer);
          resolve(got);
        };
        this.capture = {
          quiet,
          fn: (line) => {
            got.push(line);
            if (/^(ok|error)\b/i.test(line) && ++answered >= cmds.length) {
              clearTimeout(timer);
              timer = window.setTimeout(done, 150);
            }
          },
        };
        timer = window.setTimeout(done, ms);
        if (!this.connected) return done();
        (async () => {
          for (const c of cmds) await this.send(c, quiet);
        })();
      });
    const p = this.queryChain.then(run, run);
    this.queryChain = p.catch(() => {});
    return p;
  }

  /** FluidNC-Konfiguration ($CD) und ihren Dateinamen lesen */
  async readFluidConfig(): Promise<FluidConfig | null> {
    if (!this.connected || this.busy) return this.fluid;
    const lines = await this.query(['$CD'], 6000, true);
    const values = parseFluidConfig(lines);
    if (!Object.keys(values).length) return this.fluid;
    const file = parseConfigFile(await this.query(['$Config/Filename'], 2000, true)) ?? this.fluid?.file ?? 'config.yaml';
    this.fluid = { values, text: configText(lines), file };
    this.emit({ type: 'config' });
    return this.fluid;
  }

  /** Override auf einen Prozentwert bringen (Vorschub oder Laserleistung, 10 … 200 %) */
  async setOverride(kind: keyof typeof OVERRIDE, pct: number) {
    const ov = this.status.ov;
    const cur = ov ? (kind === 'feed' ? ov[0] : ov[2]) : NaN;
    for (const b of overrideSteps(kind, cur, pct)) await this.realtime(b);
  }

  /** Datei auf SD-Karte oder Flash starten; Fortschritt kommt über den Statusbericht (SD:) */
  async runStored(fs: FluidFs, name: string) {
    if (!this.connected) return this.log(t('Nicht verbunden.'), 'error');
    if (this.running) return this.log(t('Es läuft bereits ein Auftrag.'), 'error');
    this.storedJob = { file: name, started: performance.now(), seen: false };
    this.emit({ type: 'progress' });
    await this.send(runCmd(fs, name));
  }

  /** Läuft ein Job von SD/Flash an, ist er im Status zu sehen; verschwindet er wieder, ist er zu Ende */
  private trackStoredJob() {
    const j = this.storedJob;
    if (!j) return;
    if (this.status.sd) {
      j.seen = true;
      return;
    }
    const alarm = this.status.state.startsWith('Alarm');
    // Startet die Datei nicht (z. B. nicht gefunden), meldet die Steuerung nie SD:; nach 5 s aufgeben
    if (!j.seen && !alarm && performance.now() - j.started < 5000) return;
    if (this.status.state === 'Run' || this.status.state.startsWith('Hold')) return;
    this.storedJob = null;
    this.emit({ type: 'progress' });
    const secs = Math.round((performance.now() - j.started) / 1000);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (j.aborted) this.emit({ type: 'done', ok: false, message: t('Abgebrochen') });
    else if (!j.seen) this.emit({ type: 'done', ok: false, message: t('Die Steuerung hat {file} nicht gestartet. Details stehen in der Konsole.', { file: j.file }) });
    else if (alarm) this.emit({ type: 'done', ok: false, message: t('Alarm, Job abgebrochen') });
    else this.emit({ type: 'done', ok: true, message: t('Fertig nach {time} min', { time }) });
  }

  /** G-Code auf die Steuerung hochladen (Weboberfläche von FluidNC); liefert die Größe in Bytes */
  async upload(d: Device, fs: FluidFs, name: string, g: PreparedGCode, onProgress?: (sent: number, total: number) => void): Promise<number> {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const off = await listen<{ sent: number; total: number }>('fluid-upload-progress', (e) => onProgress?.(e.payload.sent, e.payload.total));
    try {
      return await invoke<number>('fluid_upload', { host: d.host, port: d.httpPort || 80, fs, name, id: g.lines ? null : g.id, lines: g.lines });
    } catch (e) {
      throw new Error(tBackend(String(e)));
    } finally {
      off();
    }
  }

  /** FluidNC-Steuerungen im lokalen Netz suchen (fluidnc.local und das eigene /24-Netz) */
  async discover(httpPort = 80): Promise<FoundController[]> {
    if (!isTauri()) return [];
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<FoundController[]>('fluid_discover', { port: httpPort });
  }

  /** Echtzeitbefehl: ? Status, ! Halt, ~ Weiter, 0x18 Reset, 0x85 Jog abbrechen, 0x90 … Overrides */
  async realtime(byte: number) {
    if (!this.connected) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('machine_realtime', { byte });
  }

  /** Auftrag senden: fertige Zeilen oder G-Code, den der Rust-Kern schon vorbereitet hat (prepareGCode) */
  async runJob(lines: string[], times: Float64Array | null, frame = false) {
    return this.startJob(lines.length, times, frame, { cmd: 'machine_job', args: { lines } });
  }
  async runPrepared(g: PreparedGCode) {
    if (g.lines) return this.runJob(g.lines, g.times);
    return this.startJob(g.count, g.times, false, { cmd: 'machine_job_prepared', args: { id: g.id } });
  }
  /** true, wenn der Auftrag angenommen wurde */
  private async startJob(total: number, times: Float64Array | null, frame: boolean, call: { cmd: string; args: Record<string, unknown> }): Promise<boolean> {
    if (!this.connected) return this.log(t('Nicht verbunden.'), 'error'), false;
    if (this.busy) return this.log(t('Es läuft bereits ein Auftrag.'), 'error'), false;
    const { invoke } = await import('@tauri-apps/api/core');
    this.jobTimes = times;
    this.jobIsFrame = frame;
    this.jobStarted = performance.now();
    this.progress = { sent: 0, acked: 0, total, errors: 0 };
    this.emit({ type: 'progress' });
    try {
      await invoke(call.cmd, call.args);
    } catch (e) {
      this.progress = null;
      this.jobTimes = null;
      this.emit({ type: 'progress' });
      this.log(tBackend(String(e)), 'error');
      return false;
    }
    return true;
  }

  /** Anhalten: GRBL-Familie per Echtzeitbefehl !, Marlin durch Zurückhalten weiterer Zeilen (im Rust-Kern) */
  async pause() {
    if (!this.connected) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('machine_pause');
  }
  async resume() {
    if (!this.connected) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('machine_resume');
  }
  async stop() {
    if (!this.connected) return;
    const { invoke } = await import('@tauri-apps/api/core');
    // Ein Job von SD/Flash endet mit dem Reset; Meldung kommt über den Status
    if (this.storedJob) ((this.storedJob.seen = true), (this.storedJob.aborted = true));
    await invoke('machine_stop');
    this.log(t('Gestoppt.'), 'info');
  }

  /** Ruida-Speicheradressen lesen (Einstellungen, Zähler) */
  async ruidaRead(addrs: number[]): Promise<RuidaValue[]> {
    if (!this.connected || !this.isRuida) throw new Error(t('Keine Ruida-Steuerung verbunden.'));
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<RuidaValue[]>('ruida_read', { addrs });
    } catch (e) {
      throw new Error(tBackend(String(e)));
    }
  }

  /** Ruida-Einstellung schreiben; liefert den zurückgelesenen Wert */
  async ruidaWrite(addr: number, value: number): Promise<number> {
    if (!this.connected || !this.isRuida) throw new Error(t('Keine Ruida-Steuerung verbunden.'));
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<number>('ruida_write', { addr, value });
    } catch (e) {
      throw new Error(tBackend(String(e)));
    }
  }

  /** Ruida-Aktion: homeXY, homeZ, homeU, focusZ (bewegt die Maschine, nur auf Klick des Benutzers) */
  async ruidaAction(action: 'homeXY' | 'homeZ' | 'homeU' | 'focusZ') {
    if (!this.connected || !this.isRuida) return this.log(t('Keine Ruida-Steuerung verbunden.'), 'error');
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('ruida_action', { action });
    } catch (e) {
      this.log(tBackend(String(e)), 'error');
    }
  }

  /** Anteil des laufenden Jobs 0 … 1: bestätigte Zeilen; bei Ruida nach der geschätzten Zeit (höchstens 99 %, bis die Steuerung fertig meldet) */
  jobFraction(): number {
    const p = this.progress;
    if (!p || !p.total) return 0;
    const t = this.jobTimes;
    if (this.isRuida && t && t.length && t[t.length - 1] > 0) return Math.min(0.99, (performance.now() - this.jobStarted) / 1000 / t[t.length - 1]);
    return p.acked / p.total;
  }

  /** Geschätzte Restzeit des laufenden Jobs in Sekunden */
  remaining(): number | null {
    const p = this.progress,
      t = this.jobTimes;
    if (!p || !t || !t.length) return null;
    // Ruida lädt den ganzen Auftrag in die Steuerung; die Bestätigungen sagen nichts über den Fortschritt
    if (this.isRuida) return Math.max(0, t[t.length - 1] - (performance.now() - this.jobStarted) / 1000);
    const i = Math.min(t.length - 1, Math.max(0, p.acked - 1));
    return Math.max(0, t[t.length - 1] - (p.acked ? t[i] : 0));
  }
}

export const machine = new Machine();
