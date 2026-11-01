"use strict";
// Run with: node --test tests
const test = require("node:test");
const assert = require("node:assert");
const Ics = require("../src/panels/ics.js");

const ics = (...lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Test", ...lines, "END:VCALENDAR"].join("\r\n");
const range = (a, b) => [new Date(a), new Date(b)];
const iso = (ms) => new Date(ms).toISOString();

test("single event with a time zone (Windows name) is converted to the right instant", () => {
  const text = ics(
    "BEGIN:VEVENT", "UID:1", "SUMMARY:Planning", "DTSTART;TZID=W. Europe Standard Time:20261104T090000",
    "DTEND;TZID=W. Europe Standard Time:20261104T100000", "END:VEVENT"
  );
  const { name, events } = Ics.expand(text, ...range("2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z"));
  assert.strictEqual(name, "Test");
  assert.strictEqual(events.length, 1);
  assert.strictEqual(iso(events[0].start), "2026-11-04T08:00:00.000Z"); // CET = UTC+1 in November
  assert.strictEqual(iso(events[0].end), "2026-11-04T09:00:00.000Z");
});

test("UTC event, all-day event and folded lines", () => {
  const text = ics(
    "BEGIN:VEVENT", "UID:2", "SUMMARY:Very long", " title", "DTSTART:20261105T120000Z", "DTEND:20261105T123000Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:3", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261106", "DTEND;VALUE=DATE:20261107", "END:VEVENT"
  );
  const { events } = Ics.expand(text, ...range("2026-11-05T00:00:00Z", "2026-11-08T00:00:00Z"));
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].title, "Very longtitle");
  assert.strictEqual(events[1].allDay, true);
});

test("weekly rule with BYDAY, EXDATE and a modified occurrence", () => {
  const text = ics(
    "BEGIN:VEVENT", "UID:w", "SUMMARY:Standup", "DTSTART;TZID=Europe/Prague:20261102T090000", "DTEND;TZID=Europe/Prague:20261102T091500",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXDATE;TZID=Europe/Prague:20261104T090000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:w", "RECURRENCE-ID;TZID=Europe/Prague:20261109T090000", "SUMMARY:Standup (moved)",
    "DTSTART;TZID=Europe/Prague:20261109T140000", "DTEND;TZID=Europe/Prague:20261109T141500", "END:VEVENT"
  );
  const { events } = Ics.expand(text, ...range("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"));
  // Mon 2, (Wed 4 excluded), Mon 9 -> moved, Wed 11, Mon 16, Wed 18  = 5 events
  assert.deepStrictEqual(events.map((e) => iso(e.start)), [
    "2026-11-02T08:00:00.000Z",
    "2026-11-09T13:00:00.000Z",
    "2026-11-11T08:00:00.000Z",
    "2026-11-16T08:00:00.000Z",
    "2026-11-18T08:00:00.000Z",
  ]);
  assert.strictEqual(events[1].title, "Standup (moved)");
});

test("daily rule keeps the wall-clock time across the DST change", () => {
  const text = ics(
    "BEGIN:VEVENT", "UID:d", "SUMMARY:Daily", "DTSTART;TZID=Europe/Prague:20261024T100000", "DTEND;TZID=Europe/Prague:20261024T103000",
    "RRULE:FREQ=DAILY;COUNT=4", "END:VEVENT"
  );
  const { events } = Ics.expand(text, ...range("2026-10-20T00:00:00Z", "2026-11-05T00:00:00Z"));
  // DST ends on Sunday 25 Oct 2026: 10:00 is 08:00Z before, 09:00Z after.
  assert.deepStrictEqual(events.map((e) => iso(e.start)), [
    "2026-10-24T08:00:00.000Z",
    "2026-10-25T09:00:00.000Z",
    "2026-10-26T09:00:00.000Z",
    "2026-10-27T09:00:00.000Z",
  ]);
});

test("monthly rule on the second Tuesday, and UNTIL", () => {
  const text = ics(
    "BEGIN:VEVENT", "UID:m", "SUMMARY:Review", "DTSTART:20260908T130000Z", "DTEND:20260908T140000Z",
    "RRULE:FREQ=MONTHLY;BYDAY=2TU;UNTIL=20261231T000000Z", "END:VEVENT"
  );
  const { events } = Ics.expand(text, ...range("2026-09-01T00:00:00Z", "2027-03-01T00:00:00Z"));
  assert.deepStrictEqual(events.map((e) => iso(e.start).slice(0, 10)), ["2026-09-08", "2026-10-13", "2026-11-10", "2026-12-08"]);
});

test("join links are found in the description", () => {
  const text = ics(
    "BEGIN:VEVENT", "UID:j", "SUMMARY:Call", "DTSTART:20261105T120000Z", "DTEND:20261105T123000Z",
    "DESCRIPTION:Join https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x now", "END:VEVENT"
  );
  const { events } = Ics.expand(text, ...range("2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z"));
  assert.match(events[0].join, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
});
