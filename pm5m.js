(function(){const m=document.querySelector('main');if(!m)return;const p=document.createElement('div');p.className='panel';p.id='pm5m';
p.innerHTML='<div class="bar"><h2>₿ Polymarket BTC 5m (paper)</h2></div><div id="pmx" class="mut">Cargando…</div>';const cp=document.getElementById('compass');cp?cp.after(p):m.prepend(p);
const u=v=>(v<0?'-':'')+'$'+Math.abs(v||0).toFixed(2),c=v=>v>0?'pos':v<0?'neg':'';
function load(){fetch('pm5m.json?'+Date.now()).then(r=>r.json()).then(d=>{let h='<div class="mut">Actualizado: '+d.actualizado+'</div>';
h+=d.bots.map(b=>`<div style="border-bottom:1px solid var(--ln);padding:10px 0"><b>Bot ${b.nombre}</b><br>Balance: <b>${u(b.balance)}</b> · P&L: <span class="${c(b.pnl)}">${u(b.pnl)}</span><br>Trades: ${b.trades} · Acierto: ${b.winrate==null?'—':b.winrate+'%'} · ❌ hoy: ${b.perdidas_hoy} · Caída máx: ${b.max_dd}%<br>`+
(b.abiertas.length?b.abiertas.map(o=>`⏳ Abierta: ronda ${o.t} · ${o.lado} a ${o.precio}¢`).join('<br>'):'Sin operación abierta')+
'<div style="margin-top:6px"><b>Últimas 10</b></div>'+(b.ultimas.length?b.ultimas.map(t=>`<div style="font-size:13px;padding:3px 0">${t.t} · ${t.lado} a ${t.precio}¢ · ${t.gano?'✅':'❌'} <span class="${c(t.pnl)}">${u(t.pnl)}</span></div>`).join(''):'<div class="empty" style="padding:8px">Sin operaciones todavía.</div>')+'</div>').join('');
document.getElementById('pmx').innerHTML=h}).catch(()=>{document.getElementById('pmx').textContent='Sin datos todavía.'})}
load();setInterval(load,60000)})();
