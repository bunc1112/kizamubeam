// Fenster „Ruida-Steuerung“: Einstellungen (Hersteller- und Benutzerparameter) lesen, ändern, sichern und
// wiederherstellen, Zähler und Kennung ansehen, Z/U referenzieren, Autofokus. Katalog und Umrechnung: ruidaSettings.ts.
// Jede Änderung wird vorher bestätigt, der alte Stand gesichert und der neue Wert von der Steuerung zurückgelesen.
import { h } from './dom';
import { openText, saveText } from './files';
import { device, laserNotify } from './laser';
import { machine } from './machine';
import { t, tn } from './i18n';
import {
  addrText, backupDiff, bitList, display, makeBackup, parseAddr, parseBackup, parseInput, RUIDA_GROUPS, RUIDA_MAX, RUIDA_SETTINGS, RuidaBackup, RuidaGroup,
  RuidaSetting, unitLabel,
} from './ruidaSettings';

function dialog(cls: string, ...children: (HTMLElement | string)[]): HTMLDialogElement {
  const dlg = h('dialog', { class: `fluid-dialog ${cls}` }, ...children) as HTMLDialogElement;
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

const ready = () => machine.connected && machine.isRuida && !machine.running;
const notReady = () => (!machine.connected ? t('Nicht verbunden.') : !machine.isRuida ? t('Keine Ruida-Steuerung verbunden.') : t('Es läuft bereits ein Auftrag.'));

// ---------- Sicherungen im Speicher der App ----------

const BACKUP_KEY = 'kizamubeam.ruidaBackups';
const MAX_BACKUPS = 10;

function loadBackups(): RuidaBackup[] {
  try {
    const all = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}') as Record<string, RuidaBackup[]>;
    return all[device.id] ?? [];
  } catch {
    return [];
  }
}

function storeBackup(b: RuidaBackup) {
  try {
    const all = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}') as Record<string, RuidaBackup[]>;
    const list = all[device.id] ?? [];
    if (list[0] && JSON.stringify(list[0].values) === JSON.stringify(b.values)) return;
    all[device.id] = [b, ...list].slice(0, MAX_BACKUPS);
    localStorage.setItem(BACKUP_KEY, JSON.stringify(all));
  } catch {
    /* nicht speicherbar */
  }
}

const backupFile = (b: RuidaBackup) => `ruida-${device.name.replace(/[^\w-]+/g, '-')}-${b.date.slice(0, 16).replace(/[:T]/g, '-')}.json`;

// ---------- Fenster ----------

export async function openRuidaSettings() {
  if (!ready()) return laserNotify(notReady(), true);
  /** Gelesene Werte und Texte */
  const values = new Map<number, number>();
  const texts = new Map<number, string>();
  const errors = new Map<number, string>();
  /** Geänderte Werte: Adresse → neuer Rohwert */
  const edits = new Map<number, number>();
  let group: RuidaGroup = 'axes';
  let card = '';

  const note = h('div', { class: 'note' });
  const head = h('div', { class: 'note' });
  const table = h('div', { class: 'fluid-config ruida-settings' });
  const count = h('span', { class: 'note' });
  const search = h('input', { type: 'search', placeholder: t('Suchen, z. B. Beschleunigung oder 0x0026'), oninput: () => render() }) as HTMLInputElement;
  const tabs = h('div', { class: 'conn-row' });
  const groupNote = h('div', { class: 'note' });
  const backups = h('div', { class: 'fluid-backups' });

  const applyBtn = h('button', { class: 'btn primary', onclick: () => apply() }, t('In die Steuerung schreiben …')) as HTMLButtonElement;
  const resetBtn = h('button', { class: 'btn', onclick: () => (edits.clear(), render()) }, t('Änderungen verwerfen')) as HTMLButtonElement;

  // Aktionen der Steuerung, die die Maschine bewegen: immer nachfragen
  const action = (label: string, a: 'homeZ' | 'homeU' | 'focusZ', question: string) =>
    h('button', {
      class: 'btn small',
      onclick: async () => {
        if (!ready()) return (note.textContent = notReady());
        if (!confirm(question)) return;
        await machine.ruidaAction(a);
        note.textContent = t('Befehl gesendet: {what}', { what: label });
      },
    }, label);

  // Rohzugriff auf eine Adresse
  const rawAddr = h('input', { type: 'text', placeholder: '0x0026', size: 8, spellcheck: false }) as HTMLInputElement;
  const rawVal = h('input', { type: 'text', placeholder: t('Rohwert'), size: 12, spellcheck: false }) as HTMLInputElement;
  const rawOut = h('span', { class: 'note' });

  const dlg = dialog('ruida-settings-dialog',
    h('h3', {}, t('Ruida-Steuerung')),
    head,
    h('div', { class: 'note warn' }, t('Herstellerparameter bestimmen Motoren, Fahrbereich, Endschalter und Laser. Falsche Werte können Achsen gegen die Anschläge fahren lassen oder die Röhre beschädigen. Nur ändern, was du verstehst; vorher sichern. KizamuBeam schreibt nichts ohne Rückfrage und legt vor jedem Schreiben eine Sicherung an.')),
    tabs,
    groupNote,
    h('div', { class: 'conn-row' }, search,
      h('button', { class: 'btn', onclick: () => readAll() }, t('Neu lesen')),
      h('button', { class: 'btn', title: t('Alle gelesenen Werte als Datei sichern'), onclick: () => saveFile() }, t('Als Datei sichern …')),
      h('button', { class: 'btn', title: t('Eine Sicherungsdatei mit der Steuerung vergleichen; die Unterschiede werden als Änderungen vorgemerkt'), onclick: () => restoreFile() }, t('Aus Datei laden …')),
    ),
    table,
    h('details', { class: 'fluid-backups-box' }, h('summary', {}, t('Steuerung bedienen')),
      h('div', { class: 'conn-row' },
        action(t('Z referenzieren'), 'homeZ', t('Z-Achse referenzieren? Tisch bzw. Kopf fahren bis zum Endschalter. Vorher den Bereich freiräumen.')),
        action(t('U referenzieren'), 'homeU', t('U-Achse referenzieren? Sie fährt bis zum Endschalter.')),
        action(t('Autofokus'), 'focusZ', t('Autofokus starten? Die Z-Achse fährt, bis der Fokussensor auslöst. Nur mit eingebautem Fokussensor.')),
      ),
    ),
    h('details', { class: 'fluid-backups-box' }, h('summary', {}, t('Sicherungen')),
      h('div', { class: 'note' }, t('Vor jedem Schreiben legt KizamuBeam den gelesenen Stand hier ab (die letzten {n} je Gerät).', { n: MAX_BACKUPS })), backups),
    h('details', { class: 'fluid-backups-box' }, h('summary', {}, t('Experten: beliebige Adresse')),
      h('div', { class: 'note' }, t('Liest oder schreibt eine Speicheradresse (0x0000 … 0x3FFF) als Rohwert. Unbekannte Adressen können alles Mögliche bedeuten.')),
      h('div', { class: 'conn-row' }, rawAddr,
        h('button', { class: 'btn small', onclick: () => rawRead() }, t('Lesen')),
        rawVal,
        h('button', { class: 'btn small', onclick: () => rawWrite() }, t('Schreiben …')),
        rawOut,
      ),
    ),
    note,
    h('div', { class: 'dialog-buttons' }, count, h('button', { class: 'btn', onclick: () => dlg.close() }, t('Schließen')), resetBtn, applyBtn),
  );

  for (const g of RUIDA_GROUPS) {
    const b = h('button', { class: 'btn small', onclick: () => ((group = g.id), (search.value = ''), render()) }, g.label);
    b.dataset.group = g.id;
    tabs.append(b);
  }

  const setting = (a: number) => RUIDA_SETTINGS.find((s) => s.addr === a);

  function row(s: RuidaSetting) {
    const raw = values.get(s.addr) ?? null;
    const err = errors.get(s.addr);
    const label = h('label', { title: `${s.en} · ${addrText(s.addr)}` }, s.name);
    const unit = unitLabel(s.unit);
    const rawNote = h('span', { class: 'note' }, raw !== null && unit ? t('Rohwert {raw}', { raw }) : s.unit === 'bits' && raw !== null ? bitsText(raw) : '');
    if (s.readonly || s.unit === 'pos' || s.unit === 'hex' || s.unit === 'text') {
      table.append(label, h('span', {}, err ? t('Fehler: {error}', { error: err }) : `${display(s, raw, texts.get(s.addr))}${unit ? ' ' + unit : ''}`), h('span', {}));
      return;
    }
    const input = h('input', {
      type: 'text', spellcheck: false,
      value: edits.has(s.addr) ? display(s, edits.get(s.addr)!) : display(s, raw),
      disabled: raw === null,
      title: raw === null ? (err ?? t('Nicht gelesen')) : s.unit === 'bits' ? t('Hexadezimal (0x…) oder dezimal') : '',
      oninput: (e: Event) => {
        const el = e.target as HTMLInputElement;
        const v = parseInput(s, el.value);
        el.classList.toggle('invalid', v === null);
        if (v === null || v === raw) edits.delete(s.addr);
        else edits.set(s.addr, v);
        el.classList.toggle('changed', edits.has(s.addr));
        if (s.unit === 'bits' && v !== null) rawNote.textContent = bitsText(v);
        updateButtons();
      },
    }) as HTMLInputElement;
    input.classList.toggle('changed', edits.has(s.addr));
    table.append(label, h('span', { class: 'conn-row' }, input, unit ? h('span', { class: 'note' }, unit) : ''), rawNote);
  }

  const bitsText = (v: number) => {
    const b = bitList(v);
    return b.length ? t('Bits: {list}', { list: b.join(', ') }) : t('keine Bits gesetzt');
  };

  function render() {
    table.textContent = '';
    const q = search.value.trim().toLowerCase();
    for (const b of tabs.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('primary', !q && b.dataset.group === group);
    groupNote.textContent = q ? '' : (RUIDA_GROUPS.find((g) => g.id === group)?.note ?? '');
    const list = RUIDA_SETTINGS.filter((s) =>
      q ? s.name.toLowerCase().includes(q) || s.en.toLowerCase().includes(q) || addrText(s.addr).toLowerCase().includes(q) : s.group === group,
    );
    for (const s of list) row(s);
    if (!list.length) table.append(h('div', { class: 'note wide' }, t('Keine Einträge.')));
    renderBackups();
    updateButtons();
  }

  function updateButtons() {
    count.textContent = edits.size ? tn('{n} Änderung', '{n} Änderungen', edits.size) : '';
    applyBtn.disabled = resetBtn.disabled = !edits.size;
  }

  function renderBackups() {
    backups.textContent = '';
    const list = loadBackups();
    if (!list.length) return void backups.append(h('div', { class: 'note' }, t('Noch keine Sicherungen.')));
    for (const b of list)
      backups.append(h('div', { class: 'conn-row' },
        h('span', {}, new Date(b.date).toLocaleString()),
        h('button', { class: 'btn small', onclick: () => saveText(backupFile(b), t('Ruida-Sicherung'), 'json', 'application/json', JSON.stringify(b, null, 2)) }, t('Speichern …')),
        h('button', { class: 'btn small', title: t('Unterschiede zu diesem Stand als Änderungen vormerken'), onclick: () => stage(new Map(Object.entries(b.values).map(([k, v]) => [parseAddr(k)!, v]))) }, t('Vormerken')),
      ));
  }

  async function readAll() {
    if (!ready()) return void (note.textContent = notReady());
    note.textContent = t('Lese Einstellungen …');
    const addrs = [...new Set(RUIDA_SETTINGS.map((s) => s.addr))];
    try {
      for (let i = 0; i < addrs.length; i += 32) {
        for (const r of await machine.ruidaRead(addrs.slice(i, i + 32))) {
          if (r.error) errors.set(r.addr, r.error);
          else errors.delete(r.addr);
          if (r.value !== null) values.set(r.addr, r.value);
          texts.set(r.addr, r.text);
        }
        note.textContent = t('Lese Einstellungen … {n} von {total}', { n: Math.min(addrs.length, i + 32), total: addrs.length });
      }
    } catch (e) {
      note.textContent = (e as Error).message;
      return render();
    }
    card = values.has(0x02fe) ? display({ unit: 'hex' }, values.get(0x02fe)!) : '';
    const version = texts.get(0x02ff) || '';
    head.textContent = t('Steuerung: {card}, Firmware {version}, Gerät „{name}“', { card: card || '?', version: version || '?', name: device.name });
    const bad = errors.size;
    note.textContent = bad
      ? tn('{n} Adresse ohne Antwort (gibt es bei dieser Steuerung vielleicht nicht).', '{n} Adressen ohne Antwort (gibt es bei dieser Steuerung vielleicht nicht).', bad)
      : t('Alle Werte gelesen.');
    render();
  }

  /** Nur schreibbare, gelesene Werte für die Sicherung */
  const writableValues = () => new Map([...values].filter(([a]) => !setting(a)?.readonly));

  function saveFile() {
    if (!values.size) return void (note.textContent = t('Erst lesen.'));
    const b = makeBackup(device.name, card, writableValues());
    storeBackup(b);
    saveText(backupFile(b), t('Ruida-Sicherung'), 'json', 'application/json', JSON.stringify(b, null, 2));
    renderBackups();
  }

  function stage(wanted: Map<number, number>) {
    if (!values.size) return void (note.textContent = t('Erst lesen.'));
    const diff = backupDiff(values, wanted).filter((d) => d.from !== null);
    for (const d of diff) edits.set(d.addr, d.to);
    note.textContent = diff.length ? tn('{n} Unterschied vorgemerkt. Prüfen und dann schreiben.', '{n} Unterschiede vorgemerkt. Prüfen und dann schreiben.', diff.length) : t('Keine Unterschiede.');
    render();
  }

  async function restoreFile() {
    const f = await openText(t('Ruida-Sicherung'), ['json']);
    if (!f) return;
    try {
      const { backup, values: wanted, skipped } = parseBackup(f[1]);
      if (backup.card && card && backup.card !== card && !confirm(t('Die Sicherung stammt von einer anderen Steuerung ({from}, verbunden: {to}). Trotzdem vergleichen?', { from: backup.card, to: card }))) return;
      stage(wanted);
      if (skipped.length) note.textContent += ' ' + tn('{n} Eintrag übersprungen (unbekannt oder nur lesbar).', '{n} Einträge übersprungen (unbekannt oder nur lesbar).', skipped.length);
    } catch (e) {
      note.textContent = t('Datei nicht lesbar: {error}', { error: (e as Error).message });
    }
  }

  async function apply() {
    if (!ready()) return void (note.textContent = notReady());
    if (machine.status.state !== 'Idle') return void (note.textContent = t('Zum Schreiben muss die Maschine still stehen.'));
    const list = [...edits].map(([a, v]) => {
      const s = setting(a);
      const u = s ? unitLabel(s.unit) : '';
      return `• ${s?.name ?? addrText(a)} (${addrText(a)}): ${s ? display(s, values.get(a) ?? null) : values.get(a)} → ${s ? display(s, v) : v}${u ? ' ' + u : ''}`;
    });
    if (!confirm(t('Diese Werte in die Steuerung schreiben?') + '\n\n' + list.join('\n') + '\n\n' + t('Der bisherige Stand wird vorher gesichert. Manche Werte wirken erst nach einem Neustart der Steuerung.'))) return;
    storeBackup(makeBackup(device.name, card, writableValues()));
    const failed: string[] = [];
    let ok = 0;
    for (const [a, v] of [...edits]) {
      try {
        const back = await machine.ruidaWrite(a, v);
        values.set(a, back);
        edits.delete(a);
        ok++;
        machine.log(t('Ruida: {addr} = {value}', { addr: addrText(a), value: back }));
      } catch (e) {
        failed.push(`${setting(a)?.name ?? addrText(a)}: ${(e as Error).message}`);
      }
    }
    note.textContent = failed.length
      ? t('{ok} geschrieben, Fehler: {errors}', { ok, errors: failed.join('; ') })
      : tn('{n} Wert geschrieben und geprüft.', '{n} Werte geschrieben und geprüft.', ok);
    render();
  }

  async function rawRead() {
    const a = parseAddr(rawAddr.value);
    if (a === null) return void (rawOut.textContent = t('Adresse 0x0000 … 0x3FFF'));
    if (!ready()) return void (rawOut.textContent = notReady());
    try {
      const [r] = await machine.ruidaRead([a]);
      rawOut.textContent = r.error ? r.error : `${addrText(a)} = ${r.value ?? '–'} (0x${(r.value ?? 0).toString(16).toUpperCase()})${r.text ? ` „${r.text}“` : ''}`;
      if (r.value !== null) rawVal.value = String(r.value);
    } catch (e) {
      rawOut.textContent = (e as Error).message;
    }
  }

  async function rawWrite() {
    const a = parseAddr(rawAddr.value);
    const v = parseInput({ unit: 'raw' }, rawVal.value);
    if (a === null || v === null) return void (rawOut.textContent = t('Adresse 0x0000 … 0x3FFF und Rohwert 0 … {max}', { max: RUIDA_MAX }));
    if (!ready()) return void (rawOut.textContent = notReady());
    const s = setting(a);
    if (s?.readonly) return void (rawOut.textContent = t('Diese Adresse ist nur zum Lesen.'));
    if (!confirm(t('Rohwert {value} an Adresse {addr} schreiben?', { value: v, addr: addrText(a) }) + (s ? `\n${s.name}` : '\n' + t('Diese Adresse ist KizamuBeam unbekannt.')) + '\n\n' + t('Das kann die Maschine unbrauchbar machen, bis der alte Wert wieder geschrieben ist.'))) return;
    try {
      const [old] = await machine.ruidaRead([a]);
      if (old.value !== null) storeBackup(makeBackup(device.name, card, new Map([[a, old.value]])));
      const back = await machine.ruidaWrite(a, v);
      rawOut.textContent = t('Geschrieben und gelesen: {value} (vorher {old})', { value: back, old: old.value ?? '–' });
      values.set(a, back);
      renderBackups();
    } catch (e) {
      rawOut.textContent = (e as Error).message;
    }
  }

  render();
  readAll();
}
