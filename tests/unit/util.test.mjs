import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as u from "../../extension/lib/util.js";

const DHAKA = "Asia/Dhaka";
const NY = "America/New_York";
// Local wall time in Dhaka (UTC+6, no DST) on 2026-10-<d>.
const dhaka = (h, m, d = 29, mo = 10) => u.zonedTime(2026, mo, d, h, m, DHAKA);

describe("util.js", () => {
afterEach(() => { u._setClock(null); u._setRandom(null); });

describe("normalizeHandle", () => {
  test("plain, @ and case", () => {
    assert.equal(u.normalizeHandle("VitalikButerin"), "vitalikbuterin");
    assert.equal(u.normalizeHandle("@Vitalik"), "vitalik");
    assert.equal(u.normalizeHandle("@@double"), "double");
    assert.equal(u.normalizeHandle("  @spaced_1  "), "spaced_1");
  });
  test("x.com / twitter.com URLs", () => {
    assert.equal(u.normalizeHandle("https://x.com/elonmusk"), "elonmusk");
    assert.equal(u.normalizeHandle("https://x.com/elonmusk/status/1849000000000000000"), "elonmusk");
    assert.equal(u.normalizeHandle("x.com/Foo_Bar"), "foo_bar");
    assert.equal(u.normalizeHandle("http://www.twitter.com/jack?lang=en"), "jack");
    assert.equal(u.normalizeHandle("https://mobile.twitter.com/@naval"), "naval");
    assert.equal(u.normalizeHandle("https://twitter.com/#!/oldstyle"), "oldstyle");
    assert.equal(u.normalizeHandle("https://x.com/someone#top"), "someone");
  });
  test("reserved X paths are rejected", () => {
    for (const r of ["home", "explore", "notifications", "messages", "i", "search", "settings", "compose", "login", "hashtag", "intent", "share"]) {
      assert.equal(u.normalizeHandle(r), "", r);
    }
    assert.equal(u.normalizeHandle("https://x.com/home"), "");
    assert.equal(u.normalizeHandle("https://x.com/i/lists/123456"), "");
    assert.equal(u.normalizeHandle("https://x.com/search?q=from%3Afoo"), "");
    assert.equal(u.normalizeHandle("https://twitter.com/intent/user?screen_name=foo"), "");
  });
  test("invalid input", () => {
    assert.equal(u.normalizeHandle(null), "");
    assert.equal(u.normalizeHandle(undefined), "");
    assert.equal(u.normalizeHandle(""), "");
    assert.equal(u.normalizeHandle("   "), "");
    assert.equal(u.normalizeHandle("@"), "");
    assert.equal(u.normalizeHandle("this_handle_is_too_long"), "");
    assert.equal(u.normalizeHandle("!!!"), "");
  });
  test("non-X URLs are not turned into a handle", () => {
    assert.equal(u.normalizeHandle("https://instagram.com/foo"), "");
    assert.equal(u.normalizeHandle("http://example.org/bar"), "");
    assert.equal(u.normalizeHandle("www.example.com/foo"), "");
  });
});

describe("parseHandleList", () => {
  test("splits on whitespace, commas, semicolons, dedupes", () => {
    const text = "@alice, bob;carol\n\thttps://x.com/Dave/status/123\n@ALICE  bob\nhome";
    assert.deepEqual(u.parseHandleList(text), ["alice", "bob", "carol", "dave"]);
  });
  test("empty / nullish", () => {
    assert.deepEqual(u.parseHandleList(""), []);
    assert.deepEqual(u.parseHandleList(null), []);
  });
});

describe("parseCount / tweetIdFromUrl / fmt", () => {
  test("parseCount", () => {
    assert.equal(u.parseCount("12.3K"), 12300);
    assert.equal(u.parseCount("1,234"), 1234);
    assert.equal(u.parseCount("1.2M"), 1200000);
    assert.equal(u.parseCount("3B"), 3000000000);
    assert.equal(u.parseCount("987"), 987);
    assert.equal(u.parseCount("4.5k"), 4500);
    assert.equal(u.parseCount(" 1 234 "), 1234);
    assert.equal(u.parseCount(42), 42);
    assert.equal(u.parseCount("abc"), null);
    assert.equal(u.parseCount(""), null);
    assert.equal(u.parseCount(null), null);
  });
  test("tweetIdFromUrl", () => {
    assert.equal(u.tweetIdFromUrl("https://x.com/foo/status/1849123456789012345"), "1849123456789012345");
    assert.equal(u.tweetIdFromUrl("https://twitter.com/foo/statuses/123456789?s=20"), "123456789");
    assert.equal(u.tweetIdFromUrl("https://x.com/foo/status/1849123456789012345/photo/1"), "1849123456789012345");
    assert.equal(u.tweetIdFromUrl("https://x.com/foo"), "");
    assert.equal(u.tweetIdFromUrl(null), "");
    assert.equal(u.tweetUrl("foo", "123"), "https://x.com/foo/status/123");
  });
  test("fmtCount / fmtUsd / fmtDuration / truncate", () => {
    assert.equal(u.fmtCount(999), "999");
    assert.equal(u.fmtCount(12300), "12.3K");
    assert.equal(u.fmtCount(2000000), "2M");
    assert.equal(u.fmtCount(null), "-");
    assert.equal(u.fmtUsd(1.5), "$1.50");
    assert.equal(u.fmtUsd(0.0012), "$0.0012");
    assert.equal(u.fmtUsd(0), "$0.00");
    assert.equal(u.fmtDuration(30 * 1000), "30s");
    assert.equal(u.fmtDuration(5 * u.MIN), "5m");
    assert.equal(u.fmtDuration(90 * u.MIN), "1h 30m");
    assert.equal(u.fmtDuration(3 * u.DAY), "3d");
    assert.equal(u.truncate("abcdef", 4), "abc…");
    assert.equal(u.truncate("abc", 4), "abc");
  });
});

describe("random helpers with injected RNG / clock", () => {
  test("now() and random() are injectable", () => {
    u._setClock(() => 1234);
    u._setRandom(() => 0.25);
    assert.equal(u.now(), 1234);
    assert.equal(u.random(), 0.25);
    u._setClock(null);
    assert.ok(Math.abs(u.now() - Date.now()) < 1000);
  });
  test("randInt bounds", () => {
    u._setRandom(() => 0);
    assert.equal(u.randInt(3, 6), 3);
    u._setRandom(() => 0.999999);
    assert.equal(u.randInt(3, 6), 6);
    assert.equal(u.randInt(6, 3), 6);
  });
  test("humanDelay stays in range without the long tail", () => {
    u._setRandom(() => 0.5); // u=0.5, chance(0.06) false
    assert.equal(u.humanDelay(1000, 3000), 2000);
    u._setRandom(() => 0);
    // chance(0.06) true with random 0 -> long tail added (0.3 * span)
    assert.equal(u.humanDelay(1000, 3000), 1000 + 0.3 * 2000);
  });
  test("pick / shuffle / sample deterministic", () => {
    u._setRandom(() => 0);
    assert.equal(u.pick(["a", "b", "c"]), "a");
    assert.equal(u.pick([]), undefined);
    const s = u.shuffle([1, 2, 3, 4]);
    assert.deepEqual([...s].sort(), [1, 2, 3, 4]);
    assert.equal(u.sample([1, 2, 3, 4], 2).length, 2);
    assert.equal(u.sample([1, 2], -1).length, 0);
  });
  test("uid uses clock + rng", () => {
    u._setClock(() => 1000);
    u._setRandom(() => 0.5);
    const a = u.uid("h");
    assert.ok(a.startsWith("h" + (1000).toString(36)));
    assert.equal(a, u.uid("h"));
  });
});

describe("time zones", () => {
  test("zonedParts / dayKey in Asia/Dhaka (UTC+6, no DST)", () => {
    const ts = Date.UTC(2026, 9, 29, 18, 30); // 2026-10-30 00:30 Dhaka
    const p = u.zonedParts(ts, DHAKA);
    assert.deepEqual(p, { year: 2026, month: 10, day: 30, hour: 0, minute: 30, second: 0, weekday: 5 });
    assert.equal(u.dayKey(ts, DHAKA), "2026-10-30");
    assert.equal(u.dayKey(ts, "UTC"), "2026-10-29");
    assert.equal(u.monthKey(Date.UTC(2026, 9, 31, 18, 0), DHAKA), "2026-11");
    // Same offset in summer and winter
    assert.equal(u.tzOffset(Date.UTC(2026, 0, 15), DHAKA), 6 * u.HOUR);
    assert.equal(u.tzOffset(Date.UTC(2026, 6, 15), DHAKA), 6 * u.HOUR);
  });
  test("zonedParts / tzOffset in America/New_York (DST)", () => {
    const summer = Date.UTC(2026, 6, 1, 3, 30); // 2026-06-30 23:30 EDT
    assert.equal(u.dayKey(summer, NY), "2026-06-30");
    assert.equal(u.zonedParts(summer, NY).hour, 23);
    assert.equal(u.tzOffset(summer, NY), -4 * u.HOUR);
    const winter = Date.UTC(2026, 0, 15, 4, 30); // 2026-01-14 23:30 EST
    assert.equal(u.dayKey(winter, NY), "2026-01-14");
    assert.equal(u.tzOffset(winter, NY), -5 * u.HOUR);
  });
  test("zonedTime round-trips and handles DST transitions", () => {
    assert.equal(u.zonedTime(2026, 10, 29, 10, 0, DHAKA), Date.UTC(2026, 9, 29, 4, 0));
    // after spring-forward (2026-03-08) EDT
    assert.equal(u.zonedTime(2026, 3, 8, 3, 0, NY), Date.UTC(2026, 2, 8, 7, 0));
    assert.equal(u.zonedTime(2026, 3, 7, 23, 0, NY), Date.UTC(2026, 2, 8, 4, 0));
    // after fall-back (2026-11-01) EST
    assert.equal(u.zonedTime(2026, 11, 1, 12, 0, NY), Date.UTC(2026, 10, 1, 17, 0));
    assert.equal(u.zonedTime(2026, 10, 31, 12, 0, NY), Date.UTC(2026, 9, 31, 16, 0));
  });
  test("startOfDay", () => {
    assert.equal(u.startOfDay(dhaka(15, 45), DHAKA), dhaka(0, 0));
    assert.equal(u.startOfDay(Date.UTC(2026, 10, 1, 20, 0), NY), Date.UTC(2026, 10, 1, 4, 0)); // EDT midnight on fall-back day
  });
  test("weekKey ISO weeks incl. year boundaries and local time zone", () => {
    assert.equal(u.weekKey(Date.UTC(2026, 0, 1, 12), "UTC"), "2026-W01");
    assert.equal(u.weekKey(Date.UTC(2027, 0, 1, 12), "UTC"), "2026-W53");
    assert.equal(u.weekKey(Date.UTC(2024, 11, 30, 12), "UTC"), "2025-W01");
    assert.equal(u.weekKey(Date.UTC(2021, 0, 3, 12), "UTC"), "2020-W53");
    // Sunday 2026-11-01 20:00 UTC is Monday 02:00 in Dhaka -> next ISO week there
    const ts = Date.UTC(2026, 10, 1, 20, 0);
    assert.equal(u.weekKey(ts, "UTC"), "2026-W44");
    assert.equal(u.weekKey(ts, DHAKA), "2026-W45");
  });
  test("parseHHMM", () => {
    assert.equal(u.parseHHMM("10:00"), 600);
    assert.equal(u.parseHHMM("0:05"), 5);
    assert.equal(u.parseHHMM("24:00"), 1440);
    assert.equal(u.parseHHMM("24:01"), null);
    assert.equal(u.parseHHMM("25:00"), null);
    assert.equal(u.parseHHMM("10:60"), null);
    assert.equal(u.parseHHMM("10am"), null);
    assert.equal(u.parseHHMM(null), null);
  });
  test("isValidTimeZone", () => {
    assert.equal(u.isValidTimeZone("Asia/Dhaka"), true);
    assert.equal(u.isValidTimeZone("Mars/Olympus"), false);
    assert.equal(u.isValidTimeZone(""), false);
  });
});

describe("inWindow", () => {
  test('"10:00"-"00:00" runs until midnight', () => {
    const w = (h, m) => u.inWindow(dhaka(h, m), "10:00", "00:00", DHAKA);
    assert.equal(w(9, 59), false);
    assert.equal(w(10, 0), true);
    assert.equal(w(15, 0), true);
    assert.equal(w(23, 30), true);
    assert.equal(w(23, 59), true);
    assert.equal(w(0, 0), false);
    assert.equal(w(0, 30), false);
  });
  test('"22:00"-"02:00" crosses midnight', () => {
    const w = (h, m) => u.inWindow(dhaka(h, m), "22:00", "02:00", DHAKA);
    assert.equal(w(21, 59), false);
    assert.equal(w(22, 0), true);
    assert.equal(w(23, 59), true);
    assert.equal(w(0, 0), true);
    assert.equal(w(1, 59), true);
    assert.equal(w(2, 0), false);
    assert.equal(w(12, 0), false);
  });
  test('"09:00"-"17:00" same day', () => {
    const w = (h, m) => u.inWindow(dhaka(h, m), "09:00", "17:00", DHAKA);
    assert.equal(w(8, 59), false);
    assert.equal(w(9, 0), true);
    assert.equal(w(16, 59), true);
    assert.equal(w(17, 0), false);
    assert.equal(w(23, 0), false);
  });
  test("same start/end = 24h, 00:00-24:00 = 24h, invalid = open", () => {
    for (const h of [0, 3, 8, 12, 23]) {
      assert.equal(u.inWindow(dhaka(h, 15), "08:00", "08:00", DHAKA), true);
      assert.equal(u.inWindow(dhaka(h, 15), "00:00", "00:00", DHAKA), true);
      assert.equal(u.inWindow(dhaka(h, 15), "00:00", "24:00", DHAKA), true);
      assert.equal(u.inWindow(dhaka(h, 15), "nope", "17:00", DHAKA), true);
    }
  });
  test("uses the configured time zone, not UTC", () => {
    const ts = Date.UTC(2026, 9, 29, 3, 0); // 09:00 Dhaka, 03:00 UTC, 23:00 NY (prev day)
    assert.equal(u.inWindow(ts, "09:00", "17:00", DHAKA), true);
    assert.equal(u.inWindow(ts, "09:00", "17:00", "UTC"), false);
    assert.equal(u.inWindow(ts, "22:00", "02:00", NY), true);
  });
});

describe("nextWindowStart / currentWindowEnd", () => {
  test("nextWindowStart returns ts when inside", () => {
    const ts = dhaka(12, 0);
    assert.equal(u.nextWindowStart(ts, "10:00", "00:00", DHAKA), ts);
  });
  test("nextWindowStart same day / next day / crossing midnight (Dhaka)", () => {
    assert.equal(u.nextWindowStart(dhaka(0, 30), "10:00", "00:00", DHAKA), dhaka(10, 0));
    assert.equal(u.nextWindowStart(dhaka(23, 0), "09:00", "17:00", DHAKA), dhaka(9, 0, 30));
    assert.equal(u.nextWindowStart(dhaka(17, 0), "09:00", "17:00", DHAKA), dhaka(9, 0, 30));
    assert.equal(u.nextWindowStart(dhaka(3, 0), "22:00", "02:00", DHAKA), dhaka(22, 0));
    // month boundary
    assert.equal(u.nextWindowStart(dhaka(20, 0, 31), "09:00", "17:00", DHAKA), u.zonedTime(2026, 11, 1, 9, 0, DHAKA));
  });
  test("nextWindowStart around DST transitions (New York)", () => {
    // 2026-03-07 23:30 EST -> next 10:00 is 2026-03-08 10:00 EDT (not 03-09)
    const before = u.zonedTime(2026, 3, 7, 23, 30, NY);
    assert.equal(u.nextWindowStart(before, "10:00", "22:00", NY), Date.UTC(2026, 2, 8, 14, 0));
    // fall-back day: 00:30 EDT -> 10:00 EST same day
    const fb = u.zonedTime(2026, 11, 1, 0, 30, NY);
    assert.equal(u.nextWindowStart(fb, "10:00", "00:00", NY), Date.UTC(2026, 10, 1, 15, 0));
    // day before fall-back, after the window -> 10:00 EST on 11-01
    const late = u.zonedTime(2026, 10, 31, 23, 0, NY);
    assert.equal(u.nextWindowStart(late, "10:00", "22:00", NY), Date.UTC(2026, 10, 1, 15, 0));
  });
  test("currentWindowEnd (Dhaka)", () => {
    assert.equal(u.currentWindowEnd(dhaka(23, 30), "10:00", "00:00", DHAKA), dhaka(0, 0, 30));
    assert.equal(u.currentWindowEnd(dhaka(10, 0), "10:00", "00:00", DHAKA), dhaka(0, 0, 30));
    assert.equal(u.currentWindowEnd(dhaka(12, 0), "09:00", "17:00", DHAKA), dhaka(17, 0));
    assert.equal(u.currentWindowEnd(dhaka(23, 0), "22:00", "02:00", DHAKA), dhaka(2, 0, 30));
    assert.equal(u.currentWindowEnd(dhaka(1, 0), "22:00", "02:00", DHAKA), dhaka(2, 0));
    assert.equal(u.currentWindowEnd(dhaka(12, 0), "10:00", "24:00", DHAKA), dhaka(0, 0, 30));
    assert.equal(u.currentWindowEnd(dhaka(12, 0), "10:00", "bad", DHAKA), dhaka(12, 0) + u.DAY);
  });
  test("currentWindowEnd terminates and is correct on DST days (New York)", () => {
    // fall-back day (25h): 15:00 EST inside 10:00-00:00 -> ends 2026-11-02 00:00 EST
    const fb = u.zonedTime(2026, 11, 1, 15, 0, NY);
    assert.equal(u.currentWindowEnd(fb, "10:00", "00:00", NY), Date.UTC(2026, 10, 2, 5, 0));
    // spring-forward eve: window crossing midnight ending 23:40 -> next day 23:40 EDT, not two days later
    const sp = u.zonedTime(2026, 3, 7, 23, 55, NY);
    assert.equal(u.currentWindowEnd(sp, "23:50", "23:40", NY), u.zonedTime(2026, 3, 8, 23, 40, NY));
    assert.equal(u.dayKey(u.currentWindowEnd(sp, "23:50", "23:40", NY), NY), "2026-03-08");
    // spring-forward day (23h): 15:00 EDT inside 10:00-00:00 -> ends 2026-03-09 00:00 EDT
    const sd = u.zonedTime(2026, 3, 8, 15, 0, NY);
    assert.equal(u.currentWindowEnd(sd, "10:00", "00:00", NY), Date.UTC(2026, 2, 9, 4, 0));
  });
});

describe("text helpers", () => {
  test("normalizeText / words / ngrams / jaccard", () => {
    assert.equal(u.normalizeText("Héllo, WORLD! https://t.co/x  it's"), "hello world it's");
    assert.deepEqual(u.words("A b, c"), ["a", "b", "c"]);
    assert.deepEqual(u.words(""), []);
    const g = u.ngrams(["a", "b", "c", "d"], 3);
    assert.deepEqual([...g], ["a b c", "b c d"]);
    assert.equal(u.jaccard(new Set(), new Set()), 0);
    assert.equal(u.jaccard(new Set(["x", "y"]), new Set(["y", "z"])), 1 / 3);
  });
  test("countEmoji collapses ZWJ sequences, skin tones and VS16", () => {
    assert.equal(u.countEmoji("no emoji here"), 0);
    assert.equal(u.countEmoji("nice 🔥"), 1);
    assert.equal(u.countEmoji("🔥🔥"), 2);
    assert.equal(u.countEmoji("👍🏽"), 1);
    assert.equal(u.countEmoji("❤️"), 1);
    assert.equal(u.countEmoji("👨‍👩‍👧"), 1);
    assert.equal(u.countEmoji("👩🏽‍💻"), 1);
    assert.equal(u.countEmoji("🏳️‍🌈"), 1);
    assert.equal(u.countEmoji("👨‍👩‍👧 and 👍🏽"), 2);
    assert.equal(u.countEmoji(null), 0);
  });
  test("redact removes sk- keys, Bearer tokens and key fields", () => {
    const s = u.redact("key=sk-proj-AbCdEf1234567890_xyz and Authorization: Bearer abc.def-ghi_12345");
    assert.ok(!s.includes("AbCdEf1234567890"), s);
    assert.ok(!s.includes("abc.def-ghi_12345"), s);
    assert.ok(s.includes("sk-***"));
    assert.ok(s.includes("Bearer ***"));
    const o = u.redact({ openaiKey: "plain-secret-value", note: "ok" });
    assert.ok(!o.includes("plain-secret-value"), o);
    assert.ok(o.includes('"note":"ok"'));
    assert.ok(!u.redact('{"api_key":"abc"}').includes("abc"));
    assert.equal(u.redact("nothing secret"), "nothing secret");
  });
  test("csvEscape neutralises formulas and quotes properly", () => {
    assert.equal(u.csvEscape(null), "");
    assert.equal(u.csvEscape(undefined), "");
    assert.equal(u.csvEscape("plain"), "plain");
    assert.equal(u.csvEscape(12), "12");
    assert.equal(u.csvEscape("=SUM(A1:A9)"), "'=SUM(A1:A9)");
    assert.equal(u.csvEscape("+CMD|' /C calc'!A0"), "'+CMD|' /C calc'!A0");
    assert.equal(u.csvEscape("-2+3"), "'-2+3");
    assert.equal(u.csvEscape("@SUM(1)"), "'@SUM(1)");
    assert.equal(u.csvEscape("\tTAB"), "'\tTAB");
    assert.equal(u.csvEscape('He said "hi"'), '"He said ""hi"""');
    assert.equal(u.csvEscape("a,b"), '"a,b"');
    assert.equal(u.csvEscape("line1\nline2"), '"line1\nline2"');
    assert.equal(u.csvEscape('=HYPERLINK("x",1)'), '"\'=HYPERLINK(""x"",1)"');
    assert.equal(u.csvEscape({ a: 1 }), '"{""a"":1}"');
  });
  test("toCsv header labels, getters and CRLF", () => {
    const csv = u.toCsv([{ a: "x", b: 2 }, { a: "=1", b: "y,z" }], [{ key: "a", label: "Col A" }, { key: "b" }, { key: "c", label: "C", get: (r) => String(r.b).length }]);
    assert.equal(csv, 'Col A,b,C\r\nx,2,1\r\n\'=1,"y,z",3');
  });
  test("deepMerge replaces arrays, merges objects, keeps base intact", () => {
    const base = { a: [1, 2, 3], b: { c: 1, d: 2 }, e: "x" };
    const out = u.deepMerge(base, { a: [9], b: { c: 5 }, f: true, e: undefined });
    assert.deepEqual(out, { a: [9], b: { c: 5, d: 2 }, e: "x", f: true });
    assert.deepEqual(base, { a: [1, 2, 3], b: { c: 1, d: 2 }, e: "x" });
    assert.deepEqual(u.deepMerge({ a: [1, 2] }, { a: [] }), { a: [] });
    assert.deepEqual(u.deepMerge({ a: { b: 1 } }, { a: null }), { a: null });
    assert.equal(u.deepMerge(1, undefined), 1);
    assert.deepEqual(u.deepClone({ a: [1, { b: 2 }] }), { a: [1, { b: 2 }] });
    assert.equal(u.deepClone(null), null);
  });
  test("clamp / num", () => {
    assert.equal(u.clamp(5, 0, 3), 3);
    assert.equal(u.clamp(-1, 0, 3), 0);
    assert.equal(u.num("4.5"), 4.5);
    assert.equal(u.num("x", 7), 7);
    assert.equal(u.num(undefined, 2), 2);
    assert.equal(u.num(Infinity, 1), 1);
  });
});
});
