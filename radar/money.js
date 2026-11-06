/** Precios en diezmilésimas de dólar (1.0000 = 10000). Comisión taker del radar original. */

export function dollarsToTicks(x) {
  if (x == null || x === '') return null;
  const s = typeof x === 'number' ? x.toFixed(4) : String(x).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [whole, fracRaw = ''] = s.replace('-', '').split('.');
  const frac = (fracRaw + '0000').slice(0, 4);
  const ticks = Number(whole) * 10000 + Number(frac);
  if (!Number.isFinite(ticks)) return null;
  return neg ? -ticks : ticks;
}

/** 10000 unidades = 1 dólar. Recorta ceros de más y deja al menos 2 decimales. */
export function formatMicro(micro) {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(micro));
  const dollars = Math.floor(abs / 10000);
  let frac = String(abs % 10000).padStart(4, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return sign + dollars + '.' + frac;
}

export function formatTicks4(ticks) {
  if (ticks == null || !Number.isFinite(ticks)) return '—';
  const sign = ticks < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(ticks));
  return sign + Math.floor(abs / 10000) + '.' + String(abs % 10000).padStart(4, '0');
}

/** Ceil al centavo de 0.07 × contratos × P × (1−P). multiplier 1 = fórmula original. */
export function feeCents(qty, ticks, multiplier = 1) {
  if (!Number.isInteger(qty) || qty <= 0) return null;
  if (!Number.isInteger(ticks) || ticks <= 0 || ticks >= 10000) return null;
  const m = Math.round(Number(multiplier) * 1000);
  if (!Number.isInteger(m) || m <= 0) return null;
  const num = 7n * BigInt(m) * BigInt(qty) * BigInt(ticks) * BigInt(10000 - ticks);
  const den = 100000000n * 1000n;
  return Number((num + den - 1n) / den);
}

export function roundTrip(entryTicks, exitTicks, qty, multiplier = 1) {
  const feeIn = feeCents(qty, entryTicks, multiplier);
  const feeOut = feeCents(qty, exitTicks, multiplier);
  if (feeIn == null || feeOut == null) return null;
  const gross = (exitTicks - entryTicks) * qty;
  const net = gross - feeIn * 100 - feeOut * 100;
  const premium = entryTicks * qty;
  return {
    qty: String(qty),
    entry: formatMicro(entryTicks),
    exit: formatMicro(exitTicks),
    gross: formatMicro(gross),
    fee_in: formatMicro(feeIn * 100),
    fee_out: formatMicro(feeOut * 100),
    net: formatMicro(net),
    premium: formatMicro(premium),
    worst_case_binary_loss: formatMicro(premium),
    assumption: 'taker-equivalent both legs, ceil $0.01/order; maker not assumed free',
  };
}

export function suggestedQty(entryTicks, bidQty, opts = {}) {
  const maxContracts = opts.maxContracts ?? 10;
  const maxPremium = opts.maxPremiumDollars ?? 5;
  const depthFrac = opts.depthFrac ?? 0.25;
  const qty = Number(bidQty);
  if (!Number.isInteger(entryTicks) || entryTicks <= 0 || !Number.isFinite(qty) || qty <= 0) return 0;
  const byPrem = Math.floor((maxPremium * 10000) / entryTicks);
  const byDepth = Math.trunc(qty * depthFrac + 1e-9);
  return Math.max(0, Math.min(maxContracts, byPrem, byDepth));
}
