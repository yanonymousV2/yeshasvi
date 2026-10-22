// Design kit: preferences, font loading, toolbar, shared blocks and widgets.
// Loaded in <head> so the chosen style/font applies before first paint.
(() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const STYLES = [
    ['paper', 'Paper'], ['midnight', 'Midnight'], ['phosphor', 'Phosphor'], ['blueprint', 'Blueprint'],
    ['brutalist', 'Brutalist'], ['swiss', 'Swiss'], ['neon', 'Neon'],
  ];
  const FIXED = ['phosphor', 'blueprint', 'brutalist', 'swiss', 'neon'];
  const FONTS = [
    ['auto', 'Style default'], ['geist', 'Geist + Instrument Serif'], ['fraunces', 'Inter Tight + Fraunces'],
    ['plex', 'IBM Plex family'], ['grotesk', 'Space Grotesk + JetBrains'], ['newsreader', 'Manrope + Newsreader'], ['syne', 'Syne + DM Sans'],
  ];
  // Only one layout ships now (Motion, the homepage). Add entries here to bring the layout switcher back.
  const LAYOUTS = [];
  const FAMILIES = {
    base: ['Geist:wght@400;500;600;700', 'Geist+Mono:wght@400;500;600', 'Instrument+Serif:ital@0;1'],
    phosphor: ['VT323'], blueprint: ['Space+Grotesk:wght@300;400;500;600;700', 'Caveat:wght@600;700'],
    brutalist: ['Archivo:wght@400;500;600;700', 'Archivo+Black'], swiss: ['Inter+Tight:wght@400;500;600;700;800'],
    neon: ['Space+Grotesk:wght@300;400;500;600;700'],
    fraunces: ['Inter+Tight:wght@400;500;600;700', 'JetBrains+Mono:wght@400;500;600', 'Fraunces:ital,wght@0,400;0,600;1,400'],
    plex: ['IBM+Plex+Sans:wght@400;500;600', 'IBM+Plex+Mono:wght@400;500;600', 'IBM+Plex+Serif:ital@1'],
    grotesk: ['Space+Grotesk:wght@300;400;500;600;700', 'JetBrains+Mono:wght@400;500;600'],
    newsreader: ['Manrope:wght@400;500;600;700', 'DM+Mono:wght@400;500', 'Newsreader:ital,wght@0,500;1,400'],
    syne: ['DM+Sans:wght@400;500;700', 'Space+Mono:wght@400;700', 'Syne:wght@500;700;800'],
  };
  const loaded = new Set();
  // Skip families the page already links in <head> (base fonts and the default style's)
  const linked = name => [...document.querySelectorAll('link[href*="fonts.googleapis.com/css2"]')]
    .some(l => new RegExp('family=' + name.replace(/[+]/g, '\\+') + '(?=[:&]|$)').test(l.href));
  function loadFonts(keys) {
    const fams = keys.flatMap(k => FAMILIES[k] || []).filter(f => !loaded.has(f) && !linked(f.split(':')[0]));
    if (!fams.length) return;
    fams.forEach(f => loaded.add(f));
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?' + fams.map(f => 'family=' + f).join('&') + '&display=swap';
    document.head.appendChild(l);
  }

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const currentStyle = () => root.dataset.style || (isDark() ? 'midnight' : 'paper');
  const currentFont = () => root.dataset.font || 'auto';

  function setStyle(s, save = true) {
    if (FIXED.includes(s)) root.dataset.style = s;
    else { delete root.dataset.style; root.dataset.theme = s === 'midnight' ? 'dark' : 'light'; }
    loadFonts(['base', s]);
    if (save) { store.set('style', s); if (!FIXED.includes(s)) store.set('theme', root.dataset.theme); }
  }
  function setFont(f, save = true) {
    if (f && f !== 'auto') root.dataset.font = f; else delete root.dataset.font;
    loadFonts([f]);
    if (save) store.set('font', f || 'auto');
  }

  // Apply preferences before paint (URL params win over saved choices)
  const q = new URLSearchParams(location.search);
  const t = store.get('theme');
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  // Brutalist is the default look until a visitor picks something else
  const DEFAULT_STYLE = 'brutalist';
  const st = q.get('style') || store.get('style') || DEFAULT_STYLE;
  setStyle(st, !!q.get('style'));
  const ft = q.get('font') || store.get('font');
  if (ft) setFont(ft, !!q.get('font'));
  root.classList.add('js');

  const C = () => window.CONTENT;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---------- Toolbar ----------
  function toolbar(layout) {
    const opts = (list, cur) => list.map(([k, n]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${n}</option>`).join('');
    const bar = document.createElement('div');
    bar.className = 'dtb';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Style and font');
    bar.innerHTML = `<b>style</b>
      ${LAYOUTS.length > 1 ? `<label>layout <select data-k="layout">${opts(LAYOUTS, layout)}</select></label>` : ''}
      <label><span class="sr-only">Visual style</span><select data-k="style">${opts(STYLES, currentStyle())}</select></label>
      <label>font <select data-k="font">${opts(FONTS, currentFont())}</select></label>
      <button class="x" type="button" aria-label="Hide style toolbar">✕</button>`;
    const mini = document.createElement('button');
    mini.className = 'dtb-min btn btn-ghost btn-sm';
    mini.type = 'button';
    mini.textContent = 'style ▲';
    bar.querySelector('[data-k="layout"]')?.addEventListener('change', e => {
      const l = LAYOUTS.find(x => x[0] === e.target.value);
      if (l) location.href = l[2];
    });
    bar.querySelector('[data-k="style"]').addEventListener('change', e => setStyle(e.target.value));
    bar.querySelector('[data-k="font"]').addEventListener('change', e => setFont(e.target.value));
    bar.querySelector('.x').addEventListener('click', () => bar.classList.add('hide'));
    mini.addEventListener('click', () => bar.classList.remove('hide'));
    document.body.append(bar, mini);
  }

  // ---------- Shared content blocks (HTML strings) ----------
  const html = {
    dig() {
      const rows = C().dns.records.map(([t, v]) => `<span>yeshasvi.</span>  <span class="c ttl">300 IN </span><span class="t">${t.padEnd(6)}</span> <span class="s">${esc(v)}</span>`).join('\n');
      return `<div class="stamp-wrap"><pre class="dig card"><span class="c">$ dig yeshasvi</span>\n\n<span class="c">;; ANSWER SECTION:</span>\n${rows}\n\n<span class="c">;; Query time: 12 msec</span></pre>
        <a class="stamp" href="${C().credly}" target="_blank" rel="noopener" aria-label="AWS Certified Solutions Architect – Associate. Verify on Credly"><img src="${C().badge}" alt="" width="104" height="104"></a></div>`;
    },
    dnsText: () => C().dns.text.map(p => `<p>${p}</p>`).join(''),
    nodes() {
      return `<div class="nodes">${C().lb.nodes.map(n => `<article class="node card"><div class="node-top"><span>${n.id}</span><span class="hc">● healthy</span></div><h3>${n.title}</h3><p>${n.text}</p>${html.tags(n.tags)}</article>`).join('')}</div>`;
    },
    waf() {
      return `<div class="card w-waf" style="overflow:hidden">
        <div class="waf-req"><code data-req><span class="verb">GET</span> /yeshasvi</code>
          <span style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" type="button" data-sqli>Try SQL injection</button><button class="btn btn-ghost btn-sm" type="button" data-flood>Flood it</button></span></div>
        <ol class="rules">${C().waf.rules.map(r => `<li class="rule" data-rule="${r.key}"><span class="st">✓</span><code>${r.code}</code><p>${r.text}</p><span class="verdict">pass</span></li>`).join('')}</ol>
        <div class="waf-res" data-res aria-live="polite"><span class="code">200</span><span>all rules passed. You look friendly.</span></div></div>`;
    },
    timeline() {
      return `<div class="card timeline">${C().routes.map(r => `<div class="tl-row"><span class="path">${r.path}</span><span class="tl-role">${r.role}<small>${r.where}</small></span><span class="when">${r.when}</span></div>`).join('')}
        <div class="tl-foot"><a class="link" href="${C().linkedin}" target="_blank" rel="noopener">full history on LinkedIn ↗</a></div></div>`;
    },
    wins: w => `<ul class="wins">${w.map(([n, t]) => `<li><span class="num">${esc(n)}</span><span>${t}</span></li>`).join('')}</ul>`,
    tags: t => t.length ? `<div class="tags">${t.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : '',
    chips: c => `<div class="chips3">${c.map(([b, s]) => `<div><b>${esc(b)}</b><span>${s}</span></div>`).join('')}</div>`,
    caseRows: rows => `<dl class="case">${rows.map(([d, t]) => `<div><dt>${d}</dt><dd>${t}</dd></div>`).join('')}</dl>`,
    stack() {
      return `<div class="card" style="overflow:hidden"><pre class="sql"><span class="kw">SELECT</span> category, tools <span class="kw">FROM</span> stack\n<span class="kw">WHERE</span> used_in = <span class="str">'production'</span>;</pre>
        <table class="stack-table"><tbody>${C().stack.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${html.tags(v)}</td></tr>`).join('')}</tbody></table></div>`;
    },
    cert() {
      return `<div class="cert"><img src="${C().badge}" alt="" width="42" height="42"><div><b>${C().cert.title}</b><span>${C().cert.meta} · </span><a class="link" href="${C().credly}" target="_blank" rel="noopener">verify ↗</a></div></div>`;
    },
    json() {
      const c = C();
      return `<pre class="json">{
  <span class="k">"email"</span>:    <a href="mailto:${c.email}">"${c.email}"</a>,
  <span class="k">"linkedin"</span>: <a href="${c.linkedin}" target="_blank" rel="noopener">"${c.linkedinLabel}"</a>,
  <span class="k">"github"</span>:   <a href="${c.github}" target="_blank" rel="noopener">"${c.githubLabel}"</a>,
  <span class="k">"phone"</span>:    <a href="tel:${c.phone}">"${c.phoneLabel}"</a>,
  <span class="k">"location"</span>: "${c.location}"
}</pre>`;
    },
    sageIntro() {
      const s = C().sage;
      return `<div class="install"><code>${esc(s.install)}</code><button class="copy-mini" type="button" data-copy="${esc(s.install)}">copy</button></div>`;
    },
  };

  // ---------- Widgets ----------
  const mount = {};
  // Copy buttons anywhere on the page
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const was = b.textContent;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied ✓'; } catch (err) { b.textContent = 'select it'; }
    setTimeout(() => b.textContent = was, 1600);
  });

  mount.waf = el => {
    const rules = [...el.querySelectorAll('.rule')], req = el.querySelector('[data-req]'), res = el.querySelector('[data-res]');
    let busy = false;
    const setRes = (code, text, bad) => { res.classList.toggle('blocked', !!bad); res.innerHTML = `<span class="code">${code}</span><span>${text}</span>`; };
    function attack(h, key, code, msg) {
      if (busy) return; busy = true;
      req.innerHTML = h;
      const r = rules.find(x => x.dataset.rule === key);
      r.classList.add('block'); r.querySelector('.st').textContent = '✕'; r.querySelector('.verdict').textContent = 'BLOCK';
      setRes(code, msg, true);
      setTimeout(() => {
        r.classList.remove('block'); r.querySelector('.st').textContent = '✓'; r.querySelector('.verdict').textContent = 'pass';
        req.innerHTML = '<span class="verb">GET</span> /yeshasvi'; setRes('200', "back to normal. You're still welcome."); busy = false;
      }, 2600);
    }
    el.querySelector('[data-sqli]').addEventListener('click', () => attack('<span class="verb">GET</span> /yeshasvi?id=<span class="evil">1\' OR \'1\'=\'1\' --</span>', 'edge', '403', 'Forbidden. SQL injection caught at the edge.'));
    el.querySelector('[data-flood]').addEventListener('click', () => attack('<span class="verb">GET</span> /yeshasvi <span class="evil">× 500 req/s</span>', 'rate', '429', 'Too Many Requests. Slow down.'));
  };

  mount.lb = el => {
    const nodes = [...el.querySelectorAll('.node')];
    let k = 0, timer, hover = false;
    const show = i => nodes.forEach((n, j) => n.classList.toggle('rr', j === i));
    show(0);
    if (reduced) return;
    nodes.forEach((n, j) => { n.addEventListener('mouseenter', () => { hover = true; show(k = j); }); n.addEventListener('mouseleave', () => hover = false); });
    new IntersectionObserver(([e]) => { clearInterval(timer); if (e.isIntersecting) timer = setInterval(() => { if (!hover) show(k = (k + 1) % nodes.length); }, 1800); }).observe(el);
  };

  mount.grpc = el => {
    el.classList.add('w-grpc');
    el.innerHTML = `<div class="ctrls">
        <label class="ctrl"><span>Service hops <output data-o="hops">4</output></span><input type="range" data-i="hops" min="1" max="8" value="4"></label>
        <label class="ctrl"><span>Payload <output data-o="size">32 KB</output></span><input type="range" data-i="size" min="0" max="5" value="2"></label>
        <label class="ctrl"><span>Round trip <output data-o="rtt">2 ms</output></span><input type="range" data-i="rtt" min="0" max="5" value="2"></label>
        <label class="toggle"><input type="checkbox" data-i="keep"><span class="toggle-ui"></span>REST keep-alive</label>
      </div>
      <div class="lanes">
        <div><div class="lane-head"><b>REST</b><span>JSON · HTTP/1.1</span><output class="lane-ms" data-o="rest">0 ms</output></div><div class="track"><div class="segs" data-s="rest"></div><i class="runner" data-r="rest"></i></div></div>
        <div><div class="lane-head"><b>gRPC</b><span>protobuf · HTTP/2</span><output class="lane-ms" data-o="grpc">0 ms</output></div><div class="track"><div class="segs" data-s="grpc"></div><i class="runner" data-r="grpc"></i></div></div>
      </div>
      <div class="w-foot"><div class="legend-row"><span><i class="sw sw-conn"></i>connection setup</span><span><i class="sw sw-net"></i>network</span><span><i class="sw sw-ser"></i>serialization</span></div><button class="btn btn-ghost btn-sm" type="button" data-race>Race ▶</button></div>
      <p class="verdict-line" data-o="verdict" aria-live="polite"></p>
      <p class="note">A simplified model, not production data. Assumes a 1 Gbps link, JSON about 2.5× the size of protobuf, and a TCP + TLS handshake of 3 round trips when connections aren't reused.</p>`;
    const $ = (a, k) => el.querySelector(`[data-${a}="${k}"]`);
    const SIZES = [1, 8, 32, 128, 256, 512], RTTS = [0.5, 1, 2, 5, 10, 20], BW = 125;
    const fmt = ms => ms < 10 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms';
    function model() {
      const n = +$('i', 'hops').value, kb = SIZES[$('i', 'size').value], r = RTTS[$('i', 'rtt').value];
      const rest = { conn: $('i', 'keep').checked ? 0 : 3 * r, net: r + kb / BW, ser: kb * 0.02 };
      const grpc = { conn: 0, net: r + (kb * 0.4) / BW, ser: kb * 0.4 * 0.01 };
      const sum = h => (h.conn + h.net + h.ser) * n;
      return { n, kb, r, rest, grpc, restT: sum(rest), grpcT: sum(grpc) };
    }
    function paint(seg, hop, n, t, max) {
      seg.style.width = (t / max * 100) + '%';
      const per = hop.conn + hop.net + hop.ser;
      let h = '';
      for (let i = 0; i < n; i++) [['conn', hop.conn], ['net', hop.net], ['ser', hop.ser]].forEach(([k, v], j) => {
        if (v > 0) h += `<i class="${k}${j === 2 && i < n - 1 ? ' hop-end' : ''}" style="width:${v / per / n * 100}%"></i>`;
      });
      seg.innerHTML = h;
    }
    function update() {
      const m = model(), max = Math.max(m.restT, m.grpcT);
      $('o', 'hops').textContent = m.n; $('o', 'size').textContent = m.kb + ' KB'; $('o', 'rtt').textContent = m.r + ' ms';
      $('o', 'rest').textContent = fmt(m.restT); $('o', 'grpc').textContent = fmt(m.grpcT);
      paint($('s', 'rest'), m.rest, m.n, m.restT, max); paint($('s', 'grpc'), m.grpc, m.n, m.grpcT, max);
      const x = (m.restT / m.grpcT).toFixed(1), share = Math.round(m.rest.conn * m.n / m.restT * 100);
      $('o', 'verdict').innerHTML = $('i', 'keep').checked
        ? `gRPC is still <b>${x}× faster</b> here, from smaller payloads and faster serialization. Real HTTP/1.1 also makes parallel calls queue, which this model leaves out.`
        : `gRPC is <b>${x}× faster</b> here, and <b>${share}%</b> of the REST time is spent opening connections.`;
      el.querySelectorAll('.runner').forEach(r => { r.getAnimations().forEach(a => a.cancel()); r.style.opacity = 0; });
    }
    el.querySelectorAll('[data-i]').forEach(i => i.addEventListener('input', update));
    update();
    el.querySelector('[data-race]').addEventListener('click', () => {
      if (reduced) return;
      const m = model(), max = Math.max(m.restT, m.grpcT);
      [['rest', m.restT], ['grpc', m.grpcT]].forEach(([k, t]) => {
        const w = $('s', k).getBoundingClientRect().width;
        $('r', k).animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${Math.max(0, w - 3)}px)`, opacity: 1 }], { duration: 2400 * t / max, easing: 'linear', fill: 'forwards' });
      });
    });
  };

  mount.cb = el => {
    el.classList.add('w-cb');
    el.innerHTML = `<div class="w-foot"><div class="seg-ctrl" role="radiogroup" aria-label="Failure strategy"><button type="button" role="radio" aria-checked="false" data-mode="retry">Retries only</button><button type="button" role="radio" aria-checked="true" data-mode="breaker">Circuit breaker</button></div><button class="btn btn-primary btn-sm" type="button" data-break>Break downstream</button></div>
      <svg class="cb-svg" viewBox="0 0 520 150" aria-hidden="true"><path class="sys-wire" data-w="1" d="M96,75 L192,75"/><path class="sys-wire" data-w="2" d="M328,75 L424,75"/><g data-pk></g>
        <g class="sys-node"><rect x="8" y="50" width="88" height="50" rx="10"/><text x="52" y="80" text-anchor="middle">client</text></g>
        <g class="sys-node cb-breaker" data-node><rect x="192" y="44" width="136" height="62" rx="10"/><text x="260" y="70" text-anchor="middle" data-title>breaker</text><text class="subt" x="260" y="88" text-anchor="middle" data-state>closed</text></g>
        <g class="sys-node cb-down" data-down><rect x="424" y="50" width="88" height="50" rx="10"/><text x="468" y="73" text-anchor="middle">service</text><text class="subt" x="468" y="89" text-anchor="middle" data-dstate>healthy</text></g></svg>
      <div class="cb-stats"><div><span>Load on downstream</span><b data-load>0 calls/s</b></div><div><span>Average user wait</span><b data-wait>—</b></div><div><span>Answered with fallback</span><b data-fast>0</b></div></div>
      <p class="note">Each call times out after 900 ms. Retries try 3 times with backoff. The breaker opens after 3 failures in a row, then sends one test request after 3 seconds.</p>`;
    const q1 = s => el.querySelector(s);
    const svg = q1('svg'), layer = q1('[data-pk]'), w1 = q1('[data-w="1"]'), w2 = q1('[data-w="2"]'), node = q1('[data-node]'), down = q1('[data-down]');
    const L1 = w1.getTotalLength(), L2 = w2.getTotalLength(), NS = 'http://www.w3.org/2000/svg';
    const SPEED = 0.22, TIMEOUT = 900, HEALTHY = 120, OPEN_FOR = 3000, TRIP_AT = 3, SPAWN = 700;
    let mode = 'breaker', isDown = false, state = 'closed', fails = 0, openedAt = 0, trial = false;
    let packets = [], hits = [], waits = [], fast = 0, last = 0, acc = 0, running = false;
    function setState(s, now) {
      state = s; if (s === 'open') openedAt = now; if (s !== 'half') trial = false;
      node.classList.remove('closed', 'open', 'half');
      if (mode === 'breaker') { node.classList.add(s); q1('[data-title]').textContent = 'breaker'; q1('[data-state]').textContent = { closed: 'closed', open: 'open · fallback', half: 'half-open · test' }[s]; }
      else { q1('[data-title]').textContent = 'retry ×3'; q1('[data-state]').textContent = 'no breaker'; }
    }
    function finish(p, cls) { p.el.setAttribute('class', 'packet ' + cls); p.phase = 'back1'; p.d = 0; waits.push(p.cost); if (waits.length > 8) waits.shift(); }
    function result(ok, now) {
      if (mode !== 'breaker') return;
      if (ok) { fails = 0; if (state === 'half') setState('closed', now); }
      else { fails++; if (state === 'half' || fails >= TRIP_AT) setState('open', now); }
    }
    function step(p, dt, now) {
      const mv = SPEED * dt;
      switch (p.phase) {
        case 'out1': p.d += mv; if (p.d >= L1) {
          if (mode === 'breaker' && (state === 'open' || (state === 'half' && trial))) { fast++; p.cost += 2; finish(p, 'fast'); }
          else { if (mode === 'breaker' && state === 'half') trial = true; p.phase = 'out2'; p.d = 0; } } break;
        case 'out2': p.d += mv; if (p.d >= L2) { p.phase = 'at'; p.wait = isDown ? TIMEOUT : HEALTHY; p.cost += p.wait; p.tries++; hits.push(now); } break;
        case 'at': p.wait -= dt; if (p.wait <= 0) { p.ok = !isDown; p.el.setAttribute('class', 'packet ' + (p.ok ? 'ok' : 'fail')); p.phase = 'back2'; p.d = 0; } break;
        case 'back2': p.d += mv; if (p.d >= L2) { result(p.ok, now);
          if (!p.ok && mode === 'retry' && p.tries < 3) { p.phase = 'backoff'; p.wait = 150 * p.tries; p.cost += p.wait; p.el.setAttribute('class', 'packet'); }
          else finish(p, p.ok ? 'ok' : 'fail'); } break;
        case 'backoff': p.wait -= dt; if (p.wait <= 0) { p.phase = 'out2'; p.d = 0; } break;
        case 'back1': p.d += mv; if (p.d >= L1) { p.el.remove(); return false; } break;
      }
      const pt = p.phase === 'out1' ? w1.getPointAtLength(Math.min(p.d, L1)) : p.phase === 'back1' ? w1.getPointAtLength(Math.max(0, L1 - p.d))
        : p.phase === 'out2' ? w2.getPointAtLength(Math.min(p.d, L2)) : p.phase === 'back2' ? w2.getPointAtLength(Math.max(0, L2 - p.d))
        : p.phase === 'at' ? { x: 468, y: 75 } : { x: 260, y: 75 };
      p.el.setAttribute('cx', pt.x); p.el.setAttribute('cy', pt.y);
      return true;
    }
    function frame(now) {
      if (!running) return;
      const dt = Math.min(48, now - (last || now)); last = now;
      acc += dt;
      if (acc >= SPAWN) {
        acc = 0;
        const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', 4); c.setAttribute('class', 'packet'); layer.appendChild(c);
        packets.push({ el: c, phase: 'out1', d: 0, wait: 0, tries: 0, cost: 0 });
      }
      if (mode === 'breaker' && state === 'open' && now - openedAt > OPEN_FOR) setState('half', now);
      packets = packets.filter(p => step(p, dt, now));
      hits = hits.filter(t => now - t < 4000);
      q1('[data-load]').textContent = (hits.length / 4).toFixed(1) + ' calls/s';
      q1('[data-wait]').textContent = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) + ' ms' : '—';
      q1('[data-fast]').textContent = fast;
      requestAnimationFrame(frame);
    }
    el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      mode = b.dataset.mode; el.querySelectorAll('[data-mode]').forEach(o => o.setAttribute('aria-checked', o === b));
      fails = 0; waits = []; setState('closed', performance.now());
    }));
    q1('[data-break]').addEventListener('click', e => {
      isDown = !isDown; e.currentTarget.textContent = isDown ? 'Fix downstream' : 'Break downstream';
      down.classList.toggle('down', isDown); q1('[data-dstate]').textContent = isDown ? 'failing' : 'healthy';
    });
    setState('closed', 0);
    new IntersectionObserver(([e]) => { const was = running; running = e.isIntersecting; if (running && !was) { last = 0; requestAnimationFrame(frame); } }).observe(svg);
  };

  mount.sage = el => {
    el.classList.add('w-sage');
    el.innerHTML = `<div class="chips" role="tablist" aria-label="Example questions">
        <button type="button" role="tab" class="chip" data-q="0" aria-selected="true">why is my disk full</button>
        <button type="button" role="tab" class="chip" data-q="1" aria-selected="false">what's using port 3000</button>
        <button type="button" role="tab" class="chip" data-q="2" aria-selected="false">is postgres running</button></div>
      <div class="term-win"><div class="term-bar"><i></i><i></i><i></i><span>~ — zsh</span></div><pre class="term-body" aria-live="polite"></pre></div>
      <p class="note">A replay with sample output. When you run it, sage answers from your own machine's data.</p>`;
    const term = el.querySelector('.term-body'), chips = [...el.querySelectorAll('.chip')];
    const S = [
      { q: 'why is my disk full', cmds: ['df -h /', 'du -sh ~/* 2>/dev/null | sort -rh | head -5'],
        a: 'Your main disk is **91% full** (419G of 460G used).\n\nThe biggest folder is **~/Library at 182G**, and most of that is Docker: 96G of images and volumes.\n\nTo free space safely, run `docker system prune` to remove unused images.' },
      { q: "what's using port 3000", cmds: ['lsof -nP -iTCP:3000 -sTCP:LISTEN'],
        a: '**node** (PID 48211) is listening on port 3000. It started about 2 hours ago from ~/code/web, so it is probably a dev server you left running.\n\nTo stop it: `kill 48211`' },
      { q: 'is postgres running', cmds: ['pg_isready', 'ps aux | grep [p]ostgres'],
        a: '**Yes, PostgreSQL is running** and accepting connections on port 5432.\n\nThere are 7 postgres processes and 2 active client connections. Nothing looks wrong.' },
    ];
    const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<span class="t-b">$1</span>').replace(/`(.+?)`/g, '<span class="t-cmd">$1</span>');
    const partial = s => { if ((s.match(/\*\*/g) || []).length % 2) s += '**'; if ((s.match(/`/g) || []).length % 2) s += '`'; return rich(s); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let run = 0;
    async function play(i) {
      const id = ++run, s = S[i], live = () => id === run;
      let h = '';
      const put = x => { term.innerHTML = h + x + '<span class="caret"></span>'; term.scrollTop = term.scrollHeight; };
      const add = x => { h += x; put(''); };
      const P = '<span class="t-p">❯</span> ', cmd = `sage "${s.q}"`;
      const plan = '\n<span class="t-dim">◆ figuring out which commands to run…</span>\n  sage wants to run:\n' + s.cmds.map(c => '    <span class="t-cmd">$ ' + esc(c) + '</span>').join('\n') + '\n  Run these read-only commands? [Y/n] <span class="t-ok">y</span>\n<span class="t-dim">◆ reading the output…</span>\n\n';
      if (reduced) { h = P + esc(cmd) + plan + rich(s.a) + '\n\n' + P; put(''); return; }
      add(P);
      for (const ch of cmd) { if (!live()) return; add(esc(ch)); await sleep(32); }
      await sleep(700); if (!live()) return;
      add(plan); await sleep(1100); if (!live()) return;
      let buf = '';
      for (const w of s.a.split(/( |\n)/)) { if (!live()) return; buf += w; put(partial(buf)); if (w.trim()) await sleep(28); }
      h += rich(buf) + '\n\n' + P; put('');
    }
    chips.forEach(c => c.addEventListener('click', () => { chips.forEach(o => o.setAttribute('aria-selected', o === c)); play(+c.dataset.q); }));
    new IntersectionObserver(([e], obs) => { if (e.isIntersecting) { play(0); obs.disconnect(); } }, { threshold: 0.3 }).observe(term);
  };

  window.KIT = { toolbar, html, mount, esc, reduced, setStyle, setFont, currentStyle, currentFont, STYLES, FONTS, LAYOUTS };
})();
