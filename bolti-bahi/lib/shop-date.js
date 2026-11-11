/**
 * Shop calendar dates.
 *
 * The server runs in UTC, the shop does not. A kirana closing at 1am IST was
 * having its entries stamped 2026-11-12 while "today" was computed as
 * 2026-11-11, so "Aaj ka Udhaar" read ₹0 next to a list of today's rows.
 *
 * Every date the app compares or stamps now comes from this one helper, in the
 * shop's own timezone.
 */

export const SHOP_TIMEZONE = process.env.SHOP_TIMEZONE || 'Asia/Kolkata';

/**
 * @param {Date} [date]
 * @param {string} [timeZone]
 * @returns {string} YYYY-MM-DD in the shop's timezone
 */
export function localYmd(date = new Date(), timeZone = SHOP_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  try {
    return formatter.format(date);
  } catch {
    // Unknown SHOP_TIMEZONE should not take the ledger down.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
}
