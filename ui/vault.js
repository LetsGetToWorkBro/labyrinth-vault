/* ============================================================================
   LABYRINTH VAULT — front-end concept
   ----------------------------------------------------------------------------
   A runnable prototype of the interface for the offline half of the project.
   Open ui/index.html from disk. It makes no network requests of any kind: no
   fonts, no images, no analytics, nothing to configure and nothing to leak.

   What is real here: the interaction design. The scroll gate on the
   confirmation screen, the hold-to-sign commitment, the out-of-order frame
   acquisition, the refusal states and the fact that they have exactly one
   button — those behave the way the shipped app should behave, and they are
   the point of the artefact.

   What is staged here: the data. Transactions, addresses and frame streams are
   fixtures. Two things are visibly stubbed and marked as such at their
   definitions — the QR module matrix (a structural stand-in, not an encoder)
   and the camera (a viewfinder, not getUserMedia). Wiring either to the real
   thing is a swap at one function, and the interface does not change.

   The rules that come from the repository rather than from taste:

     - No price. The vault has no network, so it cannot know what a coin is
       worth, and a figure it cannot verify has no business next to one it can.
       The screen says so out loud rather than leaving a suspicious gap.
     - No balance as the headline. This device does not manage money.
     - Refusals have no way past them. See src/keys/psbt.ts: an output claiming
       to be change that pays elsewhere, and a transaction that will not say
       what its fee is, are fatal. So there is no "continue anyway" in here,
       and adding one would be the bug.
     - What is displayed is what is signed. The gate hands a digest of the
       summary to the signing step, mirroring signPsbt's contract.
   ========================================================================== */

(function () {
  'use strict';

  /* ==========================================================================
     FIXTURES
     The unsigned transaction a compromised companion has just handed us. The
     numbers are internally consistent: in = out + fee, and the rate matches
     the vsize, because a demo that does not add up teaches the wrong reflexes.
     ====================================================================== */

  var TX = {
    send:    '0.482731',
    fee:     '0.000142',
    change:  '0.317891',
    total:   '0.800764',
    inputs:  3,
    outputs: 2,
    vsize:   208,
    satvb:   68,
    feeShare: '0.03%',
    to:      'bc1q7k9x2t4vlqz8m3n0d5r6sgu9hj2wf4paeyc3lz',
    changeTo:'bc1q9m4v0xr2ekstd7q5c3jag8huw6zfn2ypl4v0d3',
    changePath: "m/84'/0'/0'/1/17",
    digest:  '9f2a1c04e7b83d5619ac0f42d8e7135b',
    txid:    'c1d0a4f7e2b95836aa41c07d9e3f5b28d6407e1ac83b95f2e0d7461bc9a35f80'
  };

  var VAULT = {
    id: '•••• •••• 7F21',
    fingerprint: '7F21A9C4',
    xpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wnrGmqRjTnAoyzYaGrBqRPRDULoZv5ovbaAtCXKLQ7kFznKrJ8m3rTfQeVsn2Kh4',
    btcPath: "m/84'/0'/0'",
    xmrAddress: '4AdUndXHHZ9pfQj27iMAjAPrXnYLTvrhSFDPbvGnRcDvKZLdWjHnyaJ7ecvHDkTMSUEcbLdvBqAcRmzJnEr8Ftk3PbLwGzJ',
    xmrView: 'f3a41c8b2d905e6718bc4a03df82e5719ad06b34c8f2519e7d0a64b3c8215e09'
  };

  /* ==========================================================================
     PRIMITIVES
     ====================================================================== */

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /** Deterministic 32-bit hash. Used only to make stubbed visuals stable
   *  across reloads — never for anything a signature depends on. */
  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  /* --------------------------------------------------------------------------
     QR — STUB.

     This draws a module matrix with correct QR anatomy (finders, separators,
     timing, alignment, quiet zone) and fills the data region from a hash of
     the payload, so every distinct frame produces a distinct, stable pattern
     and the presentation can be designed honestly at real module density.

     It is not an encoder and the codes do not decode. The shipped app renders
     the same component from the real `LV1:` frames that src/airgap/envelope.ts
     already produces; only `modules()` changes.
     ---------------------------------------------------------------------- */

  function modules(payload, n) {
    var grid = [], y, x;
    for (y = 0; y < n; y++) { grid[y] = []; for (x = 0; x < n; x++) grid[y][x] = 0; }

    /* A finder plus its separator: the 7×7 eye, and the one-module quiet ring
       around it that keeps the eye distinguishable from the data. */
    function finder(oy, ox) {
      for (var dy = -1; dy <= 7; dy++) for (var dx = -1; dx <= 7; dx++) {
        var yy = oy + dy, xx = ox + dx;
        if (yy < 0 || xx < 0 || yy >= n || xx >= n) continue;
        var separator = (dy < 0 || dy > 6 || dx < 0 || dx > 6);
        var ring = (dy === 0 || dy === 6 || dx === 0 || dx === 6);
        var core = (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4);
        grid[yy][xx] = (!separator && (ring || core) ? 1 : 0) | 2; // 2 = reserved
      }
    }
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

    for (var i = 8; i < n - 8; i++) {
      grid[6][i] = (i % 2 === 0 ? 1 : 0) | 2;
      grid[i][6] = (i % 2 === 0 ? 1 : 0) | 2;
    }

    var ay = n - 9, ax = n - 9;
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
      var on = (Math.abs(dy) === 2 || Math.abs(dx) === 2 || (dy === 0 && dx === 0));
      grid[ay + dy][ax + dx] = (on ? 1 : 0) | 2;
    }

    var seed = hash32(payload), bits = seed;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      if (grid[y][x] & 2) { grid[y][x] &= 1; continue; }
      if (bits === 0) bits = hash32(payload + ':' + y + ':' + x) | 1;
      grid[y][x] = bits & 1;
      bits >>>= 1;
    }
    return grid;
  }

  /** Runs of adjacent dark modules become one rect: a 45×45 code is 2000
   *  nodes drawn naively and a few hundred drawn this way. */
  function qr(payload, n) {
    n = n || 45;
    var g = modules(payload, n), q = 2, out = '';
    for (var y = 0; y < n; y++) {
      var x = 0;
      while (x < n) {
        if (!g[y][x]) { x++; continue; }
        var w = 0;
        while (x + w < n && g[y][x + w]) w++;
        out += '<rect x="' + (x + q) + '" y="' + (y + q) + '" width="' + w + '" height="1"/>';
        x += w;
      }
    }
    return '<svg viewBox="0 0 ' + (n + q * 2) + ' ' + (n + q * 2) + '" fill="#08080a">' + out + '</svg>';
  }

  /** The labyrinth: a right-angle involute, drawn as one continuous path from
   *  the outside to a single centre. Used as architecture — watermark, scan
   *  assembly, entropy resolution — never as a picture of a maze. */
  function labyrinthPath(size, turns, step) {
    var c = size / 2, x = c, y = c, d = step, p = 'M ' + c + ' ' + c;
    for (var i = 0; i < turns; i++) {
      x += d; p += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
      y -= d; p += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
      d += step;
      x -= d; p += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
      y += d; p += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
      d += step;
    }
    return p;
  }

  function glyph(size, turns, step, width, cls) {
    return '<svg class="glyph ' + (cls || '') + '" viewBox="0 0 ' + size + ' ' + size + '" width="100%">' +
      '<path d="' + labyrinthPath(size, turns, step) + '" stroke-width="' + width + '"/></svg>';
  }

  /** An address set for comparison rather than for reading. Grouped in fours;
   *  the head and tail carry weight because those are the characters a
   *  substitution attack tries hardest to make look familiar. */
  function address(a) {
    var groups = a.match(/.{1,4}/g) || [];
    return groups.map(function (g, i) {
      var edge = i < 2 || i >= groups.length - 2;
      return edge ? '<b>' + g + '</b>' : g;
    }).join(' ');
  }

  function shuffled(n) {
    var a = [], i, j, t;
    for (i = 1; i <= n; i++) a.push(i);
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* Timers owned by the current screen, cleared on every navigation so a
     half-finished scan cannot keep ticking behind another screen. */
  var timers = [];
  function after(fn, ms)   { var t = setTimeout(fn, ms); timers.push(t); return t; }
  function every(fn, ms)   { var t = setInterval(fn, ms); timers.push(t); return t; }
  function clearTimers()   { timers.forEach(clearTimeout); timers.forEach(clearInterval); timers = []; }

  /* ==========================================================================
     CHROME
     ====================================================================== */

  function bar(state) {
    var airgap = state === 'none'
      ? '<div class="airgap airgap--none"><span class="airgap__dot"></span>AIRGAP&nbsp; UNVERIFIED</div>'
      : state === 'quiet' ? ''
      : '<div class="airgap"><span class="airgap__dot"></span>AIRGAP&nbsp; VERIFIED</div>';
    return '<header class="statusbar">' +
      '<div class="statusbar__mark"><b>LABYRINTH</b><span>VAULT</span></div>' + airgap +
    '</header>';
  }

  function primary(label, hint, act) {
    return '<button class="control control--primary" data-go="' + act + '">' +
      '<span>' + label + '</span><span class="control__hint">' + (hint || '') + '</span></button>';
  }
  function control(label, hint, act, cls) {
    return '<button class="control ' + (cls || '') + '" data-go="' + act + '">' +
      '<span>' + label + '</span><span class="control__hint">' + (hint || '') + '</span></button>';
  }
  function field(k, v, mod) {
    return '<div class="field"><span class="field__k">' + k + '</span>' +
      '<span class="field__v ' + (mod || '') + '">' + v + '</span></div>';
  }

  /* ==========================================================================
     SCREENS
     ====================================================================== */

  var S = {};

  /* --- boot ---------------------------------------------------------------- */

  S.splash = {
    group: 'Boot', name: 'Splash',
    render: function () {
      return '<div class="screen" style="justify-content:center;align-items:center;position:relative">' +
        '<div style="position:absolute;inset:0;display:grid;place-items:center;opacity:.10">' +
          '<div style="width:150%">' + glyph(300, 9, 13, 1) + '</div>' +
        '</div>' +
        '<div class="enter" style="position:relative;text-align:center">' +
          '<div style="font-size:26px;font-weight:600;letter-spacing:.36em;margin-left:.36em">LABYRINTH</div>' +
          '<div class="label" style="margin-top:14px">VAULT&nbsp; ·&nbsp; OFFLINE SIGNER</div>' +
        '</div>' +
        '<div class="label" style="position:absolute;bottom:46px">NO NETWORK INTERFACE PRESENT</div>' +
      '</div>';
    },
    mount: function () { after(function () { go('declaration'); }, 2100); }
  };

  /* --- onboarding ---------------------------------------------------------- */

  S.declaration = {
    group: 'Onboarding', name: 'This phone is now a vault',
    render: function () {
      return '<div class="screen">' + bar('quiet') +
        '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center">' +
          '<div class="enter">' +
            '<h1 class="statement statement--mega">THIS PHONE<br>IS NOW<br>A VAULT.</h1>' +
            '<hr class="rule" style="margin:36px 0 24px">' +
            '<p class="prose">It will hold keys and give signatures. It will not hold money, ' +
            'watch a balance, or reach a network. Those belong to the device in your pocket, ' +
            'and that device is never trusted with a key.</p>' +
          '</div>' +
        '</div>' +
        '<div class="foot">' + primary('BEGIN', 'STEP 1 / 5', 'radios') + '</div>' +
      '</div>';
    }
  };

  S.radios = {
    group: 'Onboarding', name: 'Sever the radios',
    render: function () {
      var items = [
        ['REMOVE SIM', 'Physically. The tray, not a setting.'],
        ['DISABLE WI-FI', 'In Settings, not Control Centre.'],
        ['DISABLE BLUETOOTH', 'Including sharing and nearby devices.'],
        ['DISABLE CELLULAR', 'Data and voice.'],
        ['VERIFY IN SETTINGS', 'The vault requests no network permission. Confirm it has none.']
      ];
      return '<div class="screen">' + bar('none') +
        '<div class="body pad">' +
          '<h1 class="statement" style="margin:20px 0 8px">SEVER<br>THE RADIOS.</h1>' +
          '<p class="prose" style="margin-bottom:30px">Each of these is yours to do. The vault ' +
          'cannot turn a radio off for you — it can only refuse to ask for one.</p>' +
          '<div class="stack">' + items.map(function (it, i) {
            return '<label class="check" data-check style="cursor:pointer;align-items:flex-start;padding:16px 0">' +
              '<span class="check__mark" style="margin-top:1px">✓</span>' +
              '<span><span style="display:block;font-size:12px;letter-spacing:.12em">' + it[0] + '</span>' +
              '<span style="display:block;margin-top:5px;font-size:11px;color:var(--paper-faint);letter-spacing:0">' + it[1] + '</span></span>' +
              '<span style="margin-left:auto;font-size:9px;color:var(--paper-ghost)">0' + (i + 1) + '</span></label>';
          }).join('') + '</div>' +
          '<div style="height:24px"></div>' +
        '</div>' +
        '<div class="foot"><button class="control control--primary" data-arm disabled>' +
          '<span>VERIFY AIRGAP</span><span class="control__hint" data-count>0 / 5</span></button></div>' +
      '</div>';
    },
    mount: function (root) {
      var done = 0;
      $$('[data-check]', root).forEach(function (row) {
        row.addEventListener('click', function () {
          if (row.classList.contains('is-on')) return;
          row.classList.add('is-on');
          done++;
          $('[data-count]', root).textContent = done + ' / 5';
          if (done === 5) {
            var b = $('[data-arm]', root);
            b.disabled = false;
            b.addEventListener('click', function () { go('airgap'); });
          }
        });
      });
    }
  };

  S.airgap = {
    group: 'Onboarding', name: 'Airgap verification',
    render: function () {
      return '<div class="screen">' + bar('none') +
        '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center">' +
          '<div class="eyebrow">VERIFYING</div>' +
          '<div style="margin:22px 0 34px">' +
            '<div class="statement" data-headline style="font-size:44px">NETWORK<br>ACCESS</div>' +
            '<div class="readout" data-verdict style="margin-top:18px;color:var(--paper-ghost)">— — —</div>' +
          '</div>' +
          '<div class="stack" data-probes></div>' +
        '</div>' +
        '<div class="foot"><button class="control control--primary" data-next disabled>' +
          '<span>CONTINUE</span><span class="control__hint" data-hint>VERIFYING</span></button></div>' +
      '</div>';
    },
    mount: function (root) {
      var probes = [
        ['WI-FI INTERFACE', 'DOWN'], ['CELLULAR RADIO', 'DOWN'], ['BLUETOOTH STACK', 'DOWN'],
        ['NETWORK ENTITLEMENT', 'NOT REQUESTED'], ['LINKED SOCKETS', 'NONE'],
        ['CLOUD CONTAINER', 'NONE'], ['ACCOUNT SESSION', 'NONE']
      ];
      var host = $('[data-probes]', root), i = 0;
      var tick = every(function () {
        if (i >= probes.length) {
          clearInterval(tick);
          $('[data-verdict]', root).textContent = 'NONE';
          $('[data-verdict]', root).style.color = 'var(--signal)';
          var b = $('[data-next]', root);
          b.disabled = false;
          $('[data-hint]', root).textContent = 'VERIFIED';
          b.addEventListener('click', function () { go('boundary'); });
          return;
        }
        var p = probes[i++];
        var row = document.createElement('div');
        row.className = 'field enter';
        row.innerHTML = '<span class="field__k">' + p[0] + '</span>' +
                        '<span class="field__v field__v--good">' + p[1] + '</span>';
        host.appendChild(row);
      }, 340);
    }
  };

  S.boundary = {
    group: 'Onboarding', name: 'Security boundary',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center;position:relative">' +
          '<div class="watermark" style="inset:auto -40% -10% auto;width:150%">' + glyph(300, 8, 15, 1) + '</div>' +
          '<div style="position:relative">' +
            '<div class="eyebrow">SECURITY BOUNDARY</div>' +
            '<h1 class="statement statement--mega" style="margin:18px 0 30px">THIS<br>DEVICE.</h1>' +
            '<hr class="rule rule--heavy">' +
            '<p class="prose" style="margin-top:22px">Everything inside this phone is trusted. ' +
            'Everything outside it — the companion, the desktop wallet, the QR code you are ' +
            'about to scan — is not, and is not required to be.</p>' +
            '<p class="prose" style="margin-top:14px;color:var(--paper)">You are the last check ' +
            'on the boundary. The vault will show you what it is about to sign, in full, every time.</p>' +
          '</div>' +
        '</div>' +
        '<div class="foot">' + primary('GENERATE KEYS', 'STEP 4 / 5', 'entropy') + '</div>' +
      '</div>';
    }
  };

  S.entropy = {
    group: 'Onboarding', name: 'Key generation',
    render: function () {
      return '<div class="screen">' + bar('quiet') +
        '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center">' +
          '<canvas class="entropy" data-canvas width="700" height="700"></canvas>' +
          '<div style="margin-top:34px">' +
            '<div class="statement" style="font-size:34px">GENERATING<br>KEY MATERIAL</div>' +
            '<div class="field" style="margin-top:24px;border-bottom-color:var(--rule)">' +
              '<span class="field__k">ENTROPY COLLECTED</span>' +
              '<span class="field__v" data-bits>0 / 256 BITS</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="foot" style="text-align:center">' +
          '<div class="label" style="color:var(--paper);letter-spacing:.2em">DO NOT LEAVE THIS SCREEN</div>' +
        '</div>' +
      '</div>';
    },
    mount: function (root) {
      /* Thousands of undetermined points resolving into one determined
         structure. The visualisation is a metaphor and says so — the real
         entropy comes from the platform CSPRNG, not from this canvas. */
      var cv = $('[data-canvas]', root), ctx = cv.getContext('2d');
      var W = cv.width, N = 1400, pts = [], i;

      var path = labyrinthPath(W, 11, W / 26).split(' L ').map(function (s, k) {
        var p = s.replace('M ', '').trim().split(' ');
        return { x: parseFloat(p[0]), y: parseFloat(p[1]), k: k };
      });

      /* Resample the polyline so targets are evenly spread along it. */
      var targets = [];
      for (i = 0; i < path.length - 1; i++) {
        var a = path[i], b = path[i + 1];
        var seg = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 5));
        for (var s = 0; s < seg; s++) {
          targets.push({ x: a.x + (b.x - a.x) * (s / seg), y: a.y + (b.y - a.y) * (s / seg) });
        }
      }

      for (i = 0; i < N; i++) {
        var t = targets[i % targets.length];
        pts.push({
          x: Math.random() * W, y: Math.random() * W,
          tx: t.x, ty: t.y, d: Math.random() * 0.35
        });
      }

      var start = performance.now(), DUR = 5200, raf;
      function frame(now) {
        var p = Math.min(1, (now - start) / DUR);
        ctx.clearRect(0, 0, W, W);
        ctx.fillStyle = '#efeae2';
        for (var j = 0; j < N; j++) {
          var q = pts[j];
          var e = Math.max(0, Math.min(1, (p - q.d) / (1 - q.d)));
          e = e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2;
          var x = q.x + (q.tx - q.x) * e, y = q.y + (q.ty - q.y) * e;
          ctx.globalAlpha = 0.20 + 0.65 * e;
          ctx.fillRect(x, y, 1.7, 1.7);
        }
        $('[data-bits]', root).textContent = Math.round(p * 256) + ' / 256 BITS';
        if (p < 1) raf = requestAnimationFrame(frame);
        else after(function () { go('created'); }, 700);
      }
      raf = requestAnimationFrame(frame);
      root.addEventListener('screen:exit', function () { cancelAnimationFrame(raf); });
    }
  };

  S.created = {
    group: 'Onboarding', name: 'Key material created',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center">' +
          '<div class="enter">' +
            '<div class="eyebrow">COMPLETE</div>' +
            '<h1 class="statement" style="margin:18px 0 34px">KEY MATERIAL<br>CREATED.</h1>' +
            '<div class="stack">' +
              field('STORAGE', 'DEVICE SECURE HARDWARE') +
              field('AT REST', 'ENCRYPTED') +
              field('BINDING', 'THIS DEVICE ONLY') +
              field('COPIES ELSEWHERE', 'NONE') +
              field('VAULT ID', VAULT.id) +
            '</div>' +
            '<p class="prose" style="margin-top:26px">There is no cloud backup, because there is ' +
            'no cloud. If you lose this phone without a recovery phrase written down, the keys ' +
            'are gone. That is the trade you made when you took the SIM out.</p>' +
          '</div>' +
        '</div>' +
        '<div class="foot" style="display:flex;flex-direction:column;gap:10px">' +
          primary('OPEN VAULT', '', 'home') +
          control('WRITE DOWN RECOVERY PHRASE', 'RECOMMENDED', 'keys', 'control--quiet') +
        '</div>' +
      '</div>';
    }
  };

  /* --- vault --------------------------------------------------------------- */

  S.home = {
    group: 'Vault', name: 'Vault home',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body" style="position:relative">' +
          '<div class="watermark">' + glyph(300, 8, 15, 1) + '</div>' +
          '<div class="pad" style="position:relative">' +
            '<div style="padding:34px 0 30px">' +
              '<div class="eyebrow">VAULT</div>' +
              '<div class="statement statement--mega" style="margin-top:10px">READY</div>' +
            '</div>' +
            '<div class="stack" style="margin-bottom:30px">' +
              field('NETWORK', 'NONE') +
              field('CLOUD', 'NONE') +
              field('ACCOUNT', 'NONE') +
              field('BROADCAST CAPABILITY', 'NONE') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:10px">' +
              primary('SCAN TRANSACTION', 'CAMERA', 'scanner') +
              control('EXPORT WATCH-ONLY', 'QR', 'export') +
            '</div>' +
            '<div style="height:30px"></div>' +
          '</div>' +
          '<div class="assets">' +
            '<div class="asset asset--btc"><div class="asset__bar"></div>' +
              '<div class="asset__t">BITCOIN <span style="color:var(--paper-faint);font-weight:400">BTC</span></div>' +
              '<div class="asset__s">SIGNING · READY</div></div>' +
            '<div class="asset asset--xmr"><div class="asset__bar"></div>' +
              '<div class="asset__t">MONERO <span style="color:var(--paper-faint);font-weight:400">XMR</span></div>' +
              '<div class="asset__s">KEYS ONLY · SIGNING NOT INSTALLED</div></div>' +
          '</div>' +
          '<div class="pad" style="padding-top:20px;padding-bottom:24px">' +
            '<div class="field" style="border-bottom:0;padding-bottom:6px">' +
              '<span class="field__k">VAULT ID</span><span class="field__v">' + VAULT.id + '</span></div>' +
            '<div class="field" style="border-bottom:0;padding-top:0">' +
              '<span class="field__k">LAST VERIFIED</span><span class="field__v field__v--dim">NEVER</span></div>' +
          '</div>' +
        '</div>' + tabs('home') +
      '</div>';
    }
  };

  function tabs(on) {
    var items = [['home', 'VAULT'], ['scanner', 'SIGN'], ['export', 'EXPORT'], ['security', 'SECURITY']];
    return '<nav class="tabs">' + items.map(function (t) {
      return '<button data-go="' + t[0] + '" class="' + (t[0] === on ? 'is-on' : '') + '">' + t[1] + '</button>';
    }).join('') + '</nav>';
  }

  S.btcsetup = {
    group: 'Vault', name: 'Bitcoin setup',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:26px 0 24px">' +
            '<div class="eyebrow" style="color:var(--btc)">BITCOIN</div>' +
            '<h1 class="statement" style="margin-top:12px;font-size:40px">BIP84<br>ACCOUNT 0</h1>' +
          '</div>' +
          '<div class="stack">' +
            field('DERIVATION', VAULT.btcPath) +
            field('SCRIPT', 'P2WPKH · NATIVE SEGWIT') +
            field('FINGERPRINT', VAULT.fingerprint) +
            field('ADDRESS GAP SCAN', '200') +
            field('SIGNING', 'INSTALLED', 'field__v--good') +
          '</div>' +
          '<p class="prose" style="margin:26px 0">The vault derives its own addresses and ' +
          're-derives every output a transaction claims is yours. Nothing about ownership is ' +
          'ever read from the file a companion sends.</p>' +
          '<div class="stack">' +
            control('EXPORT WATCH-ONLY KEY', 'ZPUB', 'export', 'control--quiet') +
          '</div>' +
          '<div style="height:24px"></div>' +
        '</div>' +
        '<div class="foot">' + primary('DONE', '', 'home') + '</div>' +
      '</div>';
    }
  };

  S.xmrsetup = {
    group: 'Vault', name: 'Monero setup',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:26px 0 24px">' +
            '<div class="eyebrow" style="color:var(--xmr)">MONERO</div>' +
            '<h1 class="statement" style="margin-top:12px;font-size:40px">VIEW KEY<br>EXPORT</h1>' +
          '</div>' +
          '<div class="stack">' +
            field('SEED', '25 WORDS · ELECTRUM STYLE') +
            field('PRIMARY ADDRESS', 'DERIVED') +
            field('PRIVATE VIEW KEY', 'AVAILABLE FOR EXPORT') +
            field('SPEND KEY', 'NEVER LEAVES DEVICE') +
            field('TRANSACTION SIGNING', 'NOT INSTALLED', 'field__v--dim') +
          '</div>' +
          '<div style="margin-top:26px;padding:20px;border:1px solid var(--rule)">' +
            '<div class="label" style="color:var(--paper)">WHAT THIS BUILD CANNOT DO</div>' +
            '<p class="prose" style="margin-top:10px;font-size:13.5px">Monero keys, addresses and ' +
            'view-key export work. Signing an unsigned transaction set does not exist yet, so the ' +
            'vault will refuse an XMR payload rather than appear to handle one.</p>' +
          '</div>' +
          '<div style="height:24px"></div>' +
        '</div>' +
        '<div class="foot">' + primary('DONE', '', 'home') + '</div>' +
      '</div>';
    }
  };

  /* --- transport ----------------------------------------------------------- */

  S.export = {
    group: 'Transport', name: 'Watch-only export',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:24px 0 20px">' +
            '<div class="eyebrow">EXPORT</div>' +
            '<h1 class="statement" style="margin-top:12px;font-size:38px">WATCH-ONLY<br>KEY</h1>' +
            '<p class="prose" style="margin-top:16px">Your companion can watch your funds with ' +
            'this. It cannot spend them: no private key has ever been on that device, and this ' +
            'code does not contain one.</p>' +
          '</div>' +
          '<div class="aperture" data-qr>' + qr('ACCOUNT:' + VAULT.xpub + ':1', 45) +
            '<svg class="aperture__frame" viewBox="0 0 100 100" preserveAspectRatio="none">' +
              '<rect x="0.5" y="0.5" width="99" height="99"/></svg>' +
          '</div>' +
          '<div class="stack" style="margin-top:22px">' +
            field('ASSET', 'BITCOIN') +
            field('STANDARD', 'BIP84') +
            field('ACCOUNT', '0') +
            field('CONTAINS', 'PUBLIC KEY ONLY', 'field__v--good') +
            field('FRAME', '<span data-frame>1 / 6</span>') +
          '</div>' +
          '<div style="margin:20px 0 8px" class="label" style="color:var(--paper)">SCAN THIS WITH YOUR COMPANION DEVICE</div>' +
          '<button class="linkline" data-reveal>SHOW KEY AS TEXT</button>' +
          '<div class="mono masked" data-key style="font-size:11px;line-height:1.7;word-break:break-all;color:var(--paper-dim);padding-bottom:24px">' +
            VAULT.xpub + '</div>' +
        '</div>' + tabs('export') +
      '</div>';
    },
    mount: function (root) {
      /* A multi-frame export animates. The frame counter is the honest signal
         that this is a stream, not a still image. */
      var n = 6, i = 1;
      every(function () {
        i = i % n + 1;
        $('[data-qr]', root).firstChild.outerHTML = qr('ACCOUNT:' + VAULT.xpub + ':' + i, 45);
        $('[data-frame]', root).textContent = i + ' / ' + n;
      }, 900);
      $('[data-reveal]', root).addEventListener('click', function () {
        $('[data-key]', root).classList.toggle('is-shown');
      });
    }
  };

  S.scanner = {
    group: 'Transport', name: 'QR scanner',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:22px 0 18px">' +
            '<div class="eyebrow">RECEIVE</div>' +
            '<h1 class="statement" style="margin-top:10px;font-size:38px">POINT AT<br>THE COMPANION</h1>' +
          '</div>' +
          '<div class="viewfinder">' +
            '<span class="viewfinder__bracket"></span><span class="viewfinder__bracket"></span>' +
            '<span class="viewfinder__bracket"></span><span class="viewfinder__bracket"></span>' +
            '<span class="viewfinder__sweep"></span>' +
            '<div style="position:absolute;inset:auto 0 16px;text-align:center" class="label" data-state>SEARCHING</div>' +
          '</div>' +
          '<div class="stack" style="margin-top:20px">' +
            field('WIRE', 'BC-UR&nbsp; ·&nbsp; LABYRINTH ENVELOPE') +
            field('DETECTION', 'AUTOMATIC') +
            field('ACCEPTS', 'PSBT&nbsp; ·&nbsp; XMR UNSIGNED') +
          '</div>' +
          '<p class="prose" style="margin:20px 0">Both wires are read off one camera loop. ' +
          'Pointing this at a different wallet mid-scan is not a restart.</p>' +
          '<div style="height:16px"></div>' +
        '</div>' +
        '<div class="foot">' + primary('SIMULATE INCOMING PSBT', 'DEMO', 'receiving') + '</div>' +
      '</div>';
    },
    mount: function (root) {
      /* STUB: the shipped app opens the camera here. The prototype does not,
         which is also why it needs no permissions to run. */
      var states = ['SEARCHING', 'SEARCHING', 'CODE IN FRAME', 'LOCKED · LV1 ENVELOPE'], i = 0;
      every(function () {
        $('[data-state]', root).textContent = states[i % states.length];
        i++;
      }, 1100);
    }
  };

  S.receiving = {
    group: 'Transport', name: 'Multi-frame receiving',
    render: function () {
      var cells = '';
      for (var i = 0; i < 42; i++) cells += '<span class="cell" data-cell="' + (i + 1) + '"></span>';
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:22px 0 20px">' +
            '<div class="eyebrow">RECEIVING TRANSACTION</div>' +
            '<div class="readout" style="margin-top:14px"><span data-have>0</span> <span style="color:var(--paper-ghost)">/</span> 42</div>' +
            '<div class="label" style="margin-top:12px">FRAGMENTS ACQUIRED</div>' +
          '</div>' +
          '<div class="lattice" data-lattice>' + cells + '</div>' +
          '<div class="stack" style="margin:24px 0 18px">' +
            field('RECEIVED', '<span data-r>0</span>') +
            field('MISSING', '<span data-m>42</span>') +
            field('REPEATS DISCARDED', '<span data-dup>0</span>') +
            field('DIGEST', TX.digest.slice(0, 8).toUpperCase() + '…') +
          '</div>' +
          '<div class="tickers" data-tick></div>' +
          '<p class="prose" style="margin:18px 0 24px;font-size:13.5px">Frames arrive out of order ' +
          'and repeat. That is the transport working. Keep the camera steady until the count fills.</p>' +
        '</div>' +
        '<div class="foot"><div class="label" data-foot>ACQUIRING</div></div>' +
      '</div>';
    },
    mount: function (root) {
      var order = shuffled(42), got = 0, dup = 0, idx = 0, last = null;
      var tickHost = $('[data-tick]', root);

      var run = every(function () {
        if (idx >= order.length) {
          clearInterval(run);
          $('[data-foot]', root).textContent = 'CHECKSUM VERIFIED';
          $('[data-foot]', root).style.color = 'var(--signal)';
          after(function () { go('received'); }, 900);
          return;
        }
        /* Every so often the camera reads a frame it already has. Showing that
           as normal traffic rather than an error is the whole point. */
        if (Math.random() < 0.16 && got > 2) {
          dup++;
          $('[data-dup]', root).textContent = dup;
          push('FRAME ' + order[Math.floor(Math.random() * got)] + ' · REPEAT, DISCARDED');
          return;
        }
        var n = order[idx++];
        got++;
        var cell = $('[data-cell="' + n + '"]', root);
        if (last) last.classList.remove('is-new');
        cell.classList.add('is-in', 'is-new');
        last = cell;
        $('[data-have]', root).textContent = got;
        $('[data-r]', root).textContent = got;
        $('[data-m]', root).textContent = 42 - got;
        push('FRAME ' + n + ' · VERIFIED');
      }, 105);

      function push(text) {
        var row = document.createElement('div');
        row.textContent = text;
        tickHost.insertBefore(row, tickHost.firstChild);
        while (tickHost.children.length > 4) tickHost.removeChild(tickHost.lastChild);
      }
    }
  };

  S.received = {
    group: 'Transport', name: 'Transaction received',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center;position:relative">' +
          '<div class="watermark" style="inset:auto auto -25% -30%;width:150%;opacity:.07">' + glyph(300, 7, 17, 1) + '</div>' +
          '<div class="enter" style="position:relative">' +
            '<div class="eyebrow">TRANSPORT COMPLETE</div>' +
            '<h1 class="statement" style="margin:16px 0 30px;font-size:44px">TRANSACTION<br>RECEIVED.</h1>' +
            '<div class="checks">' +
              '<div class="check is-on"><span class="check__mark">✓</span>42 OF 42 FRAGMENTS ASSEMBLED</div>' +
              '<div class="check is-on"><span class="check__mark">✓</span>PAYLOAD DIGEST MATCHED</div>' +
              '<div class="check is-on"><span class="check__mark">✓</span>KIND RECOGNISED · PSBT</div>' +
              '<div class="check is-on"><span class="check__mark">✓</span>DECODED WITHOUT AMBIGUITY</div>' +
            '</div>' +
            '<p class="prose" style="margin-top:24px">The checksum proves the camera read the ' +
            'bytes correctly. It proves nothing about what the bytes do. That is the next screen, ' +
            'and it is yours to read.</p>' +
          '</div>' +
        '</div>' +
        '<div class="foot">' + primary('READ THE TRANSACTION', '', 'confirm') + '</div>' +
      '</div>';
    }
  };

  /* --- the confirmation screen -------------------------------------------- */

  S.confirm = {
    group: 'Signing', name: 'Transaction confirmation',
    render: function () {
      return '<div class="screen">' +
        '<header class="statusbar" style="border-bottom:1px solid var(--rule);padding-bottom:12px">' +
          '<div class="gate" data-gate>' +
            '<span class="is-live" data-g="0">STOP</span><i>/</i>' +
            '<span data-g="1">VERIFY</span><i>/</i>' +
            '<span data-g="2">SIGN</span>' +
          '</div>' +
          '<div class="label" data-progress>0%</div>' +
        '</header>' +
        '<div class="body" data-scroll>' +
          '<div class="pad">' +

            '<div style="padding:30px 0 26px">' +
              '<h1 class="statement" style="font-size:34px;line-height:1">READ BEFORE<br>SIGNING</h1>' +
              '<p class="prose" style="margin-top:16px">This came from a device the vault does not ' +
              'trust. Everything below was decoded here, on this phone, from the bytes themselves.</p>' +
            '</div>' +

            '<hr class="rule rule--heavy">' +

            '<div style="padding:30px 0 8px">' +
              '<div class="eyebrow">SENDING</div>' +
              '<div class="readout" style="margin-top:16px">' + TX.send + '</div>' +
              '<div style="font-size:20px;font-weight:600;letter-spacing:.1em;color:var(--btc);margin-top:12px">BTC</div>' +
              /* No fiat figure. The vault has no network, so it cannot know a
                 rate, and a number it cannot verify has no business sitting
                 beside one it can. The absence is stated rather than left as a
                 gap somebody might read as an oversight. */
              '<div class="label" style="margin-top:14px;line-height:1.5">NO PRICE SHOWN · THIS DEVICE<br>HAS NO NETWORK TO ASK</div>' +
            '</div>' +

            '<div style="height:26px"></div>' +
          '</div>' +

          /* The human verification zone. Full width, full address, no
             disclosure, no truncation, nothing else competing with it. */
          '<div class="pad">' +
            '<div class="zone">' +
              '<span class="zone__tag eyebrow" style="color:var(--paper)">DESTINATION</span>' +
              '<div class="addr">' + address(TX.to) + '</div>' +
              '<hr class="rule" style="margin:24px 0 18px">' +
              '<div class="field" style="border-bottom:0;padding:0">' +
                '<span class="field__k">TYPE</span><span class="field__v field__v--dim">P2WPKH · NOT YOURS</span></div>' +
              '<div style="margin-top:18px">' +
                '<button class="control control--quiet" data-go="destination" style="min-height:52px">' +
                  '<span style="font-size:13px">COMPARE CHARACTER BY CHARACTER</span>' +
                  '<span class="control__hint">OPEN</span></button>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="pad">' +
            '<div style="padding:34px 0 6px"><div class="eyebrow">FEE</div>' +
              '<div class="readout" style="font-size:34px;margin-top:12px">' + TX.fee + ' <span style="font-size:15px;color:var(--paper-faint)">BTC</span></div>' +
            '</div>' +
            '<div class="stack" style="margin-top:14px">' +
              field('SHARE OF AMOUNT', TX.feeShare) +
              field('RATE', TX.satvb + ' SAT/VB') +
              field('VIRTUAL SIZE', TX.vsize + ' VB') +
              field('INPUT VALUES', 'ALL KNOWN', 'field__v--good') +
            '</div>' +
            '<p class="prose" style="margin-top:16px;font-size:13.5px">The fee is not written in a ' +
            'transaction — it is what is left over. The vault can only state it because every ' +
            'input value was supplied and checked. Had one been missing, this screen would not exist.</p>' +

            '<div style="padding:34px 0 6px"><div class="eyebrow">CHANGE RETURNING TO YOU</div>' +
              '<div class="readout" style="font-size:34px;margin-top:12px">' + TX.change + ' <span style="font-size:15px;color:var(--paper-faint)">BTC</span></div>' +
            '</div>' +
            '<div class="mono" style="font-size:12.5px;line-height:1.7;word-break:break-all;color:var(--paper-dim);margin-top:12px">' + TX.changeTo + '</div>' +
            '<div class="stack" style="margin-top:14px">' +
              field('DERIVED AT', TX.changePath) +
              field('SCRIPT RE-DERIVED HERE', 'MATCHES', 'field__v--good') +
            '</div>' +
            '<p class="prose" style="margin-top:16px;font-size:13.5px">The transaction claims this ' +
            'output is yours. The vault ignored that claim and rebuilt the address from its own ' +
            'key. The two agree, so it is yours.</p>' +

            '<div style="padding:34px 0 0"><div class="eyebrow">STRUCTURE</div></div>' +
            '<div class="stack" style="margin-top:14px">' +
              field('INPUTS', String(TX.inputs)) +
              field('OUTPUTS', String(TX.outputs)) +
              field('TOTAL IN', TX.total + ' BTC') +
              field('LOCKTIME', 'NONE') +
              field('RBF SIGNALLED', 'YES') +
            '</div>' +

            '<div style="padding:34px 0 0"><div class="eyebrow">WHAT THE VAULT CHECKED</div></div>' +
            '<div class="checks" style="margin-top:14px">' +
              '<div class="check is-on"><span class="check__mark">✓</span>CHANGE OUTPUT IDENTIFIED BY OWN DERIVATION</div>' +
              '<div class="check is-on"><span class="check__mark">✓</span>EVERY INPUT VALUE KNOWN</div>' +
              '<div class="check is-on"><span class="check__mark">✓</span>FEE CALCULATED, NOT ASSERTED</div>' +
              '<div class="check is-on"><span class="check__mark">✓</span>TRANSACTION DIGEST MATCHED</div>' +
            '</div>' +

            '<p class="prose" style="margin:30px 0 10px;color:var(--paper)">The vault has checked ' +
            'everything a machine can check. It cannot check whether this is the person you meant ' +
            'to pay. Only you can do that, and only by reading the destination above.</p>' +
            '<div style="height:40px"></div>' +
          '</div>' +
        '</div>' +

        '<div class="foot">' +
          '<button class="control control--primary" data-proceed disabled>' +
            '<span>I HAVE READ THIS</span>' +
            '<span class="control__hint" data-phint>SCROLL</span></button>' +
        '</div>' +
      '</div>';
    },
    mount: function (root) {
      /* STOP → VERIFY → SIGN is not a progress bar with three labels. The
         signing route does not open until the document has physically passed
         the reader's eyes, because the only defence this product has is that
         somebody looked. */
      var scroll = $('[data-scroll]', root);
      var marks  = $$('[data-g]', root);
      var btn    = $('[data-proceed]', root);
      var hint   = $('[data-phint]', root);
      var pct    = $('[data-progress]', root);
      var armed  = false;

      function update() {
        var max = scroll.scrollHeight - scroll.clientHeight;
        var p = max <= 0 ? 1 : Math.min(1, scroll.scrollTop / max);
        pct.textContent = Math.round(p * 100) + '%';

        var stage = p >= 0.985 ? 2 : p > 0.05 ? 1 : 0;
        marks.forEach(function (m, i) {
          m.classList.toggle('is-on', i < stage);
          m.classList.toggle('is-live', i === stage);
        });

        if (stage === 2 && !armed) {
          armed = true;
          btn.disabled = false;
          hint.textContent = 'CONTINUE';
          btn.addEventListener('click', function () { go('attest'); });
        }
      }
      scroll.addEventListener('scroll', update, { passive: true });
      update();
    }
  };

  S.destination = {
    group: 'Signing', name: 'Destination verification',
    render: function () {
      var chunks = TX.to.match(/.{1,4}/g) || [];
      return '<div class="screen">' +
        '<header class="statusbar" style="border-bottom:1px solid var(--rule)">' +
          '<div class="label" style="color:var(--paper)">DESTINATION</div>' +
          '<button class="linkline" data-go="confirm">CLOSE</button>' +
        '</header>' +
        '<div class="body pad">' +
          '<p class="prose" style="margin:22px 0 26px">Read it against the address on your ' +
          'companion. A substitution attack changes the middle and keeps the ends familiar, ' +
          'so read the middle.</p>' +
          '<div class="stack" style="border-top:1px solid var(--rule)">' +
            chunks.map(function (c, i) {
              return '<div class="field" style="padding:12px 0">' +
                '<span class="field__k">' + String(i * 4).padStart(2, '0') + '</span>' +
                '<span class="mono" style="font-size:22px;letter-spacing:.22em;color:var(--paper)">' + c + '</span></div>';
            }).join('') +
          '</div>' +
          '<div style="margin-top:24px;padding:18px;border:1px solid var(--rule)">' +
            '<div class="label">FULL STRING</div>' +
            '<div class="mono" style="margin-top:10px;font-size:12.5px;line-height:1.7;word-break:break-all">' + TX.to + '</div>' +
          '</div>' +
          '<div style="height:28px"></div>' +
        '</div>' +
        '<div class="foot">' + primary('BACK TO TRANSACTION', '', 'confirm') + '</div>' +
      '</div>';
    }
  };

  S.attest = {
    group: 'Signing', name: 'Attest & hold to sign',
    render: function () {
      var lines = ['THE DESTINATION', 'THE AMOUNT', 'THE FEE', 'THE CHANGE'];
      return '<div class="screen">' + bar('quiet') +
        '<div class="body pad">' +
          '<div style="padding:26px 0 22px">' +
            '<div class="eyebrow" style="color:var(--signal)">TRANSACTION VERIFIED</div>' +
            '<h1 class="statement" style="margin-top:14px;font-size:36px">I HAVE<br>VERIFIED</h1>' +
          '</div>' +
          '<div class="checks">' + lines.map(function (l) {
            return '<label class="check" data-attest style="cursor:pointer;padding:17px 0;font-size:13px;letter-spacing:.1em">' +
              '<span class="check__mark">✓</span>' + l + '</label>';
          }).join('') + '</div>' +
          '<div class="stack" style="margin-top:26px">' +
            field('AMOUNT', TX.send + ' BTC') +
            field('TO', '…' + TX.to.slice(-10)) +
            field('FEE', TX.fee + ' BTC') +
            field('SUMMARY DIGEST', TX.digest.slice(0, 12).toUpperCase()) +
          '</div>' +
          '<p class="prose" style="margin:20px 0;font-size:13.5px">The signature will be taken over ' +
          'these bytes and no others. If anything below this screen differs from what you just ' +
          'read, signing fails rather than proceeds.</p>' +
          '<div style="height:20px"></div>' +
        '</div>' +
        '<div class="foot">' +
          '<div class="holdstage" data-stage>&nbsp;</div>' +
          '<button class="hold" data-hold disabled style="margin-top:12px;opacity:.35">' +
            '<span class="hold__fill" data-fill></span>' +
            '<span class="hold__label" data-holdlabel>CONFIRM ALL FOUR ABOVE</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    },
    mount: function (root) {
      var need = 4, done = 0;
      var hold = $('[data-hold]', root), fill = $('[data-fill]', root);
      var label = $('[data-holdlabel]', root), stage = $('[data-stage]', root);

      $$('[data-attest]', root).forEach(function (row) {
        row.addEventListener('click', function () {
          if (row.classList.contains('is-on')) return;
          row.classList.add('is-on');
          if (++done === need) {
            hold.disabled = false;
            hold.style.opacity = '1';
            label.textContent = 'HOLD TO SIGN';
            stage.textContent = 'READY';
          }
        });
      });

      /* A press is a keystroke. A hold is a decision. Releasing early does not
         sign, and says so. */
      var DUR = 2400, t0 = 0, raf = null;
      var STAGES = [
        [0.00, 'VERIFYING DIGEST'],
        [0.34, 'MATCHING APPROVED SUMMARY'],
        [0.68, 'GENERATING SIGNATURE']
      ];

      function frame(now) {
        var p = Math.min(1, (now - t0) / DUR);
        fill.style.width = (p * 100) + '%';
        for (var i = STAGES.length - 1; i >= 0; i--) {
          if (p >= STAGES[i][0]) { stage.textContent = STAGES[i][1]; break; }
        }
        if (p < 1) { raf = requestAnimationFrame(frame); return; }
        hold.classList.add('is-done');
        label.textContent = 'SIGNED';
        stage.textContent = 'SIGNATURE COMPLETE';
        if (navigator.vibrate) navigator.vibrate([12, 40, 26]);
        after(function () { go('signed'); }, 700);
      }

      function start(e) {
        if (hold.disabled || raf) return;
        e.preventDefault();
        t0 = performance.now();
        raf = requestAnimationFrame(frame);
      }
      function stop() {
        if (!raf) return;
        cancelAnimationFrame(raf); raf = null;
        if (hold.classList.contains('is-done')) return;
        fill.style.width = '0%';
        stage.textContent = 'RELEASED · NOT SIGNED';
      }

      hold.addEventListener('pointerdown', start);
      hold.addEventListener('pointerup', stop);
      hold.addEventListener('pointercancel', stop);
      hold.addEventListener('pointerleave', stop);
      root.addEventListener('screen:exit', function () { if (raf) cancelAnimationFrame(raf); });
    }
  };

  S.signed = {
    group: 'Signing', name: 'Signature created',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center">' +
          '<div class="enter">' +
            '<div class="eyebrow" style="color:var(--signal)">COMPLETE</div>' +
            '<h1 class="statement statement--mega" style="margin:16px 0 8px">SIGNED</h1>' +
            '<div class="statement" style="font-size:30px;color:var(--paper-faint)">NOT BROADCAST</div>' +
            '<hr class="rule rule--heavy" style="margin:30px 0 0">' +
            '<div class="stack">' +
              field('SIGNATURES', String(TX.inputs) + ' OF ' + String(TX.inputs)) +
              field('SIGHASH', 'ALL') +
              field('TXID', TX.txid.slice(0, 16).toUpperCase() + '…') +
              field('SENT ANYWHERE', 'NO', 'field__v--good') +
            '</div>' +
            '<p class="prose" style="margin-top:24px">Nothing has left this device and nothing ' +
            'will. The vault has no way to reach the network — carrying this to the chain is the ' +
            'companion\'s job, and only if you show it the code.</p>' +
          '</div>' +
        '</div>' +
        '<div class="foot">' + primary('SHOW SIGNED TRANSACTION', 'QR', 'signedqr') + '</div>' +
      '</div>';
    }
  };

  S.signedqr = {
    group: 'Signing', name: 'Signed transaction QR',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:20px 0 18px">' +
            '<div class="eyebrow">SIGNED TRANSACTION</div>' +
            '<h1 class="statement" style="margin-top:10px;font-size:32px">SHOW THIS TO YOUR<br>COMPANION DEVICE</h1>' +
          '</div>' +
          '<div class="aperture" data-qr>' + qr('TXSIGNED:' + TX.txid + ':1', 49) +
            '<svg class="aperture__frame" viewBox="0 0 100 100" preserveAspectRatio="none">' +
              '<rect x="0.5" y="0.5" width="99" height="99"/></svg>' +
          '</div>' +
          '<div class="stack" style="margin-top:22px">' +
            field('KIND', 'TXSIGNED') +
            field('FRAME', '<span data-frame>1 / 12</span>') +
            field('DIGEST', TX.digest.slice(0, 8).toUpperCase()) +
          '</div>' +
          '<div style="margin-top:24px;padding:18px;border:1px solid var(--rule-strong)">' +
            '<div class="prose" style="color:var(--paper);font-size:14px">THE VAULT WILL NOT ' +
            'BROADCAST THIS TRANSACTION.</div>' +
            '<div class="prose" style="margin-top:8px;font-size:13px">It has no code that could. ' +
            'Until your companion sends it, this payment does not exist anywhere but on this screen.</div>' +
          '</div>' +
          '<div style="height:24px"></div>' +
        '</div>' +
        '<div class="foot">' + control('DONE', 'RETURN TO VAULT', 'home', 'control--quiet') + '</div>' +
      '</div>';
    },
    mount: function (root) {
      var n = 12, i = 1;
      every(function () {
        i = i % n + 1;
        $('[data-qr]', root).firstChild.outerHTML = qr('TXSIGNED:' + TX.txid + ':' + i, 49);
        $('[data-frame]', root).textContent = i + ' / ' + n;
      }, 700);
    }
  };

  /* --- refusals ------------------------------------------------------------ */
  /* Three of these, matching the three fatal conditions in src/keys/psbt.ts.
     Each has exactly one control. There is deliberately no route onward: an
     "advanced" escape hatch here would delete the security of the product. */

  function refusal(headline, why, detail, checks) {
    return '<div class="screen refusal">' +
      '<div class="refusal__bar"></div>' +
      '<header class="statusbar"><div class="label" style="color:var(--paper)">SIGNING REFUSED</div>' +
        '<div class="label">VAULT · FAIL CLOSED</div></header>' +
      '<div class="body pad" style="display:flex;flex-direction:column;justify-content:center">' +
        '<h1 class="statement statement--mega" style="margin-bottom:26px">' + headline + '</h1>' +
        '<hr class="rule rule--heavy">' +
        '<div class="refusal__why" style="margin:26px 0 20px">' + why + '</div>' +
        '<p class="prose">' + detail + '</p>' +
        (checks ? '<div class="checks" style="margin-top:26px">' + checks + '</div>' : '') +
      '</div>' +
      '<div class="foot">' + primary('SCAN AGAIN', '', 'scanner') + '</div>' +
    '</div>';
  }

  S.refusechange = {
    group: 'Refusal', name: 'Change does not match',
    render: function () {
      return refusal('CANNOT<br>SIGN',
        'CHANGE OUTPUT<br>DOES NOT MATCH<br>VAULT DERIVATION.',
        'One output claims to be your change. The vault rebuilt that address from its own key ' +
        'and got a different one, which means the transaction is describing itself falsely. ' +
        'Nothing else it says can be trusted either, so none of it gets signed.',
        '<div class="check is-bad"><span class="check__mark">×</span>OUTPUT 1 CLAIMED AS CHANGE</div>' +
        '<div class="check is-bad"><span class="check__mark">×</span>RE-DERIVED SCRIPT DIFFERS</div>' +
        '<div class="check is-on"><span class="check__mark">✓</span>NO SIGNATURE PRODUCED</div>');
    }
  };

  S.refusefee = {
    group: 'Refusal', name: 'Fee is unknowable',
    render: function () {
      return refusal('CANNOT<br>DETERMINE<br>FEE',
        'THE VAULT CANNOT<br>HONESTLY TELL YOU<br>WHAT THIS COSTS.',
        'A fee is what is left over after the outputs, so it can only be stated by a signer that ' +
        'knows what every input was worth. This transaction did not supply one of them. The ' +
        'alternative to refusing is printing a number the vault has not verified, which is worse ' +
        'than printing nothing.',
        '<div class="check is-bad"><span class="check__mark">×</span>INPUT 2 · PREVIOUS OUTPUT MISSING</div>' +
        '<div class="check is-bad"><span class="check__mark">×</span>FEE NOT COMPUTABLE</div>' +
        '<div class="check is-on"><span class="check__mark">✓</span>NO SIGNATURE PRODUCED</div>');
    }
  };

  S.refuseframes = {
    group: 'Refusal', name: 'Transport digest mismatch',
    render: function () {
      return refusal('SCAN<br>INCOMPLETE',
        'THE ASSEMBLED PAYLOAD<br>DOES NOT MATCH<br>ITS OWN DIGEST.',
        'The frames that arrived do not add up to the payload they claim to be. This is almost ' +
        'always a misread camera frame rather than an attack, and the fix is the same either way: ' +
        'the vault throws all of it away and you scan from the beginning.',
        '<div class="check is-bad"><span class="check__mark">×</span>38 OF 42 FRAGMENTS · 4 NEVER ARRIVED</div>' +
        '<div class="check is-bad"><span class="check__mark">×</span>DIGEST MISMATCH</div>' +
        '<div class="check is-on"><span class="check__mark">✓</span>BUFFER DISCARDED</div>');
    }
  };

  /* --- device -------------------------------------------------------------- */

  S.security = {
    group: 'Device', name: 'Security diagnostics',
    render: function () {
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:26px 0 22px">' +
            '<div class="eyebrow">DIAGNOSTIC</div>' +
            '<h1 class="statement" style="margin-top:12px;font-size:40px">AIRGAP<br>STATUS</h1>' +
            '<div class="readout" style="margin-top:20px;color:var(--signal);font-size:38px">VERIFIED</div>' +
          '</div>' +
          '<div class="eyebrow" style="padding-top:14px">NETWORK</div>' +
          '<div class="stack" style="margin-top:10px">' +
            field('NETWORK PERMISSION', 'NONE', 'field__v--good') +
            field('WI-FI', 'DISABLED') + field('BLUETOOTH', 'DISABLED') +
            field('CELLULAR', 'DISABLED') + field('SIM', 'NOT PRESENT') +
            field('CLOUD', 'NONE') + field('ACCOUNT', 'NONE') +
          '</div>' +
          '<div class="eyebrow" style="padding-top:30px">KEY STORAGE</div>' +
          '<div class="stack" style="margin-top:10px">' +
            field('DEVICE SECURE HARDWARE', 'ACTIVE', 'field__v--good') +
            field('ENCRYPTION AT REST', 'ACTIVE', 'field__v--good') +
            field('PASSPHRASE', 'CONFIGURED', 'field__v--good') +
            field('KEY EXPORTABLE', 'NO') +
            field('BACKUP SERVICE', 'NONE') +
          '</div>' +
          '<div class="eyebrow" style="padding-top:30px">BUILD</div>' +
          '<div class="stack" style="margin-top:10px">' +
            field('NETWORK CODE IN BINARY', 'NONE', 'field__v--good') +
            field('WIRE VERSION', 'LV1') +
            field('BC-UR', 'SUPPORTED') +
            field('VAULT ID', VAULT.id) +
          '</div>' +
          '<p class="prose" style="margin:24px 0;font-size:13.5px">Every line above is a property ' +
          'of this device that you can check yourself in Settings. The vault asserts nothing here ' +
          'it cannot be caught lying about.</p>' +
          '<div style="height:20px"></div>' +
        '</div>' + tabs('security') +
      '</div>';
    }
  };

  S.settings = {
    group: 'Device', name: 'Settings',
    render: function () {
      var rows = [
        ['BITCOIN', 'BIP84 · ACCOUNT 0', 'btcsetup'],
        ['MONERO', 'VIEW KEY ONLY', 'xmrsetup'],
        ['SECURITY DIAGNOSTICS', 'ALL CLEAR', 'security'],
        ['KEY MANAGEMENT', 'ENCRYPTED', 'keys'],
        ['RE-RUN AIRGAP CHECK', '', 'airgap']
      ];
      return '<div class="screen">' + bar() +
        '<div class="body pad">' +
          '<div style="padding:26px 0 22px">' +
            '<h1 class="statement" style="font-size:40px">VAULT</h1>' +
          '</div>' +
          '<div class="stack">' + rows.map(function (r) {
            return '<button class="field" data-go="' + r[2] + '" style="width:100%;background:none;border-left:0;border-right:0;border-top:0;cursor:pointer;text-align:left">' +
              '<span style="font-size:15px;font-weight:500;letter-spacing:-.01em;color:var(--paper)">' + r[0] + '</span>' +
              '<span class="field__v field__v--dim">' + r[1] + ' &nbsp;→</span></button>';
          }).join('') + '</div>' +
          '<div style="margin-top:34px;padding:20px;border:1px solid var(--rule)">' +
            '<div class="label" style="color:var(--paper)">WHAT IS NOT HERE</div>' +
            '<p class="prose" style="margin-top:10px;font-size:13px">No cloud backup. No account. ' +
            'No price feed. No address book synced from anywhere. No notifications. Each of those ' +
            'would need a network, and this build has no code that could open one.</p>' +
          '</div>' +
          '<div style="height:24px"></div>' +
        '</div>' + tabs('') +
      '</div>';
    }
  };

  S.keys = {
    group: 'Device', name: 'Recovery & key management',
    render: function () {
      var words = ['aperture', 'basin', 'cinder', 'draft', 'ember', 'fathom', 'girder', 'harbour',
                   'ingot', 'jetty', 'kiln', 'lantern'];
      return '<div class="screen">' + bar('quiet') +
        '<div class="body pad">' +
          '<div style="padding:24px 0 20px">' +
            '<div class="eyebrow">RECOVERY</div>' +
            '<h1 class="statement" style="margin-top:12px;font-size:34px">TWELVE WORDS<br>ON PAPER</h1>' +
            '<p class="prose" style="margin-top:16px">This is the only backup that exists. Write it ' +
            'by hand. Do not photograph it — the camera roll is on a phone that has a network.</p>' +
          '</div>' +
          '<div class="seedgrid masked" data-seed>' + words.map(function (w, i) {
            return '<div><i>' + (i + 1) + '</i>' + w + '</div>';
          }).join('') + '</div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">' +
            '<button class="linkline" data-reveal>HOLD TO REVEAL</button>' +
            '<span class="label" data-seedstate>CONCEALED</span>' +
          '</div>' +
          '<div class="eyebrow" style="padding-top:30px">AT REST</div>' +
          '<div class="stack" style="margin-top:10px">' +
            field('ENCRYPTION', 'ACTIVE', 'field__v--good') +
            field('PASSPHRASE', 'CONFIGURED') +
            field('SECURE HARDWARE', 'BOUND TO THIS DEVICE') +
            field('EXPORTABLE', 'NO') +
          '</div>' +
          '<div style="margin-top:28px">' +
            control('CHANGE PASSPHRASE', '', 'keys', 'control--quiet') +
            '<div style="height:10px"></div>' +
            '<button class="control control--quiet" style="border-color:var(--rule-strong)">' +
              '<span>ERASE VAULT</span><span class="control__hint">IRREVERSIBLE</span></button>' +
          '</div>' +
          '<p class="prose" style="margin:18px 0 26px;font-size:13px">Erasing destroys the key ' +
          'material in secure hardware. Without the twelve words there is no way back, and no ' +
          'service to ask.</p>' +
        '</div>' +
      '</div>';
    },
    mount: function (root) {
      var seed = $('[data-seed]', root), state = $('[data-seedstate]', root), btn = $('[data-reveal]', root);
      function show() { seed.classList.add('is-shown'); state.textContent = 'VISIBLE'; }
      function hide() { seed.classList.remove('is-shown'); state.textContent = 'CONCEALED'; }
      btn.addEventListener('pointerdown', show);
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (e) {
        btn.addEventListener(e, hide);
      });
    }
  };

  /* ==========================================================================
     ROUTER + REVIEW RAIL
     ====================================================================== */

  var ORDER = [
    'splash',
    'declaration', 'radios', 'airgap', 'boundary', 'entropy', 'created',
    'home', 'btcsetup', 'xmrsetup',
    'export', 'scanner', 'receiving', 'received',
    'confirm', 'destination', 'attest', 'signed', 'signedqr',
    'refusechange', 'refusefee', 'refuseframes',
    'security', 'settings', 'keys'
  ];

  var stage = null, current = null;

  function go(id) {
    if (!S[id]) id = 'home';
    if (location.hash !== '#' + id) { location.hash = id; return; }
    paint(id);
  }

  function paint(id) {
    if (current && stage.firstChild) {
      stage.firstChild.dispatchEvent(new CustomEvent('screen:exit'));
    }
    clearTimers();
    current = id;
    stage.innerHTML = S[id].render();
    var root = stage.firstChild;
    if (S[id].mount) S[id].mount(root);

    $$('[data-go]', root).forEach(function (el) {
      el.addEventListener('click', function () { go(el.getAttribute('data-go')); });
    });

    $$('.rail a').forEach(function (a) {
      a.classList.toggle('is-on', a.getAttribute('data-id') === id);
    });
    $('.rail').classList.remove('is-open');
    document.title = 'Labyrinth Vault — ' + S[id].name;
  }

  function buildRail() {
    var rail = $('.rail'), group = null, html = '';
    ORDER.forEach(function (id, i) {
      var s = S[id];
      if (s.group !== group) { group = s.group; html += '<div class="rail__g">' + group + '</div>'; }
      html += '<a data-id="' + id + '" href="#' + id + '"><em>' +
              String(i + 1).padStart(2, '0') + '</em>' + s.name + '</a>';
    });
    rail.insertAdjacentHTML('beforeend', html);
  }

  function boot() {
    stage = $('[data-stage]');
    buildRail();
    window.addEventListener('hashchange', function () {
      paint(location.hash.slice(1) || 'splash');
    });
    /* Arrow keys walk the deck — a review affordance, not part of the product. */
    window.addEventListener('keydown', function (e) {
      var i = ORDER.indexOf(current);
      if (e.key === 'ArrowRight' && i < ORDER.length - 1) go(ORDER[i + 1]);
      if (e.key === 'ArrowLeft' && i > 0) go(ORDER[i - 1]);
    });
    $('.railbtn').addEventListener('click', function () { $('.rail').classList.toggle('is-open'); });
    paint(location.hash.slice(1) || 'splash');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
