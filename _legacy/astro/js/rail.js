// Rail layout behaviour: request tracker, style picker, WAF, tabs and widgets.
    (() => {
      const root = document.documentElement;
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const $ = id => document.getElementById(id);

      // ---------- Theme ----------
      const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      $('themeToggle').addEventListener('click', () => {
        const next = isDark() ? 'light' : 'dark';
        root.dataset.theme = next;
        try { localStorage.setItem('theme', next); localStorage.setItem('style', next === 'dark' ? 'midnight' : 'paper'); } catch (e) {}
      });

      // ---------- Visual style picker ----------
      (() => {
        const btn = $('styleBtn'), menu = $('styleMenu');
        const opts = [...menu.querySelectorAll('.style-opt')];
        const FIXED = ['phosphor', 'blueprint', 'brutalist', 'swiss', 'neon'];
        const current = () => root.dataset.style || (isDark() ? 'midnight' : 'paper');
        const mark = () => opts.forEach(o => o.setAttribute('aria-checked', o.dataset.styleOpt === current()));
        const fopts = [...menu.querySelectorAll('.font-opt')];
        const markFont = () => fopts.forEach(o => o.setAttribute('aria-checked', o.dataset.fontOpt === (root.dataset.font || 'auto')));
        const apply = s => { KIT.setStyle(s); mark(); };
        fopts.forEach(o => o.addEventListener('click', () => { KIT.setFont(o.dataset.fontOpt); markFont(); }));
        markFont();
        const open = on => { menu.classList.toggle('open', on); btn.setAttribute('aria-expanded', on); if (on) { mark(); markFont(); } };
        btn.addEventListener('click', e => { e.stopPropagation(); open(!menu.classList.contains('open')); });
        opts.forEach(o => o.addEventListener('click', () => apply(o.dataset.styleOpt)));
        document.addEventListener('click', e => { if (!menu.contains(e.target)) open(false); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && menu.classList.contains('open')) { open(false); btn.focus(); } });
        mark();
      })();
      $('year').textContent = new Date().getFullYear();

      // ---------- The visitor's own user-agent ----------
      const ua = navigator.userAgent;
      const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'your browser';
      const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
      $('uaVal').textContent = browser + (os ? ' on ' + os : '') + ' (that\'s you)';

      // ---------- Request path: rail, packet, HUD ----------
      const layers = [...document.querySelectorAll('.layer')];
      const railItems = [...document.querySelectorAll('#railList li')];
      const railLinks = railItems.map(li => li.querySelector('a'));
      const lat = layers.map(l => +l.dataset.ms);
      const total = lat.reduce((a, b) => a + b, 0);
      const N = layers.length;
      railItems.forEach((li, i) => li.style.top = (i / (N - 1) * 100) + '%');
      const respMs = $('respMs'); if (respMs) respMs.textContent = total;
      const nav = $('nav'), hud = $('hud');

      let ticking = false;
      function track() {
        ticking = false;
        nav.classList.toggle('scrolled', scrollY > 8);
        const probe = innerHeight * 0.4;
        let i = 0;
        layers.forEach((l, k) => { if (l.getBoundingClientRect().top <= probe) i = k; });
        const top = layers[i].getBoundingClientRect().top;
        const span = i < N - 1 ? layers[i + 1].getBoundingClientRect().top - top : layers[i].offsetHeight;
        let f = Math.min(1, Math.max(0, (probe - top) / span));
        if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) { i = N - 1; f = 1; }
        const p = i >= N - 1 ? 1 : (i + f) / (N - 1);
        $('railFill').style.height = (p * 100) + '%';
        $('railPacket').style.top = `calc(8px + (100% - 16px) * ${p})`;
        railLinks.forEach((a, k) => {
          a.classList.toggle('passed', k < i);
          a.classList.toggle('active', k === i);
          if (k === i) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
        });
        let ms = 0;
        for (let k = 0; k < i; k++) ms += lat[k];
        ms += lat[i] * (i >= N - 1 ? 1 : f);
        const done = i === N - 1;
        $('hudLayer').textContent = layers[i].dataset.name;
        $('hudHop').textContent = `hop ${i}/${N - 1}`;
        $('hudMs').textContent = done ? '200 · ' + total + ' ms' : Math.round(ms) + ' ms';
        hud.classList.toggle('done', done);
        hud.classList.toggle('show', scrollY > innerHeight * 0.35);
      }
      const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(track); } };
      addEventListener('scroll', onScroll, { passive: true });
      addEventListener('resize', onScroll);
      track();

      // ---------- Reveal on scroll ----------
      const io = new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
      }, { threshold: 0.12 });
      document.querySelectorAll('.reveal').forEach(el => io.observe(el));

      // ---------- DNS: stamp the AWS badge when the record resolves ----------
      new IntersectionObserver(([e], obs) => {
        if (e.isIntersecting) { $('digWrap').classList.add('stamped'); obs.disconnect(); }
      }, { threshold: 0.6 }).observe($('digWrap'));

      // ---------- Load balancer: round robin ----------
      (() => {
        const nodes = [...document.querySelectorAll('.node')];
        const wires = [...document.querySelectorAll('.lb-wires path')];
        let k = 0, timer = null, hover = false;
        const show = i => {
          nodes.forEach((n, j) => n.classList.toggle('rr', j === i));
          wires.forEach((w, j) => w.classList.toggle('on', j === i));
        };
        show(0);
        if (reduced) return;
        const tick = () => { if (!hover) { k = (k + 1) % nodes.length; show(k); } };
        nodes.forEach((n, j) => {
          n.addEventListener('mouseenter', () => { hover = true; k = j; show(j); });
          n.addEventListener('mouseleave', () => { hover = false; });
        });
        new IntersectionObserver(([e]) => {
          clearInterval(timer);
          if (e.isIntersecting) timer = setInterval(tick, 1800);
        }).observe($('lbBox'));
      })();

      // ---------- WAF: evaluate rules, block attacks ----------
      (() => {
        const rules = [...document.querySelectorAll('.rule')];
        const req = $('wafReq'), res = $('wafRes');
        const NORMAL = '<span class="verb">GET</span> /yeshasvi';
        let busy = false;
        const setRes = (code, text, blocked) => {
          res.classList.toggle('blocked', !!blocked);
          res.innerHTML = `<span class="code">${code}</span><span>${text}</span>`;
        };
        const passAll = () => rules.forEach(r => { r.className = 'rule pass'; r.querySelector('.verdict').textContent = 'pass'; });
        async function evaluate() {
          for (const r of rules) {
            r.className = 'rule pass'; r.querySelector('.verdict').textContent = 'pass';
            if (!reduced) await new Promise(ok => setTimeout(ok, 220));
          }
          if (!busy) setRes('200', 'all rules passed. You look friendly, carry on ↓');
        }
        new IntersectionObserver(([e], obs) => { if (e.isIntersecting) { evaluate(); obs.disconnect(); } }, { threshold: 0.4 }).observe($('wafBox'));

        function attack(html, ruleKey, code, msg) {
          if (busy) return;
          busy = true;
          passAll();
          req.innerHTML = html;
          const r = rules.find(x => x.dataset.rule === ruleKey);
          r.className = 'rule block'; r.querySelector('.st').textContent = '✕'; r.querySelector('.verdict').textContent = 'BLOCK';
          setRes(code, msg, true);
          setTimeout(() => {
            r.querySelector('.st').textContent = '✓';
            req.innerHTML = NORMAL;
            passAll();
            setRes('200', 'back to normal. You\'re still welcome ↓');
            busy = false;
          }, 2600);
        }
        $('wafSqli').addEventListener('click', () => attack(
          '<span class="verb">GET</span> /yeshasvi?id=<span class="evil">1\' OR \'1\'=\'1\' --</span>',
          'edge', '403', 'Forbidden. SQL injection caught at the edge. Nice try.'));
        $('wafFlood').addEventListener('click', () => attack(
          '<span class="verb">GET</span> /yeshasvi <span class="evil">× 500 req/s</span>',
          'rate', '429', 'Too Many Requests. Slow down, there\'s plenty of me to go around.'));
      })();

      // ---------- Services: tabs ----------
      (() => {
        const tabs = [...document.querySelectorAll('.svc-tab')];
        const select = t => {
          tabs.forEach(o => {
            const on = o === t;
            o.setAttribute('aria-selected', on);
            o.tabIndex = on ? 0 : -1;
            $(o.getAttribute('aria-controls')).hidden = !on;
          });
          $(t.getAttribute('aria-controls')).classList.add('in');
        };
        tabs.forEach((t, i) => {
          t.addEventListener('click', () => select(t));
          t.addEventListener('keydown', e => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            const n = tabs[(i + d + tabs.length) % tabs.length];
            n.focus(); select(n);
          });
        });
      })();

      // ---------- Services: REST vs gRPC model ----------
      (() => {
        const SIZES = [1, 8, 32, 128, 256, 512];
        const RTTS = [0.5, 1, 2, 5, 10, 20];
        const BW = 125;
        const hops = $('gHops'), size = $('gSize'), rtt = $('gRtt'), keep = $('gKeep');
        const fmt = ms => ms < 10 ? ms.toFixed(1) + ' ms' : Math.round(ms).toLocaleString() + ' ms';
        function model() {
          const n = +hops.value, kb = SIZES[size.value], r = RTTS[rtt.value];
          const rest = { conn: keep.checked ? 0 : 3 * r, net: r + kb / BW, ser: kb * 0.02 };
          const grpc = { conn: 0, net: r + (kb * 0.4) / BW, ser: kb * 0.4 * 0.01 };
          const sum = h => (h.conn + h.net + h.ser) * n;
          return { n, kb, r, rest, grpc, restT: sum(rest), grpcT: sum(grpc) };
        }
        function paint(el, hop, n, t, max) {
          el.style.width = (t / max * 100) + '%';
          const per = hop.conn + hop.net + hop.ser;
          let html = '';
          for (let i = 0; i < n; i++) {
            [['conn', hop.conn], ['net', hop.net], ['ser', hop.ser]].forEach(([k, v], j) => {
              if (v <= 0) return;
              html += `<i class="${k}${j === 2 && i < n - 1 ? ' hop-end' : ''}" style="width:${v / per / n * 100}%"></i>`;
            });
          }
          el.innerHTML = html;
        }
        function update() {
          const m = model();
          $('gHopsOut').textContent = m.n;
          $('gSizeOut').textContent = m.kb + ' KB';
          $('gRttOut').textContent = m.r + ' ms';
          $('gRestMs').textContent = fmt(m.restT);
          $('gGrpcMs').textContent = fmt(m.grpcT);
          const max = Math.max(m.restT, m.grpcT);
          paint($('gRestSegs'), m.rest, m.n, m.restT, max);
          paint($('gGrpcSegs'), m.grpc, m.n, m.grpcT, max);
          const x = (m.restT / m.grpcT).toFixed(1);
          const share = Math.round(m.rest.conn * m.n / m.restT * 100);
          $('gVerdict').innerHTML = keep.checked
            ? `gRPC is still <b>${x}× faster</b> here, from smaller payloads and faster serialization. Real HTTP/1.1 also makes parallel calls queue, which this model leaves out.`
            : `gRPC is <b>${x}× faster</b> here, and <b>${share}%</b> of the REST time is spent opening connections.`;
          [$('gRestRun'), $('gGrpcRun')].forEach(r => { r.getAnimations().forEach(a => a.cancel()); r.style.opacity = 0; });
        }
        [hops, size, rtt, keep].forEach(el => el.addEventListener('input', update));
        update();
        $('gRace').addEventListener('click', () => {
          if (reduced) return;
          const m = model(), max = Math.max(m.restT, m.grpcT);
          [['gRestRun', 'gRestSegs', m.restT], ['gGrpcRun', 'gGrpcSegs', m.grpcT]].forEach(([r, s, t]) => {
            const w = $(s).getBoundingClientRect().width;
            $(r).animate(
              [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${Math.max(0, w - 3)}px)`, opacity: 1 }],
              { duration: 2400 * t / max, easing: 'linear', fill: 'forwards' });
          });
        });
      })();

      // ---------- Services: circuit breaker playground ----------
      (() => {
        const svg = document.querySelector('.cb-svg');
        const layer = $('cbPackets'), w1 = $('cb-w1'), w2 = $('cb-w2');
        const L1 = w1.getTotalLength(), L2 = w2.getTotalLength();
        const node = $('cbNode'), down = $('cbDown');
        const NS = 'http://www.w3.org/2000/svg';
        const SPEED = 0.22, TIMEOUT = 900, HEALTHY = 120, OPEN_FOR = 3000, TRIP_AT = 3, SPAWN = 700;
        let mode = 'breaker', isDown = false, state = 'closed', fails = 0, openedAt = 0, trial = false;
        let packets = [], hits = [], waits = [], fast = 0, last = 0, acc = 0, running = false;

        function setState(s, now) {
          state = s;
          if (s === 'open') openedAt = now;
          if (s !== 'half') trial = false;
          node.classList.remove('closed', 'open', 'half');
          if (mode === 'breaker') {
            node.classList.add(s);
            $('cbTitle').textContent = 'breaker';
            $('cbState').textContent = { closed: 'closed', open: 'open · fallback', half: 'half-open · test' }[s];
          } else {
            $('cbTitle').textContent = 'retry ×3';
            $('cbState').textContent = 'no breaker';
          }
        }
        function spawn() {
          const c = document.createElementNS(NS, 'circle');
          c.setAttribute('r', 4); c.setAttribute('class', 'packet');
          layer.appendChild(c);
          packets.push({ el: c, phase: 'out1', d: 0, wait: 0, tries: 0, cost: 0 });
        }
        function finish(p, cls) {
          p.el.setAttribute('class', 'packet ' + cls);
          p.phase = 'back1'; p.d = 0;
          waits.push(p.cost); if (waits.length > 8) waits.shift();
        }
        function result(ok, now) {
          if (mode !== 'breaker') return;
          if (ok) { fails = 0; if (state === 'half') setState('closed', now); }
          else { fails++; if (state === 'half' || fails >= TRIP_AT) setState('open', now); }
        }
        function step(p, dt, now) {
          const move = SPEED * dt;
          switch (p.phase) {
            case 'out1':
              p.d += move;
              if (p.d >= L1) {
                const blocked = mode === 'breaker' && (state === 'open' || (state === 'half' && trial));
                if (blocked) { fast++; p.cost += 2; finish(p, 'fast'); }
                else { if (mode === 'breaker' && state === 'half') trial = true; p.phase = 'out2'; p.d = 0; }
              }
              break;
            case 'out2':
              p.d += move;
              if (p.d >= L2) { p.phase = 'at'; p.wait = isDown ? TIMEOUT : HEALTHY; p.cost += p.wait; p.tries++; hits.push(now); }
              break;
            case 'at':
              p.wait -= dt;
              if (p.wait <= 0) { p.ok = !isDown; p.el.setAttribute('class', 'packet ' + (p.ok ? 'ok' : 'fail')); p.phase = 'back2'; p.d = 0; }
              break;
            case 'back2':
              p.d += move;
              if (p.d >= L2) {
                result(p.ok, now);
                if (!p.ok && mode === 'retry' && p.tries < 3) {
                  p.phase = 'backoff'; p.wait = 150 * p.tries; p.cost += p.wait;
                  p.el.setAttribute('class', 'packet');
                } else finish(p, p.ok ? 'ok' : 'fail');
              }
              break;
            case 'backoff':
              p.wait -= dt;
              if (p.wait <= 0) { p.phase = 'out2'; p.d = 0; }
              break;
            case 'back1':
              p.d += move;
              if (p.d >= L1) { p.el.remove(); return false; }
              break;
          }
          let pt;
          if (p.phase === 'out1') pt = w1.getPointAtLength(Math.min(p.d, L1));
          else if (p.phase === 'back1') pt = w1.getPointAtLength(Math.max(0, L1 - p.d));
          else if (p.phase === 'out2') pt = w2.getPointAtLength(Math.min(p.d, L2));
          else if (p.phase === 'back2') pt = w2.getPointAtLength(Math.max(0, L2 - p.d));
          else if (p.phase === 'at') pt = { x: 468, y: 75 };
          else pt = { x: 260, y: 75 };
          p.el.setAttribute('cx', pt.x); p.el.setAttribute('cy', pt.y);
          return true;
        }
        function frame(now) {
          if (!running) return;
          const dt = Math.min(48, now - (last || now)); last = now;
          acc += dt; if (acc >= SPAWN) { acc = 0; spawn(); }
          if (mode === 'breaker' && state === 'open' && now - openedAt > OPEN_FOR) setState('half', now);
          packets = packets.filter(p => step(p, dt, now));
          hits = hits.filter(t => now - t < 4000);
          $('cbLoad').textContent = (hits.length / 4).toFixed(1) + ' calls/s';
          $('cbWait').textContent = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length).toLocaleString() + ' ms' : '—';
          $('cbFast').textContent = fast.toLocaleString();
          requestAnimationFrame(frame);
        }
        document.querySelectorAll('.seg-ctrl button').forEach(b => b.addEventListener('click', () => {
          mode = b.dataset.mode;
          document.querySelectorAll('.seg-ctrl button').forEach(o => o.setAttribute('aria-checked', o === b));
          fails = 0; waits = []; setState('closed', performance.now());
        }));
        $('cbBreak').addEventListener('click', e => {
          isDown = !isDown;
          e.currentTarget.textContent = isDown ? 'Fix downstream' : 'Break downstream';
          down.classList.toggle('down', isDown);
          $('cbDownState').textContent = isDown ? 'failing' : 'healthy';
        });
        setState('closed', 0);
        new IntersectionObserver(([e]) => {
          const was = running; running = e.isIntersecting;
          if (running && !was) { last = 0; requestAnimationFrame(frame); }
        }).observe(svg);
      })();

      // ---------- Queue: sage terminal replay ----------
      (() => {
        const term = $('sageTerm');
        const chips = [...document.querySelectorAll('.sage-chips .chip')];
        const SCRIPTS = [
          { q: 'why is my disk full',
            cmds: ['df -h /', 'du -sh ~/* 2>/dev/null | sort -rh | head -5'],
            answer: 'Your main disk is **91% full** (419G of 460G used).\n\nThe biggest folder is **~/Library at 182G**, and most of that is Docker: 96G of images and volumes. ~/Downloads is next at 41G.\n\nTo free space safely, run `docker system prune` to remove unused images, then clear out old files in ~/Downloads.' },
          { q: "what's using port 3000",
            cmds: ['lsof -nP -iTCP:3000 -sTCP:LISTEN'],
            answer: '**node** (PID 48211) is listening on port 3000. It started about 2 hours ago from ~/code/web, so it is probably a dev server you left running.\n\nTo stop it: `kill 48211`' },
          { q: 'is postgres running',
            cmds: ['pg_isready', 'ps aux | grep [p]ostgres'],
            answer: '**Yes, PostgreSQL is running** and accepting connections on port 5432.\n\nThere are 7 postgres processes: the main server, its background workers and 2 active client connections. Nothing looks wrong.' },
        ];
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<span class="t-b">$1</span>').replace(/`(.+?)`/g, '<span class="t-cmd">$1</span>');
        // While streaming, close any half-typed ** or ` so markers never flash
        const richPartial = s => {
          if ((s.match(/\*\*/g) || []).length % 2) s += '**';
          if ((s.match(/`/g) || []).length % 2) s += '`';
          return rich(s);
        };
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        let run = 0;
        async function play(i) {
          const id = ++run, s = SCRIPTS[i];
          const live = () => id === run;
          let html = '';
          const put = h => { term.innerHTML = html + h + '<span class="caret"></span>'; term.scrollTop = term.scrollHeight; };
          const add = h => { html += h; put(''); };
          const cmd = `sage "${s.q}"`;
          const prompt = '<span class="t-p">❯</span> ';
          if (reduced) {
            html = prompt + esc(cmd) + '\n<span class="t-dim">◆ figuring out which commands to run…</span>\n  sage wants to run:\n' +
              s.cmds.map(c => '    <span class="t-cmd">$ ' + esc(c) + '</span>').join('\n') +
              '\n  Run these read-only commands? [Y/n] <span class="t-ok">y</span>\n<span class="t-dim">◆ reading the output…</span>\n\n' + rich(s.answer) + '\n\n' + prompt;
            put(''); return;
          }
          add(prompt);
          for (const ch of cmd) { if (!live()) return; add(esc(ch)); await sleep(32); }
          await sleep(350); if (!live()) return;
          add('\n<span class="t-dim">◆ figuring out which commands to run…</span>\n'); await sleep(900); if (!live()) return;
          add('  sage wants to run:\n'); await sleep(250);
          for (const c of s.cmds) { if (!live()) return; add('    <span class="t-cmd">$ ' + esc(c) + '</span>\n'); await sleep(220); }
          add('  Run these read-only commands? [Y/n] '); await sleep(800); if (!live()) return;
          add('<span class="t-ok">y</span>\n<span class="t-dim">◆ reading the output…</span>\n\n'); await sleep(1000); if (!live()) return;
          let buf = '';
          for (const w of s.answer.split(/( |\n)/)) {
            if (!live()) return;
            buf += w; put(richPartial(buf));
            if (w.trim()) await sleep(28);
          }
          html += rich(buf) + '\n\n' + prompt; put('');
        }
        chips.forEach(c => c.addEventListener('click', () => {
          chips.forEach(o => o.setAttribute('aria-selected', o === c));
          play(+c.dataset.q);
        }));
        new IntersectionObserver(([e], obs) => {
          if (e.isIntersecting) { play(0); obs.disconnect(); }
        }, { threshold: 0.4 }).observe(term);
        const copy = $('sageCopy');
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText($('sageInstall').textContent); copy.textContent = 'copied ✓'; }
          catch (e) { copy.textContent = 'select it'; }
          setTimeout(() => copy.textContent = 'copy', 1800);
        });
      })();

      // ---------- Response: copy email ----------
      const copyBtn = $('copyEmail');
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText('workwithyeshasvi@gmail.com'); copyBtn.textContent = 'Copied ✓'; }
        catch (e) { copyBtn.textContent = 'Press ⌘C'; }
        setTimeout(() => copyBtn.textContent = 'Copy email', 1800);
      });
    })();
  
