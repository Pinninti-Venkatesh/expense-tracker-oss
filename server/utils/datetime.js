/**
 * Calendar dates in the USER's timezone, not the server's.
 *
 * Cloud Run runs in UTC. A charge at 3:36 AM IST is 22:06 the previous day in
 * UTC, so `new Date().toISOString().slice(0,10)` and `date.getDate()` both file
 * it under yesterday — it then vanishes from a "Today" filter even though it was
 * recorded correctly. Every stored `date` is a wall-clock calendar day to the
 * person reading it, so it must be computed in their zone.
 *
 * Timezone is configurable but defaults to IST, since this is a single-user app
 * in India. `en-CA` is used purely because its locale format is YYYY-MM-DD.
 */
const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD for the given instant (Date or epoch ms) in the app timezone. */
export function localDate(instant = Date.now()) {
  return dateFmt.format(instant instanceof Date ? instant : new Date(instant));
}

/** Today's calendar date in the app timezone. */
export const today = () => localDate(Date.now());

export const APP_TIMEZONE = APP_TZ;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** How far the app timezone is ahead of UTC at an instant, in ms. */
function zoneOffsetMs(instant) {
  const p = Object.fromEntries(partsFmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const wallClockAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wallClockAsUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a calendar day begins in the app timezone, as epoch ms. `month`
 * is 1–12 and may overflow either way (0 is December of the year before).
 */
export function startOfLocalDay(year, month, day) {
  const guess = Date.UTC(year, month - 1, day);
  const offset = zoneOffsetMs(guess);
  const instant = guess - offset;
  // A zone that changes its clocks between the guess and the answer needs the
  // offset in force at the answer instead.
  const settled = zoneOffsetMs(instant);
  return settled === offset ? instant : guess - settled;
}

/**
 * Midnight on the 1st of last month, in the app timezone, as epoch ms. The
 * first sync reads from here, so a new account sees all of last month and this
 * month so far. On a UTC server, computing this with local Date methods would
 * start 5½ hours late in India and miss the early hours of the 1st.
 */
export function startOfPreviousMonth(instant = Date.now()) {
  const [year, month] = localDate(instant).split('-').map(Number);
  return startOfLocalDay(year, month - 1, 1);
}
