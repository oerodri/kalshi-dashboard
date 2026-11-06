function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stateClass(s) {
  if (!s) return 's-esperar';
  if (s.startsWith('Condición') || s.startsWith('Candidato')) return 's-ok';
  if (s === 'Preparando') return 's-prep';
  if (s === 'Bloqueada') return 's-block';
  return 's-esperar';
}

function econBox(title, econ) {
  if (!econ) return '';
  return `<div><span>${esc(title)}</span><b>neto ${esc(econ.net)}</b><small>bruto ${esc(econ.gross)} · comisiones ${esc(econ.fee_in)}+${esc(econ.fee_out)} · prima ${esc(econ.premium)}</small></div>`;
}

function candidateLines(m) {
  const all = m.bilateralAll || [];
  if (!all.length) return '';
  return all
    .slice(0, 8)
    .map((s) => {
      const id = s.candidate_id ? `${s.candidate_id} · ` : '';
      const side = s.side ? `${s.side} · ` : '';
      const family = s.family ? `${s.family} · ` : '';
      return `<div class="mini"><span class="state ${stateClass(s.state)}">${esc(s.state)}</span> ${esc(id + side + family)}${esc(s.reason || '')}</div>`;
    })
    .join('');
}

function detailLine(d) {
  if (!d) return '';
  const target = d.target_price_rebound || d.target_price_continue || '';
  if (!target) return '';
  return `<div class="mini">Precio objetivo del candidato ${esc(target)} · stop ${esc(d.stop_price || '—')} · entrada ask ${esc(d.entry_idea_ask_taker || '—')}. ${esc(d.note_arithmetic || '')} No es ROI ni dólares por barril.</div>`;
}

export function renderMarkets(view) {
  if (!view.markets || !view.markets.length) {
    return '<div class="card"><h2>Sin contratos en pantalla</h2><p class="sub">No hay un libro recibido. No se rellena con un ejemplo.</p></div>';
  }
  return view.markets
    .map((m, idx) => {
      const v = m.bilateral && m.bilateral.validation;
      const valStatus = (v && v.status) || 'Exploratorio · no validado';
      const valSample = (v && v.hit_rate_display) || 'Sin muestra suficiente';
      return `<article class="card">
        <h2>${esc(m.ticker)}</h2>
        <div class="meta">${esc(m.strike ?? '')} · ${esc(m.closeText)} · latencia de la lectura ${esc(m.latencyText)}</div>
        <div class="meta">Último libro de este contrato: ${esc(m.receiptText)}</div>
        <div class="row"><span class="state ${stateClass(m.legacy && m.legacy.state)}">LEGACY</span><span class="sub">${esc(m.legacy && m.legacy.state)} — ${esc(m.legacy && m.legacy.reason)}</span></div>
        <div class="row"><span class="state ${stateClass(m.bilateral && m.bilateral.state)}">% 20/30</span><span class="sub">${esc(m.bilateral && m.bilateral.state)} — ${esc(m.bilateral && m.bilateral.reason)}</span></div>
        ${candidateLines(m)}
        ${detailLine(m.bilateral && m.bilateral.details)}
        <div class="kv">
          <div><span>YES bid</span><b>${esc(m.bidText)}</b> × ${esc(m.bidQtyText)}</div>
          <div><span>YES ask (derivado de NO bid)</span><b>${esc(m.askText)}</b> × ${esc(m.askQtyText)}</div>
          <div><span>Spread</span><b>${esc(m.spreadText)}</b></div>
          <div><span>Niveles en la respuesta</span><b>${esc(m.levelsText)}</b></div>
          <div><span>Tamaño idea (máx)</span><b>${esc(m.sizeText)}</b></div>
          <div><span>Validación</span><b>${esc(valStatus)}</b><small>${esc(valSample)}</small></div>
          ${econBox('Neto si ambas se llenan (+5¢ legacy)', m.econ)}
          ${econBox('Si stop −3¢ se llena', m.stopEcon)}
        </div>
        <canvas id="c${idx}" width="600" height="110" aria-hidden="true"></canvas>
        <p class="sub">Verde = bid · Rojo = ask. El % es del contrato, no del barril. No es una orden ni un consejo.</p>
      </article>`;
    })
    .join('');
}

export function applyView(doc, view) {
  const banner = doc.getElementById('banner');
  banner.textContent = view.ageSec == null ? `${view.banner} · sin libro` : `${view.banner} · edad del libro ${view.ageSec.toFixed(1)} s`;
  banner.className = 'banner ' + (view.stale ? 'bad' : 'ok');
  const ageBit = view.ageSec == null ? 'sin libro' : `edad del libro más viejo en pantalla ${view.ageSec.toFixed(1)} s`;
  doc.getElementById('clock').textContent = `Reloj de la interfaz: ${view.interfaceText} · ${ageBit}`;
  const attempt = view.attemptText ? `Último intento de lectura: ${view.attemptText}. ` : '';
  const receipt = view.receiptText ? `Último libro bueno: ${view.receiptText}. ` : 'Último libro bueno: ninguno. ';
  doc.getElementById('reason').textContent = `${attempt}${receipt}${view.reason}`;
  const ev = doc.getElementById('event-line');
  if (ev) {
    ev.textContent = view.eventTicker
      ? `Evento en pantalla: ${view.eventTicker}. Se eligen hasta 3 strikes abiertos del evento que cierra antes, los más cercanos a 50¢ en el listado (ese listado puede ir hasta 15 s detrás; la cotización del cuadro es el libro).`
      : 'Todavía no hay evento elegido.';
  }
  const fee = doc.getElementById('fee-line');
  if (fee) fee.textContent = view.feeLine;
  const root = doc.getElementById('markets');
  root.innerHTML = renderMarkets(view);
  return root;
}

export function drawCharts(root, markets) {
  const canvases = root.querySelectorAll('canvas');
  markets.forEach((m, i) => {
    const canvas = canvases[i];
    if (!canvas || !canvas.getContext) return;
    const dpr = Number(globalThis.devicePixelRatio) > 0 ? Number(globalThis.devicePixelRatio) : 1;
    const cssW = Math.max(280, canvas.clientWidth || 600);
    const cssH = 110;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const series = m.series || [];
    const w = cssW;
    const h = cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#121a24';
    ctx.fillRect(0, 0, w, h);
    if (series.length < 2) {
      ctx.fillStyle = '#9aa8bc';
      ctx.font = '14px sans-serif';
      ctx.fillText('Sin historial de libros todavía', 12, 28);
      return;
    }
    const vals = series.flatMap((p) => [p.bid_ticks, p.ask_ticks]).filter((x) => x != null);
    if (vals.length < 2) {
      ctx.fillStyle = '#9aa8bc';
      ctx.font = '14px sans-serif';
      ctx.fillText('Sin historial de libros todavía', 12, 28);
      return;
    }
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) {
      min -= 100;
      max += 100;
    }
    const x = (idx) => (idx / (series.length - 1)) * (w - 12) + 6;
    const y = (v) => h - ((v - min) / (max - min)) * (h - 16) - 8;
    const line = (key, color) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      let started = false;
      series.forEach((p, idx) => {
        if (p[key] == null) return;
        const X = x(idx);
        const Y = y(p[key]);
        if (!started) {
          ctx.moveTo(X, Y);
          started = true;
        } else ctx.lineTo(X, Y);
      });
      ctx.stroke();
    };
    line('bid_ticks', '#3dd68c');
    line('ask_ticks', '#ff6b6b');
  });
}
