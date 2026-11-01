"use strict";

/*
 * Small iCalendar (.ics) reader for the calendar panel: VEVENTs, time zones, all-day events,
 * recurrence rules (DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY,
 * BYMONTH, BYSETPOS-free), EXDATE and modified occurrences (RECURRENCE-ID).
 * It does not try to be a full implementation, only what calendar feeds from Outlook / Google use.
 */

const Ics = (() => {
  // Windows time zone names (used by Outlook feeds) -> IANA names (used by Intl).
  const WINDOWS_TZ = {
    "UTC": "UTC",
    "GMT Standard Time": "Europe/London",
    "W. Europe Standard Time": "Europe/Berlin",
    "Central Europe Standard Time": "Europe/Budapest",
    "Central European Standard Time": "Europe/Warsaw",
    "Romance Standard Time": "Europe/Paris",
    "E. Europe Standard Time": "Europe/Chisinau",
    "FLE Standard Time": "Europe/Kiev",
    "GTB Standard Time": "Europe/Bucharest",
    "Russian Standard Time": "Europe/Moscow",
    "Turkey Standard Time": "Europe/Istanbul",
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "Pacific Standard Time": "America/Los_Angeles",
    "Alaskan Standard Time": "America/Anchorage",
    "AUS Eastern Standard Time": "Australia/Sydney",
    "India Standard Time": "Asia/Kolkata",
    "China Standard Time": "Asia/Shanghai",
    "Tokyo Standard Time": "Asia/Tokyo",
  };

  const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  /* --- text helpers ---------------------------------------------------- */

  function unfold(text) {
    return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  }

  function unescapeText(v) {
    return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  }

  function parseLine(line) {
    const colon = (() => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQuote = !inQuote;
        else if (line[i] === ":" && !inQuote) return i;
      }
      return -1;
    })();
    if (colon < 0) return null;
    const head = line.slice(0, colon).split(";");
    const params = {};
    for (const p of head.slice(1)) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
  }

  /* --- time zones ------------------------------------------------------ */

  const formatters = new Map();

  function ianaZone(tzid) {
    if (!tzid) return null;
    const name = WINDOWS_TZ[tzid] || tzid.replace(/^\/?(mozilla\.org\/[^/]+\/|[^/]+\.com\/[^/]+\/)/, "");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: name });
      return name;
    } catch {
      return null;
    }
  }

  /** Offset (ms) of `zone` from UTC at the given instant. */
  function zoneOffset(instant, zone) {
    let f = formatters.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
      formatters.set(zone, f);
    }
    const p = {};
    for (const part of f.formatToParts(instant)) p[part.type] = Number(part.value);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
  }

  /** Wall-clock components in `zone` (or the local zone when null) -> Date. */
  function wallToDate(w, zone) {
    if (!zone) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    let t = guess - zoneOffset(new Date(guess), zone);
    t = guess - zoneOffset(new Date(t), zone); // second pass settles DST edges
    return new Date(t);
  }

  /** "20261101T080000[Z]" / "20261101" -> { y, mo, d, h, mi, s, utc, dateOnly } */
  function parseStamp(v) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
    if (!m) return null;
    return {
      y: +m[1], mo: +m[2], d: +m[3],
      h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
      utc: !!m[7], dateOnly: m[4] === undefined,
    };
  }

  function toDate(stamp, tzid) {
    if (stamp.utc) return new Date(Date.UTC(stamp.y, stamp.mo - 1, stamp.d, stamp.h, stamp.mi, stamp.s));
    return wallToDate(stamp, stamp.dateOnly ? null : ianaZone(tzid));
  }

  const wallMs = (w) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  function fromWallMs(ms, like) {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: like.h, mi: like.mi, s: like.s };
  }

  /* --- recurrence -------------------------------------------------------- */

  function parseRule(value) {
    const r = {};
    for (const part of value.split(";")) {
      const [k, v] = part.split("=");
      r[k.toUpperCase()] = v;
    }
    return {
      freq: r.FREQ,
      interval: Math.max(1, +r.INTERVAL || 1),
      count: r.COUNT ? +r.COUNT : null,
      until: r.UNTIL ? parseStamp(r.UNTIL) : null,
      byDay: r.BYDAY ? r.BYDAY.split(",").map((x) => ({ n: +(/^[+-]?\d+/.exec(x) || [0])[0] || 0, day: DAY_CODES.indexOf(x.slice(-2)) })) : null,
      byMonthDay: r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null,
      byMonth: r.BYMONTH ? r.BYMONTH.split(",").map(Number) : null,
    };
  }

  function daysInMonth(y, mo) {
    return new Date(Date.UTC(y, mo, 0)).getUTCDate();
  }

  /** Days (day-of-month numbers) of a month matching BYDAY entries like MO, 2TU, -1FR. */
  function monthDays(y, mo, byDay) {
    const out = new Set();
    const total = daysInMonth(y, mo);
    for (const { n, day } of byDay) {
      const days = [];
      for (let d = 1; d <= total; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === day) days.push(d);
      if (n === 0) days.forEach((d) => out.add(d));
      else {
        const pick = n > 0 ? days[n - 1] : days[days.length + n];
        if (pick) out.add(pick);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /**
   * Start times (wall-clock, same zone as DTSTART) of the occurrences of `rule`,
   * generated lazily until `stopMs` (wall-clock ms).
   */
  function* occurrences(start, rule, stopMs) {
    const first = wallMs(start);
    const startDay = new Date(first).getUTCDay();
    let produced = 0;
    const limit = rule.count ?? Infinity;
    const untilMs = rule.until ? wallMs({ ...rule.until, h: rule.until.dateOnly ? 23 : rule.until.h, mi: rule.until.dateOnly ? 59 : rule.until.mi, s: rule.until.dateOnly ? 59 : rule.until.s }) : Infinity;
    const emit = function* (w) {
      const ms = wallMs(w);
      if (ms < first || ms > untilMs || ms > stopMs || produced >= limit) return false;
      produced += 1;
      yield w;
      return true;
    };
    const okMonth = (mo) => !rule.byMonth || rule.byMonth.includes(mo);

    if (rule.freq === "DAILY") {
      for (let i = 0; i < 4000; i++) {
        const w = fromWallMs(first + i * rule.interval * 86400000, start);
        if (wallMs(w) > Math.min(stopMs, untilMs) || produced >= limit) return;
        if (okMonth(w.mo) && (!rule.byDay || rule.byDay.some((b) => b.day === new Date(wallMs(w)).getUTCDay()))) yield* emit(w);
      }
    } else if (rule.freq === "WEEKLY") {
      const days = rule.byDay ? rule.byDay.map((b) => b.day) : [startDay];
      const weekStart = first - startDay * 86400000; // Sunday of the first week
      for (let week = 0; week < 1000; week++) {
        const base = weekStart + week * rule.interval * 7 * 86400000;
        if (base > Math.min(stopMs, untilMs) + 7 * 86400000 || produced >= limit) return;
        for (const day of [...days].sort((a, b) => a - b)) {
          const w = fromWallMs(base + day * 86400000, start);
          if (wallMs(w) < first) continue;
          if (wallMs(w) > Math.min(stopMs, untilMs) || produced >= limit) return;
          if (okMonth(w.mo)) yield* emit(w);
        }
      }
    } else if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
      const step = rule.freq === "MONTHLY" ? rule.interval : rule.interval * 12;
      for (let i = 0; i < 600; i++) {
        const total = start.y * 12 + (start.mo - 1) + i * step;
        const y = Math.floor(total / 12);
        const mo = (total % 12) + 1;
        if (Date.UTC(y, mo - 1, 1) > Math.min(stopMs, untilMs) || produced >= limit) return;
        if (!okMonth(mo) || (rule.freq === "YEARLY" && !rule.byMonth && mo !== start.mo)) continue;
        let days;
        if (rule.byMonthDay) days = rule.byMonthDay.map((d) => (d < 0 ? daysInMonth(y, mo) + 1 + d : d));
        else if (rule.byDay) days = monthDays(y, mo, rule.byDay);
        else days = [start.d];
        for (const d of days.filter((d) => d >= 1 && d <= daysInMonth(y, mo)).sort((a, b) => a - b)) {
          yield* emit({ y, mo, d, h: start.h, mi: start.mi, s: start.s });
        }
      }
    }
  }

  /* --- parsing ----------------------------------------------------------- */

  function parse(text) {
    const events = [];
    let cal = { name: "" };
    let cur = null;
    let inAlarm = false;
    for (const raw of unfold(text)) {
      const line = parseLine(raw);
      if (!line) continue;
      if (line.name === "X-WR-CALNAME") cal.name = unescapeText(line.value);
      if (line.name === "BEGIN" && line.value === "VEVENT") cur = { exdates: [], props: {} };
      else if (line.name === "END" && line.value === "VEVENT") {
        if (cur) events.push(cur);
        cur = null;
      } else if (cur && line.name === "BEGIN" && line.value === "VALARM") inAlarm = true;
      else if (cur && line.name === "END" && line.value === "VALARM") inAlarm = false;
      else if (cur && !inAlarm) {
        if (line.name === "EXDATE") for (const v of line.value.split(",")) cur.exdates.push({ stamp: parseStamp(v), tzid: line.params.TZID });
        else cur.props[line.name] = line;
      }
    }
    return { name: cal.name, events };
  }

  const JOIN = /https:\/\/(teams\.microsoft\.com\/l\/meetup-join|[\w.]*zoom\.us\/j|meet\.google\.com)\/[^\s<>"\\)]+/;

  /** Events of `text` that overlap [from, to], recurrences expanded. */
  function expand(text, from, to) {
    const { name, events } = parse(text);
    const out = [];
    const overrides = new Map(); // uid|recurrence-id ms -> event
    for (const e of events) {
      const rid = e.props["RECURRENCE-ID"];
      if (rid && e.props.UID) {
        const stamp = parseStamp(rid.value);
        if (stamp) overrides.set(`${e.props.UID.value}|${toDate(stamp, rid.params.TZID).getTime()}`, e);
      }
    }

    const make = (e, start, end, allDay) => {
      const p = e.props;
      const desc = unescapeText(p.DESCRIPTION?.value || "");
      const url = p["X-MICROSOFT-SKYPETEAMSMEETINGURL"]?.value || p.URL?.value || (JOIN.exec(desc) || JOIN.exec(p.LOCATION?.value || "") || [""])[0];
      return {
        title: unescapeText(p.SUMMARY?.value || "(no title)"),
        location: unescapeText(p.LOCATION?.value || "").replace(JOIN, "").trim(),
        join: url && /^https?:/i.test(url) ? url : "",
        start: start.getTime(),
        end: end.getTime(),
        allDay,
        busy: /TRANSPARENT/i.test(p.TRANSP?.value || "") ? 0 : 2,
      };
    };

    for (const e of events) {
      const p = e.props;
      if (!p.DTSTART || /CANCELLED/i.test(p.STATUS?.value || "")) continue;
      if (p["RECURRENCE-ID"]) {
        // a modified occurrence is only emitted if it is not replacing a generated one below
        continue;
      }
      const s = parseStamp(p.DTSTART.value);
      if (!s) continue;
      const tzid = p.DTSTART.params.TZID;
      const allDay = s.dateOnly;
      const startDate = toDate(s, tzid);
      let durationMs = allDay ? 86400000 : 3600000;
      if (p.DTEND) {
        const en = parseStamp(p.DTEND.value);
        if (en) durationMs = Math.max(0, toDate(en, p.DTEND.params.TZID || tzid).getTime() - startDate.getTime());
      } else if (p.DURATION) {
        const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(p.DURATION.value);
        if (m) durationMs = (((+m[1] || 0) * 7 + (+m[2] || 0)) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000;
      }

      const overlaps = (a, b) => b >= from.getTime() && a <= to.getTime();
      if (!p.RRULE) {
        if (overlaps(startDate.getTime(), startDate.getTime() + durationMs)) {
          out.push(make(e, startDate, new Date(startDate.getTime() + durationMs), allDay));
        }
        continue;
      }

      const rule = parseRule(p.RRULE.value);
      const zone = s.utc ? "UTC" : allDay ? null : ianaZone(tzid);
      const excluded = new Set(e.exdates.filter((x) => x.stamp).map((x) => toDate(x.stamp, x.tzid || tzid).getTime()));
      // Occurrences are generated in wall-clock time of the event's zone, then converted (keeps DST right).
      const stopMs = to.getTime() + 2 * 86400000 + (zone ? 14 * 3600000 : 0);
      for (const w of occurrences(s, rule, stopMs)) {
        const at = s.utc ? new Date(wallMs(w)) : wallToDate(w, zone);
        if (excluded.has(at.getTime())) continue;
        const override = overrides.get(`${p.UID?.value}|${at.getTime()}`);
        if (override) continue; // handled below
        if (overlaps(at.getTime(), at.getTime() + durationMs)) {
          out.push(make(e, at, new Date(at.getTime() + durationMs), allDay));
        }
      }
    }

    // modified occurrences
    for (const e of overrides.values()) {
      const p = e.props;
      if (!p.DTSTART || /CANCELLED/i.test(p.STATUS?.value || "")) continue;
      const s = parseStamp(p.DTSTART.value);
      if (!s) continue;
      const start = toDate(s, p.DTSTART.params.TZID);
      let end = new Date(start.getTime() + 3600000);
      if (p.DTEND) {
        const en = parseStamp(p.DTEND.value);
        if (en) end = toDate(en, p.DTEND.params.TZID || p.DTSTART.params.TZID);
      }
      if (end.getTime() >= from.getTime() && start.getTime() <= to.getTime()) out.push(make(e, start, end, s.dateOnly));
    }
    return { name, events: out.sort((a, b) => a.start - b.start) };
  }

  return { parse, expand };
})();

if (typeof module !== "undefined") module.exports = Ics;
