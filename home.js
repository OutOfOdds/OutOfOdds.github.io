/* oddlyworking.app home page: a card for every app name in the sentence, and the sentence size.
   Without this file the page still works: the names are links and home.css sets the size. */
(function () {
  'use strict';

  var store = function (id) { return ['App Store', 'https://apps.apple.com/app/id' + id]; };
  var mail = function (box) { return ['Support', 'mailto:' + box + '@oddlyworking.app']; };

  // One entry per app: the full name, one line about it and the links on its card.
  // The first link is also where the name in index.html goes.
  var APPS = {
    flipscore: { name: 'Flip & Score', desc: 'Score keeping for the Flip Seven card game.', links: [store('6747075064'), mail('flipscore')] },
    skyjo: { name: 'Skyjo Scorepad', desc: 'Score keeping for Skyjo game nights.', links: [store('6830564784'), ['Support', '/skyjo/index.html'], ['Privacy', '/skyjo/privacy.html']] },
    riichiclub: { name: 'RiichiClub', desc: 'Score keeping for riichi mahjong.', links: [store('6499211526'), mail('riichi')] },
    tmhelper: { name: 'TMHelper', desc: 'A helper for Terraforming Mars.', links: [store('1627456078'), mail('tmhelper')] },
    voidbound: { name: 'Voidbound', desc: 'A companion for Sorcery TCG games.', links: [store('6759371512'), mail('voidbound')] },
    oracle: { name: 'Oracle: Find the Mole', desc: 'A word party game for 4–8 friends sharing one phone.', links: [store('1564639558'), ['Details', '/apps/oracle/'], mail('oracle'), ['Privacy', '/en-US/privacy.html']] },
    pokerlog: { name: 'PokerLog', desc: 'A log of poker sessions and results.', links: [store('1547807748'), mail('pokerlog')] },
    capsula: { name: 'Capsula', desc: 'Medication reminders and a journal of every dose.', links: [store('6823259496'), ['Site', '/Capsula-Site/'], mail('capsula')] },
    pokerpal: { name: 'PokerPal', desc: 'PokerLog’s successor, rebuilt from scratch.', links: [['Page', '/pokerpal/'], ['Ideas', '/pokerpal/ideas/']] },
    houserules: { name: 'House Rules', desc: 'Home poker nights, from buy-ins to settle up.', links: [['Site', '/house-rules/'], ['Wiki', '/house-rules/wiki/']] },
    drip: { name: 'Drip', desc: 'One drop at a time.', links: [] }
  };

  var root = document.documentElement;
  var say = document.querySelector('.say');
  if (!say) return;
  var bar = document.querySelector('.bar'), foot = document.querySelector('.foot');
  var phone = window.matchMedia('(max-width: 820px)');
  var ws = [];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // wrap every name with its card: <span class="w"><a class="app">…</a><span class="pop">…</span></span>
  [].forEach.call(say.querySelectorAll('.app[data-app]'), function (a, i) {
    var app = APPS[a.getAttribute('data-app')];
    if (!app) return;
    var w = el('span', 'w'), pop = el('span', 'pop'), title = el('b', '', app.name), go = el('span', 'go');
    pop.id = 'card-' + (i + 1);
    if (a.classList.contains('soon')) title.appendChild(el('i', '', 'soon'));
    pop.appendChild(title);
    pop.appendChild(el('span', '', app.desc));
    app.links.forEach(function (l) {
      var link = el('a', '', l[0]);
      link.href = l[1];
      go.appendChild(link);
    });
    if (!app.links.length) go.appendChild(el('span', 'none', 'No page yet'));
    pop.appendChild(go);
    a.parentNode.insertBefore(w, a);
    w.appendChild(a);
    w.appendChild(pop);
    // the name now opens its card; the card has the links
    a.setAttribute('role', 'button');
    a.setAttribute('aria-expanded', 'false');
    a.setAttribute('aria-controls', pop.id);
    if (!a.hasAttribute('href')) a.tabIndex = 0;
    w.pop = pop; w.app = a;
    ws.push(w);
  });

  function gutter() { return parseFloat(getComputedStyle(say.parentNode).paddingLeft) || 20; }

  // keep a card on the screen: shift it left near the right edge, open it upwards near the bottom
  function place(w) {
    var pop = w.pop;
    pop.style.left = '';
    w.classList.remove('up');
    if (phone.matches) return;
    var W = root.clientWidth, m = gutter(), r = w.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, x = 0;
    if (r.left + pw > W - m) x = W - m - pw - r.left;
    if (r.left + x < m) x = m - r.left;
    if (x) pop.style.left = Math.round(x) + 'px';
    if (r.bottom + 10 + ph > window.innerHeight && r.top - 10 - ph > 0) w.classList.add('up');
  }

  function setOpen(w, on) {
    w.classList.toggle('open', on);
    w.app.setAttribute('aria-expanded', String(on));
    if (on) w.classList.remove('x');
  }
  function closeOthers(keep) { ws.forEach(function (w) { if (w !== keep) setOpen(w, false); }); }

  ws.forEach(function (w) {
    w.addEventListener('pointerenter', function (e) {
      if (e.pointerType === 'mouse') { place(w); closeOthers(w); }
    });
    w.addEventListener('pointerleave', function () { w.classList.remove('x'); });
    w.addEventListener('focusin', function () { place(w); closeOthers(w); });
    w.addEventListener('focusout', function (e) {
      if (!w.contains(e.relatedTarget)) { w.classList.remove('x'); setOpen(w, false); }
    });
    w.app.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return; // a new tab still opens the link
      e.preventDefault();
      var on = !w.classList.contains('open');
      closeOthers(w);
      place(w);
      setOpen(w, on);
      if (!on) w.classList.add('x');
    });
    w.app.addEventListener('keydown', function (e) {
      if (e.key === ' ' || (e.key === 'Enter' && !w.app.hasAttribute('href'))) { e.preventDefault(); w.app.click(); }
    });
  });

  // a tap or click outside the names closes the open card
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.w')) closeOthers(null);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var w = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.w') : null;
    ws.forEach(function (o) {
      if (o.classList.contains('open') || o === w || o.matches(':hover')) { setOpen(o, false); o.classList.add('x'); }
    });
    if (w && document.activeElement !== w.app) w.app.focus();
  });

  // The sentence takes the largest size at which the bar, the sentence and the footer fit the first screen
  // (on a phone, the bar and the sentence). The height comes from 100svh, so a phone's toolbars do not resize it.
  var probe = el('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  var lastW = 0, lastH = 0;

  function fit() {
    var W = root.clientWidth, H = probe.offsetHeight || window.innerHeight, small = phone.matches;
    lastW = W; lastH = H;
    say.style.fontSize = '';
    var cs = getComputedStyle(say), pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var room = H - bar.offsetHeight - pad - (small ? 0 : foot.offsetHeight);
    var lo = small ? W * 0.068 : Math.max(26, W * 0.022), hi = small ? W * 0.11 : Math.min(W * 0.09, 168);
    var apps = say.querySelectorAll('.app');
    function fits() {
      if (say.offsetHeight - pad > room) return false;
      for (var j = 0; j < apps.length; j++) if (apps[j].offsetWidth > say.clientWidth) return false;
      return true;
    }
    for (var i = 0; i < 12; i++) {
      var mid = (lo + hi) / 2;
      say.style.fontSize = mid + 'px';
      if (fits()) lo = mid; else hi = mid;
    }
    say.style.fontSize = Math.floor(lo * 2) / 2 + 'px';
    ws.forEach(place);
  }

  var queued = 0;
  window.addEventListener('resize', function () {
    if (queued) return;
    queued = requestAnimationFrame(function () {
      queued = 0;
      if (root.clientWidth !== lastW || probe.offsetHeight !== lastH) fit();
    });
  });
  fit();
  // the first fit asks for the fonts; fit again once they are in
  if (document.fonts) {
    if (document.fonts.ready) document.fonts.ready.then(fit);
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', fit);
  }
})();
