// Heating Schedule Card
// Edits a Home Assistant schedule helper whose blocks carry a target temperature
// in their block data, as rows of "days · from · to · temperature".
// Config: type: custom:heating-schedule-card, schedule, name?, base?, climate?,
//         temperature_attribute? (block data key, default "temperature")
const HSC_VERSION = "1.0.0";
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const TEXTS = {
  en: {
    days: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
    base: "Base temperature (outside the periods)",
    add: "+ Period",
    save: "Save",
    saved: "Saved.",
    unsaved: "Unsaved changes",
    empty: "No periods – the base temperature applies all day.",
    del: "Delete period",
    loadError: "Loading failed: ",
    saveError: "Saving failed: ",
    notFound: "Schedule not found: ",
    row: "Row",
    noDay: "no day selected",
    noTime: "time missing",
    order: "“to” must be after “from” (00:00 = midnight)",
    temp: "temperature 5–30 °C",
    overlap: "periods overlap",
    nowBlock: (t, n) => `Now: period ${t} °C until ${n}`,
    nowBase: (g, n) => `Now: base temperature${g}, next period ${n}`,
    thermostat: (c, s) => `Thermostat: ${c} °C, target ${s} °C`,
  },
  de: {
    days: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
    base: "Grundtemperatur (außerhalb der Zeiträume)",
    add: "+ Zeitraum",
    save: "Speichern",
    saved: "Gespeichert.",
    unsaved: "Ungespeicherte Änderungen",
    empty: "Keine Zeiträume – den ganzen Tag gilt die Grundtemperatur.",
    del: "Zeitraum löschen",
    loadError: "Fehler beim Laden: ",
    saveError: "Speichern fehlgeschlagen: ",
    notFound: "Zeitplan nicht gefunden: ",
    row: "Zeile",
    noDay: "kein Tag gewählt",
    noTime: "Zeit fehlt",
    order: "„bis“ muss nach „von“ liegen (00:00 = Mitternacht)",
    temp: "Temperatur 5–30 °C",
    overlap: "Zeiträume überschneiden sich",
    nowBlock: (t, n) => `Jetzt Zeitraum: ${t} °C bis ${n}`,
    nowBase: (g, n) => `Jetzt Grundtemperatur${g}, nächster Zeitraum ${n}`,
    thermostat: (c, s) => `Thermostat: ${c} °C, Soll ${s} °C`,
  },
};

class HeatingScheduleCard extends HTMLElement {
  setConfig(config) {
    if (!config.schedule) throw new Error("schedule is required");
    this._cfg = { ...config };
    if (!this._cfg.base && config.grund) this._cfg.base = config.grund; // legacy key
    this._key = config.temperature_attribute || "temperature";
    this._rows = null;
    this._dirty = false;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._started) {
      this._started = true;
      this._load();
    } else {
      this._renderStatus();
    }
  }

  get _t() {
    const lang = ((this._hass && (this._hass.locale?.language || this._hass.language)) || "en").slice(0, 2);
    return TEXTS[lang] || TEXTS.en;
  }

  getCardSize() {
    return 3 + (this._rows ? this._rows.length : 2);
  }

  static getStubConfig() {
    return { schedule: "" };
  }

  async _load() {
    try {
      const reg = await this._hass.callWS({ type: "config/entity_registry/get", entity_id: this._cfg.schedule });
      this._sid = reg.unique_id;
      const list = await this._hass.callWS({ type: "schedule/list" });
      this._item = list.find((i) => i.id === this._sid);
      if (!this._item) throw new Error(this._t.notFound + this._sid);
      this._rows = this._toRows(this._item);
      this._dirty = false;
      this._msg = "";
      this._render();
    } catch (e) {
      this._rows = [];
      this._msg = this._t.loadError + (e.message || e);
      this._err = true;
      this._render();
    }
  }

  _hhmm(t) {
    return (t || "").slice(0, 5);
  }

  _toRows(item) {
    const map = new Map();
    DAYS.forEach((day, i) => {
      (item[day] || []).forEach((b) => {
        const temp = b.data && b.data[this._key] != null ? Number(b.data[this._key]) : null;
        const key = `${this._hhmm(b.from)}|${this._hhmm(b.to)}|${temp}`;
        if (!map.has(key)) map.set(key, { from: this._hhmm(b.from), to: this._hhmm(b.to), temp, days: [], data: b.data || {} });
        map.get(key).days.push(i);
      });
    });
    return [...map.values()].sort((a, b) => a.days[0] - b.days[0] || a.from.localeCompare(b.from));
  }

  _min(t) {
    if (!t) return NaN;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }

  _end(r) {
    return r.to === "00:00" ? 1440 : this._min(r.to);
  }

  _validate() {
    const t = this._t;
    for (const [n, r] of this._rows.entries()) {
      const z = `${t.row} ${n + 1}`;
      if (!r.days.length) return `${z}: ${t.noDay}`;
      if (!r.from || !r.to) return `${z}: ${t.noTime}`;
      if (!(this._end(r) > this._min(r.from))) return `${z}: ${t.order}`;
      if (r.temp == null || isNaN(r.temp) || r.temp < 5 || r.temp > 30) return `${z}: ${t.temp}`;
    }
    for (let d = 0; d < 7; d++) {
      const bl = this._rows
        .filter((r) => r.days.includes(d))
        .map((r) => [this._min(r.from), this._end(r)])
        .sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < bl.length; i++) {
        if (bl[i][0] < bl[i - 1][1]) return `${t.days[d]}: ${t.overlap}`;
      }
    }
    return "";
  }

  async _save() {
    const err = this._validate();
    if (err) {
      this._showMsg(err, true);
      return;
    }
    const msg = { type: "schedule/update", schedule_id: this._sid, name: this._item.name };
    if (this._item.icon) msg.icon = this._item.icon;
    DAYS.forEach((day, d) => {
      msg[day] = this._rows
        .filter((r) => r.days.includes(d))
        .sort((a, b) => this._min(a.from) - this._min(b.from))
        .map((r) => ({
          from: r.from + ":00",
          to: r.to === "00:00" ? "24:00:00" : r.to + ":00",
          data: { ...r.data, [this._key]: Number(r.temp) },
        }));
    });
    try {
      await this._hass.callWS(msg);
      await this._load();
      this._showMsg(this._t.saved, false);
    } catch (e) {
      this._showMsg(this._t.saveError + (e.message || e), true);
    }
  }

  _setBase(v) {
    if (!this._cfg.base) return;
    const domain = this._cfg.base.split(".")[0];
    this._hass.callService(domain, "set_value", { entity_id: this._cfg.base, value: Number(v) });
  }

  _fmtNext(iso) {
    if (!iso) return "–";
    const lang = this._hass.locale?.language || this._hass.language || "en";
    return new Date(iso).toLocaleString(lang, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }

  _statusText() {
    const h = this._hass;
    if (!h) return "";
    const t = this._t;
    const s = h.states[this._cfg.schedule];
    const g = this._cfg.base ? h.states[this._cfg.base] : null;
    const c = this._cfg.climate ? h.states[this._cfg.climate] : null;
    const parts = [];
    if (s) {
      const next = this._fmtNext(s.attributes.next_event);
      if (s.state === "on") parts.push(t.nowBlock(s.attributes[this._key] ?? "–", next));
      else parts.push(t.nowBase(g ? ` ${g.state} °C` : "", next));
    }
    if (c) parts.push(t.thermostat(c.attributes.current_temperature ?? "–", c.attributes.temperature ?? "–"));
    return parts.join(" · ");
  }

  _renderStatus() {
    if (!this.shadowRoot) return;
    const el = this.shadowRoot.getElementById("status");
    if (el) el.textContent = this._statusText();
    const gi = this.shadowRoot.getElementById("base");
    const g = this._cfg.base ? this._hass.states[this._cfg.base] : null;
    if (gi && g && this.shadowRoot.activeElement !== gi) gi.value = Number(g.state);
  }

  _showMsg(text, error) {
    this._msg = text;
    this._err = error;
    this._renderMsg();
  }

  _renderMsg() {
    const el = this.shadowRoot.getElementById("msg");
    if (el) {
      el.textContent = this._msg || (this._dirty ? this._t.unsaved : "");
      el.className = this._err ? "msg err" : "msg";
    }
    const sb = this.shadowRoot.getElementById("save");
    if (sb) sb.disabled = !this._dirty;
  }

  _changed() {
    this._dirty = true;
    this._msg = "";
    this._err = false;
    this._renderMsg();
  }

  _render() {
    const t = this._t;
    const root = this.shadowRoot;
    const g = this._cfg.base && this._hass ? this._hass.states[this._cfg.base] : null;
    const gmin = g?.attributes?.min ?? 5;
    const gmax = g?.attributes?.max ?? 30;
    const gstep = g?.attributes?.step ?? 0.5;
    root.innerHTML = `
      <style>
        ha-card { padding: 12px 16px 16px; }
        .name { font-size: 1.2em; font-weight: 500; }
        .status { color: var(--secondary-text-color); font-size: .9em; margin: 4px 0 10px; }
        .base { display:flex; align-items:center; gap:8px; margin-bottom: 10px; flex-wrap:wrap; }
        .row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 0; border-top:1px solid var(--divider-color); }
        .days { display:flex; gap:3px; }
        .day { min-width:30px; padding:4px 0; border-radius:6px; border:1px solid var(--divider-color);
               background: none; color: var(--primary-text-color); cursor:pointer; font-size:.85em; }
        .day.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
        input { font: inherit; color: var(--primary-text-color); background: var(--card-background-color);
                border:1px solid var(--divider-color); border-radius:6px; padding:4px 6px; }
        input[type=number] { width: 64px; }
        .del { background:none; border:none; color: var(--error-color); cursor:pointer; font-size:1.2em; }
        .actions { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
        button.btn { font: inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--primary-color);
                     background:none; color: var(--primary-color); cursor:pointer; }
        button.btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        button.btn:disabled { opacity:.4; cursor:default; }
        .msg { font-size:.9em; color: var(--secondary-text-color); }
        .msg.err { color: var(--error-color); }
        .empty { color: var(--secondary-text-color); padding: 8px 0; border-top:1px solid var(--divider-color); }
      </style>
      <ha-card>
        <div class="name">${this._cfg.name || this._cfg.schedule}</div>
        <div class="status" id="status"></div>
        ${this._cfg.base ? `<div class="base"><span>${t.base}</span>
          <input id="base" type="number" min="${gmin}" max="${gmax}" step="${gstep}" value="${g ? Number(g.state) : ""}"> °C</div>` : ""}
        <div id="rows"></div>
        <div class="actions">
          <button class="btn" id="add">${t.add}</button>
          <button class="btn primary" id="save" disabled>${t.save}</button>
          <span class="msg" id="msg"></span>
        </div>
      </ha-card>`;
    const rows = root.getElementById("rows");
    if (!this._rows || !this._rows.length) rows.innerHTML = `<div class="empty">${t.empty}</div>`;
    (this._rows || []).forEach((r, idx) => {
      const div = document.createElement("div");
      div.className = "row";
      div.innerHTML = `
        <div class="days">${t.days.map((k, d) => `<button class="day ${r.days.includes(d) ? "on" : ""}" data-d="${d}">${k}</button>`).join("")}</div>
        <input type="time" class="from" value="${r.from}"> – <input type="time" class="to" value="${r.to}">
        <input type="number" class="temp" min="5" max="30" step="0.5" value="${r.temp ?? ""}"> °C
        <button class="del" title="${t.del}">✕</button>`;
      div.querySelectorAll(".day").forEach((b) =>
        b.addEventListener("click", () => {
          const d = Number(b.dataset.d);
          r.days = r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort();
          b.classList.toggle("on");
          this._changed();
        })
      );
      div.querySelector(".from").addEventListener("change", (e) => { r.from = e.target.value; this._changed(); });
      div.querySelector(".to").addEventListener("change", (e) => { r.to = e.target.value; this._changed(); });
      div.querySelector(".temp").addEventListener("change", (e) => { r.temp = parseFloat(e.target.value); this._changed(); });
      div.querySelector(".del").addEventListener("click", () => {
        this._rows.splice(idx, 1);
        this._dirty = true;
        this._render();
      });
      rows.appendChild(div);
    });
    root.getElementById("add").addEventListener("click", () => {
      this._rows.push({ from: "06:00", to: "08:00", temp: 21, days: [0, 1, 2, 3, 4], data: {} });
      this._dirty = true;
      this._render();
    });
    root.getElementById("save").addEventListener("click", () => this._save());
    const gi = root.getElementById("base");
    if (gi) gi.addEventListener("change", (e) => this._setBase(e.target.value));
    this._renderStatus();
    this._renderMsg();
  }
}

customElements.define("heating-schedule-card", HeatingScheduleCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "heating-schedule-card",
  name: "Heating Schedule Card",
  description: "Edit a schedule helper as periods with a target temperature each.",
});
console.info(`%c HEATING-SCHEDULE-CARD %c ${HSC_VERSION} `, "background:#c0392b;color:#fff", "");
