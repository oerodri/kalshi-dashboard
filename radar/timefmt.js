const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function tzParts(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const map = {};
  for (const part of fmt.formatToParts(d)) map[part.type] = part.value;
  const dayPeriod = String(map.dayPeriod || '').toLowerCase().includes('p') ? 'p. m.' : 'a. m.';
  return {
    day: Number(map.day),
    mon: MESES[(Number(map.month) || 1) - 1] || '',
    year: map.year,
    hour: Number(map.hour),
    minute: map.minute,
    second: map.second,
    dayPeriod,
    tz: map.timeZoneName || 'EST',
  };
}

function clock(p) {
  return `${p.hour}:${p.minute}:${p.second} ${p.dayPeriod} ${p.tz}`;
}

export function fmtNowET(ms) {
  const p = tzParts(ms);
  if (!p) return '';
  return `Ahora ${p.day} ${p.mon} ${p.year}, ${clock(p)}`;
}

export function fmtDataET(ms) {
  const p = tzParts(ms);
  if (!p) return '—';
  return `${p.day} ${p.mon} ${p.year}, ${clock(p)}`;
}

export function fmtCloseET(msOrIso) {
  const ms = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso);
  const p = tzParts(ms);
  if (!p) return '—';
  return `Cierre ${p.day} ${p.mon}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.tz}`;
}
