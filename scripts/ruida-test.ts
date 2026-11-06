// Tests für Ruida in der Oberfläche: Firmware-Profil, Einstellungskatalog, Umrechnung, Sicherungen,
// Statuszeile des Treibers. Protokoll und Auftragsformat testet der Rust-Kern (npm run test:core, cargo test).
// Aufruf: npm run test:ruida
import './core-fixtures-env';
import { strict as assert } from 'node:assert';
import { DEFAULT_DEVICE, FIRMWARES, frameGCode, Job, jogLines, jogToLines, loadDevices, Moves, newDevice, pointerGCode, PRESETS, ruidaConnect } from '../src/gcode';
import { emptyStatus, parseStatus, WorkOffset } from '../src/machine';
import {
  addrText, backupDiff, bitList, display, makeBackup, parseAddr, parseBackup, parseInput, RUIDA_GROUPS, RUIDA_MAX, RUIDA_SETTINGS,
} from '../src/ruidaSettings';

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${(e as Error).stack}`);
  }
}

test('Firmware-Profil: nur Zeilen, die der Ruida-Treiber versteht', () => {
  const fw = FIRMWARES.ruida;
  assert.equal(fw.home, '$H');
  assert.equal(fw.unlock, null, 'Ruida hat keinen Alarm zum Entsperren');
  assert.equal(fw.read, null);
  assert.equal(fw.overrides, false);
  assert.equal(fw.setOrigin, 'G10 L20 P1 X0 Y0');
  assert.equal(fw.clearOrigin, 'G10 L2 P1 X0 Y0');
  const d = newDevice({ fw: 'ruida' });
  assert.deepEqual(jogLines(d, 10, -5, 3000), ['$J=G91 G21 X10 Y-5 F3000']);
  assert.deepEqual(jogToLines(d, 12.5, 30, 6000), ['$J=G90 G21 X12.5 Y30 F6000']);
  // Zielpunkt mit Laser gibt es bei Ruida nicht: nie M3 außerhalb eines Auftrags
  assert.deepEqual(pointerGCode(d, true, 5), []);
  assert.deepEqual(pointerGCode(d, false, 0), ['M5']);
});

test('Rahmen ohne Laser: nur G0/G1 mit S0', () => {
  const d = newDevice({ fw: 'ruida', bedW: 600, bedH: 400 });
  const job: Job = { moves: new Moves(0, 0), bounds: { x0: 10, y0: 10, x1: 50, y1: 40 }, travel: null, hull: [], warnings: [], offset: { x: 0, y: 0 }, air: [] };
  const lines = frameGCode(job, d, false)!;
  assert.ok(lines.some((l) => l.startsWith('G1')));
  assert.ok(lines.every((l) => /^(G21|G90|M5|G0 X[\d.]+ Y[\d.]+|G1 X[\d.]+ Y[\d.]+( S0)?( F\d+)?)$/.test(l)), lines.join('\n'));
});

test('Gerät: Voreinstellungen und alte Gerätedaten', () => {
  assert.equal(DEFAULT_DEVICE.ruidaOrigin, 'tr');
  assert.equal(DEFAULT_DEVICE.ruidaMagic, 0);
  assert.equal(DEFAULT_DEVICE.ruidaMinPower, 100);
  const p = PRESETS.find((x) => x.fw === 'ruida')!;
  assert.equal(p.conn, 'udp');
  assert.equal(p.host, '192.168.1.100');
  // Alte gespeicherte Geräte ohne Ruida-Felder bekommen die Voreinstellungen
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  store.set('kizamubeam.devices', JSON.stringify({ devices: [{ id: 'a', name: 'Alt', fw: 'grbl', bedW: 300, bedH: 200 }], current: 'a' }));
  const d = loadDevices().devices[0];
  assert.equal(d.ruidaOrigin, 'tr');
  assert.equal(d.ruidaMinPower, 100);
  assert.equal(d.fw, 'grbl');
});

test('Verbindungsdaten für den Treiber', () => {
  const d = newDevice({ fw: 'ruida', bedW: 900, bedH: 600, ruidaOrigin: 'bl', ruidaMagic: 0x11, ruidaMinPower: 40 });
  assert.deepEqual(ruidaConnect(d), { magic: 0x11, bedW: 900, bedH: 600, origin: 'bl', sMax: 1000, minPower: 0.4 });
  assert.equal(ruidaConnect({ ...d, ruidaMinPower: 250 }).minPower, 1);
});

test('Statuszeile des Treibers wird wie bei GRBL gelesen', () => {
  const wco: WorkOffset = { v: [0, 0, 0], known: false };
  const st = parseStatus('<Jog|MPos:500.000,350.000,0.000|WCO:100.000,50.000,0.000>', emptyStatus(), wco);
  assert.equal(st.state, 'Jog');
  assert.deepEqual(st.mpos, [500, 350, 0]);
  assert.deepEqual(st.wpos, [400, 300, 0]);
  assert.ok(wco.known);
  assert.equal(parseStatus('<Hold:0|MPos:1.000,2.000,0.000|WCO:0.000,0.000,0.000>', emptyStatus(), wco).state, 'Hold');
});

test('Katalog: Adressen eindeutig, im 14-Bit-Bereich, jede Gruppe belegt', () => {
  const seen = new Set<number>();
  for (const s of RUIDA_SETTINGS) {
    assert.ok(s.addr >= 0 && s.addr <= 0x3fff, addrText(s.addr));
    assert.ok(!seen.has(s.addr), `doppelt: ${addrText(s.addr)} ${s.name}`);
    seen.add(s.addr);
    assert.ok(s.name && s.en);
  }
  for (const g of RUIDA_GROUPS) assert.ok(RUIDA_SETTINGS.some((s) => s.group === g.id), g.id);
  assert.ok(RUIDA_SETTINGS.length > 150, `${RUIDA_SETTINGS.length} Einträge`);
  // Bekannte Adressen (MeerK40t): Fahrbereich X/Y, Kennung, Position
  const by = (a: number) => RUIDA_SETTINGS.find((s) => s.addr === a)!;
  assert.equal(by(0x0026).en, 'Axis Range 1');
  assert.equal(by(0x0036).en, 'Axis Range 2');
  assert.equal(by(0x0026).unit, 'mm');
  assert.ok(by(0x02fe).readonly && by(0x0221).readonly);
  assert.equal(by(0x0005).en, 'G0 Velocity');
});

test('Umrechnung: µm ↔ mm, Rohwerte, Bits, Grenzen', () => {
  assert.equal(display({ unit: 'mm' }, 600000), '600');
  assert.equal(display({ unit: 'mm/s' }, 123456), '123.456');
  assert.equal(display({ unit: 'pos' }, 2 ** 32 - 5000), '-5', 'negative Position (32-Bit-Zweierkomplement)');
  assert.equal(display({ unit: 'hex' }, 0x65106510), '0x65106510');
  assert.equal(display({ unit: 'bits' }, 0x13), '0x13');
  assert.equal(display({ unit: 'raw' }, null), '');
  assert.equal(parseInput({ unit: 'mm' }, '600'), 600000);
  assert.equal(parseInput({ unit: 'mm/s' }, '12,5'), 12500);
  assert.equal(parseInput({ unit: 'mm' }, '-1'), null, 'keine negativen Werte');
  assert.equal(parseInput({ unit: 'mm' }, 'abc'), null);
  assert.equal(parseInput({ unit: 'bits' }, '0x1F'), 31);
  assert.equal(parseInput({ unit: 'raw' }, '1.5'), null, 'Rohwerte ganzzahlig');
  assert.equal(parseInput({ unit: 'raw' }, String(RUIDA_MAX + 1)), null);
  assert.equal(parseInput({ unit: 'hex' }, '1'), null, 'nur lesbar');
  assert.deepEqual(bitList(0b1010_0001), [0, 5, 7]);
  assert.deepEqual(bitList(2 ** 34), [34]);
  assert.equal(parseAddr('0x26'), 0x26);
  assert.equal(parseAddr('38'), 38);
  assert.equal(parseAddr('0x4000'), null);
  assert.equal(parseAddr('x'), null);
});

test('Sicherung: speichern, lesen, Unterschiede; nur bekannte, schreibbare Adressen', () => {
  const vals = new Map([[0x0026, 600000], [0x0005, 300000], [0x0221, 12345]]);
  const b = makeBackup('CO2', '0x65106510', vals, new Date('2026-11-06T20:00:00Z'));
  assert.deepEqual(b.values, { '0x0005': 300000, '0x0026': 600000, '0x0221': 12345 });
  const text = JSON.stringify({ ...b, values: { ...b.values, '0x3FFF': 1, '0x0036': -1 } });
  const r = parseBackup(text);
  assert.deepEqual([...r.values].sort((p, q) => p[0] - q[0]), [[0x0005, 300000], [0x0026, 600000]]);
  assert.deepEqual(r.skipped.sort(), ['0x0036', '0x0221', '0x3FFF']);
  assert.deepEqual(backupDiff(new Map([[0x0026, 600000], [0x0005, 250000]]), r.values), [{ addr: 0x0005, from: 250000, to: 300000 }]);
  assert.throws(() => parseBackup('{"format":"other"}'));
});

if (failed) {
  console.log(`${failed} Test(s) fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Ruida-Tests bestanden');
